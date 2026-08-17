/**
 * T14's search wire format and matching rules, pure under `bun test`. The scrollback never comes
 * to the phone (50k lines × N windows per keystroke), so the scrollback half of the match is one
 * host-side exec per window per settled keystroke: `capture-pane -S - | grep -m1 -B/-A`, which
 * answers with exactly the card's worth of context around the first hit. The metadata half
 * (window name, path, process) is already on the phone via LIST_WINDOWS and matches locally.
 *
 * The terminal view's search is host-side for the same reason, and since BUGS.md §6 it is host-side
 * in fact: `searchWindowCommand` below, one window, every occurrence. Both halves of this file
 * therefore ask tmux — there is no longer a search in this app that can only see the screen.
 *
 * `src/switcher.tsx` schedules the grid's greps, `src/app/terminal.tsx` the terminal's; the latter
 * also owns the shared armed/disarmed search state the two views reflect (§ T14: one piece of
 * state, armed or disarmed as a whole).
 */

import { shellQuote, target, type TmuxWindow } from '@/tmux-model';

/** Case-insensitive substring — the baseline the whole task is specified against. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

/** The phone-side half: name, working directory, foreground process. */
export function metaMatches(win: TmuxWindow, q: string): boolean {
  const n = normalizeQuery(q);
  if (n === '') return false;
  return (win.name + '\n' + win.path + '\n' + win.command).toLowerCase().includes(n);
}

/** Context around the hit, sized for the card: the hit lands ~40% down a full block, which is
 *  the prototype's scroll-to-hit position without any scrolling machinery. */
export const HIT_BEFORE = 14;
export const HIT_AFTER = 20;

/**
 * First occurrence in the window's whole scrollback, with the card's context, in ONE exec.
 * `-e` keeps colours as escapes for the card; `-F` because the query is text, not a pattern;
 * `-i` to match the metadata half; `-m1` because the grid shows the first occurrence and nothing
 * more (multiple hits are the terminal view's prev/next job). `-n` marks which context line is
 * the hit. Quoting is `shellQuote`'s — the one contract for user-typed text on a remote command
 * line. Empty output = no hit (`; true` eats grep's exit 1). The window is addressed by tmux's
 * `@N` id through `target` — the same guard every other window command goes through, and for the
 * same reasons (see its note).
 *
 * ponytail: grep runs over the escaped capture, so a hit split mid-word by a colour change is
 * missed. The upgrade is a plain capture for line numbers plus a coloured re-capture of that
 * range — two round trips per window (PLAN.md T14 leaves it open; this is the walkthrough's
 * baseline).
 */
export function searchPaneCommand(id: string, query: string): string {
  return (
    `tmux capture-pane -p -e -S - ${target(id)} | ` +
    `grep -i -F -n -m1 -B${HIT_BEFORE} -A${HIT_AFTER} ${shellQuote(query)} 2>/dev/null; true`
  );
}

export type SearchHit = {
  /** The context lines, colours still as escapes — `parseAnsi` renders them like any capture. */
  lines: string[];
  /** Index into `lines` of the line holding the first occurrence. */
  hitLine: number;
};

/**
 * `grep -n` prefixes every line with its capture line number: `N:` on the match, `N-` on
 * context. The prefix is how the hit line is found, then it is stripped — the card renders the
 * text. A line without the prefix (shouldn't happen under -m1, but grep's `--` group separator
 * would be one) is kept verbatim rather than misparsed. Empty output = no hit.
 */
export function parseSearchOutput(stdout: string): SearchHit | null {
  if (stdout.trim() === '') return null;
  const lines: string[] = [];
  let hitLine = 0;
  for (const raw of stdout.split('\n')) {
    if (raw === '' && lines.length > 0) continue; // the trailing newline, not a context line
    const m = /^(\d+)([-:])/.exec(raw);
    if (m === null) {
      lines.push(raw);
      continue;
    }
    if (m[2] === ':') hitLine = lines.length;
    lines.push(raw.slice(m[0].length));
  }
  return { lines, hitLine };
}

/**
 * What one window's grep has told us, and the ONLY three things it can tell us:
 *   `undefined`  not asked yet, or still in flight
 *   `SearchHit`  a hit, with its context
 *   `null`       grep answered: this scrollback does not contain the query
 *   `'failed'`   we never got an answer — the channel died (sshd's MaxSessions, a dropped link)
 *
 * The fourth exists because it is not the third. A failed grep reported as `null` drops the card
 * out of a filtered grid, and the user reads that as "no match here" — a search that quietly
 * under-reports (emulator, 2026-08-17: 16 of 24 windows at once, all `open failed`).
 */
export type SearchAnswer = SearchHit | null | 'failed';

/** The grid's filter: a window survives on either half of the match.
 *
 *  The four states of `hit` are the whole of it — a card is removed only once its grep has
 *  ANSWERED that there is nothing (`null`), never while the answer is still in flight
 *  (`undefined`) and never when the answer never came (`'failed'`). Treating "not known yet" as
 *  "no match" emptied the grid on the first keystroke and refilled it a beat later, so a quick
 *  query read as the tabs vanishing and coming back rather than as a list narrowing (user,
 *  device). Held instead, the grid only ever loses cards, one grep at a time — and an unanswered
 *  window stays, saying so on its card (§ disabled-over-hidden: never silently drop it). */
export function windowSurvives(win: TmuxWindow, q: string, hit: SearchAnswer | undefined): boolean {
  return metaMatches(win, q) || hit !== null;
}

/** One settled keystroke per debounce window — every grep on this file rides it, the metadata
 *  match doesn't. */
export const SEARCH_DEBOUNCE_MS = 300;

/* --- the terminal view's half: every occurrence in ONE window (BUGS.md §6) --- */

/**
 * Why this is not `searchPaneCommand` above: the grid asks "does this window contain it, and what
 * does the first hit look like", and answers with a card's worth of coloured context. The terminal
 * asks "where is every occurrence in THIS window", and has to answer with positions. Same quoting,
 * same `target` guard, same debounce — a different question, so a different pair of greps.
 *
 * It replaces `@xterm/addon-search`, which walked xterm's own buffer: under tmux every pane draws
 * inside a scroll region, nothing ever leaves the screen into the emulator's scrollback, and the
 * addon therefore searched the visible ~41 rows and reported ~20 hits where the host had thousands
 * (device, 2026-08-15). The reach a terminal search is expected to have is tmux's history, and
 * tmux's history only ever comes to the phone through `capture-pane`.
 *
 * It opens by asking tmux to name the window back, and that line is not decoration: a capture of a
 * window that is GONE prints its error on stderr and leaves `wc -l` to answer `0` on stdout, which
 * parses as "no hits in this window" — the exact silent under-report the grid's `'failed'` exists
 * to prevent. `#{window_id}` comes back empty for a dead target, so an answer that does not open
 * with an `@N` is an answer from nowhere (see `parseWindowSearch`).
 *
 * Then TWO captures, all of it ONE exec channel — the split is what keeps it cheap:
 *   1. the whole history, counted with `grep -o … | wc -l`. OCCURRENCES, not lines: `grep -c`
 *      counts lines, and a line holding the query twice is two hits by every other reckoning in
 *      this file (`highlightLine` marks both). One number, however deep the history goes.
 *   2. the visible screen alone, `grep -n`, so the POSITIONS come back as at most `rows` short
 *      lines instead of dragging 50 000 lines of scrollback across the bridge.
 * The visible screen is the tail of the history capture, so the on-screen hits are the LAST
 * `onScreen.length` of the `total` — which is what makes the label's index (see `searchLabel`) a
 * position in the whole window rather than in the viewport.
 *
 * No `-e` on either, unlike the grid's: colour escapes would both split a hit mid-word and destroy
 * the column arithmetic the mark is placed on. No `-J` either — unjoined, one capture line IS one
 * screen row, which is what makes `grep -n`'s line number a row to mark.
 *
 * ponytail: a hit that WRAPS across two screen rows is two half-hits neither grep sees, exactly as
 * for the grid. The upgrade is `-J` plus a wrap-aware row mapping, which needs the pane's width;
 * nobody has hit it, because the query is short and the wrap rare.
 */
export function searchWindowCommand(id: string, query: string): string {
  const q = shellQuote(query);
  const t = target(id);
  return (
    `tmux display-message -p ${t} '#{window_id}'; ` +
    `tmux capture-pane -p -S - ${t} | grep -o -i -F -e ${q} | wc -l; ` +
    `tmux capture-pane -p ${t} | grep -n -i -F -e ${q} 2>/dev/null; true`
  );
}

/** A hit on the visible screen: 0-based row from the top of the pane, 0-based column. */
export type WindowHit = { row: number; col: number };

export type WindowSearch = {
  /** Occurrences in the whole window — tmux's history and the screen. The true count. */
  total: number;
  /** The ones the user can actually see, in document order — the only ones that can be marked. */
  onScreen: WindowHit[];
};

/**
 * `@N\n<count>\n<row>:<line>\n…` → the count and every on-screen position.
 *
 * `null` unless the window named itself back AND the count is a number — a search that did not
 * reach its window must not read as "nothing here" (the grid draws the same line between `null`
 * and `'failed'`, for the same reason). `wc -l` alone cannot make that distinction: it answers `0`
 * just as cheerfully for a dead window as for a window with no hits.
 *
 * The columns are found here rather than by grep, because grep answers in lines: one `grep -n` line
 * can hold several occurrences, and each is its own hit.
 */
export function parseWindowSearch(stdout: string, query: string): WindowSearch | null {
  const q = normalizeQuery(query);
  const lines = stdout.split('\n');
  if (!/^@\d+$/.test(lines[0] ?? '')) return null;
  const count = /^\s*(\d+)\s*$/.exec(lines[1] ?? '');
  if (count === null || q === '') return null;
  const onScreen: WindowHit[] = [];
  for (const raw of lines.slice(2)) {
    const m = /^(\d+):/.exec(raw);
    if (m === null) continue;
    const row = Number(m[1]) - 1; // grep counts from 1, the screen's top row is 0
    const text = raw.slice(m[0].length).toLowerCase();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      onScreen.push({ row, col: i });
    }
  }
  // The two captures are two reads of a pane that may be printing between them, so the tail can
  // hold a hit the count never saw. The count is the one the label divides by; it can never be
  // smaller than the hits in hand.
  return { total: Math.max(Number(count[1]), onScreen.length), onScreen };
}

/**
 * The count beside the field, which now has TWO scopes to be honest about: the search reaches the
 * whole window, the mark and the steppers reach only the screen.
 *
 * `at` indexes `onScreen`, and the label prints that hit's position in the WHOLE window — which is
 * what "the last n of total" buys. So `1265/1284` says both things at once: this is hit 1265, and
 * 1264 of them are further up in tmux's history, out of the steppers' reach. No suffix needed and
 * none given; the greyed-out ∧ at the first reachable hit says the rest of it.
 *
 * The old `on screen` suffix (BUGS.md §6's half-measure) survives in exactly the state where the
 * index cannot speak: hits exist, none of them on this screen, so there is nothing to step to and
 * nothing to mark. It means the opposite of what it used to — it used to qualify a count that
 * could not see past the viewport, and the count sees everything now.
 */
export function searchLabel(found: WindowSearch | 'failed' | null, at: number): string {
  if (found === null) return '';
  if (found === 'failed') return 'failed';
  const n = found.onScreen.length;
  if (found.total === 0) return 'none';
  if (n === 0) return `${found.total}, none on screen`;
  return `${found.total - n + Math.min(Math.max(at, 0), n - 1) + 1}/${found.total}`;
}
