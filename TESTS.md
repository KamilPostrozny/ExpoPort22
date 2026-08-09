# TESTS.md — device verification test cases

Written during implementation (T6–T12), executed later in one hardware phase on a physical
iPhone against a real host. Unit tests (`bun test`) already ran at implementation time; this
file holds only what needs a device, a finger, or a live SSH session.

Conventions:
- Case IDs `TX.n` (task, number). Each case: **Setup → Steps → Expect**.
- A case that depends on another task's feature says so inline.
- Tick `[ ]` → `[x]` only on hardware, during the verification phase (T13).

## Cross-task dependency map

How the remaining slices interlock — read before testing, because a failure in one task's
cases can be rooted in its upstream:

- **T6 (scroll)** lives inside the T4 DOM component (`src/terminal.tsx`), where mouse
  protocol / alt-screen / DECCKM state is known. It **exposes those mode signals** over the
  bridge; T11's ribbon consumes them. A T11 ribbon failure on alt-screen detection may be a
  T6 signal bug.
- **T7 (key bar)** implements the **native `TextInput` decision from T4** — keyboard input
  leaves the webview. Dictation filter and held-delete (T12 polish) sit on this input. T7's
  bar is the mount point for T8 (Paste popover, ⋯ menu), T10 (tabs circle, swipe-up), and
  T11 (bar swipe ↔, ribbon above bar).
- **T9 (tmux side-channel)** provides exec-channel helpers (`list-windows`, `capture-pane`,
  `select/kill/new/move-window`), the window badge feed (T7's tabs circle reads it), and the
  foreground-process poll (T11's ribbon reads it). T10 and T11 issue every tmux action
  through T9's helpers — never the attached PTY.
- **T8 (clipboard + uploads)** needs T7's Paste key and ⋯ menu, and T2's SFTP. The
  quick-attach flow is triggered from T11's agent ribbon cap — T8 ships the helper, T11
  wires the cap.
- **T10 (switcher)** needs T9's helpers and T7's tabs button + bar swipe-up hook.
- **T11 (bar swipe + ribbon)** needs T9 (snapshots, poll), T7 (bar), T6 (mode signals),
  T8 (quick-attach helper).
- **T12 (settings + polish)** touches all of the above; its cases re-walk earlier features
  through the Settings door (theme restyle live, tmux toggle hiding T10's tabs button,
  Forget host key moving off the mismatch screen).

Sections below are appended per task, in implementation order.

## T6 — Scroll gesture system

All cases: connected to a real host, terminal on screen. "Notch" = one cell height of finger
travel = one line. Watch the Metro log — the DOM side prints `[terminal] scroll <route> <n>`
per spend and `[terminal] modes {...}` per mode change.

### T6.1 — Plain-shell scrollback pan
- **Setup**: plain shell, `seq 1 200` so there is scrollback.
- **Steps**: pan up one finger slowly; pan back down.
- **Expect**: viewport scrolls locally, ~one line per cell height of travel, content follows
  the finger's direction; log says route `local`; nothing is sent to the PTY (no stray input
  at the prompt).
- [ ]

### T6.2 — `less` scrolls by arrows, both directions
- **Setup**: `less /etc/services` (alt screen, no mouse, no DECCKM).
- **Steps**: pan up (toward earlier lines), then pan down.
- **Expect**: `less` moves line-by-line both ways; log route `arrows`; `less` shows no `ESC O A`
  garbage — bytes are `CSI A`/`CSI B`.
- [ ]

### T6.3 — `htop` with mouse on: wheel at the finger's cell
- **Setup**: `htop` (requests mouse + SGR).
- **Steps**: pan over the process list; then pan while the finger sits over a different column.
- **Expect**: the list scrolls; log route `wheel`; scrolling acts at the row/column under the
  finger (htop scrolls its list regardless, but tmux panes — if attached — scroll the pane
  under the finger, which is the real assertion once tmux is configured).
- [ ]

### T6.4 — DECCKM variant: vim vs less
- **Setup**: `vim` on a long file, `:set mouse=` first so no mouse reporting; separately `less`.
- **Steps**: pan in vim; pan in less.
- **Expect**: vim moves the cursor line-by-line (receives `SS3 A/B` — DECCKM on); less moves
  too (receives `CSI A/B` — DECCKM off). Neither shows literal escape garbage.
- [ ]

### T6.5 — Momentum flick, and a touch stops the coast dead
- **Setup**: plain shell with deep scrollback (`seq 1 2000`).
- **Steps**: flick hard; while it is still coasting, tap the screen once.
- **Expect**: scroll continues after release, decaying smoothly (log `coast start`, then
  `scroll local` lines thinning out); the tap stops it instantly and does nothing else — no
  keyboard raise, no selection, no cursor move.
- [ ]

### T6.6 — One finger and two fingers are the same pan
- **Setup**: plain shell with scrollback.
- **Steps**: pan with one finger; repeat the same travel with two fingers; add a second finger
  mid-pan; lift one of two mid-pan.
- **Expect**: identical scrolling for the same travel; adding/removing a finger neither jumps
  nor re-triggers; no zoom, no selection.
- [ ]

### T6.7 — Stationary long-press still selects (T4 regression)
- **Setup**: plain shell, some text on screen, keyboard down (T4's WebKit focus finding).
- **Steps**: long-press a word without moving; then lift and tap once elsewhere.
- **Expect**: selection appears with the system edit menu (Copy · Look Up …), exactly as T4
  verified; the pan layer never claims the touch (no `scroll` log line); the tap clears it.
- [ ]

### T6.8 — Notch granularity is one line per cell height
- **Setup**: `less /etc/services` with line numbers (`less -N`) so movement is countable.
- **Steps**: pan exactly ~5 cell heights (about 5 rows of text) slowly.
- **Expect**: the view moves ~5 lines, not 1 and not 20; a sub-cell wiggle moves nothing but a
  following pan picks up the carried remainder (no dead zone at slow speeds).
- [ ]

### T6.9 — Mode signal fires on entering and leaving vim
- **Setup**: Metro log visible; plain shell.
- **Steps**: run `vim`, wait for the screen; quit with `:q!`; run `htop`; quit with `q`.
- **Expect**: on vim entry a `[session] modes {"altScreen":true,…,"decckm":true}` line (and its
  `[terminal]` twin from the DOM side); on exit both flags return false; htop entry/exit flips
  `mouseReporting` true/false. One line per change, not one per keystroke.
- [ ]

## T7 — Key bar core

All cases: connected to a real host, terminal on screen, unless said otherwise. The bar's
decisions are unit-tested (`src/keybar-model.test.ts`); these cases are the finger-and-host
half. Stubs in play: Settings is a T12 stub alert (with a working Disconnect), Paste
long-press is a T8 no-op, the tabs badge shows the default `1` until T9's feed, tabs tap and
switcher drag are T10 no-ops, horizontal bar swipe only logs into T11's hook.

### T7.1 — A chord reaches the host: ^C kills a running sleep
- **Setup**: at a shell prompt, run `sleep 100`.
- **Steps**: tap Ctrl (tints accent, chord strip appears), tap the `C · interrupt` cap — or
  tap Ctrl then type `c` on the keyboard.
- **Expect**: `^C` echoes, `sleep` dies, prompt returns; Ctrl disarms (tint gone, strip
  slides away) after the one chord.
- [ ]

### T7.2 — Ctrl double-tap locks and sends repeated chords
- **Setup**: shell prompt with a longish command typed (do the typing *before* locking —
  while locked, every letter chords).
- **Steps**: double-tap Ctrl (<300ms apart) — accentA tint + halo; type `a`, then `e`; tap
  the `C` cap twice; tap Ctrl once.
- **Expect**: while locked every letter chords (`^A`/`^E` jump to start/end of the line) and
  the strip stays up through repeated caps (`^C` twice = two fresh prompts); the single tap
  unlocks (tint + strip gone) and letters type normally again.
- [ ]

### T7.3 — All five strip caps are observable
- **Setup**: shell prompt with some history; then `sleep 100` for Z.
- **Steps**: arm Ctrl before each: `R` → reverse-i-search prompt appears (Esc leaves it);
  `L` → screen clears to one prompt line; with `sleep 100` running, `Z` → `[1]+ Stopped`;
  `C` at an empty prompt → `^C` + fresh prompt; `D` at an empty prompt of a nested shell
  (`bash` first) → the nested shell exits (§7: instant, no confirmation).
- **Expect**: each cap sends its byte once and disarms; captions read interrupt · suspend ·
  history · clear · EOF.
- [ ]

### T7.4 — Esc leaves vim insert mode
- **Setup**: `vim`, press `i`, type a word.
- **Steps**: tap Esc, then type `:q!` + Return (keyboard).
- **Expect**: `-- INSERT --` vanishes on the Esc tap; the `:q!` reaches the command line —
  proof the byte was ESC (0x1b), not text.
- [ ]

### T7.5 — Tab completes in the shell
- **Setup**: shell prompt, type `ls /et`.
- **Steps**: tap Tab.
- **Expect**: completes to `/etc/` (0x09 went down the PTY).
- [ ]

### T7.6 — Paste types the pasteboard
- **Setup**: copy a string on the phone (e.g. from Notes): `echo pasted-ok`.
- **Steps**: tap Paste at a prompt. Then long-press Paste (~420ms).
- **Expect**: the text is *typed* at the prompt, no Return of ours (never executes, §4.4);
  long-press does nothing yet — TODO(T8) clipboard popover.
- [ ]

### T7.7 — Arrows navigate in vim (DECCKM) and walk history at a prompt
- **Setup**: `vim` on a multi-line file; separately a shell with history.
- **Steps**: open the arrows popover (button tints accent), tap ↑ ↓ ← → in vim; quit; at the
  prompt tap ↑ then ↓.
- **Expect**: vim's cursor moves cell by cell (SS3 — DECCKM on, watch `[session] modes`
  say `"decckm":true`); at the prompt ↑/↓ walk shell history (CSI — DECCKM off). Popover
  stays open across taps; outside tap or the button closes it.
- [ ]

### T7.8 — Home/End at a prompt
- **Setup**: shell prompt, type a long command, caret at the end.
- **Steps**: arrows popover → Home, then End.
- **Expect**: caret jumps to line start, then line end (CSI H / CSI F; shells map both).
- [ ]

### T7.9 — Bar swipe ↓ hides the keyboard, ↑ shows it
- **Setup**: keyboard up (it rises on connect).
- **Steps**: swipe down anywhere on the bar; then swipe up on it; then swipe up again with
  the keyboard already up.
- **Expect**: keyboard slides away (bar stays, docked at the bottom, terminal grows —
  `[terminal] size` logs a taller grid); swipe up raises it again; the second ↑ is a no-op
  for now — TODO(T10) switcher drag.
- [ ]

### T7.10 — Keys never fire during a bar swipe
- **Setup**: shell prompt, keyboard up.
- **Steps**: start the ↓ swipe with the finger ON the Esc key; likewise across Ctrl/Tab.
- **Expect**: keyboard hides, but no key fires (nothing at the prompt, Ctrl not armed) —
  the pan activating cancels the press. The press-in dim may flash; the send must not
  happen.
- [ ]

### T7.11 — Press feedback: dim/shrink + haptic on touch, not on echo
- **Setup**: any key; airplane-mode-slow or `sleep`-blocked session is the interesting case.
- **Steps**: press and hold a key; watch and feel.
- **Expect**: the key dims and shrinks while touched and the light haptic fires on the
  *touch*, immediately — even when the session is slow to echo (§4.4: on touch, not echo).
- [ ]

### T7.12 — Two-finger tap opens Settings; two-finger pan still scrolls
- **Setup**: shell with scrollback (`seq 1 200`).
- **Steps**: tap the grid once with two fingers (quick, no movement); then two-finger *pan*.
- **Expect**: the tap opens the Settings stub (T12 alert; `[terminal] two-finger tap` in the
  log) and does not scroll; the pan scrolls exactly as in T6.6 and opens nothing.
- [ ]

### T7.13 — Native input owns the keyboard; selection works with it up (the T4 fix)
- **Setup**: fresh connect (keyboard rises on its own), text on screen.
- **Steps**: type a command — watch it echo; touch the terminal once — keyboard should
  hide; swipe the bar ↑ to bring it back; with the keyboard UP, long-press a word.
- **Expect**: typing reaches the PTY through the native input (webview never focused — no
  webview keyboard flicker); touching the terminal dismisses the keyboard (native default,
  unfought); the long-press selects with the system edit menu even while the keyboard is up
  — the architecture T4 measured for. Backspace and held-delete: single deletes work;
  auto-repeat on hold is TODO(T12).
- [ ]

## T9 — tmux side-channel + config push

All cases: a real host with a fish login shell unless said otherwise. The side-channel has no
UI of its own yet, so most assertions are Metro-log reads: `[tmux] {...}` prints the state on
every change (present/config/attached/windowIndex/foreground), `[ssh] exec` prints every
side-channel command and its answer. Stubs in play: the tabs circle renders but its tap is a
T10 no-op; the ribbon (T11) and the Settings tmux row (T12) do not exist yet — their feeds do.

### T9.1 — Fresh host gets conf + source line + verify round-trip
- **Setup**: on the host: `rm -rf ~/.config/port22` and remove any `port22.conf` source line
  from the tmux conf; tmux installed, no server running (`tmux kill-server`).
- **Steps**: connect from the phone; watch the log; then on the host inspect the files.
- **Expect**: log shows the probe answer, the SFTP upload, and `[tmux] configure: applied`;
  `~/.config/port22/port22.conf` exists and starts `# port22-conf-v1`; the user's tmux conf
  gained exactly one `source-file -q ~/.config/port22/port22.conf` line; `[tmux]` state says
  `"config":"applied"`; the tabs circle appears on the bar. (Settings row showing "applied" is
  T12 — until then the log line is the assertion.)
- [ ]

### T9.2 — Works on a fish login shell
- **Setup**: host user's shell is fish (`chsh -s $(which fish)` or already so).
- **Steps**: walk T9.1 on that host.
- **Expect**: identical outcome — no parse errors in the log (`Unknown command`, `Missing end`
  are the fish tells), verify still answers `1`. Every exec line the log shows is the
  fish-and-sh common ground pinned in `src/tmux-model.test.ts`.
- [ ]

### T9.3 — Toggle off: tabs affordance gone, no push on next connect
- **Setup**: connected with config applied (T9.1); host conf files present.
- **Steps**: turn "Configure tmux" off (until T12's sheet: flip `configureTmux` in the settings
  blob or a dev build); disconnect; `rm -rf ~/.config/port22` on the host; reconnect.
- **Expect**: the tabs circle does not render (derived state needs toggle AND applied); the log
  shows probe but **no** SFTP upload and no `configure:` line; `~/.config/port22` stays absent.
  The poll still runs — the ribbon feed does not depend on the toggle.
- [ ]

### T9.4 — No tmux on the host: zero tmux UI, zero message
- **Setup**: a host (or container) without tmux on PATH.
- **Steps**: connect; use the session normally for a minute.
- **Expect**: log shows the probe answering empty and `"present":false`; no tabs circle, no
  poll lines, no error, no mention of tmux anywhere on screen (§7: silence, not a message).
- [ ]

### T9.5 — Badge tracks `select-window` from another client
- **Setup**: connected, `tmux attach` typed into the phone session (window badge visible on the
  tabs circle); a laptop attached to the same session.
- **Steps**: from the laptop: `tmux select-window -t :2`, then `:1`.
- **Expect**: within ~2s (one poll beat) the badge follows to 2, then back; log shows one
  `[tmux]` line per change, not one per poll.
- [ ]

### T9.6 — capture-pane snapshot carries ANSI colour
- **Setup**: attached to tmux; something colourful on screen (`ls --color`, `git log`).
- **Steps**: trigger `capturePane` — until T10's cards exist, from the switcher once it lands,
  or by a temporary dev call. **Dep: T10** for the on-screen assertion.
- **Expect**: the captured string contains `\x1b[` colour sequences (`-e` did its job); fed to
  a terminal it reproduces the pane's colours.
- [ ]

### T9.7 — new/kill/select/move helpers observable from a second client
- **Setup**: attached to tmux; laptop attached to the same session, watching `tmux list-windows`.
  **Dep: T10** — the helpers have no UI caller until the switcher; drive them from it then.
- **Steps**: via the switcher (T10): new tab, select another, reorder by drag, close one.
- **Expect**: the laptop sees each: a window appears (`new-window`), the active marker moves
  (`select-window`), indices reorder (`move-window -b`/`-a`), a window dies (`kill-window`).
  Every command in the log is an exec channel — the phone's PTY never echoes any of it.
- [ ]

### T9.8 — Poll: `sleep 100` is foreground, the prompt is idle
- **Setup**: attached to tmux, at a fish prompt. **Dep: T11** for the on-screen ribbon; until
  then the `[tmux]` log line is the assertion.
- **Steps**: run `sleep 100`; wait ~3s; Ctrl-C it; wait ~3s.
- **Expect**: log flips to `"foreground":{"command":"sleep","pid":…}` within a beat, then back
  to `"foreground":null` (fish = idle) after the interrupt. vim and `claude` likewise register;
  a bare prompt never does.
- [ ]

### T9.9 — Version bump replaces an old conf
- **Setup**: on the host: `printf '# port22-conf-v0\nset -g mouse on\n' > ~/.config/port22/port22.conf`.
- **Steps**: connect.
- **Expect**: log shows the read-back, the push (content differs), and `configure: applied`;
  the file on the host now starts `# port22-conf-v1`. Reconnecting again shows the read-back
  and **no** second upload — byte-identical content skips the push.
- [ ]

### T9.10 — Failed push changes nothing visible
- **Setup**: on the host: `chmod 500 ~/.config` (or `chattr +i` the port22 dir) so the SFTP
  write fails; no `port22.conf` present.
- **Steps**: connect; use the session.
- **Expect**: the session works normally; log shows `[tmux] configure failed …` and state stays
  `"config":"not-applied"`; no tabs circle, no alert, no banner — §7's "failed conf push
  changes nothing visible". Restore with `chmod 700 ~/.config`; the next connect applies.
- [ ]

## T8 — Clipboard + ⋯ menu + uploads

All cases: connected to a real host, terminal on screen, tmux configured (a yank needs the
pushed OSC 52 lines). Watch the Metro log: `[clipboard]` prints on every slot change,
`[ssh] upload` / `[ssh] listDirectory` / `[ssh] exec` print every SFTP and exec call,
`[upload]` prints the quick-attach path and any failure.

### T8.1 — OSC 52 yank fills a slot and the pasteboard
- **Setup**: attached to tmux, some text on screen.
- **Steps**: yank in copy-mode (`prefix [`, select, Enter); then long-press Paste; also paste
  into another iOS app.
- **Expect**: the popover's top slot shows the yanked text with "tmux yank · just now"; the
  other app pastes the same text (pasteboard got it too); log shows one `[clipboard]` line.
- [ ]

### T8.2 — Three-yank rotation
- **Setup**: as T8.1.
- **Steps**: yank four different strings; open the popover.
- **Expect**: exactly three yank slots, newest on top, the first yank gone; the phone-pasteboard
  row (holding yank four — the pasteboard follows the last yank) sits below them.
- [ ]

### T8.3 — Pin survives rotation and an app restart
- **Setup**: one yank in the slots.
- **Steps**: open the popover, tap the pin glyph on that slot; yank three more strings; open
  the popover again; force-quit the app, relaunch, reconnect, open the popover.
- **Expect**: the pinned slot is still there after the three yanks (fourth row, "· pinned"
  instead of an age) and still there after the restart — pins live in SecureStore, yanks do
  not (the three unpinned ones are gone after relaunch).
- [ ]

### T8.4 — Paste tap types the top slot and never executes
- **Setup**: yank `echo yanked` (with no newline selected); cursor at an empty prompt.
- **Steps**: tap Paste once.
- **Expect**: `echo yanked` appears at the prompt, **not run** — no Return travels, the cursor
  sits at the end of the typed text. Pressing Return manually runs it (proof the text is real).
- [ ]

### T8.5 — Long-press popover: previews, provenance, pasteboard slot, banner once
- **Setup**: at least one yank in the slots; copy something in another iOS app first.
- **Steps**: long-press Paste (~420ms); read the popover; close it (outside tap); long-press
  again.
- **Expect**: slots show content preview (one line, ellipsized) + provenance ("tmux yank ·
  N min ago"); the phone-pasteboard row is last and shows the other app's text; iOS's paste
  banner fires **once per open** (on the read), not per row; outside tap closes.
- [ ]

### T8.6 — Multiline yank stays unexecuted
- **Setup**: yank a multi-line block (two shell lines) in copy-mode.
- **Steps**: open the popover, tap that slot.
- **Expect**: both lines land at the prompt as typed input — the shell may show continuation,
  but nothing runs until a manual Return. The yank's own embedded newline travels because it is
  *content*; the app appends none of its own.
- [ ]

### T8.7 — ⋯ menu: three pickers reachable
- **Setup**: connected, keyboard up.
- **Steps**: tap ⋯; tap each of Files / Photo or video / Camera in turn (cancel each picker).
- **Expect**: the menu opens with the keyboard dismissed (§4.4); Files opens the document
  picker, Photo or video the photo library (no permission prompt — PHPicker), Camera asks for
  camera permission once then opens the camera; cancelling any picker returns to the terminal
  with nothing typed and no sheet.
- [ ]

### T8.8 — Destination sheet: browse, breadcrumb, descend
- **Setup**: pick a file via ⋯ → Files.
- **Steps**: read the sheet; tap a directory; tap `..`; watch the breadcrumb.
- **Expect**: the sheet opens at `$HOME` (first ever run) with directories first then files,
  names mono; tapping a directory descends and re-lists (fresh `listDirectory` in the log);
  `..` walks up; the breadcrumb tracks the path with `/` accented and the current segment
  bright.
- [ ]

### T8.9 — Collision is visible and overwrite works
- **Setup**: on the host: `echo old > ~/collide.txt`; pick any file via ⋯ → Files.
- **Steps**: in the sheet, type `collide.txt` into SAVE AS while in `$HOME`; read the listing;
  Save here; on the host `cat ~/collide.txt`.
- **Expect**: `collide.txt` is visible in the listing (files are shown for exactly this) and
  tints warning while the field matches it, with "— replaces the existing file" on the SAVE AS
  label; saving overwrites without any further prompt; the host file now holds the upload.
- [ ]

### T8.10 — Editable filename lands the file under the new name
- **Setup**: pick a file with a known name via ⋯ → Files.
- **Steps**: clear SAVE AS, type `renamed hello.txt`, Save here; `ls` on the host.
- **Expect**: the file lands as `renamed-hello.txt` (the sanitiser turns the space into a dash
  on save); the original name is nowhere on the host.
- [ ]

### T8.11 — Camera default name is the timestamp
- **Setup**: ⋯ → Camera, take a photo, accept it.
- **Expect**: the sheet's SAVE AS field pre-fills `YYYYMMDDTHHMMSS.jpg` (UTC, this minute) —
  not the camera's own IMG-style name.
- [ ]

### T8.12 — "Save here" saves silently
- **Setup**: any destination upload; the terminal at a prompt with a distinctive line.
- **Steps**: Save here; watch the terminal.
- **Expect**: the sheet dismisses, the file lands (verify on the host), and the terminal shows
  **nothing** — no typed path, no output, the prompt untouched (§4.6: nothing typed into the
  session from this flow).
- [ ]

### T8.13 — Last destination is remembered
- **Setup**: complete T8.8's browse ending in a subdirectory, Save here.
- **Steps**: run a second ⋯ upload; then force-quit, relaunch, reconnect, a third upload.
- **Expect**: the second and third sheets open directly in that subdirectory (persisted in
  settings); if the directory has meanwhile vanished, the sheet falls back to `$HOME` without
  an error.
- [ ]

### T8.14 — ⋯ circle tints accent and goes inert during the send
- **Setup**: a large file (tens of MB — the send needs to take a visible moment) via ⋯ → Files.
- **Steps**: Save here; immediately look at the ⋯ circle and try tapping it.
- **Expect**: the circle is accent-filled with the glyph in background colour for the duration
  of the SFTP write, and tapping it does nothing; it returns to glass when the send settles —
  that is the entire progress UI (§4.4/§4.6).
- [ ]

### T8.15 — Unwritable destination: one alert, nothing typed, nothing left
- **Setup**: on the host: `mkdir -p ~/noentry && chmod 500 ~/noentry`; upload via ⋯ → Files.
- **Steps**: browse into `noentry` (listing works — read is allowed), Save here.
- **Expect**: "Could not send the file" alert, once; the terminal shows nothing; `ls ~/noentry`
  on the host shows nothing new; the raw SFTP error is in the log. Restore with `chmod 700`.
- [ ]

### T8.16 — Quick-attach: `/tmp/port22`, typed path, trailing space
- **Setup**: connected, cursor at a prompt. **Dep: T11** — the agent ribbon 📎 cap is the only
  UI caller; until it lands, drive `quickAttach('photo')` from a temporary dev call and assert
  via the log.
- **Steps**: run the quick-attach flow, pick a photo.
- **Expect**: log shows `upload` into `/tmp/port22/<UTCstamp>.jpg` (mkdir 0700 on demand —
  `stat -c %a /tmp/port22` says 700) and `[upload] quick-attach typed …`; the prompt now holds
  the absolute path plus **one trailing space**, unexecuted; the path also appears as an
  "upload path" clipboard slot.
- [ ]
