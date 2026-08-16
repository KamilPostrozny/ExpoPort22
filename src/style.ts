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
 * swatch chip, the 38×30 stepper key, and the two bottom sheets' *different* drop shadows all
 * stay at their call sites — the browse sheet's `0 -10px 30px rgba(0,0,0,0.5)` and the settings
 * sheet's `0 -12px 40px rgba(0,0,0,0.45)` are both drawn that way on purpose, and folding them
 * into one constant would be inventing a consistency the design does not have. A vocabulary is
 * the words used twice.
 *
 * The pinned block at the bottom is geometry PLAN.md §3 or the prototype fixes outright, named
 * here only so it stops being a magic number in three files at once. It is not up for snapping:
 * a 49pt bar circle rounded to 48 is not consistency, it is a redesign.
 */

import { Platform } from 'react-native';

const ANDROID = Platform.OS === 'android';

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
  /** A filled button's label — always with weight 600. */
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
 * Note the key bar's menu header (11) and the ribbon's (9.5) are NOT this — the prototype gives
 * those their own sizes, and they keep them.
 */
export const SECTION_HEADER = {
  fontSize: TEXT.note,
  fontWeight: '600',
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
  /** A filled control on glass — a d-pad key. */
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
 * The key bar, PLAN.md §3. The 49pt circles and pill, the 35pt keys and the 7pt gap between them
 * are the same on both platforms; only the corners and the side margin take the Material skin.
 */
export const BAR = {
  circle: 49,
  key: 35,
  /** The prototype's `padding:0 5px` on a key — the code had drifted to 8. */
  keyPad: 5,
  gap: 7,
  keyRadius: ANDROID ? 12 : 18,
  sideMargin: ANDROID ? 8 : 24,
  radius: ANDROID ? 16 : 24.5,
} as const;

/**
 * The ⋯ menu's shell: the prototype's 26 on iOS, and 16 on Android — where PLAN §3's blanket
 * "popovers capped at 20" does not apply, because the Android prototype draws this one shell at 16.
 *
 * Only this popover is named here. The arrows cluster and the chord strip carry the prototype's own
 * 22, and the clipboard its 20; those are three separate decisions the design made per surface, not
 * one value with exceptions, so they stay literals beside the comments that cite them.
 */
export const MENU_RADIUS = ANDROID ? 16 : 26;

/** A bottom sheet's top corners: Material's 28 on Android, the prototype's 24 on iOS (§5d). */
export const SHEET_RADIUS = ANDROID ? 28 : 24;

/** The switcher's grid card — 14 on both platforms, no skin branch (PLAN.md §T7A). It coincides
 *  with `RADIUS.button`; they are two decisions that landed on one number, not one decision. */
export const CARD_RADIUS = 14;

/**
 * The two search fields. Only the Android arm is shared: Material's 16 (§5d buttons-16) is the
 * same for both, and was typed out at three call sites. The iOS arm is *not* one number — the
 * prototype draws the switcher's 40pt field at 13 and the terminal's 38pt field at 12, sized to
 * each box, so collapsing them would be inventing a consistency the design does not have.
 */
export const SEARCH_RADIUS = { switcher: ANDROID ? 16 : 13, terminal: ANDROID ? 16 : 12 } as const;

/** The caption under a chord cap. The design's own (§3), and the one place the app draws type
 *  smaller than anything else in the chrome. */
export const CAP_CAPTION = 8.5;
