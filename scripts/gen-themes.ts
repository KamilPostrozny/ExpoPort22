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
  ['one-dark-pro', 'One Dark'],
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

async function extract(mod: string, label: string, dark: boolean) {
  const theme = (await import(`@shikijs/themes/${mod}`)).default;
  const c: Record<string, string> = theme.colors ?? {};
  const need = (key: string) => {
    const v = c[key];
    if (v === undefined) throw new Error(`${mod}: missing ${key}`);
    return v;
  };
  const background = flatten(need('editor.background'), '#000000');
  const foreground = flatten(need('editor.foreground'), background);
  // The GitHub themes ship no `editor.selectionBackground`; a fifth of the way to the text is what
  // the themes that do ship one land near, and it is a raised layer either way.
  const selection = c['editor.selectionBackground'] ?? c['editor.inactiveSelectionBackground'];
  return {
    name: mod,
    label,
    dark,
    background,
    foreground,
    cursor: flatten(c['editorCursor.foreground'] ?? need('editor.foreground'), background),
    selection: selection ? flatten(selection, background) : mix(background, foreground, 0.2),
    ansi: ANSI_KEYS.map((key) => flatten(need(key), background)),
  };
}

const themes = [
  ...(await Promise.all(DARK.map(([m, l]) => extract(m, l, true)))),
  ...(await Promise.all(LIGHT.map(([m, l]) => extract(m, l, false)))),
];

const version = JSON.parse(await readFile('node_modules/@shikijs/themes/package.json', 'utf8'))
  .version;

const body = themes
  .map(
    (t) =>
      `  {\n    name: '${t.name}',\n    label: '${t.label}',\n    dark: ${t.dark},\n` +
      `    background: '${t.background}',\n    foreground: '${t.foreground}',\n` +
      `    cursor: '${t.cursor}',\n    selection: '${t.selection}',\n` +
      `    ansi: [\n      ${t.ansi.slice(0, 8).map((h) => `'${h}'`).join(', ')},\n` +
      `      ${t.ansi.slice(8).map((h) => `'${h}'`).join(', ')},\n    ],\n  },`,
  )
  .join('\n');

await writeFile(
  'src/themes-generated.ts',
  `/* GENERATED by scripts/gen-themes.ts from @shikijs/themes@${version} — do not edit by hand. */\n\n` +
    `export type SchemeData = {\n  name: string;\n  label: string;\n  dark: boolean;\n` +
    `  background: string;\n  foreground: string;\n  cursor: string;\n  selection: string;\n` +
    `  ansi: string[];\n};\n\nexport const SCHEMES: SchemeData[] = [\n${body}\n];\n`,
);

console.log(`wrote ${themes.length} schemes from @shikijs/themes@${version}`);
