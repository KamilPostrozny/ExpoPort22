import { controlByte, navKey } from './keybar-model';

/*
 * Physical-keyboard routing.
 *
 * `modules/expo-hwkeys` stands in front of each OS's own key pipeline (iOS's
 * `-[UIApplication handleKeyUIEvent:]`, the Android window's key dispatch) and forwards only
 * the keys the 1×1 field does nothing useful with — see the module for the pass-through rule:
 * plain printables, Enter, Backspace and Space reach the field as usual, everything else arrives
 * here as a raw platform event. This file is where a raw event becomes a key and a key becomes a
 * decision: PTY bytes (the same bytes the key bar would have sent) or an app action.
 */

/** The raw event the native module emits — one shape for both platforms, decided there. */
export type RawHwKey = {
  platform: 'ios' | 'android';
  /** iOS `UIKeyboardHidUsage` raw value, Android `KeyEvent.KEYCODE_*`. */
  keyCode: number;
  /** The typed character as the OS produced it (shift applied); `''` when it produces none. */
  character: string;
  /** The character with no modifiers at all — what an Alt chord's `ESC` prefix must be followed by. */
  baseCharacter: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Key auto-repeat (Android only; iOS does not report it). */
  repeat: boolean;
};

export type HwKeyEvent = {
  /** Normalized key: `escape`, `tab`, `arrowup` …, or the lowercase typed character. */
  key: string;
  baseCharacter: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
};

/* iOS `UIKeyboardHidUsage` raw values — the HID usage IDs, which the enum copies 1:1. Only the
 * keys the module ever intercepts need naming; letters and digits come from the character. */
const IOS_HID: Record<number, string> = {
  0x28: 'enter',
  0x29: 'escape',
  0x2a: 'backspace',
  0x2b: 'tab',
  0x2c: 'space',
  0x39: 'f1',
  0x3a: 'f2',
  0x3b: 'f3',
  0x3c: 'f4',
  0x3d: 'f5',
  0x3e: 'f6',
  0x3f: 'f7',
  0x40: 'f8',
  0x41: 'f9',
  0x42: 'f10',
  0x45: 'f11',
  0x46: 'f12',
  0x87: 'delete',
  0x89: 'home',
  0x8a: 'end',
  0x8b: 'pageup',
  0x8c: 'pagedown',
  0x8d: 'insert',
  0x52: 'arrowleft',
  0x53: 'arrowright',
  0x54: 'arrowdown',
  0x55: 'arrowup',
};

/* Android `KeyEvent.KEYCODE_*` values for the same set. The Kotlin side uses the named constants;
 * this table must stay in lockstep with them. */
const ANDROID_KEY: Record<number, string> = {
  61: 'tab',
  62: 'space',
  66: 'enter',
  67: 'backspace',
  111: 'escape',
  112: 'delete',
  122: 'home',
  123: 'end',
  92: 'pageup',
  93: 'pagedown',
  19: 'arrowup',
  20: 'arrowdown',
  21: 'arrowright',
  22: 'arrowleft',
  131: 'f1',
  132: 'f2',
  133: 'f3',
  134: 'f4',
  135: 'f5',
  136: 'f6',
  137: 'f7',
  138: 'f8',
  139: 'f9',
  140: 'f10',
  141: 'f11',
  142: 'f12',
};

/** Letters and digits, keyed by platform code, so a key that produces no character (a held
 *  modifier blanking it) still normalizes to what it is. */
const IOS_LETTERS: Record<number, string> = {};
for (let i = 0; i < 26; i += 1) IOS_LETTERS[0x04 + i] = String.fromCharCode(0x61 + i);
const IOS_DIGITS: Record<number, string> = {};
for (let i = 1; i <= 9; i += 1) IOS_DIGITS[0x1e + i - 1] = String(i);
IOS_DIGITS[0x27] = '0';

const ANDROID_LETTERS: Record<number, string> = {};
for (let i = 0; i < 26; i += 1) ANDROID_LETTERS[29 + i] = String.fromCharCode(97 + i);
const ANDROID_DIGITS: Record<number, string> = {};
for (let i = 1; i <= 9; i += 1) ANDROID_DIGITS[7 + i] = String(i);
ANDROID_DIGITS[7] = '0';

export function normalizeHwKey(raw: RawHwKey): HwKeyEvent {
  const table =
    raw.platform === 'ios'
      ? { special: IOS_HID, letters: IOS_LETTERS, digits: IOS_DIGITS }
      : { special: ANDROID_KEY, letters: ANDROID_LETTERS, digits: ANDROID_DIGITS };
  const special = table.special[raw.keyCode] ?? '';
  let key =
    special !== '' ? special : (table.letters[raw.keyCode] ?? table.digits[raw.keyCode] ?? '');
  if (key === '') key = raw.baseCharacter.toLowerCase() || raw.character.toLowerCase();
  if (key === '') key = `code-${raw.keyCode}`;
  return {
    key,
    baseCharacter: raw.baseCharacter !== '' ? raw.baseCharacter : raw.character,
    shiftKey: raw.shiftKey,
    ctrlKey: raw.ctrlKey,
    altKey: raw.altKey,
    metaKey: raw.metaKey,
    repeat: raw.repeat,
  };
}

export type HwRouteCtx = {
  /** DECCKM — application cursor keys: arrows and home/end go `SS3`, not `CSI`. */
  decckm: boolean;
  /** A tmux session is attached — the window and switcher shortcuts have something to act on. */
  tmux: boolean;
};

export type HwRoute =
  | { kind: 'bytes'; bytes: string }
  | { kind: 'window-select'; number: number }
  | { kind: 'window-new' }
  | { kind: 'switcher' }
  | { kind: 'paste' }
  | { kind: 'ignore' };

const ESC = '\x1b';

const FKEYS: Record<string, string> = {
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
};

/* What xterm sends for a Ctrl'd navigation key — `CSI 1;5` and the nav final. */
const CTRL_NAV: Record<string, string> = {
  arrowup: '\x1b[1;5A',
  arrowdown: '\x1b[1;5B',
  arrowright: '\x1b[1;5C',
  arrowleft: '\x1b[1;5D',
  home: '\x1b[1;5H',
  end: '\x1b[1;5F',
};

/**
 * What an intercepted key becomes.
 *
 * The app actions are checked first and only when there is something to act on (a tmux session
 * for the window keys — without one, `Alt+1` falls through to its terminal meaning, `ESC 1`);
 * a repeat never re-fires an app action. Everything else is routed to the same bytes the key bar
 * sends for its own keys: chords through `controlByte`, navigation through `navKey` (DECCKM
 * aware, so the bar and the keyboard cannot drift apart).
 */
export function routeHwKey(ev: HwKeyEvent, ctx: HwRouteCtx): HwRoute {
  const { key } = ev;

  if (!ev.repeat && ev.metaKey && key === 'v') return { kind: 'paste' };

  if (ev.altKey && ctx.tmux) {
    const shortcut = (key >= '1' && key <= '9') || key === '0' || key === 't' || key === 'n';
    if (shortcut) {
      // A held shortcut does not re-fire the action — a held Alt+T must not open the switcher a
      // second time, and must not type into the terminal under it.
      if (ev.repeat) return { kind: 'ignore' };
      if (key >= '1' && key <= '9') return { kind: 'window-select', number: Number(key) };
      if (key === '0') return { kind: 'window-select', number: 10 };
      if (key === 't') return { kind: 'switcher' };
      return { kind: 'window-new' };
    }
  }

  if (ev.ctrlKey) {
    if (key === 'enter') return { kind: 'bytes', bytes: ESC + '\r' };
    const nav = CTRL_NAV[key];
    if (nav !== undefined) return { kind: 'bytes', bytes: nav };
    const byte = controlByte(ev.baseCharacter !== '' ? ev.baseCharacter : key);
    if (byte !== null) return { kind: 'bytes', bytes: byte };
    return { kind: 'ignore' };
  }

  if (ev.altKey) {
    if (key === 'enter') return { kind: 'bytes', bytes: ESC + '\r' };
    if (ev.baseCharacter !== '') return { kind: 'bytes', bytes: ESC + ev.baseCharacter };
    return { kind: 'ignore' };
  }

  const nav = navKeyTo(key, ctx.decckm);
  if (nav !== null) return { kind: 'bytes', bytes: nav };
  if (key === 'pageup') return { kind: 'bytes', bytes: '\x1bO5~' };
  if (key === 'pagedown') return { kind: 'bytes', bytes: '\x1bO6~' };
  if (key === 'delete') return { kind: 'bytes', bytes: '\x1b[3~' };
  if (key === 'escape') return { kind: 'bytes', bytes: ESC };
  if (key === 'tab') return { kind: 'bytes', bytes: '\t' };
  if (key === 'backspace') return { kind: 'bytes', bytes: '\x7f' }; // normally pass-through; belt
  const f = FKEYS[key];
  if (f !== undefined) return { kind: 'bytes', bytes: f };
  return { kind: 'ignore' };
}

/** `navKey` narrowed to the keys it takes — the hardware keys named a little differently. */
const NAV_NAMES: Record<string, 'up' | 'down' | 'left' | 'right' | 'home' | 'end'> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  home: 'home',
  end: 'end',
};

function navKeyTo(key: string, decckm: boolean): string | null {
  const name = NAV_NAMES[key];
  return name === undefined ? null : navKey(name, decckm);
}
