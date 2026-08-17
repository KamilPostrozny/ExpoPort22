import { expect, test } from 'bun:test';

import { highlightLine, type SpanLine } from '@/ansi-spans';
import {
  HIT_AFTER,
  HIT_BEFORE,
  metaMatches,
  normalizeQuery,
  parseSearchOutput,
  parseWindowSearch,
  searchLabel,
  searchPaneCommand,
  searchWindowCommand,
  windowSurvives,
} from '@/search-model';
import type { TmuxWindow } from '@/tmux-model';

const win = (over: Partial<TmuxWindow> = {}): TmuxWindow => ({
  id: '@1',
  index: 1,
  name: 'fish',
  active: false,
  path: '/home/kamil/port22',
  width: 80,
  command: 'cargo',
  ...over,
});

/* --- metadata half --- */

test('metadata match: name, path, process, case-insensitive substring', () => {
  expect(metaMatches(win(), 'FISH')).toBe(true);
  expect(metaMatches(win(), 'port22')).toBe(true);
  expect(metaMatches(win(), 'cargo')).toBe(true);
  expect(metaMatches(win(), 'deploy')).toBe(false);
  expect(metaMatches(win(), '')).toBe(false); // empty query matches nothing, not everything
  expect(metaMatches(win(), '  ')).toBe(false);
  // The three fields are joined with a separator no query can straddle.
  expect(metaMatches(win({ name: 'fi' }), 'fi/home')).toBe(false);
});

/* --- the host-side grep --- */

test('search command: whole scrollback, first hit only, quoted query', () => {
  expect(searchPaneCommand('@3', 'deploy')).toBe(
    `tmux capture-pane -p -e -S - -t @3 | grep -i -F -n -m1 -B${HIT_BEFORE} -A${HIT_AFTER} 'deploy' 2>/dev/null; true`,
  );
  // shellQuote's contract: a quote in the query cannot escape the quoting.
  expect(searchPaneCommand('@0', "it's")).toContain(`'it'\\''s'`);
});

// The grep is targeted by tmux's `@N` id, through the one `target` guard the other window commands
// share — never `-t :index`. Here the bug wears a different face than a mis-aimed kill: an index
// that slid under a renumber, or one that falls through to a window NAMED like it, greps the wrong
// scrollback (or none), and the switcher's per-window catch renders that as "no hit".
test('search command targets the window id, and rejects anything that is not one', () => {
  expect(searchPaneCommand('@31', 'x')).toContain('-t @31 |');
  expect(searchPaneCommand('@31', 'x')).not.toContain('-t :');
  for (const bad of ['5', ':5', '@', '@5x', '', '@5;rm -rf /', 'fish']) {
    expect(() => searchPaneCommand(bad, 'x')).toThrow();
  }
});

test('grep output parses into context lines with the hit line marked', () => {
  const hit = parseSearchOutput('41-  Compiling tokio\n42:POST /hooks/deploy 502\n43-GET /healthz 200\n');
  expect(hit).toEqual({
    lines: ['  Compiling tokio', 'POST /hooks/deploy 502', 'GET /healthz 200'],
    hitLine: 1,
  });
  // Line numbers ≥ 10 digits and escape-prefixed content both strip clean.
  const esc = parseSearchOutput('1234567890:\x1b[32mdeploy\x1b[0m ok\n');
  expect(esc).toEqual({ lines: ['\x1b[32mdeploy\x1b[0m ok'], hitLine: 0 });
  expect(parseSearchOutput('')).toBeNull(); // no hit
  expect(parseSearchOutput('  \n')).toBeNull();
});

test('a window survives on either half of the match', () => {
  const hit = { lines: ['x'], hitLine: 0 };
  expect(windowSurvives(win(), 'fish', undefined)).toBe(true); // metadata, grep still in flight
  expect(windowSurvives(win(), 'deploy', hit)).toBe(true); // scrollback only
  expect(windowSurvives(win(), 'deploy', null)).toBe(false); // grep answered: nothing
  // Held until the grep answers: a card leaves on a `null`, never on a pending `undefined`, so the
  // grid narrows one answer at a time instead of emptying and refilling on the first keystroke.
  expect(windowSurvives(win(), 'deploy', undefined)).toBe(true);
});

// The correctness half of the channel-saturation fix (emulator, 2026-08-17): a grep that never
// answered must not read as "nothing here". Only grep's own `null` may take a card out of a
// filtered grid.
test('a window whose grep failed stays in the grid', () => {
  expect(windowSurvives(win(), 'deploy', 'failed')).toBe(true);
  expect(windowSurvives(win({ name: 'x', path: '/x', command: 'x' }), 'deploy', 'failed')).toBe(
    true,
  );
});

/* --- the terminal view's half: one window, every occurrence (BUGS.md §6) --- */

test('window search: the whole history counted, the visible screen located, one exec', () => {
  const cmd = searchWindowCommand('@3', 'deploy');
  // The window names itself back first: a capture of a window that is GONE leaves `wc -l` printing
  // a perfectly parseable `0`, and "no hits here" is not what a search that missed its window may
  // say. `#{window_id}` is empty for a dead target, so the answer stops parsing instead.
  expect(cmd.startsWith(`tmux display-message -p -t @3 '#{window_id}'; `)).toBe(true);
  // The count is over `-S -` (history + screen) and counts OCCURRENCES, not lines: `grep -c` would
  // report a line holding the query twice as one, which is not what the label divides by.
  expect(cmd).toContain(`tmux capture-pane -p -S - -t @3 | grep -o -i -F -e 'deploy' | wc -l;`);
  // The positions come from the visible screen alone — the reason 50k lines never cross the bridge.
  expect(cmd).toContain(`tmux capture-pane -p -t @3 | grep -n -i -F -e 'deploy'`);
  // No colours on either capture: escapes would split a hit mid-word AND move every column.
  expect(cmd).not.toContain('-e -S');
  expect(cmd).not.toContain('-J');
  expect(searchWindowCommand('@0', "it's")).toContain(`'it'\\''s'`); // shellQuote's contract
});

test('window search targets the window id, and rejects anything that is not one', () => {
  expect(searchWindowCommand('@31', 'x')).not.toContain('-t :');
  for (const bad of ['5', ':5', '@', '@5x', '', '@5;rm -rf /', 'fish']) {
    expect(() => searchWindowCommand(bad, 'x')).toThrow();
  }
});

test('window search output: the count, then every position on the screen', () => {
  const out = ['@3', '1284', '3:deploy started', '7:  re-deploy failed after deploy', ''].join('\n');
  expect(parseWindowSearch(out, 'deploy')).toEqual({
    total: 1284,
    // grep counts lines from 1, the screen's top row is 0; two occurrences in one line are two
    // hits, at the columns they actually sit at.
    onScreen: [
      { row: 2, col: 0 },
      { row: 6, col: 5 },
      { row: 6, col: 25 },
    ],
  });
});

test('window search output: case-insensitive, no hits, and a broken exec', () => {
  expect(parseWindowSearch('@3\n2\n1:Deploy and DEPLOY\n', 'deploy')).toEqual({
    total: 2,
    onScreen: [
      { row: 0, col: 0 },
      { row: 0, col: 11 },
    ],
  });
  // `wc -l` always prints a number, so 0 is grep's own honest answer: nothing in this window.
  expect(parseWindowSearch('@3\n0\n', 'deploy')).toEqual({ total: 0, onScreen: [] });
  // Anything that is not a number first is an exec that did not run — NOT "no hits" (the
  // distinction the grid's `'failed'` draws, and the reason `searchWindow` throws on null).
  for (const broken of ['', 'bash: tmux: not found\n', "can't find window: @9\n", '@3\n']) {
    expect(parseWindowSearch(broken, 'deploy')).toBeNull();
  }
  // The window that was killed under the search: tmux prints nothing for its id, `wc -l` prints a
  // flawless 0, and the answer is 'we could not ask' — never 'there is nothing there'.
  expect(parseWindowSearch('\n0\n', 'deploy')).toBeNull();
  expect(parseWindowSearch('@3\n7\n', '  ')).toBeNull(); // an empty query is not a search
});

test('a screen that scrolled between the two captures never reports more hits than it counted', () => {
  const raced = parseWindowSearch('@3\n1\n1:deploy\n2:deploy\n', 'deploy');
  expect(raced?.total).toBe(2);
  expect(searchLabel(raced, 0)).toBe('1/2');
});

/* --- the label: two scopes, one number (BUGS.md §6) --- */

test('the count is the true count, and the index says how much of it is out of reach', () => {
  const hit = (row: number) => ({ row, col: 0 });
  // The on-screen hits are the LAST n of the total (the screen is the tail of the capture), so the
  // index is the hit's place in the WHOLE window: 1264 hits sit above this one, in tmux's history.
  const flood = { total: 1284, onScreen: [hit(0), hit(1), hit(2)] };
  expect(searchLabel(flood, 0)).toBe('1282/1284');
  expect(searchLabel(flood, 2)).toBe('1284/1284');
  // Everything reachable: the index and the count mean what they always did, and say nothing extra.
  expect(searchLabel({ total: 3, onScreen: [hit(0), hit(1), hit(2)] }, 1)).toBe('2/3');
  expect(searchLabel({ total: 0, onScreen: [] }, 0)).toBe('none');
  // The one state the index cannot speak for, and the only survivor of the old `on screen` suffix:
  // the hits are real and every one of them is up in the history, so there is nothing to step to.
  expect(searchLabel({ total: 1284, onScreen: [] }, 0)).toBe('1284, none on screen');
  // Not asked yet vs asked and unreachable — never the same as "none".
  expect(searchLabel(null, 0)).toBe('');
  expect(searchLabel('failed', 0)).toBe('failed');
  // A stale `at` (the answer landed with fewer hits than the last step reached) clamps, never
  // prints a position past the count.
  expect(searchLabel({ total: 9, onScreen: [hit(0)] }, 7)).toBe('9/9');
});

/* --- the highlight surgery (ansi-spans) --- */

const span = (text: string, fg: number | null = null): SpanLine[number] => ({
  text,
  fg,
  bg: null,
  bold: false,
  underline: false,
  italic: false,
  inverse: false,
  dim: false,
});

test('highlight marks every occurrence, splitting spans at the boundaries', () => {
  const out = highlightLine([span('deploy the deploy')], 'deploy');
  expect(out).toEqual([
    { ...span('deploy'), hl: true },
    span(' the '),
    { ...span('deploy'), hl: true },
  ]);
});

test('a hit split by a mid-word colour change highlights whole, colours kept', () => {
  const out = highlightLine([span('dep', 2), span('loy now', 3)], 'deploy');
  expect(out).toEqual([
    { ...span('dep', 2), hl: true },
    { ...span('loy', 3), hl: true },
    span(' now', 3),
  ]);
});

test('highlight is case-insensitive and leaves miss lines untouched (same array)', () => {
  const line = [span('Deploy')];
  expect(highlightLine(line, 'deploy')[0].hl).toBe(true);
  const miss = [span('nothing here')];
  expect(highlightLine(miss, 'deploy')).toBe(miss);
  expect(highlightLine(miss, '')).toBe(miss);
});

test('normalize: trim and lowercase, the one spelling both views share', () => {
  expect(normalizeQuery('  DePloy ')).toBe('deploy');
});
