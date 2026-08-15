/**
 * Every theme the app can wear, as plain data.
 *
 * Two sources, one shape. Catppuccin comes from `@catppuccin/palette` — its 26 colours and its
 * light/dark flag — because that package hands us named steps (`mantle`, `crust`, `overlay0`) that
 * a terminal palette does not have, and the four flavours were tuned against them. Everything else
 * comes from `@shikijs/themes` by way of `scripts/gen-themes.ts`, which lifts out the background,
 * the foreground, the cursor, the selection and the 16 ANSI slots and leaves the ~28 KB of
 * syntax-token data behind (see that file for what else was looked at and why it did not fit).
 *
 * A scheme is its terminal colours and nothing else. Every chrome role below is computed from
 * them, which is what makes a new scheme one line in the generator and no decisions here.
 *
 * Views ask for a colour by the job it does — `panel`, `scrim`, `border` — never by slot index, so
 * nothing outside this file knows that a Catppuccin scrim is `crust` and a Nord one is arithmetic.
 *
 * The Catppuccin package also ships an `ansiColors` set (the official spec, with bright slots on
 * their own hues). It is deliberately not used: those four flavours follow the alacritty mapping,
 * where bright repeats the normal hue and only the grey ramp steps, which is what the reference
 * app's terminal was tuned against. The generated schemes carry their own authors' 16, as shipped.
 */

import { flavorEntries, flavors } from '@catppuccin/palette';

import { SCHEMES, type SchemeData } from '@/themes-generated';

/** The key of any installed theme — a Catppuccin flavour or a generated scheme. Not a union of
 *  literals: the generated list is data, and a name is validated by looking it up in `THEMES`. */
export type ThemeName = string;

/** One colour per class of process, named after the Catppuccin step the prototype picked. Every
 *  other scheme approximates them out of its own ANSI set. */
export type DotName = 'green' | 'grey' | 'mauve' | 'blue' | 'yellow' | 'peach';

export type Theme = {
  name: ThemeName;
  /** What the picker shows. */
  label: string;
  isDark: boolean;

  /* --- what the terminal itself paints with --- */
  background: string;
  foreground: string;
  cursor: string;
  /** A raised background layer rather than a tint, so glyphs inside a highlighted run stay
   *  `foreground` and stay legible on every scheme. */
  selection: string;
  /** The 16 ANSI slots, as the scheme's own author wrote them. */
  ansi: string[];

  /* --- chrome roles: a colour by the job it does, never by slot index --- */
  /** Selection rings, tints, the confirm button, an armed modifier: "this one". */
  accent: string;
  /** A second accent tellable from `accent` across one capsule — Ctrl locked vs Ctrl armed. */
  accentAlternate: string;
  /** Secondary text. Well clear of the grey ramp's dim step, which on a dark scheme lands near
   *  1.7:1 against the row it is drawn on. */
  muted: string;
  /** It failed, and a retry will not fix it. */
  danger: string;
  /** It failed, and a retry might. */
  warning: string;
  /** A control that is filled rather than drawn: a form row's card, a stepper pill, a toggle track.
   *  Identical to `selection` by construction — one is chrome, the other is inside the grid. */
  surface: string;
  /** The field a group of rows floats on. It sits *behind* the background, so a sheet over a
   *  terminal still reads as a sheet rather than as more terminal. */
  panel: string;
  /** The backmost field, behind even `panel`. Darker than the background on a light scheme too —
   *  which is why this is a role and not black-at-30%, a grey no palette contains. */
  scrim: string;
  /** A hairline at rest. */
  border: string;
  /** Text that is not the user's yet: a ghost prompt, a label on a button that cannot be tapped.
   *  One step up from `border` — drawing it in `muted` makes an empty field look filled in. */
  placeholder: string;
  /** The label on top of a filled `accent`. The background colour on purpose: contrast is
   *  symmetric, so background-on-accent inherits the guarantee that accent-on-background holds. */
  onAccent: string;
  /** The ribbon handle's colour, one per class of process. */
  dots: Record<DotName, string>;

  /** What the terminal pushes at the host on a mid-session theme switch. DECSET 2031 subscribers
   *  (fish 4) treat it as "re-query the background"; anyone else parses and drops it. */
  colorSchemeNotification: string;
};

const notify = (isDark: boolean) => `\x1b[?997;${isDark ? 1 : 2}n`;

/* --- Catppuccin: the four flavours, off their own named steps --- */

type FlavourName = keyof typeof flavors;
type Palette = Record<keyof (typeof flavors)['mocha']['colors'], string>;

const PALETTES = Object.fromEntries(
  flavorEntries.map(([name, flavour]) => [
    name,
    Object.fromEntries(flavour.colorEntries.map(([colour, { hex }]) => [colour, hex])),
  ]),
) as Record<FlavourName, Palette>;

const FLAVOUR_LABELS: Record<FlavourName, string> = {
  latte: 'Latte',
  frappe: 'Frappé',
  macchiato: 'Macchiato',
  mocha: 'Mocha',
};

function fromFlavour(name: FlavourName): Theme {
  const p = PALETTES[name];
  const isDark = flavors[name].dark;
  // Which end of the grey ramp is "black" inverts with the flavour, and that inversion is the
  // whole reason Latte is usable.
  const black = isDark ? p.surface1 : p.subtext1;
  const white = isDark ? p.subtext1 : p.surface2;
  const brightBlack = isDark ? p.surface2 : p.subtext0;
  const brightWhite = isDark ? p.subtext0 : p.surface1;
  return {
    name,
    label: `Catppuccin ${FLAVOUR_LABELS[name]}`,
    isDark,

    background: p.base,
    foreground: p.text,
    // `rosewater` is the one accent tuned to sit on its own background without also meaning a
    // state — a blue cursor is indistinguishable from an armed modifier at a glance.
    cursor: p.rosewater,
    selection: p.surface0,
    ansi: [
      black, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, white,
      brightBlack, p.red, p.green, p.yellow, p.blue, p.pink, p.teal, brightWhite,
    ],

    accent: p.blue,
    accentAlternate: p.pink,
    // `subtext0` deliberately, not the grey ramp's dim step.
    muted: p.subtext0,
    danger: p.red,
    warning: p.yellow,
    surface: p.surface0,
    panel: p.mantle,
    scrim: p.crust,
    // Latte steps up because its layer stack runs the other way round: a hairline chosen against
    // `base` is in practice drawn on something darker than `base`.
    border: isDark ? p.overlay0 : p.overlay1,
    placeholder: isDark ? p.overlay1 : p.overlay2,
    onAccent: p.base,
    dots: {
      green: p.green,
      grey: p.overlay0,
      mauve: p.mauve,
      blue: p.blue,
      yellow: p.yellow,
      peach: p.peach,
    },

    colorSchemeNotification: notify(isDark),
  };
}

/* --- everything else: the chrome roles, computed --- */

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** `t` of the way from `a` to `b`, in sRGB. Blunt on purpose: these are one-step neighbours of a
 *  colour the scheme's author already chose, not a gradient anyone reads across. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return (
    '#' +
    [ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * The ratios come from measuring Catppuccin: `overlay0` sits 45% of the way from `base` to `text`,
 * `overlay1` 55%, `subtext0` 78%, and `mantle`/`crust` are the background pulled toward black by
 * about a fifth and two fifths on a dark flavour, a twentieth and a twelfth on a light one — a
 * light scheme's layers darken as they go back too, which is the part that is easy to get wrong.
 */
function fromScheme(s: SchemeData): Theme {
  const { background: bg, foreground: fg, dark } = s;
  // The normal half, never the bright one. ANSI only pins down what slots 1–6 mean; what a scheme
  // does with 9–14 is its own business, and Solarized spends them on its base greys — so a confirm
  // button read out of "bright blue" is #839496 there, and a warning out of "bright yellow" is a
  // blue-grey. Catppuccin's own four take their chrome from the same half, tuned.
  const [, red, green, yellow, blue, magenta] = s.ansi;
  return {
    name: s.name,
    label: s.label,
    isDark: dark,

    background: bg,
    foreground: fg,
    cursor: s.cursor,
    selection: s.selection,
    ansi: s.ansi,

    accent: blue,
    accentAlternate: magenta,
    muted: mix(bg, fg, 0.78),
    danger: red,
    warning: yellow,
    surface: s.selection,
    panel: mix(bg, '#000000', dark ? 0.2 : 0.04),
    scrim: mix(bg, '#000000', dark ? 0.42 : 0.08),
    border: mix(bg, fg, 0.45),
    placeholder: mix(bg, fg, 0.55),
    onAccent: bg,
    dots: {
      green,
      grey: mix(bg, fg, 0.45),
      mauve: magenta,
      blue,
      yellow,
      // No ANSI slot is orange, and the red one is the closest most schemes get.
      peach: red,
    },

    colorSchemeNotification: notify(dark),
  };
}

/* --- the installed set --- */

const ALL: Theme[] = [
  ...flavorEntries.map(([name]) => fromFlavour(name)),
  ...SCHEMES.map(fromScheme),
];

export const THEMES: Record<ThemeName, Theme> = Object.fromEntries(
  ALL.map((t) => [t.name, t]),
);

/** Catppuccin first — it is the app's own — then the generated schemes in the generator's order.
 *  Not every scheme has both cuts, so the two lists are different lengths on purpose. */
export const DARK_THEMES = ALL.filter((t) => t.isDark);
export const LIGHT_THEMES = ALL.filter((t) => !t.isDark);
/** Dark before light — the picker that shows this one is the "ignore the system" case, where the
 *  two groups are still the useful way to read a list of twenty-six. */
export const ALL_THEMES = [...DARK_THEMES, ...LIGHT_THEMES];

export const DEFAULT_DARK = 'mocha';
export const DEFAULT_LIGHT = 'latte';

export function isThemeName(name: unknown): name is ThemeName {
  return typeof name === 'string' && name in THEMES;
}

export function resolveTheme(name: ThemeName): Theme {
  return THEMES[name] ?? THEMES[DEFAULT_DARK];
}

/** The font names live in `fonts.ts` — a leaf, so the DOM terminal can take them without dragging
 *  the palette into the webview bundle. Re-exported here because this is where they read. */
export { MONO, MONO_BOLD } from '@/fonts';
