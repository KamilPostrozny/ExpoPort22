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

/** Bundled JetBrains Mono Nerd Font, loaded in `app/_layout.tsx`. The terminal grid and every
 *  monospaced readout (public key, remote paths) use these; chrome text uses the system font. */
export const MONO = 'JetBrainsMono';
export const MONO_BOLD = 'JetBrainsMono-Bold';
