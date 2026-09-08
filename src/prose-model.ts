/**
 * The prose-mode auto-decision (T7.15). The poll carries tmux's `#{pane_current_command}` — the
 * BASENAME of the pane's foreground job — plus, only while that job is an interpreter, the argvs
 * of the shell's direct children (the foreground job's root among them). From those two, decide
 * whether the keyboard should autocorrect:
 *
 *   - a shell or a keystroke TUI (vim, htop, fzf) — the line is a command or an escape sequence;
 *     a correction is a mangled one. OFF.
 *   - a prose app (mutt, an LLM prompt line) — the line is plain English. ON.
 *   - an interpreter (node, python3, …) — the basename says nothing; the child argvs do. The
 *     foreground job's root is the shell's direct child, and for a node CLI that child's argv
 *     carries the script path (`…/claude-code/cli.js`, `…/.bin/pi`), so a path-SEGMENT match
 *     against the known prose apps decides it. No match — a REPL, a home-grown script — is a
 *     terminal like any other. OFF.
 *
 *   There is a second install shape the interpreter half does NOT see, and it is the common one:
 *   a node CLI that sets its own process title (pi, claude). tmux's `pane_current_command` then
 *   answers the CLI's NAME (`pi`), not `node`, so the basename is not an interpreter and the child
 *   argvs are never asked for. Those names are allowlisted in `ON` directly — the process title is
 *   the signature. Measured on the host, not assumed: a bare `node script.js` reports `node` and
 *   rides the interpreter half; `pi` reports `pi` and rides `ON`.
 *   - anything unrecognised — `null`: the model declines, and the screen treats that as OFF (the
 *     terminal default), leaving the user's manual override untouched is NOT an option here,
 *     because the override is scoped to the current program and a new program has already
 *     happened (see the effect in app/terminal.tsx).
 *
 * What this CANNOT see, and never will: the mode INSIDE a program (vim's insert vs normal, a TUI
 * that swapped its prompt). tmux reports the job, not its state. That is why the ⋯ menu row
 * stays — it is the override for exactly the cases this table gets wrong.
 */

export type ProseDecision = boolean | null;

/** The user is at a bare prompt, typing a command. The set is an allowlist of "definitely a
 *  shell": a shell not on it (tcsh, oil) falls through to `null` and the screen's OFF default —
 *  the same answer, without claiming to recognise the program. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'ash', 'mksh']);

/** Keystroke TUIs and structured-input programs: corrections land as stray characters or
 *  mangled syntax. Curated, not exhaustive — the fallthrough is already OFF at the screen, this
 *  table is for saying so here, in the tested place. */
const OFF = new Set([
 'vim', 'nvim', 'vi', 'emacs', 'nano', 'micro',
 'htop', 'btop', 'top', 'atop',
 'fzf', 'fzy', 'kaku',
 'less', 'more', 'man', 'tail',
 'tig', 'lazygit', 'k9s', 'lazydocker',
 'tmux', 'screen',
 'ssh', 'scp', 'sftp', 'mosh', 'expect',
 'git', 'make', 'cmake', 'gradle', 'mvn',
 'npm', 'yarn', 'pnpm', 'bunx', 'npx',
 'psql', 'mysql', 'sqlite3', 'redis-cli',
 'code', 'lazy',
]);

/** The line is plain English: mail, chat, and an LLM prompt line. The last group (claude, pi,
 *  codex, aider) are the coding agents whose main input is free-form prose, and they reach this
 *  table by NAME — they set their process title, so `pane_current_command` answers `pi`, not
 *  `node` (see the doc above). The path-segment half (`PROSE_SIGNATURES`) still covers the install
 *  shape that reports `node` and rides the interpreter branch instead. */
const ON = new Set([
 'mutt', 'neomutt', 'mail', 'alpine', 'pine', 'elm', 'weechat', 'irssi',
 'claude', 'pi', 'codex', 'aider',
]);

/** Basenames that mean "an interpreter — the basename is useless, look at what it is running".
 *  Glob-free on purpose: `pane_current_command` answers `python3`, not `python3.11`, and `node`
 *  is never `node-18`. A table, not a pattern. */
/** Exported because the poll's `children` half is asked on the host only while the foreground is
 *  one of these (see `childrenCommand` in tmux-model) — the two halves must name the same set. */
export const INTERPRETERS = new Set([
 'node', 'nodejs', 'bun', 'deno',
 'python', 'python2', 'python3',
 'ruby', 'ruby3', 'jruby', 'irb', 'pry',
 'php', 'perl', 'perl5',
 'lua', 'luajit', 'tclsh', 'wish',
]);

/** Path SEGMENTS that mark a prose app when it is the thing an interpreter is running. Segments,
 *  not substrings: `/opt/myapi/server.js` must not read as `pi`, and a pattern the user grep'd
 *  for is an ARGUMENT, not a segment of the running script. `claude-code` and `@anthropic-ai`
 *  both land in the same install's path, as do `pi-coding-agent` and `@earendil-works` — the
 *  pairs are belt and braces for the two install shapes (a global install's `lib/…` path, a
 *  `.bin` shim whose only segment is the bare name). */
const PROSE_SIGNATURES = new Set([
 'claude', 'claude-code', '@anthropic-ai',
 'pi', 'pi-coding-agent', '@earendil-works',
 'codex',
 'aider',
]);

/** Does a child's argv name one of the known prose apps? The command line is split on `/` and
 *  every SEGMENT is tested — but a segment is read only up to its first space, because the space
 *  ends the path and starts the next ARGUMENT: `/usr/local/bin/aider --chat` splits into the
 *  segments `bin` and `aider --chat`, and it is `aider` — the first word — that names the app,
 *  not `aider --chat` with the flag glued on. A real path segment never contains a space, so
 *  dropping the rest loses nothing true and keeps a bare `claude` passed as a non-path argument
 *  (a segment with no `/` at all) out of the match. The signature set is small and whole-word,
 *  so the only false positive left is an argument that is itself a path with a segment named
 *  exactly `claude`, `pi`, … — rarer than the install shapes the set exists to catch, and one
 *  tap of the override heals it. */
function argvNamesProseApp(argv: string): boolean {
 return argv
  .split("/")
  .some((segment) => PROSE_SIGNATURES.has(segment.split(/\s+/)[0] ?? ""));
}

/** The decision. `command` is the foreground job's basename (may be `''` — a pane tmux cannot
 *  name yet); `children` the direct children's argvs, empty when the foreground is not an
 *  interpreter (the poll does not ask for them then). */
export function proseFor(command: string, children: string[]): ProseDecision {
 if (SHELLS.has(command)) return false;
 if (ON.has(command)) return true;
 if (OFF.has(command)) return false;
 if (INTERPRETERS.has(command)) return children.some(argvNamesProseApp);
 return null;
}
