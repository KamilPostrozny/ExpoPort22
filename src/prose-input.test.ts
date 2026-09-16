/** Prose mode's input routing: the key split and the smart-punctuation normalization. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import { DEL, diffInput } from '@/keybar-model';
import {
  CARET_PARK_MIN,
  proseKey,
  proseSelfKey,
  proseStart,
  proseText,
  proseWalk,
} from '@/prose-input';

const plain = { ctrl: false, alt: false, meta: false };

test('printable characters belong to the browser, so the field can hold a line', () => {
  for (const key of ['a', 'Z', '7', ' ', '.', '’', 'é']) {
    expect(proseKey(key, plain, '', 0)).toBe('browser');
  }
});

test('keys xterm owns stay xterm-s: escapes, navigation, function keys and Return', () => {
  for (const key of ['Escape', 'Tab', 'ArrowLeft', 'Home', 'End', 'F5', 'Enter', 'Dead']) {
    expect(proseKey(key, plain, 'ls', 2)).toBe('xterm');
  }
});

test('a chord is never typed into the field', () => {
  expect(proseKey('c', { ctrl: true, alt: false, meta: false }, '', 0)).toBe('xterm');
  expect(proseKey('f', { ctrl: false, alt: true, meta: false }, '', 0)).toBe('xterm');
  expect(proseKey('k', { ctrl: false, alt: false, meta: true }, '', 0)).toBe('xterm');
});

test('backspace is the browser-s while there is something before the caret', () => {
  expect(proseKey('Backspace', plain, 'ls -l', 5)).toBe('browser');
  expect(proseKey('Backspace', plain, 'ls -l', 1)).toBe('browser');
  // Nothing to delete: no input event would fire, so the DEL has to be sent here — this is what
  // makes a held backspace keep working once the line is empty.
  expect(proseKey('Backspace', plain, '', 0)).toBe('self');
  expect(proseKey('Backspace', plain, 'ls', 0)).toBe('self');
});

test('forward delete is the browser-s only while there is something after the caret', () => {
  expect(proseKey('Delete', plain, 'ls -l', 2)).toBe('browser');
  expect(proseKey('Delete', plain, 'ls -l', 5)).toBe('self');
  expect(proseKey('Delete', plain, '', 0)).toBe('self');
});

test('the self byte is the one that edge needs', () => {
  expect(proseSelfKey('Backspace')).toBe(DEL);
  expect(proseSelfKey('Delete')).toBe('\x1b[3~');
});

test('a missing caret reads as the end of the line', () => {
  expect(proseKey('Backspace', plain, 'ls', null)).toBe('browser');
  expect(proseKey('Delete', plain, 'ls', null)).toBe('self');
});

test('iOS non-breaking spaces become the spacebar the PTY understands', () => {
  expect(proseText('ls\u00a0-l')).toBe('ls -l');
  expect(proseText('a\u202fb')).toBe('a b');
  expect(proseText(' plain ')).toBe(' plain ');
  expect(proseText('a\u00a0b\u202fc')).toBe('a b c');
});

/** A walk state, written out: the anchor, the gesture's origin, and the last accepted step. */
const at = (caret: number, burst: number, last: number) => ({ caret, burst, last });

test('a drag sends one arrow per character and keeps the anchor', () => {
  // The gesture began at the end of the line (11), where typing left the caret.
  expect(proseWalk('hello world', at(11, -1, 0), 5)).toEqual({
    action: 'send',
    arrows: -6,
    state: { caret: 5, burst: 11, last: -6 },
  });
  // Later samples are measured from the anchor the last one left, still against the same origin.
  expect(proseWalk('hello world', at(5, 11, -6), 3)).toEqual({
    action: 'send',
    arrows: -2,
    state: { caret: 3, burst: 11, last: -2 },
  });
});

test('a drag reaches either edge, and stillness sends nothing', () => {
  const text = 'hello world';
  expect(proseWalk(text, at(11, -1, 0), 0)).toEqual({
    action: 'send',
    arrows: -11,
    state: { caret: 0, burst: 11, last: -11 },
  });
  expect(proseWalk(text, at(0, 11, -11), 0)).toEqual({ action: 'none', state: at(0, 11, -11) });
  expect(proseWalk('ls -l', at(5, 3, -2), 5)).toEqual({ action: 'none', state: at(5, 3, -2) });
});

test('the caret iOS restores when the trackpad ends is a park, not travel', () => {
  // Measured on the phone: a drag to column 0 of a 13-character field, the release arriving as one
  // +13 straight back to the end. The gesture began at 13, so that landing is the restore.
  expect(proseWalk('hello, world!', at(0, 13, -13), 13)).toEqual({
    action: 'park',
    // The anchor stays where the last accepted sample left it: the field is snapped back to the
    // PTY's cursor, not to the caret iOS just restored.
    state: { caret: 0, burst: -1, last: 0 },
  });
});

test('a landing that is not the origin is travel, however far and whichever way it reverses', () => {
  expect(proseWalk('hello, world!', at(0, 13, -13), 9)).toEqual({
    action: 'send',
    arrows: 9,
    state: { caret: 9, burst: 13, last: 9 },
  });
});

test('dragging back to the end of the line still gets there', () => {
  // The return is progressive, so every step runs the same way round as the one before it and none
  // of them is mistaken for the restore — the whole reason the park needs a reversal, not just the
  // landing. A settlement on the landing alone would swallow the last step of this every time.
  const reversed = proseWalk('hello, world!', at(0, 13, -13), 2);
  expect(reversed).toEqual({
    action: 'send',
    arrows: 2,
    state: { caret: 2, burst: 13, last: 2 },
  });
  expect(proseWalk('hello, world!', at(2, 13, 2), 13)).toEqual({
    action: 'send',
    arrows: 11,
    state: { caret: 13, burst: 13, last: 11 },
  });
});

test('a finger turning round at the origin is not a restore', () => {
  // One cell the other way, landing exactly on the origin: below CARET_PARK_MIN, so it is a finger.
  expect(proseWalk('hello, world!', at(12, 13, -1), 13)).toEqual({
    action: 'send',
    arrows: 1,
    state: { caret: 13, burst: 13, last: 1 },
  });
  expect(CARET_PARK_MIN).toBe(3);
});

test('the first sample of a gesture can never be the restore', () => {
  // With no burst yet the origin IS the anchor, so a landing on it means no movement at all.
  expect(proseWalk('hello, world!', at(13, -1, 0), 13)).toEqual({
    action: 'none',
    state: at(13, -1, 0),
  });
});

test('a supplementary character takes one arrow, not two UTF-16 arrows', () => {
  expect(proseWalk('a😀b', at(4, -1, 0), 1)).toEqual({
    action: 'send',
    arrows: -2,
    state: { caret: 1, burst: 4, last: -3 },
  });
  expect(proseWalk('a😀b', at(1, 4, -3), 4)).toEqual({
    action: 'send',
    arrows: 2,
    state: { caret: 4, burst: 4, last: 3 },
  });
});

test('out-of-range positions stay inside the current field', () => {
  expect(proseWalk('', proseStart(), -1)).toEqual({ action: 'none', state: proseStart() });
  expect(proseWalk('abc', at(20, -1, 0), -10)).toEqual({
    action: 'send',
    arrows: -3,
    state: { caret: 0, burst: 3, last: -3 },
  });
});

test('typing after a drag inserts at the new anchor without deleting and replaying the suffix', () => {
  const before = 'hello world';
  const walk = proseWalk(before, at(before.length, -1, 0), 5);
  const caret = walk.action === 'send' ? walk.state.caret : 0;
  expect(walk.action === 'send' && walk.arrows).toBe(-6);
  const edit = diffInput(before, 'hello! world', caret);
  expect(edit).toEqual({ ahead: 0, keys: '!', caret: 6 });
  // The timer after the edit must not send its caret movement a second time: the edit re-anchored
  // the walk, so the sample that follows it is stillness.
  expect(proseWalk('hello! world', at(edit.caret, -1, 0), 6)).toEqual({
    action: 'none',
    state: at(6, -1, 0),
  });
});

test('backspace after a drag deletes only the character before the new caret', () => {
  const before = 'hello world';
  const walk = proseWalk(before, at(before.length, -1, 0), 5);
  const caret = walk.action === 'send' ? walk.state.caret : 0;
  expect(diffInput(before, 'hell world', caret)).toEqual({ ahead: 0, keys: DEL, caret: 4 });
});

test('repeated characters are edited at the moved caret', () => {
  const walk = proseWalk('aaaa', at(4, -1, 0), 2);
  const caret = walk.action === 'send' ? walk.state.caret : 0;
  expect(diffInput('aaaa', 'aaaaa', caret)).toEqual({ ahead: 0, keys: 'a', caret: 3 });
});
