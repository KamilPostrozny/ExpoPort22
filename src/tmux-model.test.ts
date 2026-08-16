/** `bun test` — the tmux side-channel's decisions (T9). Everything here is pure: the conf the app
 *  pushes, the commands it sends down exec channels, and the parsers reading the answers. The
 *  commands themselves were additionally run through `fish -c` verbatim during development — the
 *  fish-parses-it half of every claim is measured, not assumed. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  APPLY_AND_VERIFY,
  FAST_POLL_MS,
  FAST_POLL_TICKS,
  CONF_MARKER,
  CONF_PATH,
  CONF_VERSION,
  LIST_SESSIONS,
  LIST_WINDOWS,
  NEW_WINDOW,
  POLL,
  POLL_MS,
  PROBE,
  SEP,
  capturePaneCommand,
  deriveConfigStatus,
  foregroundFrom,
  generateConf,
  killWindowCommand,
  moveWindowCommand,
  needsPush,
  parsePoll,
  parseProbe,
  parseSessions,
  parseVerify,
  parseWindows,
  pollDelay,
  readFileCommand,
  selectWindowCommand,
  shellQuote,
  tabsAvailable,
  tabsHint,
} from '@/tmux-model';
import * as model from '@/tmux-model';

/* --- the conf file --- */

test('the required half is in the conf whether or not the comforts are', () => {
  for (const conf of [generateConf(true), generateConf(false)]) {
    expect(conf.startsWith(`${CONF_MARKER}\n`)).toBe(true); // the human-readable version stamp
    expect(conf).toContain(`set -g @port22 ${CONF_VERSION}`); // the verify handle
    expect(conf).toContain('set -g mouse on');
    expect(conf).toContain('set -g set-clipboard on'); // OSC 52, half one
    expect(conf).toContain(`Ms=\\E]52;%p1%s;%p2%s\\007`); // OSC 52, half two: the Ms capability
    // One line per notch, both copy-mode flavours (§4.3): vi and emacs, up and down.
    for (const table of ['copy-mode ', 'copy-mode-vi']) {
      for (const wheel of ['WheelUpPane', 'WheelDownPane']) {
        expect(conf).toMatch(
          new RegExp(`bind -T ${table.trim()}\\s+${wheel}\\s+send -N1 -X scroll-`),
        );
      }
    }
    // The root table, where a notch arrives before anything is in copy mode. Without these tmux
    // answers `copy-mode -e` for any app that never asked for the mouse, which on the alternate
    // screen is a pager that will not scroll.
    for (const [wheel, key] of [
      ['WheelUpPane', 'Up'],
      ['WheelDownPane', 'Down'],
    ]) {
      expect(conf).toMatch(new RegExp(`bind -n ${wheel}\\s+if -F .#\\{\\|\\|:`));
      // The mouse-aware app keeps its untouched report, the alt screen gets one key per notch.
      expect(conf).toMatch(new RegExp(`${wheel}[^\\n]*send -M[^\\n]*alternate_on[^\\n]*send -N1 ${key}`));
      // ...and everything else still falls through to tmux's own default.
      expect(conf).toMatch(new RegExp(`${wheel}[^\\n]*copy-mode -e`));
    }
    // Never in either half: nothing here reads a title, and it rewrote every terminal's.
    expect(conf).not.toContain('set-titles');
  }
});

test('the comforts are exactly what the toggle adds, and nothing else moves', () => {
  const on = generateConf(true);
  const off = generateConf(false);
  for (const line of [
    "set -as terminal-features ',*:RGB,*:usstyle'",
    'set -g status off',
    'bind S set -g status',
    'set -s escape-time 0',
    'set -g history-limit 50000',
  ]) {
    expect(on).toContain(line);
    expect(off).not.toContain(line);
  }
  // The one option that can break every pane on the host is the one that asks first.
  expect(on).toContain(
    "if-shell 'infocmp tmux-256color >/dev/null 2>&1' 'set -g default-terminal tmux-256color'",
  );
  expect(on.startsWith(off)).toBe(true); // off is on minus its tail: one seam, no reshuffling
});

test('push decision: fresh, stale, the other half, and current remote content', () => {
  expect(needsPush(null, true)).toBe(true); // nothing there yet
  expect(needsPush('', true)).toBe(true);
  expect(needsPush('# port22-conf-v0\nset -g mouse on\n', true)).toBe(true); // bump replaces
  expect(needsPush(generateConf(true).slice(0, -40), true)).toBe(true); // truncated, same version
  expect(needsPush(generateConf(true), true)).toBe(false); // byte-for-byte current: skip
  // The toggle changes the file without changing the version, which is why the compare is content.
  expect(needsPush(generateConf(true), false)).toBe(true);
  expect(needsPush(generateConf(false), true)).toBe(true);
  expect(needsPush(generateConf(false), false)).toBe(false);
});

test('sessions: names only, tmux’s own chatter dropped', () => {
  // A name may contain spaces — `tmux new -s 'work stuff'`, measured — so only the marker byte
  // tells a row from a diagnostic.
  expect(parseSessions(`${SEP}port22\n${SEP}work stuff\n${SEP}0\n`)).toEqual([
    'port22',
    'work stuff',
    '0',
  ]);
  expect(parseSessions('')).toEqual([]);
  // What a server-less host answers with, on the same stream as the names.
  expect(parseSessions('no server running on /tmp/tmux-1000/default\n')).toEqual([]);
  expect(LIST_SESSIONS).toContain(`-F '${SEP}#{session_name}'`);
});

test('the greyed tabs button names the actual reason, not a generic one', () => {
  // The question that matters: a tmux mode chosen against a host that has no tmux. Sending that
  // user to Settings to "choose a tmux start mode" would be advice they have already taken.
  expect(tabsHint(false, true)).toContain('has not got it');
  expect(tabsHint(false, false)).toContain('has not got it'); // the host still decides first
  expect(tabsHint(true, false)).toContain('Settings');
  expect(tabsHint(null, false)).toContain('Settings'); // probe still out, mode is answer enough
  expect(tabsHint(true, true)).toBe('Waiting for tmux…'); // pushing the conf, or not attached yet
});

/* --- probe / apply / verify --- */

test('probe interpretation: a path means tmux, silence means silence', () => {
  expect(PROBE).toBe('command -v tmux');
  expect(parseProbe('/usr/bin/tmux\n')).toBe(true);
  expect(parseProbe('')).toBe(false);
  expect(parseProbe('  \n')).toBe(false);
});

test('apply and verify travel as one tmux client command', () => {
  // Measured: a session-less server exits with its last client, so a verify in a *second* exec
  // finds "no server running" on exactly the fresh host that matters. One chain keeps it alive.
  expect(APPLY_AND_VERIFY).toBe(
    `tmux start-server \\; source-file ~/${CONF_PATH} \\; show -gv @port22 2>/dev/null; true`,
  );
  expect(parseVerify(`${CONF_VERSION}\n`)).toBe(true);
  expect(parseVerify('')).toBe(false); // no server reachable, or our option never landed
  expect(parseVerify('9000')).toBe(false); // some other build's conf answered
});

test('nothing this app sends writes anywhere outside its own directory', () => {
  // The guard on 2026-08-12's decision: host state must not outlive the session. The app used to
  // append a source-file line to the user's own tmux conf, which was the one permanent edit it
  // made. Any new command that redirects, tees or sed-i's into a path fails here.
  for (const [name, value] of Object.entries(model)) {
    if (typeof value !== 'string') continue;
    expect(`${name} = ${value}`).not.toMatch(/>>|\btee\b|sed -i/);
  }
});

test('file reads come back empty rather than failing on a missing file', () => {
  expect(readFileCommand(`~/${CONF_PATH}`)).toBe(`cat ~/${CONF_PATH} 2>/dev/null; true`);
});

/* --- windows --- */

const line = (fields: string[]) => fields.join(SEP);

test('list-windows output parses, name last so separators in names shift nothing', () => {
  const output = [
    line(['@0', '1', '0', '/home/kamil/dev', '80', 'cargo', 'fish']),
    line(['@3', '2', '1', '/home/kamil', '120', 'vim', `weird${SEP}name: with everything\t`]),
  ].join('\n');
  expect(parseWindows(output)).toEqual([
    { id: '@0', index: 1, active: false, path: '/home/kamil/dev', width: 80, command: 'cargo', name: 'fish' },
    // The name survives with the separator inside it — it is the tail, rejoined.
    { id: '@3', index: 2, active: true, path: '/home/kamil', width: 120, command: 'vim', name: `weird${SEP}name: with everything\t` },
  ]);
});

test('lines that are not windows (tmux diagnostics, junk) never become cards', () => {
  expect(parseWindows('')).toEqual([]);
  expect(parseWindows('no server running on /tmp/tmux-501/default\n')).toEqual([]);
  expect(parseWindows(line(['not-an-id', '1', '0', '/', '80', 'sh', 'x']))).toEqual([]);
  expect(parseWindows(line(['@1', 'NaN', '0', '/', '80', 'sh', 'x']))).toEqual([]);
  // A six-field line is the OLD format — reject rather than misread the command as the name.
  expect(parseWindows(line(['@1', '1', '0', '/', '80', 'x']))).toEqual([]);
});

test('window commands target by validated integer index only', () => {
  expect(selectWindowCommand(3)).toBe('tmux select-window -t :3');
  expect(killWindowCommand(0)).toBe('tmux kill-window -t :0');
  // -e: colours stay escapes. -N: trailing spaces stay too, because they carry the background of
  // a highlighted run that reaches past its last letter.
  expect(capturePaneCommand(2)).toBe('tmux capture-pane -p -e -N -t :2');
  // Always the end of the list, never tmux's lowest free index; quoted so fish leaves `{end}` be.
  expect(NEW_WINDOW).toBe("tmux new-window -a -t ':{end}'");
  // The injection guard: an index is an integer or it is nothing.
  expect(() => selectWindowCommand(1.5)).toThrow();
  expect(() => killWindowCommand(NaN)).toThrow();
  expect(() => capturePaneCommand(-1)).toThrow();
});

test('move-window inserts before when moving down, after when moving up', () => {
  expect(moveWindowCommand(4, 1)).toBe('tmux move-window -b -s :4 -t :1');
  expect(moveWindowCommand(1, 4)).toBe('tmux move-window -a -s :1 -t :4');
});

/* --- the poll --- */

test('poll parse: attached flag, badge index, pid, command-last rejoin', () => {
  const poll = parsePoll(line(['1', '3', '4242', 'vim']) + '\n');
  expect(poll).toEqual({ attached: true, windowIndex: 3, pid: 4242, command: 'vim' });
  expect(parsePoll(line(['0', '1', '99', 'fish']))?.attached).toBe(false);
  expect(parsePoll('')).toBeNull(); // no server = nothing to say (§7: silence, not a message)
  expect(parsePoll('no current client\n')).toBeNull();
});

test('the poll hurries for the attach, settles on it, and gives up hurrying either way', () => {
  expect(pollDelay(false, 0)).toBe(FAST_POLL_MS);
  expect(pollDelay(true, 0)).toBe(POLL_MS); // attached: nothing left to hurry for
  expect(FAST_POLL_MS).toBeLessThan(POLL_MS);
  // A host with tmux under a start mode that never enters it never attaches — the fast phase has
  // to end anyway, or it fast-polls for the life of the session.
  expect(pollDelay(false, FAST_POLL_TICKS - 1)).toBe(FAST_POLL_MS);
  expect(pollDelay(false, FAST_POLL_TICKS)).toBe(POLL_MS);
  expect(pollDelay(false, 9999)).toBe(POLL_MS);
});

test('foreground: shells are idle, everything else is a process for the ribbon', () => {
  const at = (command: string) => ({ attached: true, windowIndex: 1, pid: 7, command });
  for (const shell of ['fish', 'bash', 'zsh', 'sh']) {
    expect(foregroundFrom(at(shell))).toBeNull(); // §4.4: shell name = idle
  }
  expect(foregroundFrom(at('vim'))).toEqual({ command: 'vim', pid: 7 });
  expect(foregroundFrom(at('claude'))).toEqual({ command: 'claude', pid: 7 });
  expect(foregroundFrom(at('sleep'))).toEqual({ command: 'sleep', pid: 7 });
  expect(foregroundFrom(null)).toBeNull();
  // Detached: whatever runs there is not under the user's finger, so the ribbon shows nothing.
  expect(foregroundFrom({ attached: false, windowIndex: 1, pid: 7, command: 'vim' })).toBeNull();
});

test('poll and list commands go quiet instead of erroring without a server', () => {
  for (const command of [POLL, LIST_WINDOWS]) {
    expect(command.endsWith(`2>/dev/null; true`)).toBe(true);
  }
});

/* --- derived state --- */

test('config status is the §4.5 trio, and tabs follow tmux whoever started it', () => {
  expect(deriveConfigStatus(false, 'applied')).toBe('off'); // the toggle wins
  expect(deriveConfigStatus(true, 'applied')).toBe('applied');
  expect(deriveConfigStatus(true, 'not-applied')).toBe('not-applied');
  expect(tabsAvailable(true, true)).toBe(true);
  expect(tabsAvailable(false, true)).toBe(false); // no tmux on the host, whatever is attached
  expect(tabsAvailable(null, true)).toBe(false); // not probed yet = not available yet
  // Installed, but this PTY never entered tmux: the switcher's commands would target a session
  // that is not the one on screen, so the button stays dark (T13/T9.4).
  expect(tabsAvailable(true, false)).toBe(false);
});

test('shell quoting survives quotes, spaces, and stays literal', () => {
  expect(shellQuote('plain')).toBe(`'plain'`);
  expect(shellQuote('two words')).toBe(`'two words'`);
  expect(shellQuote(`don't`)).toBe(`'don'\\''t'`); // the POSIX dance, which fish parses the same
  expect(shellQuote('$(reboot); `id`')).toBe(`'$(reboot); \`id\`'`); // inert inside single quotes
});

test('the poll names its session, or asks untargeted when it cannot', () => {
  // Untargeted is what made the ribbon show another window's process: tmux answers about whichever
  // session it last considered current (BUGS.md).
  expect(model.pollCommand(null)).toBe(model.POLL);
  expect(model.POLL).not.toContain('-t');

  const aimed = model.pollCommand('port22');
  expect(aimed).toContain(`-t '=port22:'`); // exact name, that session's current window, active pane
  expect(aimed).toContain('#{pane_current_command}');
  // A session name is user-typed on the attach picker, so it goes through the same quoting.
  expect(model.pollCommand('$(reboot)')).toContain(`'=$(reboot):'`);
});
