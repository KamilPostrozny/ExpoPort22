/** `bun test` — the bar-swipe page slide's decisions (T11): rubber band, commit thresholds,
 *  page geometry, the name pills' interpolation. Every number is the prototype's. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  COMMIT_PX,
  FLICK_MS,
  FLICK_PX,
  PAGE_GAP,
  PILL_GAP,
  PILL_ITEM,
  pageFontSize,
  pagePitch,
  pillCont,
  pillDist,
  pillOpacity,
  pillScale,
  rubber,
  swipeTarget,
} from '@/barswipe-model';

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

/* --- page geometry (prototype: 402-wide pages, 28 gap → 430 pitch) --- */

test('pagePitch scales the prototype 430-at-402', () => {
  expect(pagePitch(402)).toBeCloseTo(430);
  expect(PAGE_GAP).toBeCloseTo(28 / 402);
});

/* --- name pills (prototype namePills: 228+14 in a 242 window) --- */

test('pill fractions fill the pitch exactly', () => {
  expect(PILL_ITEM + PILL_GAP).toBeCloseTo(1);
});

test('pillCont slides with the page offset', () => {
  expect(pillCont(1, 0, 430)).toBe(1);
  expect(pillCont(1, -215, 430)).toBeCloseTo(1.5); // half-way toward next
  expect(pillCont(1, 430, 430)).toBe(0); // a full page toward previous
  expect(pillCont(1, -100, 0)).toBe(1); // no pitch yet: stay put, no divide-by-zero
});

test('pill scale and opacity: full at centre, saturating one window out', () => {
  expect(pillScale(pillDist(1, 1))).toBe(1);
  expect(pillOpacity(pillDist(1, 1))).toBe(1);
  expect(pillDist(0, 1.5)).toBe(1); // saturates
  expect(pillScale(1)).toBeCloseTo(0.85);
  expect(pillOpacity(1)).toBeCloseTo(0.6);
  expect(pillScale(pillDist(2, 1.5))).toBeCloseTo(0.925);
});

/* --- neighbour page type size --- */

test('pageFontSize fits the columns, clamped', () => {
  expect(pageFontSize(390, 50)).toBeCloseTo(13);
  expect(pageFontSize(390, 500)).toBe(4); // absurdly wide pane: floor
  expect(pageFontSize(390, 10)).toBe(24); // narrow pane: ceiling
  expect(pageFontSize(390, 0)).toBe(13); // no width known: the default size
});
