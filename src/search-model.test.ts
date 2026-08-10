import { expect, test } from 'bun:test';

import { highlightLine, type SpanLine } from '@/ansi-spans';
import {
  HIT_AFTER,
  HIT_BEFORE,
  metaMatches,
  normalizeQuery,
  parseSearchOutput,
  searchPaneCommand,
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
  expect(searchPaneCommand(3, 'deploy')).toBe(
    `tmux capture-pane -p -e -S - -t :3 | grep -i -F -n -m1 -B${HIT_BEFORE} -A${HIT_AFTER} 'deploy' 2>/dev/null; true`,
  );
  // shellQuote's contract: a quote in the query cannot escape the quoting.
  expect(searchPaneCommand(0, "it's")).toContain(`'it'\\''s'`);
  expect(() => searchPaneCommand(1.5, 'x')).toThrow();
  expect(() => searchPaneCommand(-1, 'x')).toThrow();
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
  expect(windowSurvives(win(), 'deploy', undefined)).toBe(false); // not answered yet: not shown yet
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
