/** `bun test` — the checks behind the pieces of real logic that do not need a device to be wrong:
 *  the ANSI ramp's flavour inversion, the settings decoder's tolerance, and the two terminal
 *  sequences the app answers itself. */

/// <reference types="bun" />
import { expect, mock, test } from 'bun:test';

// The store's only native dependency, stubbed so the pure functions are importable off-device.
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));

mock.module('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'stub',
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

const { THEMES, resolveTheme } = await import('@/theme');
const { DEFAULTS, clampFontSize, decode, endpoint, startupLine, usesTmux, validate } =
  await import('@/settings');
const { isHttpLink, parseOsc52 } = await import('@/terminal-protocol');
const { hostKeyVerdict } = await import('@/host-keys');

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

test('a startup command written by an older build still runs, as the custom mode', () => {
  const migrated = decode({ host: 'box', startupCommand: 'tmux attach' });
  expect(migrated.startMode).toBe('custom');
  expect(startupLine(migrated)).toBe('tmux attach');
  // A stored blob with no line at all takes the new default rather than a silent plain shell.
  expect(decode({ host: 'box' }).startMode).toBe('session');
});

test('each start mode is one line the host shells all parse the same way', () => {
  const s = { ...DEFAULTS };
  expect(startupLine({ ...s, startMode: 'shell' })).toBeNull();
  expect(startupLine({ ...s, startMode: 'session' })).toBe('tmux new-session -A -D -s port22');
  // Nothing picked yet: the most recent, and the same session the other mode makes if there is none.
  expect(startupLine({ ...s, startMode: 'attach' })).toBe(
    'tmux attach -d 2>/dev/null || tmux new-session -A -D -s port22',
  );
  expect(startupLine({ ...s, startMode: 'attach', attachSession: 'work' })).toBe(
    "tmux attach -d -t 'work' 2>/dev/null || tmux new-session -A -D -s port22",
  );
  // The name came off the host, so it is the host's to be strange: it is quoted, never trusted.
  expect(startupLine({ ...s, startMode: 'attach', attachSession: "a'; rm -rf ~ #" })).toBe(
    "tmux attach -d -t 'a'\\''; rm -rf ~ #' 2>/dev/null || tmux new-session -A -D -s port22",
  );
  // Custom is the user's line verbatim, and an empty one is not a line.
  expect(startupLine({ ...s, startMode: 'custom', startupCommand: 'byobu' })).toBe('byobu');
  expect(startupLine({ ...s, startMode: 'custom', startupCommand: '  ' })).toBeNull();
});

test('the conf is pushed for a tmux mode, and for a custom line that starts one', () => {
  const s = { ...DEFAULTS };
  expect(usesTmux({ ...s, startMode: 'session' })).toBe(true);
  expect(usesTmux({ ...s, startMode: 'attach' })).toBe(true);
  expect(usesTmux({ ...s, startMode: 'shell' })).toBe(false);
  expect(usesTmux({ ...s, startMode: 'custom', startupCommand: 'tmux attach -t work' })).toBe(true);
  expect(usesTmux({ ...s, startMode: 'custom', startupCommand: 'ssh jump' })).toBe(false);
  expect(usesTmux({ ...s, startMode: 'custom', startupCommand: 'tmuxinator start x' })).toBe(false);
});

test('font size clamps to the stepper range', () => {
  expect(clampFontSize(2)).toBe(8);
  expect(clampFontSize(400)).toBe(32);
  expect(clampFontSize(13.4)).toBe(13);
});

test('an OSC 52 yank comes back as text, a read comes back as nothing', () => {
  expect(parseOsc52('c;aGVsbG8=')).toBe('hello');
  expect(parseOsc52('p;aGVsbG8=')).toBe('hello'); // any selection target, same clipboard
  expect(parseOsc52('c;JC1Dw6nCoQ==')).toBe('$-Cé¡'); // multi-byte UTF-8 survives the round trip
  expect(parseOsc52('c;?')).toBeNull(); // a read: never answered (§4.7)
  expect(parseOsc52('c;')).toBeNull();
  expect(parseOsc52('nonsense')).toBeNull();
});

test('only http(s) links are offered to the browser', () => {
  expect(isHttpLink('https://expo.dev')).toBe(true);
  expect(isHttpLink('HTTP://expo.dev')).toBe(true);
  expect(isHttpLink('javascript:alert(1)')).toBe(false);
  expect(isHttpLink('file:///etc/passwd')).toBe(false);
  expect(isHttpLink('not a url at all')).toBe(false);
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

test('a pinned host key is trusted, an unpinned one asked about, a changed one refused', () => {
  expect(hostKeyVerdict(null, 'AAAAC3Nz')).toBe('ask'); // first contact
  expect(hostKeyVerdict('AAAAC3Nz', 'AAAAC3Nz')).toBe('trust');
  // The one that matters: a different key is never a prompt (§4.1), because a prompt is what an
  // attacker in the middle needs the user to tap through.
  expect(hostKeyVerdict('AAAAC3Nz', 'AAAAC3Nx')).toBe('mismatch');
});
