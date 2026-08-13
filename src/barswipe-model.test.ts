/** `bun test` — the bar-swipe page slide's decisions (T11): rubber band, commit thresholds,
 *  page geometry, the name pills' interpolation. Every number is the prototype's. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  COMMIT_PX,
  FLICK_MS,
  FLICK_PX,
  PAGE_GAP,
  pagePitch,
  pillCont,
  pillDist,
  pillOpacity,
  PILL_MIN,
  pillWidthFrac,
  rubber,
  swipeTarget,
  zoomCommits,
  ZOOM_FLICK_VY,
} from '@/barswipe-model';
import { ZOOM_COMMIT } from '@/switcher-model';

/* --- rubber band (prototype barMove: a third past the ends) --- */

test('rubber: 1:1 in the middle, a third past either end', () => {
  expect(rubber(-50, 1, 3)).toBe(-50);
  expect(rubber(50, 1, 3)).toBe(50);
  expect(rubber(60, 0, 3)).toBe(20); // first window, pulling toward a previous that is not there
  expect(rubber(-60, 2, 3)).toBe(-20); // last window, pulling toward a next that is not there
  expect(rubber(-60, 0, 3)).toBe(-60); // first window toward next: normal
  expect(rubber(60, 0, 1)).toBe(20); // one window: both directions rubber-band
  expect(rubber(-60, 0, 1)).toBe(-20);
});

/* --- commit thresholds (prototype barUp: 70pt, or 30pt under 250ms) --- */

test('swipeTarget: slow drag commits past 70, flick past 30', () => {
  expect(swipeTarget(-(COMMIT_PX + 1), 800, 1, 4)).toBe(2); // slow, far enough → next
  expect(swipeTarget(-(FLICK_PX + 5), 200, 1, 4)).toBe(2); // fast, near enough → next
  expect(swipeTarget(-(FLICK_PX + 5), FLICK_MS + 50, 1, 4)).toBe(1); // same travel, slow → stay
  expect(swipeTarget(-(FLICK_PX - 5), 100, 1, 4)).toBe(1); // fast but not far enough → stay
  expect(swipeTarget(COMMIT_PX + 1, 800, 1, 4)).toBe(0); // rightward → previous
  expect(swipeTarget(FLICK_PX + 5, 200, 1, 4)).toBe(0);
  expect(swipeTarget(0, 100, 1, 4)).toBe(1);
});

test('swipeTarget clamps at the ends', () => {
  expect(swipeTarget(200, 100, 0, 4)).toBe(0); // no previous before the first
  expect(swipeTarget(-200, 100, 3, 4)).toBe(3); // no next after the last
});

/* The screen swipes over one more position than it has windows: the slot past the last tab is a
 * window that does not exist yet, and committing onto it births one. Nothing in the model knows
 * that — it is `count + 1` at the two call sites — so this pins what that convention buys. */
test('a phantom slot past the last window is reachable, and does not rubber-band', () => {
  const REAL = 3; // windows 0..2, plus the new-tab slot at 3
  expect(rubber(-50, REAL - 1, REAL + 1)).toBe(-50); // last tab, leftward: rides the finger
  expect(rubber(-50, REAL - 1, REAL)).toBe(-50 / 3); // …which it would NOT without the phantom
  expect(swipeTarget(-(COMMIT_PX + 1), 800, REAL - 1, REAL + 1)).toBe(REAL); // commit onto it
  expect(swipeTarget(FLICK_PX + 5, 200, 0, REAL + 1)).toBe(0); // the first tab still has no left
  expect(rubber(50, 0, REAL + 1)).toBe(50 / 3); // and still bands there
});

test('zoomCommits: a quarter pulled, or thrown upward at the release', () => {
  // The pull, unchanged: a quarter of the way into the card and let go.
  expect(zoomCommits(ZOOM_COMMIT + 0.01, 0, 0)).toBe(true);
  expect(zoomCommits(ZOOM_COMMIT, 0, 0)).toBe(false);
  // The flick, now asked of the release's speed rather than its travel — travel could never tell
  // a flick from the arc a thumb draws through a flat hop (device, 2026-08-12).
  expect(zoomCommits(0, 0, -(ZOOM_FLICK_VY + 1))).toBe(true);
  expect(zoomCommits(0, 0, -(ZOOM_FLICK_VY - 1))).toBe(false); // upward, not thrown
  // A flat hop's release: travelling sideways, barely upward at all.
  expect(zoomCommits(0, -1800, -800)).toBe(false);
  // Down is not up, however fast — the keyboard drop and the grab are the same gesture, mirrored.
  expect(zoomCommits(0, 0, 1800)).toBe(false);
});

/* --- page geometry (prototype: 402-wide pages, 28 gap → 430 pitch) --- */

test('pagePitch scales the prototype 430-at-402', () => {
  expect(pagePitch(402)).toBeCloseTo(430);
  expect(PAGE_GAP).toBeCloseTo(28 / 402);
});

/* --- name pills --- */

test('pillCont slides with the page offset', () => {
  expect(pillCont(1, 0, 430)).toBe(1);
  expect(pillCont(1, -215, 430)).toBeCloseTo(1.5); // half-way toward next
  expect(pillCont(1, 430, 430)).toBe(0); // a full page toward previous
  expect(pillCont(1, -100, 0)).toBe(1); // no pitch yet: stay put, no divide-by-zero
});

test('pill morph: squeezed out by 0.7 of a window, growing from 30% in', () => {
  expect(pillWidthFrac(pillDist(1, 1))).toBe(1);
  expect(pillOpacity(pillDist(1, 1))).toBe(1);
  expect(pillDist(0, 1.5)).toBe(1); // saturates
  expect(pillWidthFrac(1)).toBeCloseTo(PILL_MIN);
  // Fully invisible at the floor — a floored residue is a phantom capsule parked at the edge.
  expect(pillOpacity(1)).toBeCloseTo(0);
  expect(pillOpacity(pillDist(3, 1.5))).toBeCloseTo(0); // a whole window out, either side
  expect(pillOpacity(pillDist(0, 1.5))).toBeCloseTo(0);
  // 0.35 out (morph half-way): squeezing in plain sight, the quadratic fade trailing.
  expect(pillWidthFrac(0.35)).toBeCloseTo(1 - (1 - PILL_MIN) / 2);
  expect(pillOpacity(0.35)).toBeCloseTo(0.75);
  // The arriving pill is already alive 30% into the travel (dist 0.69 < the 0.7 saturation) —
  // the edge anchors keep the brief two-pill overlap apart, one capsule per side.
  expect(pillWidthFrac(0.69)).toBeGreaterThan(PILL_MIN);
  expect(pillOpacity(0.69)).toBeGreaterThan(0);
  expect(pillWidthFrac(0.7)).toBeCloseTo(PILL_MIN);
});

/* --- neighbour page type size --- */

