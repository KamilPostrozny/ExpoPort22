/** `bun test` — the clipboard slots' decisions (§4.4/§4.7), all pure: the three-slot ring, pin
 *  survival and unpin-drops, provenance wording, and the SecureStore pin round trip. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  decodePins,
  isFileUri,
  MAX_UNPINNED,
  provenance,
  push,
  relativeTime,
  serializePins,
  togglePin,
  type Slot,
} from '@/clipboard-model';

const yank = (text: string, at = 0, pinned = false): Slot => ({
  text,
  source: 'yank',
  at,
  pinned,
});

/* --- the ring --- */

test('a yank lands on top', () => {
  const slots = push([yank('a')], yank('b'));
  expect(slots.map((s) => s.text)).toEqual(['b', 'a']);
});

test('the fourth unpinned yank rotates the oldest out', () => {
  let slots: Slot[] = [];
  for (const text of ['a', 'b', 'c', 'd']) slots = push(slots, yank(text));
  expect(slots).toHaveLength(MAX_UNPINNED);
  expect(slots.map((s) => s.text)).toEqual(['d', 'c', 'b']);
});

test('a pinned slot survives any number of new yanks and does not eat a ring place', () => {
  let slots = push([], yank('secret', 0, true));
  for (const text of ['a', 'b', 'c', 'd']) slots = push(slots, yank(text));
  expect(slots.map((s) => s.text)).toEqual(['d', 'c', 'b', 'secret']);
});

test('unpinning a slot beyond the newest three drops it on the spot', () => {
  let slots = push([], yank('old', 0, true));
  for (const text of ['a', 'b', 'c']) slots = push(slots, yank(text));
  expect(slots.map((s) => s.text)).toEqual(['c', 'b', 'a', 'old']);
  slots = togglePin(slots, 3);
  expect(slots.map((s) => s.text)).toEqual(['c', 'b', 'a']);
});

test('unpinning a slot still among the newest three keeps it', () => {
  let slots = push([], yank('recent', 0, true));
  slots = push(slots, yank('a'));
  slots = togglePin(slots, 1);
  expect(slots.map((s) => s.text)).toEqual(['a', 'recent']);
  expect(slots[1].pinned).toBe(false);
});

test('pinning is togglePin the other way', () => {
  const slots = togglePin([yank('a')], 0);
  expect(slots[0].pinned).toBe(true);
});

/* --- provenance --- */

test('relative time buckets', () => {
  expect(relativeTime(0, 30_000)).toBe('just now');
  expect(relativeTime(0, 2 * 60_000)).toBe('2 min ago');
  expect(relativeTime(0, 3 * 3_600_000)).toBe('3 h ago');
  expect(relativeTime(0, 2 * 86_400_000)).toBe('2 d ago');
});

test('provenance reads like the design', () => {
  expect(provenance(yank('x', 0), 2 * 60_000)).toBe('tmux yank · 2 min ago');
  expect(provenance({ text: 't', source: 'pasteboard', at: 0, pinned: true }, 999)).toBe(
    'phone pasteboard · pinned',
  );
});

/* --- pin persistence --- */

test('pins round-trip; unpinned slots do not travel', () => {
  const slots = [yank('a', 5), { text: 'ghp_x', source: 'pasteboard' as const, at: 7, pinned: true }];
  const restored = decodePins(serializePins(slots));
  expect(restored).toEqual([{ text: 'ghp_x', source: 'pasteboard', at: 7, pinned: true }]);
});

test('a bad pin blob is an empty list, not a crash', () => {
  expect(decodePins(null)).toEqual([]);
  expect(decodePins('not json')).toEqual([]);
  expect(decodePins('{"still":"not a list"}')).toEqual([]);
  expect(decodePins('[{"text":""},{"text":"ok","source":"nonsense","at":"x"}]')).toEqual([
    { text: 'ok', source: 'yank', at: 0, pinned: true },
  ]);
});

test('a copied file is a file, not a line to type', () => {
  expect(isFileUri('content://com.android.providers/document/1234')).toBe(true);
  expect(isFileUri('file:///private/var/mobile/spec.pdf')).toBe(true);
  expect(isFileUri('https://example.com/spec.pdf')).toBe(false);
  expect(isFileUri('ls -la /tmp')).toBe(false);
});
