/** `bun test` — the one thing about shell output that can be wrong without a device: every chunk
 *  reaches the screen exactly once, in order, however the coalescing and the replay interleave.
 *
 *  Output crosses into the terminal in batches (see `emit`), which is three moving parts — a
 *  pending buffer, a zero timer, and a replay that fires on every webview boot. Getting them
 *  wrong does not throw; it duplicates a screenful or drops one. */

/// <reference types="bun" />
import { beforeEach, expect, mock, test } from 'bun:test';

/** Every window-change the module actually sent, so the dedupe in `setSize` is observable. */
const resizes: [number, number][] = [];

/** Captured from `addListener`, so the test can play the native side. */
const handlers: Record<string, (payload: unknown) => void> = {};

/** Every `send` the module made, and whether one was still running when the next arrived — the
 *  native side settles these on a thread POOL, so two in flight is two racing writers. */
const writes: string[] = [];
let inFlight = 0;
let overlapped = false;
/** How long the n-th write takes to settle, shuffled so a serial path is the only thing that can
 *  still come out in order. */
let delays: number[] = [];

mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }), currentState: 'active' },
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));
mock.module('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'stub',
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
mock.module('expo-crypto', () => ({
  getRandomBytes: () => new Uint8Array(32),
  randomUUID: () => 'id-fixed', // T17 host ids; this file never reads one
}));
/** T15's gate: what the biometric prompt answers, and how many times it was raised. */
let authResult: { success: boolean; error?: string } = { success: true };
let prompts = 0;
/** How many times a socket was actually opened — the gate's whole job is that a refusal leaves
 *  this at zero. */
let connects = 0;

mock.module('expo-local-authentication', () => ({
  authenticateAsync: async () => {
    prompts += 1;
    return authResult;
  },
  getEnrolledLevelAsync: async () => 3,
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

mock.module('../modules/expo-ssh/src/ExpoSSHModule', () => ({
  default: {
    addListener: (event: string, handler: (payload: unknown) => void) => {
      handlers[event] = handler;
      return { remove: () => {} };
    },
    connect: async () => {
      connects += 1;
    },
    disconnect: async () => {},
    startShell: async () => {},
    send: async (text: string) => {
      overlapped ||= inFlight > 0;
      inFlight += 1;
      writes.push(text);
      await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
      inFlight -= 1;
    },
    resize: async (cols: number, rows: number) => {
      resizes.push([cols, rows]);
    },
    exec: async () => '',
  },
}));

const { attachTerminal, authNeeded, connect, disconnect, getSession, send, setSize } =
  await import('@/session');
const { updateSettings } = await import('@/settings');

// The session is a module singleton, so the replay buffer outlives a test. `disconnect` is the
// real thing that empties it — the same path the Disconnect button takes.
beforeEach(async () => {
  await disconnect();
  updateSettings({ requireAuth: false });
  authResult = { success: true };
});

const shell = (data: string) => handlers.onShellData?.({ data });
/** One turn of the event loop — what the coalescing timer waits for. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Long enough for the slowest write below to settle and the queue behind it to drain. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

/* --- T15's gate --- */

/** The grace decision, without a clock: five minutes of cover for the foreground reconnects §4.9
 *  makes, and never a persisted one. `MINUTE`s are handed in, so nothing here waits. */
test('one unlock covers five minutes of reconnects, and a cold start has none', () => {
  const min = 60_000;
  // Off is off, whatever the timestamps say.
  expect(authNeeded(false, null, 0)).toBe(false);
  expect(authNeeded(false, 0, 99 * min)).toBe(false);
  // A cold launch: `lastAuthAt` is module state, so it is null however recently the user unlocked.
  expect(authNeeded(true, null, 12 * min)).toBe(true);
  expect(authNeeded(true, 0, 4 * min)).toBe(false); // inside
  expect(authNeeded(true, 0, 5 * min)).toBe(true); // the edge is asked, not waved through
  expect(authNeeded(true, 0, 60 * min)).toBe(true);
  // A phone whose clock moved backwards hands us a timestamp from the future. That is not a grace
  // anyone granted — ask again rather than trust it.
  expect(authNeeded(true, 10 * min, 1 * min)).toBe(true);
});

test('a refused gate never opens a socket, and says so in plain English', async () => {
  updateSettings({ requireAuth: true });
  authResult = { success: false, error: 'user_cancel' };
  connects = 0;
  prompts = 0;

  await connect();

  expect(prompts).toBe(1);
  expect(connects).toBe(0); // the whole point: nothing was dialled
  const session = getSession();
  expect(session.status).toBe('failed');
  // The §4.9 screen's sentence, not whatever the SSH stack would have said, and not a mismatch —
  // that is the one failure with a recovery button of its own.
  expect(session.status === 'failed' && session.message).toContain('locked');
  expect(session.status === 'failed' && session.mismatch).toBe(false);
});

/** Order-independent on purpose: whatever `lastAuthAt` is when this starts, the *second* connect is
 *  inside the grace the first one opened and must not ask again. Backgrounding is what makes this
 *  matter — §4.9 reconnects on every foreground. */
test('a reconnect inside the grace window does not ask again', async () => {
  updateSettings({ requireAuth: true });
  await connect();
  const asked = prompts;

  await disconnect();
  await connect();

  expect(prompts).toBe(asked);
  expect(getSession().status).toBe('connected');
});

test('a burst of chunks crosses into the terminal as one batch, in order', async () => {
  const seen: string[][] = [];
  const detach = attachTerminal((chunks) => seen.push(chunks));

  shell('aaa');
  shell('bbb');
  shell('ccc');
  expect(seen).toEqual([]); // nothing crosses until the turn ends

  await tick();
  expect(seen).toEqual([['aaa', 'bbb', 'ccc']]);
  detach();
});

test('a terminal attaching mid-flush replays the history without doubling it', async () => {
  const first = attachTerminal(() => {});
  shell('one');
  shell('two');
  first(); // the webview is reaped before the flush lands — iOS does this on backgrounding

  const seen: string[][] = [];
  const detach = attachTerminal((chunks) => seen.push(chunks));
  await tick();

  // Replayed once by the attach, and NOT a second time by the flush that was still queued.
  expect(seen.flat()).toEqual(['one', 'two']);
  detach();
});

test('output arriving with no terminal attached is replayed to the next one', async () => {
  shell('offscreen');
  await tick();

  const seen: string[][] = [];
  const detach = attachTerminal((chunks) => seen.push(chunks));
  expect(seen.flat()).toContain('offscreen');
  detach();
});

/** The webview re-reports a size it has already reported — coming out of a hold it cannot know
 *  which of its reports the screen dropped mid-zoom, and every switcher open is one such release.
 *  Unguarded that was an SSH window-change, and a SIGWINCH in the shell, per tab glance. */
test('a size the shell already has is not sent again', async () => {
  await connect();
  resizes.length = 0;

  setSize(100, 40);
  setSize(100, 40); // the re-report
  expect(resizes).toEqual([[100, 40]]);

  setSize(100, 41); // a real change still goes
  expect(resizes).toEqual([
    [100, 40],
    [100, 41],
  ]);
});

/** The one that matters: `less` typed fast arrived at the host as `lses` (2026-08-17), because the
 *  native `send` finishes on a thread pool and two calls in flight are two writers racing for the
 *  PTY stream. Nothing on the JS side can order what native has already parallelised — so the rule
 *  this asserts is that there is never a second call in flight, whatever order the first settles
 *  in. Drop the `await` in `pump` and both expectations below fail. */
test('a burst of keystrokes reaches the shell in submission order, one write at a time', async () => {
  await connect();
  await settled();
  writes.length = 0;
  overlapped = false;
  // Shuffled, longest first: anything issued alongside the opening write would settle ahead of it.
  delays = [8, 0, 6, 2, 4];

  const typed = [...'/etc/services'];
  for (const key of typed) send(key);
  await settled();

  expect(overlapped).toBe(false); // never two writers on one stream
  expect(writes.join('')).toBe('/etc/services'); // and the bytes in the order they were typed
  expect(writes.length).toBeLessThan(typed.length); // the burst coalesced behind the first write
});
