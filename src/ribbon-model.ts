/**
 * The edge handle's brain (§4.4): which recipe the active pane's state selects, the locally
 * tracked suspended-job machine, the per-process-instance identity the running timer keys on,
 * and the kill-force command. Pure — tested in `src/ribbon-model.test.ts`; the recipes
 * themselves are data in `src/ribbon-recipes.ts`, and `src/ribbon.tsx` renders.
 *
 * Signals in: T9's ~2s foreground poll (`{command, pid} | null`, shell = null) and, from the same
 * poll, the active pane's `#{alternate_on}`. Signals cross in the reducer, never in the component.
 * (It used to be T6's `modes.altScreen` from the outer terminal — see `selectRecipe` for why that
 * was the wrong fact and why the scroll path still wants it.)
 */

import { RECIPES, REPL_NAMES, type RecipeId } from '@/ribbon-recipes';

/* --- instance identity --- */

/**
 * "That process instance": a counter bumped on every foreground transition — null→X, X→Y, and
 * X→suspended all count. The running timer starts over on it, and the screen closes the panel
 * on it (a new process means the caps under the finger changed). `#{pane_pid}` is the pane's
 * shell, not the process, so the pid alone cannot tell two runs of `vim` apart; the
 * transition can.
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
  /** Clock ms at the first beat that stopped seeing `command`, or null while it is being seen.
   *  The poll blinks (see `RIBBON_HOLD_MS`), so "gone" is a claim that has to survive a beat. */
  goneAt: number | null;
  /** The last process we had a pid for, so a hop away and back can be recognised as the SAME run
   *  and keep its clock. A window switch names the command from the window list but has no pid
   *  (`ribbonForWindow`), which reads as a new foreground and reset the timer — on device the
   *  chip therefore sat at 0:00 forever, since every hop restarted it. Matching on the pid keeps
   *  "a different window running the same command is a different run" true, which a match on the
   *  name alone would break. */
  last: { command: string; pid: number; startedAt: number } | null;
};

/** What this core will want to recognise later: the run it is watching, if it has a pid for it. */
function remember(core: RibbonCore): RibbonCore['last'] {
  return core.command !== null && core.pid !== null
    ? { command: core.command, pid: core.pid, startedAt: core.startedAt }
    : core.last;
}

export const RIBBON_IDLE: RibbonCore = {
  instance: 0,
  command: null,
  pid: null,
  startedAt: 0,
  suspended: null,
  candidate: null,
  candidateAt: null,
  goneAt: null,
  last: null,
};

/**
 * How long the foreground has to stay gone before we believe it.
 *
 * `tmux display-message -p` is issued with no target, so tmux answers for whatever it considers
 * the current window — and on a host where anything else is working in another window, that
 * alternates beat to beat. Measured on device 2026-08-16: `windowIndex` flapped 6 → 7 → 6 → 7
 * every ~2s with `claude` / null / `claude` / null behind it. Taken literally that unmounts and
 * remounts the band forever and restarts its clock every beat.
 *
 * A bit over one beat, so one blink costs nothing and a process that really ended still clears
 * within a beat of the truth. The right fix is for the poll to name its target; this is the
 * ribbon refusing to believe a signal that contradicts itself, which it should do regardless.
 *
 * This comment used to also claim the hold was what let a plain `sleep 30` appear at all (user,
 * 2026-08-16: "it didn't show up for sleep"). It was not, and `sleep` still did not show up —
 * measured on the emulator 2026-08-17, four runs, chip region empty at every one of 40 samples.
 * The blink was one of two blockers and the hold really did remove it; the other is written up on
 * `RIBBON_MIN_RUN_MS` below and was never touched. Claiming a fix that did not hold is worse than
 * claiming nothing, so: the hold fixes the blink, and nothing else.
 */
export const RIBBON_HOLD_MS = 2500;

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
        goneAt: null,
      };
    }
    // Not gone until it has stayed gone (`RIBBON_HOLD_MS`). One blink of the poll used to unmount
    // the band and restart the process's identity, which is what made a plain `sleep` unable to
    // outlive the gate and made the band animate in twice around a window hop.
    if (core.goneAt === null) return { ...core, goneAt: now };
    if (now - core.goneAt < RIBBON_HOLD_MS) return core; // same object: the quiet beat re-renders nothing
    return { ...core, last: remember(core), command: null, candidate: null, candidateAt: null, goneAt: null };
  }
  if (foreground.command === core.command && foreground.pid === core.pid && core.suspended === null) {
    // Back after a blink is not a new run: the clock and the instance carry on.
    return core.goneAt === null ? core : { ...core, goneAt: null };
  }
  // The pid catching up with a command a window switch already named: the same process, so the
  // instance and its timer carry on.
  if (
    foreground.pid !== null &&
    core.pid === null &&
    foreground.command === core.command &&
    core.suspended === null
  ) {
    // If the pid is one we were already timing, this is that same run come back into view — a hop
    // away and back, not a restart — so its clock picks up where it left off instead of at zero.
    const same = core.last !== null && core.last.pid === foreground.pid && core.last.command === foreground.command;
    return { ...core, pid: foreground.pid, startedAt: same ? core.last!.startedAt : core.startedAt };
  }
  // A new foreground (or the suspended job back in front): a new instance, timer from now.
  return {
    ...core,
    last: remember(core),
    instance: core.instance + 1,
    command: foreground.command,
    pid: foreground.pid,
    startedAt: now,
    suspended: null,
    candidate: null,
    candidateAt: null,
    goneAt: null,
  };
}

/**
 * A hop landed on a window the list says is idle. Unlike a poll's null this is authoritative —
 * we are looking at the window, not asking about it — so it clears now rather than waiting out
 * `RIBBON_HOLD_MS`, and the band leaves with the slide instead of flashing on the tab it does
 * not belong to (user, 2026-08-16).
 */
export function ribbonSwitchedToIdle(core: RibbonCore): RibbonCore {
  if (core.command === null) return core;
  // Remember what we were watching: hopping back to it is the same run, and its clock should say so.
  return { ...core, last: remember(core), command: null, candidate: null, candidateAt: null, goneAt: null };
}

/** Bytes left the key bar for the PTY. A ^Z while something runs makes that something a
 *  suspension candidate; everything else is not ours to watch. */
export function ribbonSent(core: RibbonCore, bytes: string, now: number): RibbonCore {
  if (!bytes.includes('\x1a') || core.command === null) return core;
  return { ...core, candidate: core.command, candidateAt: now };
}

/** The fg / bg / kill cap resolved a suspended job: the handle leaves now, the poll confirms. */
export function ribbonResumed(core: RibbonCore): RibbonCore {
  if (core.suspended === null) return core;
  return { ...core, instance: core.instance + 1, suspended: null };
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
 * The §4.4 table: the tracked suspension wins, then a name match (vim on the alt screen is vim,
 * not "unknown TUI"), then the silences — REPLs sitting at their prompt, and unmatched
 * alt-screen apps we have no caps for. What remains is a non-shell, non-TUI foreground:
 * `running`.
 *
 * `paneAlt` is the tmux poll's `#{alternate_on}` (src/tmux.ts's `paneAlt`), NOT T6's
 * `modes.altScreen`. The two look like the same fact and are not, which is worth the paragraph
 * because the next reader will assume they are:
 *
 * - `modes.altScreen` is the OUTER xterm's buffer type. Inside tmux it is permanently true — a
 *   tmux client is itself a full-screen app — so it says "tmux is running" and nothing at all
 *   about the pane. `scrollRoute` wants exactly that reading (under tmux a wheel notch should be
 *   arrows), so the scroll path keeps it and must not be repointed here.
 * - `paneAlt` is per pane, so it answers the question this gate asks: is the thing in front of the
 *   user a full-screen app.
 *
 * Sourced from the outer flag, `running` was unreachable in EVERY tmux session — the app's own
 * default start mode — for every command at every duration (emulator, 2026-08-17: `sleep 30`
 * detected, chip region empty at all 15 samples over two runs). `vim` still got its chip only
 * because `matchRecipe` hits before the gate. The §4.4 intent is unchanged: an unknown full-screen
 * TUI still gets no chip, because no caps beat wrong caps. Only the source of the fact moved.
 *
 * Without tmux (`custom`/`shell` start modes) the poll cannot answer and `paneAlt` is false — moot,
 * because `foregroundFrom` needs an attached tmux client too, so `core.command` is null there and
 * the gate is never reached (device walk, 2026-08-17: plain-shell mode reports `attached:false`,
 * `foreground:null`, and shows no ribbon at all).
 *
 * It takes `{ paneAlt }` rather than a bare boolean ON PURPOSE, and that is the fix's other half:
 * the wrong signal was passed here for two months and neither `tsc` nor a test could see it,
 * because `modes.altScreen` and the pane's flag are both `boolean`. Named, the compiler rejects
 * anything that is not the tmux poll's answer — `getTmux()`/`useTmux()` satisfy it structurally.
 */
export function selectRecipe(
  core: RibbonCore,
  { paneAlt }: { paneAlt: boolean },
): { id: RecipeId; proc: string } | null {
  if (core.suspended !== null) return { id: 'suspended', proc: core.suspended };
  if (core.command === null) return null;
  const named = matchRecipe(core.command);
  if (named !== null) return { id: named, proc: core.command };
  if (REPL_NAMES.has(core.command)) return null;
  if (paneAlt) return null; // an unknown TUI: no caps beat wrong caps (§4.4)
  return { id: 'running', proc: core.command };
}

/**
 * How long a plain foreground command must have been alive before `running` earns the band.
 *
 * `running` matches EVERY non-shell foreground — `git log`, `ls`, `npm test`, every `rg` — so
 * ungated it appears dozens of times an hour for processes that are gone before the eye finds
 * them, which is what makes an unrequested surface read as intrusive no matter how it is drawn
 * (docs/ribbon-redesign.md §6). Three seconds is also exactly when kill / bg / stop start being
 * the caps you actually want. The named recipes (vim, pager, htop, agent) are not gated: those
 * are things the user opened on purpose and sat down in.
 *
 * It is a DELAY THE BAND SERVES ITSELF, not a clock `selectRecipe` reads, and that is the whole
 * bug of 2026-08-17. The gate used to be `now - core.startedAt < RIBBON_MIN_RUN_MS` right here,
 * with the screen calling `selectRecipe(ribbonCore, modes.altScreen, Date.now())` from a component
 * body — and this app builds with the React Compiler, which caches that call on
 * `[connected, ribbonCore, modes]`. A clock is not a dependency. Compiled output, verified:
 *
 *     if ($[0] !== connected || $[1] !== modes || $[2] !== ribbonCore) {
 *       t1 = connected ? selectRecipe(ribbonCore, modes.altScreen, Date.now()) : null;
 *
 * A running job changes none of those — an identical poll answer returns the same core object by
 * design, and `set` in src/tmux.ts drops it before that — so the screen's gate-beat re-render at
 * `RIBBON_MIN_RUN_MS + 50` read the cached `null` straight back and the band never appeared for
 * ANY unnamed command. Same family as the chip clock frozen at 0:00 (see src/ribbon.tsx) and as
 * `RIBBON_HOLD_MS` never expiring: a quantity that changes with time cannot be recomputed by a
 * re-render nobody's dependencies noticed. State can hold time; a render-time clock cannot.
 */
export const RIBBON_MIN_RUN_MS = 3000;

/** How long the band waits before drawing a recipe. `running` is the only gated one, for the
 *  reason above; everything else is something the user opened on purpose and shows at once. */
export function ribbonAppearDelay(id: RecipeId): number {
  return id === 'running' ? RIBBON_MIN_RUN_MS : 0;
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
