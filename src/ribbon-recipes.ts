/**
 * The edge handle's recipes (§4.4), as declarative data — match names → caps — so the user
 * recipe editor PLAN §6 promises later is a data problem, not a rewrite. `src/ribbon-model.ts`
 * owns the matching rules; `src/ribbon.tsx` renders and executes.
 *
 * Caps are the panel's column, top to bottom — the prototype puts the destructive cap at the
 * top and the most-used one at the bottom, nearest the thumb. Cap bytes are exactly what goes
 * to the PTY. The vim caps are Esc-prefixed (§4.4: they must work from insert mode — one ESC
 * first is harmless in normal mode and decisive in insert). F6/F9 are `CSI 17~`/`CSI 20~`, the
 * xterm function-key sequences htop binds sort/kill to. `\r` is what the Return key sends on a
 * PTY, so `/clear\r` is "type /clear and press Return".
 */

import type { DotName } from '@/theme';

export type RecipeId = 'running' | 'suspended' | 'vim' | 'pager' | 'htop' | 'agent';

export type Cap = {
  /** A section header row (the agent recipe's SESSION/COMMANDS/NOW) — a small right-aligned
   *  label in the column, not a capsule. Every other field is ignored on a header. */
  header?: string;
  /** The mono key text on the cap (`^C`, `:w`, `/clear`…). */
  label?: string;
  /** The caption beside it. Absent on the slash caps — the label says it all. */
  caption?: string;
  /** Sent verbatim to the PTY on tap. Absent when `action` does something richer. */
  bytes?: string;
  /** The non-byte behaviours, executed by the screen:
   *  `bg` = ^Z then `bg\r` (running → run behind), `fg`/`bg2` = resume/run-behind a suspended
   *  job, `kill` = pgrep+kill -9 on an exec channel, `attach` = T8's quickAttach. */
  action?: 'bg' | 'fg' | 'bg2' | 'kill' | 'attach';
  /** Two taps to fire twice (the agent's `^C ^C` quit — Claude Code needs both): the first tap
   *  sends `bytes` and re-labels the cap "tap again"; only the second closes the panel. */
  arm?: boolean;
  /** Red-tinted, per the design (`:q!`, kill, F9). */
  danger?: boolean;
  /** Also raise the keyboard (search/filter caps — the `/` needs typing after it). */
  focus?: boolean;
};

export type Recipe = {
  /** `#{pane_current_command}` values that select this recipe. Empty for the two synthetic
   *  recipes (running/suspended), which match by state, not name. */
  names: string[];
  caps: Cap[];
  /** The handle's (and dot's) colour, as a theme dot role — one colour per class of process
   *  (prototype `dotFor`). */
  dot: DotName;
  /** The handle breathes (prototype `p22edge`) while the process is live — running jobs and
   *  agents; a stopped job or a TUI sitting there earns a still handle. */
  pulse: boolean;
};

export const RECIPES: Record<RecipeId, Recipe> = {
  running: {
    names: [],
    dot: 'green',
    pulse: true,
    caps: [
      { label: 'kill', caption: 'force', action: 'kill', danger: true },
      { label: '^Z bg', caption: 'background', action: 'bg' },
      { label: '^C', caption: 'stop', bytes: '\x03' },
    ],
  },
  suspended: {
    names: [],
    dot: 'grey',
    pulse: false,
    caps: [
      { label: 'kill', caption: 'force', action: 'kill', danger: true },
      { label: 'bg', caption: 'run behind', action: 'bg2' },
      { label: 'fg', caption: 'resume', action: 'fg' },
    ],
  },
  vim: {
    names: ['vim', 'nvim', 'vi'],
    dot: 'mauve',
    pulse: false,
    caps: [
      { label: ':q!', caption: 'discard', bytes: '\x1b:q!\r', danger: true },
      { label: ':q', caption: 'quit', bytes: '\x1b:q\r' },
      { label: '/', caption: 'search', bytes: '\x1b/', focus: true },
      { label: 'ZZ', caption: 'save+quit', bytes: '\x1bZZ' },
      { label: ':w', caption: 'save', bytes: '\x1b:w\r' },
    ],
  },
  pager: {
    names: ['less', 'man', 'bat', 'delta'],
    dot: 'blue',
    pulse: false,
    caps: [
      { label: 'q', caption: 'quit', bytes: 'q' },
      { label: 'G', caption: 'end', bytes: 'G' },
      { label: 'g', caption: 'top', bytes: 'g' },
      { label: 'n', caption: 'next hit', bytes: 'n' },
      { label: '/', caption: 'search', bytes: '/', focus: true },
    ],
  },
  htop: {
    names: ['htop', 'top', 'btop'],
    dot: 'yellow',
    pulse: false,
    caps: [
      { label: 'F9', caption: 'kill', bytes: '\x1b[20~', danger: true },
      { label: 'q', caption: 'quit', bytes: 'q' },
      { label: 'F6', caption: 'sort', bytes: '\x1b[17~' },
      { label: '/', caption: 'filter', bytes: '/', focus: true },
    ],
  },
  agent: {
    names: ['claude', 'codex', 'aider', 'gemini'],
    dot: 'peach',
    pulse: true,
    caps: [
      { header: 'SESSION' },
      { label: '^C ^C', caption: 'quit', bytes: '\x03', arm: true, danger: true },
      { header: 'COMMANDS' },
      { label: '/clear', bytes: '/clear\r' },
      { label: '/context', bytes: '/context\r' },
      { label: '/model', bytes: '/model\r' },
      { label: '/usage', bytes: '/usage\r' },
      { label: '/config', bytes: '/config\r' },
      { label: '/plugins', bytes: '/plugins\r' },
      { header: 'NOW' },
      { label: '📎', caption: 'attach', action: 'attach' },
      { label: '⇧⇥', caption: 'plan mode', bytes: '\x1b[Z' },
      { label: '⎋', caption: 'stop', bytes: '\x1b' },
    ],
  },
};

/** Interactive prompts that are not "a job running" — a REPL sitting at its prompt gets no
 *  handle (§4.4: shell idle, REPLs, unknown TUIs → nothing). Names, because a REPL does not
 *  use the alternate screen and would otherwise read as `running`. */
export const REPL_NAMES = new Set([
  'python', 'python3', 'ipython', 'node', 'deno', 'bun', 'irb', 'pry',
  'ghci', 'lua', 'sqlite3', 'psql', 'mysql', 'bc',
]);
