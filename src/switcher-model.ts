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

/** Card 173×240 at 20pt margins, 16pt gutter, 298pt row pitch (240 card + name + directory),
 *  66pt of headroom above the grid — all from the prototype, as fractions of its width. */
const CARD_W = 173 / DESIGN_W;
const CARD_H = 240 / DESIGN_W;
const MARGIN = 20 / DESIGN_W;
const COL_PITCH = 189 / DESIGN_W;
const ROW_PITCH = 298 / DESIGN_W;
const GRID_TOP = 66 / DESIGN_W;
/** The card's own corner radius (14pt at design width). */
const CARD_R = 14 / DESIGN_W;

export function gridTop(width: number): number {
  return GRID_TOP * width;
}

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
    radius: ((CARD_R * stage.w) / S) * t,
    ringOpacity: Math.min(t * 2, 1),
  };
}

/** The + button's frame — where a new terminal is born from (Safari new-tab). The switcher's
 *  bottom bar: 34pt side padding, 49pt circle, 44pt above the bottom, at design width. */
export function plusFrame(width: number, height: number): Frame {
  const u = width / DESIGN_W;
  return { x: 34 * u, y: height - (44 + 49) * u, w: 49 * u, h: 49 * u };
}

/* --- the snapshot's type size --- */

/** A card renders the pane at its true column count, so the type size is whatever makes `cols`
 *  columns fit the card width. JetBrains Mono's advance is 0.6em. Clamped: below ~3pt nothing
 *  reads as text, above 8 the card looks like a ransom note. */
export function snapshotFontSize(cardW: number, cols: number): number {
  if (cols <= 0) return 6;
  return Math.min(8, Math.max(3, cardW / (cols * 0.6)));
}
