/**
 * The bar-swipe window hop's brain (§4.4): horizontal swipe on the bar slides page cards between
 * tmux windows without opening the switcher. Every number is the prototype's
 * (`docs/design/Port22-Prototype.dc.html` — `barMove`/`barUp` and the `pagesSty`/`namePills`
 * render): pages at full design width with a 28pt gap, rubber-band at a third past the ends,
 * commit at 70pt of travel or a 30pt flick under 250ms, name pills at 228/242 pitch scaling
 * 0.85–1 and fading 0.6–1 with distance from the continuous position. Pure — tested in
 * `src/barswipe-model.test.ts`; the screen and the bar render and execute.
 */

import { DESIGN_W, SCREEN_R, ZOOM_COMMIT } from '@/switcher-model';

/* --- page geometry --- */

/** The 28pt gap between page cards at design width, as a fraction of the stage width. */
export const PAGE_GAP = 28 / DESIGN_W;

/** One page step: a full stage width plus the gap (the prototype's 430 at 402). */
export function pagePitch(stageW: number): number {
  return stageW + PAGE_GAP * stageW;
}

/** Page corner radius while a swipe is live; 0 at rest. The display's own radius, not the
 *  prototype's 16: the cards run the full window now, so their corners ARE the screen's — the
 *  same `SCREEN_R` the zoom starts its rounding from. 16pt on a full-screen card read as barely
 *  rounded at all (user, 2026-08-11). */
export function pageRadius(stageW: number): number {
  return SCREEN_R * stageW;
}

/** The travel over which a neighbour closes the last of its gap and seats — one distance for
 *  every swipe, fast or slow. It briefly scaled with the swipe's speed (130pt at a walk, ~40pt at
 *  a flick, user 2026-08-13); the coupling was withdrawn the next day — the row arrives at its own
 *  pace, not the hand's (user, 2026-08-14). */
export const ROW_REACH = 130;

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

/** Upward speed at the release, pt/s, that sends the card to the grid whatever the travel was. */
export const ZOOM_FLICK_VY = 700;

/**
 * The vertical release: does letting go open the switcher, or spring the terminal back?
 *
 * Two ways, and now they are the ONLY vertical decision in the gesture — nothing is judged while
 * the finger is down any more, because the card follows it up and back down with no threshold in
 * between (user, 2026-08-13). `prog` past `ZOOM_COMMIT` is the pull: a quarter of the way into the
 * card and let go. The flick is a slight swipe up off the bar that sends the tab to the grid
 * without dragging it there (user, 2026-08-10) — and it is asked of the SPEED at the release, not
 * of the travel, because travel cannot tell an upward flick from the arc a thumb draws through an
 * ordinary flat swipe (2026-08-12: ten hops crossing -24…-26). At the release those two look
 * nothing alike: a flick is going up faster than it is going sideways, and a hop is not going up.
 */
export function zoomCommits(prog: number, vx: number, vy: number): boolean {
  return prog > ZOOM_COMMIT || (vy <= -ZOOM_FLICK_VY && Math.abs(vy) > Math.abs(vx));
}

/** The release slide's speed, pt per ms — the duration scales with the distance left, so an
 *  early release does not sprint the rest of the way the fixed-duration ease-out did. 0.9
 *  (~480ms full pitch) then read as too slow (user, 2026-08-11, twice): 1.15 puts a full pitch
 *  at ~375ms, between the original 320 and the constant-speed 480. */
export const SLIDE_SPEED = 1.15;

/** Remaining distance → the release slide's duration, floored so a hair's width never snaps. */
export function slideMs(distance: number): number {
  return Math.max(60, Math.abs(distance) / SLIDE_SPEED);
}

/* The committed snapshot's hold over the terminal has no duration here on purpose: it ends when
 * the host says it has finished redrawing (`afterHostRedraw` in the screen), not after a number
 * anyone picked. A flat 350ms cap was long enough to photograph twice (user, 2026-08-10). */

/* --- the name pills replacing the bar keys during the swipe --- */


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

/** Safari's sequencing (user, 2026-08-11, screenshots): the departing pill finishes shrinking in
 *  the FIRST half of the step and the arriving one only starts growing in the second — morphing
 *  both at once reads as one pill stretching into the next. Distance saturates at half a window
 *  instead of a whole one; the far half is flat at the floor. And Safari's magnitude: the pill
 *  vanishes — opacity to zero, scale well down — not the prototype's 0.85/0.6 nudge, which on
 *  device read as no morph at all (user, 2026-08-11). */
function pillMorph(dist: number): number {
  'worklet';
  // Saturates at 0.7 of a window, so the arriving pill starts growing ~30% into the travel —
  // floored until half-way it read as popping in at the end (user, 2026-08-11). The overlap
  // this opens is safe NOW: the pills anchor to opposite edges of the slot, so two part-morphed
  // capsules sit apart like Safari's — centre-anchored they stacked, which is why this was
  // briefly halved.
  return Math.min(dist / 0.7, 1);
}

/** The collapsed capsule, as a fraction of the pill slot — Safari's morph is the pill
 *  SQUEEZING sideways to a small capsule and growing back out, height untouched, not a uniform
 *  scale-down (user, 2026-08-11, Safari screenshots side by side with ours). */
export const PILL_MIN = 50 / 228;

/** The glass pill's width through the morph: full slot at its window, the bare capsule half a
 *  window out. Width, not scale — the text inside keeps its size and clips. */
export function pillWidthFrac(dist: number): number {
  'worklet';
  return 1 - (1 - PILL_MIN) * pillMorph(dist);
}

/** Quadratic to ZERO: near-full while the pill squeezes — the width change happens in plain
 *  sight, the fade trails it — but fully gone at the floor, because the floored pill shares its
 *  slot with the other one and a 0.25-opacity residue stacked the two visibly. */
export function pillOpacity(dist: number): number {
  'worklet';
  const m = pillMorph(dist);
  return 1 - m * m;
}

