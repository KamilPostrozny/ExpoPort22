/**
 * Catppuccin, as plain data. The 26 colours and the light/dark flag come straight from
 * `@catppuccin/palette` — the upstream package, not a copy of it. The derivations below are ours:
 * the ANSI mapping follows catppuccin/alacritty, and the chrome roles follow the design files.
 *
 * A flavour is its 26 official colours and nothing else. The 16 ANSI slots, the terminal's four
 * colours and every chrome role are computed from them, which is what makes a fifth flavour zero
 * lines of hex and no decisions.
 *
 * The 26 are reachable as `theme.palette` only so the flavour picker can show the palette itself.
 * Everything else asks for a colour by the job it does — `panel`, `scrim`, `border` — so a view
 * never has to know that a scrim is `crust`.
 *
 * The package also ships an `ansiColors` set (the official Catppuccin ANSI spec, with bright slots
 * on their own hues). It is deliberately not used: this app follows the alacritty mapping, where
 * bright repeats the normal hue and only the grey ramp steps, which is what the reference app's
 * terminal was tuned against.
 */

import { flavorEntries, flavors } from '@catppuccin/palette';

export type FlavourName = keyof typeof flavors;
export type ThemeChoice = 'auto' | FlavourName;
export type Palette = Record<keyof (typeof flavors)['mocha']['colors'], string>;

export const FLAVOURS = flavorEntries.map(([name]) => name);
export const THEME_CHOICES: ThemeChoice[] = ['auto', ...FLAVOURS];

const PALETTES = Object.fromEntries(
  flavorEntries.map(([name, flavour]) => [
    name,
    Object.fromEntries(flavour.colorEntries.map(([colour, { hex }]) => [colour, hex])),
  ]),
) as Record<FlavourName, Palette>;

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

function derive(name: FlavourName): Theme {
  const p = PALETTES[name];
  const isDark = flavors[name].dark;
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

export const THEMES = Object.fromEntries(
  FLAVOURS.map((name) => [name, derive(name)]),
) as Record<FlavourName, Theme>;

export function resolveTheme(choice: ThemeChoice, systemIsDark: boolean): Theme {
  return choice === 'auto' ? (systemIsDark ? THEMES.mocha : THEMES.latte) : THEMES[choice];
}

/** Bundled JetBrains Mono Nerd Font, loaded in `app/_layout.tsx`. The terminal grid and every
 *  monospaced readout (public key, remote paths) use these; chrome text uses the system font. */
export const MONO = 'JetBrainsMono';
export const MONO_BOLD = 'JetBrainsMono-Bold';
