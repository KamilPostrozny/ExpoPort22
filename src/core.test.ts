/** `bun test` — the one check behind T1's two pieces of real logic: the ANSI ramp's flavour
 *  inversion, and the settings decoder's tolerance. Neither needs a device to be wrong. */

/// <reference types="bun" />
import { expect, mock, test } from 'bun:test';

// The store's only native dependency, stubbed so the pure functions are importable off-device.
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));

const { THEMES, resolveTheme } = await import('@/theme');
const { DEFAULTS, clampFontSize, decode, endpoint, validate } = await import('@/settings');

test('ANSI black and white swap ends between a light and a dark flavour', () => {
  const mocha = THEMES.mocha;
  const latte = THEMES.latte;
  expect(mocha.ansi[0]).toBe(mocha.palette.surface1); // dark: black is the light-ward step
  expect(mocha.ansi[7]).toBe(mocha.palette.subtext1);
  expect(latte.ansi[0]).toBe(latte.palette.subtext1); // light: and the other way round
  expect(latte.ansi[7]).toBe(latte.palette.surface2);
  expect(mocha.ansi).toHaveLength(16);
});

test('border and placeholder step up on a light flavour only', () => {
  expect(THEMES.mocha.border).toBe(THEMES.mocha.palette.overlay0);
  expect(THEMES.latte.border).toBe(THEMES.latte.palette.overlay1);
  expect(THEMES.mocha.placeholder).toBe(THEMES.mocha.palette.overlay1);
  expect(THEMES.latte.placeholder).toBe(THEMES.latte.palette.overlay2);
});

test('auto follows the system, an explicit flavour does not', () => {
  expect(resolveTheme('auto', true).name).toBe('mocha');
  expect(resolveTheme('auto', false).name).toBe('latte');
  expect(resolveTheme('frappe', false).name).toBe('frappe');
});

test('a theme flip notifies the host with the right DECSET 2031 code', () => {
  expect(THEMES.mocha.colorSchemeNotification).toBe('\x1b[?997;1n');
  expect(THEMES.latte.colorSchemeNotification).toBe('\x1b[?997;2n');
});

test('decode fills gaps, rejects wrong types, and drops unknown keys', () => {
  expect(decode({})).toEqual(DEFAULTS);
  expect(decode(null)).toEqual(DEFAULTS);
  expect(decode({ port: '2222', theme: 'chartreuse', configureTmux: 'yes' })).toEqual(DEFAULTS);
  expect(decode({ host: 'box', keyRow: ['gone'] })).toEqual({ ...DEFAULTS, host: 'box' });
  expect(decode({ theme: 'frappe', fontSize: 99 })).toEqual({
    ...DEFAULTS,
    theme: 'frappe',
    fontSize: 32,
  });
});

test('font size clamps to the stepper range', () => {
  expect(clampFontSize(2)).toBe(8);
  expect(clampFontSize(400)).toBe(32);
  expect(clampFontSize(13.4)).toBe(13);
});

test('validation says what is wrong in plain English', () => {
  const ok = { ...DEFAULTS, host: 'box.lan', username: 'kamil' };
  expect(validate(ok)).toBeNull();
  expect(validate({ ...ok, host: '   ' })).toBe('Host cannot be empty.');
  expect(validate({ ...ok, port: 0 })).toBe('Port must be between 1 and 65535.');
  expect(validate({ ...ok, port: 70000 })).toBe('Port must be between 1 and 65535.');
  expect(validate({ ...ok, username: 'two words' })).toBe(
    'Username cannot be empty or contain spaces.'
  );
  expect(endpoint(ok)).toBe('box.lan:22');
});
