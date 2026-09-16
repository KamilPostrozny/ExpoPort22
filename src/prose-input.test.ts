/** Prose mode's input routing: the key split and the smart-punctuation normalization. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import { DEL } from '@/keybar-model';
import {
  CARET_PARK_MIN,
  heldStep,
  proseKey,
  proseSelfKey,
  proseText,
  walkStep,
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

test('a small step is travel, wherever the caret is', () => {
  expect(walkStep(-1, 12, 13)).toBe('send');
  expect(walkStep(2, 0, 13)).toBe('send'); // stepping off the edge is still travel
});

test('a big jump that lands on an edge is held, not sent', () => {
  // The park shape: 12 -> 0 in one sample, or 0 -> 13.
  expect(walkStep(-12, 0, 13)).toBe('hold');
  expect(walkStep(13, 13, 13)).toBe('hold');
  // A big jump into the middle of the line is travel — nothing parks there.
  expect(walkStep(9, 9, 13)).toBe('send');
});

test('the sample after a held jump says which it was', () => {
  // Kept going the same way: travel, and the held cells were real.
  expect(heldStep(-12, -2)).toBe('travel');
  expect(heldStep(12, 1)).toBe('travel');
  // Stopped dead or turned back: iOS put the caret there, the user did not.
  expect(heldStep(-12, 0)).toBe('park');
  expect(heldStep(12, -3)).toBe('park');
  expect(heldStep(12, 0)).toBe('park');
});
