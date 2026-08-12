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
  applyCtrl,
  caretKeys,
  classifyBarSwipe,
  controlByte,
  ctrlTap,
  diffInput,
  navKey,
  pasteBytes,
} from '@/keybar-model';
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
  expect(diffInput('ls -la', 'ls x-la')).toBe('x');
  expect(diffInput('ls -la', 'ls-la')).toBe(DEL); // backspace at the same spot
  expect(diffInput('ls -la', 'x' + 'ls -la')).toBe('x'); // at the very start
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
  expect(diffInput('x😀', '😀')).toBe(DEL);
  expect(diffInput('a😀', 'b😀')).toBe(DEL + 'b');
});

/* --- hold-space: the caret's move, as arrows --- */

test('a caret walked left or right is that many arrows', () => {
  expect(caretKeys(3, false)).toBe('\x1b[C'.repeat(3));
  expect(caretKeys(-2, false)).toBe('\x1b[D'.repeat(2));
  expect(caretKeys(1, true)).toBe('\x1bOC'); // DECCKM: the app asked for SS3
});

test('a caret that did not move sends nothing', () => {
  expect(caretKeys(0, false)).toBe('');
  expect(caretKeys(0, true)).toBe('');
});

/* --- bar swipe classification --- */

test('under the slop nothing fires', () => {
  expect(classifyBarSwipe(5, 5)).toBeNull();
});

test('vertical travel past the fire threshold is a keyboard gesture', () => {
  expect(classifyBarSwipe(0, -30)).toBe('up');
  expect(classifyBarSwipe(0, 30)).toBe('down');
});

test('vertical travel past the slop but under the threshold waits', () => {
  expect(classifyBarSwipe(0, -15)).toBeNull();
  expect(classifyBarSwipe(0, 15)).toBeNull();
});

test('dominant horizontal travel is the window swipe (T11)', () => {
  expect(classifyBarSwipe(40, 5)).toBe('horizontal');
  expect(classifyBarSwipe(-40, 30)).toBe('horizontal');
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
