import { expect, test } from 'bun:test';

import { keyboardOverlap } from './keyboard-model';

test('keyboard overlap reserves the safe strip exactly once on both platforms', () => {
  expect(keyboardOverlap(336.4, 24) + 24).toBe(336.4);
  expect(keyboardOverlap(320, 34) + 34).toBe(320);
});

test('hidden, floating and hardware keyboards never make negative padding', () => {
  expect(keyboardOverlap(0, 34)).toBe(0);
  expect(keyboardOverlap(20, 34)).toBe(0);
  expect(keyboardOverlap(312, 0)).toBe(312);
});

test('animation positions are continuous above the safe strip and reversible', () => {
  const frames = [0, 20, 34, 45, 110, 250, 320];
  const up = frames.map((height) => keyboardOverlap(height, 34));
  expect(up).toEqual([0, 0, 0, 11, 76, 216, 286]);
  expect(frames.toReversed().map((height) => keyboardOverlap(height, 34))).toEqual(up.toReversed());
});
