/**
 * Catppuccin, as plain data. Ported from the reference app's `Port22Core/Theme.swift`, which is the
 * source of truth for every derivation in here — palette values come from catppuccin/palette, the
 * ANSI mapping from catppuccin/alacritty.
 *
 * A flavour is its 26 official colours and nothing else. The 16 ANSI slots, the terminal's four
 * colours and every chrome role are computed from them, which is what makes a fifth flavour 26
 * lines of hex and no decisions.
 *
 * The 26 are reachable as `theme.palette` only so the flavour picker can show the palette itself.
 * Everything else asks for a colour by the job it does — `panel`, `scrim`, `border` — so a view
 * never has to know that a scrim is `crust`.
 */

export type FlavourName = 'latte' | 'frappe' | 'macchiato' | 'mocha';
export type ThemeChoice = 'auto' | FlavourName;

export const FLAVOURS: FlavourName[] = ['latte', 'frappe', 'macchiato', 'mocha'];
export const THEME_CHOICES: ThemeChoice[] = ['auto', ...FLAVOURS];

export type Palette = {
  rosewater: string;
  flamingo: string;
  pink: string;
  mauve: string;
  red: string;
  maroon: string;
  peach: string;
  yellow: string;
  green: string;
  teal: string;
  sky: string;
  sapphire: string;
  blue: string;
  lavender: string;
  text: string;
  subtext1: string;
  subtext0: string;
  overlay2: string;
  overlay1: string;
  overlay0: string;
  surface2: string;
  surface1: string;
  surface0: string;
  base: string;
  mantle: string;
  crust: string;
};

const PALETTES: Record<FlavourName, Palette> = {
  latte: {
    rosewater: '#dc8a78', flamingo: '#dd7878', pink: '#ea76cb', mauve: '#8839ef',
    red: '#d20f39', maroon: '#e64553', peach: '#fe640b',
    yellow: '#df8e1d', green: '#40a02b', teal: '#179299', sky: '#04a5e5',
    sapphire: '#209fb5', blue: '#1e66f5', lavender: '#7287fd',
    text: '#4c4f69', subtext1: '#5c5f77', subtext0: '#6c6f85',
    overlay2: '#7c7f93', overlay1: '#8c8fa1', overlay0: '#9ca0b0',
    surface2: '#acb0be', surface1: '#bcc0cc', surface0: '#ccd0da',
    base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8',
  },
  frappe: {
    rosewater: '#f2d5cf', flamingo: '#eebebe', pink: '#f4b8e4', mauve: '#ca9ee6',
    red: '#e78284', maroon: '#ea999c', peach: '#ef9f76',
    yellow: '#e5c890', green: '#a6d189', teal: '#81c8be', sky: '#99d1db',
    sapphire: '#85c1dc', blue: '#8caaee', lavender: '#babbf1',
    text: '#c6d0f5', subtext1: '#b5bfe2', subtext0: '#a5adce',
    overlay2: '#949cbb', overlay1: '#838ba7', overlay0: '#737994',
    surface2: '#626880', surface1: '#51576d', surface0: '#414559',
    base: '#303446', mantle: '#292c3c', crust: '#232634',
  },
  macchiato: {
    rosewater: '#f4dbd6', flamingo: '#f0c6c6', pink: '#f5bde6', mauve: '#c6a0f6',
    red: '#ed8796', maroon: '#ee99a0', peach: '#f5a97f',
    yellow: '#eed49f', green: '#a6da95', teal: '#8bd5ca', sky: '#91d7e3',
    sapphire: '#7dc4e4', blue: '#8aadf4', lavender: '#b7bdf8',
    text: '#cad3f5', subtext1: '#b8c0e0', subtext0: '#a5adcb',
    overlay2: '#939ab7', overlay1: '#8087a2', overlay0: '#6e738d',
    surface2: '#5b6078', surface1: '#494d64', surface0: '#363a4f',
    base: '#24273a', mantle: '#1e2030', crust: '#181926',
  },
  mocha: {
    rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7',
    red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387',
    yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb',
    sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe',
    text: '#cdd6f4', subtext1: '#bac2de', subtext0: '#a6adc8',
    overlay2: '#9399b2', overlay1: '#7f849c', overlay0: '#6c7086',
    surface2: '#585b70', surface1: '#45475a', surface0: '#313244',
    base: '#1e1e2e', mantle: '#181825', crust: '#11111b',
  },
};

export type Theme = {
  name: FlavourName;
  isDark: boolean;
  palette: Palette;

  /* --- what the terminal itself paints with --- */
  /** `rosewater` is the cursor: the one accent tuned to sit on its own background without also
   *  meaning a state — a blue cursor is indistinguishable from an armed modifier at a glance. */
  background: string;
  foreground: string;
  cursor: string;
  /** A raised background layer rather than a tint, so glyphs inside a highlighted run stay
   *  `foreground` and stay legible on all four flavours. */
  selection: string;
  /** The 16 ANSI slots. Six hues repeat between the normal and bright set; the grey ramp is built
   *  from the two text steps and the two surface steps. Which end of the ramp is "black" inverts
   *  with the flavour, and that inversion is the whole reason Latte is usable. */
  ansi: string[];

  /* --- chrome roles: a colour by the job it does, never by slot index --- */
  /** Selection rings, tints, the confirm button, an armed modifier: "this one". */
  accent: string;
  /** A second accent tellable from `accent` across one capsule — Ctrl locked vs Ctrl armed. */
  accentAlternate: string;
  /** Secondary text. `subtext0` in every flavour, deliberately not the grey ramp's dim step: on a
   *  dark flavour `surface2` lands at 1.7:1 against the row it is drawn on. */
  muted: string;
  /** It failed, and a retry will not fix it. */
  danger: string;
  /** It failed, and a retry might. */
  warning: string;
  /** A control that is filled rather than drawn: a form row's card, a stepper pill, a toggle track.
   *  Identical to `selection` by construction — one is chrome, the other is inside the grid. */
  surface: string;
  /** The field a group of rows floats on. `mantle` sits behind `base`, so a sheet over a terminal
   *  painted in `background` still reads as a sheet rather than as more terminal. */
  panel: string;
  /** The backmost field, behind even `panel`. `crust` is the darkest layer in every flavour, Latte
   *  included — which is why this is a role and not black-at-30%, a grey no palette contains. */
  scrim: string;
  /** A hairline at rest. Latte steps up because its layer stack runs the other way round: a
   *  hairline chosen against `base` is in practice drawn on something darker than `base`. */
  border: string;
  /** Text that is not the user's yet: a ghost prompt, a label on a button that cannot be tapped.
   *  One step up from `border` — drawing it in `muted` makes an empty field look filled in. */
  placeholder: string;
  /** The label on top of a filled `accent`. The background colour on purpose: contrast is
   *  symmetric, so `base` on `accent` inherits the guarantee that `accent` is legible on `base`. */
  onAccent: string;

  /** What the terminal pushes at the host on a mid-session theme switch. DECSET 2031 subscribers
   *  (fish 4) treat it as "re-query the background"; anyone else parses and drops it. */
  colorSchemeNotification: string;
};

function derive(name: FlavourName, isDark: boolean): Theme {
  const p = PALETTES[name];
  const black = isDark ? p.surface1 : p.subtext1;
  const white = isDark ? p.subtext1 : p.surface2;
  const brightBlack = isDark ? p.surface2 : p.subtext0;
  const brightWhite = isDark ? p.subtext0 : p.surface1;
  return {
    name,
    isDark,
    palette: p,

    background: p.base,
    foreground: p.text,
    cursor: p.rosewater,
    selection: p.surface0,
    ansi: [
      black, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, white,
      brightBlack, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, brightWhite,
    ],

    accent: p.blue,
    accentAlternate: p.pink,
    muted: p.subtext0,
    danger: p.red,
    warning: p.yellow,
    surface: p.surface0,
    panel: p.mantle,
    scrim: p.crust,
    border: isDark ? p.overlay0 : p.overlay1,
    placeholder: isDark ? p.overlay1 : p.overlay2,
    onAccent: p.base,

    colorSchemeNotification: `\x1b[?997;${isDark ? 1 : 2}n`,
  };
}

export const THEMES: Record<FlavourName, Theme> = {
  latte: derive('latte', false),
  frappe: derive('frappe', true),
  macchiato: derive('macchiato', true),
  mocha: derive('mocha', true),
};

export function resolveTheme(choice: ThemeChoice, systemIsDark: boolean): Theme {
  return choice === 'auto' ? (systemIsDark ? THEMES.mocha : THEMES.latte) : THEMES[choice];
}

/** Bundled JetBrains Mono Nerd Font, loaded in `app/_layout.tsx`. The terminal grid and every
 *  monospaced readout (public key, remote paths) use these; chrome text uses the system font. */
export const MONO = 'JetBrainsMono';
export const MONO_BOLD = 'JetBrainsMono-Bold';
