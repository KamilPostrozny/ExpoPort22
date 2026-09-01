/**
 * The tmux side-channel (§4.5): probe on connect, conf push over SFTP with a read-back verify,
 * the window helpers T10's switcher drives, and the ~2s poll that feeds T7's badge and T11's
 * badge. A module singleton read through `useSyncExternalStore`, like `settings` and `session` —
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
import { makePool, retryRefused } from '@/exec-pool';
import {
  parseSearchOutput,
  parseWindowSearch,
  searchPaneCommand,
  searchWindowCommand,
  type SearchHit,
  type WindowSearch,
} from '@/search-model';
import { getSettings, pollSession, SESSION_NAME, updateSettings, usesTmux } from '@/settings';
import {
  APPLY_AND_VERIFY,
  CONF_DIRECTORIES,
  CONF_PATH,
  LIST_SESSIONS,
  listWindowsCommand,
  newWindowCommand,
  pollCommand,
  PROBE,
  capturePaneCommand,
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
   *  to the start mode and is derived (see `deriveConfigStatus`), because a mode change is a
   *  Setup-screen change and takes effect on the next connect, not on the live server. */
  config: 'applied' | 'not-applied';
  /** A client is attached to the session our exec commands resolve to — for this app's one user,
   *  the phone's own PTY (the ceiling is in tmux-model's `pollCommand` comment). */
  attached: boolean;
  /** The session the last poll answered for BY NAME, or `null` — not attached, or a start mode
   *  with no name to give (`custom`, `shell`, `attach` on "most recent").
   *
   *  This is the one fact every window command is scoped to (`scope`) and the one the switcher
   *  lives or dies by (`tabsAvailable`): a grid must never outlive the session it belongs to, and
   *  a list must never be answered by a session nobody chose. See `sessionScope`. */
  session: string | null;
  /** The active window index while attached — T7's badge. `null` = not attached, badge default. */
  windowIndex: number | null;
};

const DOWN: TmuxState = {
  present: null,
  config: 'not-applied',
  attached: false,
  session: null,
  windowIndex: null,
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
    next.session === state.session &&
    next.windowIndex === state.windowIndex;
  if (same) return;
  state = next;
  console.log('[tmux]', JSON.stringify(next));
  for (const listener of listeners) listener();
}

function getTmux(): TmuxState {
  return state;
}

export function useTmux(): TmuxState {
  return useSyncExternalStore(subscribe, getTmux, getTmux);
}

/* --- the exec seam --- */

/** One short-lived exec channel per command, on the session's own connection, spending from NO
 *  budget — every caller in this file either goes through `run1` or is fanned out by a caller that
 *  pools it (see the arithmetic below). The commands are built to answer on stdout and exit 0 (see
 *  tmux-model), so a rejection here is transport-level — the caller decides whether that is silence
 *  or a throw. */
function run(command: string): Promise<string> {
  return ExpoSSH.exec(command, EXEC_LIMIT);
}

/** A command that answers in a line or two, through the singleton budget, retried once if sshd
 *  refuses the channel outright (see `retryRefused` — a refusal is strictly before execution, so
 *  even `new-window` is safe to re-ask). Everything in this file that is not fanned out per window
 *  goes through here; that is what makes the class countable. */
function run1(command: string): Promise<string> {
  return singlePool(() => retryRefused(() => run(command)));
}

/*
 * --- the channel budget ---
 *
 * Every exec is a channel, and sshd counts them all against `MaxSessions` (default 10) for the one
 * connection this app opens. THREE classes spend from it, and the whole point of splitting them is
 * that they cannot sum past the limit no matter how they overlap:
 *
 *   1  the shell's PTY, held for the whole session
 *   3  `execPool`  — the grid's per-window fan-outs (T10's captures, T14's greps), shared
 *   2  `singlePool` — every command that is not fanned out, via `run1`: the ~2s poll, `listWindows`,
 *                     select/kill/new/move, the probe, `cacheSessions`, `configure`'s two reads,
 *                     and the terminal view's own search (`searchWindow` — one window, not N)
 *   2  `shotPool`  — the un-fanned single captures (the zoom's `refreshCard`, the bar swipe's two
 *                     neighbour warms — which is three in flight if the two overlap)
 *   = 8, and the two spare cover `configure`'s SFTP upload plus whatever sshd counts that we do not.
 *
 * The FIRST version of this budget got the arithmetic wrong and the second Android walk proved it
 * (emulator, 2026-08-17): it bounded the two fan-outs at 4 and then assumed at most one singleton
 * on top. The pool held — a `ps` on the host caught exactly four concurrent `capture-pane` children
 * and never five, and no grep failed — but `open failed` still came back three times, at three
 * un-pooled sites: a fan-out capture for a window that was demonstrably alive, `listWindows`, and
 * `refreshCard`'s capture. Several singletons overlap in practice; unbounded classes summed past 10
 * beside a pool that was itself behaving. Hence: no class outside a pool.
 *
 * The measurement before any of it existed, kept because it is what made this a correctness fix and
 * not a tidy-up: 24 windows with the search armed fired 24 greps beside the captures and answered
 * `open failed` for 16 of them — and a window whose grep failed is a window the grid CANNOT tell
 * from "no hit". Note this is a different fault from BUGS.md's "one exec per grid open fails",
 * which stays refuted: that one was always a window the user had just killed.
 *
 * ponytail: three fixed numbers against the DEFAULT MaxSessions. A host set lower (`MaxSessions 4`)
 * still saturates — and now says so, in the grid's own words, instead of lying; a host set higher
 * just fills the grid slower than it could. The upgrade is to read the host's own limit, which sshd
 * does not advertise, so it would mean widening until `open failed` comes back and settling one
 * below. Not worth it until someone's host is actually the odd one.
 */

/** The per-window fan-outs — captures and greps go through THIS instance, never one each: two
 *  pools of three is six channels, which was the original bug. */
export const execPool = makePool(3);

/**
 * The single captures, kept OFF `execPool` on purpose: `refreshCard`'s capture is the one the
 * zoom-out crossfades into, and queueing it behind a grid's worth of captures would land stale
 * content on the card the flight arrives at. Two slots, so the aimed capture waits behind at most
 * one neighbour warm (~250ms) rather than behind twenty-four.
 */
export const shotPool = makePool(2);

/** Everything that is not fanned out per window (see `run1`). Two, because the walk showed several
 *  of them genuinely overlap — a poll, a `listWindows` and the user's select can all be in flight
 *  at once — and one reserved slot is what the old budget assumed and did not enforce. */
const singlePool = makePool(2);

/* --- lifecycle (driven by src/session.ts state transitions) --- */

/** The session is connected: probe, maybe push the conf, start the poll. Idempotent — the session
 *  calls it on every transition into `connected`. */
export async function startTmux(): Promise<void> {
  if (up) return;
  up = true;
  let present = false;
  try {
    present = parseProbe(await run1(PROBE));
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
  aimedAt = undefined; // the next connect says what it is aiming at, even if it is the same name
  set(DOWN); // `session` goes with it: no scope, no window commands, no grid (see `scope`)
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
    const remote = await run1(readFileCommand(`~/${CONF_PATH}`));
    if (needsPush(remote, tmuxExtras)) {
      const bytes = new TextEncoder().encode(generateConf(tmuxExtras));
      await ExpoSSH.upload(toBase64(bytes), CONF_PATH, CONF_DIRECTORIES);
    }
    // The whole apply: source our own file onto the running server, read the option back. Nothing
    // of the user's is touched on the way — see tmux-model's "why nothing of the user's is edited".
    const verified = parseVerify(await run1(APPLY_AND_VERIFY));
    set({ config: verified ? 'applied' : 'not-applied' });
    console.log('[tmux] configure:', verified ? 'applied' : 'not-applied (read-back said no)');
  } catch (error) {
    // §7: a failed conf push changes nothing visible. The status was already 'not-applied'.
    set({ config: 'not-applied' });
    console.log('[tmux] configure failed, nothing visible changes:', error);
  }
}

/* --- the poll (T7 badge) --- */

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
    // Ask about OUR session, not whichever one tmux last touched (see `pollCommand`).
    const wanted = pollSession(getSettings());
    if (wanted !== aimedAt) {
      aimedAt = wanted;
      console.log(`[tmux] poll aimed at ${wanted === null ? 'nothing (untargeted)' : `session ${wanted}`}`);
    }
    // The session that answered last time is asked first — it is where the shell actually IS, and
    // that does not change because a setting did (a start-mode change takes effect on the next
    // connect). It also keeps the retry below a one-off rather than a doubled poll every beat.
    let session = state.session ?? wanted;
    let answer = parsePoll(await run1(pollCommand(session)));
    // The one retry, and it is another NAME rather than the untargeted form. `attach` mode's pick
    // can be gone by morning, and `startupLine` says exactly where the shell went when it was:
    // `port22`, the session both tmux modes fall back to creating. Asking that by name cannot be
    // answered by a session nobody chose — which is precisely what the old untargeted fallback
    // could do, and did (BUGS: the grid re-listing onto the user's session after ours ended).
    if (answer === null && session !== null && session !== SESSION_NAME) {
      session = SESSION_NAME;
      answer = parsePoll(await run1(pollCommand(session)));
    }
    if (!up) return;
    const attached = answer?.attached ?? false;
    set({
      attached,
      // Only a session we NAMED and that answered gets to scope a window command or hold a grid
      // open. Nothing here can ever be a session tmux picked for us.
      session: attached ? session : null,
      windowIndex: answer?.attached ? answer.windowIndex : null,
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
    const names = parseSessions(await run1(LIST_SESSIONS));
    const known = getSettings().knownSessions;
    if (names.length !== known.length || names.some((name, i) => name !== known[i])) {
      updateSettings({ knownSessions: names });
    }
  } catch {
    // One list nobody is looking at yet; the next connect asks again.
  }
}

/* --- window helpers (T10's switcher, T11's swipe) --- */

/**
 * The session every session-relative command is scoped to — the one the last poll answered for by
 * name. Throws rather than degrading to an untargeted command: tabs are not offered at all without
 * it (`tabsAvailable` reads the same field), so getting here with no name is a bug in this app, not
 * a mode the user can be in. An untargeted `list-windows` is how the grid came to show — and offer
 * a ✕ for — a detached session's windows (BUGS, 2026-08-17).
 */
function scope(): string {
  const { session } = state;
  if (session === null) throw new Error('tmux: no named session to scope this command to');
  return session;
}

export async function listWindows(): Promise<TmuxWindow[]> {
  return parseWindows(await run1(listWindowsCommand(scope())));
}

/** The window's active pane with its colours as escapes (`-e`) — feed it to a terminal, not a
 *  <Text>. Rejects when the window is gone; the switcher decides what a missing card looks like.
 *
 *  One channel per call and NOT pooled here, because the two ways of calling it belong to
 *  different budgets: fanned out once per window it goes through `execPool`, and on its own — the
 *  capture the zoom-out crossfades into — through `shotPool`, so it never queues behind a grid's
 *  worth of them. Pooling it in here would put one inside the other and collapse both. Every
 *  caller picks its pool; none may call this bare. */
export function capturePane(windowId: string): Promise<string> {
  return run(capturePaneCommand(windowId));
}

/** T14: first occurrence of `query` in the window's whole scrollback, with the card's context —
 *  the search stays on the host (one grep per window per settled keystroke). `null` = no hit.
 *  Fanned out per window, so callers go through `execPool`. */
export async function searchPane(windowId: string, query: string): Promise<SearchHit | null> {
  return parseSearchOutput(await run(searchPaneCommand(windowId, query)));
}

/**
 * BUGS.md §6: the terminal view's search — every occurrence in ONE window, plus where the visible
 * ones are, in one exec.
 *
 * Through `run1`, not `execPool`: this is a singleton, one per settled keystroke for the window in
 * front of the user, so it belongs to the class the budget above already reserves two channels for.
 * It is deliberately NOT on the fan-out pool — a search typed on the terminal is not competing with
 * a grid full of captures (the caller holds it while the grid is up), and giving it a slot there
 * would take one off the grid's greps for a query the grid is not showing.
 *
 * Rejects if the host cannot be reached OR if the answer is unparseable — see `parseWindowSearch`:
 * a search that never reached the host must not read as "no hits in this window".
 */
export async function searchWindow(windowId: string, query: string): Promise<WindowSearch> {
  const parsed = parseWindowSearch(await run1(searchWindowCommand(windowId, query)), query);
  if (parsed === null) throw new Error(`search: no answer for ${windowId}`);
  return parsed;
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

export async function selectWindow(windowId: string): Promise<void> {
  await run1(selectWindowCommand(windowId));
  setTimeout(() => void poll(), NUDGE_AFTER_SLIDE_MS);
}

// Not deferred: a kill is not on the swipe path, and its grid wants the fresh list at once.
export async function killWindow(windowId: string): Promise<void> {
  await run1(killWindowCommand(windowId));
  void poll();
}

// Deferred like `selectWindow`: committing a swipe past the last tab births a window, and that
// commit is followed by the same slide.
export async function newWindow(): Promise<void> {
  await run1(newWindowCommand(scope()));
  setTimeout(() => void poll(), NUDGE_AFTER_SLIDE_MS);
}

/** Reorder for T10's drag-drop. Landing indices depend on the user's base-index/renumber
 *  options, so re-list after — the answer is what tmux did, not what we asked. */
export async function moveWindow(from: number, to: number): Promise<void> {
  await run1(moveWindowCommand(scope(), from, to));
  void poll();
}
