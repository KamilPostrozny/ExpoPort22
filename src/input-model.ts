/**
 * T12's input polish, kept pure so `bun test` can reach it: the dictation leading-space filter
 * (§4.2) and the Settings sheet's swipe-dismiss decision (§4.8).
 *
 * The dictation problem: iOS prepends a space to dictated text so it joins the previous word —
 * right for prose, wrong at a shell prompt, where ` ls` is not `ls`. The filter drops that space
 * only when the *line* is empty, and only for a multi-character insert: a real spacebar press is a
 * single-character insert and always goes through.
 *
 * Line emptiness is a heuristic, tracked from what the bar itself sends (the host's own editing —
 * tab completion's output, vim — is invisible from here, and perfect tracking would need a PTY
 * echo parser nobody asked for). It is right at the moment that matters: a fresh prompt, or just
 * after Return, which is exactly where dictation starts a command.
 */

import { DEL } from '@/keybar-model';

/** Bytes that are known to empty the line: Return, ^C (interrupt redraws a prompt), ^U (kill-line). */
const LINE_CLEARERS = new Set(['\r', '\n', '\x03', '\x15']);

/**
 * The tracked line length after `sent` went to the PTY. Printables count up, DEL counts down,
 * clearers reset; every other control byte is ignored — its effect on the line is unknowable here,
 * and guessing wrong would only move the heuristic's ceiling, not remove it.
 */
export function trackLine(len: number, sent: string): number {
  for (const ch of sent) {
    if (LINE_CLEARERS.has(ch)) len = 0;
    else if (ch === DEL) len = Math.max(0, len - 1);
    else if (ch >= ' ') len += 1;
  }
  return len;
}

/**
 * The filter, applied to one `diffInput` result before its keys are emitted. Strips the leading
 * space iff the line is empty AND the insert is more than the space itself — a lone ' ' is the
 * spacebar and always passes. A diff that starts with deletes is not an insert at a fresh prompt.
 * Known ceiling: a dictation chunk that arrives as a lone space (iOS usually inserts whole
 * hypotheses) passes as a spacebar — one stray space at a prompt, harmless.
 */
export function filterDictation(lineLen: number, diff: string): string {
  if (lineLen === 0 && diff.length > 1 && diff[0] === ' ') return diff.slice(1);
  return diff;
}

/* --- the Settings sheet's release decision (§4.8) --- */

/** Dragged this far down, the sheet is let go of. About a third of its height. */
export const SHEET_DISMISS_DISTANCE = 140;
/** Or flicked faster than this (px/s, RNGH's unit), whatever the distance. */
export const SHEET_DISMISS_VELOCITY = 500;

export function sheetShouldDismiss(dy: number, velocityY: number): boolean {
  if (dy <= 0) return false; // an upward release never dismisses, however fast
  return dy > SHEET_DISMISS_DISTANCE || velocityY > SHEET_DISMISS_VELOCITY;
}
