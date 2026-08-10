/**
 * The tab switcher's brain (§4.5), kept out of the component so `bun test` can reach it: grid
 * slot geometry, the drag-reorder mapping (array position vs tmux index — windows can have
 * gapped indices), the swipe-to-close thresholds, and the zoom interpolation the terminal
 * follows into its card slot. Every number is the prototype's
 * (`docs/design/Port22-Prototype.dc.html`), scaled from its 402pt design width to the real
 * screen. `src/switcher.tsx` and the screen only render and execute what these say.
 */

import type { TmuxWindow } from '@/tmux-model';

/** The prototype's design width — every constant below is specified at this width and scaled. */
export const DESIGN_W = 402;

export type Frame = { x: number; y: number; w: number; h: number };

/** Card 173×240 at 20pt margins, 16pt gutter, 298pt row pitch (240 card + name + directory) —
 *  all from the prototype, as fractions of its width.
 *
 *  The prototype's 66pt band above the grid is *the device frame's status bar* (`ios-frame.jsx`
 *  pads `21px 24px 19px`), not headroom the app draws. On a real phone SafeAreaView already
 *  insets past the notch, so copying the 66 spent it twice: the grid began ~120pt down and the
 *  scroll view's clip edge sat that far below the crust's top, which reads as an invisible thing
 *  the cards disappear under (device, T13/T10.3). 12pt of breathing room is what is left. */
const CARD_W = 173 / DESIGN_W;
const CARD_H = 240 / DESIGN_W;
const MARGIN = 20 / DESIGN_W;
const COL_PITCH = 189 / DESIGN_W;
const ROW_PITCH = 298 / DESIGN_W;
const GRID_TOP = 12 / DESIGN_W;
/** The card's own corner radius (14pt at design width). */
const CARD_R = 14 / DESIGN_W;
/**
 * The display's own corner radius — where the flying surface's rounding STARTS, so the terminal
 * reads as the phone's screen shrinking rather than as a rectangle that rounds off somewhere over
 * the grid (user, 2026-08-10). 62pt is the radius of the device the prototype is drawn at
 * (402pt wide), scaled with everything else here.
 *
 * ponytail: a constant, not the real display radius. Apple exposes it only through
 * `UIScreen._displayCornerRadius`; the one npm wrapper for that
 * (`react-native-screen-corner-radius`) is a private-API read behind an old-architecture bridge
 * module, which RN 0.86 runs bridgeless. It would also be answering a question this geometry does
 * not quite ask: SafeAreaView already insets the stage off the top and bottom of the display, so
 * these corners are near the screen's, never on them. Scaling one number is the same answer to
 * within a few points on every phone that has round corners at all. If a device ever reads wrong,
 * the fix is that module, or a `Device.modelId` table.
 */
const SCREEN_R = 62 / DESIGN_W;
/**
 * How much of the flight the rounding takes to arrive: rounded within ~40ms of the surface first
 * moving, and exactly square at rest. Not merely square-looking — at rest the wrapper is the
 * terminal's own box, `overflow: hidden`, and a 62pt radius there clips the corner characters of
 * the top line off the live terminal.
 */
const ROUND_IN = 0.12;

export function gridTop(width: number): number {
  return GRID_TOP * width;
}

/**
 * The gap the pane keeps from the edge of the screen, at design width (user, 2026-08-10). The
 * terminal had none and the cards had their own, which is why the zoom's crossfade stepped: the
 * emulator draws from the very top-left of its box, so the text sat a whole inset higher and
 * further left in the flying surface than in the card it landed on.
 */
export const TERM_PAD = 8;

export function termPad(width: number): number {
  return (TERM_PAD / DESIGN_W) * width;
}

/** The same gap seen through the zoom. A card is `CARD_W` of the stage, so the inset that lands
 *  on the terminal's inset is the terminal's times that — derived, never a second number to keep
 *  in step by hand. */
export const SHOT_PAD = TERM_PAD * CARD_W;

/** T14: the search field's block above the grid (40pt field + 12pt gap, absolute like the other
 *  controls). The zoom aim adds it — the grid, and every card slot, sits this far lower. */
export const SEARCH_BAR_H = 52;

export function rowPitch(width: number): number {
  return ROW_PITCH * width;
}

/** Grid position i (array position, not tmux index) → the card's frame, relative to the grid
 *  origin (below the headroom, before any scroll). Two columns, always. */
export function slotFrame(i: number, width: number): Frame {
  return {
    x: (MARGIN + (i % 2) * COL_PITCH) * width,
    y: (MARGIN + Math.floor(i / 2) * ROW_PITCH) * width,
    w: CARD_W * width,
    h: CARD_H * width,
  };
}

/** Total grid content height for n cards — what the scroll view scrolls. */
export function gridHeight(n: number, width: number): number {
  return (MARGIN + Math.ceil(n / 2) * ROW_PITCH) * width;
}

/** Where a dragged card (top-left at x,y) wants to land: nearest slot by card centre, clamped to
 *  the existing cards. The prototype's cardMove, in width-relative terms. */
export function targetSlot(x: number, y: number, width: number, count: number): number {
  const cx = x + (CARD_W / 2) * width;
  const cy = y + (CARD_H / 2) * width;
  const col = cx > (MARGIN + COL_PITCH) * width ? 1 : 0;
  const row = Math.max(0, Math.round((cy - (MARGIN + CARD_H / 2) * width) / (ROW_PITCH * width)));
  return Math.min(count - 1, row * 2 + col);
}

/* --- reorder: array positions in, tmux indices out --- */

/** The optimistic local order after dragging position `from` to position `to`. */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The `moveWindow(from, to)` arguments for a drop, from the PRE-drag window list. Array position
 * and tmux index are different things — indices can be gapped (`:1 :3 :7`) — so both arguments
 * are the tmux indices of the windows that sat at those positions when the drag began. That
 * matches splice semantics: T9's `move-window -a/-b` lands the source after (moving down) or
 * before (moving up) the target window. `null` = dropped where it started, nothing to run.
 */
export function reorderArgs(
  before: TmuxWindow[],
  fromPos: number,
  toPos: number,
): { from: number; to: number } | null {
  if (fromPos === toPos) return null;
  const source = before[fromPos];
  const target = before[toPos];
  if (!source || !target) return null;
  return { from: source.index, to: target.index };
}

/* --- swipe-to-close (prototype cardMove/cardUp: left rides the finger, right rubber-bands) --- */

/** Rightward travel is shown at a third — the rubber band. Leftward is 1:1. */
export function swipeOffset(dx: number): number {
  'worklet';
  return dx < 0 ? dx : dx / 3;
}

/** Close past half a card width, or a 40pt-at-design-width fling under 300ms. */
export function shouldClose(offset: number, elapsedMs: number, width: number): boolean {
  'worklet';
  const u = width / DESIGN_W;
  return offset < (-173 / 2) * u || (offset < -40 * u && elapsedMs < 300);
}

/** The card fades as it leaves: fully gone one card-width out. */
export function swipeOpacity(offset: number, width: number): number {
  'worklet';
  return 1 - Math.min(Math.max(-offset, 0) / (CARD_W * width), 1);
}

/* --- the zoom (prototype zoomFollow / zoomSty) --- */

/** Bar-swipe-up drag travel → zoom progress: dead for the first 24pt (the classify threshold),
 *  saturating 280pt later. Design-width points, scaled. */
export function zoomProgress(dy: number, width: number): number {
  const u = width / DESIGN_W;
  return Math.min(Math.max((-dy - 24 * u) / (280 * u), 0), 1);
}

/** Release above this progress commits to the grid; below springs back. */
export const ZOOM_COMMIT = 0.25;

export type ZoomFrame = {
  /** Scale about the wrapper's centre. */
  scale: number;
  /** The wrapper's height — the clip that removes the stage's bottom as it shrinks. */
  height: number;
  /** Top-left translation, compensated for RN's centre-origin scaling. */
  translateX: number;
  translateY: number;
  /** Corner radius in wrapper units (visually multiplied by `scale`). */
  radius: number;
  /** The accent ring during the transition: in by half-way. */
  ringOpacity: number;
};

/**
 * Interpolate the whole terminal surface between rest (t=0: identity over the stage) and the
 * card slot (t=1: scaled to the slot frame, bottom clipped away). `slot` is in stage
 * coordinates. `dx` is the finger's horizontal drift during a drag-follow (prototype rides it
 * at 0.6), zero for committed animations. RN scales about the view centre, so the translation
 * compensates to keep the interpolation anchored at the top-left like the prototype's
 * `transform-origin: 0 0`.
 */
export function zoomFrame(
  t: number,
  dx: number,
  slot: Frame,
  stage: { w: number; h: number },
): ZoomFrame {
  'worklet';
  const S = slot.w / stage.w;
  const scale = 1 + (S - 1) * t;
  const height = stage.h - (stage.h - slot.h / S) * t;
  const x = slot.x * t + dx * 0.6;
  const y = slot.y * t;
  return {
    scale,
    height,
    translateX: x - (stage.w * (1 - scale)) / 2,
    translateY: y - (height * (1 - scale)) / 2,
    // Screen corner → card corner, in what the eye actually measures: the radius ON SCREEN, which
    // is this one times `scale`. Hence the divide — at t=1 it comes back to the card's own 14pt.
    radius: (((SCREEN_R + (CARD_R - SCREEN_R) * t) * stage.w) / scale) * Math.min(t / ROUND_IN, 1),
    ringOpacity: Math.min(t * 2, 1),
  };
}

/* --- the snapshot's type size --- */

/** A card renders the pane at its true column count, so the type size is whatever makes `cols`
 *  columns fit the card width. JetBrains Mono's advance is 0.6em. Clamped: below ~3pt nothing
 *  reads as text, above 8 the card looks like a ransom note. */
export function snapshotFontSize(cardW: number, cols: number): number {
  if (cols <= 0) return 6;
  return floorFit(Math.min(8, Math.max(3, cardW / (cols * MONO_ADVANCE))));
}

/** JetBrains Mono's advance, in ems — what RN lays the snapshot's text out on, and what the
 *  emulator's cell measures too (7.79 at 13pt on device). The catch is not the cell, it is that
 *  `cols` of them do not fill the box: see `snapshotType`. */
export const MONO_ADVANCE = 0.6;

export type SnapType = { fontSize: number; lineHeight: number };

/**
 * The type a snapshot draws its pane at: the terminal's own cell, scaled by the zoom. Fitting the
 * columns to the box instead — the obvious thing, and what this did first — is wrong because the
 * emulator's own columns do not fill their box: its fit holds back a scrollbar gutter that never
 * renders. Handing that slack to the snapshot drew it ~6% large, so the zoom's crossfade stepped
 * in size as well as position (device, two photographs). The cell comes measured from the
 * emulator; `cols`/`boxW` only cap it, for a pane some other client sized wider than the card it
 * has to be drawn in.
 */
export function snapshotType(
  cell: { w: number; h: number },
  scale: number,
  cols: number,
  boxW: number,
): SnapType {
  const fromCell = cell.w * scale;
  if (fromCell <= 0 || cols <= 0) {
    // No metrics yet (nothing has been rendered): the columns are all there is to go on.
    const fontSize = snapshotFontSize(boxW, cols);
    return { fontSize, lineHeight: fontSize * 1.4 };
  }
  const shrink = Math.min(1, boxW / (cols * fromCell));
  return {
    fontSize: floorFit((fromCell * shrink) / MONO_ADVANCE),
    lineHeight: cell.h * scale * shrink,
  };
}

/** An exact fit is `cols` advances landing on exactly `cardW`, and a float that rounds the last
 *  one up by a millionth of a point is a line that no longer fits — which RN answers by folding
 *  it, turning one overflowing character into a card that reads nothing like the terminal. Two
 *  decimals of type size is under a tenth of a pixel; the slack is free. */
export function floorFit(size: number): number {
  return Math.floor(size * 100) / 100;
}
