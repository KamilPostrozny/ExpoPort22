/**
 * The key bar's brain (§4.4), kept out of the component so `bun test` can reach it. The bar in
 * `src/keybar.tsx` only renders and executes what these functions decide.
 *
 * Up/down arrows are T6's `arrowKey` (src/scroll-model.ts) — reused, not duplicated; this file
 * adds the four keys a scroll never sends (left/right/Home/End) on the same DECCKM rule.
 */

import { arrowKey } from '@/scroll-model';

/* --- the Ctrl state machine --- */

export type CtrlMode = 'off' | 'armed' | 'locked';

/** Two taps closer together than this lock; further apart they arm-then-disarm. */
export const CTRL_DOUBLE_TAP_MS = 300;

/** A tap on the Ctrl key. `sinceLastTapMs` is the time since the previous tap (Infinity for the
 *  first ever), which is what tells a double-tap lock from an arm/disarm toggle. */
export function ctrlTap(mode: CtrlMode, sinceLastTapMs: number): CtrlMode {
  if (mode === 'locked') return 'off';
  if (mode === 'armed') return sinceLastTapMs < CTRL_DOUBLE_TAP_MS ? 'locked' : 'off';
  return 'armed';
}

/** After a chord went out: armed was for one key, locked is until tapped off. */
export function afterChord(mode: CtrlMode): CtrlMode {
  return mode === 'locked' ? 'locked' : 'off';
}

/* --- control bytes --- */

/** `^X = letter & 0x1f`, the terminal's own rule — which also covers `@ [ \ ] ^ _` (Ctrl-[ is
 *  ESC). Anything else is not a chord and returns null. */
export function controlByte(key: string): string | null {
  if (!/^[a-zA-Z@[\\\]^_]$/.test(key)) return null;
  return String.fromCharCode(key.toUpperCase().charCodeAt(0) & 0x1f);
}

/** A typed key arriving while Ctrl is armed or locked. A non-chordable key (Return, delete,
 *  space) passes through and leaves the arm standing for the next actual letter. */
export function applyCtrl(mode: CtrlMode, key: string): { out: string; mode: CtrlMode } {
  if (mode === 'off') return { out: key, mode };
  const byte = key.length === 1 ? controlByte(key) : null;
  if (byte === null) return { out: key, mode };
  return { out: byte, mode: afterChord(mode) };
}

/** The chord strip above the bar: the static five (user decision, PLAN §6), in design order. */
export const CHORD_STRIP: { letter: string; caption: string }[] = [
  { letter: 'C', caption: 'interrupt' },
  { letter: 'Z', caption: 'suspend' },
  { letter: 'R', caption: 'history' },
  { letter: 'L', caption: 'clear' },
  { letter: 'D', caption: 'EOF' },
];

/**
 * Clipboard text on its way into the session. While the far end has bracketed paste on
 * (`CSI ?2004 h` — every modern shell does at its prompt), the text goes inside `ESC[200~ …
 * ESC[201~`: that is how a shell tells a paste from typing, and it is what stops the newlines
 * *inside* the paste from being read as Return presses.
 *
 * Found on device (T13/T8.6): pasting three lines without the markers ran the first two and left
 * the third at the prompt — the "a paste executes commands you never read" hazard that bracketed
 * paste exists to prevent. With the mode off the text is sent bare, because then the markers
 * themselves would be typed as literal characters.
 */
export function pasteBytes(text: string, bracketedPaste: boolean): string {
  return bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text;
}

/* --- arrows cluster --- */

export type NavKey = 'up' | 'down' | 'left' | 'right' | 'home' | 'end';

const NAV_FINAL: Record<NavKey, string> = {
  up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F',
};

/** The escape sequence a nav key sends, DECCKM-aware — `CSI x` normally, `SS3 x` when the app
 *  has switched the cursor keys to application mode. Up/down delegate to T6's `arrowKey` so the
 *  bar and the scroll layer can never drift apart. */
export function navKey(key: NavKey, decckm: boolean): string {
  if (key === 'up' || key === 'down') return arrowKey(key === 'up', decckm);
  return `\x1b${decckm ? 'O' : '['}${NAV_FINAL[key]}`;
}

/* --- the native TextInput's diff --- */

/** What iOS sends for backspace on a PTY. */
export const DEL = '\x7f';

/**
 * The keys between two states of the (uncontrolled) native TextInput: deletes for what left,
 * then whatever was typed. Deletes are counted in code points — one DEL per character the user
 * saw vanish — and both ends back off a split surrogate pair so an emoji is never half kept.
 *
 * Prefix first, then the tail the two still share, because the caret is no longer always at the
 * end: hold-space moves it (see `caretKeys`), and a character typed mid-line must come out as
 * that one character rather than "delete the rest of the line and retype it" — the PTY's cursor
 * was moved to the same place by the arrows, so a prefix-only diff would eat the line from
 * there. Prefix wins ties, so every edit at the end still diffs exactly as it did before.
 */
export function diffInput(prev: string, next: string): string {
  const max = Math.min(prev.length, next.length);
  let common = 0;
  while (common < max && prev[common] === next[common]) common++;
  const code = prev.charCodeAt(common - 1);
  if (common > 0 && code >= 0xd800 && code <= 0xdbff) common--;
  let tail = 0;
  while (tail < max - common && prev[prev.length - 1 - tail] === next[next.length - 1 - tail])
    tail++;
  const low = next.charCodeAt(next.length - tail);
  if (tail > 0 && low >= 0xdc00 && low <= 0xdfff) tail--;
  const deletes = [...prev.slice(common, prev.length - tail)].length;
  return DEL.repeat(deletes) + next.slice(common, next.length - tail);
}

/**
 * §4.2 hold-space: iOS turns the held spacebar into a trackpad that walks the caret through the
 * *field*, which sends no text change at all — so the move arrives as an `onSelectionChange` and
 * this turns it into the arrows the PTY understands. One arrow per field character crossed;
 * `delta` is signed, and zero (an edit's own caret move, see the caller) sends nothing.
 */
export function caretKeys(delta: number, decckm: boolean): string {
  return delta === 0 ? '' : navKey(delta > 0 ? 'right' : 'left', decckm).repeat(Math.abs(delta));
}

/* --- bar swipes --- */

/** Travel before an axis is even chosen (the prototype's 10px). */
export const BAR_AXIS_SLOP = 10;
/** Vertical travel at which the keyboard gesture fires (the prototype's 24px). */
export const BAR_SWIPE_FIRE = 24;

export type BarSwipe = 'up' | 'down' | 'horizontal' | null;

/** Classifies a pan on the bar from its total travel. `horizontal` is handed to T11's window
 *  switching; `up`/`down` drive the keyboard (§4.4). Null means keep watching. */
export function classifyBarSwipe(dx: number, dy: number): BarSwipe {
  if (Math.abs(dx) <= BAR_AXIS_SLOP && Math.abs(dy) <= BAR_AXIS_SLOP) return null;
  if (Math.abs(dx) > Math.abs(dy)) return 'horizontal';
  if (dy <= -BAR_SWIPE_FIRE) return 'up';
  if (dy >= BAR_SWIPE_FIRE) return 'down';
  return null;
}
