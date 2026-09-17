import { describe, expect, test } from 'bun:test';

import { DEL } from '@/keybar-model';
import {
  RAW_HOLD_CAP_MS,
  RAW_HOLD_DELAY_MS,
  rawHoldBeat,
  rawHoldByte,
  rawHoldInit,
  rawHoldPress,
  rawHoldReady,
  rawHoldRelease,
} from '@/raw-hold-model';

describe('raw-hold-model', () => {
  test('a press sends exactly one byte and arms the hold', () => {
    const press = rawHoldPress(rawHoldInit(), 'Backspace', 1000);
    expect(press.send).toBe(true);
    expect(press.arm).toBe(true);
    expect(press.state).toEqual({ key: 'Backspace', since: 1000, looping: false });
  });

  test('a repeat of the held key sends a byte but does not re-arm', () => {
    const first = rawHoldPress(rawHoldInit(), 'Backspace', 1000).state;
    const repeat = rawHoldPress(first, 'Backspace', 1600);
    expect(repeat.send).toBe(true);
    expect(repeat.arm).toBe(false);
    expect(repeat.state.since).toBe(1000); // the cap still measures the whole hold
  });

  test('a different key is a fresh hold: the old one does not survive the press', () => {
    const first = rawHoldPress(rawHoldInit(), 'Backspace', 1000).state;
    const other = rawHoldPress(first, 'Delete', 2000);
    expect(other.state.key).toBe('Delete');
    expect(other.state.since).toBe(2000);
    expect(other.arm).toBe(true);
  });

  test('the delay fires only for the same, still-held key', () => {
    const held = rawHoldPress(rawHoldInit(), 'Backspace', 0).state;
    expect(rawHoldReady(held, 'Backspace', RAW_HOLD_DELAY_MS - 1)).toBe(false);
    expect(rawHoldReady(held, 'Backspace', RAW_HOLD_DELAY_MS)).toBe(true);
    // Released in the meantime: the waking timer finds no hold to take over.
    expect(rawHoldReady(rawHoldRelease(held), 'Backspace', RAW_HOLD_DELAY_MS)).toBe(false);
    // The hold became a different key: the old timer is stale.
    const deleted = rawHoldPress(held, 'Delete', 10).state;
    expect(rawHoldReady(deleted, 'Backspace', 5000)).toBe(false);
    expect(rawHoldReady(deleted, 'Delete', 5000)).toBe(true);
  });

  test('the loop beats one byte per tick until the cap, then stops', () => {
    let held = rawHoldPress(rawHoldInit(), 'Backspace', 0).state;
    held = { ...held, looping: true };
    for (let t = RAW_HOLD_DELAY_MS; t < RAW_HOLD_CAP_MS; t += 40) {
      const beat = rawHoldBeat(held, t);
      expect(beat.stop).toBe(false);
      expect(beat.send).toBe(true);
    }
    const cap = rawHoldBeat(held, RAW_HOLD_CAP_MS);
    expect(cap).toEqual({ send: false, stop: true });
  });

  test('a released or never-looping hold beats nothing', () => {
    expect(rawHoldBeat(rawHoldInit(), 999_999)).toEqual({ send: false, stop: false });
    const pressed = rawHoldPress(rawHoldInit(), 'Delete', 0);
    expect(rawHoldBeat(pressed.state, RAW_HOLD_CAP_MS * 2)).toEqual({ send: false, stop: false });
  });

  test('the hold bytes are the mode delete bytes', () => {
    expect(rawHoldByte('Backspace')).toBe(DEL);
    expect(rawHoldByte('Delete')).toBe('\x1b[3~');
  });
});
