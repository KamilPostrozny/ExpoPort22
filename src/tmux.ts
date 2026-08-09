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
import { getSettings } from '@/settings';
import {
  APPLY_AND_VERIFY,
  CONF_DIRECTORIES,
  CONF_PATH,
  LIST_WINDOWS,
  NEW_WINDOW,
  POLL,
  POLL_MS,
  PROBE,
  appendSourceLineCommand,
  capturePaneCommand,
  chooseUserConf,
  deriveConfigStatus,
  foregroundFrom,
  generateConf,
  hasSourceLine,
  killWindowCommand,
  moveWindowCommand,
  needsPush,
  parsePoll,
  parseProbe,
  parseVerify,
  parseWindows,
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
  /** What the last push attempt proved with its read-back. 'off' is not a value here — it is the
   *  toggle's, derived (see `configStatus`), because flipping the toggle changes no remote state. */
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
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

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
  return deriveConfigStatus(getSettings().configureTmux, state.config);
}

/* --- the exec seam --- */

/** One short-lived exec channel per command, on the session's own connection. The commands are
 *  built to answer on stdout and exit 0 (see tmux-model), so a rejection here is transport-level
 *  — the caller decides whether that is silence or a throw. */
function run(command: string): Promise<string> {
  return ExpoSSH.exec(command, EXEC_LIMIT);
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
  if (getSettings().configureTmux) await configure();
  if (!up) return;
  timer = setInterval(poll, POLL_MS);
  void poll();
}

/** The session went away, whichever way. Everything resets: the next connect re-probes, and a
 *  toggled-off config gets its chance to not be pushed. */
export function stopTmux(): void {
  up = false;
  if (timer !== null) clearInterval(timer);
  timer = null;
  set(DOWN);
}

/**
 * The §4.5 push: conf over SFTP (only when it differs), one source-file line into the conf tmux
 * actually reads, then apply-and-verify in a single tmux client command. Every failure lands in
 * the catch: the status just stays 'not-applied' and nothing else is visible (§7).
 */
async function configure(): Promise<void> {
  try {
    const remote = await run(readFileCommand(`~/${CONF_PATH}`));
    if (needsPush(remote)) {
      const bytes = new TextEncoder().encode(generateConf());
      await ExpoSSH.upload(toBase64(bytes), CONF_PATH, CONF_DIRECTORIES);
    }
    // Which conf tmux reads depends on which exists (~/.tmux.conf shadows the XDG path), so the
    // existence checks go over SFTP — no shell, no fish-vs-sh question to even ask.
    const names = async (path: string) =>
      (await ExpoSSH.listDirectory(path).catch(() => [])).map((entry) => entry.name);
    const target = chooseUserConf(
      (await names('.')).includes('.tmux.conf'),
      (await names('.config/tmux')).includes('tmux.conf'),
    );
    const existing = target.exists ? await run(readFileCommand(target.path)) : '';
    if (!hasSourceLine(existing)) await run(appendSourceLineCommand(target.path));
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

async function poll(): Promise<void> {
  if (polling) return; // a slow link answers late; never stack channels on top of it
  polling = true;
  try {
    const answer = parsePoll(await run(POLL));
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

/* --- window helpers (T10's switcher, T11's swipe) --- */

export async function listWindows(): Promise<TmuxWindow[]> {
  return parseWindows(await run(LIST_WINDOWS));
}

/** The window's active pane with its colours as escapes (`-e`) — feed it to a terminal, not a
 *  <Text>. Rejects when the window is gone; the switcher decides what a missing card looks like. */
export function capturePane(windowIndex: number): Promise<string> {
  return run(capturePaneCommand(windowIndex));
}

export async function selectWindow(windowIndex: number): Promise<void> {
  await run(selectWindowCommand(windowIndex));
  void poll(); // the badge should not wait out the interval to notice
}

export async function killWindow(windowIndex: number): Promise<void> {
  await run(killWindowCommand(windowIndex));
  void poll();
}

export async function newWindow(): Promise<void> {
  await run(NEW_WINDOW);
  void poll();
}

/** Reorder for T10's drag-drop. Landing indices depend on the user's base-index/renumber
 *  options, so re-list after — the answer is what tmux did, not what we asked. */
export async function moveWindow(from: number, to: number): Promise<void> {
  await run(moveWindowCommand(from, to));
  void poll();
}
