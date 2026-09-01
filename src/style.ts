/**
 * How big a thing is, how round, and how far from its neighbour — for every screen at once.
 *
 * `theme.ts` answers "what colour"; this answers everything else about how the chrome is drawn.
 *
 * **These are the design's numbers, not a scale invented here.** That distinction is the whole
 * file. They were read off a working prototype with concrete CSS on every element (that file is
 * deleted — AGENTS.md; the iOS build is the reference now), and it was hand-tuned rather than built on a grid: it legitimately spends 7 *and* 8 on
 * gaps, 11.5 and 12.5 on captions, and nine different alphas of one grey. Snapping that onto a
 * 4pt ladder would be tidier and would be a different design, so what is collected here is only
 * what the prototype itself uses more than once — a 15pt row label (its most-set size), a 16pt
 * gutter, a 16pt card corner, a 14pt button corner. The screens the prototype never covered
 * (Setup, the browse sheet, the status block) now pick from that instead of inventing a fourth.
 *
 * What is deliberately NOT here: anything the prototype fixes for a single element. The 9×13
 * swatch chip and the 38×30 stepper key stay at their call sites — a number set once belongs
 * beside the thing it sizes, and hoisting it would invent a vocabulary out of a single word. A
 * vocabulary is the words used twice.
 *
 * The pinned block at the bottom is geometry PLAN.md §3 or the prototype fixes outright, named
 * here only so it stops being a magic number in three files at once. It is not up for snapping:
 * a 49pt bar circle rounded to 48 is not consistency, it is a redesign.
 */

import { SANS_SEMIBOLD } from '@/fonts';

/* --- type --- */

/**
 * Chrome type, by the job the text does. The terminal's own size is the user's
 * (`settings.fontSize`, 8–32) and is not here.
 *
 * Only the roles the app actually repeats. A caption the prototype sets once at 11.5 and once at
 * 9.5 is two decisions it made, not one this file should overrule — those stay where they are.
 */
export const TEXT = {
  /** A card's second line: a directory under a window name. */
  micro: 10,
  /** A readout beside something else: a match count, a byte size, a note under a row. */
  caption: 11,
  /** A section header. */
  note: 12,
  /** Monospaced values, and the terminal's search field. */
  base: 13,
  /** A monospaced chrome label: a bar key, a name pill, a cap. Five call sites, all at 14. */
  mono: 14,
  /** A row's own label. The size the prototype sets more often than any other. */
  label: 15,
  /** A filled button's label — always in `SANS_SEMIBOLD`. */
  button: 16,
} as const;

/**
 * Line height for text that WRAPS. Single-line labels leave it unset — RN centres them in their
 * own box and pinning a leading there only fights the box.
 */
export const leading = (size: number) => Math.round(size * 1.4);

/**
 * The group label over a list of rows. The prototype sets `font:600 12px system-ui;
 * letter-spacing:0.6px` on all three of the settings sheet's own.
 *
 * Note the key bar's menu header (11) is NOT this — the prototype gives
 * those their own sizes, and they keep them.
 */
export const SECTION_HEADER = {
  fontFamily: SANS_SEMIBOLD,
  fontSize: TEXT.note,
  letterSpacing: 0.6,
} as const;

/* --- space --- */

/**
 * Padding, margin and gap for the chrome — the prototype's own gutters: 16 inside a row or a
 * popover, 20 for the outer edge of a sheet or the grid, and the small steps between.
 */
export const SPACE = {
  /** Between a glyph and its caption; a stub off an edge. */
  xs: 4,
  sm: 8,
  md: 12,
  /** The default gutter — a row's inset inside its card, a popover's own padding. */
  gutter: 16,
  /** A sheet's or a screen's outer edge, one step clear of the rows inside it. */
  wide: 20,
  xl: 24,
  xxl: 32,
} as const;

/* --- shape --- */

/**
 * Corners. The prototype draws three kinds of box and gives each one corner: a field or popover
 * key at 12, a button at 14, a grouped rows card at 16.
 */
export const RADIUS = {
  /** A swatch chip, a sheet's grabber: round enough not to be a rectangle. */
  chip: 3,
  small: 6,
  /** A field, a popover key. */
  control: 12,
  /** A filled or tinted action button. Setup's two had drifted to 12 and 10. */
  button: 14,
  /** A card holding a list of rows. Setup's had drifted to 12. */
  card: 16,
  /**
   * Anything whose radius is half its height — a circle, a capsule, a track. A number past any
   * real height rather than the computed half, so the shape survives a resize; RN clamps it to
   * half the box, which is the definition of the shape wanted.
   */
  pill: 999,
} as const;

/** Two props, a dozen call sites, and every one of them means "in the middle of its box". */
export const CENTER = { alignItems: 'center', justifyContent: 'center' } as const;

/** The drag handle at the top of a bottom sheet — the design frames' own 36×5, drawn twice. */
export const GRABBER = { width: 36, height: 5, borderRadius: RADIUS.chip } as const;

/** Touch-down on something that does not move: a button in a fixed box, a list row. */
export const PRESSED = { opacity: 0.6 } as const;
/** Touch-down on a key or a circle, which also shrinks under the finger. */
export const PRESSED_KEY = { opacity: 0.6, transform: [{ scale: 0.94 }] } as const;

/* --- neutrals --- */

/**
 * The prototype's cross-flavour greys (PLAN.md §7 sanctions exactly these: overlay-grey tints,
 * hairlines, shadow black). One grey at the alphas the chrome needs, rather than the same
 * `rgba(127,132,156,…)` string re-typed in three files under three different names.
 *
 * They live outside `theme.ts` on purpose: they read the same on all 26 schemes, which is what
 * makes them a tint rather than a colour.
 */
const GREY = (a: number) => `rgba(127,132,156,${a})`;
export const TINT = {
  /** A shape that is barely there: the switcher's drop placeholder. */
  ghost: GREY(0.08),
  /** A filled control on a plate — a d-pad key. */
  fill: GREY(0.16),
  /** The stepper's track. */
  track: GREY(0.25),
  /** A hairline between rows, and the press wash on a popover row. */
  line: GREY(0.3),
  /** A divider that has to survive being drawn on top of `track`. */
  edge: GREY(0.4),
} as const;

/* --- pinned: the design's fixed geometry, named so it stops being magic --- */

/**
 * The key bar, PLAN.md §3. 49pt circles and pill, 35pt keys with an 18pt corner, a 7pt gap, a 24.5
 * capsule on every plate (half of 49, so the bar's pill is a true capsule) and a 34pt
 * inset from each screen edge. One set of numbers for both platforms.
 *
 * `sideMargin` and `padBottom` are read by BOTH floating bars — the terminal's key bar and the
 * switcher's `+ | N Tabs | ✓` — and that is the whole point of them living here. The two bars sit
 * at the same place on screen and the user switches between them with one tap, so a circle that
 * moves between the two views reads as the bar jumping. They had drifted apart: the key bar was
 * inset 24 and hung 6 off the home strip, the switcher 34 and 10, which put the ⋯ and the + 10pt
 * apart horizontally and 4pt vertically (user, 2026-08-31, screenshot pair). The switcher's pair
 * won because the tabs view is the one the user named as correct. Change these and both bars move
 * together; hardcode either number at a call site again and they drift again.
 */
export const BAR = {
  circle: 49,
  key: 35,
  /** The prototype's `padding:0 5px` on a key — the code had drifted to 8. */
  keyPad: 5,
  gap: 7,
  keyRadius: 18,
  sideMargin: 34,
  /** The row's own top gap. `keybar` re-exports it as `BAR_PAD_TOP`, which the terminal's pane
   *  arithmetic reads; this is the one definition. */
  padTop: 5,
  /** The gap under the row, INSIDE the safe-area inset both bars already sit on. */
  padBottom: 10,
  radius: 24.5,
} as const;

/**
 * The ⋯ menu's shell corners at 26 — this popover's own decision, not PLAN §3's blanket "popovers
 * capped at 20".
 *
 * Only this popover is named here. The arrows cluster and the chord strip carry 22, and the
 * clipboard 20; those are three separate per-surface decisions, not one value with exceptions, so
 * they stay literals beside the comments that cite them.
 */
export const MENU_RADIUS = 26;

/** A bottom sheet's top corners. The settings sheet draws this itself on both platforms; the
 *  upload sheet's hand-built Android shell takes the same number so it comes out matching the
 *  system pageSheet iOS presents there. */
export const SHEET_RADIUS = 24;

/** The switcher's grid card — 14 on both platforms (PLAN.md §T7A). It coincides with
 *  `RADIUS.button`; they are two decisions that landed on one number, not one decision. */
export const CARD_RADIUS = 14;

/**
 * The two search fields: two fields, two boxes, two corners. The switcher's 40pt field takes 13
 * and the terminal's 38pt field (and its 34×38 stepper keys) takes 12, each sized to its own box,
 * so collapsing them would be inventing a consistency the design does not have.
 */
export const SEARCH_RADIUS = { switcher: 13, terminal: 12 } as const;

/** The caption under a chord cap. The design's own (§3), and the one place the app draws type
 *  smaller than anything else in the chrome. */
export const CAP_CAPTION = 8.5;
