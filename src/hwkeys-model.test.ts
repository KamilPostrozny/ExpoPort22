import { expect, test } from 'bun:test';
import { normalizeHwKey, routeHwKey, type HwRouteCtx, type RawHwKey } from './hwkeys-model';

const ios = (over: Partial<RawHwKey>): RawHwKey => ({
  platform: 'ios',
  keyCode: 0,
  character: '',
  baseCharacter: '',
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  ...over,
});

const and = (over: Partial<RawHwKey>): RawHwKey => ({ ...ios(over), platform: 'android' });

const ctx: HwRouteCtx = { decckm: false, tmux: false };
const tmuxCtx: HwRouteCtx = { decckm: false, tmux: true };
const decckmCtx: HwRouteCtx = { decckm: true, tmux: false };

test('iOS special keys normalize by HID usage', () => {
  expect(normalizeHwKey(ios({ keyCode: 0x29 })).key).toBe('escape');
  expect(normalizeHwKey(ios({ keyCode: 0x2b })).key).toBe('tab');
  expect(normalizeHwKey(ios({ keyCode: 0x28 })).key).toBe('enter');
  expect(normalizeHwKey(ios({ keyCode: 0x2a })).key).toBe('backspace');
  expect(normalizeHwKey(ios({ keyCode: 0x2c })).key).toBe('space');
  expect(normalizeHwKey(ios({ keyCode: 0x87 })).key).toBe('delete');
  expect(normalizeHwKey(ios({ keyCode: 0x89 })).key).toBe('home');
  expect(normalizeHwKey(ios({ keyCode: 0x8a })).key).toBe('end');
  expect(normalizeHwKey(ios({ keyCode: 0x8b })).key).toBe('pageup');
  expect(normalizeHwKey(ios({ keyCode: 0x8c })).key).toBe('pagedown');
  expect(normalizeHwKey(ios({ keyCode: 0x55 })).key).toBe('arrowup');
  expect(normalizeHwKey(ios({ keyCode: 0x52 })).key).toBe('arrowleft');
  expect(normalizeHwKey(ios({ keyCode: 0x39 })).key).toBe('f1');
  expect(normalizeHwKey(ios({ keyCode: 0x46 })).key).toBe('f12');
});

test('iOS letters and digits normalize from the produced character', () => {
  expect(normalizeHwKey(ios({ keyCode: 0x04, character: 'A', baseCharacter: 'a' })).key).toBe('a');
  expect(normalizeHwKey(ios({ keyCode: 0x1d, character: 'z' })).key).toBe('z');
  expect(normalizeHwKey(ios({ keyCode: 0x1e, character: '1' })).key).toBe('1');
  // A held modifier can blank the character — the code still names the key.
  expect(normalizeHwKey(ios({ keyCode: 0x1f, character: '', baseCharacter: '' })).key).toBe('2');
  expect(normalizeHwKey(ios({ keyCode: 0x27 })).key).toBe('0');
});

test('Android keys normalize by KEYCODE', () => {
  expect(normalizeHwKey(and({ keyCode: 111 })).key).toBe('escape');
  expect(normalizeHwKey(and({ keyCode: 61 })).key).toBe('tab');
  expect(normalizeHwKey(and({ keyCode: 66 })).key).toBe('enter');
  expect(normalizeHwKey(and({ keyCode: 67 })).key).toBe('backspace');
  expect(normalizeHwKey(and({ keyCode: 62 })).key).toBe('space');
  expect(normalizeHwKey(and({ keyCode: 112 })).key).toBe('delete');
  expect(normalizeHwKey(and({ keyCode: 122 })).key).toBe('home');
  expect(normalizeHwKey(and({ keyCode: 123 })).key).toBe('end');
  expect(normalizeHwKey(and({ keyCode: 92 })).key).toBe('pageup');
  expect(normalizeHwKey(and({ keyCode: 93 })).key).toBe('pagedown');
  expect(normalizeHwKey(and({ keyCode: 19 })).key).toBe('arrowup');
  expect(normalizeHwKey(and({ keyCode: 21 })).key).toBe('arrowright');
  expect(normalizeHwKey(and({ keyCode: 131 })).key).toBe('f1');
  expect(normalizeHwKey(and({ keyCode: 142 })).key).toBe('f12');
  expect(normalizeHwKey(and({ keyCode: 30, character: 'B' })).key).toBe('b');
  expect(normalizeHwKey(and({ keyCode: 7, character: '0' })).key).toBe('0');
  // Under Ctrl the OS may report no unicode — the base character names the key.
  expect(normalizeHwKey(and({ keyCode: 105, baseCharacter: '@', ctrlKey: true })).key).toBe('@');
});

test('plain keys route to the terminal the way xterm sends them', () => {
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x29 })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1b',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x2b })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\t',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x55 })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1b[A',
  });
  expect(routeHwKey(normalizeHwKey(and({ keyCode: 22 })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1b[D',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x89 })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1b[H',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x8a })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1b[F',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x8b })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1bO5~',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x8c })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1bO6~',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x87 })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1b[3~',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x39 })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1bOP',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x46 })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1b[24~',
  });
});

test('arrows and home/end follow DECCKM, as the bar does', () => {
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x55 })), decckmCtx)).toEqual({
    kind: 'bytes',
    bytes: '\x1bOA',
  });
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x89 })), decckmCtx)).toEqual({
    kind: 'bytes',
    bytes: '\x1bOH',
  });
});

test('Ctrl chords send the same control bytes the bar sends', () => {
  expect(
    routeHwKey(
      normalizeHwKey(and({ keyCode: 31, character: 'C', baseCharacter: 'c', ctrlKey: true })),
      ctx,
    ),
  ).toEqual({ kind: 'bytes', bytes: '\x03' });
  expect(
    routeHwKey(
      normalizeHwKey(ios({ keyCode: 0x04, character: 'A', baseCharacter: 'a', ctrlKey: true })),
      ctx,
    ),
  ).toEqual({ kind: 'bytes', bytes: '\x01' });
  expect(
    routeHwKey(normalizeHwKey(and({ keyCode: 105, baseCharacter: '@', ctrlKey: true })), ctx),
  ).toEqual({ kind: 'bytes', bytes: '\x00' });
  expect(routeHwKey(normalizeHwKey(and({ keyCode: 66, ctrlKey: true })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1b\r',
  });
  expect(routeHwKey(normalizeHwKey(and({ keyCode: 19, ctrlKey: true })), ctx)).toEqual({
    kind: 'bytes',
    bytes: '\x1b[1;5A',
  });
});

test('Alt sends an ESC prefix, or the app action when tmux is attached', () => {
  expect(
    routeHwKey(
      normalizeHwKey(and({ keyCode: 30, character: 'B', baseCharacter: 'b', altKey: true })),
      ctx,
    ),
  ).toEqual({ kind: 'bytes', bytes: '\x1bb' });
  expect(
    routeHwKey(normalizeHwKey(and({ keyCode: 8, baseCharacter: '1', altKey: true })), ctx),
  ).toEqual({ kind: 'bytes', bytes: '\x1b1' });
  // With tmux the same keys are the window keys.
  expect(
    routeHwKey(normalizeHwKey(and({ keyCode: 8, baseCharacter: '1', altKey: true })), tmuxCtx),
  ).toEqual({ kind: 'window-select', number: 1 });
  expect(
    routeHwKey(normalizeHwKey(and({ keyCode: 7, baseCharacter: '0', altKey: true })), tmuxCtx),
  ).toEqual({ kind: 'window-select', number: 10 });
  expect(
    routeHwKey(normalizeHwKey(and({ keyCode: 48, baseCharacter: 't', altKey: true })), tmuxCtx),
  ).toEqual({ kind: 'switcher' });
  expect(
    routeHwKey(normalizeHwKey(and({ keyCode: 42, baseCharacter: 'n', altKey: true })), tmuxCtx),
  ).toEqual({ kind: 'window-new' });
  // A held key does not re-fire the action.
  expect(
    routeHwKey(
      normalizeHwKey(and({ keyCode: 48, baseCharacter: 't', altKey: true, repeat: true })),
      tmuxCtx,
    ),
  ).toEqual({ kind: 'ignore' });
});

test('meta+v is the paste, whatever the tmux', () => {
  expect(
    routeHwKey(normalizeHwKey(ios({ keyCode: 0x19, baseCharacter: 'v', metaKey: true })), ctx),
  ).toEqual({ kind: 'paste' });
  expect(
    routeHwKey(
      normalizeHwKey(ios({ keyCode: 0x19, baseCharacter: 'v', metaKey: true, repeat: true })),
      ctx,
    ),
  ).toEqual({ kind: 'ignore' });
});

test('unmapped keys are ignored rather than typed', () => {
  expect(routeHwKey(normalizeHwKey(ios({ keyCode: 0x8d })), ctx)).toEqual({ kind: 'ignore' });
  expect(routeHwKey(normalizeHwKey(and({ keyCode: 133, ctrlKey: true })), ctx)).toEqual({
    kind: 'ignore',
  });
});
