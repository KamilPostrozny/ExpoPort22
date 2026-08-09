# ExpoPort22 — Implementation Plan

Port22 rebuilt from scratch in Expo (SDK 57) for iOS **and** Android. This plan is the
contract for a series of independent Claude sessions: each task below is sized for one
session, states its dependencies, and has acceptance criteria. Read
https://docs.expo.dev/versions/v57.0.0/ before writing code in any session (AGENTS.md rule).

Sources of truth:
- **Functionality**: distilled from the reference Swift app (`../Port22`, branch `xtool`) — described here; do not copy its implementation.
- **Design & interactions**: Claude Design project `16acd697-dc0e-491d-8792-667f1beaf6af`
  (`Port22 Prototype.dc.html` = live interaction spec, `Port22 Design.dc.html` = visual spec
  incl. Android variants). Where the old app and the design disagree, **the design wins**.

---

## 1. What the app is

A single-purpose mobile SSH terminal for one person attaching to tmux on their own machine
over LAN/WireGuard. One host config. ed25519 key generated on device (private key never
leaves secure storage), public key pasted into `authorized_keys` by hand. TOFU host-key
pinning with hard refusal on mismatch. Full-bleed xterm-256color terminal, JetBrains Mono
Nerd Font, Catppuccin four-flavour theming. Everything distinctive is phone-shaped: a
Liquid-Glass accessory key bar, gesture-driven tmux window switching (Safari-style card
grid + bar swipes), a context ribbon for the foreground process, one-way uploads whose
remote path is typed into the session, OSC 52 clipboard (write-only into phone), OSC 8
links. No accounts, no sync, no analytics, no background modes.

Non-goals (explicit in reference, keep them): password auth, key import, jump hosts, agent
forwarding, file browser/downloads, multiple hosts, iPad/tablet layout, push/widgets.

---

## 2. Stack decisions

| Concern | Decision |
|---|---|
| Base | Expo SDK 57, TypeScript, Expo Router, **dev builds** (native modules ⇒ no Expo Go) |
| SSH | **Custom Expo native module** (`modules/expo-ssh`): Swift wraps Citadel/SwiftNIO-SSH; Kotlin wraps sshj (or Apache MINA client). API: connect (host-key callback), ed25519 pubkey auth, PTY shell channel with resize + data events, short-lived exec channels, SFTP mkdir/readdir/write. No maintained RN SSH lib supports exec channels + SFTP + host-key callbacks — this module is the riskiest slice, build it first. |
| Terminal emulation & render | **xterm.js inside an Expo DOM component** (webview). Gives xterm-256color, DECCKM, alt-screen detection, mouse-protocol negotiation, OSC 8 via link addon, OSC 52 hook, scrollback, selection. Bundled Nerd Font via CSS `@font-face`. Custom touch layer in the DOM component implements the notch-scroll rules (§4.3) where the negotiated protocol is actually known. |
| Keys | ed25519 via `@noble/curves` (same author as `@noble/ed25519`, but self-contained — the standalone package needs a SHA-512 hook wired by hand); 32-byte seed in `expo-secure-store` (device-only, no backup). Public key re-derived on load. |
| Persistence | Settings in AsyncStorage (forward-tolerant decode); seed + pinned host keys in SecureStore keyed `host:port`. |
| UI/gestures | react-native-reanimated + gesture-handler for bar swipes, card grid, zoom transition; `expo-blur` for iOS glass (Android uses flush Material surfaces per design); expo-haptics, expo-clipboard, expo-image-picker, expo-document-picker, expo-camera. |
| Theming | Catppuccin 4 flavours as 26-colour static data; ANSI 16 + all chrome derived via semantic roles (accent, danger, surface, panel, scrim, sub, muted…). `auto` follows system appearance live. |

---

## 3. Design tokens & metrics (from the design files)

- Font: JetBrains Mono Nerd Font regular+bold, bundled (assets exist in the design project — copy the two `.ttf`s).
- Flavours (bg/mantle/crust/surface0/text/sub/overlay0/accent/red/green/…): exact hexes in
  `Port22 Prototype.dc.html` `FLAV` table — Mocha `#1e1e2e/#181825/#11111b/#313244/#cdd6f4/#a6adc8/#6c7086/#89b4fa/#f38ba8/#a6e3a1`, plus Latte/Frappé/Macchiato sets. Terminal screens Mocha by default, setup reads well in Latte.
- iOS glass recipe: `blur(14px) saturate(160%)`, tint `rgba(205,214,244,0.08)` dark /
  `rgba(255,255,255,0.55)` light, inset specular `1.5px 1.5px 1px rgba(255,255,255,0.12)`,
  border `0.5px rgba(255,255,255,0.12)`.
- Bar geometry: 49pt circles, 49pt pill, 35pt keys (18pt radius), 24pt side margins,
  hairline divider before the arrows button; popovers 26pt corners; ribbon/chord caps ~50pt wide with 8.5pt captions.
- Android: same Catppuccin roles, flush `#181825` surfaces instead of glass, 40pt buttons,
  8–12pt radii, FAB for new tab, gesture pill, Roboto for chrome text, JBMono for terminal.

---

## 4. Functional spec (condensed; details live in the referenced files)

### 4.1 Connection & identity
- One host: address, port (1–65535, default 22), username, optional startup command. Fields locked while connected; Disconnect returns to Setup.
- Generate ed25519 on device; show public key monospaced + Copy. Never writes `authorized_keys`.
- TOFU: first connect → modal with `ed25519 SHA256:…` fingerprint, Cancel/Trust. Mismatch later → hard refusal; only recovery is confirm-gated "Forget host key" in Settings.
- Plain-English validation errors.

### 4.2 Terminal
- Full-bleed grid, no chrome, safe-area padded, portrait+landscape. `TERM=xterm-256color`.
- Font size 8–32pt (default 13), persisted, applied live; stepper in Settings. No pinch-zoom.
- Tap raises keyboard; long-press selects (system edit menu Copy/Paste/Select All); tap clears selection.
- Debounced (~150ms) resize on rotation/keyboard/font change so tmux redraws.
- Dictation leading-space filter (drop iOS's prepended space on empty line; real spacebar always sends). Held-delete repeats.
- Answer tmux colour-scheme query (`CSI ?996n`) with current light/dark. Bell → light haptic.

### 4.3 Scroll (headline behaviour)
- Any pan (1 or 2 fingers) is a scroll, beating drag-select. One notch per cell-height:
  1. mouse reporting on → wheel event **at the cell under the finger** (SGR/X10 as negotiated);
  2. alternate screen → one arrow key per notch (DECCKM-aware);
  3. else → local scrollback only.
- Momentum on release: exponential decay, frame-rate independent; touch stops coast and does nothing else.

### 4.4 Key bar (design supersedes old app here)
- Docked above keyboard, stays when keyboard hidden. Swipe bar ↓ hides keyboard, ↑ shows it (or, if already shown, drags into the tab switcher — §4.5). Bar swipe ↔ switches tmux window with sliding page cards, rubber-band at ends, tab-name pills replacing the keys during the swipe.
- Layout: ⋯ plus circle | pill: Ctrl · Esc · Tab · Paste ‖ arrows button | tabs circle with window-index badge.
- **Ctrl**: tap arms (accent tint), next key chords then disarms; double-tap locks (accentA tint + halo); armed shows the **chord strip** above the bar: C interrupt · Z suspend · R history · L clear · D EOF, each cap with caption.
- **Tab key**: sends Tab (completion). **Esc** sends ESC.
- **Paste**: tap pastes top clipboard slot; long-press (~420ms) opens **clipboard popover**: last three OSC 52 yanks + phone pasteboard **with content preview** (accepted: iOS paste banner fires on popover open), provenance labels ("tmux yank · 2 min ago"), pin to keep, tap types it (never executes). Yanks session-transient; pins persist in SecureStore (may hold secrets).
- **Arrows cluster**: toggle button opens glass popover, inverted-T ↑↓←→ + Home/End; sends proper escape sequences (DECCKM-aware). (Prototype's history/caret simulation = what the shell does with those keys; app just sends keys.)
- **⋯ menu**: UPLOAD FILE — Files / Photo or video / Camera — divider — Settings. Opening closes other popovers, puts keyboard away. During upload the circle tints accent and goes inert (that's the whole progress UI).
- Every key: press-dim/shrink + light haptic on touch, not on echo. Swipe on bar never presses keys.
- **Context ribbon** — recipe-driven action strip above the bar, keyed on what runs in the **active pane only**. Signals: alt-screen/DECCKM/mouse state (emulator-internal, instant) + `#{pane_current_command}` poll (~2s exec channel; shell name = idle). Recipes are **declarative data** (match names → caps `{label, caption, bytes|action, danger}`) so a user recipe editor can slot in later. UX: `running`/`suspended` show expanded per design; TUI recipes start as a collapsed dot+label pill, tap expands caps, outside-tap collapses; swipe ribbon down dismisses it for that process instance. Shell idle, REPLs, unknown TUIs → nothing.
  Built-in recipes v1:
  - **running** (non-shell, no alt-screen): pulsing dot + `proc · m:ss` (timer from first detection) · ^C stop · background (^Z then `bg\n`) · kill force (red; `pgrep -P #{pane_pid}` + `kill -9` via exec channel).
  - **suspended** (tracked locally: we sent ^Z, poll shows shell): `· stopped` · fg resume (types `fg\n`) · bg run-behind (types `bg\n`) · kill.
  - **vim/nvim/vi**: save `:w` · quit `:q` · save+quit `ZZ` · force-quit `:q!` (red) — all Esc-prefixed so they work from insert mode.
  - **pagers less/man/bat/delta**: q quit · / search (raises keyboard) · g top · G end.
  - **htop/top/btop**: q quit · / filter · F9 kill.
  - **agents claude/codex/aider/gemini** (name list in recipe data): 📎 Attach file (quick-attach flow, §4.6; cap goes inert-tinted during send) · ⎋ interrupt.

### 4.5 tmux integration
- On connect probe `command -v tmux`; absent → no tabs button, no switcher, no mention.
- "Configure tmux" toggle (default on): push `~/.config/port22/port22.conf` over SFTP, sourced; `# port22-conf-v1` marker, version-bump replaces. Contents: notch wheel bindings both copy-mode flavours, `mouse on`, `escape-time 0`, `history-limit 50000`, OSC 52 lines, `set-titles` string the badge reads. Verify by reading a setting back; surface off/applied/not-applied in Settings. Toggle off also hides tabs button (switcher needs configured tmux).
- **Switcher**: full-screen card grid (2 cols) over crust bg; per tmux window a live colour `capture-pane` snapshot card + name + directory sub. Active card accent ring. Tap → select; ✕ or left-swipe-fling → close (rubber-band right); long-press lifts card (scale/rotate/shadow, mauve ring) → drag-to-reorder with dashed target slot → `move-window` on drop; + births a new terminal that zooms out of the button (Safari new-tab); Done ✓ returns. Header "N Tabs". Terminal zooms into/out of its card slot (drag-following zoom on bar-swipe-up, accent ring during transition). Closing last window ends session.
- All switcher actions on short-lived exec channels (`list-windows`, `capture-pane`, `select-window`, `kill-window`, `new-window`, `move-window`) — never the attached PTY.

### 4.6 Uploads (one-way, two flows)
- **Quick attach** (agent ribbon cap only): picker → SFTP to `/tmp/port22/` (mkdir 0700 on demand), generated name `UTCstamp.ext` (sanitised, same-second overwrite), then remote path + trailing space typed into session — no Return.
- **Destination upload** (⋯ menu Files / Photo-video / Camera): **destination browser sheet** — SFTP readdir listing (dirs first, files shown so collisions are visible), breadcrumb path, tap dir to descend, "Save here"; starts at `$HOME`, remembers last destination. Filename field pre-filled with sanitised original name, editable (camera defaults to timestamp); overwrite visible in listing. Saves silently — **nothing typed into the session**. ⋯ circle tints accent + inert during send.
- Shared: whole file in memory, size user's problem. Failure: "Could not send the file" alert, nothing typed, nothing left behind. Never downloads or deletes; host listing exists only inside the destination picker.

### 4.7 Clipboard & links
- OSC 52 write → phone pasteboard + pushed into clipboard-slot history. OSC 52 **read: never answered**. Slots: last 3 yanks + phone pasteboard entry; pinnable (pins persist).
- OSC 8 links underlined, tappable, `http(s)` only, others silently refused. Bare URLs stay plain text.

### 4.8 Settings (bottom sheet over live terminal)
- Grabber, swipe-dismiss, no Done. Sections: APPEARANCE (Auto + 4 flavours with swatch rows + check; font-size stepper), TMUX (Configure toggle + status + explainer), SESSION (Disconnect accent, Forget host key red + confirm). While connected host/port/user/startup hidden; Setup screen shows the full form. Doors: ⋯ menu, two-finger tap on grid.
- Theme change restyles live session, no reconnect.

### 4.9 Lifecycle
- Background kills socket (expected). Foreground: dead → auto reconnect, re-auth, new PTY plain shell (startup command replays if set; **no auto tmux attach**). Two consecutive failures → stop, show manual Reconnect. Distinct Disconnected vs Cannot-connect states (icon, headline, sentence, Setup/Reconnect buttons) + Connecting spinner.

### 4.10 Android specifics (design file §2f/2g)
- Same functionality, Material skin: flush mantle surfaces, no blur; bar rides Gboard (WindowInsets); switcher via container-transform, FAB new tab, top-left back, predictive back closes grid; gesture pill instead of home indicator. Everything else identical.

---

## 5. Task slices (one Claude session each)

Order respects dependencies; ★ = riskiest, front-loaded.

**T1 — Scaffold** ✅ done, verified on device 2026-08-09 · deps: none
`create-expo` (⚠ shim npm 11 — npm 12 leaves empty dir, see memory), SDK 57, TS, Expo Router,
dev-client config, `app.json` (portrait+landscape, phone-only, camera usage string), fonts
copied from design project + loaded, theme module (4 flavours × 26 colours, semantic roles,
ANSI derivation, `auto` listener), settings store (AsyncStorage, tolerant decode, defaults).
*Accept*: dev build runs both platforms, theme hook flips with system, fonts render.
Landed: `src/theme.ts` (ported from reference `Port22Core/Theme.swift` — palette, ANSI ramp,
chrome roles, `colorSchemeNotification`), `src/settings.ts` (singleton +
`useSyncExternalStore`, no `keyRow`/`snippets` per §6), `src/hooks/use-theme.ts`,
`src/app/_layout.tsx` (font load + hydrate behind the splash), `src/app/index.tsx`
(throwaway palette/font harness, T5 replaces it with Setup), `src/core.test.ts` (`bun test`).
Expo template screens, demo components and demo assets deleted. Verified: `bun test`,
`tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20, and on an iPhone — fonts render, the
flavour picker restyles live. The palette later moved to `@catppuccin/palette` (see AGENTS.md);
all 104 hexes were checked identical first, so nothing on screen changed.

**T2 ★ — expo-ssh native module, iOS** ✅ done, verified on device 2026-08-09 · deps: T1
Swift Expo Module wrapping Citadel: connect/disconnect, host-key callback→JS promise,
ed25519 pubkey auth (seed passed from JS), shell channel (PTY, `TERM`, resize, base64 data
events both ways), exec channel (run, collect stdout, exit code), SFTP (mkdir mode, readdir
with types, write bytes). Typed TS API + event emitter.
*Accept*: demo screen connects to a real host, runs `ls` via exec, streams shell I/O, uploads a file.
Landed: local module `modules/expo-ssh` (`ExpoSSH`) — `ios/SSHSession.swift` (Citadel actor ported
from the reference `Port22Core/SSHSession.swift`, plus `listDirectory`), `ios/ExpoSSHModule.swift`
(definition, `SHA256:` fingerprint, base64 payloads), `src/ExpoSSHModule.ts` (typed API) and
`src/ExpoSSH.types.ts`. Also `src/keys.ts` (seed in SecureStore device-only + `authorized_keys`
line, T5 reuses it) and a T2 harness in `src/app/index.tsx` on top of the T1 palette one.
Decisions: Citadel ships no podspec, so the podspec pulls it — and the four transitive products it
imports directly (NIOSSH/Crypto/NIOCore/Logging) — through React Native's `spm_dependency`;
CocoaPods has no SPM support of its own. iOS deployment target 17.0 (Citadel's floor) via
`expo-build-properties`. Shell output is base64 (a read can split a UTF-8 sequence), input is a
plain string. Host-key answers that arrive before the handshake asks are held, not dropped.
Verified: `bun test`, `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20, podspec parses,
and the whole accept list walked against a real host on an iPhone — connect with the TOFU
fingerprint prompt, `ls` over an exec channel, shell I/O, and a file into `/tmp/port22` confirmed
by `listDirectory`. RN's static-linking warning for SPM products never bit; `USE_FRAMEWORKS=dynamic`
was not needed. **Still open**: Android is a name-only stub until T3.

**T3 ★ — expo-ssh native module, Android** deps: T2 (API fixed by T2)
Same TS API, Kotlin + sshj impl. *Accept*: same demo passes on Android.

**T4 ★ — Terminal DOM component** ✅ built, **not yet verified on device** · deps: T1
xterm.js in expo-dom component: Nerd Font CSS, Catppuccin theme injection, font-size prop,
fit/resize→cols/rows callback, data in/out bridge, selection + native edit menu, OSC 8
link addon (http/https only), OSC 52 handler (write→bridge, read→drop), `CSI ?996n` reply,
bell→haptic bridge, scrollback. *Accept*: local echo harness renders vim-style output,
links tap, selection copies.
Landed: `src/terminal.tsx` (`'use dom'`, `@xterm/xterm` 6 + `@xterm/addon-fit`), `src/app/terminal.tsx`
(local-echo harness, reachable from the T2 harness), `src/terminal-protocol.ts` (OSC 52 parse, http
link guard — the two pure bits, tested in `src/core.test.ts`), `src/base64.ts` (moved out of
`keys.ts` so the webview bundle does not drag SecureStore in with it).
Decisions: no `@xterm/addon-web-links` — §4.7 wants bare URLs left as plain text, and OSC 8 is
xterm's own `linkHandler`. Bytes cross the bridge base64 (JSON only) and reach xterm as
`Uint8Array` so it does the UTF-8 decoding; keystrokes go back as strings. The webview cannot see
the fonts `useFonts` loads, so the two `.ttf`s are copied into `public/fonts/` — the one directory
`expo export:embed` puts inside `www.bundle`, which is the DOM bundle's base URL. Resize is
debounced 150ms in the DOM, where the cell size is known. `TerminalHandle` deliberately does not
extend `DOMImperativeFactory` (its index signature would type `write` as taking any `JSONValue`).
Verified so far off-device only: `bun test`, `tsc --noEmit`, `expo export -p ios` (DOM bundle +
`public/` copy present), `expo-doctor` 20/20. **Still open**: everything the accept list actually
asks — glyph metrics, the system edit menu over `.xterm-rows`, link taps, bell haptics — needs the
harness on hardware. Mouse reports (`onBinary`) are still unforwarded; T6 owns their encoding.

**T5 — Session wiring + Setup flow** deps: T2/T3, T4
Key gen (@noble/ed25519 + SecureStore), Setup screen per design (Latte-friendly), validation,
TOFU prompt modal, pinned-key store + mismatch hard-fail, connect → terminal screen,
startup command, Disconnect, reconnect state machine (§4.9) with the three status screens.
*Accept*: full connect/disconnect/reconnect loop on device against real host.

**T6 — Scroll gesture system** deps: T4, T5
Touch layer in DOM component: pan-always-scrolls, notch = cell height, three-way routing
(wheel-at-finger-cell w/ negotiated encoding, alt-screen arrows DECCKM-aware, local scrollback),
frame-rate-independent momentum, touch-stops-coast. Keep encoding decision inside xterm.js
side where the protocol is known. *Accept*: `less`, `htop` (mouse on), and plain shell all
scroll correctly; flick behaves same at 60/120Hz.

**T7 — Key bar core** deps: T5
Glass bar (iOS blur / Android flush): ⋯ circle, pill Ctrl·Esc·Tab·Paste + arrows button,
tabs circle+badge; press feedback + haptics; sticky/locked Ctrl with chord strip; arrows
cluster popover; keyboard show/hide via bar swipe ↓/↑; two-finger-tap → Settings; d-pad and
popover anchoring above ribbon/strip as in prototype (`popBase` stacking). *Accept*: chords
reach host (`^C` kills a running `sleep`), arrows work in vim.

**T8 — Clipboard + ⋯ menu + uploads** deps: T7, T2/T3
Clipboard slots store (OSC52 feed + pasteboard, pins persisted), Paste tap/long-press
popover, ⋯ glass menu (Files/Photo-video/Camera/Settings), pickers, **destination browser
sheet** (readdir, breadcrumb, editable filename, Save here, last-dir memory) + quick-attach
helper for the agent ribbon cap, both per §4.6, failure alert. *Accept*: file lands in a
browsed-to directory under its own name with nothing typed; quick-attach puts a photo in
`/tmp/port22/` and types the path with trailing space.

**T9 — tmux side-channel + config push** deps: T5
Probe, config file v1 content, SFTP push + source + read-back verify, status in settings
store, exec-channel helpers (`list-windows`, `capture-pane -e`, `select/kill/new/move-window`),
window-title badge feed, foreground-process poll for ribbon. *Accept*: fresh host gets conf,
works on a `fish` login shell, badge tracks window.

**T10 — Tab switcher** deps: T9, T7
Card grid + snapshot rendering (ANSI→styled text mini-view), zoom-in/out transitions
(button tap + drag-following bar-swipe-up per prototype `zoomFollow`), select/close/create/
reorder gestures incl. swipe-to-close rubber-band and drag with dashed slot, new-tab birth
from +, Done, count header, last-window-ends-session. Android: container-transform + FAB +
predictive back instead of Safari zoom. *Accept*: all gestures on device, reorder issues
`move-window`, snapshots refresh while grid open.

**T11 — Bar-swipe window switching + ribbon** deps: T9, T7
Horizontal bar swipe: page-slide cards, rounded corners during drag, name pills strip,
rubber-band ends, flick thresholds from prototype. Neighbor page content = **fresh
`capture-pane` snapshot taken on swipe start** (accepted ~100–300ms before slide attaches);
live PTY content replaces it after `select-window` redraw. Context ribbon: recipe engine +
all §4.4 built-ins (running/suspended/vim/pagers/htop/agents), collapsed-pill UX, dismissal.
*Accept*: swipe hops windows without switcher; ribbon controls a live build; `:wq` cap
finishes a `git commit` from insert mode; agent cap attaches a file.

**T12 — Settings sheet + polish pass** deps: T7–T11
Bottom sheet per design (sections, swatch rows, stepper 8–32, tmux toggle wiring incl.
hiding tabs button, Disconnect, Forget host key confirm), dictation space filter,
held-delete repeat, `?996n` on theme flip live-restyle, 120Hz opt-in, launch bg + icon,
themed everywhere via roles. *Accept*: design-side-by-side review of every screen, both
platforms, all four flavours.

**T13 — Device verification + builds** deps: all
Walk §4 acceptance criteria on physical iPhone & Android. *Accept*: checklist in repo with every
item ticked on hardware.
The iOS half of the build/sideload story landed early, in T2, because nothing else could be
verified without it: `.github/workflows/ipa.yml` builds an unsigned Debug dev client on
`macos-26`/Xcode 26.6 (older toolchains cannot compile `expo-modules-jsi`) and publishes it as the
rolling `dev` prerelease; `docs/ship.md` is the laptop half — download, netmuxd, `xtool install`,
which signs with the free Apple ID. Free provisioning expires weekly, so a re-sign is a re-run of
that, not a rebuild. Android APK install is still unwritten.

---

## 6. Open decisions

1. SSH lib choice on Android (sshj vs MINA) — decide in T3 after a spike.
2. Terminal engine fallback: if DOM-component latency/IME proves bad on device in T4,
   plan B is a native terminal view per platform (bigger job) — flag early.

Settled (user decisions, 2026-08-09):
- Key bar is the fixed design bar (Ctrl·Esc·Tab·Paste + arrows cluster) — no catalogue
  editor, no snippets.
- Context ribbon tracks the active pane only — no cross-window job table.
- Clipboard popover shows full phone-pasteboard preview (iOS paste banner accepted).
- Bar-swipe neighbor preview: fresh snapshot captured on swipe start.
- Chord strip is the static five (C·Z·R·L·D) — no context-aware sets.
- Ribbon is recipe-driven; v1 built-ins: running, suspended, vim/nvim, pagers, htop,
  coding agents (claude/codex/aider/gemini). Collapsed-pill UX for TUI recipes; nothing
  for shell/REPLs/unknown TUIs. Recipes stored declaratively; user editor is a later,
  already-data-ready feature.
- Uploads split: ⋯ menu = destination-browser flow (readdir listing, original editable
  filename, saves silently); agent ribbon 📎 Attach = quick `/tmp/port22` + typed path.
  (Departure from reference's never-list-the-host stance, deliberate.)

## 7. Deliberate behaviours (features, not bugs — keep them exactly so)

- No reply to OSC 52 reads; non-http links do nothing; no tmux = no tabs button, no message; failed conf push changes nothing visible.
- No haptic on tab select; `^D` instant, no confirmation.
- **Log freely.** The reference app's SPEC §5 banned logging host, session bytes and filenames even
  in debug; user decision 2026-08-09 drops that outright — debuggability wins, and this app has one
  user on his own LAN. Every `ExpoSSH` call, result and event goes to the Metro console
  (`modules/expo-ssh/src/ExpoSSHModule.ts`, `LOG`). The one thing still held back is the ed25519
  seed: it has no debug value where the public key does, so `src/keys.ts` logs the
  `authorized_keys` line instead. Say the word and that goes too.
- Uploads stay memory-bound and size-unguarded.
