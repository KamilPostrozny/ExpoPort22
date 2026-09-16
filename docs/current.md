# Current behaviour and architecture

Status: maintenance reference, reconciled against source during the documentation cleanup.
Scope: product constraints and implementation map, **not a device-verification claim**.
[AGENTS.md](../AGENTS.md) governs parity and verification; the iOS build is the visual/interaction
reference. If source, this summary, and device behaviour disagree, record the discrepancy in
[issues.md](issues.md); do not silently redefine the desired behaviour from a suspected bug.
Old T-number/§ references lead through [PLAN.md](../PLAN.md), not to a current backlog.

## Product boundaries

One personal SSH host over LAN/WireGuard; phone-sized iOS and Android UI. No accounts, sync,
analytics, password authentication, key import, jump hosts, agent forwarding, multi-host UI, or
background connection service. The context ribbon was removed on 2026-09-01; its research is
archived, not a proposal to implement. Foreground-program detection still exists for prose mode.

## Connection and identity

Sources: `src/settings.ts`, `src/keys.ts`, `src/host-keys.ts`, `src/session.ts`, `src/app/index.tsx`.

- Generate an ed25519 key on-device; keep the private seed in SecureStore. The user installs the
  public key in `authorized_keys`; the app does not edit that file.
- First use requires TOFU confirmation of the host fingerprint. A changed pinned key is refused;
  recovery is explicit, confirm-gated Forget host key. Pins are keyed by host and port.
- One host, port (1–65535), username, and start mode. Non-secret settings use AsyncStorage.
- Start modes: plain shell; named `port22` tmux session (default); attach to an existing session;
  custom command. The start line runs once per connection, including reconnects.
- Tmux start modes detach other clients. Existing-session attach falls back to `port22` when its
  target is gone. This can touch real work: use a disposable test target, never the user's session.
- Backgrounding closes the connection; foreground reconnects a dead session. Two consecutive
  automatic failures stop retries and leave manual recovery. Verify lifecycle on both platforms.

## Terminal, input, and keyboard

Sources: `src/terminal.tsx`, `src/terminal-protocol.ts`, `src/input-model.ts`, `src/keybar.tsx`,
`src/hooks/use-terminal-keyboard.ts`, `src/prose-model.ts`, `src/app/terminal.tsx`.

- xterm.js runs in an Expo DOM component. The WebView owns the keyboard: xterm's helper
  textarea is first responder, so software and hardware keys alike become xterm `onData` (Esc,
  Tab, arrows, F-keys, Ctrl/Alt chords, DECCKM-aware). The bar's up-swipe focuses it (and raises
  the software keyboard); the bar's down-swipe and the screen's doors blur it. A terminal tap
  deliberately does neither. The PTY uses `xterm-256color`.
- Font size 8–32, default 13; portrait/landscape and keyboard changes must resize the remote PTY.
- Pan routes to negotiated mouse-wheel events, alternate-screen arrows, or local scrollback.
  Respect DECCKM, finger cell coordinates, one-cell notch granularity, and momentum cancellation.
- Long-press selects text without becoming a scroll. A terminal tap clears selection but does not
  move the keyboard; only the bar's down and up swipes hide and raise it (the up-swipe also
  focuses the page for a hardware keyboard).
- Bar down hides the keyboard; bar up raises it. Horizontal bar gestures switch windows. The old
  bar-up-to-switcher interaction is retired; the tabs button opens the switcher.
- Ctrl arms once or locks on double-tap; the fixed chord strip is C/Z/R/L/D. Esc, Tab, arrows,
  Home/End, and Enter send terminal input. Keys must not fire during a swipe.
- No app-level hardware-key control: the page intercepts no key, so a hardware keyboard feeds
  xterm exactly as the software one does (Alt/AltGr chords included) and tmux owns window
  management. The software keyboard follows the app theme (the page's `color-scheme`) and its
  webview accessory bar is hidden. WebKit grants the page first responder only from a user
  gesture, so the bar's up-swipe is what arms a hardware keyboard; a terminal tap deliberately
  does not focus the page.
- Prose mode follows the foreground program; the menu provides an override scoped to that context.
  Shell/TUI input stays raw. The old native-field dictation filter went with the field: xterm
  forwards exactly what the keyboard produced. That is an accepted regression of moving keyboard
  ownership into the page, not a parity claim.
- SSH writes are serialized in `src/session.ts`; do not bypass the queue and reorder input.

## Clipboard and transfers

Sources: `src/clipboard.ts`, `src/clipboard-model.ts`, `src/keybar.tsx`, `src/upload.ts`,
`src/upload-sheet.tsx`, `src/download.ts`, `src/download-sheet.tsx`, `modules/expo-pasteboard/`.

- OSC 52 writes populate the phone pasteboard and three-slot yank history; pins persist in
  SecureStore. Never answer OSC 52 reads. OSC 8 opens only HTTP(S); bare URLs are not auto-linked.
- Paste with multiple yank slots opens the chooser. One slot types directly; no slot falls back
  to the phone pasteboard. Long-press always opens the chooser, including preview and provenance.
- Paste never adds Return; preserve bracketed-paste handling. Reading the phone pasteboard when
  opening the chooser may show the accepted iOS paste banner.
- A non-text pasteboard item uses quick upload to `/tmp/port22/`, then types its remote path and a
  trailing space, not Return. This path exists in source; historical media-paste failures still
  require device re-verification, not a source-only pass.
- The ⋯ menu keeps the keyboard up; Settings and the system pickers manage dismissal themselves.
- Destination upload offers Files, Photo/video, or Camera; browse directories, edit the sanitized
  filename, show collisions, remember the destination, and save silently (no path typed).
- Download browses from the host home directory, reads the chosen file to app cache, and offers
  the system share sheet. Browsers do not provide remote rename/move/delete.
- The menu's busy tint/inert state covers transfers. Errors must be visible, not an infinite spinner.
  Whole-file in-memory/base64 transfers remain an explicit limitation, not a streaming guarantee;
  no size guard is currently promised. Large-file OOM remains a triage item.

## Tmux and switcher

Sources: `src/tmux.ts`, `src/tmux-model.ts`, `src/exec-pool.ts`, `src/switcher.tsx`,
`src/switcher-model.ts`, `src/barswipe-model.ts`, `src/app/terminal.tsx`.

- Swift wraps Citadel; Kotlin wraps sshj. Commands use short-lived exec channels, never the PTY.
  Share bounded channel pools; do not fan out unbounded captures/searches.
- Push the app-owned `~/.config/port22/port22.conf` and source it on connect. Do not append to or
  rewrite the user's tmux configuration. Read `CONF_VERSION`/`generateConf` from source rather
  than copying a version into docs. The generated file still contains an outdated source-line
  comment; the actual apply path and this requirement do not append that line.
- Required configuration enables terminal features; the opt-out comforts affect the running
  server globally and apply on reconnect. Turning them off does not undo already-applied options.
- Tabs require tmux and a session the app can name. The disabled tabs control remains visible
  and explains why on tap; no numeric window badge is promised. Never list another session's
  windows as a fallback. Use stable window IDs for mutations.
- Cards show name, directory, ANSI snapshot, and active selection. Select, close, reorder, create,
  and Done act on the named session. Reorder must not unexpectedly select a different window.
- The final window cannot be closed from the grid; other windows can. Ctrl-D is terminal input,
  not a confirm-gated grid action. New-window birth disarms search.
- Bar swipes use cached neighbour previews and an extra new-tab page after the last window.
  Do not promise a fresh capture on every gesture start: freshness versus performance is an
  unresolved acceptance decision in [issues.md](issues.md).
- Preserve pre-switcher keyboard state on return, including search paths; raise a discrepancy
  rather than following old tests that force a particular keyboard state. No haptic on tab select.

## Search

Sources: `src/search-model.ts`, `src/switcher.tsx`, `src/app/terminal.tsx`, `src/terminal.tsx`.

One query is shared by switcher and terminal. Search includes window metadata and host scrollback,
not only visible rows. Distinguish pending/failed search from no match, ignore stale responses,
show the active hit distinctly, and navigate/scroll to hits. Clearing from either UI disarms both;
reorder is disabled while filtered. Never let a search failure silently remove an unsearched window.

## Appearance and settings

Sources: `src/theme.ts`, `src/themes-generated.ts`, `src/fonts.ts`, `src/style.ts`,
`src/appearance.tsx`, `src/settings-sheet.tsx`.

- Shared opaque surfaces; no glass/blur or platform-specific skin. Use semantic theme roles and
  existing metrics, not copied prototype values. Fonts are bundled: Inter for chrome, JetBrains
  Mono Nerd Font for terminal/icons; choose the registered face for weight.
- Catppuccin comes from `@catppuccin/palette`; additional schemes are generated from upstream
  data by `scripts/gen-themes.ts`. Do not copy palette tables or freeze the scheme count in docs.
- Follow system selects separate light/dark schemes; manual mode chooses one. Changes apply live.
- Settings supports appearance, font size, tmux comforts, Disconnect, and Forget host key.
  Sheet dismissal must restore the previous keyboard state.
- Android Back dismisses the top overlay first; at the terminal it should background, not silently
  route to Setup with a live session. This has a historical failure awaiting re-verification.

## Diagnostics and known constraints

App-level traces remain useful, but the verbose SSH proxy is currently `LOG = false` in
`modules/expo-ssh/src/ExpoSSHModule.ts`; absence of `[ssh]` lines is not evidence of failure.
The existing user policy permits host/session-byte/filename diagnostics; never log the private
seed. Do not enable bulk payload logging by default—it can overwhelm Metro and distort profiling.
Logs and screenshots may contain private session content; keep evidence local and deliberately scoped.

Keep working invariants near the code and tests. General troubleshooting lessons live in
[ship.md](ship.md); uncertainty and historical verification debt live in [issues.md](issues.md).
