/**
 * The context ribbon's recipes (§4.4), as declarative data — match names → caps — so the user
 * recipe editor PLAN §6 promises later is a data problem, not a rewrite. `src/ribbon-model.ts`
 * owns the matching rules; `src/ribbon.tsx` renders and executes.
 *
 * Cap bytes are exactly what goes to the PTY. The vim caps are Esc-prefixed (§4.4: they must
 * work from insert mode — one ESC first is harmless in normal mode and decisive in insert).
 * F9 is `CSI 20~`, the xterm function-key sequence htop binds kill to. `\r` is what the Return
 * key sends on a PTY, so `fg\r` is "type fg and press Return".
 */

export type RecipeId = 'running' | 'suspended' | 'vim' | 'pager' | 'htop' | 'agent';

export type Cap = {
  /** The big text on the cap (`^C`, `:w`, `q`…). */
  label: string;
  /** The 8.5pt caption under it (§3). */
  caption: string;
  /** Sent verbatim to the PTY on tap. Absent when `action` does something richer. */
  bytes?: string;
  /** The non-byte behaviours, executed by the ribbon component:
   *  `bg` = ^Z then `bg\r` (running → run behind), `fg`/`bg2` = resume/run-behind a suspended
   *  job, `kill` = pgrep+kill -9 on an exec channel, `attach` = T8's quickAttach. */
  action?: 'bg' | 'fg' | 'bg2' | 'kill' | 'attach';
  /** Red-tinted, per the design (`:q!`, kill, F9). */
  danger?: boolean;
  /** Also raise the keyboard (pager/htop `/` — the search needs typing). */
  focus?: boolean;
  /** The agent caps' row layout (icon + label) instead of the letter-over-caption column. */
  wide?: boolean;
};

export type Recipe = {
  /** `#{pane_current_command}` values that select this recipe. Empty for the two synthetic
   *  recipes (running/suspended), which match by state, not name. */
  names: string[];
  caps: Cap[];
  /** The dot's colour, as a Catppuccin palette key — one colour per class of process
   *  (prototype `dotFor`). */
  dot: 'green' | 'overlay0' | 'mauve' | 'blue' | 'yellow' | 'peach';
  /** TUI recipes start as a collapsed dot+label pill (§4.4); running/suspended/agent open
   *  expanded (the prototype's `isTui`). */
  collapsible: boolean;
};

export const RECIPES: Record<RecipeId, Recipe> = {
  running: {
    names: [],
    dot: 'green',
    collapsible: false,
    caps: [
      { label: '^C', caption: 'stop', bytes: '\x03' },
      { label: '^Z bg', caption: 'background', action: 'bg' },
      { label: 'kill', caption: 'force', action: 'kill', danger: true },
    ],
  },
  suspended: {
    names: [],
    dot: 'overlay0',
    collapsible: false,
    caps: [
      { label: 'fg', caption: 'resume', action: 'fg' },
      { label: 'bg', caption: 'run behind', action: 'bg2' },
      { label: 'kill', caption: 'force', action: 'kill', danger: true },
    ],
  },
  vim: {
    names: ['vim', 'nvim', 'vi'],
    dot: 'mauve',
    collapsible: true,
    caps: [
      { label: ':w', caption: 'save', bytes: '\x1b:w\r' },
      { label: ':q', caption: 'quit', bytes: '\x1b:q\r' },
      { label: 'ZZ', caption: 'save+quit', bytes: '\x1bZZ' },
      { label: ':q!', caption: 'force quit', bytes: '\x1b:q!\r', danger: true },
    ],
  },
  pager: {
    names: ['less', 'man', 'bat', 'delta'],
    dot: 'blue',
    collapsible: true,
    caps: [
      { label: 'q', caption: 'quit', bytes: 'q' },
      { label: '/', caption: 'search', bytes: '/', focus: true },
      { label: 'g', caption: 'top', bytes: 'g' },
      { label: 'G', caption: 'end', bytes: 'G' },
    ],
  },
  htop: {
    names: ['htop', 'top', 'btop'],
    dot: 'yellow',
    collapsible: true,
    caps: [
      { label: 'q', caption: 'quit', bytes: 'q' },
      { label: '/', caption: 'filter', bytes: '/', focus: true },
      { label: 'F9', caption: 'kill', bytes: '\x1b[20~', danger: true },
    ],
  },
  agent: {
    names: ['claude', 'codex', 'aider', 'gemini'],
    dot: 'peach',
    collapsible: false,
    caps: [
      { label: '📎', caption: 'attach', action: 'attach', wide: true },
      { label: '⎋', caption: 'interrupt', bytes: '\x1b', wide: true },
    ],
  },
};

/** Interactive prompts that are not "a job running" — a REPL sitting at its prompt gets no
 *  ribbon (§4.4: shell idle, REPLs, unknown TUIs → nothing). Names, because a REPL does not
 *  use the alternate screen and would otherwise read as `running`. */
export const REPL_NAMES = new Set([
  'python', 'python3', 'ipython', 'node', 'deno', 'bun', 'irb', 'pry',
  'ghci', 'lua', 'sqlite3', 'psql', 'mysql', 'bc',
]);
