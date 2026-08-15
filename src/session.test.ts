/** `bun test` — the one thing about shell output that can be wrong without a device: every chunk
 *  reaches the screen exactly once, in order, however the coalescing and the replay interleave.
 *
 *  Output crosses into the terminal in batches (see `emit`), which is three moving parts — a
 *  pending buffer, a zero timer, and a replay that fires on every webview boot. Getting them
 *  wrong does not throw; it duplicates a screenful or drops one. */

/// <reference types="bun" />
import { beforeEach, expect, mock, test } from 'bun:test';

/** Captured from `addListener`, so the test can play the native side. */
const handlers: Record<string, (payload: unknown) => void> = {};

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
    send: async () => {},
    resize: async () => {},
    exec: async () => '',
  },
}));

const { attachTerminal, disconnect } = await import('@/session');

// The session is a module singleton, so the replay buffer outlives a test. `disconnect` is the
// real thing that empties it — the same path the Disconnect button takes.
beforeEach(async () => {
  await disconnect();
});

const shell = (data: string) => handlers.onShellData?.({ data });
/** One turn of the event loop — what the coalescing timer waits for. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
