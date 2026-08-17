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
  listWindowsCommand,
  newWindowCommand,
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
      // The mouse-aware app keeps its untouched report, a pager gets one key per notch.
      expect(conf).toMatch(new RegExp(`${wheel}[^\\n]*send -M[^\\n]*alternate_on[^\\n]*send -N1 ${key}`));
      // ...and "a pager" is not just the alternate screen. git runs less with `LESS=FRX`, and `-X`
      // keeps it on the main buffer: measured in a `git log` pane on this host, `alternate_on` is 0
      // and `pane_current_command` is `git`, not `less` — so the name arm has to carry both, and
      // anchored, or `gitk` and `lesspipe` would take the wheel too.
      expect(conf).toContain(
        `#{||:#{alternate_on},#{m/r:^(git|less)$,#{pane_current_command}}}' 'send -N1 ${key}' 'copy-mode -e'`,
      );
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
  expect(tabsHint(false, true, true)).toContain('has not got it');
  expect(tabsHint(false, false, false)).toContain('has not got it'); // the host still decides first
  expect(tabsHint(true, false, false)).toContain('Settings');
  expect(tabsHint(null, false, false)).toContain('Settings'); // probe still out, mode is answer enough
  expect(tabsHint(true, true, true)).toBe('Waiting for tmux…'); // pushing the conf, or not attached yet
  // A tmux mode whose session has no name to give (`custom`, or `attach` on "most recent"): the
  // button is dark because the grid refuses to list windows it cannot attribute, and the advice is
  // the choice that gives it a name — not "choose a tmux start mode", which they already did.
  expect(tabsHint(true, true, false)).toContain('name');
  expect(tabsHint(true, true, false)).toContain('Settings');
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

test('the list has exactly as many windows as tmux printed — no phantom row', () => {
  // The refuted half of BUGS' "one exec per grid open fails": a single extra entry — an off-by-one,
  // or the trailing newline every `list-windows` ends with becoming a card — would manufacture
  // exactly one uncapturable target every time, which is what "always exactly 1, at 8 windows and
  // at 25" looked like. It does not. Verbatim `tmux list-windows` output, trailing newline and all.
  const rows: [string, number][] = [
    ['@29', 0],
    ['@26', 1],
    ['@28', 2],
    ['@30', 4],
    ['@31', 5],
  ];
  const output =
    rows.map(([id, i]) => line([id, String(i), '0', '/home/kamil', '80', 'fish', 'w'])).join('\n') + '\n';
  expect(parseWindows(output)).toHaveLength(rows.length);
  expect(parseWindows(output.trimEnd())).toHaveLength(rows.length);
  // Non-contiguous indices survive as themselves — the gap is tmux's, not a missing window.
  expect(parseWindows(output).map((w) => w.index)).toEqual([0, 1, 2, 4, 5]);
});

test('lines that are not windows (tmux diagnostics, junk) never become cards', () => {
  expect(parseWindows('')).toEqual([]);
  expect(parseWindows('no server running on /tmp/tmux-501/default\n')).toEqual([]);
  expect(parseWindows(line(['not-an-id', '1', '0', '/', '80', 'sh', 'x']))).toEqual([]);
  expect(parseWindows(line(['@1', 'NaN', '0', '/', '80', 'sh', 'x']))).toEqual([]);
  // A six-field line is the OLD format — reject rather than misread the command as the name.
  expect(parseWindows(line(['@1', '1', '0', '/', '80', 'x']))).toEqual([]);
});

test('window commands target by tmux window id, never by index', () => {
  // `:index` is a position, and a position moves: with renumber-windows on, `kill-window -t :2`
  // aimed at the card that WAS index 2 exits 0 and kills whatever slid into slot 2 (measured,
  // tmux 3.7b). `@N` is server-global and never reused, so it names one window or none.
  expect(selectWindowCommand('@3')).toBe('tmux select-window -t @3');
  expect(killWindowCommand('@0')).toBe('tmux kill-window -t @0');
  // -e: colours stay escapes. -N: trailing spaces stay too, because they carry the background of
  // a highlighted run that reaches past its last letter.
  expect(capturePaneCommand('@12')).toBe('tmux capture-pane -p -e -N -t @12');
  // Always the end of the list, never tmux's lowest free index; quoted so fish leaves `{end}` be.
  expect(newWindowCommand('port22')).toBe("tmux new-window -a -t '=port22:{end}'");
  // The injection guard: an id is `@` and digits or it is nothing. An INDEX is now rejected too —
  // `-t :7` also falls back to matching a window NAMED `7`, which is how a capture reached the
  // wrong pane and exited 0.
  expect(() => selectWindowCommand('7')).toThrow();
  expect(() => killWindowCommand('@1; rm -rf ~')).toThrow();
  expect(() => capturePaneCommand('@')).toThrow();
  expect(() => capturePaneCommand('')).toThrow();
  expect(() => capturePaneCommand('%2')).toThrow(); // a PANE id is not a window id
});

test('move-window inserts before when moving down, after when moving up, and never selects', () => {
  // `-d`: a reorder is not a selection. Without it the drag also switches the attached client to
  // the moved window — a tab the user never chose, while they are looking at the grid.
  expect(moveWindowCommand('port22', 4, 1)).toBe(
    "tmux move-window -d -b -s '=port22:4' -t '=port22:1'",
  );
  expect(moveWindowCommand('port22', 1, 4)).toBe(
    "tmux move-window -d -a -s '=port22:1' -t '=port22:4'",
  );
  expect(() => moveWindowCommand('port22', -1, 0)).toThrow();
  expect(() => moveWindowCommand('port22', 1.5, 0)).toThrow();
});

test('no window command can be built without a session to scope it to', () => {
  // The bug this whole family exists to prevent: an exec channel is outside any tmux client, so an
  // untargeted command is aimed by tmux's "best session" heuristic — newest activity, attachment
  // irrelevant — and the grid listed (and offered a ✕ for) a DETACHED session's windows.
  for (const built of [
    listWindowsCommand('port22'),
    newWindowCommand('port22'),
    moveWindowCommand('port22', 0, 1),
  ]) {
    expect(built).toContain('=port22:'); // exact-name scope, not a prefix match and not "current"
    expect(built).toMatch(/-t '=port22:/); // ...and it is the TARGET that carries it
  }
  // Empty is the only way a name can arrive absent, and it throws rather than producing `:` — which
  // is what "whatever session tmux calls current" is spelled as.
  for (const build of [listWindowsCommand, newWindowCommand]) expect(() => build('')).toThrow();
  expect(() => moveWindowCommand('', 0, 1)).toThrow();
  expect(() => model.sessionScope('')).toThrow();
  // A session name is user-typed on the attach picker: same quoting as everywhere else.
  expect(listWindowsCommand(`it's`)).toContain(`-t '=it'\\''s:'`);
  // The grid's own commands still address a WINDOW by id, and an id is server-global — scoping
  // them would add nothing. What the scope above buys is that the ids came from the right session.
  expect(killWindowCommand('@7')).toBe('tmux kill-window -t @7');
});

test('a session that stops answering takes the tabs, and so the grid, with it', () => {
  // T10A.8: our session ended, the app logged `attached:false` and then re-listed onto the USER's
  // session. The two halves of why it cannot any more, both pure:
  //
  // 1. There is no session to scope a list to — `src/tmux.ts` writes `session` only when a NAMED
  //    ask came back attached, so a dead session leaves null...
  expect(tabsAvailable(true, null)).toBe(false);
  // 2. ...and null is not a name a command can be built from. Not "build it untargeted": throw.
  expect(() => listWindowsCommand(null as unknown as string)).toThrow();
  // The falling edge of exactly this is what tears the grid down (`showTabs` in app/terminal.tsx).
  expect(tabsAvailable(true, 'port22')).toBe(true);
});

/* --- the poll --- */

test('poll parse: attached flag, badge index, pid, the PANE alt flag, command-last rejoin', () => {
  const poll = parsePoll(line(['1', '3', '4242', '1', 'vim']) + '\n');
  expect(poll).toEqual({ attached: true, windowIndex: 3, pid: 4242, paneAlt: true, command: 'vim' });
  expect(parsePoll(line(['0', '1', '99', '0', 'fish']))?.attached).toBe(false);
  // The whole 2026-08-17 bug in one line: a pane running `sleep` inside tmux. The OUTER terminal
  // is on the alternate screen (it is showing a tmux client), the PANE is not.
  expect(parsePoll(line(['1', '3', '4242', '0', 'sleep']))?.paneAlt).toBe(false);
  // A command name full of separators still rejoins from field 5, not 4.
  expect(parsePoll(line(['1', '3', '4242', '0', 'we', 'ird']))?.command).toBe(`we${SEP}ird`);
  // A tmux too old for `#{alternate_on}` renders it empty — false, not a rejected line: the badge
  // and the tabs button must not go down with a field only the ribbon reads.
  const old = parsePoll(line(['1', '3', '4242', '', 'sleep']));
  expect(old?.paneAlt).toBe(false);
  expect(old?.command).toBe('sleep');
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
  const at = (command: string) => ({ attached: true, windowIndex: 1, pid: 7, paneAlt: false, command });
  for (const shell of ['fish', 'bash', 'zsh', 'sh']) {
    expect(foregroundFrom(at(shell))).toBeNull(); // §4.4: shell name = idle
  }
  expect(foregroundFrom(at('vim'))).toEqual({ command: 'vim', pid: 7 });
  expect(foregroundFrom(at('claude'))).toEqual({ command: 'claude', pid: 7 });
  expect(foregroundFrom(at('sleep'))).toEqual({ command: 'sleep', pid: 7 });
  expect(foregroundFrom(null)).toBeNull();
  // Detached: whatever runs there is not under the user's finger, so the ribbon shows nothing.
  expect(
    foregroundFrom({ attached: false, windowIndex: 1, pid: 7, paneAlt: false, command: 'vim' }),
  ).toBeNull();
});

test('poll and list commands go quiet instead of erroring without a server', () => {
  for (const command of [POLL, listWindowsCommand('port22')]) {
    expect(command.endsWith(`2>/dev/null; true`)).toBe(true);
  }
});

/* --- derived state --- */

test('config status is the §4.5 trio, and tabs follow tmux whoever started it', () => {
  expect(deriveConfigStatus(false, 'applied')).toBe('off'); // the toggle wins
  expect(deriveConfigStatus(true, 'applied')).toBe('applied');
  expect(deriveConfigStatus(true, 'not-applied')).toBe('not-applied');
  expect(tabsAvailable(true, 'port22')).toBe(true);
  expect(tabsAvailable(false, 'port22')).toBe(false); // no tmux on the host, whatever is attached
  expect(tabsAvailable(null, 'port22')).toBe(false); // not probed yet = not available yet
  // Installed, but this PTY never entered tmux: the switcher's commands would target a session
  // that is not the one on screen, so the button stays dark (T13/T9.4). `null` is also what a
  // poll that could not find OUR session leaves behind — which is the grid's teardown (T10A.8):
  // the button goes dark on the same fact the terminal screen closes the switcher on.
  expect(tabsAvailable(true, null)).toBe(false);
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
  // The ribbon's TUI gate: per-pane, because the outer terminal's own buffer says only "tmux".
  expect(aimed).toContain('#{alternate_on}');
  // Command stays last — nothing after it to shift when a name contains the separator.
  expect(aimed.indexOf('#{alternate_on}')).toBeLessThan(aimed.indexOf('#{pane_current_command}'));
  // A session name is user-typed on the attach picker, so it goes through the same quoting.
  expect(model.pollCommand('$(reboot)')).toContain(`'=$(reboot):'`);
});
