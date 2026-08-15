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
- Android: same Catppuccin roles and the **same geometry** — the design's Android frames (§5a +
  `Port22-Android-Prototype.dc.html`) keep the 49pt bar and supersede this file's older
  "40pt buttons, mantle" summary. Elevated `surface0` containers instead of glass (no blur, small
  shadow), 16pt bar corners, 12pt keys, 20pt popovers, 8pt side margins, bar docked flush to
  Gboard; FAB for new tab, gesture pill, Roboto for chrome text, JBMono for terminal.

---

## 4. Functional spec (condensed; details live in the referenced files)

### 4.1 Connection & identity
- One host: address, port (1–65535, default 22), username. Fields locked while connected; Disconnect returns to Setup.
- **Start**: how the fresh shell becomes a session, one line sent once it is up, replayed on every reconnect. Four modes — `tmux session` (default; `tmux new-session -A -D -s port22`, one fixed name), `tmux, existing session` (`tmux attach -d [-t <pick>] 2>/dev/null || tmux new-session -A -D -s port22`, the pick coming from a list on Setup itself — `list-sessions` over a connection opened and closed for that one command, cached between visits, and skipped entirely until the host key is pinned, since the TOFU prompt is not on this screen; the line falls back to creating `port22` when the pick is gone), `Plain shell` (nothing sent), `Custom command` (the user's own line, the advanced escape hatch). Both tmux modes detach other clients: a second client on the same session decides that session's size and answers its `OSC 11` background query, so a shared session hands the phone the desktop's palette. A tmux mode forces the §4.5 config push — the features are what the config *is*.
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
- Docked above keyboard, stays when keyboard hidden. Swipe bar ↓ hides keyboard, ↑ always drags into the tab switcher (§4.5) whether the keys are up or down; the keyboard's own door is a tap on the terminal (§4.3), and connecting does not raise it. Bar swipe ↔ switches tmux window with sliding page cards, rubber-band at ends, tab-name pills replacing the keys during the swipe.
- Layout: ⋯ plus circle | pill: Ctrl · Esc · Tab · Paste ‖ arrows button | tabs circle with window-index badge.
- **Ctrl**: tap arms (accent tint), next key chords then disarms; double-tap locks (accentA tint + halo); armed shows the **chord strip** above the bar: C interrupt · Z suspend · R history · L clear · D EOF, each cap with caption.
- **Tab key**: sends Tab (completion). **Esc** sends ESC.
- **Paste**: tap pastes top clipboard slot; long-press (~420ms) opens **clipboard popover**: last three OSC 52 yanks + phone pasteboard **with content preview** (accepted: iOS paste banner fires on popover open), provenance labels ("tmux yank · 2 min ago"), pin to keep, tap types it (never executes). Yanks session-transient; pins persist in SecureStore (may hold secrets).
- **Arrows cluster**: toggle button opens glass popover, inverted-T ↑↓←→ + Home/End; sends proper escape sequences (DECCKM-aware). (Prototype's history/caret simulation = what the shell does with those keys; app just sends keys.)
- **⋯ menu**: UPLOAD FILE — Files / Photo or video / Camera — divider — Settings. Opening closes other popovers; the keyboard stays up under it, as in the reference app (its bar is the keyboard's own accessory view). The doors it opens put the keyboard away for themselves — Settings, and the system pickers. During upload the circle tints accent and goes inert (that's the whole progress UI).
- Every key: press-dim/shrink + light haptic on touch, not on echo. Swipe on bar never presses keys.
- **Context band** (redesign 2026-08-16, "Accessory" — supersedes the 5pt edge handle, which superseded the in-bar pill; study and evidence in `docs/ribbon-redesign.md`) — recipe-driven, keyed on what runs in the **active pane only**. Signals: alt-screen/DECCKM/mouse state (emulator-internal, instant) + `#{pane_current_command}` poll (~2s exec channel; shell name = idle). Recipes are **declarative data** (match names → caps `{label, caption, bytes|action, danger, arm}` plus section markers) so a user recipe editor can slot in later. UX: the ribbon rotated 90°. One 52pt band pinned at `popBase`, 6pt above the bar; at rest a 44pt opaque chip flush to the trailing edge (identity glyph, process name, live `m:ss`), announced by three cycles of a 2.5pt lateral nudge and then still. Tap it — iOS: or swipe it left — and the band unrolls leftward into a horizontal row of 44pt caps (danger caps red + **bold** + ⚠; the agent's `^C ^C` arms — first tap fires and reads "tap again"), scrolling only where they measurably overflow. Close by tapping the chip, a cap, the terminal above the band, or Android's back. The plate is **opaque `theme.panel`** with a two-colour C40 perimeter — no glass, no blur, no alpha ground, because a translucent plate cannot be legible over both a bright pane and a dark one, and the terminal draws in the same theme as any single edge colour we might pick. **Zero vertical cost: the band floats over output and never resizes the terminal**, and a 13-cap recipe has the same 52pt footprint as a 3-cap one. Shell idle, REPLs, unknown TUIs → nothing, and plain `running` waits until the process has been alive 3s (`RIBBON_MIN_RUN_MS`) so `ls` and `git status` never raise it.
  Built-in recipes v1:
  - **running** (non-shell, no alt-screen): pulsing dot + `proc · m:ss` (timer from first detection) · ^C stop · background (^Z then `bg\n`) · kill force (red; `pgrep -P #{pane_pid}` + `kill -9` via exec channel).
  - **suspended** (tracked locally: we sent ^Z, poll shows shell): `· stopped` · fg resume (types `fg\n`) · bg run-behind (types `bg\n`) · kill.
  - **vim/nvim/vi**: save `:w` · quit `:q` · save+quit `ZZ` · force-quit `:q!` (red) — all Esc-prefixed so they work from insert mode.
  - **pagers less/man/bat/delta**: q quit · / search (raises keyboard) · g top · G end.
  - **htop/top/btop**: q quit · / filter · F9 kill.
  - **agents claude/codex/aider/gemini** (name list in recipe data): 📎 Attach file (quick-attach flow, §4.6; cap goes inert-tinted during send) · ⎋ interrupt.

### 4.5 tmux integration
- On connect probe `command -v tmux`; absent → no tabs button, no switcher, no mention.
- A tmux start mode (§4.1) pushes `~/.config/port22/port22.conf` over SFTP, sourced; `# port22-conf-v2` marker, version-bump replaces. No toggle: choosing tmux is choosing the features the file buys. Two halves: **required** — notch wheel bindings both copy-mode flavours, `mouse on`, the two OSC 52 lines, no toggle because a feature dies without each — and **comforts** behind the §4.8 opt-out toggle (default on), which are the author's own hand-written `~/.tmux.conf` minus what only the reference Swift app used: `terminal-features ',*:RGB,*:usstyle'` + an `if-shell`-guarded `default-terminal tmux-256color` (truecolor through tmux; guarded because a TERM with no terminfo on the host breaks every pane), `status off` + `bind S` to bring it back, `escape-time 0` (a `set -s`, so server-wide) and `history-limit 50000`. All global — which is the reason they are a toggle. v1's `set-titles` + format string is in neither: the badge reads the poll, never a title, and the file was retitling every terminal on the server for nothing. Off takes effect on the next connect — `source-file` adds to a running server, it cannot un-set. Verify by reading `@port22` back; surface off/applied/not-applied in Settings. A non-tmux mode hides the tabs button (switcher needs configured tmux).
- **Switcher**: full-screen card grid (2 cols) over crust bg; per tmux window a live colour `capture-pane` snapshot card + name + directory sub. Active card accent ring. Tap → select; ✕ or left-swipe-fling → close (rubber-band right); long-press lifts card (scale/rotate/shadow, mauve ring) → drag-to-reorder with dashed target slot → `move-window` on drop; + births a new terminal that zooms out of the button (Safari new-tab); Done ✓ returns. Header "N Tabs". Terminal zooms into/out of its card slot (drag-following zoom on bar-swipe-up, accent ring during transition). Closing last window ends session. The keyboard is remembered, never re-decided: the switcher (and the Settings sheet) gives back the keys it took, so going in with them down comes back with them down — except a card tapped with the search armed, which lands with them down either way.
- All switcher actions on short-lived exec channels (`list-windows`, `capture-pane`, `select-window`, `kill-window`, `new-window`, `move-window`) — never the attached PTY.

### 4.6 Uploads (one-way, two flows)
- **Quick attach** (agent ribbon cap only): picker → SFTP to `/tmp/port22/` (mkdir 0700 on demand), generated name `UTCstamp.ext` (sanitised, same-second overwrite), then remote path + trailing space typed into session — no Return.
- **Destination upload** (⋯ menu Files / Photo-video / Camera): **destination browser sheet** — SFTP readdir listing (dirs first, files shown so collisions are visible), breadcrumb path, tap dir to descend, "Save here"; starts at `$HOME`, remembers last destination. Filename field pre-filled with sanitised original name, editable (camera defaults to timestamp); overwrite visible in listing. Saves silently — **nothing typed into the session**. ⋯ circle tints accent + inert during send.
- Shared: whole file in memory, size user's problem. Failure: "Could not send the file" alert, nothing typed, nothing left behind. Never downloads or deletes; host listing exists only inside the destination picker.

### 4.7 Clipboard & links
- OSC 52 write → phone pasteboard + pushed into clipboard-slot history. OSC 52 **read: never answered**. Slots: last 3 yanks + phone pasteboard entry; pinnable (pins persist).
- OSC 8 links underlined, tappable, `http(s)` only, others silently refused. Bare URLs stay plain text.

### 4.8 Settings (bottom sheet over live terminal)
- Grabber, swipe-dismiss, no Done. Sections: APPEARANCE (Auto + 4 flavours with swatch rows + check; font-size stepper), TMUX (the comfort-settings toggle and one line saying what it is, shown only on a tmux session; the mode itself lives on Setup, and the push's applied/not-applied is state the user is never told — the tabs button either appears or does not), SESSION (Disconnect accent, Forget host key red + confirm). While connected host/port/user/startup hidden; Setup screen shows the full form. Doors: ⋯ menu, two-finger tap on grid.
- Theme change restyles live session, no reconnect.

### 4.9 Lifecycle
- Background kills socket (expected). Foreground: dead → auto reconnect, re-auth, new PTY, and the §4.1 start line again — which on the tmux modes is an *attach*, so the resumed session is the one that was there. Two consecutive failures → stop, show manual Reconnect. Distinct Disconnected vs Cannot-connect states (icon, headline, sentence, Setup/Reconnect buttons) + Connecting spinner.

### 4.10 Android specifics (design file §2f/2g)
- Same functionality, Material skin: flush mantle surfaces, no blur; bar rides Gboard (WindowInsets); switcher per design §5c — the same shared-progress transform (the prototypes share the zoom verbatim; "container-transform" is its Material name), grid bottom bar of **Done text button (left) · Roboto count · 56dp FAB (right, births the new tab)** — this file's older "top-left back" was the §2g draft, superseded — and system back walks §5d's ladder — settings sheet dismisses, the destination browser goes up one directory then dismisses from `/`, popovers/⋯ menu close, the grid closes into the pane, and at the bare terminal back is **home** (backgrounds the app; never a pop to Setup, which would skip the disconnect); gesture pill instead of home indicator. Everything else identical.

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

**T3 ★ — expo-ssh native module, Android** ✅ implemented 2026-08-10 (not compiled, not device-verified) · deps: T2 (API fixed by T2)
Same TS API, Kotlin + sshj impl. *Accept*: same demo passes on Android.
Landed: `android/src/main/java/expo/modules/ssh/SSHSession.kt` (the sshj wrapper — connect with
blocking host-key callback, ed25519 from the raw seed, one PTY with pump thread, capped exec with
exit-status throw, SFTP mkdir-0700/chunked-write/ls, round-trip `isAlive`) and `ExpoSSHModule.kt`
(the definition: same names, payloads and `SHA256:` unpadded fingerprint as iOS, suspend bodies
moved to `Dispatchers.IO`). `android/build.gradle` gains sshj + bcprov. TS layer: zero changes.
Decisions: **sshj 0.40.0** over Apache MINA sshd-client (§6 open decision 1, now settled) — both
read at source. sshj covers the whole requirement list in-tree, verified at tag v0.40.0:
`HostKeyVerifier.verify` is a synchronous boolean we can block until JS answers (TOFU),
`Ed25519KeyFactory.getPrivateKey` takes exactly our 32-byte seed, `SessionChannel` has
allocatePTY/startShell/changeWindowDimensions/exec-with-exit-status, `SFTPEngine.makeDir(path,
attrs)` keeps the 0700 that `SFTPClient.mkdir` drops, `RemoteFile.write` writes bytes at offsets.
MINA covers it too but as an async server+client framework with ed25519 behind optional deps —
heavy for one blocking connection; sshj's own tests use MINA as the throwaway server. Other
decisions: Android's stripped "BC" provider is swapped for the bundled bcprov at class-load
(sshj resolves "Ed25519" by provider name); everything runs on `Dispatchers.IO` because the
module queue is a single thread and `connect` blocks on the answer `verifyHostKey` delivers —
same-thread would deadlock the handshake; host-key answers that arrive before the handshake asks
are held, not dropped (wait/notify mirror of the iOS continuation); `RemoteFile.write` is chunked
at 32 KB by hand since sshj sends one WRITE packet per call; exec throws on non-zero exit like
Citadel, which `tmux.ts` already tolerates.
Verified: `bun test` (139), `tsc --noEmit`, `expo export -p android` — honest ceiling of a box
with no Android SDK: the Kotlin has **never been compiled** and nothing ran on a device.
**Still open**: the whole TESTS.md §T3 emulator pass, gated on T3.0 (first gradle build); no
slf4j binding, so sshj's own logs are NOP on Android (the TS proxy still logs every call);
`RemoteResourceInfo` never exposes `longname`, so iOS's attribute-less-server fallback for
`isDirectory` has no Android equivalent.

**T4 ★ — Terminal DOM component** ✅ done, verified on device 2026-08-09 · deps: T1
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
Verified: `bun test`, `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20, and on the iPhone
against the harness — the webview boots (`DOM Bundled src/terminal.tsx`), the bundled font is
measurably in it (`loaded=true cell=7.80 nerd-glyph=7.80`, the private-use glyph on the same advance
as `M`), keystrokes reach native, the bell fires, an OSC 52 yank arrives decoded while an OSC 52
*read* produces nothing, an OSC 8 link activates, and the size settles at one value per layout.
Three bugs only the device could show, fixed in `9da57be`: `<Link asChild>` throws in render because
expo-router's Slot refuses an array `style`; the theme effect keyed on the `theme` *object* looped
forever, since the bridge rebuilds that object every render; and the harness's own status text
rewrapped its bar, resizing the terminal underneath it. The diagnostics that caught all three (font
report, size log, one line per bridge callback) stayed in — §7 says log freely, and a webview has no
other way to speak.
Long-press selection is proven too — system edit menu (Copy · Look Up · Translate) over a live
selection — and it took a measurement to explain: an identical press on `.xterm-screen`, same
target and same computed `user-select`, selects with focus on the body and selects nothing with
focus on xterm's helper textarea. WebKit classifies a touch when it *begins*, from the focus state
at that moment, so releasing focus mid-press is too late (a 2.4s hold with `blur()` at `touchstart`
still selected nothing) and no CSS or event juggling reaches it. Three attempted fixes were removed
rather than stacked; one of them — swallowing synthetic mouse events — broke the gesture outright,
because WebKit's own selection rides those events.

**Decision for T6/T7: keyboard input moves to a native `TextInput` outside the webview.** Verified
on the device: with the keyboard owned natively, touching the terminal blurs it, the keyboard hides
and the selection proceeds — the behaviour every native iOS app has. The webview then owns display
and selection only, and never takes focus. It also puts the dictation leading-space filter and
held-delete repeat (§4.2) on the native side, where both are easier. The harness keeps a `native
kbd` button as the standing proof of this.

**Still open**: colours, bold and box drawing are eye-checked only. Mouse reports (`onBinary`) are
still unforwarded — T6 owns their encoding.

**T5 — Session wiring + Setup flow** ✅ done, verified on device 2026-08-09 · deps: T2/T3, T4
Key gen (@noble/ed25519 + SecureStore), Setup screen per design (Latte-friendly), validation,
TOFU prompt modal, pinned-key store + mismatch hard-fail, connect → terminal screen,
startup command, Disconnect, reconnect state machine (§4.9) with the three status screens.
*Accept*: full connect/disconnect/reconnect loop on device against real host.
Landed: `src/session.ts` (the state machine and the only thing that talks to `ExpoSSH`),
`src/host-keys.ts` (TOFU pin in SecureStore + the `hostKeyVerdict` decision, tested in
`src/core.test.ts`), `src/app/index.tsx` (Setup, replacing the T1/T2 harness) and
`src/app/terminal.tsx` (the session screen with the three §4.9 states, replacing the T4 harness).
Added `expo-clipboard` — the Copy on the public key (§4.1) and the OSC 52 yank landing on the
pasteboard (§4.7); it is a native module, so it needs a build, not a reload.
Decisions: the session is a module singleton like `settings`, because it outlives every screen and
three unrelated callers (both screens, the AppState listener) drive one connection. Shell output
buffers until a terminal attaches — the webview boots slower than the login banner arrives — and
the terminal attaches on its *first size report*, the earliest proof the DOM side is up. Pins store
the key blob, not the fingerprint: comparing display strings is comparing a summary. A refusal of
ours (mismatch, or Cancel on the prompt) spends the whole automatic-retry budget on the spot, so a
refused key is not re-offered on every foreground until the user is trained to tap Trust. The
endpoint is base64url'd into the SecureStore key rather than character-substituted, since
substitution maps two endpoints onto one pin. Keyboard input still goes through xterm's textarea;
the native `TextInput` decided above is T6/T7's, and the bar here is two buttons standing in for
T7. "Forget host key" sits on the mismatch screen for now; §4.8 moves it into Settings in T12.
Verified: `bun test` (10), `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20, and the whole
accept list on an iPhone against a real host — first contact prompts and pins, a second connect goes
straight through (`host key trust`), keystrokes and delete reach the PTY, `onShellClose` →
`disconnected` → automatic reconnect on foreground, `isAlive` false-negatives caught on return, the
Disconnected and Cannot-connect screens with their buttons, and Disconnect → Setup. The mismatch
path was walked for real, not simulated: a throwaway `sshd` on port 2222 with its own host key,
trusted, then restarted with a *different* key — the app refused without a prompt, showed the
mismatch sentence and the red Forget, and after Forget asked again; Cancel on that prompt produced
"You did not trust this host key." and no pin.
Three bugs only the device could show, fixed on the spot: iOS reaps a backgrounded WKWebView and the
one that comes back is empty, so shell output is now kept in a bounded history and replayed on every
boot of the terminal (which subsumes the old buffer-until-the-webview-is-up case — one path, two
problems); a refused socket reached the Cannot-connect screen as `UnexpectedException: … NIOPosix.
NIOConnectionError error 1 … ConcurrentFunctionDefinition.swift:90`, so `describe` turns the
recognisable failures into the sentence §4.1 asks for and leaves the raw text in the log; and a
reconnect drew its login under the previous session's rows, so a new shell now starts by clearing
the screen — through the same path the output takes, which keeps the replay in order.
**Still open**: Android (T3). Long-press selection remains behind the keyboard being down until the
native `TextInput` lands in T6/T7. The `:2222` pin from the mismatch test is still on the phone,
harmless — nothing else uses that endpoint.

**T6 — Scroll gesture system** ✅ implemented 2026-08-09 (not device-verified) · deps: T4, T5
Touch layer in DOM component: pan-always-scrolls, notch = cell height, three-way routing
(wheel-at-finger-cell w/ negotiated encoding, alt-screen arrows DECCKM-aware, local scrollback),
frame-rate-independent momentum, touch-stops-coast. Keep encoding decision inside xterm.js
side where the protocol is known. *Accept*: `less`, `htop` (mouse on), and plain shell all
scroll correctly; flick behaves same at 60/120Hz.
Landed: `src/scroll-model.ts` (every decision, pure and tested in `src/scroll-model.test.ts`:
three-way routing, px→notch accumulation with carried remainder, DECCKM arrow bytes, analytic
exponential momentum with a proved 60/120Hz equivalence, release-velocity tracker), the touch
layer + mode watch in `src/terminal.tsx`, and an `onModes` log consumer in `src/app/terminal.tsx`.
Decisions: wheel encoding is **not** reimplemented — checked in the xterm 6 sources, a synthetic
`WheelEvent` dispatched at the finger's `clientX/Y` runs xterm's own CoreMouseService, which
derives the cell and encodes per the negotiated protocol (SGR out via `onData`, legacy DEFAULT via
`onBinary`, now both forwarded onto the data bridge; a DEFAULT report past column 95 would be
UTF-8-mangled by native `send` — ponytail-marked, `sendBase64` is the upgrade). Arrows and local
scrollback do *not* go through synthetic wheels: `arrowKey` (3 tested lines) through the keystroke
bridge and public `term.scrollLines` are simpler than relying on xterm's fallback listener chain.
Pan-beats-drag-select is a slop rule: under 8px of travel the touch is left entirely alone — the
window WebKit needs to begin its long-press (T4) — past it the touch is claimed and every move
preventDefaulted; once a selection exists, moves are its drag handles and the pan stands down.
Momentum spends `distance(now) − distance(spent)` per rAF off the analytic curve `v0·τ(1−e^(−t/τ))`
(τ=500ms ≈ iOS's own 0.998/ms — a hardware-tuning knob, like the flick thresholds); a touch during
the coast cancels it and is preventDefaulted into doing nothing else. Mode signal for T11
(`{altScreen, mouseReporting, decckm}` via `onModes`, `ModeSignal` in `src/scroll-model.ts`): xterm
exposes the flags read-only (`modes`, `buffer.active.type`) with no change event, so the watch is
`buffer.onBufferChange` plus pass-through CSI `?h`/`?l` handlers that peek after the parse settles;
fired on change and once per boot as the baseline. One export-time find: a `'use dom'` module
refuses re-export statements, so `ModeSignal` is imported from `@/scroll-model`, not `@/terminal`.
Verified: `bun test` (18), `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20. **Not walked
on hardware** — the device cases are TESTS.md §T6 (T6.1–T6.9). Still open besides that: the tuning
constants (τ, flick/stop thresholds, slop) are guesses until a thumb meets them; `sendBase64` if a
pre-SGR mouse app past column 95 ever matters; T7 still owes the native `TextInput` keyboard move.

**T7 — Key bar core** ✅ implemented 2026-08-09 (not device-verified) · deps: T5
Glass bar (iOS blur / Android flush): ⋯ circle, pill Ctrl·Esc·Tab·Paste + arrows button,
tabs circle+badge; press feedback + haptics; sticky/locked Ctrl with chord strip; arrows
cluster popover; keyboard show/hide via bar swipe ↓/↑; two-finger-tap → Settings; d-pad and
popover anchoring above ribbon/strip as in prototype (`popBase` stacking). *Accept*: chords
reach host (`^C` kills a running `sleep`), arrows work in vim.
Landed: `src/keybar-model.ts` (every decision, pure and tested in `src/keybar-model.test.ts`:
Ctrl machine off→armed→locked with the 300ms double-tap window, `^X = letter & 0x1f` control
bytes, `applyCtrl` for typed keys, the six DECCKM-aware nav sequences — up/down *are* T6's
`arrowKey`, imported not copied — the TextInput diff, bar-swipe classification at the
prototype's 10/24px thresholds), `src/keybar.tsx` (the bar, chord strip, both popovers, the
glass recipe, and the invisible native `TextInput`), the two-finger tap in `src/terminal.tsx`
+ `isTwoFingerTap` in `src/scroll-model.ts` (it lives with the touch layer's brain), KeyBar +
KeyboardAvoidingView wiring in `src/app/terminal.tsx`, GestureHandlerRootView in
`src/app/_layout.tsx`. Added `expo-blur` (native module — build, not reload).
Decisions: **the native `TextInput` owns the keyboard now** (T4's device-proven decision) —
uncontrolled, invisible, its `onChangeText` diffed against what it last held (`diffInput`:
DELs in code points, then the insert), Return via `submitBehavior="submit"` so it never
blurs; `emitKey` is the single per-key seam T12's dictation filter and held-delete land in.
The webview side now *disables* xterm's helper textarea outright — xterm's own mousedown
focus call no-ops, focus stays on the body, which is both "the webview never takes focus"
and exactly the focus state T4 measured long-press selection to need; `TerminalHandle.focus`
is deleted, nothing may raise the webview keyboard. Chords apply to typed letters too, not
just strip caps; a non-chordable key passes through and leaves the arm standing. Keyboard
docking is plain `KeyboardAvoidingView` (`padding`) — the terminal shrinks with it, which is
what fires §4.2's debounced resize for free. Bar swipes are one RNGH Pan (`runOnJS`, no
worklets); its activation cancels the childrens' presses, which is the whole "swiping never
presses keys" guarantee. The popovers do *not* live inside the bar: RN cannot hit-test
children drawn outside their parent's bounds, so `open` is lifted and the screen renders
scrim + popover in a layer over the stage, anchored at `popBase` = the bar stack's height,
which KeyBar itself reports via `onHeight` on layout — one measured number that already
includes the chord strip and will include T11's ribbon for free. Everything else (Ctrl,
input) stays in the bar. Icons are SF Symbols via the already-installed `expo-symbols`,
with text fallbacks (react-native-svg stays out).
Hooks left, all live on `KeyBarProps`: `onPasteLongPress` (T8 clipboard popover; tap-paste
reads the phone pasteboard until T8's slots), the disabled UPLOAD FILE menu section (T8),
`windowIndex` (T9 badge feed, default 1), `onTabsTap` + `onSwitcherDrag` (T10),
`onBarSwipeHorizontal(direction)` (T11 — fires on release past 30px, thresholds are T11's to
finish), the ribbon's slot between anchor and chord strip (T11), the Settings stub alert in
`src/app/terminal.tsx` with a working Disconnect (T12 sheet replaces it — Disconnect must
not be lost in the swap), and `emitKey` (T12 dictation filter + held-delete).
Verified: `bun test` (41), `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20. **Not
walked on hardware** — the device cases are TESTS.md §T7 (T7.1–T7.13). Still open besides
that: BlurView intensity 40 vs the design's `blur(14px)` is an eye-match guess; whether
WKWebView really resigns the TextInput's first responder on touch (T4 measured it once, this
build must confirm).
**Android half (2026-08-10)**: a Platform branch inside `Glass` skins every consumer — bar,
popovers, chord strip, T11's ribbon — at once: no blur, an elevated `surface0` container with a
small shadow, and Material metrics (16pt bar corners, 12pt keys, 20pt-capped popovers, 8pt side
margins) as platform constants beside the iOS ones. The design's own Android frames keep the
49pt geometry, so §3's old "40pt/8–12pt/mantle" line was corrected, not followed. Docking: KAV
behavior is now `undefined` on Android — the edge-to-edge window itself resizes for Gboard
(`softwareKeyboardLayoutMode` defaults to `resize`), which docks the bar and fires §4.2's resize;
the old `height` behavior would have subtracted the keyboard twice. Zero code for the rest:
chrome text sets no fontFamily (Android default is Roboto), and `SymbolView` with a string name
renders its `fallback` prop on Android, so no key goes blank. Still open: the emulator eye-walk
(TESTS.md §T7A), and whether the safe-area bottom inset leaves a strip between bar and Gboard
while it is up.

**T8 — Clipboard + ⋯ menu + uploads** ✅ implemented 2026-08-09 (not device-verified) · deps: T7, T2/T3
Clipboard slots store (OSC52 feed + pasteboard, pins persisted), Paste tap/long-press
popover, ⋯ glass menu (Files/Photo-video/Camera/Settings), pickers, **destination browser
sheet** (readdir, breadcrumb, editable filename, Save here, last-dir memory) + quick-attach
helper for the agent ribbon cap, both per §4.6, failure alert. *Accept*: file lands in a
browsed-to directory under its own name with nothing typed; quick-attach puts a photo in
`/tmp/port22/` and types the path with trailing space.
Landed: `src/clipboard-model.ts` + `src/upload-model.ts` (every decision, pure and tested in their
`.test.ts` files: the three-slot ring with pin survival and unpin-drops, the provenance wording,
the SecureStore pin round trip, the filename sanitiser, the UTC-stamp quick-attach name with the
date injected, destination-path arithmetic, dirs-first listing order), `src/clipboard.ts` (the
slots singleton — yanks session-transient, pins in SecureStore `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
because a pin is as likely as not a token), `src/upload.ts` (pickers, the shared `sendFile` with
the busy flag and the one failure alert, `quickAttach`), `src/upload-sheet.tsx` (the destination
browser, an RN `pageSheet` Modal), the clipboard popover + live ⋯ menu + sending tint in
`src/keybar.tsx`, the flow wiring in `src/app/terminal.tsx`, `lastUploadDir` in `src/settings.ts`,
pin hydration in `src/app/_layout.tsx`.
Decisions: **expo-camera stayed out** — expo-image-picker's `launchCameraAsync` *is* the system
camera UI, which is all the Camera row asks for (AGENTS.md check, the ladder's rung 5); Files is
expo-document-picker, and since neither picker returns bytes on native, expo-file-system's `File`
reads the picked URI as base64 — whole file in memory, size unguarded (§7). Destination paths are
**absolute**, with `$HOME` resolved once through `pwd` on an exec channel: SFTP has no `~`, and
the breadcrumb needs real segments to walk (the remembered `lastUploadDir` is re-checked with a
`listDirectory` and falls back to `$HOME` when it stopped existing). The sheet browses and
chooses; the *screen* uploads — so the ⋯ circle's busy tint covers both flows from the one flag
in `src/upload.ts`, and quick-attach tints it too. The sanitiser keeps unicode letters (valid
filenames, mangling helps nobody) but strips path separators, control characters and leading dots,
and turns whitespace runs into `-`; empty in, `file` out. A collision is shown twice: the file is
in the listing anyway (the design's reason for listing files at all) and the SAVE AS label says
"replaces the existing file" while the field matches one. Pinning the pasteboard row copies it
into the slots as a pinned entry — the design's "phone pasteboard · pinned" third row. The Paste
key's tap asks `topSlotText()`: top slot first, phone pasteboard as fallback, so the pre-T8
behaviour survives an empty ring. OSC 52 reads stay unanswered — untouched from T4.
Quick-attach's exported contract for T11's 📎 cap:
`quickAttach(kind?: UploadKind): Promise<string | null>` in `src/upload.ts` — picker → SFTP to
`/tmp/port22/<UTCstamp>.<ext>` (mkdir 0700 on demand, the native upload's chain) → path + one
trailing space typed, never a Return; resolves the typed path, `null` on cancel or failure (the
alert has already been shown, nothing typed either way).
Verified: `bun test` (82), `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20. **Not
walked on hardware** — the device cases are TESTS.md §T8 (T8.1–T8.16; T8.16 is log-driven until
T11 wires the cap). Still open besides that: the iOS paste-banner cadence in T8.5 (once per
popover open) is the design's acceptance, only a device shows it; the sheet is an RN `pageSheet`
Modal rather than the design's custom sheet — grabber and swipe-dismiss come from the system;
Android pickers/permissions are T3-era work.

**T9 — tmux side-channel + config push** ✅ implemented 2026-08-09 (not device-verified) · deps: T5
Probe, config file v1 content, SFTP push + source + read-back verify, status in settings
store, exec-channel helpers (`list-windows`, `capture-pane -e`, `select/kill/new/move-window`),
window-title badge feed, foreground-process poll for ribbon. *Accept*: fresh host gets conf,
works on a `fish` login shell, badge tracks window.
Landed: `src/tmux-model.ts` (every decision, pure and tested in `src/tmux-model.test.ts`: the
conf text, the push decision, source-line logic, all command builders, all parsers, the derived
config-status/tabs states, `shellQuote`), `src/tmux.ts` (the store singleton + poll timer + the
real exec/SFTP calls), `startTmux`/`stopTmux` riding `set()` in `src/session.ts`, `showTabs` +
live `windowIndex` on the bar (`src/keybar.tsx`, wired in `src/app/terminal.tsx`).
Decisions, the load-bearing ones measured rather than assumed: the conf travels over **SFTP, not
a heredoc** — the reference (`TmuxConfig.swift`, their T60) learned that an exec channel hands
its string to the *login shell* and fish cannot parse a heredoc; every command left on the exec
path here is one line fish and POSIX sh parse identically, each run through `fish -c` before
landing. Apply and verify are **one tmux client command** (`start-server \; source-file \; show
-gv @port22`): measured locally, a session-less server exits with its last client, so a separate
verify exec finds "no server running" on exactly the fresh host that matters. Verify reads a
`@port22` *user option* back — a real option like `mouse` can be masked by the user's own
conf setting the same value. The push decision is **content equality**, not a marker compare (a
marker passes stale/truncated files; equality still bump-replaces a v0 for free). The user's own
tmux conf is **append-only via `printf >>`** — SFTP would be read-modify-write on a capped read,
which is data loss — and the target respects tmux's first-found order (`~/.tmux.conf` before the
XDG path, chosen via SFTP existence checks, no shell involved). The window badge rides the ~2s
**poll**, and v2 of the conf therefore stopped setting `set-titles` at all: a title change
would need an xterm `onTitleChange` bridge T4 never built, and the ribbon needs this poll anyway
— one exec answers attached + window index + foreground at once. "Attached" is
`#{session_attached} > 0` (ponytail-marked ceiling: a desktop client attached while the phone
sits at a plain shell fools it; `#{pane_tty}` against our own PTY is the upgrade). `list-windows`
fields ride a US (0x1f) separator with the window *name last and rejoined*, so a name containing
anything at all shifts nothing; window commands interpolate validated integers only, and
`shellQuote` (POSIX single-quote escaping, which fish parses identically) is the exported
contract for later tasks. State shape for the consumers: `TmuxState { present, config, attached,
windowIndex, foreground }` via `useTmux()`, `configStatus()` folding the toggle in for T12,
`tabsAvailable(present, status)` deriving T7's button, and `listWindows`/`capturePane`/
`selectWindow`/`killWindow`/`newWindow`/`moveWindow` for T10/T11 — mutations nudge the poll so
the badge never waits out the interval.
Verified: `bun test` (58), `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20, and the
command sequences against tmux 3.7b + fish 4.8.1 locally. **Not walked on hardware** — the
device cases are TESTS.md §T9 (T9.1–T9.10; T9.6/T9.7 need T10's UI to drive, T9.8's on-screen
half needs T11). Still open besides that: `move-window -a/-b` needs tmux ≥ 3.2; the
`session_attached` ceiling above.

**T10 — Tab switcher** ✅ implemented 2026-08-09 (not device-verified) · deps: T9, T7
Card grid + snapshot rendering (ANSI→styled text mini-view), zoom-in/out transitions
(button tap + drag-following bar-swipe-up per prototype `zoomFollow`), select/close/create/
reorder gestures incl. swipe-to-close rubber-band and drag with dashed slot, new-tab birth
from +, Done, count header, last-window-ends-session. Android: container-transform + FAB +
predictive back instead of Safari zoom. *Accept*: all gestures on device, reorder issues
`move-window`, snapshots refresh while grid open.
Landed: `src/ansi-spans.ts` (SGR→spans parser + xterm-256 palette computation, tested in
`src/ansi-spans.test.ts`), `src/switcher-model.ts` (every decision, pure and tested in
`src/switcher-model.test.ts`: slot geometry and zoom interpolation as fractions of the
prototype's 402pt design width, the reorder mapping, swipe thresholds, the + birth frame),
`src/switcher.tsx` (the grid, the cards with their tap/fling/long-press-drag gestures, and
`useSwitcherCards` — the list kept warm from connect, snapshots on a ~2s beat reusing T9's
`POLL_MS` while the grid is open), and the zoom state machine + stage wrapper in
`src/app/terminal.tsx`.
Decisions: **ANSI parsing is ported minimal, not adopted** — the npm check (AGENTS.md) found
`anser` already in the tree (react-native's LogBox dependency) and read its API: it resolves
colours to its own hardcoded palette (RGB strings, or HTML class names), so mapping its output
back onto the theme's Catppuccin slots means reverse-engineering colour strings; `ansi-parser`
(dormant ~9 years) and `ansi_up`/`ansi-to-react` (DOM renderers) fit worse. The parser here
keeps slots symbolic (0–255 or `#hex`) and the theme maps them at render; slots 16–255 are
xterm's own cube/gray *algorithm*, computed, not a hand-copied table. **The switcher is an
in-screen overlay, not a router route**: the zoom scales the LIVE terminal surface into a
specific card slot, which needs both layers in one coordinate space with one shared progress
value — a modal route would cover the very view that must keep rendering mid-transition. The
zoom itself is one tested function (`zoomFrame`): height as the clip (the prototype's
clip-path), radius, and a centre-origin-compensated translate, driven by two shared values
(progress + finger drift at the prototype's 0.6) from both entries — tabs tap and T7's bar
swipe-up, whose `onSwitcherDrag` hook grew into `(phase, dx, dy)` for the drag-follow. Reorder
speaks **tmux indices, never array positions** (`reorderArgs` from the pre-drag list — gapped
indices shift nothing), the optimistic order holds until `moveWindow` + re-list answer, and
what tmux did is what the grid then shows. Kills are optimistic and idempotent — the ✕ hit
rides the card's own tap gesture by position, because a Pressable under an RNGH Tap can
double-fire and a second `kill-window` against a renumbered index is not a no-op. Closing the
last window just drops the grid: the PTY dies with the window and T5's §4.9 machine owns the
screen from there. No haptic on select (§7); the lift has one.
Verified: `bun test` (106), `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20. **Not
walked on hardware** — the device cases are TESTS.md §T10 (T10.1–T10.14). Still open besides
that: keyboard re-raise on return uses a `focusSignal` counter prop on KeyBar,
worth a device look; snapshot cards render bg colour per span but no reverse-video/underline
(deliberate subset).
**Android half (2026-08-10)**: the design files collapsed most of the work. The two prototypes
share the zoom **verbatim** — same `zoomSty`/`zoomFollow`/`REST` strings, same 0.3s/0.12s
opacity stagger, same 0.6 finger drift, same 0.25 commit — so "container-transform" is the
Material name for the transform already implemented (end-fade included), not a second
animation system: no new frame function, and the bar-swipe-up drag-follow is in the Android
prototype too, riding the same progress. Card metrics are the same fractions (170/396 vs
173/402, identical 20/16/298 dp grid, 14 radius, same rings) — no card skin branch. What is
actually Android: (1) the grid's bottom bar, one Platform branch in `switcher.tsx` — Done as
an accent **text button bottom-left** (§4.10's old "top-left back" was §2g's draft; §5c and
the prototype have no grid header at all), "n tabs" in Roboto muted, and a 56dp accent FAB
(12dp corner per the prototype; the §5c still shows 18 — prototype wins, T7A's tie-break);
(2) `fabFrame` in switcher-model (tested) as the birth origin — absolute Material dp, not
design-width fractions; (3) a `BackHandler` subscription while the switcher is up: back
closes the grid into the active pane, swallowed mid-transition. **Predictive back stays
`predictiveBackGestureEnabled: false`**, on evidence: RN 0.86's `ReactActivity` registers an
always-enabled `OnBackPressedCallback` ("Due to enforced predictive back on targetSdk 36,
'onBackPressed()' is disabled by default. Using a workaround to trigger it manually") — RN
itself routes around predictive dispatch, an enabled callback suppresses the OS peek anyway,
and JS `BackHandler` cannot feed the progress animation; the flag would buy nothing and risk
libraries still assuming `onBackPressed`. Revisit when RN forwards back-progress to JS. Still
open: design §5d wires back at *every* level (sheet → dismiss, browser → up one directory,
terminal → home) — only the switcher level is wired here (T12A-era), and back at terminal
level still pops to Setup without disconnecting, the Android twin of the iOS edge-swipe note
in `terminal.tsx`; the emulator walk is TESTS.md §T10A (T10A.1–T10A.8).

**T11 — Bar-swipe window switching + ribbon** ✅ implemented 2026-08-09 (not device-verified) · deps: T9, T7
*(2026-08-12: the ribbon half was redesigned to the edge handle — see §4.4. The in-bar pill, its
ghost-ribbon swipe morph, the settle-deferred ribbon swap and the chrome-refit wait in
`afterHostRedraw` all left with it, since the handle never resizes the terminal. The record
below describes what landed on 08-09.)*
Horizontal bar swipe: page-slide cards, rounded corners during drag, name pills strip,
rubber-band ends, flick thresholds from prototype. Neighbor page content = **fresh
`capture-pane` snapshot taken on swipe start** (accepted ~100–300ms before slide attaches);
live PTY content replaces it after `select-window` redraw. Context ribbon: recipe engine +
all §4.4 built-ins (running/suspended/vim/pagers/htop/agents), collapsed-pill UX, dismissal.
*Accept*: swipe hops windows without switcher; ribbon controls a live build; `:wq` cap
finishes a `git commit` from insert mode; agent cap attaches a file.
Landed: `src/barswipe-model.ts` (the page slide's decisions, pure and tested in
`src/barswipe-model.test.ts`: rubber-band at a third past the ends, commit at 70pt or a 30pt
flick under 250ms, 430-at-402 page pitch, the name pills' scale/opacity interpolation, the
neighbour page's type size), `src/ribbon-recipes.ts` (the six built-ins as declarative data —
match names → caps `{label, caption, bytes|action, danger}` — so PLAN §6's user editor is a data
problem later), `src/ribbon-model.ts` (selection, suspension, identity, kill, pure and tested in
`src/ribbon-model.test.ts`), `src/ribbon.tsx` (the glass pill: pulse, timer, caps, the two
gestures), the pills strip + ribbon slot + `onBarSwipe` in `src/keybar.tsx`, and the page-slide
state machine + ribbon glue in `src/app/terminal.tsx`. `Snapshot` (T10) and `Glass` (T7) are now
exported and reused rather than re-drawn; `src/tmux.ts` grew a one-line `exec` export.
Decisions: **the bar's final horizontal contract is raw gesture out, model in the screen** —
`onBarSwipe(phase: 'start'|'move'|'end', dx)` replaced T7's release-only hook; the bar reports,
the screen owns rubber/thresholds/commit, and both ride one shared page-offset value (the pills
derive their continuous position from it in worklets, so nothing re-renders per frame). The
vertical claims run *alongside* it rather than instead of it (2026-08-12): the pan no longer picks
an axis and holds the rest of the gesture to it. `barGrabbed` puts the page in hand on horizontal
travel, `barLifts` hands the vertical to T10's zoom from anywhere in the swipe (travel for a pull
straight up, velocity for a flick out of a swipe already sideways, which no travel test could
catch), `barDismisses` is the keyboard — and both surviving axes stay live at once, Safari's
model: a card pulled a little off the bar still pages between windows, and the page swipe can
start at any point in the pull up. Only the release picks, in the screen, which is the side that
knows the zoom progress: it commits to the grid and sets `gridTookIt`, and the horizontal's own
'end' — the next call in — reads that and springs home deciding nothing. The zoom's own sideways
drift freezes at the grab, so exactly one thing is carrying x at any moment.

The lift's threshold is **a cone, not a half-plane** (2026-08-12, device log): a bar at the bottom
of the phone is swiped with a thumb, the thumb pivots, and the opening 25pt of an ordinary flat hop
are upward at -600…-900pt/s — ten in a row, so neither "up beat sideways" nor "it was thrown up"
can tell that arc from a pull. Straight up still lifts at `BAR_SWIPE_FIRE`; every point of sideways
travel buys 1.5 more points of up; past `LIFT_FLICK_DX` the cone is unreachable and only a real
throw gets out. Those ten measurements are the fixtures in `keybar-model.test.ts`.

A **held card does not fly while it is held** (2026-08-13, Safari screenshot): `holdFrame` is the
stage scaled about its own centre — uncropped, so `zoomFrame`'s clip stays open and it is the whole
screen made small — and `aimFrame` blends hold→slot on `flight`, which only the bar drag takes off
1 and only `commitOpen` puts back. Aiming at the grid slot from the first frame of the pull was
what made the gesture read as one step: the card was already halfway into a corner while the finger
still had it, with nowhere left to push it sideways.

**While the finger is down, everything is travel-driven — no clocks** (user principle,
2026-08-13). A timed animation cannot match a finger: instant reads harsh, any duration is too
quick at one speed and lags at another — the joining card's approach went through all three
before landing on travel (44pt beyond its pitch, seated by 70pt of |x|). Clocks are legitimate
in exactly two places: after the release, where there is no finger to track (flights, the hop's
landing slide — itself distance-proportional), and on the held join, which triggers on stillness,
where travel does not exist and nothing else is moving to be out of sync with.

Which leaves *what moves*. Only the terminal area slides at rest — the bar stays put under the
pills, which is why the page wrapper sits inside the stage rather than being the stage — but a
lifted card has an outline, and an outline that holds still while its content slides inside it is a
window, not a card. `cardCarry` hands the offset from the page to the card over the first tenth of
the lift; both draw it at the same place on screen, so the handover is invisible.

The pages beside it took four goes, and the lesson is worth the space. They cannot be children of
the card (they share its clip and its ring, so a row of cards renders as one frame with pages
sliding about inside it), and giving each its own copy of the zoom is worse: two transforms that
must agree by arithmetic, which drew a neighbour unscaled beside a card at `HOLD_SCALE`, and at
`HOLD_SCALE²` when the tree put the zoom on both. So **one `zoomBox` carries the whole row** — one
scale, one flight, no clip — and the cards inside carry only their pitch and their own crop.
Within it they are drawn **in front of** the live card, with the key bar moved out to sit in front
of them: behind it they were laid out perfectly (420×912 at the right offset, every number checked
on device) and simply never drawn, because a transparent parent still owns its subtree. Three
fixes aimed at backgrounds and tree order missed that; `onLayout` said it in one line. They join
on `pageSwipe` — a card held up alone has no row until the finger starts moving sideways — and
leave on the commit, or they fly into the grid a pitch behind the card: tabs arriving in pairs.
After a
commit the slide lands on the snapshot, a **settle overlay** holds that snapshot ~350ms while
tmux's redraw reaches the PTY, then drops (ponytail: fixed hold; dropping on first shell data is
the upgrade). **Suspended is tracked, not observed**: the poll cannot tell "stopped" from
"exited", so a ^Z on the key-bar send path (chord strip and typed Ctrl+Z both route through it)
makes the running command a candidate, and a poll answering "shell" within 6s makes it
`suspended` — the ribbon's own "background" cap deliberately bypasses the watch, because that ^Z
ends backgrounded. **A process instance is a transition counter**, not a pid: `#{pane_pid}` is
the shell, constant across every job in the pane, so dismissal and the running timer key on a
counter bumped at every foreground change (design 4a's "returns when the foreground process
changes" verbatim). Kill-force is `pgrep -P <pane_pid> | xargs kill -9` on an exec channel —
xargs, not `$()`, for the same fish/POSIX-parity rule every T9 command obeys. Recipe selection
order: dismissal, tracked suspension, name match (vim on the alt screen is vim), then the
silences — REPL names and unmatched alt-screen apps — then `running`.
Verified: `bun test` (129), `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20. **Not
walked on hardware** — the device cases are TESTS.md §T11 (T11.1–T11.15). Still open besides
that: agent CLIs whose `pane_current_command` is their interpreter (`aider` polling as `python`)
miss the name list — the recipe data is where that gets fixed when a real host shows its names;
the settle hold and the 6s candidate window are hardware-tuning knobs like T6's; a kill on a
`running` recipe clears on the next poll beat rather than instantly (deliberate — the poll is
the truth).

**T12 — Settings sheet + polish pass** ✅ implemented 2026-08-09 (not device-verified) · deps: T7–T11
Bottom sheet per design (sections, swatch rows, stepper 8–32, tmux toggle wiring incl.
hiding tabs button, Disconnect, Forget host key confirm), dictation space filter,
held-delete repeat, `?996n` on theme flip live-restyle, 120Hz opt-in, launch bg + icon,
themed everywhere via roles. *Accept*: design-side-by-side review of every screen, both
platforms, all four flavours.
Landed: `src/input-model.ts` (the pure decisions, tested in `src/input-model.test.ts`: the
dictation filter's table, the line tracker behind it, the sheet's release rule),
`src/settings-sheet.tsx` (the sheet), the filter + held-delete + tracked-send seam in
`src/keybar.tsx`, the flip notification in `src/terminal.tsx`, `applyConfigure` in
`src/tmux.ts` (gone again with the toggle it existed for — see §4.1's start modes; the sheet's
TMUX row is now status only), sheet wiring replacing the stub alert in `src/app/terminal.tsx`, 120Hz +
splash + icon in `app.json` and `assets/images/`.
Decisions: **the sheet is a transparent RN Modal with its own slide** — reanimated drives the
translate, one RNGH pan is the swipe-dismiss (release rule tested), scrim and grabber both
close, no Done; T8's system `pageSheet` was ruled out because its grabber dismisses without
telling the animation, and no new dependency was worth a sheet this small. The prototype's
"All settings" row is **omitted**: its destination is the Setup form §4.8 hides while
connected plus options PLAN §6 settled against, so the door had nowhere to lead — stated
here rather than wired to nothing. **Dictation heuristic**: the filter runs on the whole
TextInput diff (spacebar vs dictation is a chunk-size question, invisible per key) — a
multi-char insert starting with a space at an *empty line* loses the space, a single `' '`
always passes; line emptiness is tracked from what the bar itself sends (printables up, DEL
down, `\r`/^C/^U reset, other controls ignored — a stated ceiling, not a bug). **Held-delete
finding**: iOS's keyboard auto-repeats `deleteBackward` natively, so repeat needs no timer —
each repeat reaches `onChangeText` while the field has content (the diff emits DEL) and
`onKeyPress` once it is empty; that second path also fixes a T7 gap where backspace after a
blur/trim sent nothing at all. **`?996n`**: the query reply already read the live theme; what
was missing was the push — the DOM component now sends `colorSchemeNotification` (DECSET
2031 form) when the flavour actually changes, never on boot or font change. **Icon**: T1's
assets were the Expo template's, so `assets/images/icon.png` and the two splash glyphs are
generated (crust ground, `>_` in flavour blue, the bundled JetBrains Mono; light splash is
Latte crust + Latte blue via the plugin's `dark` split) and the template `expo.icon` bundle
is gone. Colour sweep came back clean: the only literals outside `theme.ts` are the
prototype's own cross-flavour neutrals (overlay-grey tints, hairlines, shadow black, toggle
knob white), kept deliberately. Forget-host-key lives in the sheet now *and* stays on the
mismatch screen — during a mismatch the sheet is unreachable, so that copy is load-bearing
(§4.1's only recovery there).
Verified: `bun test` (137), `tsc --noEmit`, `expo export -p ios`, `expo-doctor` 20/20. **Not
walked on hardware** — the device cases are TESTS.md §T12 (T12.1–T12.16, the last being the
cross-feature regression walk that seeds T13). Still open besides that: the dictation
single-space ceiling above; whether the Modal-hosted RNGH pan needs `GestureHandlerRootView`
exactly as written is an on-device check.
Android half (2026-08-10): the "both platforms" accept. **Sheets** — the settings sheet's whole
Android skin turned out to be one radius: `panel`/`surface`/the overlay grabber already render
the design's mantle/surface0/ov0 through the theme roles, so only the 28dp Material corner
(§5d) is platform-branched; the upload sheet's `pageSheet` is iOS-only and rendered full-screen
on Android, so there it is a transparent Modal with a tap-to-cancel gap and a 28dp-cornered
sheet below (the prototype's fading scrim is skipped: RN's `slide` animates the whole modal
tree, so a scrim would ride the slide — not worth a second hand-rolled sheet), plus the
`Did*` keyboard events Android actually fires for the SAVE AS lift. **Back (§5d)** — one
BackHandler subscription in the terminal screen now walks the ladder T10A started: switcher →
pane (as before), popover/⋯ menu → closed, and at the bare terminal `BackHandler.exitApp()`,
whose task-root default is moveTaskToBack — §5d's "terminal → home", replacing the old silent
pop to Setup that skipped the disconnect. The two sheets need no subscription: RN Modals take
Android back natively via `onRequestClose`, where the settings sheet already dismissed and the
upload sheet now goes up one directory, dismissing only from `/` (iOS keeps plain cancel there
— its `onRequestClose` fires only after the pull-down has already dismissed). **Icon** — the
T3-era template art in `android-icon-*.png` is gone: foreground and monochrome are lifted from
T12's own `icon.png` (green-channel alpha mask → solid `#89b4fa` / white, glyph scaled ⅔ so it
reads the same optical size once the launcher shows the inner 72/108, well inside the 66/108
safe circle), the background image is dropped for the flat crust `backgroundColor` already in
`app.json`. **Verified no-ops, on evidence** — splash: the plugin feeds root props (image,
colours, `dark`) to Android 12+ itself (`getAndroidSplashConfig` merges root into `android`);
permissions: document-picker's plugin touches only iOS entitlements (SAF needs nothing),
image-picker's own manifest declares CAMERA + legacy `maxSdkVersion:32` storage, the 13+ photo
picker needs no permission, and the existing `microphonePermission: false` blocks RECORD_AUDIO
— so `app.json` gains nothing, deliberately; status/nav bars: SDK 57 enforces edge-to-edge and
`_layout`'s `<StatusBar>` already follows `theme.isDark`, the gesture pill draws over the app's
own ground, and 3-button nav's contrast scrim is the system's own. Verified: `bun test` (140),
`tsc --noEmit`, `expo export -p android`, `expo-doctor` 20/20 — no Android SDK on this box, so
never compiled or run; the emulator cases are TESTS.md §T12A (T12A.1–T12A.9). Still open on
this half: §5d's clipboard-as-bottom-sheet and the upload snackbar-with-UNDO (divergences the
task slices never claimed — future Android polish), and Gboard's held-delete `onKeyPress`
coverage plus dictation-chunk shape, flagged in T12A.9 rather than guessed at.

**T13 — Device verification + builds** deps: all
Walk §4 acceptance criteria on physical iPhone & Android. *Accept*: checklist in repo with every
item ticked on hardware.
T6–T12 are implemented but untested on device; TESTS.md (T6.1–T12.16) is the walk.
The iOS half of the build/sideload story landed early, in T2, because nothing else could be
verified without it: `.github/workflows/ipa.yml` builds an unsigned Debug dev client on
`macos-26`/Xcode 26.6 (older toolchains cannot compile `expo-modules-jsi`) and publishes it as the
rolling `dev` prerelease; `docs/ship.md` is the laptop half — download, netmuxd, `xtool install`,
which signs with the free Apple ID. Free provisioning expires weekly, so a re-sign is a re-run of
that, not a rebuild. Android APK install is still unwritten.

**T14 — Search across every window** ✅ implemented 2026-08-10 (device walk pending, TESTS.md T14.*) · deps: T10, T9, T4
A search field in the tab switcher that matches **the output of every tmux window**, not just its
metadata. As the user types, the grid shrinks to the matching windows and each surviving card's
preview scrolls to the **first occurrence** in that window and highlights the string, so the hit is
visible in the card itself.

What is matched, per window: the window name, the active pane's foreground process, the pane's
working directory, **and the whole scrollback**.

Deliberately simple about multiple hits: the grid shows the *first* occurrence per window and
nothing more. More than one match inside a window means tapping into that window and walking the
occurrences there — the terminal view gets prev/next-occurrence UI for that.

The search string is **one piece of state shared by the two views**, armed or disarmed as a whole.
Editing it on the terminal view updates the switcher's field, so coming back to the tabs view finds
the search still armed and showing the edited string. Disarming works from **either** side — the
terminal view's search UI and the switcher's field both close it, and the other view reflects that
immediately.

*Accept*: typing in the switcher narrows the grid to windows whose name, path, process or
scrollback contains the string, each card showing and highlighting its first hit; tapping a card
lands in that window with the same string armed and prev/next walking its occurrences; editing the
string there and returning shows the narrowed grid for the new string; disarming from either view
leaves both unarmed.

**Fuzzy verdict (spike run 2026-08-10): not viable — substring stays the only mode.** Evidence,
per the two halves:

- *Scrollback* is where fuzzy dies, on arithmetic before implementation. Subsequence matching
  (`abc` → `a.*b.*c`, the `grep -E` shape) over a 5k-line corpus built from this design's own
  window content (cargo build output, nginx logs, htop, prompts) matches far too many lines:
  6-char queries still hit 5–15% of all lines — `cargob` matches 15% of lines where substring
  matches 0% — because an ~80-char line contains nearly every short subsequence. And the grid
  narrows per *window*: with 50k lines of scrollback, a window survives when ANY line matches, so
  P(survive) = 1−(1−p)^50000 ≈ 1 for any per-line rate above ~0.001%. Measured: per-line 0.01% →
  window survives 99.3% of the time. No minimum query length in typing range fixes that, and a
  toggle doesn't change the arithmetic — a fuzzy mode would simply never narrow the grid.
  (Spike script: subsequence + substring rates by query length, plus the window-survival curve.)
- *Metadata* fuzzy alone is technically fine — the `fzf` npm package (fzf-for-js) was read:
  `new Fzf(list, {selector, casing})`, `find(q)` → `{item, score, positions: Set<number>}`,
  positions being exactly the k-disjoint highlight indices; `fuse.js` (maintained, 7.x) offers
  ranges via `includeMatches`. But fzf-for-js's last publish is 2023-04, and the accept criterion
  required "grid-narrowing … behaviour otherwise unchanged in both modes" — with scrollback
  unable to go fuzzy, a fuzzy toggle would either lie (metadata fuzzy, scrollback secretly
  substring) or not narrow. A toggle that changes only three short metadata strings is not worth
  a mode. Not built, and the spike's own text below records what was checked.

The original spike brief, kept for the record:

- *Metadata* (window name, process, cwd) is already on the phone — fuzzy there is cheap. Package
  check first, per AGENTS.md: the `fzf` npm package (fzf-for-js, a port of fzf's ranking
  algorithm) and `fuse.js` are the candidates; read their actual APIs before ruling either in or
  out. The dataset is N windows × three short strings, so hand-rolled subsequence scoring is the
  fallback if neither fits — not a third library.
- *Scrollback* stays on the host, so fuzzy there means changing the grep: explode the query into a
  subsequence pattern (`abc` → `a[^x]*b[^x]*c` shape, metacharacters escaped) and run
  `grep -i -E -m1` instead of `-F` — still one exec per window per settled keystroke, still
  `-B/-A` for the card's context. `fzf --filter` ranks better but cannot be assumed installed on
  the host; `agrep` even less so — POSIX grep is the only tool the design may rely on.

Questions the spike must answer with evidence, not assumption: **noise** — short fuzzy queries
match nearly every line of scrollback; does a minimum query length fix it, or does fuzzy need an
explicit toggle in the search field rather than being the default? — and **highlighting** — a
fuzzy hit is scattered characters, not one contiguous span, so the span surgery in
`src/ansi-spans.ts` has to mark k disjoint ranges per line, and the mid-word colour-change problem
below gets strictly worse. *Accept (fuzzy)*: a written verdict in this task (viable or not, with
the evidence); if viable, a substring↔fuzzy toggle on the shared search state, with the
grid-narrowing, first-hit and highlight behaviour otherwise unchanged in both modes.

How it was built (2026-08-10, design from the claude.ai/design project's iOS prototype; Android
takes the same layout with Material chrome per its §5d divergence list):
- The scrollback stays on the host: `capture-pane -p -e -S - -t :N | grep -i -F -n -m1 -B14 -A20`
  per window per settled keystroke (300ms debounce), built and parsed in `src/search-model.ts`
  (tested); `-B14/-A20` because the card renders the context block from the top, which puts the
  hit ~40% down — the prototype's scroll-to-first-occurrence with no scroll machinery.
- `LIST_WINDOWS` now carries `#{pane_current_command}` (name still last); the metadata half
  (name · cwd · process) matches on the phone, instantly, while the greps ride the debounce.
- Highlighting is span surgery in `src/ansi-spans.ts` (`highlightLine`): the match runs over the
  line's joined text, so a hit split by a mid-word colour change highlights whole on the phone.
  The host-side grep, though, runs over the escaped capture — a colour-split hit is *found* only
  if its bytes are contiguous. Ceiling accepted (ponytail note in search-model): the upgrade is a
  plain capture for line numbers + a coloured re-capture, two round trips per window.
- The terminal view's half is `@xterm/addon-search` 0.16.0 (API read: public-API-only —
  `registerDecoration`, `translateToString` — so xterm 6 carries it): decorations highlight every
  occurrence, `findNext/findPrevious` walk them, `onDidChangeResults` feeds the "i/N" label over
  the bridge. Nothing hand-rolled. Ceiling, accepted: the addon walks xterm's own buffer — what
  was ever painted at the phone — so tmux history from before this attach, or from time spent in
  another window, is findable in the *grid* (host grep) but not walkable in the terminal view.
  The upgrade if it ever matters is host-side `copy-mode \; send -X search-backward`, which walks
  the true 50k lines and highlights through the PTY, at the price of putting the pane into
  copy-mode from a phone UI that then has to own exiting it.
- One piece of state, armed or disarmed as a whole, lives in the screen
  (`src/app/terminal.tsx`): the switcher's field and the terminal bar edit the same string;
  disarm (✕ or Done) clears both; a card tapped with the search armed lands with the keyboard
  down (you came to read); birthing a new window disarms.
- Drag-reorder is disabled while the grid is filtered — a narrowed grid isn't the real order.

---

## 6. Open decisions

1. ~~SSH lib choice on Android (sshj vs MINA)~~ — settled in T3: sshj 0.40.0 (see the T3
   write-up and the header of `modules/expo-ssh/android/.../SSHSession.kt` for the evidence).
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
