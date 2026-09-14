/** `bun test` — the scroll gesture's decisions (§4.3), all pure: routing, notch accumulation,
 *  DECCKM arrow bytes, and the momentum decay. The DOM component only executes what these say. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  COAST_MAX_VELOCITY,
  COAST_TAU_MS,
  FLICK_MIN_VELOCITY,
  VelocityTracker,
  arrowKey,
  coastDistance,
  coastVelocity,
  compoundVelocity,
  modesEqual,
  scrollRoute,
  selectionSpan,
  takeNotches,
  wordBounds,
  type ModeSignal,
} from '@/scroll-model';

const modes = (m: Partial<ModeSignal> = {}): ModeSignal => ({
  altScreen: false,
  mouseReporting: false,
  decckm: false,
  bracketedPaste: false,
  ...m,
});

test('routing: mouse reporting wins, then alt screen, then local scrollback', () => {
  expect(scrollRoute(modes({ mouseReporting: true }))).toBe('wheel');
  // Mouse beats alt screen: htop has both on, and wants wheel reports, not arrows.
  expect(scrollRoute(modes({ mouseReporting: true, altScreen: true }))).toBe('wheel');
  expect(scrollRoute(modes({ altScreen: true }))).toBe('arrows');
  expect(scrollRoute(modes())).toBe('local');
});

test('arrow bytes follow DECCKM: CSI when off, SS3 when on', () => {
  expect(arrowKey(true, false)).toBe('\x1b[A'); // less
  expect(arrowKey(false, false)).toBe('\x1b[B');
  expect(arrowKey(true, true)).toBe('\x1bOA'); // vim sets DECCKM
  expect(arrowKey(false, true)).toBe('\x1bOB');
});

test('notches: one per cell height, remainder carried across calls', () => {
  const cell = 20;
  let { notches, carry } = takeNotches(0, 15, cell);
  expect(notches).toBe(0); // under a cell: nothing yet
  expect(carry).toBe(15);
  ({ notches, carry } = takeNotches(carry, 15, cell));
  expect(notches).toBe(1); // 30px = one notch + 10 carried
  expect(carry).toBe(10);
  ({ notches, carry } = takeNotches(carry, 55, cell));
  expect(notches).toBe(3); // 65px = three notches + 5
  expect(carry).toBe(5);
});

test('notches: direction reverses cleanly and a dead cell height yields nothing', () => {
  expect(takeNotches(0, -45, 20)).toEqual({ notches: -2, carry: -5 });
  // A reversal mid-pan spends the carry against the new direction first.
  expect(takeNotches(15, -20, 20)).toEqual({ notches: 0, carry: -5 });
  expect(takeNotches(0, 100, 0)).toEqual({ notches: 0, carry: 0 });
});

test('momentum decay is frame-rate independent: 60Hz and 120Hz land on the same offsets', () => {
  const v0 = 2; // px/ms — a solid flick
  const spendAt = (hz: number, ms: number) => {
    // What the rAF loop does: per frame, the analytic offset minus what was already spent.
    let spent = 0;
    const step = 1000 / hz;
    for (let i = 1; i * step <= ms; i++) {
      spent += coastDistance(v0, i * step) - spent;
    }
    return spent;
  };
  const at60 = spendAt(60, 600);
  const at120 = spendAt(120, 600);
  expect(Math.abs(at60 - at120)).toBeLessThan(1e-6);
  // And both are the analytic value, not a per-frame-constant approximation of it.
  expect(Math.abs(at60 - coastDistance(v0, 600))).toBeLessThan(1e-6);
});

test('momentum decay is exponential: velocity halves every tau·ln2, distance approaches v0·tau', () => {
  const v0 = 1.5;
  const halfLife = COAST_TAU_MS * Math.LN2;
  expect(coastVelocity(v0, halfLife)).toBeCloseTo(v0 / 2, 6);
  expect(coastVelocity(v0, 2 * halfLife)).toBeCloseTo(v0 / 4, 6);
  expect(coastDistance(v0, 60_000)).toBeCloseTo(v0 * COAST_TAU_MS, 3);
  expect(coastDistance(v0, 60_000)).toBeLessThanOrEqual(v0 * COAST_TAU_MS);
});

test('velocity tracker averages the recent window and forgets the stale past', () => {
  const tracker = new VelocityTracker();
  expect(tracker.velocity()).toBe(0); // no samples, no flick
  tracker.add(0, 0);
  expect(tracker.velocity()).toBe(0); // one sample is a position, not a velocity
  tracker.add(16, 32);
  tracker.add(32, 64);
  expect(tracker.velocity()).toBeCloseTo(2, 6); // steady 2 px/ms
  // A pause then a new flick: samples older than the window must not dilute it.
  tracker.add(1000, 64);
  tracker.add(1016, 96);
  expect(tracker.velocity()).toBeCloseTo(2, 6);
});

test('mode signals compare by value', () => {
  expect(modesEqual(modes(), modes())).toBe(true);
  expect(modesEqual(modes(), modes({ decckm: true }))).toBe(false);
  expect(modesEqual(modes({ altScreen: true }), modes({ mouseReporting: true }))).toBe(false);
});

test('compounding: same-direction flicks stack, reversals and stops do not', () => {
  // The iOS behaviour this exists for: flick again the same way and the coast gets faster.
  expect(compoundVelocity(2, 3)).toBe(5);
  expect(compoundVelocity(-2, -3)).toBe(-5);

  // A reversal takes the finger's own speed and nothing else — adding the leftover would subtract
  // from what was just asked for.
  expect(compoundVelocity(2, -3)).toBe(2);
  expect(compoundVelocity(-2, 3)).toBe(-2);

  // Nothing caught: an ordinary flick is unchanged.
  expect(compoundVelocity(2, 0)).toBe(2);

  // A release too slow to be a flick is a stop, *however* fast the caught coast was. Without the
  // threshold reading the finger's own speed, this relaunches at ~10px/ms — grabbing a runaway
  // scroll and setting it down would fling it again.
  const crawl = FLICK_MIN_VELOCITY / 2;
  expect(compoundVelocity(crawl, 10)).toBe(0);
  expect(compoundVelocity(-crawl, -10)).toBe(0);

  // Stacking is clamped: repeated catches must not walk the coast up to a seek.
  expect(compoundVelocity(COAST_MAX_VELOCITY, COAST_MAX_VELOCITY)).toBe(COAST_MAX_VELOCITY);
  expect(compoundVelocity(-COAST_MAX_VELOCITY, -COAST_MAX_VELOCITY)).toBe(-COAST_MAX_VELOCITY);
});

/* --- the owned selection (T6.7 rework, 2026-09-12) --- */

test('word bounds: xterm semantics — word chars run, spaces run, separators are one cell', () => {
  // `-`, `.`, `_`, `/`, `:` are word (not in xterm's default wordSeparator): paths and versions
  // select as one word, which is the case a path-fiddling user has.
  expect(wordBounds('foo/bar-baz.txt', 3)).toEqual({ start: 0, len: 15 });
  expect(wordBounds('the quick brown fox', 1)).toEqual({ start: 0, len: 3 });
  // Punctuation from the separator set is its own single-cell word, like xterm's mouse path.
  expect(wordBounds('(123)', 0)).toEqual({ start: 0, len: 1 });
  expect(wordBounds('(123)', 1)).toEqual({ start: 1, len: 3 });
  expect(wordBounds('(123)', 4)).toEqual({ start: 4, len: 1 });
  // A run of spaces is the word — double-clicking between columns selects the gap, as it does
  // on desktop xterm.
  expect(wordBounds('ab   cd', 2)).toEqual({ start: 2, len: 3 });
  // Edges: the first and last cell of the line, and a cell past the end (a padded cell).
  expect(wordBounds('abc', 0)).toEqual({ start: 0, len: 3 });
  expect(wordBounds('abc', 2)).toEqual({ start: 0, len: 3 });
  expect(wordBounds('abc', 7)).toEqual({ start: 7, len: 1 });
  // Empty line: every cell is its own one-cell word.
  expect(wordBounds('', 0)).toEqual({ start: 0, len: 1 });
});

test('word bounds: the cell-aligned line — width-2 cells ride as NUL and stay in the word', () => {
  // The touch layer builds the line one cell per entry: a width-2 character in its lead cell,
  // \u0000 in the cell it swallows (never a separator, so the pair and its neighbours form one
  // word — xterm's own mouse selection includes the wide cell in the run). A CJK run selects
  // whole, and ASCII after the wide char is NOT shifted: col 7 is `x`, the cell after the pair.
  const line = 'ab \u4f60\u0000\u597d\u0000 xy'; // a b ␣ 你 好 ␣ x y  (ten cells)
  expect(wordBounds(line, 3)).toEqual({ start: 3, len: 4 }); // 你好
  expect(wordBounds(line, 0)).toEqual({ start: 0, len: 2 }); // ab
  expect(wordBounds(line, 8)).toEqual({ start: 8, len: 2 }); // xy — x is cell 8, NOT shifted
  expect(wordBounds(line, 4)).toEqual({ start: 3, len: 4 }); // inside the pair: same word
});

test('selection span: linear in cells, order-agnostic, unpacks the way the model does', () => {
  // Same line, both directions — the smaller (col) always comes back first.
  expect(selectionSpan(10, { col: 2, row: 0 }, { col: 5, row: 0 })).toEqual({
    col: 2,
    row: 0,
    len: 4,
  });
  expect(selectionSpan(10, { col: 5, row: 0 }, { col: 2, row: 0 })).toEqual({
    col: 2,
    row: 0,
    len: 4,
  });
  // One cell: the long-press's minimum, and a drag that never left its word's start.
  expect(selectionSpan(10, { col: 3, row: 2 }, { col: 3, row: 2 })).toEqual({
    col: 3,
    row: 2,
    len: 1,
  });
  // Across lines, buffer-absolute rows, wrapping the length the way `finalSelectionEnd` does:
  // start row 5 col 7 through end row 7 col 2 of a 10-col grid is 7..9, 0..9, 0..2 = 16 cells.
  expect(selectionSpan(10, { col: 7, row: 5 }, { col: 2, row: 7 })).toEqual({
    col: 7,
    row: 5,
    len: 16,
  });
  // The reverse drag gives the identical call — the extension must not flicker when the finger
  // crosses the anchor.
  expect(selectionSpan(10, { col: 2, row: 7 }, { col: 7, row: 5 })).toEqual({
    col: 7,
    row: 5,
    len: 16,
  });
  // Scrollback rows are just bigger rows: no wraparound, no special case.
  expect(selectionSpan(10, { col: 9, row: 400 }, { col: 0, row: 401 })).toEqual({
    col: 9,
    row: 400,
    len: 2,
  });
});
