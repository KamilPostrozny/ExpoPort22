/** T12's input polish: the dictation decision table (§4.2) and the sheet's release rule (§4.8). */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  SHEET_DISMISS_DISTANCE,
  SHEET_DISMISS_VELOCITY,
  filterDictation,
  sheetShouldDismiss,
  trackLine,
} from '@/input-model';
import { DEL } from '@/keybar-model';

/* --- the dictation filter's decision table --- */

test('a dictated chunk at an empty line loses its leading space', () => {
  expect(filterDictation(0, ' ls')).toBe('ls');
  expect(filterDictation(0, ' git status')).toBe('git status');
});

test('a dictated chunk mid-line keeps its space — that is the join iOS meant', () => {
  expect(filterDictation(3, ' -la')).toBe(' -la');
});

test('a real spacebar press always sends, empty line or not', () => {
  expect(filterDictation(0, ' ')).toBe(' ');
  expect(filterDictation(5, ' ')).toBe(' ');
});

test('inserts without a leading space pass untouched', () => {
  expect(filterDictation(0, 'ls')).toBe('ls');
  expect(filterDictation(0, DEL + ' x')).toBe(DEL + ' x'); // deletes first = not a fresh insert
});

/* --- the line tracker behind it --- */

test('printables count up, DEL counts down and floors at zero', () => {
  let len = trackLine(0, 'ls -la');
  expect(len).toBe(6);
  len = trackLine(len, DEL + DEL);
  expect(len).toBe(4);
  expect(trackLine(1, DEL + DEL + DEL)).toBe(0);
});

test('Return, ^C and ^U reset the line; other control bytes are ignored', () => {
  expect(trackLine(9, '\r')).toBe(0);
  expect(trackLine(9, '\x03')).toBe(0); // ^C: the prompt redraws empty
  expect(trackLine(9, '\x15')).toBe(0); // ^U: kill-line
  expect(trackLine(9, '\x1a')).toBe(9); // ^Z: the line is the shell's problem now, not emptied
  expect(trackLine(9, '\x09')).toBe(9); // Tab: completion output is invisible from here
});

test('a pasted multi-line command ends tracking on the last line', () => {
  expect(trackLine(0, 'echo a\necho bb')).toBe(7);
});

/* --- the sheet's release decision --- */

test('the sheet dismisses past the distance or on a flick, and never upward', () => {
  expect(sheetShouldDismiss(SHEET_DISMISS_DISTANCE + 1, 0)).toBe(true);
  expect(sheetShouldDismiss(40, SHEET_DISMISS_VELOCITY + 1)).toBe(true); // short but fast
  expect(sheetShouldDismiss(SHEET_DISMISS_DISTANCE - 1, 100)).toBe(false); // short and slow
  expect(sheetShouldDismiss(-200, 9999)).toBe(false); // upward release
  expect(sheetShouldDismiss(0, 9999)).toBe(false);
});
