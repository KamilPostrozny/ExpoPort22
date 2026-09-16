/**
 * Raw-mode hold-delete (2026-09-18), kept pure so `bun test` can reach the decisions.
 *
 * Measured on device (user report, 2026-09-18, outside prose mode): a HELD software-keyboard
 * Backspace reaches the page as ONE keydown — the repeats never arrive, so the page's first DEL
 * is the only character that ever dies. The prose mode never saw this because its backspaces go
 * through the browser's own field editing, which repeats natively. So in raw mode the PAGE owns
 * the hold: one byte per keydown, and if the key is still down when the hold delay expires an
 * app-side repeat loop takes over until the keyup, a blur, a mode flip, another key, or the cap.
 *
 * The cap is a runaway guard, not a tuning value: it bounds how long a deletion can continue if
 * the release ever fails to be observed (a keyup WebKit withholds). A 10-second deletion by
 * deliberate holding is implausible at the repeat rate below; a runaway loop is not.
 */

import { DEL } from '@/keybar-model';

export type RawHoldKey = 'Backspace' | 'Delete';

/** Before the repeat loop starts after the first keydown. A completed tap ends long before this;
 *  it is the tap-vs-hold divider, not a debounce. */
export const RAW_HOLD_DELAY_MS = 300;

/** One byte per beat while held: 25/s, roughly the pace a held hardware key repeats at. */
export const RAW_HOLD_REPEAT_MS = 40;

/** A held deletion may not outlive this, however firmly it is held (see the cap note above). */
export const RAW_HOLD_CAP_MS = 6000;

export type RawHoldState = {
  /** The key currently held, if any — a different key's press ends the hold. */
  key: RawHoldKey | null;
  /** When the current hold began, so the delay and the cap are measured from the same start. */
  since: number;
  /** The repeat loop is running: keyup has not been seen and the delay has elapsed. */
  looping: boolean;
};

export function rawHoldInit(): RawHoldState {
  return { key: null, since: 0, looping: false };
}

/** The byte the hold sends for its key — the same two bytes the prose `self` routing sends
 *  (`proseSelfKey`), so a delete is a delete in either mode. */
export function rawHoldByte(key: RawHoldKey): string {
  return key === 'Delete' ? '\x1b[3~' : DEL;
}

/** One keydown of `key` at `now`. Every press sends exactly one byte; a FRESH press arms the
 *  hold delay (a repeat of the already-held key does not restart it — the cap must measure the
 *  whole hold, not the gap between the last two repeats). */
export function rawHoldPress(
  state: RawHoldState,
  key: RawHoldKey,
  now: number,
): { state: RawHoldState; send: boolean; arm: boolean } {
  if (state.key === key) return { state, send: true, arm: false };
  return { state: { key, since: now, looping: false }, send: true, arm: true };
}

/** The hold ended (keyup, blur, mode flip, another key, teardown): nothing is left to stop. */
export function rawHoldRelease(state: RawHoldState): RawHoldState {
  return { key: null, since: 0, looping: false };
}

/** Whether the hold delay has fired into a loop: the SAME key, still un-released, past the delay.
 *  The timer asks with the state it finds when it wakes — a release in the meantime disarms it. */
export function rawHoldReady(state: RawHoldState, key: RawHoldKey, now: number): boolean {
  return state.key === key && !state.looping && now - state.since >= RAW_HOLD_DELAY_MS;
}

/** One beat of the repeat loop at `now`: send while held, stop at the cap. */
export function rawHoldBeat(state: RawHoldState, now: number): { send: boolean; stop: boolean } {
  if (state.key === null || !state.looping) return { send: false, stop: false };
  if (now - state.since >= RAW_HOLD_CAP_MS) return { send: false, stop: true };
  return { send: true, stop: false };
}
