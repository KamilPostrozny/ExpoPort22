/** `bun test` — the tmux side-channel's decisions (T9). Everything here is pure: the conf the app
 *  pushes, the commands it sends down exec channels, and the parsers reading the answers. The
 *  commands themselves were additionally run through `fish -c` verbatim during development — the
 *  fish-parses-it half of every claim is measured, not assumed. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  APPLY_AND_VERIFY,
  CONF_MARKER,
  CONF_PATH,
  CONF_VERSION,
  LIST_WINDOWS,
  NEW_WINDOW,
  POLL,
  PROBE,
  SEP,
  SOURCE_LINE,
  appendSourceLineCommand,
  capturePaneCommand,
  chooseUserConf,
  deriveConfigStatus,
  foregroundFrom,
  generateConf,
  hasSourceLine,
  killWindowCommand,
  moveWindowCommand,
  needsPush,
  parsePoll,
  parseProbe,
  parseVerify,
  parseWindows,
  readFileCommand,
  selectWindowCommand,
  shellQuote,
  tabsAvailable,
} from '@/tmux-model';

/* --- the conf file --- */

test('the conf opens with the version marker and sets everything §4.5 lists', () => {
  const conf = generateConf();
  expect(conf.startsWith(`${CONF_MARKER}\n`)).toBe(true); // the human-readable version stamp
  expect(conf).toContain(`set -g @port22 ${CONF_VERSION}`); // the verify handle
  expect(conf).toContain('set -g mouse on');
  expect(conf).toContain('set -s escape-time 0');
  expect(conf).toContain('set -g history-limit 50000');
  expect(conf).toContain('set -g set-clipboard on'); // OSC 52, half one
  expect(conf).toContain(`Ms=\\E]52;%p1%s;%p2%s\\007`); // OSC 52, half two: the Ms capability
  expect(conf).toContain('set -g set-titles on');
  expect(conf).toContain('set-titles-string');
  // One line per notch, both copy-mode flavours (§4.3): vi and emacs, up and down.
  for (const table of ['copy-mode ', 'copy-mode-vi']) {
    for (const wheel of ['WheelUpPane', 'WheelDownPane']) {
      expect(conf).toMatch(new RegExp(`bind -T ${table.trim()}\\s+${wheel}\\s+send -N1 -X scroll-`));
    }
  }
});

test('push decision: fresh, stale and current remote content', () => {
  expect(needsPush(null)).toBe(true); // nothing there yet
  expect(needsPush('')).toBe(true);
  expect(needsPush('# port22-conf-v0\nset -g mouse on\n')).toBe(true); // version bump replaces
  expect(needsPush(generateConf().slice(0, -40))).toBe(true); // truncated file of the same version
  expect(needsPush(generateConf())).toBe(false); // byte-for-byte current: skip
});

/* --- the source line in the user's own conf --- */

test('source line is spotted whether ours, hand-written, or commented out', () => {
  expect(hasSourceLine('')).toBe(false);
  expect(hasSourceLine('set -g mouse on\nbind r source-file ~/.tmux.conf\n')).toBe(false);
  expect(hasSourceLine(`set -g status off\n${SOURCE_LINE}\n`)).toBe(true);
  expect(hasSourceLine('source-file ~/.config/port22/port22.conf\n')).toBe(true); // theirs, no -q
  // Commented out = the user turned it off on purpose; re-appending would override that.
  expect(hasSourceLine(`# ${SOURCE_LINE}\n`)).toBe(true);
});

test('the conf tmux actually reads wins: home first, XDG next, create home last', () => {
  expect(chooseUserConf(true, true)).toEqual({ path: '~/.tmux.conf', exists: true });
  expect(chooseUserConf(true, false)).toEqual({ path: '~/.tmux.conf', exists: true });
  // An XDG user must get the line there — creating ~/.tmux.conf would shadow their whole config.
  expect(chooseUserConf(false, true)).toEqual({ path: '~/.config/tmux/tmux.conf', exists: true });
  expect(chooseUserConf(false, false)).toEqual({ path: '~/.tmux.conf', exists: false });
});

test('append command is fish-and-sh common ground and creates a missing file', () => {
  const command = appendSourceLineCommand('~/.tmux.conf');
  expect(command).toBe(`printf '\\n%s\\n' '${SOURCE_LINE}' >> ~/.tmux.conf`);
  expect(command).not.toContain('$('); // no substitution, no heredoc, nothing fish chokes on
  expect(command).not.toContain('<<');
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

test('file reads come back empty rather than failing on a missing file', () => {
  expect(readFileCommand(`~/${CONF_PATH}`)).toBe(`cat ~/${CONF_PATH} 2>/dev/null; true`);
});

/* --- windows --- */

const line = (fields: string[]) => fields.join(SEP);

test('list-windows output parses, name last so separators in names shift nothing', () => {
  const output = [
    line(['@0', '1', '0', '/home/kamil/dev', '80', 'fish']),
    line(['@3', '2', '1', '/home/kamil', '120', `weird${SEP}name: with everything\t`]),
  ].join('\n');
  expect(parseWindows(output)).toEqual([
    { id: '@0', index: 1, active: false, path: '/home/kamil/dev', width: 80, name: 'fish' },
    // The name survives with the separator inside it — it is the tail, rejoined.
    { id: '@3', index: 2, active: true, path: '/home/kamil', width: 120, name: `weird${SEP}name: with everything\t` },
  ]);
});

test('lines that are not windows (tmux diagnostics, junk) never become cards', () => {
  expect(parseWindows('')).toEqual([]);
  expect(parseWindows('no server running on /tmp/tmux-501/default\n')).toEqual([]);
  expect(parseWindows(line(['not-an-id', '1', '0', '/', '80', 'x']))).toEqual([]);
  expect(parseWindows(line(['@1', 'NaN', '0', '/', '80', 'x']))).toEqual([]);
});

test('window commands target by validated integer index only', () => {
  expect(selectWindowCommand(3)).toBe('tmux select-window -t :3');
  expect(killWindowCommand(0)).toBe('tmux kill-window -t :0');
  expect(capturePaneCommand(2)).toBe('tmux capture-pane -p -e -t :2'); // -e: colours stay escapes
  expect(NEW_WINDOW).toBe('tmux new-window'); // untargeted: tmux picks and activates
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

test('config status is the §4.5 trio, and tabs need present AND applied', () => {
  expect(deriveConfigStatus(false, 'applied')).toBe('off'); // the toggle wins
  expect(deriveConfigStatus(true, 'applied')).toBe('applied');
  expect(deriveConfigStatus(true, 'not-applied')).toBe('not-applied');
  expect(tabsAvailable(true, 'applied', true)).toBe(true);
  expect(tabsAvailable(true, 'off', true)).toBe(false); // toggle off hides the tabs button (§4.5)
  expect(tabsAvailable(true, 'not-applied', true)).toBe(false); // switcher needs configured tmux
  expect(tabsAvailable(false, 'applied', true)).toBe(false); // no tmux = no button, no mention (§7)
  expect(tabsAvailable(null, 'applied', true)).toBe(false); // not probed yet = not available yet
  // Installed and configured, but this PTY never entered tmux: the switcher's commands would
  // target a session that is not the one on screen, so the button stays away (T13/T9.4).
  expect(tabsAvailable(true, 'applied', false)).toBe(false);
});

test('shell quoting survives quotes, spaces, and stays literal', () => {
  expect(shellQuote('plain')).toBe(`'plain'`);
  expect(shellQuote('two words')).toBe(`'two words'`);
  expect(shellQuote(`don't`)).toBe(`'don'\\''t'`); // the POSIX dance, which fish parses the same
  expect(shellQuote('$(reboot); `id`')).toBe(`'$(reboot); \`id\`'`); // inert inside single quotes
});
