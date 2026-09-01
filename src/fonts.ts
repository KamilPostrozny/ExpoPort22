/**
 * The two font family names, and nothing else.
 *
 * A leaf module on purpose. These used to live in `theme.ts`, which is the right place by subject
 * — but `terminal.tsx` is a `'use dom'` module and the only runtime value it wanted from there was
 * `MONO`, so that one import pulled `@catppuccin/palette`, `themes-generated.ts` and the whole
 * 27-theme graph across into the webview bundle. The webview runs plain JavaScript, not Hermes
 * bytecode, so all of it was re-parsed and re-allocated on every webview boot for one string.
 *
 * `theme.ts` re-exports both names, so nothing else had to move.
 */

/**
 * Bundled JetBrains Mono Nerd Font, loaded in `app/_layout.tsx`. The terminal grid, every
 * monospaced readout (public key, remote paths) and — since the SymbolView deletions in
 * `keybar.tsx`, `switcher.tsx` and `settings-sheet.tsx` — every icon in the chrome
 * render through these: the Nerd Font glyph ranges are the icon set, so `MONO` is no longer just
 * the terminal's font.
 *
 * Two separate one-face families, not one family with a weight axis, and it has to stay that way:
 * a numeric `fontWeight` against a custom one-face family resolves on neither platform the way it
 * reads, so the repo swaps the FAMILY for bold instead (`switcher.tsx:1075`).
 */
export const MONO = 'JetBrainsMono';
export const MONO_BOLD = 'JetBrainsMono-Bold';

/**
 * The chrome's sans, bundled, one family on both platforms.
 *
 * Chrome text used to set no `fontFamily` at all, which means the system font — SF Pro on iOS and
 * Roboto on Android. That is a divergence by omission, and the only one in the app that could not
 * be closed by taking the iOS value: SF Pro is Apple-licensed and cannot be shipped to Android. So
 * both platforms move instead. Inter is the pick because it is the open face nearest SF Pro in
 * metrics and shape — a humanist grotesque drawn for UI at small sizes — so the iOS build gives up
 * least by moving.
 *
 * FOUR REGISTERED FAMILIES, ONE FACE EACH, and it has to stay that way for the same reason `MONO`
 * does — only here it actively bites. `fontWeight: '700'` beside a one-face custom family
 * synthesises a fake bold on Android (minikin does it at a weight delta >= 300) and does nothing
 * at all on iOS: the exact divergence this file exists to document. So a weight is chosen by
 * naming the family, and no chrome style sets `fontWeight` next to one of these.
 *
 * The weights are the ones the chrome actually uses (600 nine times, 500 six, 700 four), not the
 * eighteen the package ships — each face is a separate asset in the bundle.
 */
export const SANS = 'Inter';
export const SANS_MEDIUM = 'Inter-Medium';
export const SANS_SEMIBOLD = 'Inter-SemiBold';
export const SANS_BOLD = 'Inter-Bold';

/**
 * WHY EVERY TEXT STYLE IN THIS APP SETS `includeFontPadding: false`.
 *
 * Android wraps every text box in the font's own recommended extra leading; iOS adds nothing. Same
 * font file, same `fontSize`, different line box — so any row that sizes to its text comes out
 * taller on Android. With SF Pro vs Roboto that was invisible, because nobody expected the two to
 * agree. Now that both platforms draw Inter it is the whole ballgame.
 *
 * Measured on the ⋯ menu, 2026-08-16, iOS device vs Android emulator at matched logical scale:
 * every row was 3.8–7.0pt taller on Android (73.0/42.7/45.7/51.3 against 80.0/46.5/49.5/55.2).
 * With the property set: 73.5/43.0/46.1/51.8 — inside half a point on all four.
 *
 * It is NOT a `Platform` branch and must not become one: iOS ignores the prop, so this is one code
 * path that happens to be load-bearing on one side. There is no global switch in React Native —
 * `Text.defaultProps` died with React 19 — so it is set per style, and a new text style without it
 * is a new divergence.
 */
