/**
 * The tmux side-channel's wire format (§4.5): the conf file the app pushes, the exec-channel
 * commands it runs, and the parsers that read the answers. Pure — every decision here runs under
 * `bun test` with no SSH and no native modules; `src/tmux.ts` owns the store, the poll timer and
 * the real connection.
 *
 * Ported behaviour from the reference `Port22Core/TmuxConfig.swift` + `TmuxTabs.swift` (spec, not
 * source), including its hardest-won lesson (their T60): an exec channel hands its string to the
 * user's **login shell**, and on a fish host a POSIX heredoc is a parse error that `try?` eats.
 * So the conf itself travels over SFTP — no shell in that path at all — and every command that
 * stays on the exec path is one line fish and POSIX sh parse identically: single quotes, `\;`,
 * `~/` at the start of a word (the one spelling of `$HOME` both agree on), `2>/dev/null`, `;`,
 * `printf`, `>>`. All of it was run through `fish -c` verbatim before landing here.
 */

/** v4: the root-table wheel bindings' pager case is matched by name as well as by alternate screen,
 *  so `git log` scrolls too — v3 caught only the pagers that switch buffers. */
export const CONF_VERSION = 4;
export const CONF_MARKER = `# port22-conf-v${CONF_VERSION}`;

/** Relative on purpose: SFTP resolves paths against `$HOME`, absolute would leave it. */
export const CONF_DIRECTORY = '.config/port22';
export const CONF_PATH = `${CONF_DIRECTORY}/port22.conf`;
/** The mkdir chain for `CONF_PATH`, shallowest first — SFTP mkdir has no `-p` (0700 is applied by
 *  the native module, which is the mode §4.6 wants for its own `/tmp/port22` too). */
export const CONF_DIRECTORIES = ['.config', CONF_DIRECTORY];

/**
 * Only what a feature of this app stops working without. The conf is not asked about any more —
 * choosing a tmux start mode pushes it (§4.1) — and something that arrives without being asked for
 * has no business having opinions: `status`, `base-index`, `mode-keys` and friends stay the user's.
 *
 * Two halves, and `extras` is the seam:
 *
 * - Always: the wheel notch, `mouse on`, the two OSC 52 lines. A feature of this app stops working
 *   without each of them, so a tmux start mode implies them and there is nothing to ask about.
 * - `extras` (the §4.8 toggle, on by default): what the app looks like when the phone is what it is
 *   being read on — truecolor through tmux, no status bar, no ESC delay, deep scrollback. All of
 *   it global, none of it load-bearing: see `EXTRAS` for the line-by-line and where it came from.
 *
 * v1's `set-titles` + format string is in neither half: the badge reads the *poll* (see POLL) and
 * never a title, so the file was rewriting the title of every terminal on the server for a feature
 * that does not read it. A dead option is a deletion, not a preference.
 *
 * `@port22` is the verify handle: a user option, because a real option like `mouse` can be masked
 * by the user's own conf setting the same value — which is exactly how a failed push once hid from
 * the reference app's read-back check. Both halves carry the same version: which of the two is on
 * the host is settled by content equality (see `needsPush`), not by the marker.
 */
export function generateConf(extras: boolean): string {
  return `${CONF_MARKER}
# Written by Port22 (the phone). Do not edit — a version bump replaces this file without asking.
# Your own tmux conf is never rewritten; it only ever gains one source-file line.

# The read-back proof the push verifies (show -gv @port22).
set -g @port22 ${CONF_VERSION}

# One line per wheel notch (§4.3), both copy-mode flavours. tmux's default sends five, so content
# would move five times the finger and then wait a round trip for the repaint, which reads as lag.
bind -T copy-mode    WheelUpPane   send -N1 -X scroll-up
bind -T copy-mode    WheelDownPane send -N1 -X scroll-down
bind -T copy-mode-vi WheelUpPane   send -N1 -X scroll-up
bind -T copy-mode-vi WheelDownPane send -N1 -X scroll-down

# Wheel events reach tmux at all only with mouse reporting on.
set -g mouse on

# What a wheel notch means in a pane that is NOT already in copy mode. tmux's default answer is
# \`copy-mode -e\` for any app that has not asked for the mouse — and over a pager that opens copy
# mode on a buffer that does not move. That is a pager that will not scroll: \`less\`, \`man\` and
# \`git log\` take the wheel and sit still (user, device). The pager case has to become the keys the
# pager actually reads.
#
# Three cases, in the order tmux tests them: the app asked for the mouse (vim, htop, and this
# app's own host) — hand it the report untouched; a pager — one arrow per notch, matching the
# copy-mode bindings above; anything else — copy mode, tmux's own default.
#
# "A pager" is two tests because the alternate screen alone misses git's. git runs less with
# \`LESS=FRX\` and \`-X\` suppresses the termcap init, so that less never switches buffers. Measured
# on this host (tmux 3.7b, git 2.55.0): in a pane sitting in \`git log\`, \`alternate_on\` is 0 and
# \`pane_current_command\` is \`git\` — NOT \`less\`, since git keeps the process group. So the name
# arm matches both spellings, anchored so \`gitk\` and \`lesspipe\` are not pagers. \`less\` and \`man\`
# still come in on \`alternate_on\`; the name arm is what \`git log\`, \`git diff\` and \`git show\` need.
#
# The cost of the name arm: a long \`git clone\` or \`git push\` also reports \`git\`, so a notch there
# sends an arrow into a process not reading stdin instead of opening copy mode. Nothing is typed
# into the shell and nothing scrolls away — the same "sit still" the wheel already did, and it ends
# when the command does.
bind -n WheelUpPane   if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send -M' "if -F '#{||:#{alternate_on},#{m/r:^(git|less)$,#{pane_current_command}}}' 'send -N1 Up' 'copy-mode -e'"
bind -n WheelDownPane if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send -M' "if -F '#{||:#{alternate_on},#{m/r:^(git|less)$,#{pane_current_command}}}' 'send -N1 Down' 'copy-mode -e'"

# A copy-mode yank lands on the phone's pasteboard over OSC 52 (§4.7). set-clipboard alone is not
# enough: tmux only emits OSC 52 when the outer terminal advertises the Ms capability, and
# xterm-256color's terminfo does not.
set -g set-clipboard on
set -as terminal-overrides ',*:Ms=\\E]52;%p1%s;%p2%s\\007'
${extras ? EXTRAS : ''}`;
}

/**
 * The opt-out half. Kept whole and appended last so the file reads as what it is: the required
 * part, then the part the user said yes to.
 *
 * This is the hand-written `~/.tmux.conf` this app's own author had been running (2026-08-09),
 * minus what only the reference Swift app needed — its `M-1`..`M-9` window row and the `set-titles`
 * string it read to know which windows existed, neither of which this app has ever sent or read —
 * and minus the two lines that are a person's taste rather than a phone's needs (`base-index`,
 * `pane-base-index`). Every option here is global, i.e. a desktop client on the same server gets it
 * too, and that is exactly why the half is a toggle instead of a fact.
 */
const EXTRAS = `
# Truecolor and underline styles the whole way through tmux. Without RGB the 24-bit colours a
# syntax theme or an agent emits are quantised to 256 on the way out — a different-looking screen
# rather than a broken one, which is what puts it on this side of the toggle. default-terminal is
# guarded: a TERM with no terminfo entry on the host breaks every pane on the server, and this file
# arrives on hosts nobody checked.
set -as terminal-features ',*:RGB,*:usstyle'
if-shell 'infocmp tmux-256color >/dev/null 2>&1' 'set -g default-terminal tmux-256color'

# A phone is ~40 rows, and the status bar spends one of them saying what the app's own chrome
# already shows (window index in the badge, session in Settings). Prefix + S puts it back.
set -g status off
bind S set -g status

# An Escape on a phone is a key on the bar, not half of a meta sequence worth waiting for. This one
# is server-wide (set -s) — the widest reach of anything in the file.
set -s escape-time 0
# More scrollback for the swipe and for T14's search to find. New panes only.
set -g history-limit 50000
`;

/**
 * Push unless the remote file is byte-for-byte the conf these settings ask for. Content equality
 * rather than a marker-version compare: a marker guard can pass stale (same version, edited or
 * truncated file), it cannot tell the two halves apart at all — flipping the toggle changes the
 * file without changing the version — and equality still gives "a version bump replaces v0" free.
 */
export function needsPush(remote: string | null, extras: boolean): boolean {
  return remote !== generateConf(extras);
}

/* --- why nothing of the user's is edited --- */

/**
 * The app used to append one `source-file` line to the user's own tmux conf, so its options
 * survived a tmux server restart. That was the only thing this app wrote outside its own
 * directory, and it was permanent: the options went on applying to every tmux on that host, from
 * any terminal, long after the phone was gone (user, 2026-08-12 — "this app shouldn't alter host
 * state forever").
 *
 * It was also unnecessary. `APPLY_AND_VERIFY` sources the file itself on every connect and the
 * options are `set -g`, which lives on the running server — so the session on the phone is
 * configured either way. The line only bought persistence across a server restart the app is not
 * present for, which is exactly the state it should not own.
 *
 * What is left on a host is one file in a directory named after this app (`~/.config/port22/`),
 * inert unless something sources it, and this is the only thing that does.
 */

/* --- probe, apply, verify --- */

/** Empty output = no tmux, and then the whole feature is silence (§7). A shell builtin rather
 *  than `which`, which is a binary that may not be installed. */
export const PROBE = 'command -v tmux';

export function parseProbe(stdout: string): boolean {
  return stdout.trim() !== '';
}

/**
 * Apply and verify in ONE client command. Measured, not assumed: a server started with no
 * sessions exits the moment its only client leaves, so a separate verify exec finds "no server
 * running" on exactly the fresh host it matters most on. In one chain the client holds the server
 * alive: start (a running server ignores it), source our file into it, read the proof back.
 * Errors to /dev/null and `; true` so the answer is always stdout: `${CONF_VERSION}` or nothing.
 */
export const APPLY_AND_VERIFY = `tmux start-server \\; source-file ~/${CONF_PATH} \\; show -gv @port22 2>/dev/null; true`;

export function parseVerify(stdout: string): boolean {
  return stdout.trim() === String(CONF_VERSION);
}

/** `cat` that answers with empty rather than an error for a missing file — used on files we then
 *  decide about locally (the pushed conf, the user's tmux conf). */
export function readFileCommand(path: string): string {
  return `cat ${path} 2>/dev/null; true`;
}

/* --- sessions (§4.1's attach mode picks one; §4.8 lists them) --- */

/** US (0x1f) as the marker byte in every `-F` format below — JS resolves the escape, so the raw
 *  byte is what crosses the wire (fish would pass a literal `\x1f` through untouched, measured;
 *  the raw byte it passes clean inside single quotes). Nothing a shell, a path or a tmux
 *  diagnostic contains, which is what makes it worth a byte. */
export const SEP = '\u001f';

/** Names only, in tmux's own order — which is what "the most recent" in §4.1 means. Each line is
 *  prefixed with the US byte, the same marker `LIST_WINDOWS` separates fields with: a session name
 *  may contain spaces (`tmux new -s 'work stuff'`, measured) so the name cannot be told from a
 *  tmux diagnostic by its shape, and a byte no diagnostic carries is the thing that can. */
export const LIST_SESSIONS = `tmux list-sessions -F '${SEP}#{session_name}' 2>/dev/null; true`;

export function parseSessions(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(SEP))
    .map((line) => line.slice(1).trimEnd());
}

/* --- windows (§4.5: always exec channels, never the attached PTY) --- */

/** The same marker byte separates the window fields. Unlikely in a path; a window NAME may contain
 *  anything at all, which is why name is the LAST field: the parser rejoins the tail and a name
 *  full of separators (or tabs, or colons) shifts nothing. */

export type TmuxWindow = {
  /** tmux's own `@N` — stable across renumbering, which the index is not. T10's reorder wants it. */
  id: string;
  index: number;
  name: string;
  active: boolean;
  /** The active pane's working directory, full path — T10's card subtitle takes the leaf. */
  path: string;
  /** Columns in the active pane: the snapshot card must render this wide or every line folds. */
  width: number;
  /** The active pane's foreground process — the "process" half of T14's metadata match. */
  command: string;
};

export const LIST_WINDOWS =
  `tmux list-windows -F '` +
  ['#{window_id}', '#{window_index}', '#{window_active}', '#{pane_current_path}', '#{pane_width}', '#{pane_current_command}', '#{window_name}'].join(SEP) +
  `' 2>/dev/null; true`;

/** A line that is not seven-plus fields with an `@N` id and numeric index/width is not a window —
 *  tmux writes its own diagnostics into this stream, and one of those must not become a card. */
export function parseWindows(stdout: string): TmuxWindow[] {
  const windows: TmuxWindow[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const fields = line.split(SEP);
    if (fields.length < 7) continue;
    const [id, index, active, path, width, command] = fields;
    if (!/^@\d+$/.test(id) || !/^\d+$/.test(index) || !/^\d+$/.test(width)) continue;
    windows.push({
      id,
      index: Number(index),
      active: active === '1',
      path,
      width: Number(width),
      command,
      name: fields.slice(6).join(SEP),
    });
  }
  return windows;
}

/**
 * Windows are addressed by tmux's own `@N` id, never by `:index` (BUGS "One exec per grid open
 * fails", 2026-08-17). An index is a POSITION, and three separate things move it under us —
 * measured on tmux 3.7b on this box, not assumed:
 *
 * - **Renumbering.** With the user's `renumber-windows on` — a setting this app deliberately does
 *   not own (see EXTRAS) — killing one window slides every higher index down by one. A card list
 *   taken before that kill then addresses the wrong windows: `kill-window -t :2` aimed at the card
 *   that WAS index 2 exited 0 and killed the window that had slid into slot 2 instead. A silent,
 *   successful kill of a bystander, which is the outcome BUGS feared and worse than the one it
 *   named.
 * - **Name fallback.** `-t :7` with no window at index 7 does not stop at "no such index": tmux
 *   falls through to matching the window NAME, so a window called `7` sitting at index 5 answered
 *   the capture — exit 0, wrong pane, no error anywhere.
 * - **The session isn't pinned either.** `:N` means "index N in whatever session tmux calls
 *   current", and `pollCommand`'s note above already measured that alternating between sessions on
 *   the user's host. A `@N` id is unique across the whole SERVER — verified: a capture by id
 *   answered for a window in a session that was not the current one.
 *
 * What survives of the old contract: nothing user-typed reaches a command line. `@\d+` is as tight
 * a shape as the integer was.
 *
 * Exported so every command that addresses a window routes through this one guard — including
 * `searchPaneCommand` over in `src/search-model.ts`, which built its own `-t :index` until
 * 2026-08-17 and had the same bug wearing a different face: a grep whose target had slid, or that
 * matched a window NAMED like the index, answers about the wrong scrollback (or none), and the
 * switcher's per-window catch made that look like "no hit".
 */
export function target(id: string): string {
  if (!/^@\d+$/.test(id)) throw new Error(`not a window id: ${id}`);
  return `-t ${id}`;
}

/** `-e` keeps colours as escapes: the card is drawn by a terminal of its own (T10), so what comes
 *  back is fed to one rather than printed.
 *
 *  `-N` keeps the trailing spaces, and it is a colour fix rather than a whitespace one: a cell's
 *  background belongs to the cell whether or not a character sits in it, so a highlighted run that
 *  reaches past its last letter — a selected line, a status bar, Claude Code's queued-message
 *  strip — is spaces carrying a background. Trimmed away, the band stops at the last letter in the
 *  card and runs to its true width in the pane, which is a band that changes length at the swipe's
 *  hand-over (user, 2026-08-11). Needs tmux 3.1, where the flag arrived. */
export function capturePaneCommand(id: string): string {
  return `tmux capture-pane -p -e -N ${target(id)}`;
}

export function selectWindowCommand(id: string): string {
  return `tmux select-window ${target(id)}`;
}

/** Exit 1 here means one thing only, and it is not "maybe": a `@N` is never reused, so tmux
 *  answering `can't find window: @N` is tmux saying that window is already gone — verified on
 *  3.7b, a kill against a dead id exits 1 and touches nothing. Nothing else can be killed by
 *  mistake, which is exactly what `:index` could not promise. */
export function killWindowCommand(id: string): string {
  return `tmux kill-window ${target(id)}`;
}

/**
 * A new window always lands at the END of the list (user, 2026-08-10) — for both doors into one,
 * the grid's + and a swipe left off the last tab. Untargeted, tmux fills the lowest free index
 * instead, so with a gap in the list (kill window 2 of 0..4) the next new one appears in the
 * middle of the grid, where nothing put it. `-a -t {end}` is "after the last window".
 *
 * Quoted because the remote shell sees this string first and fish expands a lone `{end}` to `end`
 * — bash leaves single-element braces alone, fish does not, and the host's shell is not ours to
 * assume. It still makes the window active, so the attached client is already looking at it.
 */
export const NEW_WINDOW = "tmux new-window -a -t ':{end}'";

/** `-b`/`-a` shuffle neighbours out of the way (tmux ≥ 3.2) — a bare move-window refuses an
 *  occupied index, and a drag-reorder's drop slot is always occupied. Landing indices depend on
 *  the user's own base-index/renumber-windows, so T10 re-lists after every move. */
/* ponytail: the one window command still on `:index`. A drop slot IS a position — `-b`/`-a` is
 * chosen by `to < from`, which ids cannot answer — and its two indices come from a list taken at
 * the drag's start and are re-listed the moment the move lands, so the window it can address by
 * mistake is a neighbour it was about to shuffle anyway. Nothing is destroyed either way. Give
 * `reorderArgs` a direction and this can take ids too. */
export function moveWindowCommand(from: number, to: number): string {
  const slot = (index: number) => {
    if (!Number.isInteger(index) || index < 0) throw new Error(`not a window index: ${index}`);
    return `:${index}`;
  };
  return `tmux move-window ${to < from ? '-b' : '-a'} -s ${slot(from)} -t ${slot(to)}`;
}

/* --- the poll (badge for T7, foreground process for T11's ribbon) --- */

export const POLL_MS = 2000;

/** Until a client is attached the poll is not watching, it is WAITING: the shell's own `tmux
 *  attach` lands a few hundred ms after connect, and T9's tabs button waits on it — so at 2s
 *  granularity the button arrives up to a full tick after the session is usable (log, 2026-08-12).
 *  Fast until it flips, then the steady beat. */
export const FAST_POLL_MS = 250;

/** How many fast ticks the attach gets before the poll settles anyway — 5s at `FAST_POLL_MS`. The
 *  cap is not a nicety: a host that HAS tmux under a start mode that never enters it (`shell`, or
 *  a custom line without it) never attaches at all, and without this it would fast-poll for the
 *  life of the session. A hand-typed `tmux attach` an hour in is still picked up, on the steady
 *  beat, which is what it would have been before any of this. */
export const FAST_POLL_TICKS = 20;

export function pollDelay(attached: boolean, ticks: number): number {
  return !attached && ticks < FAST_POLL_TICKS ? FAST_POLL_MS : POLL_MS;
}

/**
 * One exec every ~2s answers everything at once: is a client attached, which window is active
 * (the badge), and what runs in the active pane (the ribbon). This is why the badge rides the
 * poll rather than the pushed set-titles string: a title change would need an xterm
 * `onTitleChange` bridge out of the webview that T4 never built, works only while our PTY is the
 * attached client, and would still leave the ribbon needing this exact poll — one mechanism, one
 * parse. Command is LAST for the same reason window name is: nothing after it to shift.
 *
 * ponytail: "attached" is `#{session_attached} > 0` — some client on the session tmux resolves
 * for an outside command, which for this app's one user is the phone's own PTY. A desktop client
 * attached while the phone sits at a plain shell would fool it; telling *whose* client it is
 * means walking `#{pane_tty}` against our own PTY, the upgrade if it ever matters.
 */
/**
 * Untargeted, `display-message` answers about whatever session and window tmux last considered
 * current — which on a host running other tmux sessions alternates beat to beat. Measured on
 * device 2026-08-16, the user sitting still in one window: `windowIndex` walked 6 → 7 → 8 → 7 → 6
 * with a different `pane_current_command` behind each, so the ribbon showed another window's
 * process, the badge flickered, and the app's own `activePosIn` (which reads this) kept changing
 * its mind about which card was active.
 *
 * `=name:` names the session we attached to, its current window, its active pane — which is what
 * our client is looking at. `=` means "exact name, no prefix match", so a session called `port22x`
 * cannot answer for `port22`.
 */
/**
 * `#{alternate_on}` rides along because the ribbon's §4.4 "unknown TUI" gate has no other honest
 * source. It used to read the OUTER xterm's buffer type (`modes.altScreen`, src/scroll-model.ts),
 * and under tmux that is permanently 1 — a tmux CLIENT is itself a full-screen app — so the gate
 * swallowed `running` for every command in every tmux session, which is this app's default start
 * mode (emulator, 2026-08-17: `sleep 30` detected, chip region empty at all 15 samples).
 * `alternate_on` is per PANE, i.e. it answers the question the gate actually asks: is the thing in
 * front of the user a full-screen app. The conf's wheel binding above already switches on it.
 *
 * NOT a replacement for `modes.altScreen`: the scroll router wants the outer reading (under tmux
 * you do want arrows), so the two facts stay separate — see `selectRecipe` and `scrollRoute`.
 */
export function pollCommand(session: string | null): string {
  const target = session === null ? '' : ` -t ${shellQuote(`=${session}:`)}`;
  return (
    `tmux display-message${target} -p '` +
    ['#{session_attached}', '#{window_index}', '#{pane_pid}', '#{alternate_on}', '#{pane_current_command}'].join(SEP) +
    `' 2>/dev/null; true`
  );
}

/** The untargeted form, still the fallback when we cannot name the session (`custom` start mode,
 *  or an `attach` that never picked one) and when a targeted poll answers nothing. */
export const POLL = pollCommand(null);

export type TmuxPoll = {
  attached: boolean;
  windowIndex: number;
  pid: number;
  /** The ACTIVE PANE's alternate screen — a full-screen app in front of the user. Nothing to do
   *  with the outer terminal's own buffer, which under tmux is always the alternate one. */
  paneAlt: boolean;
  command: string;
};

/** `null` = no server, or garbage — either way there is nothing to say.
 *
 *  `paneAlt` is deliberately NOT part of the reject test: a tmux too old to know
 *  `#{alternate_on}` renders it empty, and rejecting the line for that would take the badge, the
 *  tabs button and the ribbon down with it. Anything but `1` reads as false, which is the same
 *  answer the gate had before this field existed. */
export function parsePoll(stdout: string): TmuxPoll | null {
  const line = stdout.trim().split('\n')[0] ?? '';
  const fields = line.split(SEP);
  if (fields.length < 5) return null;
  const [attached, windowIndex, pid, paneAlt] = fields;
  if (!/^\d+$/.test(attached) || !/^\d+$/.test(windowIndex) || !/^\d+$/.test(pid)) return null;
  return {
    attached: Number(attached) > 0,
    windowIndex: Number(windowIndex),
    pid: Number(pid),
    paneAlt: paneAlt === '1',
    command: fields.slice(4).join(SEP),
  };
}

/** A shell at rest is not a foreground process (§4.4: shell name = idle). */
export const IDLE_SHELLS = new Set(['fish', 'bash', 'zsh', 'sh']);

/** What T11's ribbon keys on: the active pane's non-shell foreground, or nothing. */
export function foregroundFrom(poll: TmuxPoll | null): { command: string; pid: number } | null {
  if (poll === null || !poll.attached || IDLE_SHELLS.has(poll.command)) return null;
  return { command: poll.command, pid: poll.pid };
}

/* --- derived state the screens read --- */

export type ConfigStatus = 'off' | 'applied' | 'not-applied';

/** The three states §4.5 puts in Settings. 'off' is the start mode's — a session that is not a
 *  tmux one is never configured — and the other two are the push's. */
export function deriveConfigStatus(
  usesTmux: boolean,
  pushed: 'applied' | 'not-applied',
): ConfigStatus {
  return usesTmux ? pushed : 'off';
}

/**
 * Tabs follow tmux, whoever started it: the host has it, and a client is attached.
 *
 * The conf used to be a third term (§4.5: "the switcher needs a configured tmux"), and it was
 * wrong — nothing behind the button reads the conf. `list-windows`, `capture-pane`,
 * `select-window`, `kill-window` and `move-window` are stock tmux; the conf buys the wheel notch,
 * OSC 52 and the RGB comforts, none of which the switcher touches. What that term actually did was
 * tie the button to the START MODE, since the conf is only pushed for a tmux one — so a user who
 * opened a plain shell and then typed `tmux` themselves got a session with windows and a button
 * that never lit (user, 2026-08-12).
 *
 * The attached term IS decoration-free. Every action behind the button (`select-window`, `kill-window`,
 * `new-window`, the snapshots) targets whatever session the exec channel resolves to, which is only
 * the session on screen while this PTY is inside tmux. With tmux installed and the conf pushed but
 * the shell never entering it — the default, since §4.9 starts a plain shell and never auto-attaches
 * — the button used to open a switcher onto someone else's windows, where taps quietly drove another
 * client and the phone's grid never changed (found on device, T13/T9.4).
 *
 * Ceiling, inherited from the probe: "attached" is `#{session_attached} > 0`, so a desktop client
 * attached while the phone is not still reads as attached. Same ponytail note as in `probe`.
 */
export function tabsAvailable(present: boolean | null, attached: boolean): boolean {
  return present === true && attached;
}

/**
 * What the disabled tabs button says when it is tapped (user, 2026-08-12). §7 wanted no button at
 * all, and a control that is simply absent reads as this app being broken rather than as something
 * the session does not have — so it stays, greyed, and answers when asked.
 *
 * The answer has to name the actual reason or it is worse than silence: a host with no tmux and a
 * session that merely chose not to use it need opposite advice.
 */
export function tabsHint(present: boolean | null, usesTmuxMode: boolean): string {
  if (present === false) return 'Tabs need tmux, and this host has not got it.';
  if (!usesTmuxMode) return 'Tabs need a tmux session — choose a tmux start mode in Settings.';
  return 'Waiting for tmux…';
}

/**
 * POSIX single-quote escaping — and fish parses `'…'\''…'` the same way (its outside-quotes `\'`
 * is a literal quote), so it is safe on the login shells this app meets. T9's own commands
 * interpolate only integers and its own literals; this is the exported contract for anything
 * user-typed that later tasks put on a remote command line (upload paths, T8).
 */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
