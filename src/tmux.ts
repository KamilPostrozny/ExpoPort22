/**
 * The tmux side-channel (§4.5): probe on connect, conf push over SFTP with a read-back verify,
 * the window helpers T10's switcher drives, and the ~2s poll that feeds T7's badge and T11's
 * ribbon. A module singleton read through `useSyncExternalStore`, like `settings` and `session` —
 * the session drives its lifecycle (`startTmux`/`stopTmux` on its own state transitions) and any
 * screen reads it.
 *
 * Every remote action is a short-lived exec channel through the same `ExpoSSH` connection the
 * session owns — never the attached PTY, which would echo the command into the grid the user is
 * looking at (§4.5). All the decisions live in `src/tmux-model.ts`, tested; this file schedules
 * and executes.
 */

import { useSyncExternalStore } from 'react';

import ExpoSSH from '../modules/expo-ssh/src/ExpoSSHModule';
import { toBase64 } from '@/base64';
import { parseSearchOutput, searchPaneCommand, type SearchHit } from '@/search-model';
import { getSettings, pollSession, updateSettings, usesTmux } from '@/settings';
import {
  APPLY_AND_VERIFY,
  CONF_DIRECTORIES,
  CONF_PATH,
  LIST_SESSIONS,
  LIST_WINDOWS,
  NEW_WINDOW,
  POLL,
  pollCommand,
  PROBE,
  capturePaneCommand,
  deriveConfigStatus,
  foregroundFrom,
  generateConf,
  killWindowCommand,
  moveWindowCommand,
  needsPush,
  parsePoll,
  parseProbe,
  parseSessions,
  parseVerify,
  parseWindows,
  pollDelay,
  readFileCommand,
  selectWindowCommand,
  type ConfigStatus,
  type TmuxWindow,
} from '@/tmux-model';

export type { ConfigStatus, TmuxWindow };

/** Generous because `capture-pane -e` of a wide, colourful pane is the biggest thing that ever
 *  comes back; everything else answers in a line or two. */
const EXEC_LIMIT = 512 * 1024;

export type TmuxState = {
  /** `null` until the probe answers; then whether the host has tmux at all. Absent → every tmux
   *  affordance stays invisible, and nothing says so (§7). */
  present: boolean | null;
  /** What the last push attempt proved with its read-back. 'off' is not a value here — it belongs
   *  to the start mode and is derived (see `configStatus`), because a mode change is a Setup-screen
   *  change and takes effect on the next connect, not on the live server. */
  config: 'applied' | 'not-applied';
  /** A client is attached to the session our exec commands resolve to — for this app's one user,
   *  the phone's own PTY (the ceiling is in tmux-model's POLL comment). */
  attached: boolean;
  /** The active window index while attached — T7's badge. `null` = not attached, badge default. */
  windowIndex: number | null;
  /** The active pane's non-shell foreground process — what T11's ribbon keys on. `null` = idle
   *  shell, not attached, or no tmux. */
  foreground: { command: string; pid: number } | null;
};

const DOWN: TmuxState = {
  present: null,
  config: 'not-applied',
  attached: false,
  windowIndex: null,
  foreground: null,
};

let state: TmuxState = DOWN;
/** Whether the side-channel should be running at all — flips with the session. */
let up = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
/** Polls run since this connect — the fast phase's budget (see `pollDelay`). */
let ticks = 0;

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The poll re-reports every ~2s; only actual change reaches the log and the screens. */
function set(patch: Partial<TmuxState>) {
  const next = { ...state, ...patch };
  const same =
    next.present === state.present &&
    next.config === state.config &&
    next.attached === state.attached &&
    next.windowIndex === state.windowIndex &&
    next.foreground?.command === state.foreground?.command &&
    next.foreground?.pid === state.foreground?.pid;
  if (same) return;
  state = next;
  console.log('[tmux]', JSON.stringify(next));
  for (const listener of listeners) listener();
}

export function getTmux(): TmuxState {
  return state;
}

export function useTmux(): TmuxState {
  return useSyncExternalStore(subscribe, getTmux, getTmux);
}

/** The §4.5 Settings row: off / applied / not-applied. Reactive callers pair it with
 *  `useSettings()` + `useTmux()` and derive — this form is for one-shot reads (T12 wires it). */
export function configStatus(): ConfigStatus {
  return deriveConfigStatus(usesTmux(getSettings()), state.config);
}

/* --- the exec seam --- */

/** One short-lived exec channel per command, on the session's own connection. The commands are
 *  built to answer on stdout and exit 0 (see tmux-model), so a rejection here is transport-level
 *  — the caller decides whether that is silence or a throw. */
function run(command: string): Promise<string> {
  return ExpoSSH.exec(command, EXEC_LIMIT);
}

/** T11's kill-force cap: one non-tmux command on the same short-lived-exec seam the session's
 *  connection already provides. */
export function exec(command: string): Promise<string> {
  return run(command);
}

/* --- lifecycle (driven by src/session.ts state transitions) --- */

/** The session is connected: probe, maybe push the conf, start the poll. Idempotent — the session
 *  calls it on every transition into `connected`. */
export async function startTmux(): Promise<void> {
  if (up) return;
  up = true;
  let present = false;
  try {
    present = parseProbe(await run(PROBE));
  } catch {
    // A throwing exec layer on `command -v`'s exit 1 means the same thing as empty output.
  }
  if (!up) return; // stopped while the probe was in flight
  set({ present });
  if (!present) return; // §7: no tmux = no tabs, no switcher, no mention anywhere
  // A tmux start mode is the ask (§4.1): the conf is what its features are made of, so there is no
  // second question about whether to push it. `source-file` reaches a server the startup line has
  // already started, so the two racing here is harmless.
  // The poll starts BEFORE the conf push, not after it: `attached` is what T9's tabs button also
  // waits on, and making it wait out a handful of conf round trips is the delay before the button
  // appears (user, 2026-08-12). Nothing in the poll depends on the conf.
  void tick();
  void cacheSessions();
  if (usesTmux(getSettings())) await configure();
}

/** The session went away, whichever way. Everything resets: the next connect re-probes, and a
 *  toggled-off config gets its chance to not be pushed. */
export function stopTmux(): void {
  up = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  ticks = 0;
  set(DOWN);
}

/**
 * The §4.5 push: our conf over SFTP (only when it differs), then apply-and-verify in one tmux
 * client command. Every failure lands in the catch: the status just stays 'not-applied' and
 * nothing else is visible (§7).
 *
 * Runs on every connect BECAUSE nothing persists it any more — the options live on the running
 * tmux server and die with it, which is the point (tmux-model, "why nothing of the user's is
 * edited").
 */
async function configure(): Promise<void> {
  try {
    const { tmuxExtras } = getSettings();
    const remote = await run(readFileCommand(`~/${CONF_PATH}`));
    if (needsPush(remote, tmuxExtras)) {
      const bytes = new TextEncoder().encode(generateConf(tmuxExtras));
      await ExpoSSH.upload(toBase64(bytes), CONF_PATH, CONF_DIRECTORIES);
    }
    // The whole apply: source our own file onto the running server, read the option back. Nothing
    // of the user's is touched on the way — see tmux-model's "why nothing of the user's is edited".
    const verified = parseVerify(await run(APPLY_AND_VERIFY));
    set({ config: verified ? 'applied' : 'not-applied' });
    console.log('[tmux] configure:', verified ? 'applied' : 'not-applied (read-back said no)');
  } catch (error) {
    // §7: a failed conf push changes nothing visible. The status was already 'not-applied'.
    set({ config: 'not-applied' });
    console.log('[tmux] configure failed, nothing visible changes:', error);
  }
}

/* --- the poll (T7 badge, T11 ribbon) --- */

/** Self-rescheduling rather than a fixed interval, so the beat can change with what it is waiting
 *  for (see `pollDelay`) and a slow link can never stack ticks behind a poll still in flight. */
async function tick(): Promise<void> {
  ticks += 1;
  await poll();
  if (!up) return;
  timer = setTimeout(tick, pollDelay(state.attached, ticks));
}

/** What the last poll aimed at, so the choice is logged once rather than every 2s. */
let aimedAt: string | null | undefined;

async function poll(): Promise<void> {
  if (polling) return; // a slow link answers late; never stack channels on top of it
  polling = true;
  try {
    // Ask about OUR session, not whichever one tmux last touched (see `pollCommand`). If the name
    // turns out to be wrong — a session renamed or killed under us — the targeted form answers
    // nothing, and the untargeted one is better than going blind and dropping the tabs button.
    const session = pollSession(getSettings());
    if (session !== aimedAt) {
      aimedAt = session;
      console.log(`[tmux] poll aimed at ${session === null ? 'nothing (untargeted)' : `session ${session}`}`);
    }
    let answer = parsePoll(await run(pollCommand(session)));
    if (answer === null && session !== null) answer = parsePoll(await run(POLL));
    if (!up) return;
    set({
      attached: answer?.attached ?? false,
      windowIndex: answer?.attached ? answer.windowIndex : null,
      foreground: foregroundFrom(answer),
    });
  } catch {
    // One missed beat; the next tick asks again.
  } finally {
    polling = false;
  }
}

/** What the host is running, remembered for Setup's attach picker (§4.1) — that screen has no
 *  connection to ask over. Silent on failure: the picker just offers what it offered last time. */
async function cacheSessions(): Promise<void> {
  try {
    const names = parseSessions(await run(LIST_SESSIONS));
    const known = getSettings().knownSessions;
    if (names.length !== known.length || names.some((name, i) => name !== known[i])) {
      updateSettings({ knownSessions: names });
    }
  } catch {
    // One list nobody is looking at yet; the next connect asks again.
  }
}

/* --- window helpers (T10's switcher, T11's swipe) --- */

export async function listWindows(): Promise<TmuxWindow[]> {
  return parseWindows(await run(LIST_WINDOWS));
}

/** The window's active pane with its colours as escapes (`-e`) — feed it to a terminal, not a
 *  <Text>. Rejects when the window is gone; the switcher decides what a missing card looks like. */
export function capturePane(windowIndex: number): Promise<string> {
  return run(capturePaneCommand(windowIndex));
}

/** T14: first occurrence of `query` in the window's whole scrollback, with the card's context —
 *  the search stays on the host (one grep per window per settled keystroke). `null` = no hit. */
export async function searchPane(windowIndex: number, query: string): Promise<SearchHit | null> {
  return parseSearchOutput(await run(searchPaneCommand(windowIndex, query)));
}

/**
 * How long a nudge on the SWITCH path waits before it asks. The badge should not wait out the
 * interval to notice — but firing the moment `select-window` returns lands the answer ~50-120ms
 * in, which is the first third of a page slide, and it is an answer that cannot be quiet:
 * `windowIndex` has changed by definition, so `set` fans out to every listener and re-renders the
 * whole terminal screen mid-animation. 400ms clears the slide (`slideMs`, ~350ms for a full pitch)
 * and is still five times sooner than the 2s beat, so the badge intent survives intact.
 *
 * No cancellation handle: `poll` returns early on `!up`, so a timer that fires into a dropped
 * session costs one rejected exec and nothing else.
 */
const NUDGE_AFTER_SLIDE_MS = 400;

export async function selectWindow(windowIndex: number): Promise<void> {
  await run(selectWindowCommand(windowIndex));
  setTimeout(() => void poll(), NUDGE_AFTER_SLIDE_MS);
}

// Not deferred: a kill is not on the swipe path, and its grid wants the fresh list at once.
export async function killWindow(windowIndex: number): Promise<void> {
  await run(killWindowCommand(windowIndex));
  void poll();
}

// Deferred like `selectWindow`: committing a swipe past the last tab births a window, and that
// commit is followed by the same slide.
export async function newWindow(): Promise<void> {
  await run(NEW_WINDOW);
  setTimeout(() => void poll(), NUDGE_AFTER_SLIDE_MS);
}

/** Reorder for T10's drag-drop. Landing indices depend on the user's base-index/renumber
 *  options, so re-list after — the answer is what tmux did, not what we asked. */
export async function moveWindow(from: number, to: number): Promise<void> {
  await run(moveWindowCommand(from, to));
  void poll();
}
