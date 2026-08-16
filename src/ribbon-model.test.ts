/** `bun test` — the edge handle's decisions (T11): recipe selection, the suspended-job
 *  machine, per-instance identity, the timer, the cap bytes, kill-force. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  RIBBON_HOLD_MS,
  RIBBON_IDLE,
  RIBBON_MIN_RUN_MS,
  Z_CANDIDATE_MS,
  formatElapsed,
  killCommand,
  matchRecipe,
  ribbonPoll,
  ribbonResumed,
  ribbonSwitchedToIdle,
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

/** `selectRecipe` with the clock already past `RIBBON_MIN_RUN_MS` — every test but the gate's
 *  own is about WHICH recipe, not when. */
const pick = (core: RibbonCore, altScreen: boolean, now = 1_000_000) =>
  selectRecipe(core, altScreen, now);

/* --- the selection table (§4.4) --- */

test('recipe selection: names, running, and the silences', () => {
  // Name matches win, alt screen or not.
  for (const name of ['vim', 'nvim', 'vi']) {
    expect(pick(running(name), true)).toEqual({ id: 'vim', proc: name });
  }
  for (const name of ['less', 'man', 'bat', 'delta']) {
    expect(pick(running(name), true)?.id).toBe('pager');
  }
  for (const name of ['htop', 'top', 'btop']) {
    expect(pick(running(name), true)?.id).toBe('htop');
  }
  for (const name of ['claude', 'codex', 'aider', 'gemini']) {
    expect(pick(running(name), false)?.id).toBe('agent');
  }
  // Non-shell, no alt screen → running.
  expect(pick(running('cargo'), false)).toEqual({ id: 'running', proc: 'cargo' });
  expect(pick(running('sleep'), false)?.id).toBe('running');
  // REPLs at their prompt → nothing (they would otherwise read as running).
  for (const name of ['python', 'node', 'irb', 'psql']) {
    expect(pick(running(name), false)).toBeNull();
  }
  // An unknown TUI (alt screen, unmatched name) → nothing.
  expect(pick(running('nethack'), true)).toBeNull();
  // Idle shell: the poll already reports null, nothing to select.
  expect(pick(RIBBON_IDLE, false)).toBeNull();
});

test('a short-lived command never earns the band; a slow one does', () => {
  const core = running('git'); // startedAt = 1000
  expect(selectRecipe(core, false, 1000)).toBeNull();
  expect(selectRecipe(core, false, 1000 + RIBBON_MIN_RUN_MS - 1)).toBeNull();
  expect(selectRecipe(core, false, 1000 + RIBBON_MIN_RUN_MS)?.id).toBe('running');
  // The gate is `running`'s alone: something the user opened on purpose shows at once.
  expect(selectRecipe(running('vim'), true, 1000)?.id).toBe('vim');
  expect(selectRecipe(running('claude'), false, 1000)?.id).toBe('agent');
  // So does a job we watched stop — it has been alive by definition.
  const stopped = { ...running('sleep'), suspended: 'sleep', command: null };
  expect(selectRecipe(stopped, false, 1000)?.id).toBe('suspended');
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

test('the same command through a real idle gap is a new instance', () => {
  const core = running('vim');
  // One null is not "gone" yet — it starts the hold. Only a null that outlives RIBBON_HOLD_MS
  // clears the command.
  const blink = ribbonPoll(core, null, 3000);
  expect(pick(blink, false)?.id).toBe('vim');
  const idle = ribbonPoll(blink, null, 3000 + RIBBON_HOLD_MS);
  expect(pick(idle, false)).toBeNull();
  const again = ribbonPoll(idle, fg('vim'), 9000);
  expect(again.instance).toBeGreaterThan(core.instance);
  expect(again.startedAt).toBe(9000);
});

test('a blinking poll is the same run: same instance, same clock, no re-render', () => {
  // The device case that motivated the hold: an untargeted `display-message` answers about
  // another window every other beat, so the foreground reads claude / null / claude / null.
  const core = running('claude');
  const blink = ribbonPoll(core, null, 2000);
  const back = ribbonPoll(blink, fg('claude'), 3000);
  expect(back.instance).toBe(core.instance); // NOT a new run
  expect(back.startedAt).toBe(core.startedAt); // so the clock never restarts
  expect(pick(back, false)?.id).toBe('agent');
  // And a second quiet beat is the same object again, so React re-renders nothing.
  expect(ribbonPoll(back, fg('claude'), 5000)).toBe(back);
  // The gate can therefore actually elapse — this is why `sleep` never appeared.
  const slow = ribbonPoll(ribbonPoll(running('sleep'), null, 2000), fg('sleep'), 3000);
  expect(selectRecipe(slow, false, 1000 + RIBBON_MIN_RUN_MS)?.id).toBe('running');
});

test('hopping away and back keeps the clock: same pid is the same run', () => {
  // The device symptom: the chip sat at 0:00 forever, because a hop names the command from the
  // window list with NO pid, which read as a brand-new foreground every time.
  const core = ribbonPoll(RIBBON_IDLE, fg('claude', 4242), 1000);
  const away = ribbonSwitchedToIdle(core);
  const back = ribbonPoll(away, { command: 'claude', pid: null }, 60_000); // the hop: no pid yet
  const settled = ribbonPoll(back, fg('claude', 4242), 62_000); // the poll fills it in
  expect(settled.startedAt).toBe(1000); // 61 seconds of uptime, not 0:00
  expect(formatElapsed(62_000 - settled.startedAt)).toBe('1:01');

  // A DIFFERENT window running the same command is still a different run — the pid says so.
  const elsewhere = ribbonPoll(back, fg('claude', 9999), 62_000);
  expect(elsewhere.startedAt).toBe(60_000);
});

test('a window hop to an idle window drops the band now, without waiting out the hold', () => {
  const core = running('claude');
  const left = ribbonSwitchedToIdle(core);
  expect(pick(left, false)).toBeNull();
  expect(ribbonSwitchedToIdle(left)).toBe(left); // already idle: the same object
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
  expect(pick(stopped, false)).toEqual({ id: 'suspended', proc: 'sleep' });
  expect(stopped.instance).toBe(core.instance + 1); // the stop is its own instance

  // No ^Z was ever sent: it exited, which takes one null to notice and the hold to believe.
  const exited = ribbonPoll(ribbonPoll(core, null, 3000), null, 3000 + RIBBON_HOLD_MS);
  expect(pick(exited, false)).toBeNull();
});

test('a stale ^Z candidate expires', () => {
  const zed = ribbonSent(running('sleep'), '\x1a', 2000);
  const gone = 2000 + Z_CANDIDATE_MS + 1;
  // Too late to be a suspension, so it is an exit — and an exit still has to outlive the hold.
  const late = ribbonPoll(ribbonPoll(zed, null, gone), null, gone + RIBBON_HOLD_MS);
  expect(pick(late, false)).toBeNull();
  expect(late.suspended).toBeNull();
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
  expect(pick(resumed, false)).toBeNull();
  // The other path: the user typed `fg` themselves and the poll noticed.
  const polledBack = ribbonPoll(stopped, fg('sleep'), 5000);
  expect(polledBack.suspended).toBeNull();
  expect(pick(polledBack, false)?.id).toBe('running');
});

test('resume on a core with nothing suspended is a no-op', () => {
  const core = running('cargo');
  expect(ribbonResumed(core)).toBe(core);
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
  // htop's F6/F9 are the xterm function-key sequences.
  expect(cap('htop', 'F6').bytes).toBe('\x1b[17~');
  expect(cap('htop', 'F9').bytes).toBe('\x1b[20~');
  // control bytes.
  expect(cap('running', '^C').bytes).toBe('\x03');
  // pager search raises the keyboard.
  expect(cap('pager', '/').focus).toBe(true);
  // agent: bare ESC to stop, shift-tab for plan mode, slash commands typed and entered,
  // and the two-tap quit arms.
  expect(cap('agent', '⎋').bytes).toBe('\x1b');
  expect(cap('agent', '⇧⇥').bytes).toBe('\x1b[Z');
  expect(cap('agent', '/clear').bytes).toBe('/clear\r');
  expect(cap('agent', '^C ^C')).toMatchObject({ bytes: '\x03', arm: true, danger: true });
  // One flat row: every entry is a tap, no section markers eating 44pt of thumb reach.
  expect(RECIPES.agent.caps.every((c) => c.label !== undefined)).toBe(true);
  expect(RECIPES.agent.caps.length).toBe(10);
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

// A window switch names the command before any poll can name the pid — the handle changes with
// the slide, not a poll beat after it.
test('a switch names the command, the next poll fills in the pid without restarting it', () => {
  const switched = ribbonPoll(RIBBON_IDLE, { command: 'htop', pid: null }, 1000);
  expect(switched).toMatchObject({ command: 'htop', pid: null, startedAt: 1000 });

  const polled = ribbonPoll(switched, { command: 'htop', pid: 42 }, 4000);
  expect(polled).toMatchObject({ command: 'htop', pid: 42 });
  expect(polled.instance).toBe(switched.instance); // same process: the timer carries on
  expect(polled.startedAt).toBe(1000);

  // A quiet beat after that is still the same object, as for any other poll.
  expect(ribbonPoll(polled, { command: 'htop', pid: 42 }, 6000)).toBe(polled);
});

test('switching to a window running the same command is a new instance, not a continuation', () => {
  const first = ribbonPoll(RIBBON_IDLE, { command: 'htop', pid: 42 }, 1000);
  const second = ribbonPoll(first, { command: 'htop', pid: null }, 5000);
  expect(second.instance).toBe(first.instance + 1);
  expect(second.startedAt).toBe(5000);
  expect(second.pid).toBeNull(); // never the other window's pid — the Kill cap stays inert
});
