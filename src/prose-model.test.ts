import { expect, test } from 'bun:test';

import { proseFor } from '@/prose-model';

/* --- the bare prompt and the keystroke TUIs: a correction is a mangled command --- */

test('a bare prompt is never prose, whichever shell sits there', () => {
 for (const shell of ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'ash', 'mksh']) {
  expect(proseFor(shell, [])).toBe(false);
 }
});

test('keystroke TUIs and structured input are off', () => {
 for (const command of [
  'vim', 'nvim', 'vi', 'emacs', 'nano',
  'htop', 'btop', 'top',
  'fzf', 'less', 'more', 'man',
  'tig', 'lazygit', 'k9s',
  'tmux', 'ssh', 'git', 'psql',
 ])
  expect(proseFor(command, [])).toBe(false);
});

test('mail and chat are prose', () => {
 for (const command of ['mutt', 'neomutt', 'mail', 'alpine', 'pine', 'elm', 'weechat', 'irssi'])
  expect(proseFor(command, [])).toBe(true);
});

/* --- the process-title shape: a node CLI that names itself, not `node` --- */

// These reach the table by their OWN name — pi and claude set their process title, so
// `pane_current_command` answers `pi`, not `node` — and the children are never asked for. Measured
// on the host, not assumed: this is the common install shape, the one the interpreter half below
// cannot see.
test('an LLM coding agent that reports its own name is prose, no children needed', () => {
 for (const command of ['claude', 'pi', 'codex', 'aider'])
  expect(proseFor(command, [])).toBe(true);
});

/* --- the interpreter: the basename is useless, the children decide --- */

test('a node CLI is prose when its script path names the app', () => {
 // The two install shapes of the two apps the model exists for: a global install's lib path and
 // a .bin shim whose only telling segment is the bare name.
 expect(
  proseFor('node', ['node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js']),
 ).toBe(true);
 expect(proseFor('node', ['/usr/local/lib/node_modules/.bin/pi'])).toBe(true);
 expect(
  proseFor('node', ['node /home/u/.local/share/pi-coding-agent/dist/cli.js']),
 ).toBe(true);
 expect(proseFor('bun', ['bun /srv/app/codex/index.js'])).toBe(true);
});

test('python CLIs are decided by the script argument, too — aider, not http.server', () => {
 expect(proseFor('python3', ['/usr/bin/python3 /usr/local/bin/aider --chat'])).toBe(true);
 expect(proseFor('python3', ['python3 -m http.server 8000'])).toBe(false);
 expect(proseFor('python3', ['python3 -c "print(1)"'])).toBe(false);
});

test('an interpreter with nothing recognisable is a terminal like any other', () => {
 expect(proseFor('node', [])).toBe(false); // a bare REPL
 expect(proseFor('node', ['node -e "setTimeout(()=>{},1e3)"'])).toBe(false);
 expect(proseFor('deno', ['deno run /home/u/server.ts'])).toBe(false);
});

test('segments, not substrings: myapi is not pi, and a grep argument is not a script path', () => {
 expect(proseFor('node', ['node /opt/myapi/server.js'])).toBe(false);
 expect(proseFor('python3', ['python3 /srv/site/main.py'])).toBe(false);
 // argv[1] is the script; the pattern the user searched for is argv[2] and further — and it is
 // matched whole-segment, so even there "api" is not "pi".
 expect(proseFor('node', ['node /srv/app/index.js /home/u/notes'])).toBe(false);
});

/* --- the model declines where it cannot see --- */

test('an unrecognised foreground is null — the screen takes the OFF default', () => {
 expect(proseFor('emacs29', [])).toBeNull();
 expect(proseFor('tcsh', [])).toBeNull();
 expect(proseFor('', [])).toBeNull(); // a pane tmux cannot name yet
 expect(proseFor('myapp', [])).toBeNull();
});
