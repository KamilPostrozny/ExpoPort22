/**
 * The bar-swipe window hop's brain (§4.4): horizontal swipe on the bar slides page cards between
 * tmux windows without opening the switcher. Every number is the prototype's
 * (`docs/design/Port22-Prototype.dc.html` — `barMove`/`barUp` and the `pagesSty`/`namePills`
 * render): pages at full design width with a 28pt gap, rubber-band at a third past the ends,
 * commit at 70pt of travel or a 30pt flick under 250ms, name pills at 228/242 pitch scaling
 * 0.85–1 and fading 0.6–1 with distance from the continuous position. Pure — tested in
 * `src/barswipe-model.test.ts`; the screen and the bar render and execute.
 */

import { DESIGN_W } from '@/switcher-model';

/* --- page geometry --- */

/** The 28pt gap between page cards at design width, as a fraction of the stage width. */
export const PAGE_GAP = 28 / DESIGN_W;

/** One page step: a full stage width plus the gap (the prototype's 430 at 402). */
export function pagePitch(stageW: number): number {
  return stageW + PAGE_GAP * stageW;
}

/** Page corner radius while a swipe is live (the prototype's `pageR: 16`); 0 at rest. */
export const PAGE_RADIUS = 16;

/* --- the drag --- */

/** Finger travel → displayed offset. Pulling past the first or last window shows a third of the
 *  travel — the rubber band; everywhere else the page rides the finger 1:1. */
export function rubber(dx: number, pos: number, count: number): number {
  'worklet';
  const pastEnd = (pos === 0 && dx > 0) || (pos === count - 1 && dx < 0);
  return pastEnd ? dx / 3 : dx;
}

/** Slow-drag commit distance, pt of travel. */
export const COMMIT_PX = 70;
/** Flick commit distance — enough travel, released fast. */
export const FLICK_PX = 30;
/** A release under this long after touch-down is a flick. */
export const FLICK_MS = 250;

/** Which grid position a release lands on: the neighbour past either threshold, clamped at the
 *  ends (where the rubber band already said no), the same position otherwise (spring back). */
export function swipeTarget(dx: number, dtMs: number, pos: number, count: number): number {
  if (dx < -COMMIT_PX || (dx < -FLICK_PX && dtMs < FLICK_MS)) return Math.min(pos + 1, count - 1);
  if (dx > COMMIT_PX || (dx > FLICK_PX && dtMs < FLICK_MS)) return Math.max(pos - 1, 0);
  return pos;
}

/** How long the committed snapshot stays over the terminal after the slide lands, giving tmux's
 *  redraw time to reach the PTY so the reveal is the new window, not one stale frame of the old.
 *  ponytail: a fixed hold; the upgrade is dropping it on the first shell data after select. */
export const SETTLE_HOLD_MS = 350;

/* --- the name pills replacing the bar keys during the swipe --- */

/** Pill width and gap as fractions of the bar pill's inner width (the prototype's 228 + 14 in a
 *  242 window — item plus gap exactly fill it, so the pitch IS the measured width). */
export const PILL_ITEM = 228 / 242;
export const PILL_GAP = 14 / 242;

/** The continuous position between windows: `pos` at rest, sliding with the page offset. */
export function pillCont(pos: number, x: number, pitch: number): number {
  'worklet';
  return pitch > 0 ? pos - x / pitch : pos;
}

/** A pill's distance from the continuous position, saturating at one window away. */
export function pillDist(i: number, cont: number): number {
  'worklet';
  return Math.min(Math.abs(i - cont), 1);
}

export function pillScale(dist: number): number {
  'worklet';
  return 1 - 0.15 * dist;
}

export function pillOpacity(dist: number): number {
  'worklet';
  return 1 - 0.4 * dist;
}

/* --- the neighbour page's type size --- */

/** A neighbour page renders its pane at true column count, like T10's cards but full-bleed: the
 *  size that fits `cols` columns in the page width (JBMono advance 0.6em), clamped to readable. */
export function pageFontSize(pageW: number, cols: number): number {
  if (cols <= 0) return 13;
  return Math.min(24, Math.max(4, pageW / (cols * 0.6)));
}
