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
  ribbonAppearDelay,
  ribbonPoll,
  ribbonResumed,
  ribbonSwitchedToIdle,
  ribbonSent,
  selectRecipe,
  type RibbonCore,
} from '@/ribbon-model';
import { RECIPES } from '@/ribbon-recipes';
import { SEP, foregroundFrom, parsePoll } from '@/tmux-model';

const fg = (command: string, pid = 4242) => ({ command, pid });

/** A core that has been watching `command` run since t=1000. */
function running(command: string): RibbonCore {
  return ribbonPoll(RIBBON_IDLE, fg(command), 1000);
}

/** `selectRecipe` no longer takes a clock — the appear delay is `ribbonAppearDelay`, served by a
 *  timer inside the band. These tests are about WHICH recipe. The flag is the PANE's
 *  `#{alternate_on}`, not the outer terminal's buffer type. */
const pick = (core: RibbonCore, paneAlt: boolean) => selectRecipe(core, { paneAlt });

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

test('a run that never changes still earns the band: the gate is a delay, not a render-time clock', () => {
  // The device symptom (emulator, 2026-08-17): `sleep 30` and `sleep 15`, twice each, all four
  // detected — `[ribbon] run #2 sleep pid=… startedAt=…` — and the chip region empty at every one
  // of 40 samples across a full 30s run. The gate used to be `now - startedAt < RIBBON_MIN_RUN_MS`
  // inside `selectRecipe`, which the screen called as `selectRecipe(core, altScreen, Date.now())`
  // from a component body the React Compiler caches on `[connected, core, modes]`. A clock is not
  // a dependency, and a running job changes nothing else:
  const core = running('sleep'); // startedAt = 1000
  expect(ribbonPoll(core, fg('sleep'), 3000)).toBe(core); // by design: a quiet beat re-renders nothing
  expect(ribbonPoll(core, fg('sleep'), 1000 + RIBBON_MIN_RUN_MS + 60_000)).toBe(core);
  // …and `set` in src/tmux.ts drops an identical answer before it even gets here. So nothing can
  // re-open a gate that lives on the clock, and the model must not hide a live run behind one.
  // The signature no longer has a clock to be cached against, so the memoised call is correct
  // whenever it is served — which is the point.
  expect(selectRecipe(core, { paneAlt: false })).toEqual({ id: 'running', proc: 'sleep' });

  // The three seconds survive as a delay the band serves itself, off one timer per run.
  expect(ribbonAppearDelay('running')).toBe(RIBBON_MIN_RUN_MS);
  // The gate is `running`'s alone: something the user opened on purpose shows at once…
  for (const id of ['vim', 'pager', 'htop', 'agent', 'suspended'] as const) {
    expect(ribbonAppearDelay(id)).toBe(0);
  }
  expect(selectRecipe(running('vim'), { paneAlt: true })?.id).toBe('vim');
  expect(selectRecipe(running('claude'), { paneAlt: false })?.id).toBe('agent');
  // …as does a job we watched stop — it has been alive by definition.
  const stopped = { ...running('sleep'), suspended: 'sleep', command: null };
  expect(selectRecipe(stopped, { paneAlt: false })?.id).toBe('suspended');
});

test('the TUI gate reads the PANE, not the outer terminal — `running` inside tmux', () => {
  // The second, independent blocker (emulator, 2026-08-17): `sleep 30` detected, chip region empty
  // at all 15 samples across two runs, with the fixed appear-delay already in. The gate was fed
  // T6's `modes.altScreen`, the OUTER xterm's buffer type — and a tmux client is itself a
  // full-screen app, so that flag is permanently true for the whole session (every connect's mode
  // log ends `{"altScreen":true,…}` and never flips back). `running` was therefore unreachable in
  // every tmux session, i.e. in the app's own default start mode.
  //
  // This is the exact combination, end to end from a real tmux answer: pane flag 0 while the outer
  // one is 1.
  const answer = parsePoll(['1', '3', '4242', '0', 'sleep'].join(SEP));
  expect(answer?.paneAlt).toBe(false);
  const core = ribbonPoll(RIBBON_IDLE, foregroundFrom(answer)!, 1000);
  expect(selectRecipe(core, answer!)).toEqual({ id: 'running', proc: 'sleep' });
  // …and the outer flag, which is what used to be passed here, still swallows it. That is the bug.
  expect(selectRecipe(core, { paneAlt: true })).toBeNull();

  // §4.4 intact: a real full-screen TUI in the pane still gets no chip, because no caps beat wrong
  // caps. Only the SOURCE of the fact changed.
  const tui = parsePoll(['1', '3', '4242', '1', 'nethack'].join(SEP));
  expect(tui?.paneAlt).toBe(true);
  const inTui = ribbonPoll(RIBBON_IDLE, foregroundFrom(tui)!, 1000);
  expect(selectRecipe(inTui, tui!)).toBeNull();
  // A named recipe wins before the gate either way — which is why `vim` had its chip all along.
  const vim = parsePoll(['1', '3', '4242', '1', 'vim'].join(SEP));
  const inVim = ribbonPoll(RIBBON_IDLE, foregroundFrom(vim)!, 1000);
  expect(selectRecipe(inVim, vim!)?.id).toBe('vim');
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
  // And a blink no longer restarts `startedAt`, which is what the band's own gate timer counts
  // from — the blink was one of the two things keeping `sleep` off the screen (the other is the
  // memoised gate, in the test above).
  const slow = ribbonPoll(ribbonPoll(running('sleep'), null, 2000), fg('sleep'), 3000);
  expect(slow.startedAt).toBe(1000);
  expect(selectRecipe(slow, { paneAlt: false })?.id).toBe('running');
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

test('a birth clears the band now; the poll-shaped null the swipe used to send would not', () => {
  // Committing a bar swipe past the last tab births a window, and a window being created cannot be
  // running anything — so the birth is a hop to an idle window, not an observation of one.
  const core = running('claude');
  // What it used to send: a poll's null, which `RIBBON_HOLD_MS` exists to disbelieve. The chip
  // keeps the previous window's run and its clock…
  const held = ribbonPoll(core, null, 2000);
  expect(pick(held, false)?.id).toBe('agent');
  // …and needs a SECOND null to clear, which is what the screen's hold timer keys on. Nothing in
  // the poll guarantees one: tmux's store drops an answer identical to the last, so a foreground
  // that has settled at null stops waking the reducer at all.
  expect(held.goneAt).toBe(2000);
  expect(ribbonPoll(held, null, 2000 + RIBBON_HOLD_MS).command).toBeNull();
  // The birth needs none of that: it knows.
  expect(pick(ribbonSwitchedToIdle(core), false)).toBeNull();
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
