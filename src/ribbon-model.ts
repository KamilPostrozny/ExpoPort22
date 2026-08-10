/**
 * The context ribbon's brain (§4.4): which recipe the active pane's state selects, the locally
 * tracked suspended-job machine, the per-process-instance identity that dismissal and the running
 * timer key on, and the kill-force command. Pure — tested in `src/ribbon-model.test.ts`; the
 * recipes themselves are data in `src/ribbon-recipes.ts`, and `src/ribbon.tsx` renders.
 *
 * Signals in: T9's ~2s foreground poll (`{command, pid} | null`, shell = null) and T6's instant
 * `altScreen` flag. Signals cross in the reducer, never in the component.
 */

import { RECIPES, REPL_NAMES, type RecipeId } from '@/ribbon-recipes';

/* --- instance identity --- */

/**
 * "That process instance" (§4.4's dismissal unit, and the design's rule: "a dismissed ribbon
 * returns when the foreground process changes"): a counter bumped on every foreground
 * transition — null→X, X→Y, and X→suspended all count. `#{pane_pid}` is the pane's shell, not
 * the process, so the pid alone cannot tell two runs of `vim` apart; the transition can.
 *
 * ponytail: X→shell→X inside one 2s poll beat reads as the same instance — the poll cannot see
 * a process that came and went between beats, and neither can we.
 */
export type RibbonCore = {
  instance: number;
  /** The polled foreground command, `null` while the shell is idle (or a job is suspended). */
  command: string | null;
  /** `#{pane_pid}` — the pane's shell, which is what `pgrep -P` wants for kill-force. */
  pid: number | null;
  /** Clock ms at this instance's first detection — the running timer's zero. */
  startedAt: number;
  /** The locally tracked stopped job's name, shown as `proc · stopped`. */
  suspended: string | null;
  /** We sent ^Z while `candidate` ran; if the poll shows a shell before the window closes,
   *  the job is suspended rather than exited. */
  candidate: string | null;
  candidateAt: number | null;
  /** The instance the user swiped away; a new instance clears it by not being this one. */
  dismissed: number | null;
};

export const RIBBON_IDLE: RibbonCore = {
  instance: 0,
  command: null,
  pid: null,
  startedAt: 0,
  suspended: null,
  candidate: null,
  candidateAt: null,
  dismissed: null,
};

/** How long a sent ^Z stays a suspension candidate — a bit over two poll beats, so one missed
 *  poll does not lose it, and a ^Z swallowed by a TUI hours ago cannot mark a later idle shell
 *  as a stopped job. */
export const Z_CANDIDATE_MS = 6000;

/**
 * A poll answered. Same command, same pid, nothing pending → the same object back, so React
 * state built on this never re-renders on a quiet beat.
 *
 * `pid: null` is the same answer from a different source: a window switch, which knows what the
 * window it is going to runs (the list carries `pane_current_command`) but not its pid. It is
 * used so the ribbon changes WITH the slide instead of a poll beat after it — appearing late, it
 * resizes the terminal once the swipe has already landed, which is a jolt right where the eye is
 * (user, 2026-08-10). The pid arrives on the next poll and fills in without starting the timer
 * over; until it does, the Kill cap is inert, which is the safe way round — a stale pid belongs
 * to another window's process.
 */
export function ribbonPoll(
  core: RibbonCore,
  foreground: { command: string; pid: number | null } | null,
  now: number,
): RibbonCore {
  if (foreground === null) {
    if (core.command === null) return core; // idle (or already suspended): nothing changed
    // The foreground process left. A fresh ^Z means it stopped; otherwise it exited.
    if (core.candidate !== null && core.candidateAt !== null && now - core.candidateAt < Z_CANDIDATE_MS) {
      return {
        ...core,
        instance: core.instance + 1,
        command: null,
        startedAt: now,
        suspended: core.candidate,
        candidate: null,
        candidateAt: null,
      };
    }
    return { ...core, command: null, candidate: null, candidateAt: null };
  }
  if (foreground.command === core.command && foreground.pid === core.pid && core.suspended === null) {
    return core;
  }
  // The pid catching up with a command a window switch already named: the same process, so the
  // instance and its timer carry on.
  if (
    foreground.pid !== null &&
    core.pid === null &&
    foreground.command === core.command &&
    core.suspended === null
  ) {
    return { ...core, pid: foreground.pid };
  }
  // A new foreground (or the suspended job back in front): a new instance, timer from now.
  return {
    ...core,
    instance: core.instance + 1,
    command: foreground.command,
    pid: foreground.pid,
    startedAt: now,
    suspended: null,
    candidate: null,
    candidateAt: null,
  };
}

/** Bytes left the key bar for the PTY. A ^Z while something runs makes that something a
 *  suspension candidate; everything else is not ours to watch. */
export function ribbonSent(core: RibbonCore, bytes: string, now: number): RibbonCore {
  if (!bytes.includes('\x1a') || core.command === null) return core;
  return { ...core, candidate: core.command, candidateAt: now };
}

/** The fg / bg / kill cap resolved a suspended job: the pill leaves now, the poll confirms. */
export function ribbonResumed(core: RibbonCore): RibbonCore {
  if (core.suspended === null) return core;
  return { ...core, instance: core.instance + 1, suspended: null };
}

/** The swipe-down: this instance stays gone; the next process brings the ribbon back. */
export function ribbonDismiss(core: RibbonCore): RibbonCore {
  return { ...core, dismissed: core.instance };
}

/* --- recipe selection --- */

/** Which recipe a command name selects, from the declarative data. */
export function matchRecipe(command: string): RecipeId | null {
  for (const [id, recipe] of Object.entries(RECIPES)) {
    if (recipe.names.includes(command)) return id as RecipeId;
  }
  return null;
}

/**
 * The §4.4 table: dismissal wins, then the tracked suspension, then a name match (vim on the alt
 * screen is vim, not "unknown TUI"), then the silences — REPLs sitting at their prompt, and
 * unmatched alt-screen apps we have no caps for. What remains is a non-shell, non-TUI foreground:
 * `running`.
 */
export function selectRecipe(
  core: RibbonCore,
  altScreen: boolean,
): { id: RecipeId; proc: string } | null {
  if (core.dismissed === core.instance) return null;
  if (core.suspended !== null) return { id: 'suspended', proc: core.suspended };
  if (core.command === null) return null;
  const named = matchRecipe(core.command);
  if (named !== null) return { id: named, proc: core.command };
  if (REPL_NAMES.has(core.command)) return null;
  if (altScreen) return null; // an unknown TUI: no caps beat wrong caps (§4.4)
  return { id: 'running', proc: core.command };
}

/* --- the running timer --- */

/** `m:ss` from elapsed ms, the prototype's `mm + ':' + ss`. Never negative — a clock that went
 *  backwards reads 0:00, not NaN. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* --- kill force --- */

/**
 * §4.4's red cap: the pane shell's children, killed hard, on an exec channel. `xargs` rather
 * than `$( )` for the same reason as every T9 command — one line fish and POSIX sh parse
 * identically ($() needs fish ≥ 3.4). No children → kill errors into /dev/null, `true` answers.
 * The pid is validated like tmux-model's `target`: only an integer reaches the command line.
 */
export function killCommand(panePid: number): string {
  if (!Number.isInteger(panePid) || panePid <= 0) throw new Error(`not a pid: ${panePid}`);
  return `pgrep -P ${panePid} | xargs kill -9 2>/dev/null; true`;
}
