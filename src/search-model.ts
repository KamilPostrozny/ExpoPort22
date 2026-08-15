/**
 * T14's search wire format and matching rules, pure under `bun test`. The scrollback never comes
 * to the phone (50k lines × N windows per keystroke), so the scrollback half of the match is one
 * host-side exec per window per settled keystroke: `capture-pane -S - | grep -m1 -B/-A`, which
 * answers with exactly the card's worth of context around the first hit. The metadata half
 * (window name, path, process) is already on the phone via LIST_WINDOWS and matches locally.
 *
 * `src/switcher.tsx` schedules the greps; `src/app/terminal.tsx` owns the shared armed/disarmed
 * search state the two views reflect (§ T14: one piece of state, armed or disarmed as a whole).
 */

import { shellQuote, type TmuxWindow } from '@/tmux-model';

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
 * line. Empty output = no hit (`; true` eats grep's exit 1).
 *
 * ponytail: grep runs over the escaped capture, so a hit split mid-word by a colour change is
 * missed. The upgrade is a plain capture for line numbers plus a coloured re-capture of that
 * range — two round trips per window (PLAN.md T14 leaves it open; this is the walkthrough's
 * baseline).
 */
export function searchPaneCommand(index: number, query: string): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`not a window index: ${index}`);
  return (
    `tmux capture-pane -p -e -S - -t :${index} | ` +
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

/** The grid's filter: a window survives on either half of the match.
 *
 *  The three states of `hit` are the whole of it — a card is removed only once its grep has
 *  ANSWERED (`null`), never while the answer is still in flight (`undefined`). Treating "not known
 *  yet" as "no match" emptied the grid on the first keystroke and refilled it a beat later, so a
 *  quick query read as the tabs vanishing and coming back rather than as a list narrowing (user,
 *  device). Held instead, the grid only ever loses cards, one grep at a time. */
export function windowSurvives(
  win: TmuxWindow,
  q: string,
  hit: SearchHit | null | undefined,
): boolean {
  return metaMatches(win, q) || hit !== null;
}

/** One settled keystroke per debounce window — the greps ride this, the metadata match doesn't. */
export const SEARCH_DEBOUNCE_MS = 300;

/** The terminal's own highlight, which is not a grep: each call walks the scrollback inside the
 *  webview to rebuild the decoration set, so it wants a window — but a short one. At the grep's
 *  300ms the highlight visibly trails the character being typed, which is the whole feature. */
export const SEARCH_HIGHLIGHT_MS = 120;
