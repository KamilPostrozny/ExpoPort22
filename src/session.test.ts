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
mock.module('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(32) }));
mock.module('../modules/expo-ssh/src/ExpoSSHModule', () => ({
  default: {
    addListener: (event: string, handler: (payload: unknown) => void) => {
      handlers[event] = handler;
      return { remove: () => {} };
    },
    connect: async () => {},
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

const { attachTerminal, connect, disconnect, send, setSize } = await import('@/session');

// The session is a module singleton, so the replay buffer outlives a test. `disconnect` is the
// real thing that empties it — the same path the Disconnect button takes.
beforeEach(async () => {
  await disconnect();
});

const shell = (data: string) => handlers.onShellData?.({ data });
/** One turn of the event loop — what the coalescing timer waits for. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Long enough for the slowest write below to settle and the queue behind it to drain. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

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
