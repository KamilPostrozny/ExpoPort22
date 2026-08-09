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
import { endpoint, getSettings } from '@/settings';
import { startTmux, stopTmux } from '@/tmux';

const TERM = 'xterm-256color';

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
let sink: ((base64: string) => void) | null = null;
let history: string[] = [];
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
  history = [];
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
    // A plain shell, never `tmux attach` of our own accord (§4.9) — the startup command is the
    // user's line and it replays on every reconnect, which is what makes a reconnect feel like a
    // resume rather than a fresh login.
    if (settings.startupCommand) await ExpoSSH.send(`${settings.startupCommand}\n`);
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

/** The user's own disconnect (§4.1): back to Setup, and nothing reconnects behind it. */
export async function disconnect(): Promise<void> {
  shellOpen = false;
  failures = 0;
  history = [];
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
export function attachTerminal(write: (base64: string) => void): () => void {
  sink = write;
  for (const chunk of history) write(chunk);
  return () => {
    if (sink === write) sink = null;
  };
}

/** Everything the terminal is meant to show, in order: onto the screen if one is attached, and
 *  into the history either way — the history is what a webview that boots later replays. */
function emit(base64: string) {
  history.push(base64);
  if (history.length > MAX_HISTORY_CHUNKS) history.shift();
  sink?.(base64);
}

ExpoSSH.addListener('onShellData', ({ data }) => emit(data));

ExpoSSH.addListener('onShellClose', () => {
  shellOpen = false;
  if (state.status === 'connected') set({ status: 'disconnected' });
});

ExpoSSH.addListener('onHostKey', async (hostKey) => {
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
