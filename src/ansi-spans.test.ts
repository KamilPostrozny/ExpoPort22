/** `bun test` — the ANSI→spans parser T10's snapshot cards render with. SGR subset, palette
 *  slots kept symbolic, everything else skipped without damage. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import { parseAnsi, spanColor, xterm256 } from '@/ansi-spans';

test('plain text is one default span per line', () => {
  expect(parseAnsi('hello\nworld')).toEqual([
    [{ text: 'hello', fg: null, bg: null, bold: false }],
    [{ text: 'world', fg: null, bg: null, bold: false }],
  ]);
});

test('16-colour SGR: normal, bright, background, and reset', () => {
  const [line] = parseAnsi('\x1b[31mred\x1b[0mplain');
  expect(line).toEqual([
    { text: 'red', fg: 1, bg: null, bold: false },
    { text: 'plain', fg: null, bg: null, bold: false },
  ]);
  expect(parseAnsi('\x1b[92mok')[0][0]).toMatchObject({ fg: 10 });
  expect(parseAnsi('\x1b[44mblue bg')[0][0]).toMatchObject({ bg: 4 });
  expect(parseAnsi('\x1b[103mbright bg')[0][0]).toMatchObject({ bg: 11 });
});

test('chained params apply in order: 1;31 is bold red, 39/49/22 undo selectively', () => {
  expect(parseAnsi('\x1b[1;31mx')[0][0]).toMatchObject({ fg: 1, bold: true });
  expect(parseAnsi('\x1b[1;31;39mx')[0][0]).toMatchObject({ fg: null, bold: true });
  expect(parseAnsi('\x1b[1;22mx')[0][0]).toMatchObject({ bold: false });
  expect(parseAnsi('\x1b[41;49mx')[0][0]).toMatchObject({ bg: null });
});

test('empty param means 0: CSI m alone resets', () => {
  expect(parseAnsi('\x1b[31ma\x1b[mb')[0][1]).toMatchObject({ fg: null });
});

test('256-colour and truecolor, fg and bg, with params after the extension still applying', () => {
  expect(parseAnsi('\x1b[38;5;196mx')[0][0]).toMatchObject({ fg: 196 });
  expect(parseAnsi('\x1b[48;5;238mx')[0][0]).toMatchObject({ bg: 238 });
  expect(parseAnsi('\x1b[38;2;30;30;46mx')[0][0]).toMatchObject({ fg: '#1e1e2e' });
  expect(parseAnsi('\x1b[48;2;255;0;10mx')[0][0]).toMatchObject({ bg: '#ff000a' });
  expect(parseAnsi('\x1b[38;5;196;1mx')[0][0]).toMatchObject({ fg: 196, bold: true });
});

test('unknown SGR codes and non-SGR sequences are skipped clean', () => {
  // italic (3), underline (4), reverse (7): ignored, text kept
  expect(parseAnsi('\x1b[3;4;7mx')[0][0]).toMatchObject({ text: 'x', fg: null, bold: false });
  // cursor-hide (CSI ?25l), cursor moves, OSC titles: no style change, no leaked bytes
  expect(parseAnsi('\x1b[?25la\x1b[2Jb\x1b]0;title\x07c')).toEqual([
    [{ text: 'abc', fg: null, bg: null, bold: false }],
  ]);
  // OSC terminated by ST (ESC \) instead of BEL
  expect(parseAnsi('\x1b]8;;http://x\x1b\\link')[0][0].text).toBe('link');
});

test('malformed input never throws and never leaks escape bytes', () => {
  expect(parseAnsi('\x1b')).toEqual([[]]); // lone ESC at end
  expect(parseAnsi('a\x1b[31')[0][0].text).toBe('a'); // truncated CSI dropped
  expect(parseAnsi('\x1b[38;5mx')[0][0]).toMatchObject({ text: 'x', fg: null }); // broken extension
  expect(parseAnsi('\x1b[;;;mx')[0][0].text).toBe('x');
  expect(parseAnsi('\x1b[38;2;300;0;0mx')[0][0]).toMatchObject({ fg: null }); // out-of-range RGB refused
  expect(parseAnsi('a\x1b7b')[0][0].text).toBe('ab'); // two-char escape skipped
});

test('carriage returns are dropped, adjacent same-style runs coalesce', () => {
  expect(parseAnsi('a\r\nb')).toEqual([
    [{ text: 'a', fg: null, bg: null, bold: false }],
    [{ text: 'b', fg: null, bg: null, bold: false }],
  ]);
  // same style across an ignored sequence: one span, not two
  expect(parseAnsi('a\x1b[2Jb')[0]).toHaveLength(1);
});

test('xterm256: the computed cube and gray ramp hit the documented values', () => {
  expect(xterm256(16)).toBe('#000000');
  expect(xterm256(196)).toBe('#ff0000'); // 5,0,0 in the cube
  expect(xterm256(231)).toBe('#ffffff');
  expect(xterm256(232)).toBe('#080808'); // gray ramp start
  expect(xterm256(255)).toBe('#eeeeee'); // gray ramp end
  expect(xterm256(59)).toBe('#5f5f5f'); // 1,1,1 → 95
});

test('spanColor: theme slots for 0–15, computed palette above, passthrough, default', () => {
  const ansi = Array.from({ length: 16 }, (_, i) => `#slot${i}`);
  expect(spanColor(1, ansi)).toBe('#slot1');
  expect(spanColor(15, ansi)).toBe('#slot15');
  expect(spanColor(196, ansi)).toBe('#ff0000');
  expect(spanColor('#123456', ansi)).toBe('#123456');
  expect(spanColor(null, ansi)).toBeNull();
});
