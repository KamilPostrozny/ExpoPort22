/**
 * Regenerates `src/themes-generated.ts` from `@shikijs/themes`. Run with `bun scripts/gen-themes.ts`.
 *
 * Why a generator and not a plain import: `@shikijs/themes` is the one maintained package that
 * carries all of these schemes with a complete 16-slot ANSI set (checked against `base16` — stale
 * since 2015, and missing every scheme newer than it — and the per-scheme packages `nord`,
 * `gruvbox`, `dracula`, which are three different shapes, none of them terminal palettes). But a
 * shiki theme is a TextMate theme: ~28 KB each, of which we want twenty-two colours. Nineteen of
 * them imported at runtime is ~500 KB of JSON parsed on the JS thread before first paint, so the
 * twenty-two are lifted out here instead, and the package stays a devDependency.
 *
 * Which schemes: the ones with an ecosystem behind them (official ports for terminals, editors and
 * Neovim). Not every scheme has both a light and a dark cut — Dracula, Nord, Tokyo Night and
 * Monokai are dark-only — so the two lists below are deliberately different lengths.
 */

import { readFile, writeFile } from 'node:fs/promises';

/** `[shiki module name, label]`, in the order the picker shows them. */
const DARK: [string, string][] = [
  ['tokyo-night', 'Tokyo Night'],
  ['gruvbox-dark-medium', 'Gruvbox Dark'],
  ['nord', 'Nord'],
  ['dracula', 'Dracula'],
  // "One Dark Pro", not "One Dark": Binaryify's sixteen are a different palette from Atom's — its
  // ansiYellow #d18f52 is 22.8 from Atom's *orange* and 66.9 from Atom's yellow.
  ['one-dark-pro', 'One Dark Pro'],
  ['solarized-dark', 'Solarized Dark'],
  ['rose-pine', 'Rosé Pine'],
  ['rose-pine-moon', 'Rosé Pine Moon'],
  ['everforest-dark', 'Everforest Dark'],
  ['kanagawa-wave', 'Kanagawa'],
  ['ayu-dark', 'Ayu Dark'],
  ['monokai', 'Monokai'],
  ['github-dark-default', 'GitHub Dark'],
  ['night-owl', 'Night Owl'],
];

const LIGHT: [string, string][] = [
  ['solarized-light', 'Solarized Light'],
  ['github-light-default', 'GitHub Light'],
  ['gruvbox-light-medium', 'Gruvbox Light'],
  ['everforest-light', 'Everforest Light'],
  ['rose-pine-dawn', 'Rosé Pine Dawn'],
  ['ayu-light', 'Ayu Light'],
  ['night-owl-light', 'Night Owl Light'],
  ['kanagawa-lotus', 'Kanagawa Lotus'],
];
// Left out on purpose: `one-light` and `light-plus` ship no `terminal.ansi*` at all, so a terminal
// built from them would be inventing fifteen colours. `horizon-bright` ships twelve of the sixteen.

/**
 * What a shiki theme cannot tell us, taken from the scheme's own authority.
 *
 * A TextMate theme is an *editor* theme: where its author also publishes a terminal port or a named
 * role table, that document wins, because VS Code's key set has nowhere to put "the accent colour"
 * and no opinion about which grey is a hairline. Every entry below cites the file it came from.
 *
 * `orange` is here because no ANSI slot is orange and nine of these palettes name one — without it
 * the ribbon's peach dot is byte-identical to `danger` (see `theme.ts`).
 */
const OVERRIDES: Record<string, Partial<Extracted>> = {
  // xresources: `*cursorColor: S_base1`. Shiki reports the tmTheme's `string.regexp` red, which VS
  // Code promotes to `editorCursor.foreground` — it is not one of Solarized's sixteen.
  // "For highlighting, combine base02:base1" — base02, which is also our ansi[0].
  'solarized-dark': { cursor: '#93a1a1', selection: '#073642', orange: '#cb4b16' },
  // The Light block of the xresources inverts the base macros; shiki ships the Dark block's greys,
  // which leaves bright-white at 1.00:1 against the background — invisible.
  'solarized-light': {
    cursor: '#586e75',
    selection: '#eee8d5',
    orange: '#cb4b16',
    ansi: [
      '#eee8d5', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#073642',
      '#fdf6e3', '#cb4b16', '#93a1a1', '#839496', '#657b83', '#6c71c4', '#586e75', '#002b36',
    ],
  },
  // nord.css: nord8 is "the accent color of the color palette. Main color for primary UI elements";
  // nord9 (shiki's ansi[4]) is "keywords, operators, tags". Selection is the alacritty port's.
  nord: { accent: '#88c0d0', selection: '#4c566a', orange: '#d08770' },
  // gruvbox.vim branches its whole accent tier on `s:is_dark`; the neutral tier that shiki hands us
  // exists only to be terminal slots 1-6. Visual is bg3, not the aqua accent at 25%.
  'gruvbox-dark-medium': {
    selection: '#665c54', accent: '#83a598', danger: '#fb4934', warning: '#fabd2f',
    orange: '#fe8019',
  },
  'gruvbox-light-medium': {
    selection: '#bdae93', accent: '#076678', danger: '#9d0006', warning: '#b57614',
    orange: '#af3a03',
  },
  // The published role table names highlightMed for selection and highlightHigh for "cursor
  // background, borders"; both terminal ports ship them. ansi[8] is `muted` upstream, not `subtle`.
  'rose-pine': {
    selection: '#403d52', cursor: '#524f67', border: '#524f67', orange: '#ebbcba',
    ansi8: '#6e6a86',
  },
  'rose-pine-moon': {
    selection: '#44415a', cursor: '#56526e', border: '#56526e', orange: '#ea9a97',
    ansi8: '#6e6a86',
  },
  'rose-pine-dawn': {
    selection: '#dfdad9', cursor: '#cecacd', border: '#cecacd', accent: '#286983',
    orange: '#d7827e', ansi8: '#9893a5',
  },
  // spec.mdx, "Borders and Separators": "Subtle borders: Use Current Line color".
  dracula: { border: '#44475a', orange: '#ffb86c' },
  // enkia publishes `terminal.background`/`terminal.foreground` alongside the editor pair; those are
  // read directly below. The orange is folke's, shipped as kitty color16.
  'tokyo-night': { orange: '#ff9e64' },
  // Atom names `@syntax-accent` and wires it to the cursor and the selected result marker.
  // OneDark-Pro publishes `terminal.border`.
  'one-dark-pro': { accent: '#528bff', border: '#3e4452', orange: '#d19a66' },
  // everforest.vim: black is bg3 and white is fg on a dark background, inverted on light, brights
  // repeating. Shiki substitutes bg1/grey1, which leaves the light cut's bright-white at 1.06:1.
  'everforest-dark': {
    selection: '#543a48', orange: '#e69875', ansi0: '#475258', ansi8: '#475258',
  },
  'everforest-light': {
    selection: '#eaedc8', orange: '#f57d26', ansi15: '#e6e2cc',
  },
  // themes.lua publishes a diagnostic set; ansi[3]/ansi[1] are `syn.operator` and `vcs.removed`.
  // Both ports give the real selection, where shiki reports the pmenu fill.
  'kanagawa-wave': {
    selection: '#2d4f67', danger: '#e82424', warning: '#ff9e3b', orange: '#ffa066',
  },
  'kanagawa-lotus': {
    selection: '#c9cbd1', danger: '#e82424', warning: '#e98a00', orange: '#e98a00',
  },
  // ayu-colors: `common.accent` is the whole theme's identity, and shiki hands it to us as the
  // cursor. `common.error` is a distinct hex from `vcs.removed`, which is what ansi[1] carries.
  // `ui.selection.active` is the chrome selection; ansi[4] takes the editor one.
  'ayu-dark': {
    accent: '#e6b450', danger: '#d95757', selection: '#1e242f', orange: '#ff8f40',
  },
  // No `accent` on the light cut, deliberately. ayu's gold is 9.98:1 on the dark ground and 2.16:1
  // on this one, and upstream spends it as a *fill* with its own `common.accent.on` ink on top —
  // where our `accent` is also drawn as text and as a selection ring, over `onAccent`. The blue in
  // ansi[4] takes it instead, lifted to the floor.
  'ayu-light': { danger: '#d95757', selection: '#dfe2e6', orange: '#fa8532' },
  // Monokai has no blue: VS Code's ansiBlue is self-documented as "hue shifted #AE81FF" at 75%.
  // The recessed ramp is warm olive, not the cool slate shiki derives.
  monokai: { selection: '#49483e', accent: '#ae81ff', orange: '#fd971f' },
  // github-vscode-theme re-declares `editor.selectionBackground` in the same object literal, so
  // JSON.stringify drops it and we fall back to a grey. Primer's functional tokens win for the rest.
  'github-dark-default': {
    selection: '#142744', muted: '#9198a1', danger: '#f85149', border: '#3d444d',
    orange: '#ffa657', ansi7: '#f0f6fc',
  },
  'github-light-default': {
    selection: '#cee1f8', muted: '#59636e', danger: '#cf222e', border: '#d1d9e0',
    warning: '#9a6700', orange: '#bc4c00', ansi8: '#393f46',
  },
  // sdras names one hex for both jobs: `panel.border` and `input.placeholderForeground`.
  'night-owl': { border: '#5f7e97', placeholder: '#5f7e97', orange: '#f78c6c' },
  'night-owl-light': { border: '#5f7e97', placeholder: '#5f7e97', orange: '#c96765' },
};

const ANSI_KEYS = [
  'Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White',
  'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow',
  'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite',
].map((slot) => `terminal.ansi${slot}`);

/** `#abc` / `#abcd` / `#rrggbb` / `#rrggbbaa` → `[r, g, b, a]`, a in 0..1. */
function parse(hex: string): [number, number, number, number] {
  let h = hex.replace('#', '');
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return [n(0), n(1), n(2), h.length === 8 ? n(3) / 255 : 1];
}

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Flattens `fg` (possibly translucent) onto opaque `bg`. Every colour we emit is opaque: a
 *  selection at 30% alpha over an editor is a solid colour over a terminal cell. */
function flatten(fg: string, bg: string): string {
  const [r, g, b, a] = parse(fg);
  const [br, bg_, bb] = parse(bg);
  return hex(r * a + br * (1 - a), g * a + bg_ * (1 - a), b * a + bb * (1 - a));
}

/** `t` of the way from `a` to `b`. Only used for the selection fallback below. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parse(a);
  const [br, bg_, bb] = parse(b);
  return hex(ar + (br - ar) * t, ag + (bg_ - ag) * t, ab + (bb - ab) * t);
}

/** What a scheme carries. Everything after `ansi` is optional and comes from `OVERRIDES`: a value
 *  the author published that a TextMate theme has no key for, or one where shiki's key is wrong. */
type Extracted = {
  name: string;
  label: string;
  dark: boolean;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  ansi: string[];
  /** The scheme's own named orange. No ANSI slot is orange; nine of these palettes publish one. */
  orange?: string;
  /* Chrome the author names outright, where ours would otherwise be arithmetic. */
  accent?: string;
  danger?: string;
  warning?: string;
  muted?: string;
  border?: string;
  placeholder?: string;
  /* Single ANSI slots shiki gets wrong. Folded into `ansi` below, never emitted. */
  ansi0?: string;
  ansi7?: string;
  ansi8?: string;
  ansi15?: string;
};

async function extract(mod: string, label: string, dark: boolean): Promise<Extracted> {
  const theme = (await import(`@shikijs/themes/${mod}`)).default;
  const c: Record<string, string> = theme.colors ?? {};
  const need = (key: string) => {
    const v = c[key];
    if (v === undefined) throw new Error(`${mod}: missing ${key}`);
    return v;
  };
  // `terminal.background` first where the author ships one: that is literally the ground they drew
  // their terminal on. Three themes differ from their editor background, none by much.
  //
  // `terminal.foreground` is deliberately *not* preferred. Only Tokyo Night's differs, and it drops
  // default text from 8.10:1 to 4.40:1 — enkia's terminal foreground is the same hex as their ANSI
  // white, so honouring it dims every unstyled line to make SGR 37 agree. A white dimmer than the
  // foreground is not a defect either: gruvbox ships ansi7 #a89984 under fg #ebdbb2 on purpose.
  const background = flatten(c['terminal.background'] ?? need('editor.background'), '#000000');
  const foreground = flatten(need('editor.foreground'), background);
  // The GitHub themes ship no `editor.selectionBackground` — it is re-declared in the same object
  // literal upstream and dropped by JSON.stringify — so those two come from OVERRIDES instead.
  const selection = c['editor.selectionBackground'] ?? c['editor.inactiveSelectionBackground'];
  const { ansi0, ansi7, ansi8, ansi15, ...over } = OVERRIDES[mod] ?? {};
  const ansi = over.ansi ?? ANSI_KEYS.map((key) => flatten(need(key), background));
  for (const [slot, value] of [[0, ansi0], [7, ansi7], [8, ansi8], [15, ansi15]] as const) {
    if (value) ansi[slot] = value;
  }
  return {
    name: mod,
    label,
    dark,
    background,
    foreground,
    cursor: flatten(c['editorCursor.foreground'] ?? need('editor.foreground'), background),
    selection: selection ? flatten(selection, background) : mix(background, foreground, 0.2),
    ...over,
    ansi,
  };
}

const themes = [
  ...(await Promise.all(DARK.map(([m, l]) => extract(m, l, true)))),
  ...(await Promise.all(LIGHT.map(([m, l]) => extract(m, l, false)))),
];

const version = JSON.parse(await readFile('node_modules/@shikijs/themes/package.json', 'utf8'))
  .version;

const OPTIONAL = [
  'orange', 'accent', 'danger', 'warning', 'muted', 'border', 'placeholder',
] as const;

const body = themes
  .map((t) => {
    const extra = OPTIONAL.filter((k) => t[k]).map((k) => `    ${k}: '${t[k]}',\n`).join('');
    return (
      `  {\n    name: '${t.name}',\n    label: '${t.label}',\n    dark: ${t.dark},\n` +
      `    background: '${t.background}',\n    foreground: '${t.foreground}',\n` +
      `    cursor: '${t.cursor}',\n    selection: '${t.selection}',\n` +
      extra +
      `    ansi: [\n      ${t.ansi.slice(0, 8).map((h) => `'${h}'`).join(', ')},\n` +
      `      ${t.ansi.slice(8).map((h) => `'${h}'`).join(', ')},\n    ],\n  },`
    );
  })
  .join('\n');

await writeFile(
  'src/themes-generated.ts',
  `/* GENERATED by scripts/gen-themes.ts from @shikijs/themes@${version} — do not edit by hand. */\n\n` +
    `export type SchemeData = {\n  name: string;\n  label: string;\n  dark: boolean;\n` +
    `  background: string;\n  foreground: string;\n  cursor: string;\n  selection: string;\n` +
    `  ansi: string[];\n` +
    OPTIONAL.map((k) => `  ${k}?: string;\n`).join('') +
    `};\n\nexport const SCHEMES: SchemeData[] = [\n${body}\n];\n`,
);

const overridden = themes.filter((t) => OVERRIDES[t.name]).length;
console.log(
  `wrote ${themes.length} schemes from @shikijs/themes@${version} (${overridden} with overrides)`,
);
