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
 * A shiki theme is an *editor* theme, though, and VS Code's key set has nowhere to put "the accent
 * colour" and no opinion about which grey is a hairline. Where a scheme's author publishes a
 * terminal port or a named role table that says otherwise, that document wins: those values ride
 * along on `SchemeData` as optional fields and are applied below in preference to any arithmetic.
 *
 * A scheme is its terminal colours and nothing else. Every chrome role below is computed from
 * them, which is what makes a new scheme one line in the generator and no decisions here.
 *
 * Views ask for a colour by the job it does — `panel`, `scrim`, `border` — never by slot index, so
 * nothing outside this file knows that a Catppuccin scrim is `crust` and a Nord one is arithmetic.
 *
 * The Catppuccin package also ships an `ansiColors` set. It is deliberately not used: the four
 * flavours here follow the official *ports* — bright repeats the normal hue and only the grey ramp
 * steps — which is what the reference app's terminal was tuned against, and which is what
 * catppuccin/kitty and catppuccin/alacritty actually install. The ports and the style guide's own
 * ANSI table disagree about `color7`/`color15` and the brights; the ports win here. Latte's ramp
 * inversion below comes from the guide and from catppuccin/kitty — not from catppuccin/alacritty,
 * whose latte port is the outlier upstream. The generated schemes carry their own authors' 16.
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

/** A theme colour at an alpha — the prototype's `hexA()`. Every caller passes a `#rrggbb` off a
 *  `Theme`, which is why it lives here and not in a view: the views only ever tint these.
 *  Prefer a role outright: alpha over an unknown backdrop is how a light theme ends up with an
 *  invisible hairline. */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const luminance = (hex: string) =>
  channels(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);

/** WCAG 2.1 contrast, which is symmetric — the order of the arguments does not matter. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L*, the perceptual lightness. Used for the layer stack, where what matters is "a visible
 *  step back" rather than a text-contrast ratio — the two disagree badly near black. */
function lightness(hex: string): number {
  const y = luminance(hex);
  return y <= 216 / 24389 ? (y * 24389) / 27 : Math.cbrt(y) * 116 - 16;
}

/** The smallest `mix(from, to, t)` that satisfies `ok`, or `to` if nothing does. `ok` has to be
 *  monotonic in `t`, which both callers below are: contrast and lightness-distance only grow. */
function search(from: string, to: string, ok: (hex: string) => boolean): string {
  if (ok(from)) return from;
  if (!ok(to)) return to;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) / 2;
    if (ok(mix(from, to, m))) hi = m;
    else lo = m;
  }
  return mix(from, to, hi);
}

/**
 * The floors, and where they come from.
 *
 * Every number here is the *minimum* the four Catppuccin flavours already hit, measured rather than
 * chosen — Latte is the binding case for all of them. That is deliberate: this file's promise is one
 * shape from two sources, so a generated scheme should be no quieter than the tuned family, and no
 * louder either. WCAG's 4.5 and 3.0 are not the targets, because Catppuccin does not meet them
 * either (Latte's `overlay0` hairline is 2.30:1 and its yellow is 2.31:1) and a hairline drawn to
 * 3:1 on twenty-two schemes would be visibly heavier than the family it is supposed to match.
 *
 * A floor only ever lifts. A scheme already above one keeps the colour its author chose, and an
 * author's own published value (`SchemeData`'s optional fields) skips the floor entirely — upstream
 * outranks our arithmetic even when upstream is dimmer.
 */
const FLOOR = {
  /** `subtext0` on `base`: 4.37 (latte) … 7.37 (mocha). */
  muted: 4.4,
  /** `overlay1` on `base`: 2.83 … 4.44. */
  placeholder: 2.8,
  /** `overlay0` on `base`: 2.30 … 3.36. */
  border: 2.3,
  /** A filled dot is a graphical object, not a hairline, so it gets the UI floor of its own. */
  dot: 3.0,
  /** `blue` on `base`: 4.34 … 7.79. Carries `onAccent` on top of it, and contrast is symmetric. */
  accent: 4.3,
  /** `red` on `base`: 4.65 … 7.08. */
  danger: 4.5,
};

/** How far back a layer sits, in L*. `mantle` is 2.82–3.68 behind `base` across the four flavours
 *  and `crust` 6.01–6.93, on the light flavour as much as the dark ones. */
const LAYER = { panel: 3.2, scrim: 6.5 };

/** A field `drop` L* behind `bg`. Toward black where there is room and toward the text where there
 *  is not: on GitHub Dark's #0d1117 a fifth of the way to black moves 1.14 L*, and a sheet over the
 *  terminal stops reading as a sheet at all. Three schemes take the second branch. */
const layer = (bg: string, fg: string, drop: number) =>
  search(bg, lightness(bg) >= drop ? '#000000' : fg, (h) => Math.abs(lightness(h) - lightness(bg)) >= drop);

/**
 * `c`, brightened or darkened until it clears `target` against `bg`.
 *
 * Toward white on a dark scheme and black on a light one — never toward the foreground, which is a
 * grey on plenty of schemes: Solarized's is #839496, and lifting its red that way lands on #898e8f,
 * a grey error state. Mixing with white or black keeps the hue and spends only saturation.
 */
const lift = (c: string, bg: string, dark: boolean, target: number) =>
  search(c, dark ? '#ffffff' : '#000000', (h) => contrast(h, bg) >= target);

/**
 * A step `t0` of the way from `bg` to `fg`, pushed further only if it misses its floor — and never
 * closer than a tenth of the way from the text, so secondary text stays tellable from primary.
 *
 * That cap binds on exactly one scheme: Solarized Light's own body text is 4.13:1 against its own
 * background, so nothing derived from it can reach 4.4 and the honest answer is to stop short rather
 * than to hand `muted` the foreground's hex.
 */
const step = (bg: string, fg: string, t0: number, target: number) =>
  search(mix(bg, fg, t0), mix(bg, fg, 0.9), (h) => contrast(h, bg) >= target);

function fromScheme(s: SchemeData): Theme {
  const { background: bg, foreground: fg, dark } = s;
  // The normal half, never the bright one. ANSI only pins down what slots 1–6 mean; what a scheme
  // does with 9–14 is its own business, and Solarized spends them on its base greys — so a confirm
  // button read out of "bright blue" is #839496 there, and a warning out of "bright yellow" is a
  // blue-grey. Catppuccin's own four take their chrome from the same half, tuned.
  //
  // Where a scheme publishes the colour outright — gruvbox branches its whole accent tier on
  // dark-vs-light, Nord names nord8 "main color for primary UI elements", ayu's identity is its
  // gold — the generator carries it and it wins here. See `OVERRIDES` in scripts/gen-themes.ts.
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

    accent: s.accent ?? lift(blue, bg, dark, FLOOR.accent),
    accentAlternate: magenta,
    muted: s.muted ?? step(bg, fg, 0.78, FLOOR.muted),
    danger: s.danger ?? lift(red, bg, dark, FLOOR.danger),
    // No floor. Latte's own yellow is 2.31:1, so one here would put twenty-two schemes above the
    // family they match. The schemes whose authors publish a warning token carry it instead.
    warning: s.warning ?? yellow,
    surface: s.selection,
    panel: layer(bg, fg, LAYER.panel),
    scrim: layer(bg, fg, LAYER.scrim),
    border: s.border ?? step(bg, fg, 0.45, FLOOR.border),
    placeholder: s.placeholder ?? step(bg, fg, 0.55, FLOOR.placeholder),
    onAccent: bg,
    dots: {
      green,
      // One step up from the hairline, and on its own floor: this one is filled, not drawn.
      grey: step(bg, fg, 0.55, FLOOR.dot),
      mauve: magenta,
      blue,
      yellow,
      // No ANSI slot is orange. Nine of these palettes publish one anyway and the generator carries
      // it; the rest split the difference, because falling back to red made this dot and `danger`
      // the same hex on all twenty-two.
      peach: s.orange ?? mix(red, yellow, 0.45),
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
