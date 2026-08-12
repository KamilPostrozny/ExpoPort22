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
  takeNotches,
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
