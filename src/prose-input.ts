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

/** A collapsed DOM caret uses UTF-16 offsets; terminal arrows count characters, like the diff. */
const clamp = (at: number, length: number) => Math.max(0, Math.min(at, length));

/** The walk's memory between samples. */
export type ProseState = {
  /** Where this side believes the field's caret is — the anchor an edit also uses. */
  caret: number;
  /** The caret the current gesture started from, or -1 between gestures. */
  burst: number;
  /** The last accepted step, signed, so a reversal can be told from travel. */
  last: number;
};

/** A fresh walk: no gesture, no travel, caret at the start of the line. */
export function proseStart(): ProseState {
  return { caret: 0, burst: -1, last: 0 };
}

/** What one caret sample means for the walk. */
export type ProseWalk =
  /** The caret did not move (or a range is up, which is a selection, not a walk). */
  | { action: 'none'; state: ProseState }
  /** The finger moved the caret: send this many arrows. */
  | { action: 'send'; arrows: number; state: ProseState }
  /** iOS restored the caret to where the gesture began: drop it, and the burst ends with it. */
  | { action: 'park'; state: ProseState };

/**
 * A restoring jump has to be at least this long to be one. A reversing drag of one or two cells is a
 * finger turning round, not iOS pinning the caret back.
 */
export const CARET_PARK_MIN = 3;

/**
 * The walk's decision, pure so a test can drive the whole drag shape. `to` is the caret the sample
 * just read.
 *
 * The park is the whole reason this is not one subtraction. When the spacebar trackpad ends, iOS
 * puts the field's caret back where the gesture began, and that restore arrives as ordinary caret
 * movement. Measured on the phone, 2026-09-16: a finger dragged to column 0 of a 13-character field
 * and the release arrived as `+13`, straight to the end — which the PTY drew as the cursor jumping to
 * the end of the line. Three things together identify it, and each is needed:
 *
 *   - it LANDS ON the burst's origin — the caret after the last edit, which is where the gesture
 *     began. The first sample of a burst cannot qualify: the caret has just left that position.
 *   - it REVERSES the travel. A finger dragging back to the end of the line arrives in small steps
 *     the same way round, and must not be mistaken for the restore — that is why this file does not
 *     settle for the landing alone, which would drop the last step of every drag back to the end.
 *   - it is LONG. A one-cell turn-round is a finger, not iOS.
 *
 * Dropping one ends the burst, so the very next sample opens a new one: a flick that is caught by
 * mistake costs a single 60ms sample and corrects itself.
 */
export function proseWalk(text: string, state: ProseState, to: number): ProseWalk {
  const from = clamp(state.caret, text.length);
  const at = clamp(to, text.length);
  if (from === at) return { action: 'none', state };
  const step = at - from;
  const origin = state.burst < 0 ? from : state.burst;
  // Arrows are characters, not UTF-16 units: one arrow steps a whole emoji, as the PTY expects.
  const arrows = [...text.slice(Math.min(from, at), Math.max(from, at))].length;
  const reverses = state.last !== 0 && Math.sign(step) !== Math.sign(state.last);
  if (at === origin && reverses && arrows >= CARET_PARK_MIN) {
    return { action: 'park', state: { caret: state.caret, burst: -1, last: 0 } };
  }
  return {
    action: 'send',
    arrows: Math.sign(step) * arrows,
    state: { caret: at, burst: origin, last: step },
  };
}
