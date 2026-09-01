/** `bun test` — the switcher's decisions (§4.5): slot geometry, reorder mapping (array position
 *  vs gapped tmux index), swipe-to-close thresholds, and the zoom interpolation. All at the
 *  prototype's numbers, checked at its own 402pt design width where they can be read off. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  HOLD_SCALE,
  MONO_ADVANCE,
  ZOOM_COMMIT,
  aimFrame,
  gridHeight,
  revealOffset,
  heldFrame,
  holdFrame,
  gridTop,
  reorder,
  reorderArgs,
  shouldClose,
  slotFrame,
  snapshotFontSize,
  snapshotType,
  SHOT_PAD,
  swipeOffset,
  swipeOpacity,
  targetSlot,
  termPad,
  zoomBox,
  zoomFrame,
  zoomProgress,
  liftShadow,
} from '@/switcher-model';
import type { TmuxWindow } from '@/tmux-model';

const win = (index: number, active = false): TmuxWindow => ({
  id: `@${index}`,
  index,
  name: `w${index}`,
  active,
  command: 'fish',
  path: '/home/kamil',
  width: 80,
});

/** Field-wise close compare — the fractions of 402 do not round-trip to exact floats. */
const closeTo = (got: Record<string, number>, want: Record<string, number>) => {
  for (const key of Object.keys(want)) expect(got[key]).toBeCloseTo(want[key], 6);
};

test('slot geometry at design width matches the prototype exactly', () => {
  closeTo(slotFrame(0, 402), { x: 20, y: 20, w: 173, h: 240 });
  closeTo(slotFrame(1, 402), { x: 209, y: 20, w: 173, h: 240 });
  closeTo(slotFrame(2, 402), { x: 20, y: 318, w: 173, h: 240 });
  closeTo(slotFrame(5, 402), { x: 209, y: 318 + 298, w: 173, h: 240 });
  // Nothing, not the prototype's 66: that band is the device frame's status bar, which SafeAreaView
  // already accounts for on a real phone (T13/T10.3), and the search field brings its own gap.
  expect(gridTop(402)).toBe(0);
});

test('slot geometry scales with the screen width', () => {
  const half = slotFrame(3, 201);
  const full = slotFrame(3, 402);
  expect(half.x).toBeCloseTo(full.x / 2);
  expect(half.y).toBeCloseTo(full.y / 2);
  expect(half.w).toBeCloseTo(full.w / 2);
});

test('grid height covers the last row', () => {
  expect(gridHeight(1, 402)).toBe(20 + 298);
  expect(gridHeight(2, 402)).toBe(20 + 298);
  expect(gridHeight(3, 402)).toBe(20 + 2 * 298);
  expect(gridHeight(5, 402)).toBe(20 + 3 * 298);
});

test('revealOffset puts the aimed slot on screen, and moves as little as it can', () => {
  // A phone-shaped viewport: 402 wide, 874 tall, notch+search block above, bar+home strip below.
  const grid = { count: 12, width: 402, height: 874, headerH: 107, bottomH: 98 };
  const top = (pos: number) => grid.headerH + slotFrame(pos, 402).y;

  // The launch case: the grid has never scrolled and the active window is five rows down.
  const y = revealOffset({ ...grid, pos: 10, at: 0 });
  expect(y).toBeGreaterThan(0);
  expect(top(10) - y).toBeGreaterThanOrEqual(grid.headerH); // clear of the search strip
  expect(top(10) + 298 - y).toBeLessThanOrEqual(grid.height - grid.bottomH); // clear of the bar

  // Already comfortably in view: nothing moves.
  expect(revealOffset({ ...grid, pos: 4, at: top(4) - grid.headerH })).toBe(top(4) - grid.headerH);
  // The first row never needs a scroll, and the offset never goes negative or past the end.
  expect(revealOffset({ ...grid, pos: 0, at: 0 })).toBe(0);
  const end = revealOffset({ ...grid, pos: 11, at: 1e6 });
  expect(end).toBe(grid.headerH + gridHeight(12, 402) + grid.bottomH - grid.height);
});

test('targetSlot: a card dragged onto a slot centre lands there, clamped to the deck', () => {
  const at = (i: number) => slotFrame(i, 402);
  expect(targetSlot(at(0).x, at(0).y, 402, 4)).toBe(0);
  expect(targetSlot(at(3).x, at(3).y, 402, 4)).toBe(3);
  // dragged just over the column boundary: column flips
  expect(targetSlot(at(0).x + 120, at(0).y, 402, 4)).toBe(1);
  // dragged below the last row: clamped to the last card
  expect(targetSlot(at(0).x, 1500, 402, 4)).toBe(3);
  // dragged above the grid: row clamps at 0
  expect(targetSlot(at(0).x, -300, 402, 4)).toBe(0);
});

test('reorder is a splice move', () => {
  expect(reorder([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
  expect(reorder([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
  expect(reorder([1, 2, 3, 4], 1, 1)).toEqual([1, 2, 3, 4]);
});

test('reorderArgs speaks tmux indices, not array positions — gaps included', () => {
  // windows :1 :3 :7 — array positions 0 1 2
  const wins = [win(1), win(3), win(7)];
  expect(reorderArgs(wins, 0, 2)).toEqual({ from: 1, to: 7 });
  expect(reorderArgs(wins, 2, 0)).toEqual({ from: 7, to: 1 });
  expect(reorderArgs(wins, 1, 1)).toBeNull();
  expect(reorderArgs(wins, 0, 9)).toBeNull(); // position that never existed: nothing to run
});

test('swipe-to-close: left rides the finger, right rubber-bands at a third', () => {
  expect(swipeOffset(-50)).toBe(-50);
  expect(swipeOffset(90)).toBe(30);
});

test('swipe-to-close thresholds: half a card, or a quick 40pt fling', () => {
  expect(shouldClose(-87, 999, 402)).toBe(true); // past half the 173pt card
  expect(shouldClose(-86, 999, 402)).toBe(false);
  expect(shouldClose(-41, 200, 402)).toBe(true); // fling
  expect(shouldClose(-41, 400, 402)).toBe(false); // same travel, too slow
  expect(shouldClose(30, 100, 402)).toBe(false); // rightward never closes
  // thresholds scale with the screen
  expect(shouldClose(-44, 999, 201)).toBe(true);
});

test('swipe opacity fades to zero one card-width out', () => {
  expect(swipeOpacity(0, 402)).toBe(1);
  expect(swipeOpacity(-173, 402)).toBe(0);
  expect(swipeOpacity(-86.5, 402)).toBeCloseTo(0.5);
  expect(swipeOpacity(40, 402)).toBe(1); // rightward never fades
});

test('zoomProgress: a dead zone sized by how sideways the gesture is', () => {
  expect(zoomProgress(0, 402)).toBe(0);
  // A flat hop's arc, in full: 10-19pt sideways when dy crosses -26 — never shrinks the card.
  expect(zoomProgress(-26, 402, 15)).toBe(0);
  expect(zoomProgress(-26, 402, 19)).toBe(0);
  // A straight flick pays only the minimum: moving by 10pt up already.
  expect(zoomProgress(-10, 402, 0)).toBeGreaterThan(0);
  expect(zoomProgress(-8, 402, 0)).toBe(0);
  // The legacy full zone with no sideways information.
  expect(zoomProgress(-30 - 140, 402)).toBeCloseTo(0.5);
  expect(zoomProgress(-30 - 280, 402)).toBe(1);
  expect(zoomProgress(-1000, 402)).toBe(1);
  expect(zoomProgress(50, 402)).toBe(0); // downward drag is not a zoom
  // Everything scales with the screen like the ramp does.
  expect(zoomProgress(-14, 201)).toBe(0);
  expect(zoomProgress(-15 - 70, 201)).toBeCloseTo(0.5); // half of the half-width 140pt ramp
  expect(ZOOM_COMMIT).toBe(0.25);
});


test('the held pose is the whole screen made small, centred and uncropped', () => {
  const stage = { w: 402, h: 874 };
  const hold = holdFrame(stage);
  // Centred: the margin either side is the same, and likewise above and below.
  expect(hold.x).toBeCloseTo((402 - hold.w) / 2);
  expect(hold.y).toBeCloseTo((874 - hold.h) / 2);
  // Aspect preserved, so `zoomFrame`'s clip never closes — a card in the hand shows the whole
  // page, unlike a card in the grid, which is cropped to its slot.
  const f = zoomFrame(1, 0, hold, stage);
  expect(f.scale).toBeCloseTo(HOLD_SCALE);
  expect(f.height).toBeCloseTo(stage.h);
});

test('a held card is slot-sized by its reach but always screen-centred', () => {
  const stage = { w: 402, h: 874 };
  const slot = { ...slotFrame(5, 402), y: 900 }; // a bottom-row slot, scrolled low
  for (const t of [0, 0.4, 0.7]) {
    const f = heldFrame(stage, slot, t);
    expect(f.x).toBeCloseTo((stage.w - f.w) / 2); // centred whatever the slot's place
    expect(f.y).toBeCloseTo((stage.h - f.h) / 2);
  }
  expect(heldFrame(stage, slot, 0).w).toBeCloseTo(stage.w * HOLD_SCALE);
  // at full reach the aspect is the slot's, not the screen's — the height shrink
  const deep = heldFrame(stage, slot, 1);
  expect(deep.h / deep.w).toBeCloseTo(slot.h / slot.w);
});

test('the aim leaves the hold pose only as the release flies it to the slot', () => {
  const stage = { w: 402, h: 874 };
  const hold = holdFrame(stage);
  const slot = slotFrame(3, 402);
  expect(aimFrame(hold, slot, 0)).toEqual(hold);
  expect(aimFrame(hold, slot, 1)).toEqual(slot);
  const half = aimFrame(hold, slot, 0.5);
  expect(half.x).toBeCloseTo((hold.x + slot.x) / 2);
  expect(half.w).toBeCloseTo((hold.w + slot.w) / 2);
});

test('the shared container lands its children exactly where zoomFrame would', () => {
  const stage = { w: 402, h: 874 };
  const slot = slotFrame(3, 402);
  for (const t of [0, 0.3, 0.62, 1]) {
    const b = zoomBox(t, 0, slot, stage);
    const f = zoomFrame(t, 0, slot, stage);
    expect(b.scale).toBeCloseTo(f.scale);
    // A card pinned at the container's top-left lands on the same screen point either way: the
    // box compensates against the stage's height, the frame against its own clipped one.
    expect(b.translateX + (stage.w * (1 - b.scale)) / 2).toBeCloseTo(
      f.translateX + (stage.w * (1 - f.scale)) / 2,
    );
    expect(b.translateY + (stage.h * (1 - b.scale)) / 2).toBeCloseTo(
      f.translateY + (f.height * (1 - f.scale)) / 2,
    );
  }
});

test('zoomFrame endpoints: identity at rest, the card slot at 1', () => {
  const stage = { w: 402, h: 874 };
  const slot = { ...slotFrame(0, 402), y: slotFrame(0, 402).y + 66 }; // stage coords incl. headroom
  const rest = zoomFrame(0, 0, slot, stage);
  expect(rest.scale).toBe(1);
  expect(rest.height).toBe(874);
  expect(rest.translateX).toBe(0);
  expect(rest.translateY).toBe(0);
  expect(rest.radius).toBeCloseTo(62); // the screen's own corner, worn at rest too
  expect(rest.ringOpacity).toBe(0);

  const S = 173 / 402;
  const zoomed = zoomFrame(1, 0, slot, stage);
  expect(zoomed.scale).toBeCloseTo(S);
  // clip: the visible height scaled down is exactly the card height
  expect(zoomed.height * S).toBeCloseTo(240);
  // centre-origin compensation lands the scaled top-left on the slot
  expect(zoomed.translateX + (stage.w * (1 - S)) / 2).toBeCloseTo(slot.x);
  expect(zoomed.translateY + (zoomed.height * (1 - S)) / 2).toBeCloseTo(slot.y);
  // radius scaled down is the card's 14pt corner
  expect(zoomed.radius * S).toBeCloseTo(14);
  expect(zoomed.ringOpacity).toBe(1);
});

test('zoomFrame is screen-round at rest and eases to the card corner', () => {
  const stage = { w: 402, h: 874 };
  const slot = slotFrame(0, 402);
  // On screen the corner is `radius * scale` — that is what the eye compares to the phone's own.
  const onScreen = (t: number) => {
    const f = zoomFrame(t, 0, slot, stage);
    return f.radius * f.scale;
  };
  // The display's corner at rest — no animation from square (user, 2026-08-11).
  expect(onScreen(0)).toBeCloseTo(62);
  // …shrinking monotonically to the card's 14pt by the time it lands in the slot.
  expect(onScreen(0.5)).toBeLessThan(onScreen(0));
  expect(onScreen(1)).toBeCloseTo(14);
});

test('zoomFrame rides the finger drift at 0.6 like the prototype', () => {
  const stage = { w: 402, h: 874 };
  const slot = slotFrame(0, 402);
  const still = zoomFrame(0.5, 0, slot, stage);
  const drifted = zoomFrame(0.5, 100, slot, stage);
  expect(drifted.translateX - still.translateX).toBeCloseTo(60);
});

test('snapshotFontSize fits the pane columns to the card, clamped to legible', () => {
  expect(snapshotFontSize(173, 80)).toBeCloseTo(173 / 48);
  expect(snapshotFontSize(173, 20)).toBe(8); // few columns: cap, not billboard type
  expect(snapshotFontSize(173, 500)).toBe(3); // absurd width: floor, unreadable but bounded
  expect(snapshotFontSize(173, 0)).toBe(6); // no data yet: a sane default
});

// The one number the zoom's crossfade rests on: a card's inset has to BE the terminal's inset
// after the zoom has shrunk it, or the text steps sideways and down the moment the flying
// surface hands over to the snapshot underneath it.
test('a card\'s snapshot inset is the terminal\'s inset seen through the zoom', () => {
  for (const width of [402, 393, 440]) {
    const scale = slotFrame(0, width).w / width; // what the zoom shrinks the stage by
    const cardInset = (SHOT_PAD / 402) * width; // as switcher.tsx applies it
    expect(cardInset).toBeCloseTo(termPad(width) * scale, 10);
  }
});

// The bug two photographs caught: 48 columns occupy less than the box they sit in, because the
// emulator's fit holds back a scrollbar gutter it never draws. A snapshot that fits the columns
// to the whole box instead spends that gutter on type, ~6% large — a step in size at the
// crossfade, on top of any step in position.
test('a snapshot draws the emulator cell through the zoom, not the box divided by columns', () => {
  const cell = { w: 7.79, h: 18 }; // measured on device at 13pt
  const scale = 0.43;
  const box = 200; // roomier than 48 of those cells need — the gutter the emulator held back
  const type = snapshotType(cell, scale, 48, box);
  expect(type.fontSize * 0.6).toBeCloseTo(cell.w * scale, 1); // advance matches the live one
  expect(type.lineHeight).toBeCloseTo(cell.h * scale, 6);
  expect(48 * type.fontSize * 0.6).toBeLessThan(box); // and leaves the same slack the pane does
});

// A page card rides the swipe at 1:1 beside the live pane, so its advance has to BE the pane's,
// not two decimals of it: the leftover multiplies by the column and walks one character off the
// one beside it by the far end of the line.
test('a page-sized snapshot lands on the emulator advance exactly, with nothing left to drift', () => {
  const cell = { w: 382 / 49, h: 18 }; // 49 columns in the 382pt screen the emulator reports
  const type = snapshotType(cell, 1, 49, 393);
  expect(type.fontSize * MONO_ADVANCE).toBe(cell.w);
  expect(49 * type.fontSize * MONO_ADVANCE).toBeCloseTo(382, 10); // no drift by the last column
});

test('a pane too wide for its card is capped by the columns, both metrics together', () => {
  const cell = { w: 8, h: 18 };
  const type = snapshotType(cell, 1, 100, 200); // 100 cells want 800, the box has 200
  expect(100 * type.fontSize * 0.6).toBeLessThanOrEqual(200);
  expect(type.lineHeight).toBeCloseTo(18 * 0.25, 6); // shrunk by the same quarter, not left tall
});

test('with no cell measured yet a snapshot still fits its columns', () => {
  const type = snapshotType({ w: 0, h: 0 }, 0.43, 48, 168);
  expect(type.fontSize).toBeCloseTo(snapshotFontSize(168, 48));
  expect(type.lineHeight).toBeGreaterThan(type.fontSize);
});

// The bug this guards was invisible in every test that checked a NUMBER: the alpha was in range
// the whole time. It only bit once the number became a string (device log, 2026-08-31).
test('the lift shadow never formats its alpha in exponent notation', () => {
  // Walk the spring's whole travel, including the underdamped tails past both ends.
  for (let lift = -0.2; lift <= 1.2; lift += 0.0005) {
    expect(liftShadow(lift)).not.toContain('e');
  }
  // The asymptotic settle itself: the magnitudes a raw template literal stringifies as `2.2e-7`.
  for (const tiny of [1e-7, 2.258614332007739e-7, -4.1028264514955913e-7, 1e-12, -0]) {
    expect(liftShadow(tiny)).toBe('0 18px 30px rgba(0,0,0,0.000)');
  }
});

test('the lift shadow keeps the alpha in range across the spring, ends included', () => {
  for (const lift of [-0.2, 0, 0.5, 1, 1.13, 1.2]) {
    const alpha = Number(liftShadow(lift).match(/rgba\(0,0,0,([-\d.]+)\)/)![1]);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThanOrEqual(1);
  }
  expect(liftShadow(1)).toBe('0 18px 30px rgba(0,0,0,0.550)'); // the resting lift, unchanged
});
