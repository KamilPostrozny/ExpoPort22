/** `bun test` — the checks behind the pieces of real logic that do not need a device to be wrong:
 *  the ANSI ramp's flavour inversion, the settings decoder's tolerance, and the two terminal
 *  sequences the app answers itself. */

/// <reference types="bun" />
import { expect, mock, test } from 'bun:test';

// The store's only native dependency, stubbed so the pure functions are importable off-device.
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));

// T17's host ids. Sequential rather than random so a failure names the host it means. `mock.module`
// is process-wide and the last registration wins, so this stub carries `getRandomBytes` too —
// without it, whichever file runs after this one gets a key module that cannot make a key.
let uuids = 0;
mock.module('expo-crypto', () => ({
  randomUUID: () => `id-${++uuids}`,
  getRandomBytes: () => new Uint8Array(32),
}));

mock.module('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'stub',
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));

const { flavors } = await import('@catppuccin/palette');
const { DARK_THEMES, LIGHT_THEMES, THEMES, resolveTheme } = await import('@/theme');
const { SCHEMES } = await import('@/themes-generated');
const {
  DEFAULTS,
  HOST_DEFAULTS,
  clampFontSize,
  decode,
  decodeHost,
  endpoint,
  startupLine,
  themeNameFor,
  usesTmux,
  validate,
} = await import('@/settings');

const { isHttpLink, parseOsc52 } = await import('@/terminal-protocol');
const { hostKeyVerdict } = await import('@/host-keys');

/** The per-host half, with an id the tests can ignore — every function under test takes one of
 *  these and none of them reads the id. */
const aHost = () => decodeHost({});

const cat = (flavour: 'mocha' | 'latte', colour: string) =>
  (flavors[flavour].colors as Record<string, { hex: string }>)[colour].hex;

test('ANSI black and white swap ends between a light and a dark flavour', () => {
  expect(THEMES.mocha.ansi[0]).toBe(cat('mocha', 'surface1')); // dark: black is the light-ward step
  expect(THEMES.mocha.ansi[7]).toBe(cat('mocha', 'subtext1'));
  expect(THEMES.latte.ansi[0]).toBe(cat('latte', 'subtext1')); // light: and the other way round
  expect(THEMES.latte.ansi[7]).toBe(cat('latte', 'surface2'));
});

test('border and placeholder step up on a light flavour only', () => {
  expect(THEMES.mocha.border).toBe(cat('mocha', 'overlay0'));
  expect(THEMES.latte.border).toBe(cat('latte', 'overlay1'));
  expect(THEMES.mocha.placeholder).toBe(cat('mocha', 'overlay1'));
  expect(THEMES.latte.placeholder).toBe(cat('latte', 'overlay2'));
});

test('every installed theme is a complete one', () => {
  expect(DARK_THEMES.length).toBeGreaterThan(LIGHT_THEMES.length); // not every scheme has both cuts
  for (const t of [...DARK_THEMES, ...LIGHT_THEMES]) {
    expect(t.ansi).toHaveLength(16);
    // A missing role reaches the screen as a transparent view, which reads as "the terminal shows
    // through the sheet" rather than as an error — so the shape is checked, not eyeballed.
    for (const [role, value] of Object.entries(t)) {
      if (role === 'ansi' || role === 'dots') continue;
      expect(typeof value).not.toBe('undefined');
    }
    for (const dot of Object.values(t.dots)) expect(dot).toMatch(/^#[0-9a-f]{6}$/i);
    // Not a grey. This is what pins the chrome roles to the normal ANSI half: Solarized keeps its
    // base tones in the bright half, so reading `accent` out of slot 12 there gives #839496 and
    // `warning` out of slot 11 gives a blue-grey — a grey confirm button and a grey warning.
    for (const role of [t.accent, t.accentAlternate, t.danger, t.warning, t.dots.green]) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(role.slice(i, i + 2), 16));
      expect((Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b)).toBeGreaterThan(0.14);
    }
    expect(t.colorSchemeNotification).toBe(t.isDark ? '\x1b[?997;1n' : '\x1b[?997;2n');
  }
});

test('no theme is quieter than the family it is matched to', () => {
  const chan = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (hex: string) =>
    chan(hex)
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const cr = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const L = (hex: string) => {
    const y = lum(hex);
    return y <= 216 / 24389 ? (y * 24389) / 27 : Math.cbrt(y) * 116 - 16;
  };
  const mix = (a: string, b: string, t: number) =>
    '#' +
    chan(a)
      .map((v, i) => Math.round(v + (chan(b)[i] - v) * t))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');

  // The floors in theme.ts are the minimum the four Catppuccin flavours already hit, so a generated
  // scheme is checked against the tuned family rather than against WCAG — which Catppuccin itself
  // does not meet (Latte's `overlay0` hairline is 2.30:1). The four flavours are excluded here
  // because they are not floored at all: they come off the style guide's named steps, and the test
  // above pins them to those steps by name. Flooring them would mean overruling the guide.
  const CATPPUCCIN = new Set(['latte', 'frappe', 'macchiato', 'mocha']);
  const published = new Map(SCHEMES.map((s) => [s.name, s]));
  for (const t of [...DARK_THEMES, ...LIGHT_THEMES].filter((t) => !CATPPUCCIN.has(t.name))) {
    const why = (role: string) => `${t.name}: ${role}`;
    // A floor only governs a colour we derived. Where the author published one it is used as-is even
    // when it is dimmer than the floor — Dracula's spec names Current Line for borders, and that is
    // 1.56:1 on its own background. Overruling it would be the same mistake in the other direction.
    const derived = (role: keyof (typeof SCHEMES)[number]) => !published.get(t.name)?.[role];
    if (derived('muted')) {
      // Bounded by what the ramp can actually reach — a tenth short of the scheme's own foreground.
      // Both Solarized cuts run 4.13:1 and 4.75:1 foreground-on-background, so secondary text there
      // cannot clear 4.4 however it is derived. Everything else is held to the floor proper.
      const ceiling = cr(mix(t.background, t.foreground, 0.9), t.background);
      expect(cr(t.muted, t.background), why('muted')).toBeGreaterThanOrEqual(
        Math.min(4.3, ceiling - 0.01),
      );
      expect(t.muted, why('muted vs foreground')).not.toBe(t.foreground);
    }
    if (derived('placeholder')) {
      expect(cr(t.placeholder, t.background), why('placeholder')).toBeGreaterThanOrEqual(2.75);
    }
    if (derived('border')) {
      expect(cr(t.border, t.background), why('border')).toBeGreaterThanOrEqual(2.25);
    }
    expect(cr(t.dots.grey, t.background), why('grey dot')).toBeGreaterThanOrEqual(2.9);

    // A sheet has to read as a sheet on a near-black background too — a ratio of the remaining
    // distance to black moves ~1 L* on #0d1117, which is invisible.
    expect(Math.abs(L(t.panel) - L(t.background)), why('panel step')).toBeGreaterThan(2.5);
    expect(Math.abs(L(t.scrim) - L(t.panel)), why('scrim behind panel')).toBeGreaterThan(2.5);

    // Two roles that mean different things may not be the same colour: the ribbon draws a peach
    // handle next to a red failure, and an armed modifier next to a locked one.
    expect(t.dots.peach, why('peach vs danger')).not.toBe(t.danger);
    expect(t.accent, why('accent vs alternate')).not.toBe(t.accentAlternate);

    // Bright white that *is* the background is not white at all: solarized-light shipped ansi[15] at
    // 1.00:1 and everforest-light at 1.06:1 before those slots came from upstream rather than from a
    // TextMate theme. This is a "distinguishable from the ground" check and nothing more — on a light
    // scheme SGR 97 is legitimately the palest thing there is, and Latte's own is only 1.4:1.
    expect(cr(t.ansi[15], t.background), why('ansi bright white')).toBeGreaterThan(1.15);
  }
});

test('an author who publishes the colour outranks our arithmetic', () => {
  // nord.css calls nord8 "the accent color of the color palette", where shiki's ansi[4] is nord9,
  // documented for "keywords, operators, tags".
  expect(THEMES.nord.accent).toBe('#88c0d0');
  // spec.mdx, "Borders and Separators": "Subtle borders: Use Current Line color".
  expect(THEMES.dracula.border).toBe('#44475a');
  // gruvbox.vim branches its accent tier on `s:is_dark`; the neutral tier is only ever slots 1-6.
  expect(THEMES['gruvbox-dark-medium'].accent).toBe('#83a598');
  expect(THEMES['gruvbox-light-medium'].accent).toBe('#076678');
  // ayu's whole identity is its gold, which shiki hands us only as the cursor.
  expect(THEMES['ayu-dark'].accent).toBe('#e6b450');
  // xresources: `*cursorColor: S_base1`. Shiki reports the tmTheme's `string.regexp` red.
  expect(THEMES['solarized-dark'].cursor).toBe('#93a1a1');
  // The published role table names highlightMed for selection.
  expect(THEMES['rose-pine'].selection).toBe('#403d52');
});

test('following the system picks per appearance, ignoring it picks once', () => {
  const s = { ...decode({}), followSystem: true, themeDark: 'nord', themeLight: 'ayu-light' };
  expect(themeNameFor(s, true)).toBe('nord');
  expect(themeNameFor(s, false)).toBe('ayu-light');
  expect(themeNameFor({ ...s, followSystem: false, theme: 'dracula' }, true)).toBe('dracula');
  expect(themeNameFor({ ...s, followSystem: false, theme: 'dracula' }, false)).toBe('dracula');
});

test('an unknown theme name falls back rather than rendering nothing', () => {
  expect(resolveTheme('a-scheme-that-was-removed').name).toBe('mocha');
  expect(resolveTheme('gruvbox-dark-medium').label).toBe('Gruvbox Dark');
});

test('the old single-field theme setting upgrades to the switch', () => {
  expect(decode({ theme: 'auto' }).followSystem).toBe(true);
  expect(decode({ theme: 'auto' }).theme).toBe(DEFAULTS.theme);
  expect(decode({ theme: 'frappe' })).toMatchObject({ followSystem: false, theme: 'frappe' });
  expect(decode({ theme: 'no-such-theme' }).followSystem).toBe(true);
});

test('a theme flip notifies the host with the right DECSET 2031 code', () => {
  expect(THEMES.mocha.colorSchemeNotification).toBe('\x1b[?997;1n');
  expect(THEMES.latte.colorSchemeNotification).toBe('\x1b[?997;2n');
});

/** A decoded blob minus the ids, which are freshly minted and not what these tests are about. */
const shape = (raw: unknown) => {
  const s = decode(raw);
  return { ...s, hosts: s.hosts.map(({ id, ...rest }) => rest) };
};
const globals = { ...DEFAULTS, activeHostId: expect.any(String) };

test('decode fills gaps, rejects wrong types, and drops unknown keys', () => {
  const blank = { ...globals, hosts: [HOST_DEFAULTS] };
  expect(shape({})).toEqual(blank);
  expect(shape(null)).toEqual(blank);
  expect(shape({ port: '2222', theme: 'chartreuse', configureTmux: 'yes' })).toEqual(blank);
  expect(shape({ host: 'box', keyRow: ['gone'] })).toEqual({
    ...globals,
    hosts: [{ ...HOST_DEFAULTS, host: 'box' }],
  });
  expect(shape({ theme: 'frappe', fontSize: 99 })).toEqual({
    ...globals,
    hosts: [HOST_DEFAULTS],
    followSystem: false, // a named theme in the old field is a user who had opted out of auto
    theme: 'frappe',
    fontSize: 32,
  });
});

test('a startup command written by an older build still runs, as the custom mode', () => {
  const migrated = decode({ host: 'box', startupCommand: 'tmux attach' }).hosts[0];
  expect(migrated.startMode).toBe('custom');
  expect(startupLine(migrated)).toBe('tmux attach');
  // A stored blob with no line at all takes the new default rather than a silent plain shell.
  expect(decode({ host: 'box' }).hosts[0].startMode).toBe('session');
});

/**
 * T17's migration, and the one thing about it that can silently lose the user's setup: the storage
 * key did not change, so a blob written by any build before the split has its nine per-host fields
 * at the top level and must come back as one host with every one of them intact.
 */
test('a pre-T17 blob becomes one host, whole, and that host is the active one', () => {
  const old = {
    host: 'box.lan',
    port: 2222,
    username: 'kamil',
    startMode: 'attach',
    attachSession: 'work',
    knownSessions: ['work', 'port22'],
    startupCommand: 'tmux attach -t work',
    lastUploadDir: '/home/kamil/drop',
    // The globals ride along in the same blob and must stay global rather than following the host.
    fontSize: 17,
    followSystem: false,
    theme: 'nord',
    themeDark: 'dracula',
    themeLight: 'latte',
    tmuxExtras: false,
  };
  const s = decode(old);
  expect(s.hosts).toHaveLength(1);
  const [host] = s.hosts;
  expect(host).toEqual({
    id: host.id,
    host: 'box.lan',
    port: 2222,
    username: 'kamil',
    startMode: 'attach',
    attachSession: 'work',
    knownSessions: ['work', 'port22'],
    startupCommand: 'tmux attach -t work',
    lastUploadDir: '/home/kamil/drop',
  });
  // A real id, and the one `getHost` will find — an install that upgrades and cannot point at its
  // own host is the same failure as losing it.
  expect(host.id).not.toBe('');
  expect(s.activeHostId).toBe(host.id);
  // The app's half stayed the app's.
  expect(s).toMatchObject({
    fontSize: 17,
    followSystem: false,
    theme: 'nord',
    themeDark: 'dracula',
    themeLight: 'latte',
    tmuxExtras: false,
  });
  // Nothing of the host leaked back up into the globals.
  expect(s).not.toHaveProperty('host');
  expect(s).not.toHaveProperty('lastUploadDir');
  // And the round trip is stable: re-decoding what we would write keeps the same id, so the pin
  // and the upload directory stay attached to the same row across a restart.
  const again = decode(JSON.parse(JSON.stringify(s)));
  expect(again).toEqual(s);
});

test('a multi-host blob keeps its order, its ids and its pick', () => {
  const s = decode({
    hosts: [
      { id: 'a', host: 'one.lan', startMode: 'shell' },
      { id: 'b', host: 'two.lan', lastUploadDir: '/srv' },
    ],
    activeHostId: 'b',
  });
  expect(s.hosts.map((h) => h.id)).toEqual(['a', 'b']);
  expect(s.hosts[1].lastUploadDir).toBe('/srv');
  expect(s.activeHostId).toBe('b');
  // A pick at a host that is not there would leave Setup editing a row it never highlights.
  expect(decode({ hosts: [{ id: 'a' }], activeHostId: 'gone' }).activeHostId).toBe('a');
  // An empty list is not a state the app has: Setup would need an empty version of itself.
  expect(decode({ hosts: [] }).hosts).toHaveLength(1);
});

/** T15. Off by default — an app that wants a face before it has ever reached a host is not the
 *  first run anyone wants — and global rather than per-host, so it does not ride in `hosts[0]`. */
test('the auth gate is off until it is asked for, and it is the app’s answer, not a host’s', () => {
  expect(decode({}).requireAuth).toBe(false);
  expect(decode({ requireAuth: true }).requireAuth).toBe(true);
  expect(decode({ requireAuth: 'yes' }).requireAuth).toBe(false); // junk takes the default
  expect(decode({ requireAuth: true }).hosts[0]).not.toHaveProperty('requireAuth');
});

test('each start mode is one line the host shells all parse the same way', () => {
  const s = aHost();
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
  const s = aHost();
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
  const ok = { ...aHost(), host: 'box.lan', username: 'kamil' };
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
