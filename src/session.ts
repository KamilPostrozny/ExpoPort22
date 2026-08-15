/**
 * The session: one connection, one PTY, and the lifecycle §4.9 describes.
 *
 * A module singleton read through `useSyncExternalStore`, like `settings` — the Setup screen, the
 * terminal screen and the AppState listener are three callers of one connection and none of them
 * owns it, so it cannot live in a component. It also outlives every screen: a route change must not
 * drop a shell.
 *
 * Shell output goes to whoever is attached and into a buffer until someone is. The webview takes a
 * moment to boot and the login banner is already on its way while it does.
 */

import { AppState } from 'react-native';
import { useSyncExternalStore } from 'react';

import type { HostKeyEvent } from '../modules/expo-ssh/src/ExpoSSH.types';
import ExpoSSH from '../modules/expo-ssh/src/ExpoSSHModule';
import { toBase64 } from '@/base64';
import { forgetHostKey, hostKeyVerdict, pinHostKey, pinnedHostKey } from '@/host-keys';
import { loadOrCreateKey } from '@/keys';
import { endpoint, getSettings, startupLine, validate } from '@/settings';
import { startTmux, stopTmux } from '@/tmux';
import { LIST_SESSIONS, parseSessions } from '@/tmux-model';

const TERM = 'xterm-256color';

/** A session list is a handful of names; nothing here needs the switcher's budget. */
const LIMIT = 64 * 1024;

/** Two in a row and we stop trying (§4.9). A third automatic attempt is a loop, not a recovery. */
const MAX_AUTOMATIC_ATTEMPTS = 2;

/** How much shell output is kept for replay. Two jobs: output that arrives before the webview has
 *  booted, and output already on screen when iOS reaps the webview — it reloads empty, and a live
 *  session behind a blank terminal reads as a dead one. Capped, because a session left running with
 *  no screen on it would otherwise grow without end.
 *
 *  ponytail: a replay of raw bytes, not a screen snapshot. A full-screen app that was running when
 *  the webview died redraws only on its next output; the upgrade path is asking tmux to redraw,
 *  which is T9's side channel and not worth a state machine of our own before then. */
const MAX_HISTORY_CHUNKS = 500;

/** Home the cursor, clear the screen, clear the scrollback. */
const CLEAR_SCREEN = toBase64(new TextEncoder().encode('\x1b[H\x1b[2J\x1b[3J'));

export type Session =
  /** No connection, and none wanted: the user is on Setup. */
  | { status: 'idle' }
  /** `hostKey` set means the handshake is waiting on the TOFU answer (§4.1). */
  | { status: 'connecting'; hostKey: HostKeyEvent | null }
  | { status: 'connected' }
  /** We were up and the socket went away. Backgrounding does this every time, and it is expected. */
  | { status: 'disconnected' }
  /** We could not get up. `mismatch` is the one failure with a recovery of its own. */
  | { status: 'failed'; message: string; mismatch: boolean };

let state: Session = { status: 'idle' };
let failures = 0;
/** What the last `startShell`/`resize` was told. The terminal reports its real size a beat after
 *  the webview boots, which can be either side of the shell opening. */
let size = { cols: 80, rows: 24 };
let shellOpen = false;
let sink: ((chunks: string[]) => void) | null = null;
let history: string[] = [];
/** Chunks emitted this turn, waiting for `drain` to carry them over together. */
let pending: string[] = [];
let flush: ReturnType<typeof setTimeout> | null = null;
/** Set when *we* are the ones refusing, so the rejection can say why in English rather than
 *  surfacing whatever the SSH library says when a handshake is abandoned. */
let refusal: { message: string; mismatch: boolean } | null = null;

const listeners = new Set<() => void>();

function set(next: Session) {
  state = next;
  console.log('[session]', JSON.stringify(next));
  // T9 rides these transitions: the tmux side-channel exists exactly while a shell does. Both
  // calls are idempotent, so every state change may say so unconditionally.
  if (next.status === 'connected') void startTmux();
  else stopTmux();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSession(): Session {
  return state;
}

export function useSession(): Session {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

/* --- the connection --- */

export async function connect(): Promise<void> {
  if (state.status === 'connecting') return;
  const settings = getSettings();
  refusal = null;
  resetHistory();
  set({ status: 'connecting', hostKey: null });
  try {
    const key = await loadOrCreateKey();
    // Stays pending through the host-key round trip below.
    await ExpoSSH.connect(settings.host, settings.port, settings.username, key.seedBase64);
    await ExpoSSH.startShell(size.cols, size.rows, TERM);
    shellOpen = true;
    // A new shell starts on a clean screen. Without this the last session's rows are still there,
    // and the new login prints underneath them — two banners, of which only the lower one is true.
    // It goes through `emit`, so a terminal attaching later replays the clear before the output.
    emit(CLEAR_SCREEN);
    failures = 0;
    set({ status: 'connected' });
    // The start mode's line (§4.1), replayed on every reconnect — which is what makes a reconnect
    // feel like a resume rather than a fresh login, and is why the tmux modes attach rather than
    // create: the second connect of the day finds the first one's session and walks back into it.
    const line = startupLine(settings);
    if (line !== null) await ExpoSSH.send(`${line}\n`);
  } catch (error) {
    shellOpen = false;
    // A half-open connection after a failed shell open would make the next `connect` fail for a
    // reason that has nothing to do with the network.
    await ExpoSSH.disconnect().catch(() => {});
    // Our own refusals are not worth retrying: the same key will be offered and refused again, and
    // a re-prompt on every foreground is how a user gets trained to tap Trust.
    failures = refusal ? MAX_AUTOMATIC_ATTEMPTS : failures + 1;
    set({ status: 'failed', ...(refusal ?? { message: describe(error), mismatch: false }) });
  }
}

/**
 * The host's tmux sessions, for Setup's attach picker (§4.1) — which is a screen with no session
 * behind it, so this opens one of its own for a single command and closes it again.
 *
 * The pinned-key guard is the whole reason this is a few lines rather than a flow: a first-ever
 * host answers with a key nobody has trusted, and the TOFU prompt lives over the terminal (§4.1),
 * not here — so before that first connect there is nothing to ask and nothing to show. The mode
 * still works meanwhile; with no pick it attaches to the most recent session.
 */
export async function listHostSessions(): Promise<string[]> {
  const settings = getSettings();
  if (validate(settings) !== null) return [];
  if (state.status === 'connected') return parseSessions(await ExpoSSH.exec(LIST_SESSIONS, LIMIT));
  if (state.status !== 'idle' && state.status !== 'failed') return [];
  if ((await pinnedHostKey(endpoint(settings))) === null) return [];
  try {
    const key = await loadOrCreateKey();
    await ExpoSSH.connect(settings.host, settings.port, settings.username, key.seedBase64);
    return parseSessions(await ExpoSSH.exec(LIST_SESSIONS, LIMIT));
  } catch {
    return []; // §7: an unreachable host on the Setup screen says nothing it does not already say
  } finally {
    // Unconditional: the live-session case returned above, so this connection is ours alone.
    await ExpoSSH.disconnect().catch(() => {});
  }
}

/** The user's own disconnect (§4.1): back to Setup, and nothing reconnects behind it. */
export async function disconnect(): Promise<void> {
  shellOpen = false;
  failures = 0;
  resetHistory();
  set({ status: 'idle' });
  await ExpoSSH.disconnect().catch(() => {});
}

/** The manual Reconnect button. A tap is a fresh start — the two-strike count only governs the
 *  retries nobody asked for. */
export function reconnect(): Promise<void> {
  failures = 0;
  return connect();
}

/** Answers the TOFU prompt (§4.1). Trusting pins the key for this endpoint from here on. */
export async function answerHostKey(trust: boolean): Promise<void> {
  if (state.status !== 'connecting' || state.hostKey === null) return;
  const { hostKey } = state;
  set({ status: 'connecting', hostKey: null });
  if (trust) await pinHostKey(endpoint(getSettings()), hostKey.key);
  else refusal = { message: 'You did not trust this host key.', mismatch: false };
  await ExpoSSH.verifyHostKey(trust);
}

/** Unpins the current endpoint, so the next connect asks again. The confirmation belongs to
 *  whoever calls this — there is no undo, and the pin is the only thing that would have caught a
 *  machine-in-the-middle. */
export function forgetPinnedHostKey(): Promise<void> {
  return forgetHostKey(endpoint(getSettings()));
}

/* --- the PTY --- */

/** Keystrokes and the replies the terminal writes on the app's behalf. Dropped when no shell is
 *  open: every caller is a finger on a key that is still on screen while a session is coming back. */
export function send(text: string): void {
  if (shellOpen) ExpoSSH.send(text).catch(() => {});
}

export function setSize(cols: number, rows: number): void {
  size = { cols, rows };
  if (shellOpen) ExpoSSH.resize(cols, rows).catch(() => {});
}

/** Points shell output at a terminal and replays the session so far into it. Called on every boot
 *  of the webview, not only the first: iOS reaps a backgrounded WKWebView and it comes back empty. */
export function attachTerminal(write: (chunks: string[]) => void): () => void {
  sink = write;
  // Anything still queued is already in `history`, and the replay below is about to carry it —
  // draining it afterwards as well would write those chunks to the screen twice.
  dropPending();
  if (history.length > 0) write(history.slice()); // one crossing for the whole replay, not 500
  return () => {
    if (sink === write) sink = null;
  };
}

/** Everything the terminal is meant to show, in order: onto the screen if one is attached, and
 *  into the history either way — the history is what a webview that boots later replays. */
function emit(base64: string) {
  history.push(base64);
  if (history.length > MAX_HISTORY_CHUNKS) history.shift();
  if (sink === null) return;
  // Coalesced, because a crossing into the terminal is not a cheap message. expo/dom serializes
  // each imperative call into a JavaScript SOURCE STRING and hands it to `evaluateJavaScript` on
  // the main thread, so one call per PTY read is one main-thread hop and one full JS parse per
  // read — and a redraw arrives as a burst of them. A zero timer, not a frame: everything native
  // delivered in this turn goes over together, and nothing waits on the display to echo.
  pending.push(base64);
  if (flush === null) flush = setTimeout(drain, 0);
}

function drain() {
  flush = null;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  sink?.(batch);
}

/** Forget what has not crossed yet, without touching `history`. */
function dropPending() {
  pending = [];
  if (flush !== null) clearTimeout(flush);
  flush = null;
}

/** A session boundary: the replay buffer and anything still queued for the screen both go. */
function resetHistory() {
  history = [];
  dropPending();
}

/**
 * Module-scope listeners are registered ONCE per app run — but Fast Refresh re-evaluates a module
 * on every edit, and each pass added another set. After a long session (52 reloads, 2026-08-13)
 * every shell chunk was being handled dozens of times over: dozens of history pushes and dozens
 * of writes into the webview per byte, which is a JS thread at 8fps and a gesture that shows two
 * or three states instead of an animation. The subscriptions are kept and disposed before
 * re-registering, so a reload replaces them instead of stacking.
 */
type Sub = { remove: () => void };
const HMR = globalThis as unknown as { __port22Subs?: Sub[] };
HMR.__port22Subs?.forEach((sub) => sub.remove());
HMR.__port22Subs = [];
const listen = <T>(event: string, handler: (payload: T) => void) => {
  HMR.__port22Subs?.push(ExpoSSH.addListener(event as never, handler as never) as unknown as Sub);
};

listen<{ data: string }>('onShellData', ({ data }) => emit(data));

listen('onShellClose', () => {
  shellOpen = false;
  if (state.status === 'connected') set({ status: 'disconnected' });
});

listen<HostKeyEvent>('onHostKey', async (hostKey) => {
  const where = endpoint(getSettings());
  const verdict = hostKeyVerdict(await pinnedHostKey(where), hostKey.key);
  console.log('[session] host key', verdict, hostKey.fingerprint);
  if (verdict === 'ask') {
    set({ status: 'connecting', hostKey });
    return;
  }
  if (verdict === 'mismatch') {
    refusal = {
      message:
        `${where} offered a different host key from the one you trusted. Either the machine was ` +
        `rebuilt, or something is answering in its place. Forget the old key only if you know why ` +
        `it changed.`,
      mismatch: true,
    };
  }
  await ExpoSSH.verifyHostKey(verdict === 'trust');
});

/* --- lifecycle (§4.9) --- */

AppState.addEventListener('change', async (next) => {
  if (next !== 'active') return;
  // Backgrounding kills the socket, but nothing tells us until something is sent — so ask, with a
  // round trip a half-open TCP cannot fake.
  if (state.status === 'connected' && !(await ExpoSSH.isAlive(2000).catch(() => false))) {
    shellOpen = false;
    set({ status: 'disconnected' });
  }
  const dead = state.status === 'disconnected' || state.status === 'failed';
  if (dead && failures < MAX_AUTOMATIC_ATTEMPTS) connect();
});

/**
 * What a failed connect says on screen (§4.1 wants plain English). What the SSH stack raises is not
 * that: a refused socket arrives as `UnexpectedException: … NIOPosix.NIOConnectionError error 1 …
 * ConcurrentFunctionDefinition.swift:90`, measured on the device. The raw text stays in the log,
 * where it is useful, and the user gets the sentence that tells them what to go and check.
 */
function describe(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  console.log('[session] connect failed:', raw);
  if (/NIOConnectionError|refused|timed ?out|unreachable|reset|Network is down/i.test(raw)) {
    return (
      `Could not reach ${endpoint(getSettings())}. Check the address and port, that the machine is ` +
      `awake, and that the phone is on the same network.`
    );
  }
  if (/auth|permission|publickey/i.test(raw)) {
    return (
      'The host would not accept this key. Add the public key from Setup to ~/.ssh/authorized_keys ' +
      'on the machine, then try again.'
    );
  }
  return 'Could not connect. The reason is in the log.';
}
