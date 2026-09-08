/** `bun test` — the key bar's decisions (§4.4), all pure: the Ctrl state machine, control-byte
 *  derivation, nav-key sequences (DECCKM-aware, on top of T6's `arrowKey`), the typed-input diff
 *  behind the native TextInput, and the bar-swipe classification. The UI only executes these. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  CHORD_STRIP,
  CTRL_DOUBLE_TAP_MS,
  DEL,
  afterChord,
  CARET_STEP_MAX,
  applyCtrl,
  caretKeys,
  barDismisses,
  barGrabbed,
  rowJoins,
  ROW_AIR_PROG,
  controlByte,
  ctrlTap,
  diffInput as planInputEdit,
  navKey,
  pasteBytes,
} from '@/keybar-model';
import * as model from '@/keybar-model';
import { TAP_MS, arrowKey, isTwoFingerTap } from '@/scroll-model';

/* --- Ctrl state machine --- */

test('tap arms, a chord disarms', () => {
  expect(ctrlTap('off', Infinity)).toBe('armed');
  expect(afterChord('armed')).toBe('off');
});

test('double-tap locks, and locked survives chords until tapped again', () => {
  const armed = ctrlTap('off', Infinity);
  expect(ctrlTap(armed, CTRL_DOUBLE_TAP_MS - 1)).toBe('locked');
  expect(afterChord('locked')).toBe('locked');
  expect(ctrlTap('locked', 50)).toBe('off');
});

test('a slow second tap disarms instead of locking', () => {
  expect(ctrlTap('armed', CTRL_DOUBLE_TAP_MS + 1)).toBe('off');
});

/* --- control bytes --- */

test('the chord strip letters map to their control bytes', () => {
  expect(controlByte('C')).toBe('\x03');
  expect(controlByte('D')).toBe('\x04');
  expect(controlByte('Z')).toBe('\x1a');
  expect(controlByte('R')).toBe('\x12');
  expect(controlByte('L')).toBe('\x0c');
});

test('case does not matter and non-chordable keys return null', () => {
  expect(controlByte('c')).toBe('\x03');
  expect(controlByte('[')).toBe('\x1b');
  expect(controlByte('1')).toBeNull();
  expect(controlByte(' ')).toBeNull();
  expect(controlByte('\x7f')).toBeNull();
});

test('the strip is the static five, in order, with captions', () => {
  expect(CHORD_STRIP.map((c) => c.letter).join('')).toBe('CZRLD');
  expect(CHORD_STRIP.map((c) => c.caption)).toEqual([
    'interrupt', 'suspend', 'history', 'clear', 'EOF',
  ]);
});

/* --- applying Ctrl to a typed key --- */

test('armed chords the next letter and disarms', () => {
  expect(applyCtrl('armed', 'x')).toEqual({ out: '\x18', mode: 'off' });
});

test('locked chords every letter and stays locked', () => {
  expect(applyCtrl('locked', 'c')).toEqual({ out: '\x03', mode: 'locked' });
  expect(applyCtrl('locked', 'c')).toEqual({ out: '\x03', mode: 'locked' });
});

test('off passes everything through', () => {
  expect(applyCtrl('off', 'x')).toEqual({ out: 'x', mode: 'off' });
});

test('a non-chordable key passes through and leaves the arm standing', () => {
  expect(applyCtrl('armed', '\r')).toEqual({ out: '\r', mode: 'armed' });
  expect(applyCtrl('armed', DEL)).toEqual({ out: DEL, mode: 'armed' });
});

/* --- arrows / Home / End (reusing T6's arrowKey for up/down) --- */

test('up and down are exactly what the scroll layer already sends', () => {
  expect(navKey('up', false)).toBe(arrowKey(true, false));
  expect(navKey('down', false)).toBe(arrowKey(false, false));
  expect(navKey('up', true)).toBe(arrowKey(true, true));
});

test('the six keys, normal cursor mode', () => {
  expect(navKey('up', false)).toBe('\x1b[A');
  expect(navKey('down', false)).toBe('\x1b[B');
  expect(navKey('right', false)).toBe('\x1b[C');
  expect(navKey('left', false)).toBe('\x1b[D');
  expect(navKey('home', false)).toBe('\x1b[H');
  expect(navKey('end', false)).toBe('\x1b[F');
});

test('DECCKM switches all six to SS3', () => {
  expect(navKey('up', true)).toBe('\x1bOA');
  expect(navKey('down', true)).toBe('\x1bOB');
  expect(navKey('right', true)).toBe('\x1bOC');
  expect(navKey('left', true)).toBe('\x1bOD');
  expect(navKey('home', true)).toBe('\x1bOH');
  expect(navKey('end', true)).toBe('\x1bOF');
});

/* --- the typed-input diff (native TextInput → PTY bytes) --- */

const diffInput = (prev: string, next: string, caret = prev.length) =>
  planInputEdit(prev, next, caret).keys;

test('typing appends', () => {
  expect(diffInput('', 'a')).toBe('a');
  expect(diffInput('a', 'ab')).toBe('b');
  expect(diffInput('ab', 'ab word')).toBe(' word');
});

test('backspace deletes', () => {
  expect(diffInput('ab', 'a')).toBe(DEL);
  expect(diffInput('ab', '')).toBe(DEL + DEL);
});

test('a replacement is deletes then the new tail', () => {
  expect(diffInput('abc', 'abX')).toBe(DEL + 'X');
});

test('an edit at a moved caret is that edit alone, not the tail retyped', () => {
  // Hold-space put the caret after `ls `; the PTY's cursor went with it, so the line past the
  // caret is the shell's business and must not come back as deletes.
  expect(diffInput('ls -la', 'ls x-la', 3)).toBe('x');
  expect(diffInput('ls -la', 'ls-la', 3)).toBe(DEL); // backspace at the same spot
  expect(diffInput('ls -la', 'x' + 'ls -la', 0)).toBe('x'); // at the very start
});

test('a tail edit still wins the tie — the prefix is matched first', () => {
  expect(diffInput('aa', 'aaa')).toBe('a');
  expect(diffInput('aaa', 'aa')).toBe(DEL);
  expect(diffInput(' '.repeat(8), ' '.repeat(7))).toBe(DEL); // the pad, one held-delete repeat
});

test('no change sends nothing', () => {
  expect(diffInput('a', 'a')).toBe('');
  expect(diffInput('', '')).toBe('');
});

test('an astral character is one key both ways', () => {
  expect(diffInput('', '😀')).toBe('😀');
  expect(diffInput('😀', '')).toBe(DEL);
  // A shared high surrogate must not be counted as common prefix.
  expect(diffInput('😀', '😁')).toBe(DEL + '😁');
  // Nor a shared low surrogate as common tail: 'x😀' → '😀' is one delete, not half a pair kept.
  expect(diffInput('x😀', '😀', 1)).toBe(DEL);
  expect(diffInput('a😀', 'b😀', 1)).toBe(DEL + 'b');
});

test('autocorrect rewrites the shared suffix behind the cursor, including the apostrophe in let’s', () => {
  for (const apostrophe of ["'", '’']) {
    expect(diffInput('lets', `let${apostrophe}s`)).toBe(DEL + apostrophe + 's');
    expect(diffInput('lets ', `let${apostrophe}s `)).toBe(DEL.repeat(2) + apostrophe + 's ');
    expect(diffInput('dont', `don${apostrophe}t`)).toBe(DEL + apostrophe + 't');
  }
  expect(diffInput('teh ', 'the ')).toBe(DEL.repeat(3) + 'he ');
  expect(diffInput('helo world ', 'hello world ')).toBe(DEL.repeat(8) + 'lo world ');
});

test('correction at a moved caret rewrites only up to that caret', () => {
  expect(planInputEdit('lets go', 'let’s go', 4)).toEqual({
    ahead: 0, keys: DEL + '’s', caret: 5,
  });
  expect(planInputEdit('aaa', 'aaaa', 1)).toEqual({ ahead: 0, keys: 'a', caret: 2 });
  expect(planInputEdit('aaa', 'aa', 1)).toEqual({ ahead: 0, keys: DEL, caret: 0 });
});

test('a replacement extending beyond the caret moves to its old end first', () => {
  expect(planInputEdit('teh next', 'the next', 1)).toEqual({
    ahead: 2, keys: DEL.repeat(2) + 'he', caret: 3,
  });
});

test('terminal replay agrees with native text and cursor across correction/edit sequences', () => {
  const cases: [string, string, number][] = [
    ['lets', 'let’s', 4], ['lets ', "let's ", 5], ['let’s ', 'lets ', 6],
    ['teh ', 'the ', 4], ['helo world ', 'hello world ', 11],
    ['lets go', 'let’s go', 4], ['ls -la', 'ls x-la', 3], ['ls -la', 'ls-la', 3],
    ['aaa', 'aaaa', 1], ['aaa', 'aa', 1], ['teh next', 'the next', 1],
    ['😀lets', '😀let’s', 6], ['a😀', 'b😀', 3], ['😀😀', '😀x😀', 2],
    [' '.repeat(512) + 'lets', ' '.repeat(512) + 'let’s', 516],
  ];
  for (const [prev, next, caret] of cases) {
    const edit = planInputEdit(prev, next, caret);
    const screen = [...prev];
    let cursor = [...prev.slice(0, caret)].length + edit.ahead;
    for (const key of edit.keys) {
      if (key === DEL) screen.splice(--cursor, 1);
      else screen.splice(cursor++, 0, key);
    }
    expect(screen.join('')).toBe(next);
    expect(screen.slice(0, cursor).join('').length).toBe(edit.caret);
  }
});

/* --- hold-space: the caret's move, as arrows --- */

test('a caret walked left or right is that many arrows', () => {
  expect(caretKeys(1, false)).toBe('\x1b[C');
  expect(caretKeys(-2, false)).toBe('\x1b[D'.repeat(2));
  expect(caretKeys(1, true)).toBe('\x1bOC'); // DECCKM: the app asked for SS3
});

test('a caret that did not move sends nothing', () => {
  expect(caretKeys(0, false)).toBe('');
  expect(caretKeys(0, true)).toBe('');
});

test('a settled delta of several characters is still travel', () => {
  // The caller drops the parks per event; what reaches here has settled, and a fast drag can
  // legitimately have crossed more than one character in that window.
  expect(caretKeys(5, false)).toBe('\x1b[C'.repeat(5));
  expect(CARET_STEP_MAX).toBeGreaterThan(1); // room for a coalesced pair of real steps
});

/* --- the bar grab: one gesture, both axes live --- */

test('the grab is either axis — from there both are live and neither is a decision', () => {
  expect(barGrabbed(5, 5)).toBe(false);
  expect(barGrabbed(11, 0)).toBe(true);
  expect(barGrabbed(0, -11)).toBe(true); // a pull straight up is a grab too
});

test('the row joins at the slop on the bar, and only there', () => {
  expect(rowJoins(5, 0, 0)).toBe(false);
  expect(rowJoins(11, 0, 0)).toBe(true);
  // The flat hop is on the bar however much its own arc lifts: the arc is what `prog`'s dead zone
  // discounts, and a hop reads as zero there.
  expect(rowJoins(-60, -26, 0)).toBe(true);
  expect(rowJoins(60, -26, ROW_AIR_PROG)).toBe(true);
  // But a rising thumb's own drift is not a hop, low or not: sideways has to LEAD.
  expect(rowJoins(11, -25, 0)).toBe(false);
});

test('a card that has left the bar goes to the grid alone', () => {
  // No neighbours at any height once the card is climbing — the held row and its ceiling were
  // removed 2026-08-17, so `prog` past `ROW_AIR_PROG` is simply the end of the hop's territory.
  expect(rowJoins(60, -120, 0.1)).toBe(false);
  expect(rowJoins(60, -120, 0.5)).toBe(false);
  expect(rowJoins(200, -400, 0.9)).toBe(false);
});

test('nothing about the vertical is judged mid-gesture any more', () => {
  // The whole point of the rewrite: no cone, no flick test, no threshold between a swipe and the
  // switcher (user, 2026-08-13). The card follows the finger up and back down; only the release
  // decides, in `zoomCommits`. This test exists to fail if a mid-gesture gate creeps back in.
  expect(Object.keys(model).filter((k) => /lift/i.test(k))).toEqual([]);
});

test('down dismisses the keyboard, a sagging sideways swipe does not', () => {
  expect(barDismisses(0, 30)).toBe(true);
  expect(barDismisses(-60, 30)).toBe(false);
  expect(barDismisses(0, 15)).toBe(false);
});

/* --- two-finger tap (lives with the touch layer's brain in scroll-model) --- */

test('two fingers, no movement, quick — and nothing else', () => {
  expect(isTwoFingerTap(2, false, TAP_MS - 1)).toBe(true);
  expect(isTwoFingerTap(1, false, 100)).toBe(false);
  expect(isTwoFingerTap(2, true, 100)).toBe(false);
  expect(isTwoFingerTap(2, false, TAP_MS + 1)).toBe(false);
});

test('paste is bracketed while the far end asks for it, bare otherwise', () => {
  // The device case (T13/T8.6): three lines pasted bare ran the first two.
  const block = 'echo one\necho two';
  expect(pasteBytes(block, true)).toBe(`\x1b[200~${block}\x1b[201~`);
  // Mode off: the markers would arrive as literal characters, so the text goes as-is.
  expect(pasteBytes(block, false)).toBe(block);
  expect(pasteBytes('', true)).toBe('\x1b[200~\x1b[201~');
});
