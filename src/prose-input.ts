/**
 * Prose mode's input path (T7.14/T7.15), kept pure so `bun test` can reach the decisions.
 *
 * The mode lives in xterm's helper textarea, which is the only field the page has: iOS reads a
 * text input's traits and its text around the caret from that element. Two measured facts decide
 * everything here (device, 2026-09-16):
 *
 *   - the traits alone buy nothing. With them flipped on but xterm still answering every key, the
 *     field held the capitals-and-spaces skeleton xterm does not `preventDefault` — 265 logged
 *     values, not one lowercase letter — so the keyboard had no line to correct. Once the field
 *     owns the text, iOS rewrites whole words and the rewrite arrives as a value change.
 *   - a rewrite is not a keystroke. It arrives as `inputType=insertReplacementText` with the whole
 *     replacement in `value`, and it can change text BEFORE the caret (`lets|` → `let’s|`), which
 *     is what `diffInput` counts DELs for.
 *
 * So in prose mode the page routes keys to the browser, owns the field's change stream, and sends
 * what changed. The decisions that can be made without a DOM live here.
 */

/** Bytes that mean backspace to a PTY — the same constant the key bar's diff uses. */
import { DEL } from '@/keybar-model';

/**
 * iOS smart punctuation and autocorrect put a non-breaking space (U+00A0, occasionally U+202F)
 * where the user pressed the spacebar — right in a word processor, wrong in a shell: `ls\u00a0-l`
 * is not `ls -l`, and the command is a different word to the host. Normalized on the way out, so
 * the field keeps whatever the keyboard wrote and the PTY only ever sees a plain space.
 */
export function proseText(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, ' ');
}

/** What the page should do with one keydown while prose mode owns the field. */
export type ProseKey =
  /** xterm's: Esc, Tab, arrows, Home/End, F-keys, a Ctrl/Alt chord, and Return. */
  | 'xterm'
  /** The browser's: it inserts or deletes in the field, and the diff is the sender. */
  | 'browser'
  /** Nothing for the browser to do — the field is already at that edge — so the byte is ours. */
  | 'self';

/**
 * The routing rule. A printable character with no chord modifier is the browser's, so that iOS has
 * a real line to correct; Backspace and Delete are the browser's too (the field must stay in step
 * with what the diff sent), except at the edge, where the browser fires no `input` event at all and
 * a held repeat would otherwise die after the field ran dry — the old native field kept a 512-space
 * pad for exactly that, and a pad is worse here: it sits in front of the caret, and iOS reads the
 * position as mid-sentence and stops capitalising.
 *
 * `caret` is the field's own selection start, `null` when it has none (a textarea always does).
 */
export function proseKey(
  key: string,
  mods: { ctrl: boolean; alt: boolean; meta: boolean },
  value: string,
  caret: number | null,
): ProseKey {
  const at = caret === null ? value.length : caret;
  if (key === 'Backspace') return at > 0 ? 'browser' : 'self';
  if (key === 'Delete') return at < value.length ? 'browser' : 'self';
  if (mods.ctrl || mods.alt || mods.meta) return 'xterm';
  // A dead key and an IME compose arrive as `Dead`/`Process`/`Unidentified`, not one character.
  return [...key].length === 1 ? 'browser' : 'xterm';
}

/** The byte a `self` routing sends: backspace, or forward delete's escape. */
export function proseSelfKey(key: string): string {
  return key === 'Delete' ? '\x1b[3~' : DEL;
}

/**
 * The most cells one polled caret move may become in arrows (see `caretArrows`).
 *
 * iOS parks the caret at a document edge when a hold-space drag engages and again when it ends — a
 * jump of most of the line — and a park is not travel the user made. Bounding each poll keeps a
 * park to a few cells while a real drag, sampled every 60ms, still arrives in steps of one or two.
 */
export const CARET_MOVE_MAX = 8;

/** A caret move the poll saw, as the signed number of arrows to send for it. */
export function caretArrows(moved: number): number {
  return Math.max(-CARET_MOVE_MAX, Math.min(CARET_MOVE_MAX, moved));
}
