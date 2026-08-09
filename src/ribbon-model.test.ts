/** `bun test` — the context ribbon's decisions (T11): recipe selection, the suspended-job
 *  machine, per-instance dismissal identity, the timer, the cap bytes, kill-force. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  RIBBON_IDLE,
  Z_CANDIDATE_MS,
  formatElapsed,
  killCommand,
  matchRecipe,
  ribbonDismiss,
  ribbonPoll,
  ribbonResumed,
  ribbonSent,
  selectRecipe,
  type RibbonCore,
} from '@/ribbon-model';
import { RECIPES } from '@/ribbon-recipes';

const fg = (command: string, pid = 4242) => ({ command, pid });

/** A core that has been watching `command` run since t=1000. */
function running(command: string): RibbonCore {
  return ribbonPoll(RIBBON_IDLE, fg(command), 1000);
}

/* --- the selection table (§4.4) --- */

test('recipe selection: names, running, and the silences', () => {
  // Name matches win, alt screen or not.
  for (const name of ['vim', 'nvim', 'vi']) {
    expect(selectRecipe(running(name), true)).toEqual({ id: 'vim', proc: name });
  }
  for (const name of ['less', 'man', 'bat', 'delta']) {
    expect(selectRecipe(running(name), true)?.id).toBe('pager');
  }
  for (const name of ['htop', 'top', 'btop']) {
    expect(selectRecipe(running(name), true)?.id).toBe('htop');
  }
  for (const name of ['claude', 'codex', 'aider', 'gemini']) {
    expect(selectRecipe(running(name), false)?.id).toBe('agent');
  }
  // Non-shell, no alt screen → running.
  expect(selectRecipe(running('cargo'), false)).toEqual({ id: 'running', proc: 'cargo' });
  expect(selectRecipe(running('sleep'), false)?.id).toBe('running');
  // REPLs at their prompt → nothing (they would otherwise read as running).
  for (const name of ['python', 'node', 'irb', 'psql']) {
    expect(selectRecipe(running(name), false)).toBeNull();
  }
  // An unknown TUI (alt screen, unmatched name) → nothing.
  expect(selectRecipe(running('nethack'), true)).toBeNull();
  // Idle shell: the poll already reports null, nothing to select.
  expect(selectRecipe(RIBBON_IDLE, false)).toBeNull();
});

/* --- instance identity + the timer --- */

test('a quiet poll is the same instance, the same object', () => {
  const core = running('cargo');
  expect(ribbonPoll(core, fg('cargo'), 3000)).toBe(core); // identity: no re-render
  expect(core.startedAt).toBe(1000);
});

test('a new foreground is a new instance with a fresh timer', () => {
  const core = running('cargo');
  const next = ribbonPoll(core, fg('vim'), 5000);
  expect(next.instance).toBe(core.instance + 1);
  expect(next.startedAt).toBe(5000);
});

test('the same command through an idle gap is a new instance', () => {
  const core = running('vim');
  const idle = ribbonPoll(core, null, 3000);
  expect(selectRecipe(idle, false)).toBeNull();
  const again = ribbonPoll(idle, fg('vim'), 5000);
  expect(again.instance).toBe(core.instance + 2 - 1); // idle did not bump, the return did
  expect(again.instance).toBeGreaterThan(core.instance);
  expect(again.startedAt).toBe(5000);
});

test('formatElapsed', () => {
  expect(formatElapsed(0)).toBe('0:00');
  expect(formatElapsed(61_000)).toBe('1:01');
  expect(formatElapsed(600_000)).toBe('10:00');
  expect(formatElapsed(-5)).toBe('0:00');
});

/* --- the suspended machine --- */

test('^Z then a shell poll = suspended; without the ^Z it just exited', () => {
  const core = running('sleep');
  const zed = ribbonSent(core, '\x1a', 2000);
  const stopped = ribbonPoll(zed, null, 3000);
  expect(selectRecipe(stopped, false)).toEqual({ id: 'suspended', proc: 'sleep' });
  expect(stopped.instance).toBe(core.instance + 1); // the stop is its own instance

  const exited = ribbonPoll(core, null, 3000); // no ^Z was ever sent
  expect(selectRecipe(exited, false)).toBeNull();
});

test('a stale ^Z candidate expires', () => {
  const zed = ribbonSent(running('sleep'), '\x1a', 2000);
  const late = ribbonPoll(zed, null, 2000 + Z_CANDIDATE_MS + 1);
  expect(selectRecipe(late, false)).toBeNull();
});

test('^Z at an idle shell tracks nothing', () => {
  expect(ribbonSent(RIBBON_IDLE, '\x1a', 1000)).toBe(RIBBON_IDLE);
});

test('other bytes track nothing', () => {
  const core = running('sleep');
  expect(ribbonSent(core, 'ls -la\r', 2000)).toBe(core);
});

test('fg cap clears the stop now; the poll seeing it back in front clears it too', () => {
  const stopped = ribbonPoll(ribbonSent(running('sleep'), '\x1a', 2000), null, 3000);
  const resumed = ribbonResumed(stopped);
  expect(selectRecipe(resumed, false)).toBeNull();
  // The other path: the user typed `fg` themselves and the poll noticed.
  const polledBack = ribbonPoll(stopped, fg('sleep'), 5000);
  expect(polledBack.suspended).toBeNull();
  expect(selectRecipe(polledBack, false)?.id).toBe('running');
});

test('resume on a core with nothing suspended is a no-op', () => {
  const core = running('cargo');
  expect(ribbonResumed(core)).toBe(core);
});

/* --- dismissal --- */

test('swipe-down dismisses this instance; the next process brings the ribbon back', () => {
  const core = running('vim');
  const gone = ribbonDismiss(core);
  expect(selectRecipe(gone, true)).toBeNull();
  expect(ribbonPoll(gone, fg('vim'), 3000)).toBe(gone); // same instance stays gone
  const next = ribbonPoll(ribbonPoll(gone, null, 4000), fg('vim'), 6000);
  expect(selectRecipe(next, true)?.id).toBe('vim');
});

/* --- cap bytes (the data the taps send) --- */

test('cap byte sequences', () => {
  const cap = (id: keyof typeof RECIPES, label: string) =>
    RECIPES[id].caps.find((c) => c.label === label)!;
  // vim, Esc-prefixed so insert mode obeys (§4.4).
  expect(cap('vim', ':w').bytes).toBe('\x1b:w\r');
  expect(cap('vim', ':q').bytes).toBe('\x1b:q\r');
  expect(cap('vim', 'ZZ').bytes).toBe('\x1bZZ');
  expect(cap('vim', ':q!').bytes).toBe('\x1b:q!\r');
  expect(cap('vim', ':q!').danger).toBe(true);
  // htop's F9 is the xterm function-key sequence.
  expect(cap('htop', 'F9').bytes).toBe('\x1b[20~');
  // control bytes.
  expect(cap('running', '^C').bytes).toBe('\x03');
  // pager search raises the keyboard.
  expect(cap('pager', '/').focus).toBe(true);
  // agent interrupt is a bare ESC.
  expect(cap('agent', '⎋').bytes).toBe('\x1b');
});

test('matchRecipe misses cleanly', () => {
  expect(matchRecipe('cargo')).toBeNull();
  expect(matchRecipe('fish')).toBeNull();
});

/* --- kill force --- */

test('killCommand: pgrep the pane shell, kill -9, integers only', () => {
  expect(killCommand(1234)).toBe('pgrep -P 1234 | xargs kill -9 2>/dev/null; true');
  expect(() => killCommand(1.5)).toThrow();
  expect(() => killCommand(-1)).toThrow();
  expect(() => killCommand(NaN)).toThrow();
});
