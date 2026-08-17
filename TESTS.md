# TESTS.md — device verification test cases

Written during implementation (T6–T12), executed later in one hardware phase on a physical
iPhone against a real host. Unit tests (`bun test`) already ran at implementation time; this
file holds only what needs a device, a finger, or a live SSH session.

Conventions:
- Case IDs `TX.n` (task, number). Each case: **Setup → Steps → Expect**.
- A case that depends on another task's feature says so inline.
- Every case carries **two ticks — `iOS:` and `Android:`** — and both have to be walked; a
  ticked iOS case says nothing about Android. Cases that only exist on one platform (the
  emulator sections §T3/§T7A/§T10A/§T12A, T14.7, T14.9) carry that platform's tick only.
- Tick `[ ]` → `[x]` only on hardware, during the verification phase (T13). Notes on a tick
  line are that platform's evidence.

**Android status (2026-08-16): nothing is verified.** The app has been launched in the emulator
and that is all — every Android tick in this file is open, including the ones whose iOS twin is
ticked with evidence. The shared-TS argument ("same code, so it passes") is not evidence; walk
the cases. Android runs on this box via the `android-test` skill (`. ~/Android/env.sh`, host
sshd at `10.0.2.2`).

## Android is tested against iOS, pixel for pixel

The design files are gone (AGENTS.md, "One app, two platforms"). **The iOS build is the only
reference.** An Android case does not pass because the screen works — it passes when the screen is
indistinguishable from the same screen on iOS.

Every Android case checks all of it, not just the behaviour the case names:

- **icons** — the right glyph, the right size, the right weight, the right optical centre. There
  is no longer a second implementation to catch out: `expo-symbols` is uninstalled and all eleven
  former `<SymbolView>` sites draw the same bundled Nerd Font codepoint on both platforms
  (2026-08-16). SF Symbols were an Apple API, so parity cost the iOS build its symbols — that was
  the deliberate trade. What still needs checking is that the codepoint is actually IN the face:
  `python3 scripts/patch-font.py` fails loudly if a chrome glyph is missing.
- **fonts** — family, size, weight, letter-spacing, and that the glyph is actually in the bundled
  face. A codepoint the face lacks does not fail loudly; it falls through to Noto at a different
  weight (`scripts/patch-font.py` holds the check).
- **buttons** — size, corner radius, fill, border, shadow, pressed state, hit area, disabled
  colour.
- **colour** — sampled, not eyeballed, and matched to the palette role rather than to "looks about
  right".
- **spacing and geometry** — margins, insets, bar heights, where a sheet stops.
- **animations** — the same curve, the same duration, the same thing moving. A transition that
  merely arrives at the right place is not a pass.

**Screenshot every control, not every screen.** A full-frame 1080×2400 screenshot read at fit-width
cannot resolve a 40px glyph — that is exactly how `▣` shipped as the tabs button. Crop each control
at native resolution and look at it.

**When a comparison needs the iOS side, ask for it.** The iPhone is the user's and there is no
simulator on this box, so a screenshot of the iOS screen is something only they can produce: ping
them for it, name the screen and the state you need, and wait rather than guessing. Guessing what
iOS looks like is how a divergence gets ticked as a pass.

A difference from iOS is a finding, whatever the case's own Expect says. Record it, keep walking.

## RESOLVED — the switcher reorder-snap (T10.9)

Root-caused and fixed on 2026-08-10, after the frame-vs-log correlation this section used to call
for. The write-up stays because the mechanism is a trap the rest of the codebase can walk into.

**Root cause.** The drag base (`baseX`/`baseY`) was a Reanimated shared value written from the
gesture's `onStart` — which runs on the JS thread (`runOnJS(true)`). A JS write to a shared value
flushes to the UI thread *asynchronously*, so a new drag's first `onUpdate` could read the
**previous drag's base** and set `x = staleBase + ~0`: the card teleports to its old slot in one
frame. With the finger held still no further `onUpdate` fires, so the card parks there until the
drop springs it home — exactly the observed "transient wrong position that resolves on settle",
with every state probe innocent because the state *was* correct.

**How it was caught.** All-cards position probes at lift (JS-side: always correct) plus a 60fps
screen recording showed a one-frame, pixel-exact teleport to the pre-reorder slot that JS never
saw. A `useAnimatedReaction` watchdog logging any single-frame jump >60px then caught it red-handed
on the UI thread: `JUMP @9 x 218 -> 21`, where 21 was precisely the previous drag's base. The
mirrored jump (21 → 218) matched the first video.

**Fix.** `src/switcher.tsx`: the base is a plain `useRef` — every gesture callback already runs on
JS, so JS-only memory cannot lose the cross-thread race. Verified on hardware: many
reorder-then-immediately-relift rounds, watchdog silent, no visual glitch.

**Moral.** Inside `runOnJS(true)` gesture callbacks, do not round-trip scratch state through shared
values — write-then-read from JS races the UI-thread flush. Shared values are for what the UI
thread renders; plain refs for what JS computes.

**Act two — the stranded lift (same session, after the fix above).** Grabbing a card right after
a drop sometimes froze it mid-lift (pink ring, tilted, finger off) with the pan never finalizing.
Touch-level probes showed iOS *cancelling* the touch mid-hold — and RNGH's native
`activateAfterLongPress` timer still maturing the dead touch into a drag with no finger on it.
A JS-timer manual activation was tried and reverted: `mgr.activate()` from a `setTimeout` only
applies on the next touch event, so a still hold never lifts. What shipped in `src/switcher.tsx`:

- gestures built once (`useMemo`), per-render values routed through a ref — a gesture object
  recreated mid-drag makes RNGH swap the native handler under an active gesture;
- `touchDown` ref tracked in touch callbacks; a ghost activation (touch already cancelled) skips
  every side effect and the handler self-recovers on the next touch;
- `started` ref gates `onFinalize` — a pan that lost the race to swipe/tap finalizes too, and
  running the drop for a drag that never lifted issued phantom `move-window`s from stale state;
- zIndex driven by React (`dragged`), not `useAnimatedStyle` — a UI-thread zIndex flip when the
  drop-spring settles re-sorts native siblings, and iOS cancels in-flight touches on re-sorted
  views (this was the canceller: it fires ~400ms after a drop, exactly under an eager re-grab);
- children rendered in fixed id order, position via `slotFrame` only, so a grid reorder never
  reinserts native views; newest-started `refresh` wins (seq guard) so a stale poll can't snap
  the order back; a drop's delayed optimistic clear leaves the *next* drag's order alone.

Verified on hardware across dozens of reorder-and-immediately-regrab rounds, multi-row drags on a
6-window grid, swipes and taps interleaved: every drag-start paired with one drag-end, no phantom
reorders, no stranded lifts.

**Also decided (2026-08-10):** the last window is unkillable — killing it ends the tmux session
and drops the PTY into a bare shell; the lone card hides ✕ and its swipe rubber-bands. The
switcher's fire-and-forget tmux calls (`kill`, `new`, `move`) now catch and re-list on failure.

**Open, follow-up:**
- Target tmux windows by stable `@N` id in every command (`move-window`, `select-window`,
  `kill-window`, `capture-pane`) instead of index — a rapid re-drag can race the renumbering and
  hit the wrong window; for kill that is data-loss grade. `src/tmux-model.ts` change with tests.
- `[ssh] listDirectory failed: SFTPMessage.Status error 1` (EOF) fires once on every app
  relaunch — some startup path (last-destination restore?) lists before the connection is ready.

**Related, undecided.** Repeated reorders inflate tmux indices (`move-window -b/-a` shifts
neighbours; `src/tmux-model.ts:209` leaves `base-index`/`renumber-windows` to the user), so the tabs
badge climbs — 1 … 16 over one session. Options: push `set -g renumber-windows on` in the app's
conf, or leave indices as tmux gives them. Needs a decision, not a fix.

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
  T11 (bar swipe ↔; the ribbon's edge handle floats over the terminal, not in the bar).
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

## T3 — expo-ssh Android (emulator)

The Kotlin module compiles and connects — `47950a5` was built and run on the emulator against
this box's sshd, so T3.0's "never compiled" premise is gone; it stays as the smoke case that
gates the rest on any fresh checkout. All cases run on the Android **emulator** against the host machine's sshd — from the
emulator the host is `10.0.2.2`, not `localhost`. These mirror the T2/T5 accept list: the TS
layer is byte-identical on both platforms, so any behavioural difference is the Kotlin's fault.

**T3.0 — gradle compiles / module loads (smoke)**
- Setup: `expo prebuild -p android` + `expo run:android` on a machine with the SDK, dev build
  installed on the emulator.
- Steps: launch the app; watch Metro and `adb logcat`.
- Expect: build succeeds; app boots to Setup with no `Cannot find native module 'ExpoSSH'`;
  the `[ssh]` proxy logs appear on first call rather than a red screen.
- Android: [x] — 2026-08-17, `4a0aaa4`. `./gradlew assembleDebug` BUILD SUCCESSFUL in 10s / 726
  tasks; the installed dev client boots straight to Setup with the fields prefilled, no red screen
  and no `Cannot find native module 'ExpoSSH'` in logcat (`ExpoModulesCore: ✅ AppContext was
  initialized`, `ReactNativeJS: Running "main"`). The `[ssh]` proxy trace itself is silent by
  design at this commit — `LOG = false` in `modules/expo-ssh/src/ExpoSSHModule.ts` — so the native
  module's liveness is evidenced by the calls landing instead: `[session] host key …`,
  `[tmux] {"present":true,…}` and a live shell.

**T3.1 — first connect: TOFU fingerprint prompt**
- Setup: host key for `10.0.2.2` not pinned (fresh install, or Forget host key). Emulator's
  public key in the host machine's `authorized_keys`.
- Steps: fill Setup with `10.0.2.2`, port 22, user; Connect.
- Expect: modal shows `ed25519 SHA256:…` matching `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
  on the host — same string iOS shows, no padding `=`. `connect` stays pending until answered.
- Android: [x] — 2026-08-17. Pin cleared via Settings → Forget host key, then Connect: the modal
  reads `ed25519 SHA256:jJLTGz6Twft7miBOgEw53ue4iMHQag+OVz7K1mjaqAM`, byte-identical to
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on this box, no trailing `=`. Log:
  `[session] host key ask SHA256:jJLTGz…` and the state stays `{"status":"connecting"}` until the
  button is pressed. **Finding (look, not behaviour):** the prompt is `Alert.alert`
  (`src/app/terminal.tsx:309`), so Android draws a Material dialog — grey surface, 4dp corners,
  uppercase teal CANCEL/TRUST in Roboto — where iOS draws a UIAlertController. The two cannot be
  pixel-identical while the prompt is RN's native alert; raised per AGENTS.md rather than fixed.

**T3.2 — trust + pin, second connect straight through**
- Setup: T3.1's prompt on screen.
- Steps: tap Trust; wait for the shell; Disconnect; Connect again.
- Expect: first connect lands in a live shell (banner streams in); second connect shows **no
  prompt** — the pinned key is answered before the handshake asks (held-answer path) and the
  terminal appears directly.
- Android: [x] — 2026-08-17. TRUST → `{"status":"connected"}`, fastfetch banner streams into the
  grid. Disconnect, Connect again: no prompt, log goes straight to `[session] host key trust
  SHA256:jJLTGz…` then `{"status":"connected"}` — the held-answer path, `host key ask` never
  fires. Note for the next walker: the handshake has a 30 s timeout, so a TOFU prompt left
  unanswered longer dies with the generic "Could not connect" rather than anything naming the
  timeout (`TransportException: Timeout expired: 30000 MILLISECONDS` in the log).

**T3.3 — mismatch hard-refusal**
- Setup: key pinned (T3.2); host key swapped (`ssh-keygen -f /tmp/newkey …` into sshd config +
  restart, or point Setup at a different machine reusing the pin — easiest: regenerate the host
  key in a throwaway sshd container on 10.0.2.2).
- Steps: Connect.
- Expect: no prompt, no session — the Cannot-connect state with the mismatch sentence.
  `connect` rejected; nothing pinned anew. Only recovery is Forget host key in Settings.
- Android: [x] — 2026-08-17, against a throwaway sshd stood up in the scratchpad on `10.0.2.2:2222`
  with its own host key (`/etc/ssh/sshd_config` untouched). The endpoint already carried a pin from
  an earlier session, so the new key was refused on sight: no prompt, no session,
  `[session] host key mismatch SHA256:27WjhO4BQ6XOPaJXFCdMYwvw19/IFTbWTSrpNvif8LI` then
  `{"status":"failed",…,"mismatch":true}` with the mismatch sentence on the Cannot-connect screen.
  Reconnect repeated the identical mismatch — nothing was pinned anew. Forget host key → Connect
  then produced a fresh TOFU prompt showing the new fingerprint. Observation for T12: the red
  Forget host key button is still ON the mismatch screen as well as in Settings.

**T3.4 — exec `ls`**
- Setup: connected (T3.2).
- Steps: from the tmux probe logs or a harness call, run `exec('ls', …)` — the T5 flow already
  issues `command -v tmux` on connect; check the `[ssh] exec` log pair.
- Expect: resolves with stdout; a failing command (`command -v tmux` on a host without tmux)
  rejects and the probe treats it as absent — same as iOS. Nothing echoes into the PTY grid.
- Android: [x] — 2026-08-17, both halves. Resolve: connecting to this box logs
  `[tmux] {"present":true,…}`, i.e. the connect-time `command -v tmux` exec resolved with stdout.
  Reject: the scratchpad sshd was re-run with a `ForceCommand` that gives exec channels
  `PATH=/nonexistent-bin` (the PTY still gets a normal shell), and the same connect logged
  `[tmux] {"present":false,…}` — the exec rejected and the probe treated tmux as absent. In both
  cases the grid showed only a clean prompt; nothing echoed. The `[ssh] exec` log pair the case
  names is not available at this commit (`LOG = false` in `modules/expo-ssh/src/ExpoSSHModule.ts`),
  so the exec's effect is the evidence.

**T3.5 — shell I/O + resize**
- Setup: connected, terminal on screen.
- Steps: type `echo hello` + Return; run `vim`, rotate the emulator (or toggle the keyboard),
  `:q`.
- Expect: echo and output render; UTF-8 survives chunk splits (paste `é漢字🙂` — no mojibake);
  vim redraws to the new size after rotation — `resize` reached the PTY.
- Android: [x] — 2026-08-17. `echo hello` → `hello`. UTF-8: `cat` of a 48,400-byte file of
  `é漢字🙂` rendered with zero mojibake end to end, so multi-byte characters survive the channel
  reads they certainly split across. Resize: `vim /etc/services` in portrait at
  `[terminal] size 50 × 45`; rotating to landscape logged `size 112 × 15` and vim repainted at the
  new geometry with its ruler (`1,1  Top`) at the far right of the 112-column grid. The keyboard
  is the other resize path and it works too — raising Gboard takes the grid to `50 × 26`, dropping
  it returns `50 × 45`.

**T3.6 — SFTP upload confirmed by listDirectory**
- Setup: connected; a small file reachable via the Files picker.
- Steps: ⋯ → UPLOAD FILE → Files; pick the file; save into `/tmp/port22/` (fresh dir).
- Expect: upload resolves; the destination browser (or a `listDirectory('/tmp/port22')` log)
  shows the file with its exact byte size; `ls -la /tmp/port22` on the host shows the dir mode
  0700. A multi-MB file arrives intact (chunked writes) — `sha256sum` matches.
- Android: [ ]
  - FAILED 2026-08-17: the upload never reaches SFTP. ⋯ → UPLOAD FILE → Files opens the system
    Files activity, which **backgrounds the app**; backgrounding closes the SSH shell
    (`[app] background` → `[session] {"status":"disconnected"}`). When the picker returns, the
    destination sheet calls `exec` to resolve its start directory on the same tick the app goes
    `active`, before the auto-reconnect has finished, and gets
    `[upload] sheet could not resolve a start dir: Call to function 'ExpoSSH.exec' has been
    rejected. → Caused by: java.lang.IllegalStateException: Not connected`. The reconnect succeeds
    ~1 s later but the sheet never retries: it spins forever, shows no error, and `Save here` stays
    disabled with no cwd. Reproduced twice, 3.15 MB and identical either way; nothing was written
    to `/tmp/port22` on the host. This is Android-specific in origin — iOS presents its document
    picker inside the app, so the session is never torn down — but the fix belongs in the sheet:
    resolve the start dir *after* the session reports `connected`, and retry rather than spin.

**T3.7 — disconnect/reconnect lifecycle (§4.9)**
- Setup: connected.
- Steps: background the app ~30s, foreground; then `tmux kill-server`-style hard kill of sshd
  (or toggle the host's Wi-Fi) and foreground again; restore sshd, tap Reconnect.
- Expect: dead socket detected (`isAlive` round trip, not a local flag), auto reconnect
  re-auths with **no TOFU prompt** and opens a fresh PTY; two consecutive failures stop with
  the manual Reconnect screen; Reconnect works once sshd is back. `onShellClose` fired each
  teardown — no zombie pump threads (logcat shows no repeated `expo-ssh-shell` churn).
- Android: [x] — 2026-08-17, against the scratchpad sshd on `10.0.2.2:2222` so it could be killed
  freely. Background 35 s → `[app] background`, `{"status":"disconnected"}`; foreground →
  `{"status":"connecting"}`, `[app] active`, `host key trust SHA256:27Wjh…` (**no TOFU prompt**),
  `{"status":"connected"}` and a fresh PTY (the tmux probe re-ran). Then sshd killed (listener
  *and* its `sshd-session` children — killing only the listener leaves the connection alive and
  fakes a pass): foreground once → auto attempt, `ECONNREFUSED`, plain-English failure; foreground
  again → second auto attempt, same; foreground a third time → **no attempt**, the manual
  Reconnect screen stands. sshd restored, Reconnect → connected. Zombie check: `ps -T` on the app
  pid shows exactly one `expo-ssh-shell` thread while connected and **zero** while disconnected,
  after six connect/disconnect rounds — every teardown ran.

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
- iOS: [x]
- Android: [x] — 2026-08-17. `seq 1 200`, then a slow one-finger pan of 400 device px in 50 px
  steps: seven `[terminal] scroll local 1` lines and the viewport parked at lines 152–196 instead
  of the prompt; the reverse pan gave seven `scroll local -1` and landed back on line 200 with a
  clean, empty prompt — nothing was typed into the PTY. Content tracks the finger in both
  directions (finger down reveals earlier lines).

### T6.2 — `less` scrolls by arrows, both directions
- **Setup**: `less /etc/services` (alt screen, no mouse, no DECCKM).
- **Steps**: pan up (toward earlier lines), then pan down.
- **Expect**: `less` moves line-by-line both ways; log route `arrows`; `less` shows no `ESC O A`
  garbage — bytes are `CSI A`/`CSI B`.
- iOS: [x] — with a correction to the premise: on the test host (`10.42.0.71`, Arch, `less` 600+)
  `less` *does* request application cursor keys, so `[terminal] modes` reads
  `{"altScreen":true,"mouseReporting":false,"decckm":true}` and the app correctly sent
  `ESC O A` / `ESC O B`. Byte form tracking the live DECCKM flag is the real assertion and it
  holds; "less = DECCKM off" is not true of every `less` build.
- Android: [x] — 2026-08-17, with the same premise correction as iOS and on the same host: `less -N
  /etc/services` reports `[terminal] modes {"altScreen":true,"mouseReporting":false,"decckm":true}`,
  so the app correctly sends SS3 rather than CSI. Forward pan → seven `scroll arrows -1`, less
  moved from top line 1 to top line 7; reverse pan → seven `scroll arrows 1`, back to line 1 and
  clamped there. No escape garbage anywhere on screen in either direction. The byte form itself
  cannot be read on Android at this commit (`LOG = false` in
  `modules/expo-ssh/src/ExpoSSHModule.ts` silences `[ssh] send`); that `less` moves line-by-line
  and prints nothing literal is the observable standing in for it.

### T6.3 — `htop` with mouse on: wheel at the finger's cell
- **Setup**: `htop` (requests mouse + SGR).
- **Steps**: pan over the process list; then pan while the finger sits over a different column.
- **Expect**: the list scrolls; log route `wheel`; scrolling acts at the row/column under the
  finger (htop scrolls its list regardless, but tmux panes — if attached — scroll the pane
  under the finger, which is the real assertion once tmux is configured).
- iOS: [x] — SGR wheel-down events carry the finger's own cell (`ESC [<65;28;19M`, `…;29;18M`,
  `…;30;17M`, `…;32;16M` as the finger moved), so the column travels with the touch.
- Android: [x] — 2026-08-17. `htop` (`modes {"altScreen":true,"mouseReporting":true,…}`), pan →
  `[terminal] scroll wheel -1` ×N and the process list scrolls. The column half was taken the way
  the case says is the real assertion, with tmux: attached to a session split into two side-by-side
  panes running `less -N PLAN.md` (left, cols 0–24) and `less -N TESTS.md` (right, cols 26–49), a
  pan at x=250 scrolled **only** the left pane and a pan at x=880 scrolled **only** the right one —
  including while the other was tmux's active pane. The wheel lands at the finger's own cell.
  Harness note: an injected touch that sits still for ~1 s before moving matures into a WebKit
  long-press and the selection pre-empts the pan (`[terminal] selection …`, no `scroll` line), so
  the drag must start moving immediately; that is the harness, not the app (T6.7 wants exactly
  that long-press).

### T6.4 — DECCKM variant: vim vs less
- **Setup**: `vim` on a long file, `:set mouse=` first so no mouse reporting; separately `less`.
- **Steps**: pan in vim; pan in less.
- **Expect**: vim moves the cursor line-by-line (receives `SS3 A/B` — DECCKM on); less moves
  too (receives `CSI A/B` — DECCKM off). Neither shows literal escape garbage.
- iOS: [x] — vim half verified (`ESC O B` under `modes {"altScreen":true,"mouseReporting":false,
  "decckm":true}`, no garbage). The less half is **not producible on this host**: its `less`
  sets DECCKM even under `-X`, so it too gets SS3. The DECCKM-off byte form is asserted by
  T7.7 instead (arrows at a shell prompt, `decckm:false` → `CSI A`).
- Android: [x] — 2026-08-17, vim half verified exactly as iOS: `vim /etc/services` with
  `:set mouse=` gives `modes {"altScreen":true,"mouseReporting":false,"decckm":true}`, the pan
  routes `[terminal] scroll arrows -1` (so SS3 A/B), vim's cursor walked 1 → 43 line by line and no
  literal escape text appeared. The less half is **not producible on this host** for the same
  reason iOS recorded: this `less` sets DECCKM even so (see T6.2's `decckm:true`), so the
  DECCKM-off byte form has to be asserted by T7.7.

### T6.5 — Momentum flick, and a touch stops the coast dead
- **Setup**: plain shell with deep scrollback (`seq 1 2000`).
- **Steps**: flick hard; while it is still coasting, tap the screen once.
- **Expect**: scroll continues after release, decaying smoothly (log `coast start`, then
  `scroll local` lines thinning out); the tap stops it instantly and does nothing else — no
  keyboard raise, no selection, no cursor move.
- iOS: [x] — eye-verified. The DOM component's console stopped reaching Metro partway through the
  T13 walk (last `DOM LOG` line 22:28), so `coast start` and `[terminal] scroll` were not
  available as evidence; the RN-side `[session] modes` and `[ssh] send` bytes were used for
  the rest of T6 instead.
- Android: [x] — 2026-08-17, and here the DOM console *was* reaching Metro, so the coast is in the
  log rather than eye-verified. `seq 1 2000`, hard flick → `[terminal] coast start 3.439 px/ms`
  followed by 68 `scroll local` spends decaying 3 → 2 → 1 and thinning out. Repeat the same flick
  and tap once mid-coast: `[terminal] coast caught 3.144 px/ms carried` and the run collapses from
  68 spends to 4 — and the tap did nothing else, no `[terminal] tap` line (so no keyboard:
  `mInputShown=false` after), no `[terminal] selection`, no cursor move.

### T6.6 — One finger and two fingers are the same pan
- **Setup**: plain shell with scrollback.
- **Steps**: pan with one finger; repeat the same travel with two fingers; add a second finger
  mid-pan; lift one of two mid-pan.
- **Expect**: identical scrolling for the same travel; adding/removing a finger neither jumps
  nor re-triggers; no zoom, no selection.
- iOS: [x] — scrollback parked mid-file after the mixed one/two-finger pans, and zero arrow or wheel
  bytes went to the PTY across the whole run (the local route sends nothing, so the absence is
  the assertion).
- Android: [ ]
  - NOT PROVABLE 2026-08-17: this harness cannot put two fingers on the screen. `adb shell input
    motionevent` is single-pointer (`input --help` lists no multi-pointer form), and raw injection
    does not reach the app either: the emulator's eleven `virtio_input_multi_touch_N` devices
    declare no `INPUT_PROP_DIRECT` and no `BTN_TOUCH`, and protocol-B `sendevent` sequences as root
    (slot / tracking-id / x / y, with and without `BTN_TOUCH` and `ABS_MT_PRESSURE`) produced no
    touch in the app — nor did the emulator console's own `event send`. What one finger can show is
    covered by T6.1 and T6.8; the one-vs-two equivalence, the mid-pan finger add/drop and "no zoom"
    need a real device. Side effect worth knowing before anyone retries this: those `sendevent`
    attempts carry `BTN_STYLUS`, which flips Gboard into stylus-handwriting mode and silently kills
    typing until `settings put secure stylus_handwriting_enabled 0` and a Gboard `pm clear` (both
    were restored afterwards).

### T6.7 — Stationary long-press still selects (T4 regression)
- **Setup**: plain shell, some text on screen, keyboard down (T4's WebKit focus finding).
- **Steps**: long-press a word without moving; then lift and tap once elsewhere.
- **Expect**: selection appears with the system edit menu (Copy · Look Up …), exactly as T4
  verified; the pan layer never claims the touch (no `scroll` log line); the tap clears it.
- iOS: [x] — selection + system edit menu on the stationary long-press: verified. The **tap did not
  clear it**: disabling xterm's textarea and owning touch (T4/§4.3) removes the synthetic-mouse
  path xterm would have collapsed the selection on, and nothing replaced it. Fixed during the
  walk — a one-finger tap that never became a pan now calls `removeAllRanges()` in the touch
  layer's `touchEnd`.
- Android: [ ]
  - FAILED 2026-08-17: selection yes, **edit menu no**. With the keyboard down, a stationary
    long-press over a word logs `[terminal] selection "PlasmaDesktop"` and draws the highlight with
    both teal drag handles, and no `[terminal] scroll` line appears — the pan layer correctly never
    claims the touch. But no floating edit menu is drawn: no Copy, no Select all, nothing. Checked
    three ways — the native-resolution crop shows only handles; `uiautomator` finds no `Copy` node;
    `dumpsys window windows` during a live selection lists two `PopupWindow:` entries (the two
    handles) and no toolbar. Reproduced from two different injection paths (`input motionevent`
    hold and `input swipe x y x y 1200`). So on Android the user can select text and then cannot do
    anything with it, where iOS gets Copy · Look Up. The tap half is fine: a one-finger tap
    elsewhere clears the selection, i.e. the `removeAllRanges()` fix from the iOS walk works here
    too. Likely cause to start from: the DOM component never installs an ActionMode callback, and
    Chromium WebView will not raise its own floating toolbar for a selection made on a `body` that
    is not editable and whose host view has no action-mode support wired up.

### T6.8 — Notch granularity is one line per cell height
- **Setup**: `less /etc/services` with line numbers (`less -N`) so movement is countable.
- **Steps**: pan exactly ~5 cell heights (about 5 rows of text) slowly.
- **Expect**: the view moves ~5 lines, not 1 and not 20; a sub-cell wiggle moves nothing but a
  following pan picks up the carried remainder (no dead zone at slow speeds).
- iOS: [x] — `less -N` went from top line 1 to top line 6 across a run of six down-arrows: one notch,
  one line. Up-pans against the top of the file clamp in `less` and leave nothing on screen.
- Android: [x] — 2026-08-17. One cell is 45 device px here (17.13 CSS px × the 2.63 webview scale)
  and the slop is 8 CSS px ≈ 21 device px, so a 250 px pan is exactly slop + five cells: it
  produced **five** `scroll arrows -1` and `less -N /etc/services` went from top line 1 to top line
  5 — not 1, not 20. Sub-cell behaviour checked inside one gesture: three 10 px steps (30 px, under
  a cell once the slop is paid) spent **zero** notches, and continuing the same slow 10 px steps to
  100 px total fired the notch on schedule — the remainder carries, no dead zone at slow speeds.

### T6.9 — Mode signal fires on entering and leaving vim
- **Setup**: Metro log visible; plain shell.
- **Steps**: run `vim`, wait for the screen; quit with `:q!`; run `htop`; quit with `q`.
- **Expect**: on vim entry a `[session] modes {"altScreen":true,…,"decckm":true}` line (and its
  `[terminal]` twin from the DOM side); on exit both flags return false; htop entry/exit flips
  `mouseReporting` true/false. One line per change, not one per keystroke.
- iOS: [x] — both edges fire, one line per change: vim entry
  `{"altScreen":true,"mouseReporting":true,"decckm":false}` then `…"decckm":true`, exit
  `{"altScreen":false,"mouseReporting":false,"decckm":false}`; htop flips `mouseReporting`
  the same way. The `[terminal]` twin was only present while the DOM console still reached
  Metro (see T6.5).
- Android: [x] — 2026-08-17, all four edges, each with both the `[terminal]` DOM line and its
  `[session]` twin, one pair per change and none per keystroke. vim entry
  `{"altScreen":true,"mouseReporting":true,"decckm":false,…}` then `…"decckm":true`; `:q!` →
  `{"altScreen":false,"mouseReporting":false,"decckm":false,…}`; htop entry
  `{"altScreen":true,"mouseReporting":false,…}` then `…"mouseReporting":true,"decckm":true`; `q` →
  both flags back to false. The two-line settle per transition matches what iOS recorded.

### T6.10 — `git log`'s pager takes the wheel, not tmux's history
- **Setup**: attached to tmux, in a repo with enough history to scroll. Run `git log`.
- **Steps**: pan up and down over the output; then `q`, run `less CLAUDE.md` and pan the same
  way; then `man ssh`.
- **Expect**: all three scroll the pager itself. `git log` is the case the root-table wheel
  binding (`generateConf`, `src/tmux-model.ts`) does not cover yet: git runs `less` with
  `LESS=FRX`, and `-X` keeps it off the alternate screen, so `#{alternate_on}` is false and the
  notch falls through to `copy-mode -e` — the pane scrolls into tmux's own history and takes the
  log off screen (BUGS.md §4, cause suspected, not yet confirmed on device). **Before fixing
  anything, read `#{alternate_on}` and `#{pane_current_command}` in a pane sitting in `git log`
  and record both here** — that is the measurement the fix is waiting on. `less` and `man` take
  the second case and already work; this case fails until the condition widens to match a pager
  by name.
- iOS: [ ]
- Android: [x] — 2026-08-17, and the premise above is stale: the condition **has** been widened
  (`src/tmux-model.ts`, `generateConf`, the `#{m/r:^(git|less)$,#{pane_current_command}}` arm) and
  it works. The measurement the case was waiting on, taken on a pane sitting in `git log` while the
  phone was attached: **`alternate_on=0`, `pane_current_command=git`** (also `pane_in_mode=0`,
  `mouse_any_flag=0`) — the alternate-screen test alone would indeed have missed it; the name arm
  is what catches it. All three pagers then scrolled themselves, `pane_in_mode` staying `0`
  throughout so nothing fell into tmux copy mode: `git log` moved forward over the commit body and
  back to the `commit 4a0aaa4…` header (route `wheel`); `less TESTS.md` (`alternate_on=1`,
  `cmd=less`) scrolled; `man ssh` (`alternate_on=1`, `cmd=man`) scrolled from the NAME header to
  SYNOPSIS. Walked against a throwaway `t13walk` session, not the user's. Note: `less CLAUDE.md` as
  literally written is a one-line file and cannot move — use a long file to see anything.

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
- iOS: [x] — one `^C` (0x03) on the wire, `sleep 100` died at 7s, prompt back; the screenshot has
  Ctrl untinted and the strip gone.
- Android: [x] — 2026-08-17, Pixel 7 AVD, plain shell on 10.0.2.2. Ctrl tinted accent and the
  chord strip rose (grid `50 × 45` → `50 × 40`); the `C · interrupt` cap echoed `^C`, `sleep 100`
  died (fish printed its `1m 10s` duration badge) and the prompt came back; the crop after the tap
  has Ctrl untinted and the strip gone (`50 × 40` → `50 × 45`). `LOG = false` at this commit, so
  there is no `[ssh]` byte trace — the byte is judged on its effect.

### T7.2 — Ctrl double-tap locks and sends repeated chords
- **Setup**: shell prompt with a longish command typed (do the typing *before* locking —
  while locked, every letter chords).
- **Steps**: double-tap Ctrl (<300ms apart) — accentA tint + halo; type `a`, then `e`; tap
  the `C` cap twice; tap Ctrl once.
- **Expect**: while locked every letter chords (`^A`/`^E` jump to start/end of the line) and
  the strip stays up through repeated caps (`^C` twice = two fresh prompts); the single tap
  unlocks (tint + strip gone) and letters type normally again.
- iOS: [x] — locked, the typed `a` and `e` went out as `^A` and `^E`, and the strip stayed up across
  both (terminal held `52 × 22`, returning to `52 × 26` only on the unlock tap); two `^C` in a
  row earlier held the lock the same way.
- Android: [x] — the double-tap locked: the pill turned accentA pink with a halo (armed is blue),
  a typed `a` and then `e` chorded as `^A`/`^E` (caret jumped to the leading `e` of
  `echo abcdefghij`, then back past the final `j`), the strip stayed up across two `C` caps, and one
  more tap unlocked it — tint and strip gone, grid back to `50 × 26`, and `ae` then typed as letters.
  - NOTE 2026-08-17: one double-tap in roughly ten produced *armed*, not *locked* — blue pill, and the
    strip closed after the first chord. `onCtrlTap` (`src/keybar.tsx:469`) reads `ctrl` out of the
    render closure, so two taps inside one React commit both compute from `off`. Not reproduced in the
    run recorded above; worth a functional `setCtrl` if it is ever seen on hardware.

### T7.3 — All five strip caps are observable
- **Setup**: shell prompt with some history; then `sleep 100` for Z.
- **Steps**: arm Ctrl before each: `R` → reverse-i-search prompt appears (Esc leaves it);
  `L` → screen clears to one prompt line; with `sleep 100` running, `Z` → `[1]+ Stopped`;
  `C` at an empty prompt → `^C` + fresh prompt; `D` at an empty prompt of a nested shell
  (`bash` first) → the nested shell exits (§7: instant, no confirmation).
- **Expect**: each cap sends its byte once and disarms; captions read interrupt · suspend ·
  history · clear · EOF.
- iOS: [x] — all five seen on the wire, one byte per tap: `^C`, `^Z` (`fish: Job 1, 'sleep 100' has
  stopped`), `^R`, `^L` (screen cleared to one prompt line, cursor report `12;3` → `2;3`),
  `^D` (nested `bash` exited). Each disarmed after its chord — the terminal goes `52 × 22`
  while the strip is up and back to `52 × 26` after, which is the disarm visible in the log.
- Android: [x] — all five observed, each disarming after its own chord (grid `50 × 40` → `50 × 45`
  every time): `R` opened fish's `search:` pager and Esc left it; `L` cleared the screen to one prompt
  line; `Z` printed `^Zfish: Job 1, 'sleep 100' has stopped`; `D` exited a nested `bash` instantly
  (`exit` echoed, no confirmation). Captions read interrupt · suspend · history · clear · EOF. `C` is
  T7.1's evidence — at an *empty* fish prompt ^C repaints the same prompt and shows nothing, so this
  case's "^C + fresh prompt" is a bash-ism rather than an Android failure.

### T7.4 — Esc leaves vim insert mode
- **Setup**: `vim`, press `i`, type a word.
- **Steps**: tap Esc, then type `:q!` + Return (keyboard).
- **Expect**: `-- INSERT --` vanishes on the Esc tap; the `:q!` reaches the command line —
  proof the byte was ESC (0x1b), not text.
- iOS: [x] — `^[` on the wire while vim held the alt screen, and vim then exited on `:q!`, which
  only happens if the byte was a real 0x1b.
- Android: [x] — `-- INSERT --` vanished on the Esc tap and vim's ruler went `1,6` → `1,5`, the
  one-cell left shift Esc makes leaving insert mode; `:q!` + Return then quit vim back to the shell,
  which only happens if the byte was a real 0x1b.

### T7.5 — Tab completes in the shell
- **Setup**: shell prompt, type `ls /et`.
- **Steps**: tap Tab.
- **Expect**: completes to `/etc/` (0x09 went down the PTY).
- iOS: [x] — `ls /et` + Tab left `ls /etc/` on the prompt, fish's ghost suggestion trailing it.
- Android: [x] — `ls /et` plus one Tab tap left `ls /etc/` on the prompt, fish's ghost
  `modprobe.d/` trailing it. (An earlier attempt needed a second tap; the clean repeat completed on
  the first, so that was tap injection, not the key.)

### T7.6 — Paste types the pasteboard
- **Setup**: copy a string on the phone (e.g. from Notes): `echo pasted-ok`.
- **Steps**: tap Paste at a prompt. Then long-press Paste (~420ms).
- **Expect**: the text is *typed* at the prompt, no Return of ours (never executes, §4.4);
  long-press does nothing yet — TODO(T8) clipboard popover.
- iOS: [x] — `echo pasted-ok` landed on the prompt unexecuted, cursor after it. (The long-press half
  is no longer a no-op: T8 shipped the popover, so it is covered by T8.5.)
- Android: [x] — the pasteboard was seeded from the Android Settings search field (typed
  `echo pasted-ok`, select-all, `KEYCODE_COPY`); the Paste tap typed it at the prompt unexecuted with
  the cursor after the `k`, no Return of ours. Long-press is T8's popover now — same as the iOS note,
  covered by T8.5.

### T7.7 — Arrows navigate in vim (DECCKM) and walk history at a prompt
- **Setup**: `vim` on a multi-line file; separately a shell with history.
- **Steps**: open the arrows popover (button tints accent), tap ↑ ↓ ← → in vim; quit; at the
  prompt tap ↑ then ↓.
- **Expect** (verified — `^[[C` at the prompt with `"decckm":false`, then `^[OB`, `^[OC`, `^[OD`
  inside vim with `"decckm":true`; same button, form following the live flag):
  vim's cursor moves cell by cell (SS3 — DECCKM on, watch `[session] modes`
  say `"decckm":true`); at the prompt ↑/↓ walk shell history (CSI — DECCKM off). Popover
  stays open across taps; outside tap or the button closes it.
- iOS: [x] — see the byte evidence folded into **Expect** above; the popover stayed open across the
  whole run of taps.
- Android: [x] — in `vim /etc/services` with `[session] modes … "decckm":true`, the four arrows each
  moved one cell or row (cursor `46/udp` `p` → `46/tcp` `p` → back → `d` → `p`, ruler home at `43,25`),
  and the popover stayed open across all four taps. It closed both ways: its own button, and a tap
  outside it. At the prompt with `"decckm":false`, ↑ recalled `vim /etc/services` and ↓ cleared the
  line again.

### T7.8 — Home/End at a prompt
- **Setup**: shell prompt, type a long command, caret at the end.
- **Steps**: arrows popover → Home, then End.
- **Expect**: caret jumps to line start, then line end (CSI H / CSI F; shells map both).
- iOS: [x] — `^[[H` then `^[[F` on the wire.
- Android: [x] — with `echo this-is-a-long-command-line` typed and the caret at the end, Home put it
  on the leading `e` and End put it back past the final `e`.

### T7.9 — Bar swipe ↓ hides the keyboard, ↑ shows it
- **Setup**: keyboard up (it rises on connect).
- **Steps**: swipe down anywhere on the bar; then swipe up on it; then swipe up again with
  the keyboard already up.
- **Expect**: keyboard slides away (bar stays, docked at the bottom, terminal grows —
  `[terminal] size` logs a taller grid); swipe up raises it again; the second ↑ is a no-op
  for now — TODO(T10) switcher drag.
- iOS: [x] — the grid logged `52 × 26` → `52 × 41` on the ↓ swipe and back to `52 × 26` on the ↑,
  with no bytes on the wire between them. (The "second ↑ is a no-op" line is stale: T10
  shipped, so that gesture is the switcher drag now — T10.2.)
- Android: [ ]
  - FAILED 2026-08-17: the ↓ half passes and the ↑ half does nothing at all. Down: a swipe anywhere on
    the bar puts Gboard away, the bar stays docked at the bottom and the grid grows `50 × 26` →
    `50 × 45`. Up: three attempts — `input swipe` at 250ms and at 400ms, and a seven-step
    `input motionevent` drag — all left `mInputShown=false`, the grid at `50 × 45`, no `[terminal]
    size` and no switcher. This is **not** an Android divergence: it is shared TS with no `Platform`
    branch. `src/keybar.tsx:548` makes the pan's only keyboard action `Keyboard.dismiss()`;
    `barDismisses` (`src/keybar-model.ts:210`) is the sole vertical exit that touches the keyboard, and
    the upward branch (`ty <= -KEYS_DROP_DY`) also only dismisses, for T10's switcher drag. Nothing in
    the pan raises `focusSignal`, so the keyboard now returns only on a terminal tap, on the switcher
    closing, or from a ribbon cap. The iOS tick above is stale by the same argument.
  - Walk this one from a FRESH LAUNCH — a prior long-press selection silently kills the bar's pan; see
    the finding recorded under T7.13.

### T7.10 — Keys never fire during a bar swipe
- **Setup**: shell prompt, keyboard up.
- **Steps**: start the ↓ swipe with the finger ON the Esc key; likewise across Ctrl/Tab.
- **Expect**: keyboard hides, but no key fires (nothing at the prompt, Ctrl not armed) —
  the pan activating cancels the press. The press-in dim may flash; the send must not
  happen.
- iOS: [x] — swipes started on Esc/Ctrl fired no key: nothing on the wire across six swipe pairs
  (each visible as the grid flipping `52 × 26` ↔ `52 × 41`), while deliberate presses of the
  same keys sent normally. The press-in dim does flash during the swipe, which the case allows.
- Android: [x] — three ↓ swipes started with the finger on Esc, on Ctrl and on Tab: each hid Gboard
  and fired no key. The prompt stayed empty in all three (a stray Tab at an empty fish prompt would
  have opened the completion pager) and the bar crops show Ctrl untinted with no chord strip.

### T7.11 — Press feedback: dim/shrink + haptic on touch, not on echo
- **Setup**: any key; airplane-mode-slow or `sleep`-blocked session is the interesting case.
- **Steps**: press and hold a key; watch and feel.
- **Expect**: the key dims and shrinks while touched and the light haptic fires on the
  *touch*, immediately — even when the session is slow to echo (§4.4: on touch, not echo).
- iOS: [ ]
- Android: [x] — held Esc measured against its own rest state at native resolution: the label shrinks
  (ink bbox 60 × 20 px → 57 × 19) and dims (peak luminance 205 → 140) while touched. The haptic is
  real on this AVD and readable: `dumpsys vibrator_manager` appends a 52 ms `usage: TOUCH` effect for
  `com.kamilpostrozny.port22` on every key tap, and with the session blocked by `sleep 60` an Esc tap
  logged its effect 24 ms after the tap — so it is not gated on the host's echo. One nuance the Expect
  predates: the haptic fires on the **completed tap**, not on touch-down (`src/keybar.tsx:269-273`,
  deliberate, user 2026-08-11, so a bar swipe passing over a key does not buzz). "On touch, not echo"
  still holds. The buzz itself is hardware-only.

### T7.12 — Two-finger tap opens Settings; two-finger pan still scrolls
- **Setup**: shell with scrollback (`seq 1 200`).
- **Steps**: tap the grid once with two fingers (quick, no movement); then two-finger *pan*.
- **Expect**: the tap opens the Settings stub (T12 alert; `[terminal] two-finger tap` in the
  log) and does not scroll; the pan scrolls exactly as in T6.6 and opens nothing.
- iOS: [x] — `[terminal] two-finger tap` then `[settings] sheet open` (the T12 sheet now, not the
  stub alert). The two-finger pan scrolling and opening nothing is T6.6's evidence.
- Android: [ ]
  - NOT PROVABLE 2026-08-17: two-finger input cannot be injected on this AVD — the
    `virtio_input_multi_touch_N` devices declare no `INPUT_PROP_DIRECT`/`BTN_TOUCH`, and protocol-B
    `sendevent` as root and the emulator console's `event send` both produce nothing. Both halves of
    this case (the tap and the pan) need two fingers.

### T7.13 — Native input owns the keyboard; selection works with it up (the T4 fix)
- **Setup**: fresh connect (keyboard rises on its own), text on screen.
- **Steps**: type a command — watch it echo; touch the terminal once — keyboard should
  hide; swipe the bar ↑ to bring it back; with the keyboard UP, long-press a word.
- **Expect**: typing reaches the PTY through the native input (webview never focused — no
  webview keyboard flicker); touching the terminal dismisses the keyboard (native default,
  unfought); the long-press selects with the system edit menu even while the keyboard is up
  — the architecture T4 measured for. Backspace and held-delete: single deletes work;
  auto-repeat on hold is TODO(T12).
- iOS: [ ] **partial — one half fails.** Keyboard **down**: selects correctly, edit menu and all.
  Typing echoes through the native input all session, no webview keyboard ever appears, and a
  tap dismisses the keyboard as intended. Keyboard **up**: the long-press *does* select
  (`[terminal] selection "Mem"` at the keyboard-up geometry `52 × 26`) — but the touch blurs the
  native input, the keyboard drops, and the refit to `52 × 41` reflows the grid under the
  selection, which then moves or vanishes. The log pairs them every time: `selection "Disk"`
  immediately followed by `size 52 × 41`. Fix chosen (user, during the walk): take the upgrade
  path §252 already names — xterm's own selection via `term.select`/`getSelectionPosition` with
  a Copy control on the bar, so no WebKit gesture is involved. Re-run this case after that
  lands.
- Android: [ ]
  - FAILED 2026-08-17: three halves pass and one does not — and it is a *different* half from the iOS
    failure. **Passing.** The keyboard is owned by the native input: `dumpsys input_method` reports
    `mServedView=com.facebook.react.views.textinput.ReactEditText` and typing echoes through it
    (`echo hello-native`), with no webview IME at any point. A tap on the terminal dismisses the
    keyboard (`50 × 26` → `50 × 45`) and another raises it. And the keyboard-up long-press selects
    **without the iOS side effect**: `[terminal] selection "native"` and later `selection "Disk"`, each
    with `mInputShown=true` and no `size` line behind it — the keyboard does not drop and the grid does
    not reflow under the selection. **Failing: no system edit menu ever appears.** The selection draws
    its two handles (they are the only two `PopupWindow`s in `dumpsys window windows`) and they drag
    correctly, but there is no floating Copy / Select-all toolbar — looked for immediately, 3 s later,
    and again after nudging a handle, in both the `uiautomator` dump and the screenshots. Without it a
    selection cannot be copied on Android. Also: the case's "swipe the bar ↑ to bring it back" step is
    unusable (T7.9), so a terminal tap was used instead.
  - FOUND WHILE WALKING, separate bug, 2026-08-17: **a long-press selection kills the key bar's pan
    until the app is relaunched.** Fresh launch — a ↓ swipe on the bar hides Gboard (`mInputShown`
    false, grid `50 × 26` → `50 × 45`). Long-press any word in the terminal, and the identical swipe
    then does nothing: no `[terminal] size`, `mInputShown` stays true. Taps on the bar keep working
    (Ctrl still arms and the strip still rises), so it is the pan alone. Clearing the selection does
    not restore it — only `am force-stop` plus a relaunch does. Reproduced twice. The suspect is the
    WebKit selection path in `src/terminal.tsx` (its own note at :1050, "once WebKit has begun a
    selection, the moves are its drag handles, not a pan") leaving the touch stream claimed. This is
    what made T7A.4/T7A.5 look broken mid-run until they were re-walked from a fresh launch.

## T7A — Key bar on Android (emulator)

All cases on the Android **emulator** (gated on T3.0's build), connected to the host machine's
sshd at `10.0.2.2` unless said otherwise. Same key set, same model, so T7's byte-level cases are
not repeated here.

**This section was written as "the Android skin" and that premise is dead (2026-08-16 — AGENTS.md,
"One app, two platforms").** There is no Material surface and no separate Android metric set: the
bar has to look like the iOS bar.

**The debt is now paid (b427712).** `src/style.ts` has no `Platform` import and no `ANDROID ?`
arms; `Glass` is gone entirely, renamed `Plate`, with no platform branch inside it. So the cases
below are no longer "inverted, pending a fix" — they state what the code already does, and they
are verification, not a to-do list. What genuinely stays here is Gboard docking, which is a real
system difference.

Haptics may be inert on the emulator — feel them on hardware, only observe no crash here.

### T7A.1 — The bar stack matches iOS: opaque plates, no blur on EITHER platform
- **Setup**: connected, keyboard up, dark flavour (Mocha). An iOS screenshot of the same screen,
  same flavour, keyboard up — **ask the user for it**; do not judge this case without it.
- **Steps**: look at the ⋯ circle, the pill, the tabs circle; tap Ctrl (chord strip), the
  arrows button (popover), long-press Paste (clipboard popover), ⋯ (menu). Crop each control at
  native resolution and compare it to the same control in the iOS shot.
- **Expect**: each surface is the *same* surface iOS draws: an opaque `theme.surface` plate, a
  0.5pt hairline at `foreground` 12%, the caller's corner radius, and no shadow.
- **This case has been wrong twice, in opposite directions — read the history before judging it.**
  It first demanded Material ("opaque `surface0`, no blur") off a deleted Android design file. On
  2026-08-16 it was inverted to demand iOS's blur ("same translucency, same specular border").
  **That is also void.** A backdrop blur is not one design: iOS samples the window for free, while
  Android's Dimezis backend re-draws a nominated subtree into an offscreen canvas every frame,
  needs a `blurTarget` + `blurMethod` this app never passed, forks three ways at API 31
  (`ExpoBlurView.kt:70,103,133`), and silently paints a near-black film with no target
  (`BlurView.js:54`) — which is what Android was really drawing all along. So blur was removed
  from BOTH platforms and `expo-blur` uninstalled; `src/ribbon.tsx` had already reached the same
  answer for its own contrast reasons. **The iOS build changed here too** — if the iOS shot still
  shows blur, it is the stale build, not the reference.
- Android: [x] — 2026-08-16, iPhone (device) vs Pixel 7 AVD (API 36), both Mocha, both at
  b427712+. Opaque plates on both, no blur either side, `Glass` now `Plate`. Run widths along the
  bar agree: iOS `18.7 / 1.0 / 1.0 / 18.7 / 60.3 … 48.3`, Android `18.7 / 0.8 / 0.8 / 19.4 /
  60.2 … 49.1` — the first four are the ⋯ circle with its three dots interrupting the scan, i.e.
  the same glyph in the same place. All three bar glyphs (`\uF141` ellipsis, `\uF047` arrows,
  `\uF24D` tabs) render from the bundled face on both; `nerd-glyph=7.8000` in the terminal log
  equals the mono cell advance on both, so none fell through to a system face. The only visible
  difference in the side-by-side was the tabs glyph dimmer on Android — correct disabled state,
  that session was a plain shell.

### T7A.2 — Metrics are the iOS metrics
- **Setup**: bar on screen, keyboard up. An iOS screenshot of the same state — **ask the user**.
- **Steps**: screenshot both, crop the bar at native resolution, measure corner radius, key
  radius, side margin and bar height against the iOS shot.
- **Expect**: every number is the iOS number — 18pt key radius, 24pt side margins, 24.5pt bar
  radius, capsule circles. The old Expect here ("16pt corners, visibly squarer than iOS
  capsules, 8pt side margins, docked not floating") came from the deleted Android prototype and
  was exactly the divergence to remove; the `ANDROID ?` arms in `src/style.ts` are deleted and
  the file no longer imports `Platform`.
- Android: [x] — 2026-08-16, measured off native-res PNGs (iOS 3.0x, Android 2.625x):

  | | iOS | Android | old Android |
  |---|---|---|---|
  | plate height | 48.3 | 48.8 | 49 |
  | left margin | 24.3 | 24.0 | 8 |
  | right margin | 24.3 | 24.0 | 8 |
  | gap circle→pill | — | 7.2 | 7 |
  | tabs circle radius | — | 24.4 (arc fit r=64px) | 16 |
  | ⋯ popover radius | ~26 (arc fit) | ~26 | 16, clamped to 20 |
  | ⋯ popover margin | 24.3 | 24.0 | 8 |

  The side margin moving 8 → 24 is the clearest single proof the `style.ts` deletions reached the
  Android build. `Glass`'s silent `Math.min(radius, 20)` clamp is gone too, so passed corners are
  no longer overridden.

### T7A.2a — OPEN FINDING: Android font scale distorts the terminal and overflows the bar
- **Not caused by the parity work; found while verifying it (2026-08-16), unfixed.**
- **Steps**: `adb shell settings put system font_scale 1.5`, relaunch, connect, look at the grid
  and the bar. Reset with `1.0`.
- **Observed**: the terminal cell scaled in WIDTH by exactly 1.5 (7.7964 → 11.6964) while the row
  height stayed 17.14 and the column count stayed 50 — so 50 x 11.7 = 585dp of grid on a 411dp
  screen. Text runs off the right edge and rows collide vertically. Separately the key bar held
  its 48.8dp plate correctly, but the labels scaled inside their fixed-width keys until "Paste"
  collided with the arrows glyph.
- **Why it is a divergence**: Android's WebView applies the system font scale to CSS text; iOS's
  WKWebView does not apply Dynamic Type to CSS px. Same code, different result. Android also
  stacks a *display size* multiplier on top of font scale, so it reaches extreme values sooner.
- **Where the guard already is**: only 5 of ~70 `Text` nodes cap the multiplier
  (`maxFontSizeMultiplier={1.3}`, all in `src/ribbon.tsx`).
- **Attempted 2026-08-16, one route ruled OUT by measurement.** `-webkit-text-size-adjust: 100%`
  plus `text-size-adjust: 100%` on `html` changes nothing: with both set, Android at font_scale
  1.5 still reported `cell 11.6964 x 17.14` where 1.0 gives `7.7964`. That property governs font
  BOOSTING (text autosizing in wide layouts), which is a different mechanism from the WebView's
  textZoom. Reverted; the finding is recorded in the CSS block in `src/terminal.tsx` so nobody
  spends the afternoon on it twice.
- **The documented lever is `WebSettings.setTextZoom(100)`, and it is not reachable from here.**
  `@expo/dom-webview`'s prop list (`DomWebView.types.d.ts`) has no `textZoom`; the app does not use
  `react-native-webview` (optional dep, not installed), so the `DOMProps extends RNWebViewProps`
  type is misleading — the props that actually arrive are the Expo webview's.
- **Route still open, and its arithmetic is now CONFIRMED on Android**: divide the size we ask for
  by the scale being applied, i.e. pass `PixelRatio.getFontScale()` into the DOM component and set
  the xterm `fontSize` to `settings.fontSize / fontScale`. Probed on device 2026-08-16 —

  | `font_scale` | `getFontScale()` | measured cell |
  |---|---|---|
  | 1.0 | 1 | 7.7964 |
  | 1.5 | 1.5 | 11.6964 |

  the factor RN reports is exactly the factor the WebView applies, so the division cancels it
  rather than approximating it. `getFontScale()` reflects the user's text-size preference on BOTH
  platforms (`PixelRatio.js:95-100`).
- **iOS ANSWERED 2026-08-16: WKWebView does NOT scale CSS px with Dynamic Type.** Text Size turned
  up on the device, reconnected, and the terminal reported `dpr=3 cell=7.8000` /
  `cell 7.7999 x 18.00` — identical to the default-size run. RN `Text` around it DID scale (the
  Setup caption went from one line to two), so the CHROME scaling is shared behaviour on both
  platforms and is not a divergence; only the terminal is. The correction is therefore Android-only,
  category (3).
- **The one-line division was written, measured, and REVERTED. It does not work.** Setting the
  xterm font size to `fontSize / fontScale` on Android gave, at font_scale 1.5:

  ```
  font line:  size=8.6667  cell=5.1938        <- canvas measureText, NOT scaled
  size line:  cell 7.7964 x 12.19             <- DOM render, IS scaled
  cols:       76   (should be ~50)            <- laid out on the unscaled advance
  ```

  The glyph WIDTH comes out right (7.7964, was 11.6964) and everything else breaks. Android's
  WebView scales RENDERED TEXT but not CANVAS METRICS and not LAYOUT, so dividing the font size
  desynchronises three things that must agree: the canvas measurement `monoArrived()` uses to
  prove the face loaded, the row height xterm derives from the size we set (17.14 -> 12.19, rows
  would collide), and the column count xterm computes from its own advance (50 -> 76).
- **Do not "fix" this with a compensating `lineHeight`.** It patches the row height to 12.19 x 1.5
  = 18.29 against the correct 17.14 — 6.7% out, and the error moves with the scale. The column
  count and the canvas path stay wrong regardless.
- **Where it actually stands**: the only clean lever remains `WebSettings.setTextZoom(100)`, which
  `@expo/dom-webview` does not expose. Closing this properly means getting that prop upstream (or
  a config-plugin patch of the Android view), not more arithmetic on our side. Everything else has
  now been tried and measured.
- Android: [ ]
  - FAILED 2026-08-17: the divergence is unchanged at this commit. `settings put system font_scale 1.5`,
    relaunch, connect → `[terminal] size 50 × 44 cell 11.6964 × 17.14`, against `7.7964 × 17.13` at
    1.0. The cell scales in WIDTH by exactly 1.5 while the row height and the column count do not, so
    50 × 11.70 = 585dp of grid sits on a 411dp screen: the screenshot has the fastfetch banner and every
    prompt line running off the right edge and rows clipping each other vertically, and in the key bar
    "Paste" overlaps the arrows glyph. `settings put system font_scale 1.0` restored `cell 7.7964`.

### T7A.3 — Icons render via text fallback (no blank keys)
- **Setup**: connected, tmux configured (so the tabs circle shows).
- **Steps**: look at ⋯ (circle), the arrows button, the tabs circle, and the pin marks in
  the clipboard popover.
- **Expect**: `⋯`, `✛`, `▣`+badge, `●`/`○` all visible — SF Symbols don't exist here, so
  the `fallback` text glyphs must carry every icon. No empty circle, no invisible pin.
- Android: [x] — 2026-08-17, every icon cropped at native resolution: ⋯ renders as three filled dots
  (`\uF141`), the arrows button as the four-way glyph (`\uF047`), the tabs circle as the two offset
  squares (`\uF24D`) — greyed in plain shell, full strength once attached to tmux — and the clipboard
  row's pin mark as a solid pushpin. Nothing blank, nothing tofu, everything from the bundled face.
  Two parts of the Expect are stale rather than failing: the literal `⋯` / `✛` / `▣` / `●` / `○`
  fallbacks were replaced by Nerd Font codepoints on 2026-08-16, and there is **no badge on the tabs
  circle at this commit** — `src/keybar.tsx:797-815` renders the glyph alone and `grep -rn badge
  src/**/*.tsx` finds none. Checked attached to tmux with one window and with two; no badge either way.

### T7A.4 — Bar rides Gboard: docking up/down + terminal resize
- **Setup**: connected (keyboard rises on connect).
- **Steps**: watch the bar as Gboard animates up; dismiss it (bar swipe ↓); watch the Metro
  log for `[terminal] size`.
- **Expect**: keyboard up → the bar sits directly on top of Gboard, no gap and no
  double-height dead strip (the old `height` KAV would have subtracted the keyboard twice);
  keyboard down → the bar drops to the gesture-pill area. Each transition logs a new
  `[terminal] size` — the window resize is what fires §4.2's debounced resize.
- Android: [x] — measured off native-resolution frames. Keyboard up: the bar plate spans y 1373–1500
  (128px = 48.8dp) and Gboard's top edge is at y 1517, so the gap is 16px = 6.1dp — the bar's own
  bottom padding, not a doubled keyboard inset. Keyboard down: the plate spans 2193–2320 with the
  gesture pill at 2364–2373, i.e. it drops to the pill area. Every transition logged a fresh
  `[terminal] size` (`50 × 26` ↔ `50 × 45`).

### T7A.5 — Bar swipe ↓/↑ hides and shows Gboard
- **Setup**: keyboard up.
- **Steps**: swipe down on the bar; swipe up on it.
- **Expect**: Gboard slides away and the terminal grows (taller grid in the log); the ↑
  swipe raises it again — same behaviour as T7.9, now via the Android window resize.
- Android: [ ]
  - FAILED 2026-08-17: the same split as T7.9, and the same cause. ↓ on the bar puts Gboard away and
    the grid grows `50 × 26` → `50 × 45`; ↑ does nothing — no keyboard, no `[terminal] size` — tried
    with `input swipe` at 250/300/400ms and with a stepped `input motionevent` drag. The bar's pan only
    ever calls `Keyboard.dismiss()` (`src/keybar.tsx:548`); nothing on the bar raises the keyboard.
  - Walk this from a FRESH LAUNCH: a prior long-press selection kills the pan (see T7.13's finding),
    which makes even the ↓ half look broken.

### T7A.6 — Chord strip + arrows + clipboard popovers: flush and functional
- **Setup**: shell prompt; some text copied on the emulator for the pasteboard row.
- **Steps**: tap Ctrl then the `C` cap; open the arrows popover, tap ↑; long-press Paste,
  tap a clipboard row.
- **Expect**: each renders as an opaque plate (T7A.1) and works: `^C` on the wire, history
  walks on ↑, the row's text is typed unexecuted. Captions and headers (chord captions,
  CLIPBOARD, UPLOAD FILE) render in **Inter**, bundled — NOT Roboto, and not the system default.
  Chrome text used to set no `fontFamily` at all, which drew SF Pro on iOS and Roboto on Android:
  divergence by omission, and the one case that could not be closed by taking the iOS value, since
  SF Pro cannot be shipped to Android. Both platforms moved to Inter (b427712). Weight comes from
  the family name (`Inter-Medium`/`-SemiBold`/`-Bold`), never `fontWeight` — a numeric weight
  beside a one-face custom family fake-bolds on Android and no-ops on iOS. Key glyphs stay
  JetBrains Mono.
- Android: [x] — all three popovers render as opaque plates with a hairline and no shadow, and all
  three work: Ctrl then the `C` cap killed `sleep 60` with `^C` echoed; the arrows popover's ↑ recalled
  `sleep 60` from history; a ~900ms press on Paste opened the clipboard popover
  (`[clipboard] 0 slots, 0 pinned`, header CLIPBOARD, one row `echo pasted-ok` /
  `phone pasteboard · just now` with its pin), and tapping the row typed the text unexecuted. Font: the
  chrome text is Inter, not Roboto — `src/app/_layout.tsx:29-32` registers the four Inter faces under
  the SANS names and `keybar.tsx` sets `SANS`/`SANS_SEMIBOLD` on the chord captions, the CLIPBOARD and
  UPLOAD FILE headers and the menu labels; a shape correlation of the rendered `CLIPBOARD` header
  against both candidates scored Inter 600 at 0.960 vs Roboto at 0.932, with the aspect ratio also
  closer to Inter. Honest limit: at the 13px caption size the two faces are **not** separable from a
  screenshot (per-letter correlation 0.9666 vs 0.9669), so the caption row is verified by construction
  and by the larger header, not by its own pixels.

### T7A.7 — Haptics on press do not crash
- **Setup**: any key.
- **Steps**: press keys, caps, arrows.
- **Expect**: presses dim/shrink and send; no red screen from `expo-haptics` (the emulator
  usually has no vibrator — the call must no-op, not throw). Feel the actual haptic on
  hardware, not here.
- Android: [x] — keys, chord caps and popover arrows pressed in a sweep: every press dimmed, shrank
  and sent, with no red screen and no `expo-haptics` exception. This AVD does have a vibrator, and
  `dumpsys vibrator_manager` shows the app's 52 ms `usage: TOUCH` effects *finishing* rather than being
  rejected, so the call is not even taking the no-op path here. The one `FATAL signal 11` in the logcat
  ring is unrelated to presses: it is a startup crash on the `mqt_v_js` thread inside
  `MountingCoordinator::pullTransaction` ("trying to execute non-executable memory") at process uptime
  4s on one relaunch, and the app came straight back. The buzz itself stays hardware-only.

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
- iOS: [x] — on a genuinely virgin host (`tmux kill-server`, `rm -rf ~/.config/port22`, source line
  stripped): probe reported `config:"not-applied"`, then `[tmux] configure: applied`. Host side
  gained `~/.config/port22/port22.conf` (`# port22-conf-v1`, `set -g @port22 1`) and exactly one
  `source-file -q …` line at `~/.tmux.conf:62`, rest of that file untouched.
- Android: [x] — emulator 2026-08-17, attach mode onto a private session (`t13walk3`). `tmux
  kill-server` was NOT run: it would kill the user's live `port22`/`prot22` sessions. Virgin state
  reached instead with `rm -rf ~/.config/port22` + `tmux set -gu @port22`, so the read-back verify
  was genuine. Log: `{"present":true,"config":"not-applied",…}` → `{"config":"applied"}` →
  `[tmux] configure: applied`; host gained `~/.config/port22/port22.conf` (4145 B) and
  `tmux show -gv @port22` answered `4`. Tabs circle went live (glyph sampled `#cdd6f4` vs the greyed
  `#53566b` of a plain-shell connect).
  **Two Expect clauses are stale, not failures.** (1) The marker is `# port22-conf-v4`
  (`CONF_VERSION = 4`), not v1. (2) Nothing is appended to the user's tmux conf any more — the app
  stopped writing outside its own directory on 2026-08-12 (`src/tmux-model.ts:145-157`); this host
  has no `~/.tmux.conf` at all.

### T9.2 — Works on a fish login shell
- **Setup**: host user's shell is fish (`chsh -s $(which fish)` or already so).
- **Steps**: walk T9.1 on that host.
- **Expect**: identical outcome — no parse errors in the log (`Unknown command`, `Missing end`
  are the fish tells), verify still answers `1`. Every exec line the log shows is the
  fish-and-sh common ground pinned in `src/tmux-model.test.ts`.
- iOS: [x] — the T9.1 round trip above *was* the fish run: this host's login shell is fish 4.8.1
  (`Shell: fish 4.8.1` in its own greeting). No `Unknown command` or `Missing end` anywhere in
  the log.
- Android: [x] — the T9.1 run above IS the fish run: this host's login shell is `/bin/fish`
  (fish 4.8.1 in its own greeting), and every exec channel is `fish -c`. Zero `Unknown command`,
  `Missing end` or `Unexpected end` anywhere in the whole Metro log, and the verify still answered
  `4`.

### T9.3 — Toggle off: tabs affordance gone, no push on next connect
> Historical: the toggle became the §4.1 start mode. The same state is now reached by choosing
> `Plain shell` (or a custom line with no tmux in it) on Setup, and the derived state it proves —
> no push, no tabs circle, poll unaffected — is unchanged.
- **Setup**: connected with config applied (T9.1); host conf files present.
- **Steps**: turn "Configure tmux" off (until T12's sheet: flip `configureTmux` in the settings
  blob or a dev build); disconnect; `rm -rf ~/.config/port22` on the host; reconnect.
- **Expect**: the tabs circle does not render (derived state needs toggle AND applied); the log
  shows probe but **no** SFTP upload and no `configure:` line; `~/.config/port22` stays absent.
  The poll still runs — the ribbon feed does not depend on the toggle.
- iOS: [x] — `[settings] configureTmux → false`, then a reconnect with zero `configure` and zero
  `upload` lines, `~/.config/port22` still absent, state `"config":"not-applied"` (which is what
  hides the circle), and 7 poll beats in the same window — the feed is independent of the
  toggle, as designed.
- Android: [x] — reached the same state the way the note above says to: start mode `Plain shell`,
  then `rm -rf ~/.config/port22` and reconnect. Log carried the probe and nothing else — no
  `configure:` line, no upload — `~/.config/port22` stayed absent and state stayed
  `"config":"not-applied"`. The poll kept beating: sampling the host for the poll's own
  `tmux display-message` child caught 5 hits in 10 s (≈ the 2 s beat), against 0 in 12 s in T9.4
  where the poll is off.
  **Stale Expect clause, not a failure:** the tabs circle does not disappear — it renders greyed
  (glyph `#53566b`) and answers with a hint when tapped (`src/keybar.tsx`, user 2026-08-12,
  "disabled over hidden"). Greyed is the derived state this case is really asserting.

### T9.4 — No tmux on the host: zero tmux UI, zero message
- **Setup**: a host (or container) without tmux on PATH.
- **Steps**: connect; use the session normally for a minute.
- **Expect**: log shows the probe answering empty and `"present":false`; no tabs circle, no
  poll lines, no error, no mention of tmux anywhere on screen (§7: silence, not a message).
- iOS: [x] — tmux moved off PATH on the host, then a fresh connect: `{"present":false,…}`, bar
  without a tabs circle, nothing said on screen. One `[ssh] exec failed` at the probe, then
  silence — the poll does not run when tmux is absent. Rough edge, log-only: when tmux vanishes
  *mid-session* the poll keeps retrying every 2s and logs a failure each beat.
- Android: [x] — tmux was hidden from the app WITHOUT touching the user's running server: a
  temporary `~/.config/fish/conf.d` guard stripped `/usr/bin` from the PATH of non-interactive
  fish over SSH only (the app's exec channels), leaving every interactive shell — including the
  app's own PTY — untouched; deleted again straight after. Result: `{"present":false,…}` and then
  silence — no poll (0 `display-message` hits in 12 s of sampling), no error line, tabs circle
  greyed, and nothing on screen mentions tmux (full-frame screenshot read).

### T9.5 — Badge tracks `select-window` from another client
- **Setup**: connected, `tmux attach` typed into the phone session (window badge visible on the
  tabs circle); a laptop attached to the same session.
- **Steps**: from the laptop: `tmux select-window -t :2`, then `:1`.
- **Expect**: within ~2s (one poll beat) the badge follows to 2, then back; log shows one
  `[tmux]` line per change, not one per poll.
- iOS: [x] — the laptop *is* the host (10.42.0.71), so a shell here is a genuine second client.
  `select-window -t 3` from it moved the app's feed to `windowIndex: 3` untouched, having
  already tracked 1 → 2. One `[tmux]` line per change, not per poll beat.
- Android: [x] — a host-side `tmux select-window -t t13walk3:1` then `:2` (a genuine second client)
  moved the feed `windowIndex` 2 → 1 → 2, one `[tmux]` line per change and none on the quiet beats,
  each within one poll. **Note the badge itself no longer exists:** nothing renders `windowIndex` on
  the tabs circle any more; the switcher's active card is the only UI reader (confirmed in T9.6's
  screenshot, where the ringed card was window 2). The log line is the assertion, as the case says.

### T9.6 — capture-pane snapshot carries ANSI colour
- **Setup**: attached to tmux; something colourful on screen (`ls --color`, `git log`).
- **Steps**: trigger `capturePane` — until T10's cards exist, from the switcher once it lands,
  or by a temporary dev call. **Dep: T10** for the on-screen assertion.
- **Expect**: the captured string contains `\x1b[` colour sequences (`-e` did its job); fed to
  a terminal it reproduces the pane's colours.
- iOS: [ ]
- Android: [x] — T10's grid is the on-screen assertion now. With `ls --color=always /usr` run in all
  three windows, the switcher's cards reproduced the pane colours: cyan `fastfetch` keys, blue
  directory names, pink `85%`, green symlink targets, read at native resolution. Colour cannot
  survive a `capture-pane` without `-e`, so the escapes were in the string.

### T9.7 — new/kill/select/move helpers observable from a second client
- **Setup**: attached to tmux; laptop attached to the same session, watching `tmux list-windows`.
  **Dep: T10** — the helpers have no UI caller until the switcher; drive them from it then.
- **Steps**: via the switcher (T10): new tab, select another, reorder by drag, close one.
- **Expect**: the laptop sees each: a window appears (`new-window`), the active marker moves
  (`select-window`), indices reorder (`move-window -b`/`-a`), a window dies (`kill-window`).
  Every command in the log is an exec channel — the phone's PTY never echoes any of it.
- iOS: [ ]
- Android: [x] — all four driven from the switcher against the private `t13walk3` session, each
  read back on the host with `tmux list-windows -F '#{window_index} #{window_id}'`:
  `+` → `3 @156` appeared and went active (`[switcher] new window`); drag of that card to slot 0 →
  `0 @156, 1 @153, 2 @154, 3 @155` (`[switcher] reorder {"from":3,"to":0}`); card ✕ → `@156` gone
  (`[switcher] kill @156`); card tap → `@153` active (`[switcher] select @153`). The PTY's own pane
  shows none of those commands — the screenshot after the round is a clean prompt.

### T9.8 — Poll: `sleep 100` is foreground, the prompt is idle
- **Setup**: attached to tmux, at a fish prompt. **Dep: T11** for the on-screen ribbon; until
  then the `[tmux]` log line is the assertion.
- **Steps**: run `sleep 100`; wait ~3s; Ctrl-C it; wait ~3s.
- **Expect**: log flips to `"foreground":{"command":"sleep","pid":…}` within a beat, then back
  to `"foreground":null` (fish = idle) after the interrupt. vim and `claude` likewise register;
  a bare prompt never does.
- iOS: [x] — driven from the host side (`send-keys 'sleep 100' Enter`, then `C-c`): the feed went
  `null` → `{"command":"sleep","pid":348866}` → `null`, one beat each way.
- Android: [x] — driven from the host into the private session (`send-keys 'sleep 100' Enter`, then
  `C-c`): `foreground:null` → `{"command":"sleep","pid":3989936}` → `null`, one beat each way.

### T9.9 — Version bump replaces an old conf
- **Setup**: on the host: `printf '# port22-conf-v0\nset -g mouse on\n' > ~/.config/port22/port22.conf`.
- **Steps**: connect.
- **Expect**: log shows the read-back, the push (content differs), and `configure: applied`;
  the file on the host now starts `# port22-conf-v1`. Reconnecting again shows the read-back
  and **no** second upload — byte-identical content skips the push.
- iOS: [x] — planted `# port22-conf-v0` (md5 `4399f4…`, 2 lines); the reconnect replaced it with v1
  (md5 `d122c2…`, 30 lines) and the source-line count stayed 1, not 2. The second reconnect left
  the file's mtime at the first push's `23:40:25`, so nothing was re-uploaded. Note for the
  reader: `configure: applied` logs on *every* connect — it reports the verify round-trip, not
  an upload. The mtime is what tells a push from a skip.
- Android: [x] — planted `# port22-conf-v0` (33 B, md5 `4399f4…`); the reconnect replaced it with v4
  (4145 B, md5 `50b7f6…`, mtime 16:00:25) and logged `configure: applied`. A second
  Disconnect→Connect logged `configure: applied` again but left the mtime at 16:00:25 and the md5
  unchanged — byte-identical content skipped the push, exactly as the iOS note explains.

### T9.10 — Failed push changes nothing visible
- **Setup**: on the host: `chmod 500 ~/.config` (or `chattr +i` the port22 dir) so the SFTP
  write fails; no `port22.conf` present. (What was actually used, and gentler on a live desktop:
  `rm -rf ~/.config/port22 && touch ~/.config/port22` — a regular file where the directory has
  to be. No permissions touched, and undone with a single `rm`.)
- **Steps**: connect; use the session.
- **Expect**: the session works normally; log shows `[tmux] configure failed …` and state stays
  `"config":"not-applied"`; no tabs circle, no alert, no banner — §7's "failed conf push
  changes nothing visible". Restore with `chmod 700 ~/.config`; the next connect applies.
- iOS: [x] — `[ssh] upload failed: …SFTPMessage.Status error 1` then `[tmux] configure failed,
  nothing visible changes: …`, state stayed `"config":"not-applied"`, and the screenshot shows
  the bar without a tabs circle (the pill stretches into its place). Session fully usable, no
  alert, no banner.
- Android: [x] — the gentle setup (`rm -rf ~/.config/port22 && touch ~/.config/port22`). Log:
  `[tmux] configure failed, nothing visible changes: [Error: Call to function 'ExpoSSH.upload' has
  been rejected.` and the state stayed `"config":"not-applied"`. Session fully usable, no alert, no
  banner, nothing said on screen.
  **Stale Expect clause, not a failure:** the tabs circle stays live here, because `tabsAvailable`
  is `present && attached` and no longer includes the conf — dropped deliberately on 2026-08-12
  (`src/tmux-model.ts:489` and its comment: nothing behind the button reads the conf). Sampled
  glyph `#cdd6f4` (live), against `#53566b` in T9.3/T9.4 where it really is greyed.

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
- iOS: [x] — driven from the host with `tmux set-buffer -w "…"`, which makes tmux emit the OSC 52 to
  the attached client: one `[clipboard] 1 slots, 0 pinned` per yank, and the popover's top row
  read the text with `tmux yank · just now`. The pasteboard half is the popover's own
  phone-pasteboard row, which reads the live iOS pasteboard and showed the same string.
- Android: [x] — same driver as iOS (`tmux set-buffer -w 'yank-one-alpha'` on the private session,
  which makes tmux emit the OSC 52 to the attached client): exactly one `[clipboard] 1 slots, 0
  pinned`, and the long-pressed popover's top row read `yank-one-alpha` / `tmux yank · just now`.
  The pasteboard half is the popover's phone-pasteboard row, which reads the live Android clipboard
  through `expo-clipboard` and showed the same string — the same evidence the iOS tick rests on.
  **Android-only finding (not a failure):** every yank pops Android 13's own clipboard-write chip
  over the bottom-left of the key bar for ~10 s, covering the ⋯ circle and part of the pill, and it
  swallows taps in that region while it is up. iOS has no such overlay.

### T8.2 — Three-yank rotation
- **Setup**: as T8.1.
- **Steps**: yank four different strings; open the popover.
- **Expect**: exactly three yank slots, newest on top, the first yank gone; the phone-pasteboard
  row (holding yank four — the pasteboard follows the last yank) sits below them.
- iOS: [x] — four yanks logged `1 → 2 → 3 → 3 slots`; the popover showed `yank-four-delta`,
  `yank-three-charlie`, `yank-two-bravo` newest-first with `yank-one-alpha` gone, and the
  phone-pasteboard row below them holding `yank-four-delta`.
- Android: [x] — four yanks logged `1 → 2 → 3 → 3 slots`; the popover showed `yank-four-delta`,
  `yank-three-charlie`, `yank-two-bravo` newest-first with `yank-one-alpha` gone, and the
  phone-pasteboard row below them holding `yank-four-delta`. Read off a native-resolution crop.

### T8.3 — Pin survives rotation and an app restart
- **Setup**: one yank in the slots.
- **Steps**: open the popover, tap the pin glyph on that slot; yank three more strings; open
  the popover again; force-quit the app, relaunch, reconnect, open the popover.
- **Expect**: the pinned slot is still there after the three yanks (fourth row, "· pinned"
  instead of an age) and still there after the restart — pins live in SecureStore, yanks do
  not (the three unpinned ones are gone after relaunch).
- iOS: [x] rotation half — pinning logged `3 slots, 1 pinned`, and three fresh yanks settled at
  `4 slots, 1 pinned`: `golf`/`foxtrot`/`echo` rotating above `yank-two-bravo`, which read
  `tmux yank · pinned` with a filled pin. Restart half below.
- Android: [x] — both halves. Pinning `yank-two-bravo` logged `3 slots, 1 pinned`; three fresh yanks
  settled at `4 slots, 1 pinned` with `golf-seven`/`foxtrot-six`/`echo-five` rotating above it and
  the pinned row reading `tmux yank · pinned`. Force-stop → relaunch → reconnect → popover: only
  `yank-two-bravo · pinned` survived, the three unpinned were gone, and the phone-pasteboard row
  held the live clipboard.

### T8.4 — Paste tap types the top slot and never executes
- **Setup**: yank `echo yanked` (with no newline selected); cursor at an empty prompt.
- **Steps**: tap Paste once.
- **Expect**: `echo yanked` appears at the prompt, **not run** — no Return travels, the cursor
  sits at the end of the typed text. Pressing Return manually runs it (proof the text is real).
- iOS: [x] — one `[ssh] send echo yanked` with no `\r` behind it; the screenshot shows it at the
  prompt with the cursor after it, unexecuted.
- Android: [x] — yanked `echo yanked`, one Paste tap: the host pane read `❯ echo yanked` with
  `#{cursor_x}` 13, i.e. the cursor sitting at the end of the typed text and no second prompt line —
  nothing ran. A manual Return afterwards printed `yanked`, proving the text was real.

### T8.5 — Long-press popover: previews, provenance, pasteboard slot, banner once
- **Setup**: at least one yank in the slots; copy something in another iOS app first.
- **Steps**: long-press Paste (~420ms); read the popover; close it (outside tap); long-press
  again.
- **Expect**: slots show content preview (one line, ellipsized) + provenance ("tmux yank ·
  N min ago"); the phone-pasteboard row is last and shows the other app's text; iOS's paste
  banner fires **once per open** (on the read), not per row; outside tap closes.
- iOS: [ ]
- Android: [x] — pasteboard seeded from another app (Settings' search field + `KEYCODE_COPY`,
  `settings-app-clip-77`). The popover showed one-line ellipsized previews (`long-preview-line
  ABCDEFGHIJKLMN…`) with provenance (`tmux yank · just now`, `tmux yank · 3 min ago`,
  `tmux yank · pinned`), the phone-pasteboard row last holding the other app's text; an outside tap
  closed it and a second long-press reopened it. iOS's paste banner has no Android counterpart —
  Android notifies on clipboard *write* instead (see T8.1's finding), so that clause is N/A here.
  **Bug found while reading this popover:** the pinned slot DUPLICATES — two identical
  `yank-two-bravo · pinned` rows, and the log went `3 slots, 1 pinned` → `3 slots, 2 pinned` with
  nothing pinned in between. `hydratePins()` appends unconditionally onto live module state
  (`src/clipboard.ts:62-68`), and `_layout.tsx:36-39`'s `useEffect` runs again on every JS root
  remount (each dev-client deep-link relaunch here; a JS reload in production), so one pin becomes
  N. Not diagnosed further, not fixed.

### T8.6 — Multiline yank stays unexecuted
- **Setup**: yank a multi-line block (two shell lines) in copy-mode.
- **Steps**: open the popover, tap that slot.
- **Expect**: both lines land at the prompt as typed input — the shell may show continuation,
  but nothing runs until a manual Return. The yank's own embedded newline travels because it is
  *content*; the app appends none of its own.
- iOS: [x] — **failed first, fixed during the walk.** A three-line yank pasted bare ran the first two
  lines and left the third at the prompt: the app typed the text raw, so fish (bracketed paste
  on) read the embedded newlines as Return presses. Fix: track DECSET 2004 on the mode signal
  and wrap clipboard text in `ESC[200~ … ESC[201~`. Re-run: the same yank lands as one
  unexecuted continuation block, wire shows `ESC[200~echo alpha-1…`.
- Android: [x] — `printf 'echo alpha-1\necho beta-2' | tmux load-buffer -w -`, then the popover's top
  slot tapped: the host pane read `❯ echo alpha-1` / `  echo beta-2` as one fish continuation block,
  cursor at its end, no output — nothing ran. Bracketed paste works on Android too.

### T8.7 — ⋯ menu: three pickers reachable
- **Setup**: connected, keyboard up.
- **Steps**: tap ⋯; tap each of Files / Photo or video / Camera in turn (cancel each picker).
- **Expect**: the menu opens with the keyboard dismissed (§4.4); Files opens the document
  picker, Photo or video the photo library (no permission prompt — PHPicker), Camera asks for
  camera permission once then opens the camera; cancelling any picker returns to the terminal
  with nothing typed and no sheet.
- iOS: [x] — all three pickers opened and cancelled back to the terminal with nothing typed; the
  keyboard dropped as the menu opened (`52 × 26` → `52 × 41`). Pickers are system UI and a
  cancel leaves no log trace, so the three-picker half is eye-verified.
- Android: [ ]
  - FAILED 2026-08-17: the menu opens with the keyboard STILL UP. Raised Gboard (`mInputShown=true`),
    tapped ⋯: the menu rendered squeezed above the bar and `mInputShown` was still `true`, keyboard
    fully on screen (screenshot). iOS drops it (`52 × 26` → `52 × 41`). There is no
    `Keyboard.dismiss()` on this path at all — `src/keybar.tsx:693` is a bare `toggle('menu')`,
    unlike `openSettings` (`src/app/terminal.tsx:355-363`) which does dismiss.
    The rest of the case passed: Files opened the SAF document picker, Photo or video the Android
    photo picker with no permission prompt, Camera asked for camera permission once
    ("While using the app") and then opened the camera; cancelling each returned to the terminal
    with nothing typed and no sheet. Note Files and Camera also drop the SSH session on the way
    (they background the app) while the photo picker does not — see T8.8.

### T8.8 — Destination sheet: browse, breadcrumb, descend
- **Setup**: pick a file via ⋯ → Files.
- **Steps**: read the sheet; tap a directory; tap `..`; watch the breadcrumb.
- **Expect**: the sheet opens at `$HOME` (first ever run) with directories first then files,
  names mono; tapping a directory descends and re-lists (fresh `listDirectory` in the log);
  `..` walks up; the breadcrumb tracks the path with `/` accented and the current segment
  bright.
- iOS: [x] — **one bug found and fixed.** The listing carried SFTP's own `.` and `..` on top of the
  sheet's up row: three navigation rows, one of which walked into the directory it was already
  in. Filtered in `sortEntries`; re-checked on device — one `..`, no `.`, real dotfiles like
  `.config` still listed. Everything else was right first time: opens at `$HOME`, directories
  before files, descend re-lists (`listDirectory /home/kamil/Projects` in the log), breadcrumb
  `/ home › kamil › Projects`, host label, and `Save here /home/kamil/Projects`.
- Android: [x] — but ONLY through the photo picker; the case's own "⋯ → Files" route cannot reach a
  working sheet on Android (see the finding below). Via ⋯ → Photo or video the sheet opened at
  `$HOME` on its first ever run, breadcrumb `/ home › kamil` with `/` accented and `kamil` bright,
  one `..` row and no `.`, directories before files (dotfiles included, sizes on files), names mono.
  Tapping `.config` descended and re-listed (`/ home › kamil › .config`, `Save here
  /home/kamil/.config`); `..` walked back to `/ home › kamil`.
  **Finding — which picker you use decides whether upload works at all.** The SAF document picker
  (Files) and the camera background the app, which closes the shell; the sheet then resolves its
  start dir against the dead connection and logs `[upload] sheet could not resolve a start dir:
  [Error: Call to function 'ExpoSSH.exec' has been rejected.` — empty listing, no breadcrumb,
  `Save here` disabled, and it never recovers even after the auto-reconnect lands (waited 20 s+,
  re-checked). The Android photo picker does NOT background the app, the session survives, and
  every upload case below passes through it. That is the shape of the "uploading is dead on
  Android" bug from part 1: it is picker-specific, not universal.

### T8.9 — Collision is visible and overwrite works
- **Setup**: on the host: `echo old > ~/collide.txt`; pick any file via ⋯ → Files.
- **Steps**: in the sheet, type `collide.txt` into SAVE AS while in `$HOME`; read the listing;
  Save here; on the host `cat ~/collide.txt`.
- **Expect**: `collide.txt` is visible in the listing (files are shown for exactly this) and
  tints warning while the field matches it, with "— replaces the existing file" on the SAVE AS
  label; saving overwrites without any further prompt; the host file now holds the upload.
- iOS: [x] — the SAVE AS label became "SAVE AS — replaces the existing file" and the field's border
  turned warning-yellow as soon as the name matched; Save here overwrote with no further prompt
  (target went 1162 bytes / md5 `bbc1e2…` → 87916 bytes / md5 `9ae6ac…`).
  **Run it against the `~/collide.txt` this setup asks for.** During T13 it was pointed at a
  real `~/note.txt` instead and destroyed its contents — the case overwrites whatever it names.
- Android: [x] — run against the `~/collide.txt` the setup asks for (`echo old >`, 4 B, md5
  `814fa5…`). `collide.txt, 4 B` was visible in the `$HOME` listing; typing `collide.txt` into
  SAVE AS turned the label into "SAVE AS — replaces the existing file" and the field's border
  warning-yellow; Save here overwrote with no further prompt (target went 4 B / `814fa5…` →
  2 163 464 B / `c9adc5…`). Cleaned up afterwards.

### T8.10 — Editable filename lands the file under the new name
- **Setup**: pick a file with a known name via ⋯ → Files.
- **Steps**: clear SAVE AS, type `renamed hello.txt`, Save here; `ls` on the host.
- **Expect**: the file lands as `renamed-hello.txt` (the sanitiser turns the space into a dash
  on save); the original name is nowhere on the host.
- iOS: [x] — landed as `~/Downloads/renamed-hello.txt`; the picked file's own name never appeared.
- Android: [x] — browsed into `~/Downloads`, cleared SAVE AS, typed `renamed hello.txt`, Save here:
  the file landed as `~/Downloads/renamed-hello.txt` (2 163 464 B) and `~/Downloads/renamed
  hello.txt` never existed. The picked file's own name (`42.mp4`) is nowhere on the host.

### T8.11 — Camera default name is the timestamp
- **Setup**: ⋯ → Camera, take a photo, accept it.
- **Expect**: the sheet's SAVE AS field pre-fills `YYYYMMDDTHHMMSS.jpg` (UTC, this minute) —
  not the camera's own IMG-style name.
- iOS: [x] — camera shot pre-filled with the UTC stamp, and the send itself went through
  (`[ssh] upload -> undefined`).
- Android: [ ]
  - FAILED 2026-08-17: the stamp is right, the extension is not — the sheet pre-filled
    `20260817T142208.jpeg`, where the case (and iOS) say `YYYYMMDDTHHMMSS.jpg`. UTC and the right
    minute were confirmed against `date -u` (`20260817T142153` typed one shot earlier), and it is
    not the camera's IMG-style name, so only the suffix diverges: `stampName` keeps the picked
    asset's extension and Android's camera returns `.jpeg`.
    The other half of the iOS tick — the send going through — could not happen either: the camera
    backgrounds the app, so the sheet came up with the dead-connection failure of T8.8 (empty
    listing, `Save here` disabled, `[upload] sheet could not resolve a start dir`).

### T8.12 — "Save here" saves silently
- **Setup**: any destination upload; the terminal at a prompt with a distinctive line.
- **Steps**: Save here; watch the terminal.
- **Expect**: the sheet dismisses, the file lands (verify on the host), and the terminal shows
  **nothing** — no typed path, no output, the prompt untouched (§4.6: nothing typed into the
  session from this flow).
- iOS: [x] — verified alongside T8.9: the file landed on the host (mtime and md5 both changed) while
  the terminal kept a clean prompt, nothing typed, no output.
- Android: [x] — verified twice, alongside T8.9 and T8.10: the sheet dismissed on Save here, the
  file landed on the host (size and md5 both changed), and the terminal behind it kept its prompt
  exactly as it was — nothing typed, no output (screenshots before and after).

### T8.13 — Last destination is remembered
- **Setup**: complete T8.8's browse ending in a subdirectory, Save here.
- **Steps**: run a second ⋯ upload; then force-quit, relaunch, reconnect, a third upload.
- **Expect**: the second and third sheets open directly in that subdirectory (persisted in
  settings); if the directory has meanwhile vanished, the sheet falls back to `$HOME` without
  an error.
- iOS: [ ]
- Android: [x] — after a save into `~/Downloads`, the second upload's sheet opened straight at
  `/ home › kamil › Downloads`; a force-stop, relaunch, reconnect and a third upload opened there
  too, so it is persisted, not in-memory. Fallback half checked as well: saved once into a
  throwaway `~/.0t13tmp`, deleted the directory on the host, opened a fourth sheet — it came up at
  `/ home › kamil` with no error and no alert.

### T8.14 — ⋯ circle tints accent and goes inert during the send
- **Setup**: a large file (tens of MB — the send needs to take a visible moment) via ⋯ → Files.
- **Steps**: Save here; immediately look at the ⋯ circle and try tapping it.
- **Expect**: the circle is accent-filled with the glyph in background colour for the duration
  of the SFTP write, and tapping it does nothing; it returns to the plate when the send settles —
  that is the entire progress UI (§4.4/§4.6).
- iOS: [x] — **three bugs on the way through.** (1) Picking a video threw
  `PHPhotosErrorDomain error 3164` **uncaught in a promise** — a red box instead of a message;
  `pick()` now catches it and shows one "Could not read the file" alert. (2) The busy tint sat
  *under* Glass's blur and light-mode white overlay, so in Latte the accent washed out and the
  glyph (painted in `theme.background`) nearly vanished; it is drawn over the surface now, with its
  own radius, because an absolutely-filled child squared off the circle's edge when left to the
  parent's clip. (3) The ssh logging proxy printed the whole base64 upload, which put tens of MB
  through Metro's socket — `RangeError: Max payload size exceeded`, HMR dead, log gone; long
  strings now log as a head plus their length. After those: the circle is solid accent with a
  readable glyph for the duration of the send and ignores taps throughout.
- Android: [ ]
  - FAILED 2026-08-17: at the size this case asks for, Android cannot even read the file. A 46 MB
    JPEG picked from the photo library threw before any send:
    `[upload] picker failed: [Error: Call to function 'FileSystemFile.base64' has been rejected.
    → Caused by: java.lang.OutOfMemoryError: Failed to allocate a 123507192 byte allocation …
    growth limit 201326592]`. The app handled it correctly — one "Could not read the file" alert,
    nothing else — but the whole-file-to-base64 read in `pickOrThrow` (`src/upload.ts:74-95`) puts
    ~2.7× the file size on the Java heap, so "tens of MB" is out of reach on this AVD's 192 MB
    growth limit. iOS did tens of MB fine.
    The Expect's own behaviour DOES hold at a size that fits: with a 7.8 MB image the ⋯ circle went
    solid accent (`#89b4fa`) with the ⋯ glyph in the background colour for four consecutive frames
    of the send and returned to the plate when it settled, and a tap on it during the send did
    nothing (no menu). Left unticked because the case as written — tens of MB — fails.

### T8.15 — Unwritable destination: one alert, nothing typed, nothing left
- **Setup**: on the host: `mkdir -p ~/noentry && chmod 500 ~/noentry`; upload via ⋯ → Files.
- **Steps**: browse into `noentry` (listing works — read is allowed), Save here.
- **Expect**: "Could not send the file" alert, once; the terminal shows nothing; `ls ~/noentry`
  on the host shows nothing new; the raw SFTP error is in the log. Restore with `chmod 700`.
- iOS: [x] — listing the read-only directory worked, the write failed: one alert with a single OK,
  the terminal untouched behind it, `~/noentry` still empty, and the log carrying both
  `[ssh] upload failed: …SFTPMessage.Status error 1` and
  `[upload] failed: /home/kamil/noentry/wllpr-iphone.png`.
- Android: [x] — `mkdir -p ~/noentry && chmod 500 ~/noentry`, browsed into it (the listing worked:
  breadcrumb `/ home › kamil › noentry`, empty), Save here: one "Could not send the file" alert with
  a single OK, `[upload] failed: /home/kamil/noentry/46.jpg [Error: Call to function
  'ExpoSSH.upload' has been rejected.`, `~/noentry` still empty, and the pane behind it unchanged
  (captured before and after). Restored with `chmod 700` and removed. Note the raw SFTP status is
  NOT in the log on Android — `LOG = false` in `modules/expo-ssh/src/ExpoSSHModule.ts` masks it
  behind the generic "has been rejected", where iOS quoted `SFTPMessage.Status error 1`.

### T8.16 — Quick-attach: `/tmp/port22`, typed path, trailing space
- **Setup**: connected, cursor at a prompt. **Dep: T11** — the agent ribbon 📎 cap is the only
  UI caller; until it lands, drive `quickAttach('photo')` from a temporary dev call and assert
  via the log.
- **Steps**: run the quick-attach flow, pick a photo.
- **Expect**: log shows `upload` into `/tmp/port22/<UTCstamp>.jpg` (mkdir 0700 on demand —
  `stat -c %a /tmp/port22` says 700) and `[upload] quick-attach typed …`; the prompt now holds
  the absolute path plus **one trailing space**, unexecuted; the path also appears as an
  "upload path" clipboard slot.
- iOS: [ ]
- Android: [ ]
  - FAILED 2026-08-17: the cap fires and builds the right path, the send never lands. Drove it from
    the real T11 ribbon (a harmless `sleep` copied to `/tmp/t13bin/claude` made the foreground read
    as an agent; the chip appeared, the band scrolled to the 📎 cap). Tapping it logged
    `[ribbon] cap 📎` and opened a picker, then: `[session] {"status":"disconnected"}` followed by
    `[upload] failed: /tmp/port22/20260817T143236.txt [Error: Call to function 'ExpoSSH.upload' has
    been rejected.` and one "Could not send the file" alert. Nothing typed at the prompt, no
    clipboard slot, `/tmp/port22` never created on the host.
    Root cause is T8.8's: the shipped cap calls `quickAttach()` with its default kind, which is
    `'files'` (`src/upload.ts:128`, `src/app/terminal.tsx:1871`) — the SAF picker, the one that
    backgrounds the app and kills the connection. The case's own text says `quickAttach('photo')`,
    and the photo picker is exactly the one that would have survived.

## T10 — Tab switcher

All cases: a real host with configured tmux, session attached (`tmux attach` or `tmux` typed
into the phone session), at least three windows made beforehand (`tmux new-window` twice from
the shell) unless said otherwise. The switcher logs every action as `[switcher] …`; T9's
`[ssh] exec` lines show the `select/kill/new/move-window` commands going out on exec channels,
never through the PTY. Reorder assertions read `tmux list-windows` on a laptop attached to the
same session.

**Three Expect clauses in this section are stale (Android walk, 2026-08-17).** (a) There is no
numeric window badge any more — the switcher's active card is the only reader of `windowIndex`, so
every "badge shows N" line tests a control that was removed. (b) `LOG = false` in
`modules/expo-ssh/src/ExpoSSHModule.ts`, so the `[ssh] exec` trace this preamble promises does not
exist; the exec-vs-PTY split is judged on effects (the command never appears in the terminal) and on
host-side `tmux list-windows`. (c) `GESTURE_LOG = false` in `src/app/terminal.tsx:691`, so
`[switcher] open (bar drag)` is never printed either.

**READ THIS BEFORE WALKING ANY T10 CASE — the switcher can be pointed at the wrong tmux session.**
Proven on the emulator 2026-08-17, see T10A.8. `LIST_WINDOWS` (`src/tmux-model.ts:230`) is
`tmux list-windows -F …` with **no `-t <session>`**, and it runs on an exec channel, i.e. outside
any tmux client. tmux then resolves the target with its "best session" heuristic, which is the
session with the newest `session_activity` — not the session this PTY is attached to, and not even
an attached one. With the phone attached to session A and the user's session B more recently
active, the grid draws B's windows, and ✕ / tap / reorder all address B. Reproduced by hand:

```
$ tmux ls
port22:    2 windows          # user's real work, DETACHED
t13walk4:  5 windows (attached)   # the phone's session
$ env -u TMUX tmux list-windows -F '#{window_id} #{window_name}'
@150 claude
@174 fish                      # port22's windows, not t13walk4's
```

Type one character into the phone's PTY (which bumps that session's activity) and the same command
answers with t13walk4. During this walk the emulator's grid twice rendered the user's live Claude
Code windows, each with a working ✕. **Do that bump before any destructive step, and read the card
names before tapping anything.**

### T10.1 — Open via tabs tap: terminal zooms into its card slot
- **Setup**: attached, three windows, window 2 active (badge shows 2).
- **Steps**: tap the tabs circle.
- **Expect**: keyboard drops; the live terminal shrinks into the grid slot of the *active*
  card (second position if order is 1·2·3) with rounded corners, an accent ring riding the
  transition, and the bottom (bar area) clipped away — then fades, leaving the grid. Log:
  `[switcher] open (tabs tap)`.
- iOS: [ ]
- Android: [x] — 2026-08-17, emulator, 30fps capture. Keyboard up before the tap
  (`mInputShown=true`), `mInputShown=false` after; `[switcher] open (tabs tap)` in the log. Frames
  53→64: Gboard slides out, then the live pane shrinks with rounding corners and a #89b4fa ring,
  the key-bar band clipped off its bottom, travelling to the TOP-RIGHT slot — the second of three
  (`home`·`colors`·`vim`, `colors` active) — and the card takes over there. The "badge shows 2"
  in Setup is stale: no numeric badge exists.

### T10.2 — Open via bar-swipe-up: progress tracks the finger, cancel springs back
- **Setup**: keyboard up (tap the bar first if not).
- **Steps**: touch the bar and drag up slowly ~40pt, hold; wiggle up and down without
  releasing; release. Then repeat, dragging past half the screen before releasing.
- **Expect**: first release (below the ~25% commit threshold): the terminal has shrunk part-way
  *following the finger* — growing and shrinking as the finger wiggles, drifting sideways with
  it — and springs back to full screen; the keyboard was dismissed when the drag began. Second
  release: the shrink completes into the active card's slot and the grid stays. Log:
  `[switcher] open (bar drag)`. With the keyboard down, the same swipe only raises the
  keyboard (T7.9 behaviour unchanged).
- iOS: [ ]
- Android: [ ]
  - FAILED 2026-08-17: **both switcher halves pass; the last sentence does not.** Driven with
    `input motionevent` (a `swipe` is not a held gesture). Long drag, bar y=1436 → y=500: Gboard
    goes, the pane shrinks continuously under the finger with rounding corners and the accent ring,
    release past the threshold leaves the grid up (`5 Tabs`, search bar, `mInputShown=false`) and
    the shell is told it grew — `[terminal] size 50 × 45`. Short drag to y≈1140 with a 5-point
    wiggle including two sideways excursions (x 400…700): the pane grows and shrinks with the
    finger and drifts sideways with it, and the release springs it back to full screen with no grid
    — keyboard dismissed as the drag began, restored on the spring-back. `[switcher] open (bar
    drag)` is never logged because `GESTURE_LOG = false` (`src/app/terminal.tsx:691`) — stale
    Expect, not a miss. What fails is the keyboard-DOWN clause: an identical upward drag on the bar
    with Gboard down does nothing at all — `mInputShown` stays false, no `[terminal] size`, no
    switcher. That is T7.9's already-recorded Android ↑ failure (see its FAILED note), not a new
    T10 bug; re-tick this case when T7.9's ↑ is fixed.

### T10.3 — Grid shows every window: name, directory, colour snapshot
- **Setup**: window 1 at a shell in `~`, window 2 running `ls --color` output in `/tmp`,
  window 3 in `vim`.
- **Steps**: open the switcher; look.
- **Expect**: three cards in a 2-column grid over the crust background, each with the tmux
  window name under it and the directory leaf under that (`tmp` for `/tmp`); card 2's snapshot
  shows `ls --color`'s colours (blue directories on the card, not grey text); card 3 shows
  vim's UI shape. Text is JBMono, sized so the pane's full width fits the card.
- iOS: [ ]
- Android: [x] — 2026-08-17. Three cards, 2-column grid over crust (background sampled
  `#11111b`, card surface `#1e1e2e`): `home`/`kamil`, `colors`/`tmp`, `vim`/`kamil` — name in
  JBMono over directory leaf. Card 2 carries `ls --color`'s palette (blue folder glyphs, cyan
  symlinks, pink/green permission bits at 3× zoom), card 3 the vim splash with its tilde gutter.
  Width fits: the pane's longest captured line is 48 columns (`Uptime: 8 days, 22 hours, 19 mins`)
  and it lands inside the ring with room. Note the sizing rule is `min(window width, live pane
  width)` (`src/switcher.tsx:937`, 2026-08-11), so an 80-column background window is drawn at the
  50 columns it is about to be resized to and clips — by design, not a fit bug.

### T10.4 — Active card wears the accent ring
- **Steps**: open the switcher from window 2; look; Done; `tmux select-window -t :1` from the
  laptop; open again.
- **Expect**: the active card (and only it) has the accent-coloured 2pt ring and accent-tinted
  name; after the laptop switch, the ring is on window 1's card (one ~2s beat allowed).
- iOS: [ ]
- Android: [x] — 2026-08-17. Opened from window 2: `colors`' card carries a 5px ring sampled
  `#89b4fa` (Mocha blue = `theme.accent`) — 5px at density 420 is 1.9dp, i.e. the 2pt ring — and
  its name is the same blue; the other two carry the 1px `#6c7086` idle border and white names.
  `tmux select-window -t :1` from the host, one beat: the ring and the blue name are on `home` and
  `colors` has gone grey. Poll logged `windowIndex: 1`.

### T10.5 — Tap selects: `select-window` + zoom back down
- **Steps**: from window 1, open the switcher, tap window 3's card.
- **Expect**: the terminal zooms out of card 3's slot back to full screen (ring fading out),
  the PTY now shows window 3 (tmux redrew it under the zoom), the badge says 3, the keyboard
  comes back up. Log shows `[switcher] select @N` and an exec `select-window -t :3` — nothing
  typed into the PTY.
- iOS: [x] — `[switcher] select @7` → `[ssh] exec tmux select-window -t :2`, poll moved to
  `windowIndex: 2`, and the screen came back on that window (its `/tmp` prompt under the
  `ls --color` output) with the badge reading 2 and the keyboard up. Zero `send` lines carried
  the command — it went out on the exec channel, as §4.5 requires.
- Android: [x] — 2026-08-17. From window 1, tapped `vim`'s card: `[switcher] select @163`, host
  `list-windows` flipped to `3 vim @163 (active)`, poll `windowIndex: 3`, keyboard back up
  (`mInputShown=true`). Frames: the ring hands over from `home`'s card to `vim`'s, then the pane
  grows out of card 3's bottom-left slot to full screen with the ring fading, landing on vim's
  empty buffer (`0,0-1 All`). Nothing was typed into the PTY — the terminal shows no command text.
  Two stale clauses: there is no badge, and no `[ssh] exec` line exists (`LOG = false`).

### T10.6 — Snapshots refresh while the grid is open
- **Setup**: in a background window run `watch date`; open the switcher from another window.
- **Steps**: keep the grid open ~10s, watching the `watch date` card.
- **Expect**: the card's clock ticks — the snapshot re-captures on the ~2s beat without the
  grid being touched. Scroll position and card order do not jump when it refreshes.
- iOS: [x] — `watch -n1 date` on a card read `09:59:20` in one frame and `09:59:50` in the next, grid
  untouched between them; order and scroll position held.
- Android: [x] — 2026-08-17. `watch -n1 date` in a background window; three screenshots 5s apart
  with the grid untouched read `18:58:46`, `18:58:50`, `18:58:56` on that card. All five cards kept
  their slots and the grid its scroll offset across the three.

### T10.7 — ✕ closes a window
- **Steps**: open the switcher; tap the ✕ on a non-active card.
- **Expect**: the card animates out and the grid reflows (header count drops by one);
  `tmux list-windows` on the laptop shows the window gone; the exec log shows `kill-window`.
  The remaining cards keep their order.
- iOS: [x] — `[switcher] kill @5` → `[ssh] exec tmux kill-window -t :1`; the host went from three
  windows to `2: colors`, `3: fish`, the survivors keeping their indices.
- Android: [x] — 2026-08-17. ✕ on the non-active `home` card: `[switcher] kill @161`, the card
  fades out over ~8 frames, the header steps `3 Tabs` → `2 Tabs` and the survivors reflow into
  slots 1 and 2 keeping their order (`colors`, `vim`); host `list-windows` lost `1 home @161` and
  kept `2 colors @162`, `3 vim @163`. No `[ssh] exec` line to read (`LOG = false`).

### T10.8 — Left fling closes, right swipe rubber-bands
- **Steps**: on one card, drag left slowly past half the card width and release. On another,
  flick left fast (~50pt). On a third, drag right and release.
- **Expect**: both leftward gestures close (the slow one rides the finger 1:1, fading as it
  goes; the flick closes from less travel because it was quick); the rightward drag moves the
  card only a third of the finger's travel and springs back — rightward never closes. A
  vertical drag on a card scrolls the grid instead.
- iOS: [ ]
- Android: [x] — 2026-08-17, all four clauses measured off 30fps captures (card width 470px, so
  "half a card" is a 238px threshold). **Slow left past half:** two 320px `motionevent` drags each
  closed their card (`[switcher] kill @166`, `@167`, host confirmed). **1:1:** a sub-threshold
  150px left drag moved the card's right edge 518→397px in exact 15px steps matching the 15px
  `MOVE` steps, then sprang back through an overshoot to 533 and settled at 516. **Fades as it
  goes:** the card's interior blended `#1c1c2c` → `#181826` toward the crust over that travel,
  matching `swipeOpacity`'s 1 − 46/173 = 0.73 at that offset. **Fast flick:** `input swipe … 160px
  in 50ms` closed a card from 160px, well under the 238px slow threshold (100ms also closed, 30ms
  did not — the pan never cleared its 10px activation). **Right:** a 300px right drag moved the
  card only 83px (0.28, a third) and sprang back — never closed. **Vertical:** an 800px vertical
  drag started on a card scrolled the grid a full row, killed nothing, logged nothing.
  - FOUND WHILE WALKING, separate bug, 2026-08-17: **a card swipe can throw a Reanimated red box.**
    `[Reanimated] Invalid color value: "rgba(0,0,0,7.852042303549444e-7)"` from
    `processColor` ← `shadows.ts` ← the card's `boxShadow: \`0 18px 30px rgba(0,0,0,${0.55 *
    lift.value})\`` (`src/switcher.tsx:903`). A settling spring drives `lift.value` through
    denormal-sized numbers, JS stringifies `4.3e-7` in exponential notation, and Reanimated's colour
    parser rejects it. Fires repeatedly once it starts; a dev-build red box, unknown behaviour in
    Release. Shared code, so iOS is presumably exposed too. Fix is to clamp/round the alpha
    (e.g. `Math.max(0, 0.55 * lift.value).toFixed(3)`).
  - ALSO SEEN, 2026-08-17: two consecutive native `SIGSEGV`s in
    `facebook::react::MountingCoordinator::pullTransaction` on `mqt_v_js` while relaunching right
    after that red-box storm — the app died at launch twice, then launched cleanly on the third
    try. Not reproduced deliberately; recorded because the timing points at the same animated-style
    path.

### T10.9 — Long-press lifts, drag reorders, drop issues `move-window`
- **Setup**: windows 1·2·3 in order; laptop watching `watch -n1 'tmux list-windows'`.
- **Steps**: press and hold card 1 (~300ms) until it lifts (grows slightly, tilts, drops a
  shadow, ring turns mauve — with a haptic tick on the lift); drag it over slot 3 — the other
  cards spring aside and a dashed placeholder marks the target slot; release.
- **Expect**: the card settles into slot 3; log shows `[switcher] reorder {"from":1,"to":3}`
  and an exec `move-window -a -s :1 -t :3`; the laptop's `list-windows` shows the new order;
  the phone's grid order survives the next snapshot beat (no jump back). Dropping a card back
  on its own slot runs no command at all.
- iOS: [x] — verified 2026-08-10 with two windows: lift (haptic, mauve ring, tilt), dashed placeholder,
  neighbour springs aside, `[switcher] reorder {"from":N,"to":M}` on every real move, order
  survives the ~2s beats and a switcher close/reopen. Host-side index swap was proven on the
  laptop during the earlier bug hunt. The reorder-snap glitch this case used to trip is fixed —
  see the RESOLVED section at the top.
- Android: [x] — 2026-08-17, `motionevent` DOWN, 0.8s hold, stepped MOVEs, UP (a `swipe` produces
  no lift at all). Windows were `1 wind`·`2 vim`·`3 wine`; card 1 held and dragged to slot 3.
  Frames show the lift: the card grows (470 → 508px wide, ~8%), tilts a couple of degrees, and its
  ring turns `#f5c2e7`; the two neighbours spring up one slot each and a dashed placeholder tracks
  the target slot. Drop: the card settles into slot 3, `[switcher] reorder {"from":1,"to":6}` (the
  numbers are tmux INDICES, and this session's were 1·3·6 — not ordinals), host `list-windows` went
  from `1 wind, 3 vim, 6 wine` to `3 vim, 6 wine, 7 wind`, and the phone's order survived several
  ~2s beats with no jump back. A separate hold-and-drop-on-its-own-slot ran no command at all: log
  silent, host order unchanged. Three notes: the ring is `theme.accentAlternate`, which is Mocha
  **pink** `#f5c2e7` and not mauve — the Expect's wording and the code comment at
  `src/switcher.tsx:909` are both wrong about the role's colour; the `boxShadow` is `rgba(0,0,0,
  0.55)` over a `#11111b` crust and so is invisible either way, on both platforms; and the haptic
  tick cannot be judged on an emulator. Also observed: `move-window` carries no `-d`
  (`src/tmux-model.ts:341`), so a reorder ALSO makes the moved window active — the poll went to
  `windowIndex: 7`. Not in the Expect, shared with iOS, worth a decision.

### T10.10 — + births a new terminal out of the button
- **Steps**: open the switcher, tap +.
- **Expect**: a new terminal grows out of the + button's corner to full screen (Safari
  new-tab); the PTY is sitting at a fresh shell in a new tmux window (tmux switched the
  attached client); exec log shows `new-window`; the badge shows the new index; reopening the
  switcher shows one more card and the header count up by one.
- iOS: [ ]
- Android: [x] — 2026-08-17. `[switcher] new window` + `[ribbon] forWindow 8 fish (new window)`;
  host gained `8 fish` and made it active; the PTY landed on a fresh fish prompt in `~`; header
  went `3 Tabs` → `4 Tabs` with a fourth card in the grid. Two stale clauses: there is no badge,
  and the birth does NOT grow out of the + button — per `birthCard`'s own comment
  (`src/app/terminal.tsx:1208`, user 2026-08-10) "the new card pops into the grid first, then the
  surface flies into it", and that is exactly what the frames show: the fourth card appears in the
  grid, then the live surface grows out of THAT slot. Rewrite the Expect to match.

### T10.11 — Done ✓ returns to the active window
- **Steps**: open the switcher; scroll or do nothing; tap the ✓ circle.
- **Expect**: the terminal zooms out of the *active* card's slot back to full screen; same
  window as before, nothing selected, no tmux command in the log; keyboard returns.
- iOS: [ ]
- Android: [x] — 2026-08-17. Tapped ✓ from the grid opened on window 2: frames show the pane
  growing out of the top-right (active) card's slot back to full screen with the key bar; still on
  `colors`/`/tmp`; `mInputShown=true` after. The log printed nothing at all between the tap and the
  landing — there is no `[switcher] close` line in the codebase, so silence here is the whole of
  "no tmux command".

### T10.12 — Closing the last window ends the session
- **Setup**: one window left (header says "1 Tab").
- **Steps**: ✕ (or fling) the last card.
- **Expect**: the grid drops, `kill-window` goes out, tmux ends the session, the shell behind
  the PTY exits — and the §4.9 **Disconnected** screen appears with its Reconnect/Setup
  buttons (the T5 state machine, not a crash, not a frozen grid). Reconnect gets a plain
  shell, per §4.9 no auto-attach.
- iOS: [ ]
- Android: [ ]
  - FAILED 2026-08-17 — and the Steps are stale before the Expect even starts. The lone card has
    no ✕ at all and a left fling on it rubber-bands (verified: the card rides the finger 518→208px
    and springs back to 517, window count and `1 Tab` unchanged), per the 2026-08-10 decision in
    the RESOLVED section at the top of this file. So the last window cannot be closed from the
    grid; it has to come from the host, which is what T10A.8 says. What happens then is a failure
    and it is the section-preamble session bug: see T10A.8's note. Rewrite this case to match
    T10A.8 rather than re-walking it as written.

### T10.13 — No haptic on tab select
- **Steps**: with the phone in hand, tap a card to select it; then long-press one to lift it.
- **Expect**: selecting fires **no** haptic (§7 says exactly so — deliberate); the lift does
  (it is a pick-up, not a select). The tabs *circle* on the bar still ticks like every bar
  key (T7's rule, unchanged).
- iOS: [ ]
- Android: [ ]
  - NOT PROVABLE 2026-08-17: an emulator has no haptics engine and Android's
    `performHapticFeedback` leaves no log line, so neither the presence nor the absence of a tick
    can be read here. What IS checkable and did hold: `selectCard` carries the explicit
    `// §7: no haptic on tab select` and no haptic call (`src/app/terminal.tsx:1109`), and dozens
    of selects and lifts during this walk crashed nothing. Needs a hand on the phone.

### T10.14 — Header count tracks reality
- **Steps**: open the switcher with 3 windows; from the laptop `tmux new-window`; wait a
  beat; then `tmux kill-window -t :4`; wait.
- **Expect**: "3 Tabs" → "4 Tabs" → "3 Tabs" within ~2s each, with cards appearing/leaving to
  match — the grid follows tmux even when the phone did not cause the change. (One window
  reads "1 Tab", not "1 Tabs".)
- iOS: [ ]
- Android: [x] — 2026-08-17. Grid open, untouched: `tmux new-window` from the host and the header
  read `4 Tabs` 2.5s later with a fourth card (`extra`/`etc`) in the grid wearing the accent ring;
  `tmux kill-window -t :4` and it was back to `3 Tabs` 2.5s later with the card gone. Ran twice.
  The singular was seen separately when the session was down to one window: the header read
  `1 Tab`.

## T10A — Tab switcher, Android (emulator)

All cases on the Android **emulator** (gated on T3.0's build), connected to the host machine's
sshd at `10.0.2.2`, tmux configured and attached, three windows made beforehand — same harness
as §T10. The transform, grid, cards and gestures are the SAME code as iOS (both design
prototypes share the zoom verbatim, opacity stagger included). **The Android-only bottom bar is
gone** (b427712): the "Done text button · Roboto count · 56dp FAB" arrangement, its five
Android-only styles and its `Platform.select` padding were deleted, and both platforms now draw
iOS's `+ circle | N Tabs | Done ✓`. The FAB is no longer the birth origin — the + circle is, on
both. What is still genuinely Android-only is the system-back subscription. §T10's gesture cases
are not repeated — walk T10A.5 and spot-check the rest only if the bar chrome or back handling
misbehaves.

### T10A.1 — Container-transform enter/exit (tabs tap and bar-swipe-up)
- **Setup**: attached, three windows, window 2 active.
- **Steps**: tap the tabs circle; watch the enter. Tap a card; watch the exit. Then swipe up
  on the bar slowly (terminal shrinks under the finger), release past ~a third of the travel.
- **Expect**: the live terminal shrinks into its card slot with rounding corners and the
  accent ring, fading out only at the end (the card takes over) — the same motion as iOS
  §T10.1/T10.2, per the Android prototype which shares the transform verbatim. The drag-follow
  rides the finger, drifts with it horizontally, and a short release springs back to rest.
- Android: [x] — 2026-08-17, three 30fps captures, evidence written up under the shared cases.
  Enter by tabs tap (T10.1): the live pane shrinks into the active card's slot with rounding
  corners and the `#89b4fa` ring, still opaque most of the way, the card taking over at the end.
  Exit by card tap (T10.5): the same motion in reverse out of the tapped card's slot, ring fading.
  Bar drag (T10.2): the shrink rides the finger continuously, drifts sideways with it, and a short
  release springs back to full screen. No divergence from the iOS descriptions found; iOS side not
  re-shot this session.

### T10A.2 — The bottom bar is the iOS bottom bar
- **Setup**: switcher open. An iOS screenshot of the same switcher — **ask the user**.
- **Steps**: open the switcher; crop the bottom bar at native resolution; compare control by
  control to the iOS shot.
- **Expect**: the same controls iOS draws, in the same places, with the same glyphs — `+ circle |
  N Tabs | Done ✓`, the count in JetBrains Mono at `TEXT.mono`, not the Material substitutes this
  case used to demand ("Done" text button, Roboto count, 56dp FAB). The
  `Platform.OS === 'android'` branch that rendered the alternate bar is deleted (b427712), so
  there is one code path and a difference here means a rendering bug, not a branch.
- Android: [x] — 2026-08-16. Done circle 49.0 x 49.0 at 34.0 right margin on iOS, 49.1 x 49.1 at
  33.9 on Android; the old Android drew a 56dp FAB at a 12dp margin, so both the control and the
  `Platform.select` padding are gone. Count reads `2 Tabs` in JetBrains Mono on both. Side-by-side
  at matched logical scale is indistinguishable.

### T10A.3 — The + circle births a window out of itself (was: the FAB)
- **Steps**: with 3 windows open the switcher, tap the FAB; on the laptop run
  `tmux list-windows`.
- **Expect**: a new terminal grows out of the FAB's bottom-right frame to full screen (the
  container transform's origin — not iOS's bottom-left + circle), lands on a fresh shell,
  keyboard raised; `list-windows` shows 4 windows with the new one active. `[switcher] new
  window` and T9's `new-window` exec line in the log.
- Android: [ ]
  - FAILED 2026-08-17 on the keyboard clause; the rest is stale or passes. Passing: `[switcher] new
    window` logged, host `list-windows` gained a window and made it active, the PTY landed on a
    fresh fish prompt. Stale: there is no FAB any more (see this section's own preamble, b427712)
    and the birth origin is not a button on either platform — it is the new card's grid slot, see
    T10.10's note. **Failing:** the keyboard is NOT raised after the birth. Tested both ways —
    keyboard down before opening the switcher, and keyboard up before opening it — and in both runs
    `mInputShown=false` for 8s+ after the new terminal landed, with the shell reporting its
    full-height `50 × 44` grid. Selecting a card (T10.5) and Done (T10.11) both restore it in the
    same session, so this is the birth path alone: `birthCard` finishes through `springBack`
    (`src/app/terminal.tsx:1234`), whose "nothing to fly home from" branch clears `keysWereUp`
    (`:809`). Shared code, so iOS probably does the same — needs the iOS check to say whether the
    Expect or the app is wrong.

### T10A.4 — Done returns to the active window
- **Steps**: open the switcher, scroll the grid a little, tap Done.
- **Expect**: the terminal grows back out of the active card's on-screen slot (scroll
  respected), same window as before, keyboard re-raised. No `select-window` in the log —
  returning is not a selection.
- Android: [x] — 2026-08-17. Keyboard up, switcher opened, grid scrolled one row so the active
  card sat lower on screen, then Done: the frames show the pane growing out of that card's
  **scrolled** on-screen slot, not its unscrolled one. Same window (host `9 [tmux]` still active),
  `mInputShown=true` after, and the log printed nothing between the tap and the landing — no
  `select-window`.

### T10A.5 — Select, ✕/fling close, long-press reorder still work on Android
- **Steps**: walk §T10.5 (tap selects), §T10.7/T10.8 (✕ and left-fling close, right swipe
  rubber-bands), §T10.9 (long-press lift → drag → drop reorders; laptop `tmux list-windows`
  confirms the order) on the emulator.
- **Expect**: identical behaviour to the iOS cases — the gesture code is shared, so any
  divergence here is an Android RNGH/Reanimated fault worth its own write-up.
- Android: [x] — 2026-08-17. All four were walked on the emulator as their own cases, and all four
  behave as the iOS text describes: T10.5 (tap selects, `[switcher] select @163`), T10.7 (✕ closes,
  `kill @161`, grid reflows), T10.8 (slow-left closes at 1:1, fast flick closes from less travel,
  right drag moves a third and springs back, vertical scrolls), T10.9 (long-press lift → dashed
  placeholder → drop → `reorder`, host order changed, no jump back). One Android-side divergence
  turned up and it IS an RNGH/Reanimated fault: the `boxShadow` alpha red box written up under
  T10.8. Note for whoever repeats this: `adb shell input swipe` never produces a lift — the drag
  cases need `input motionevent` with a real pause between DOWN and the first MOVE.

### T10A.6 — System back closes the grid, never the app
- **Setup**: switcher open.
- **Steps**: press the system back button (or predictive-back swipe from the screen edge in
  gesture nav). Then, with the switcher closed and the terminal up, do NOT press back — that
  level is §T12A-era (see PLAN).
- **Expect**: the grid closes into the active pane — the same exit as Done — and the app
  stays exactly where it was: not backgrounded, not popped to Setup. Back pressed again
  mid-transition is swallowed (nothing double-fires).
- Android: [x] — 2026-08-17. Three `keyevent 4`s 150ms apart from the open grid: the first closes
  it with the same growth out of the active card's slot as Done, and the second and third do
  nothing — after all three `dumpsys activity` still reports
  `topResumedActivity=…port22/.MainActivity`, the screen is the terminal with its key bar, and
  `ui_text` shows no Setup fields. Used the same way half a dozen more times during this walk with
  the same result. (Only the hardware/injected back key; the predictive-back edge swipe is not
  separable on this AVD.)

### T10A.7 — Snapshots refresh while the grid is open
- **Steps**: §T10.6 on the emulator: with the switcher open, `yes | head -50` from the laptop
  in another window's pane; wait ~2s beats.
- **Expect**: that window's card repaints with the new output while the grid stays open.
- Android: [x] — 2026-08-17. Grid open and untouched, `yes | head -50` sent to the `wind` window
  from the host: within one ~2s beat that card repainted from its neofetch banner to a column of
  `y`s, every other card and the scroll offset unchanged. (A `watch -n1 date` card ticking three
  times across 15s is the same evidence, recorded under T10.6.)

### T10A.8 — Closing the last window ends the session
- **Steps**: §T10.12 on the emulator: close windows until one remains (its ✕ is gone and a
  left fling rubber-bands — unkillable from the grid); from the laptop `tmux kill-window` the
  last one.
- **Expect**: the grid drops, §4.9's Disconnected state owns the screen; no crash, no orphan
  grid over a dead PTY.
- Android: [ ]
  - FAILED 2026-08-17, and this is the one that proved the session bug in the T10 preamble. Setup
    half passes: down to one window the card has no ✕ and a left fling rubber-bands (card rides
    518→208px and springs back to 517, header stays `1 Tab`, nothing killed). Then
    `tmux kill-window -t t13walk4:9` from the host, which ends the session. **The grid did not drop
    and §4.9 never appeared. The switcher re-listed and drew the USER'S OTHER SESSION** — two cards
    reading `claude`/`ClaudeLoop` and `fish`/`kamil`, header `2 Tabs`, the `claude` card wearing
    the accent "active" ring and a live ✕ — i.e. exactly the "orphan grid over a dead PTY" this
    Expect forbids, pointed at somebody else's work. Log for the same moment:
    `[switcher] 1 of 1 captures failed: @172(:9) … Command exited 1` (benign, that is the window
    just killed) followed by `[tmux] {"attached":false,…}`, so the app KNEW it had lost its
    session and re-listed anyway. Closing the grid with back left the PTY at a bare shell showing
    `[exited]` under the startup line, with the tabs circle correctly greyed — so the only thing
    standing between a tap and `kill-window` on a real Claude Code window was the grid already
    being open. Root cause is the unscoped `tmux list-windows` in `src/tmux-model.ts:230` (full
    write-up in this section's T10 preamble). Two fixes are needed and they are separate: scope
    every window command to the session this PTY is attached to, and make the poll's
    `attached:false` tear the grid down into §4.9 instead of re-listing.

## T11 — Bar-swipe window switching + context ribbon

All cases: a real host with configured tmux, session attached, three windows unless said
otherwise. The swipe logs as `[barswipe] …`, the ribbon as `[ribbon] …`; T9's `[ssh] exec`
lines show `capture-pane`, `select-window` and the kill-force command going out on exec
channels, never through the PTY. Ribbon foreground reactions ride the ~2s poll — allow a beat
wherever a process starts or stops; alt-screen reactions (`[session] modes`) are instant.

*(2026-08-16: T11.7–T11.17 rewritten for the Accessory redesign (docs/ribbon-redesign.md §7).
The 5pt breathing tab and the vertical glass panel are both gone. The recipe now lives in ONE
52pt opaque band pinned just above the bar: at rest a 44pt chip on the trailing edge — glyph,
process name, live clock — which tap (iOS: or swipe-left) unrolls leftward into a horizontal row
of 44pt caps. Worst case is best case: three caps and thirteen are the same 52pt. Two behaviours
to check that are new rather than moved: `running` no longer appears at all until the process has
been alive 3s, and the key bar stays LIVE while the band is open.)*

### T11.1 — Bar swipe hops a window: slide, pills, live redraw
- **Setup**: attached, three windows, window 1 active, keyboard up.
- **Steps**: touch the bar and drag slowly left ~100pt; release.
- **Expect**: the moment the drag classifies horizontal the bar keys fade out and tab-name
  pills fade in — the centred pill is the current window's name, the next name sliding in
  from the right as the pages move; the terminal slides left as a page card with rounded
  corners, the neighbour page sliding in beside it with a gap. On release past ~70pt the
  slide completes, the badge says 2, and the PTY shows window 2 live (typing works
  immediately). Log: `[barswipe] start at 0 of 3`, `[barswipe] commit → window …`, and an
  exec `select-window` — nothing typed into the PTY.
- iOS: [ ]
- Android: [ ]

### T11.2 — Neighbour preview is a real, fresh snapshot
- **Setup**: window 2 running `watch date` (leave it a while); window 1 active.
- **Steps**: swipe the bar left slowly and hold half-way; read the incoming page.
- **Expect**: the incoming page shows `watch date`'s *current* output in colour — a
  `capture-pane` taken at swipe start (the exec log shows it fire on touch, not earlier), not
  a stale image from the last switcher visit. A blank page for the first ~100–300ms of the
  drag is accepted (§4.4); the content attaches mid-slide.
- iOS: [ ]
- Android: [ ]

### T11.3 — Rubber-band at the ends
- **Steps**: on the first window, drag the bar right ~90pt and hold; release. Repeat on the
  last window dragging left.
- **Expect**: the page follows at a third of the finger's travel (heavy, stretchy), no
  neighbour appears, and release springs straight back — no commit, no `select-window` in the
  log, badge unchanged.
- iOS: [ ]
- Android: [ ]

### T11.4 — Flick vs slow drag decide differently
- **Steps**: from window 2: (a) flick the bar left fast, ~40pt of travel; (b) drag left
  slowly to ~40pt and release; (c) drag left slowly past ~80pt and release.
- **Expect**: (a) commits — a short fast swipe is enough; (b) springs back — same distance,
  slow, is a cancel (`[barswipe] cancel`); (c) commits — a slow drag needs the full ~70pt.
- iOS: [ ]
- Android: [ ]

### T11.5 — Cancel springs back clean
- **Steps**: drag left ~40pt slowly, release; keep typing.
- **Expect**: the pages spring back (0.32s ease-out), corners square up, pills fade back to
  the keys, the badge never changed, and the next keystroke lands in the same window. A new
  swipe started immediately after works.
- iOS: [ ]
- Android: [ ]

### T11.6 — Vertical claim intact: swipe-up still drags the switcher
- **Steps**: keyboard up: swipe the bar up slowly (T10.2's gesture); then down; then
  horizontal.
- **Expect**: up still drags into the switcher zoom, down still hides the keyboard —
  unchanged from T7/T10 — and only a clearly-horizontal pan starts the page slide. One
  gesture never becomes the other mid-drag.
- iOS: [ ]
- Android: [ ]

### T11.7 — `sleep 100` → green chip with a ticking clock; ^C cap kills it
- **Steps**: type `sleep 100⏎`; watch the trailing edge for ~5s; tap the chip; read the band;
  tap the `^C stop` cap.
- **Expect**: nothing for the first 3s (T11.16 owns that gate), then a 44pt opaque chip fades
  up just above the bar, flush to the trailing edge: ▶ glyph in green, `sleep`, ` · 0:0x`
  ticking once a second. It nudges sideways ~2.5pt three times and then holds perfectly still
  — it must never oscillate indefinitely. The terminal does NOT resize or rewrap when it
  arrives. The tap unrolls the band leftward over the bottom ~3 rows: an opaque plate carrying
  `! kill force` (red, bold, with a ⚠) · `^Z bg background` · `^C stop`, right-aligned hard
  against a divider and the chip. The `^C` tap rolls the band back up, prints `^C`, the prompt
  returns, and the chip leaves on the next poll beat — again with no reflow. Log:
  `[ribbon] open sleep`, `[ribbon] cap ^C`.
- iOS: [ ]
- Android: [ ]

### T11.8 — ^Z from the chord strip → grey `· stopped` chip; fg resumes
- **Steps**: `sleep 100⏎`; arm Ctrl, tap the chord strip's `Z`; wait a beat; tap the chip;
  tap `fg resume`.
- **Expect**: the shell shows `[1]+ Stopped`; within ~2s the chip swaps to a grey ⏸ glyph and
  reads `sleep · stopped` (no clock — the job is not running), and it appears at ONCE, with no
  3s wait: the gate is `running`'s alone. Caps: `! kill force` · `bg run behind` · `fg resume`.
  The `fg` tap closes the band, types and runs `fg`, and the green running chip (fresh clock)
  is back on the next beat. Identical for a Ctrl+Z typed on the keyboard.
- iOS: [ ]
- Android: [ ]

### T11.9 — Open, close, and the key bar staying live; vim caps work from insert mode
- **Steps**: `vim /tmp/t11.txt⏎`; press `i` and type a line (stay in insert mode). Open the
  band by tapping the chip; **while it is open, tap `Esc` on the key bar**; open again and tap
  the chip to close; open again and tap the terminal well above the band; on iOS open once
  more by swiping the chip left; on Android open it and press hardware back. Then open and tap
  `:w`; type more; open, tap `ZZ`. Re-open vim, dirty the buffer, tap the red `:q!`.
- **Expect**: vim keeps its full screen — the band floats over the bottom rows and never
  reflows it. **The `Esc` tap fires Esc**: the dismiss catcher stops at the band's top edge, so
  the bar is live while the band is open (the old full-screen scrim ate that tap — this is the
  fix, and combining a cap with Ctrl is now possible). All four closes work: chip tap, terminal
  tap, back (Android), cap tap. Caps left→right: `! :q! discard` (red) · `:q quit` ·
  `/ search` · `ZZ save+quit` · `:w save`, the last hard against the chip. On a 375pt phone the
  row scrolls ~46pt and a `›` chevron shows at the leading edge; on a wider phone it does not
  scroll at all. `:w` saves *from insert mode*; `ZZ` saves and quits; `:q!` discards.
- iOS: [ ]
- Android: [ ]

### T11.10 — less: q, / raises the keyboard and the band stays open, g/G jump
- **Steps**: `man ls⏎`; open the band; tap `G`, reopen and tap `g`, then tap `/` (type
  `SYNOPSIS⏎`), then — without reopening — tap `n`; finally tap `q`.
- **Expect**: caps `q quit` · `G end` · `g top` · `n next hit` · `/ search`. `G` jumps to the
  end, `g` back to the top. `/` puts less's search prompt up, **raises the keyboard, and the
  band stays open and rides up with the bar in one step** — so `n` is one tap away on the
  keyboard's top edge, with no independent animation and no gap or overlap against the bar.
  `q` exits and the band leaves.
- iOS: [ ]
- Android: [ ]

### T11.11 — htop: q, / filter, F6 sort, F9 kill
- **Steps**: `htop⏎`; open the band; tap `/`, type a name, Esc; tap `F9`; Esc; reopen, tap
  `F6`; Esc; reopen, tap `q`.
- **Expect**: `/` opens htop's filter with the keyboard raised and the band still up; the red
  `! F9 kill` cap opens htop's SendSignal column and `F6` its sort column (`CSI 20~` /
  `CSI 17~`); `q` exits. Four caps fit without scrolling on any phone.
- iOS: [ ]
- Android: [ ]

### T11.12 — Agent band: the scroll tape, ⇧⇥, 📎, and the two-tap quit
- **Setup**: `claude` (or any process whose `pane_current_command` is on the agent list)
  running in the pane.
- **Steps**: tap the peach ✳ chip (it carries a ticking clock — agents are live); read the
  band; flick the row left and right; tap `/context`; reopen and tap `⇧⇥ plan mode`; reopen,
  tap `📎 attach`, pick a photo, watch; reopen and tap the red `^C ^C quit` once, read it,
  then tap `/clear` instead; reopen and arm it again, this time tapping it twice.
- **Expect**: the band is still exactly 52pt tall — the same as `sleep`'s three caps. Ten caps in
  ONE flat row, no section markers (2026-08-16: they cost 44pt of reach each to label groups the
  caps already spell out). It rests at the leading end with `! ^C^C quit` · `/clear` · `/context`
  visible and a `›` chevron in its own gutter saying there is more — the chevron must never sit on
  top of a cap and slice its label. One flick reaches the rest of the slash commands, two reach
  📎 / ⇧⇥ / ⎋. The row never scrolls vertically and a
  near-vertical drag on it does nothing. `/context` types the command and presses Return and
  the band closes. `⇧⇥` cycles plan mode. `📎` opens the picker; during the send that cap
  alone tints accent and goes inert while the others stay live; then the remote path + one
  trailing space is typed — no Return (T8.16). The first `^C ^C` tap sends one interrupt,
  keeps the band open and re-labels the cap `tap again` (stronger red ring, disarms itself
  after ~3s); **tapping `/clear` instead disarms it without sending the second interrupt** and
  runs /clear. Two taps in a row quits claude and closes the band. Log:
  `[ribbon] cap /context`, `[ribbon] cap ^C ^C`, `[ribbon] band 9xx/2xx scroll=true`.
- iOS: [ ]
- Android: [ ]

### T11.13 — The silences: idle shell, REPL, unknown TUI
- **Steps**: sit at the prompt 5s; run `python3` and sit at `>>>` 5s; `exit()`; run an
  alt-screen app not on any list (e.g. `nano` or `nethack`) 5s.
- **Expect**: no chip in any of the three — shell is idle, a REPL at its prompt is not a job,
  an unknown TUI gets no caps (§4.4). The `[tmux]` log shows the foreground changing, so the
  silence is a decision, not a missed poll.
- iOS: [ ]
- Android: [ ]

### T11.14 — The band rides the chrome and never touches the terminal
- **Steps**: `sleep 100⏎`; raise and dismiss the keyboard; arm Ctrl (chord strip up); disarm;
  open the band with the keyboard up; open it and start a bar swipe-up into the switcher.
- **Expect**: the band always sits 6pt above the bar stack — it rides up with the keyboard and
  with the chord strip (bottom chrome then stacks to ~172pt, which is a lot but transient) and
  back down, in the same step as the bar, never lagging on its own baseline. Grabbing the bar
  for the switcher closes the band and fades it out with the bar; it is never left hanging
  mid-zoom. Through all of it the terminal's rows never rewrap (`[terminal] size` stays quiet
  except for the keyboard's own refit).
- iOS: [ ]
- Android: [ ]

### T11.15 — Kill force: pgrep + kill -9, observable in the log
- **Steps**: `sleep 100⏎`; open the band; tap the red `! kill force` cap; read the log and
  the terminal.
- **Expect**: the log shows `[ribbon] kill-force: pgrep -P <pane_pid> | xargs kill -9 …` and
  the `[ssh] exec` line for it — an exec channel, nothing typed into the PTY. The shell prints
  `Killed`, the prompt returns, the band leaves on the next beat. Same cap from the suspended
  chip (T11.8's setup) kills the stopped job.
- iOS: [ ]
- Android: [ ]

### T11.16 — The lifetime gate: short commands never raise the band at all
- **Steps**: at a prompt, run `ls`, `git status`, `git log --oneline -5`, `echo hi` — a dozen
  quick commands in a row. Then run `sleep 10⏎` and watch a clock.
- **Expect**: **not one chip appears** for any of the quick commands, however many you run:
  `running` matches every non-shell foreground, and ungated it would flash in and out dozens
  of times an hour, which is what makes an unrequested surface feel intrusive. `sleep 10`
  raises the chip ~3s in — by which point kill / bg / stop are the caps you actually want —
  and it fades out when the command ends. A named recipe (`vim`, `less`, `htop`, `claude`) is
  never gated: it appears on the first poll beat.
- iOS: [ ]
- Android: [ ]

### T11.17 — Adversarial readability: the band over the worst content there is
- **Steps**: on a many-core box run `htop` (full-width colour bars); open the band and
  screenshot. Then `bat CLAUDE.md` (dense syntax colour) and repeat. Switch to Latte and
  repeat both outdoors, or at full brightness.
- **Expect**: the plate is fully opaque in every shot — no colour bar, no syntax highlight and
  no bright background shows through it or changes any of its colours, and no cap is harder to
  read in one shot than another. The band's edge stays visible against every one of them (a
  dark stroke with a light one immediately inside it: at least one of the two always separates
  it from what is behind). Danger caps read as red **bold** with a ⚠ — legible on Latte, where
  red on the plate is the tightest ratio in the design. This is the case the old design never
  had: it was measured only against an idle prompt, which is how it shipped at 1.69:1.
- iOS: [ ]
- Android: [ ]

*(T11.18–T11.22 cover the five fixes made after the redesign landed, none of which the cases above
can catch: the clock was frozen at 0:00 by the React Compiler and restarted by every window hop,
the poll answered about other people's windows, a hop's stale answers revived the old window's
process on the new tab, and light schemes had a plate the eye could not find. See BUGS.md's
"foreground poll" entry and docs/ribbon-redesign.md §8.)*

### T11.18 — The chip's clock ticks, and a hop away and back does not restart it
- **Setup**: two windows, window 1 at a prompt, window 2 idle.
- **Steps**: in window 1 run `sleep 300⏎`; watch the chip for 30s without touching anything;
  then bar-swipe to window 2, wait ~5s there, and swipe back. Watch the clock for 10s more.
- **Expect**: the clock **advances once a second** — `0:04`, `0:05`, `0:06` — for the whole 30s.
  (It used to sit at `0:00` for an entire session: `Date.now()` read in the render body is
  memoised by the React Compiler against props that a tick does not change.) The digits do not
  jitter as they change — the meta text is tabular. On window 2 the band leaves. Back on window
  1 the chip returns reading roughly **where it left off** (`0:38`, not `0:00`): it may show
  `0:00` for up to one poll beat while the pid catches up, and must then jump to the true
  elapsed time and keep ticking from there. Log: `[ribbon] forWindow 2 … (bar swipe commit)`,
  `[ribbon] forWindow 1 sleep …`, `[ribbon] run #…`.
- iOS: [ ]
- Android: [ ]

### T11.19 — The poll names our session: no flicker while other windows work
- **Setup**: on the host, before connecting — `tmux new -d -s other 'htop'`, and in the port22
  session put something long-running in window 3 (`sleep 999`). Connect and sit on window 1.
- **Steps**: read the log line printed once at connect. Then run `sleep 300⏎` in window 1 and
  sit perfectly still for 60s, watching the chip, the tabs badge, and the `[tmux]` lines.
- **Expect**: `[tmux] poll aimed at session port22`. Over the 60s the chip stays `sleep` with a
  monotonic clock — it never leaves and comes back, never swaps to another window's process,
  never animates in twice — and `[tmux]` reports the **same** `windowIndex` on every beat with
  the badge steady. (Untargeted, `display-message` answered about whichever window tmux last
  considered current: measured 6 → 7 → 6 → 7 every ~2s with `claude` / null behind it, which
  unmounted and remounted the band forever and made `sleep` unable to outlive the 3s gate.) In
  `custom` or `shell` start mode the log instead says `poll aimed at nothing (untargeted)` and
  the flap is expected there — that is the documented ceiling, not a regression.
- iOS: [ ]
- Android: [ ]

### T11.20 — A hop's stale answers are ignored: the band leaves with the slide
- **Setup**: window 1 running `sleep 300` (chip up), window 2 idle at a prompt.
- **Steps**: bar-swipe from window 1 to window 2 and watch the trailing edge closely for the
  three seconds after the slide lands. Repeat the hop five or six times, both directions.
- **Expect**: the band goes out **with the slide** and stays gone — it must not reappear a beat
  later on the idle tab and then leave again ("the pill stayed"). `select-window` is
  asynchronous, so for a beat or two the poll still describes the window you left; those answers
  are ignored until the window you hopped to answers. Hopping back raises the chip with the
  slide too (T11.18 owns its clock). No case where the band belongs to a window you are not
  looking at.
- iOS: [ ]
- Android: [ ]

### T11.21 — Light schemes: the plate separates itself from the pane
- **Setup**: Settings → a *light* scheme. Do Latte first, then a generated one — Rose Pine Dawn
  is the worst case, and any light scheme from the generated set will do.
- **Steps**: at a prompt with plenty of pale output on screen (`bat CLAUDE.md`, or just `ls`
  a few times), raise the band with `sleep 100` and open it.
- **Expect**: the band is **findable** — its foot casts a soft shadow onto the pane and the
  plate reads a touch darker than the background behind it. (`theme.panel` is only
  `mix(bg, black, 0.04)` on the 22 generated schemes — 4%, against 20% on the dark ones — so the
  band was invisible against the pane it floated over, and Latte's mantle on base is 1.05:1. An
  opaque plate cannot separate itself from a ground it matches: it now floats on a shadow on
  both platforms, plus a 6% black ground on light schemes only.) The shadow must not read as a
  dark bar or a border; the caps' own contrast is T11.17's business.
- 📸 one shot per light scheme, band open.
- iOS: [ ]
- Android: [ ]

### T11.22 — Reduce Motion: nothing moves, and everything is visible
- **Setup**: iOS Settings → Accessibility → Motion → Reduce Motion **on**. (Android:
  Settings → Accessibility → Remove animations.)
- **Steps**: run `sleep 100⏎` and watch the arrival; open and close the band twice.
- **Expect**: the chip **fades** in rather than gliding up, plays **no** sideways nudge, and is
  fully visible and perfectly still. Open and close are instant — the width jumps, the caps do
  not fade in. Nothing is missing or invisible: the old design's failure mode was the opposite
  (Reanimated resolves a neutered `withRepeat` to its end value, which made the shipped handle
  *brighter* under Reduce Motion). Turn the setting back off and confirm the nudge returns: three
  cycles on arrival, then still forever — it must never oscillate indefinitely (WCAG 2.2.2).
- iOS: [ ]
- Android: [ ]

## T12 — Settings sheet + polish pass

All cases: connected to a real host unless said otherwise. The sheet's decisions (dictation
filter, line tracker, swipe-dismiss release) are unit-tested (`src/input-model.test.ts`);
these cases are the finger half. T7's preamble note about a "T12 stub alert" is history —
the sheet is real now, and every Settings mention below means the bottom sheet.

### T12.1 — The sheet opens from both doors, over the live terminal
- **Steps**: run `top` so the terminal is visibly alive; tap ⋯ → Settings; swipe the sheet
  away; two-finger-tap the grid.
- **Expect**: both doors slide the same sheet up over the still-updating terminal (top keeps
  refreshing behind the scrim); the keyboard goes away as it opens. Sections APPEARANCE
  (Auto + four flavour swatch rows + font stepper), TMUX (toggle + status + explainer),
  SESSION (Disconnect in accent, Forget host key in red). No host/port/user/startup fields
  anywhere on it. Log: `[settings] sheet open`.
- iOS: [ ]
- Android: [ ]

### T12.2 — Grabber swipe dismisses; there is no Done
- **Steps**: open the sheet; drag it down slowly past ~a third and release; reopen; flick it
  down fast from a short drag; reopen; drag 50pt and release slowly; tap the scrim; tap the
  grabber.
- **Expect**: the sheet rides the finger (never above its rest position), releases past the
  distance or on a flick slide it out, the short slow release springs it back. Scrim tap and
  grabber tap both close it. No Done button exists. The keyboard comes back on close.
- iOS: [ ]
- Android: [ ]

### T12.3 — A flavour tap restyles the live session, no reconnect
- **Setup**: `vim` open with syntax colouring, sheet up.
- **Steps**: tap Latte, then Frappé, then Mocha, watching terminal and chrome.
- **Expect**: on every tap the terminal grid, the key bar plates, the sheet itself and the
  check mark all restyle immediately; the SSH connection never blips (vim stays exactly
  where it was, `[session]` log shows no reconnect). Sub-second, no remount flash.
- iOS: [ ]
- Android: [ ]

### T12.4 — Auto follows a system appearance flip live
- **Setup**: theme = Auto, connected, sheet closed.
- **Steps**: Control Centre → toggle system dark mode both ways.
- **Expect**: the app flips Mocha ↔ Latte on its own, terminal and chrome together, session
  live throughout. The keyboard appearance follows on its next raise.
- iOS: [ ]
- Android: [ ]

### T12.5 — Font stepper: 8 and 32 are walls, the size survives a restart
- **Steps**: step − repeatedly to 8 (keep tapping); step + to 32; set 13; kill the app,
  relaunch, reconnect, reopen the sheet.
- **Expect**: every step reflows the live grid (tmux redraws — T9's conf sets the resize
  hooks); the stepper stops dead at 8 and 32 (extra taps change nothing, no haptic);
  after the relaunch the sheet still says 13 pt and the grid is drawn at it.
- iOS: [ ]
- Android: [ ]

### T12.6 — Tmux toggle: off removes the tabs button, on pushes and verifies
- **Setup**: tmux attached, tabs button visible, status row reads `applied`.
- **Steps**: toggle Configure tmux off; look at the bar; toggle it back on; watch the log.
- **Expect**: off → the tabs button disappears at once and the status reads `off` (nothing
  is pushed or unpushed — remote state untouched). On → `[tmux] configure: applied` without
  a reconnect (the mid-session push), status back to `applied`, tabs button returns.
- iOS: [ ]
- Android: [ ]

### T12.7 — Disconnect goes to Setup
- **Steps**: open the sheet, tap Disconnect.
- **Expect**: sheet drops, session ends (`[session] … idle`), the Setup screen is up with
  the host form editable. No auto-reconnect behind it.
- iOS: [ ]
- Android: [ ]

### T12.8 — Forget host key: confirm-gated, next connect asks again
- **Steps**: sheet → Forget host key → read the dialog → Cancel; again → Forget; Disconnect;
  connect again.
- **Expect**: the dialog names the endpoint and warns in the §4.1 wording; Cancel changes
  nothing (reconnect goes straight through). After Forget, the next connect raises the TOFU
  fingerprint prompt as if the host had never been seen. The mismatch screen's own Forget
  (T5) still exists — it is the only door when a mismatch blocks connecting.
- iOS: [ ]
- Android: [ ]

### T12.9 — Dictation: the prepended space is dropped at an empty prompt, kept mid-line
- **Steps**: at a fresh prompt, mic key → dictate "ls" → stop; ⏎. Then type `ls` (no ⏎),
  mic key → dictate "minus la" → stop.
- **Expect**: the first dictation lands as `ls`, not ` ls` — the command runs. The second
  lands as `ls -la` — the space iOS prepends mid-line is the join it meant, and it stays.
- iOS: [ ]
- Android: [ ]

### T12.10 — A real spacebar at an empty prompt always sends
- **Steps**: at a fresh prompt, press the spacebar once; type `echo hi`; ⏎.
- **Expect**: the space goes through (the shell shows ` echo hi` — with a fish/zsh
  space-prefix history rule, that is also the proof it arrived). Single-char inserts are
  never eaten by the filter.
- iOS: [ ]
- Android: [ ]

### T12.11 — Held backspace repeats
- **Steps**: type a long line (~30 chars); hold the delete key until the line is gone and
  keep holding ~2s more.
- **Expect**: deletes auto-repeat and accelerate (iOS's own keyboard repeat driving the
  diff path); when the line is empty the extra held time does no harm — and a backspace at
  an already-empty prompt still reaches the shell (the bell rings): that is the
  `onKeyPress` empty-field path, which the diff cannot see.
- iOS: [ ]
- Android: [ ]

### T12.12 — vim and tmux are told about a theme flip (`?996n` + DECSET 2031)
- **Setup**: a vim with `set background=dark`-sensitive colours (or `fish` 4, which
  subscribes to DECSET 2031), theme = Auto.
- **Steps**: flip system dark mode; watch vim/fish; also `printf '\e[?996n'` and read the
  reply before and after the flip.
- **Expect**: the query answers `CSI ?997;1n` (dark) before and `CSI ?997;2n` (light) after
  — the reply tracks the *current* flavour; and the flip itself pushes the same notification
  unprompted, so a subscriber redraws without asking (fish re-queries, vim plugins that
  watch it flip their background).
- iOS: [ ]
- Android: [ ]

### T12.13 — 120Hz: scroll and coast are ProMotion-smooth
- **Steps**: on a ProMotion iPhone, flick-scroll a long scrollback; open/close the sheet.
- **Expect**: visibly 120Hz-smooth (subjective — compare against a Camera-app pan);
  `CADisableMinimumFrameDurationOnPhone` is in the built Info.plist (check the ipa if in
  doubt). T6's frame-rate-independent momentum means the coast *distance* is identical
  either way — this case is only about smoothness.
- iOS: [ ]
- Android: [ ]

### T12.14 — Launch screen and icon are the app's own, in both appearances
- **Steps**: check the home-screen icon; kill and relaunch in system dark, then in system
  light.
- **Expect**: the icon is the Catppuccin `>_` on crust (not the Expo template); the launch
  screen is crust-dark with the blue glyph in dark mode, Latte-crust with Latte blue in
  light. No white flash between splash and the first screen in dark mode.
- iOS: [ ]
- Android: [ ]

### T12.15 — Colour sweep: all four flavours, every screen, no strays
- **Steps**: for each of Mocha, Latte, Frappé, Macchiato: walk Setup, terminal + bar,
  chord strip, all three popovers, upload sheet, switcher grid, ribbon, settings sheet,
  and the three §4.9 status faces.
- **Expect**: everything recolours per flavour via the roles — no Mocha-only hex stranded
  anywhere (Latte is where a stray shows instantly: dark text on dark chrome). The
  overlay-grey key tints and hairlines are *meant* to be the same literal on all four
  (prototype spec), as is the toggle knob's white.
- iOS: [ ]
- Android: [ ]

### T12.16 — Final cross-feature regression walk (the T13 seed)
After all T12 changes, re-run the headline case of each earlier section — one line each:
- T6.5 — momentum flick coasts, a touch stops it dead.
- T7.1 — Ctrl → `C` chord kills a running `sleep` (the tracked-send seam changed T7's path).
- T8.16 — quick-attach lands in `/tmp/port22` and types the path + trailing space.
- T9.1 — a fresh host gets conf + source line + verified `applied`.
- T10.2 — bar-swipe-up drag opens the switcher, cancel springs back.
- T11.1 — horizontal bar swipe hops a window with pills + live redraw.
- iOS: [ ]
- Android: [ ]

### T12.17 — Hold-space walks the cursor, and an edit lands where it was left
- **Steps**: at a plain prompt (no alt-screen app), type `abcdefgh` and do not press ⏎.
  Hold the spacebar until the keys grey into the trackpad; **note where the cursor is
  the instant it greys, before moving**; drag left about four characters' worth; let the
  spacebar go; type `X`.
- **Expect**: the cursor does not move on the grab itself — iOS parks the *field's* caret
  at a document edge there, and following that once drove the line's cursor to column 0
  every time (see `caretKeys`). Dragging then walks the cursor about one column per column
  of finger travel at the default font size. The line reads `abcdXefgh`: the shell's cursor
  and the field's caret sit at different offsets after a grab, and that is fine — each side
  edits at its own cursor and the diff only ever says *what* changed.
- **Also**: drag past the start of the line — the shell's cursor stops at column 0 while the
  field's keeps going, so the two rubber-band apart until the drag comes back. Stated
  ceiling, not a bug; the terminal's own cursor is the thing being watched.
- **Seen on device (2026-08-12)**: where iOS parks the caret on grab varies, and when it parks
  at 0 there is no leftward room at all — the drag has to go right first to buy some. Walked
  in a plain shell and under Claude Code, which runs the alt screen with DECCKM on, so the
  SS3 form of the arrows is covered too.
- iOS: [x]
- Android: [ ]

### T12.18 — The other 22 schemes wear their authors' colours, not our arithmetic
- **Setup**: `c9501ba` gave every generated scheme published chrome roles where upstream ships
  one and a measured floor where it does not. `bun test` already holds the numbers
  (`src/core.test.ts`, "no theme is quieter than the family it is matched to"); this case is the
  half a ratio cannot see. T12.15 walks the four Catppuccin flavours — this one walks the rest.
- **Steps**: in Settings, pick each of Nord, Dracula, Gruvbox Dark, Ayu Mirage, Rose Pine, Tokyo
  Night, GitHub Dark, Solarized Light, Everforest Light and Rose Pine Dawn. On each: look at the
  terminal with `ls --color` and something printing bright white on screen, raise the ribbon with
  `sleep 100`, open the settings sheet over it, and open Forget host key.
- **Expect**: on every one of them —
  - **nothing is invisible against its own ground**: the sheet and the ribbon plate read as a
    sheet (`panel` is a dL* step now, not a fraction of what is left — 20% toward black moved
    1.14 on GitHub Dark, which is what made three schemes' panels vanish);
  - **bright white is not the background**: Solarized Light and Everforest Light had `ansi[15]`
    equal to their own background, so bold white text disappeared — it must be legible;
  - **danger is red, not the accent**: Forget host key and the ✕ read as destructive and are
    plainly a different colour from the accent — all 22 used to hand `danger` the same peach;
  - **placeholder is not muted, and an empty field does not look filled in**; hairlines are
    findable without being loud.
- **Not expected**: WCAG. The floors are the minimum the four flavours already hit (Latte's own
  hairline is 2.30:1); a scheme dimmer than the floor is only a fault if the author did not
  publish that colour — where they did, the published value wins on purpose.
- 📸 one shot per scheme, settings sheet over the live terminal.
- iOS: [ ]
- Android: [ ]

### T12.19 — The screens the prototype never covered stopped improvising
- **Setup**: `35ebc7d` moved every repeated number into `src/style.ts` and pulled the drifts back
  to the design. Settings, the switcher and the key bar were faithful already and only got
  renames — **the drift was Setup, the browse sheet and the status block**, so those are what
  this case looks at. The reference is the iOS build (the prototype file it named is deleted).
- **Steps**: on the Setup screen, press and hold each button; connect, open ⋯ → a picker → the
  destination sheet, and hold a row; force a status face (wrong password, or pull the host).
- **Expect**: Setup's cards carry the same 16pt corner as every other card in the app (they were
  12), rows are inset the same 16 on both sides (they were 14/16), the group header is a header
  rather than body prose, its dividers are the translucent grey the rest of the app draws (they
  were opaque), and **both buttons answer a touch** — they used to take a press with no feedback
  at all. The browse sheet is inset 20 on every block (it was 18 throughout) and its name field
  sits centred rather than clipped high. Status actions no longer wear a field's corner and do
  respond to a touch.
- **Also**: on a **light** scheme, the plate's hairline is not a white line on a near-white
  surface — it was hardcoded to its dark value while the tint beside it was already branched.
  `plateEdge` (was `glassEdge`) takes it off `theme.foreground`, which fixes it for all 26.
- **Not to be measured against a grid**: 7 *and* 8 on gaps, 11.5 and 12.5 on captions are the
  prototype's own hand-tuning and are correct as they are. The single-element numbers (9×13
  swatch, 38×30 stepper key, the two sheets' deliberately different shadows) stayed at their call
  sites by design.
- 📸 Setup and the browse sheet, one light scheme and one dark.
- iOS: [ ]
- Android: [ ]

### T12.20 — The perf work holds on a Release build, and the flag nobody measured
- **Setup**: a **Release** IPA, not the dev client — dev-client frame rates are not the app's
  (see `docs/perf-audit.html` for what was changed and the twelve findings that were rejected).
  Perf overlay on, one live session under load (`yes` piped through something, or a `seq 1 50000`
  dump), Metro logs visible.
- **Steps**: (a) dump a large burst of output and watch the overlay while it lands; (b) with the
  burst still running, drag the settings sheet down by its grabber; (c) flick-scroll a deep
  scrollback and let it coast; (d) type a 6-char query into the terminal's search bar.
- **Expect**: (a) the burst is one webview crossing per turn, not one per PTY read, and every
  chunk reaches the screen exactly once and in order (`session.test.ts` holds that invariant;
  here it is the eye's job — no duplicated or dropped block); (b) the dismiss pan tracks the
  finger while the session is still pumping bytes — it is a UI-thread gesture now and must not
  stutter behind the output; (c) the coast is smooth and its *distance* does not change with the
  frame rate (T12.13's other half); (d) the highlight keeps up with the character being typed
  (120ms debounce, deliberately not the grep's 300).
- **The measurement this case exists for**: `reanimated.staticFeatureFlags.
  IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS` is the one perf change with **nothing behind it** (BUGS.md,
  "Not a bug"). It is compiled in, so it needs two Release builds: same session, same load, read
  the overlay's **UI** figure (not JS — the flag does not touch JS) with it on and with it off.
  Record both numbers here. If it does not show, take it out.
- iOS: [ ]
- Android: [ ]

## T12A — Android polish (emulator)

All cases on the Android **emulator** (gated on T3.0's build), connected to the host machine's
sshd at `10.0.2.2` — same harness as §T7A/§T10A.

What is legitimately Android-only here is the part the *system* owns: §5d's system-back ladder
(sheet → dismiss, browser → up a directory then dismiss, popover → close, terminal → home; the
switcher's rung is §T10A.4), the runtime permission prompts, the adaptive/themed launcher icon,
and edge-to-edge under the status bar and gesture pill.

**Everything about the look is not Android-only any more** (2026-08-16 — AGENTS.md, "One app, two
platforms"). Where a case below says "28dp Material corners" or "hand-drawn bottom-sheet look",
read it as inverted: the sheet has to have the *iOS* corner and the *iOS* look, reached through
whatever Modal mode Android needs to get there. Those numbers came from a deleted design file.

`SHEET_RADIUS` no longer branches — it is 24 on both (b427712). The upload sheet's Modal branch
stays, because `presentationStyle="pageSheet"` is an iOS-only Modal mode and Android has to
hand-build the equivalent; that is a permitted category-(1) branch, and the *result* is what these
cases judge. Three numbers on it are still unmeasured and want settling here: the `insets.top + 46`
top gap, the footer inset above the home indicator, and whether iOS's system pageSheet corner is
really 24. One side-by-side screenshot settles all three.

### T12A.1 — Settings sheet: matches iOS, swipe-dismiss, back dismisses
- **Setup**: connected, keyboard up.
- **Steps**: ⋯ → Settings; look at the sheet; drag it down past a third and release; reopen;
  press system back.
- **Expect**: the sheet is the iOS sheet — same top corner radius (`SHEET_RADIUS` 24, one value
  for both), same ground, same cards, and **no blur on either platform** (**ask the user for an
  iOS screenshot**; both the old "28dp Material corners" and the later "same blur as iOS" are
  void — see T7A.1 for why blur left both builds). The swipe-dismiss rides the finger and releases exactly as on
  iOS (same tested rule). System back dismisses the sheet with the slide-out — it never pops the route
  or reaches the terminal. Log: `[settings] sheet closed`.
- Android: [ ] — **look verified 2026-08-16, behaviour NOT.** The corner is confirmed: the arcs
  are the same curve on both, iOS inset `10.7 / 5.0 / 2.3 / 0.0` at dy `4.0 / 9.3 / 13.3 / 21.3`
  against Android `9.9 / 5.0 / 2.3 / 0.0` at dy `4.6 / 9.1 / 13.7 / 21.7`, both fitting r=24.
  Material's 28 is gone. Grabber, section headers, mono values and the accent/red action rows all
  match; no blur either side. Heights are not comparable in that run and it is not a defect — the
  two were in different states (iOS on tmux so it drew a TMUX section, Android on a plain shell;
  iOS with Follow-system off so it drew one Theme row where Android drew Dark + Light).
  **Still to walk: the drag-past-a-third release and the system-back dismiss.** Neither was
  exercised — an unrelated error closed the sheet before back was pressed, so the press that was
  observed landed on the terminal, not the sheet.
- **Finding, switch colours (fixed).** The `Switch` is a native control on both — UISwitch and
  Material's — and its PROPORTIONS differing is expected and not chased (user, 2026-08-16: native
  differences are fine, do not build custom components). Its colours are ours, and were not being
  set: only `trackColor.true` was, so Android took its thumb from the Material default — a teal
  that appears nowhere in this app, against iOS's white. Now routed through `switchColors()` in
  `src/settings-sheet.tsx`: themed track (both states) and a thumb that is the pale end of the
  scheme on both. Re-check the colours here on the next pass; the shapes will still differ, by
  design.

### T12A.2 — Upload sheet: bottom-sheet look, browse, back goes up a directory
- **Setup**: connected; a host directory tree at least two levels deep under `$HOME`.
- **Steps**: ⋯ → Files, pick a file; in the browser descend two directories; press system
  back twice; press it repeatedly until the sheet is gone; note when it dismissed.
- **Expect**: the sheet is not full-screen — the iOS top corner radius, a gap above showing the
  terminal, tap on the gap cancels. (Android needs a different Modal mode to get there, which is
  allowed; the *result* must match iOS. **Ask the user for the iOS shot** to set the corner.) Each back walks up exactly one directory (breadcrumb and
  listing follow, same as tapping `..`); from `/` — where the `..` row also disappears — back
  dismisses the sheet instead. Nothing typed into the session at any point.
- Android: [ ] — **look verified 2026-08-16 and the construction changed underneath this case;
  behaviour NOT walked.** The sheet no longer imitates a system surface: `presentationStyle=
  "pageSheet"` is gone from iOS and both platforms build it the way `src/settings-sheet.tsx`
  already did (374d156). That was forced by measurement — the hand-built Android replica sat at
  97.9dp from the top where iOS's system sheet sat 69.0pt (`insets.top + 46`, a number this file
  had itself flagged as never measured), and iOS's system corner is ~35 drawn with CONTINUOUS
  curvature, which RN cannot express at all. After: corner arcs identical, iOS inset
  `10.7 / 5.3 / 2.7 / 0.7` and Android `10.7 / 5.3 / 2.7 / 0.8` at dy `4 / 9 / 13 / 18`, both
  r=24; the top gap is one formula on both (`insets.top + SPACE.sm`, 76.0 vs 59.8) and the
  residual is each device's own safe area. Thirteen `ANDROID` branches became four, all
  behaviour. **Still to walk: descending two directories, back walking up one at a time, and the
  dismiss from `/`.** Android's listing could not be read in that run — see the note below.
- **Known race, not a design issue.** `[upload] sheet could not resolve a start dir: Call to
  function 'ExpoSSH.exec' has been rejected` on Android: the system document picker foregrounds
  itself, the session disconnects behind it, and the sheet opens before the reconnect lands. iOS
  resolved `/ tmp › port22` in the same run. Pre-existing and separate from the parity work.

### T12A.3 — Back closes popovers and the ⋯ menu first
- **Setup**: connected, keyboard up.
- **Steps**: open the ⋯ menu; press back; open the arrows popover; press back; long-press
  Paste (clipboard popover); press back; press back once more with nothing open.
- **Expect**: each press closes just the open popover — the bar, keyboard state and route all
  stay put. The final press (nothing open) is T12A.4's case.
- Android: [ ]

### T12A.4 — Terminal-level back is "home", never a silent pop to Setup
- **Setup**: connected, nothing open over the terminal.
- **Steps**: press system back; relaunch from the recents/launcher; wait for §4.9's
  foreground reconnect; from the Disconnected/Cannot-connect overlay press back again.
- **Expect**: back backgrounds the app (launcher home) — it does NOT pop to the Setup screen
  (the old pop skipped `leave()`'s disconnect; leaving is the sheet's Disconnect / the
  overlay's Setup button's job). Coming back foregrounds into the reconnect flow (§4.9), and
  back from the overlay backgrounds again the same way.
- Android: [ ]

### T12A.5 — Adaptive icon on the launcher, themed/monochrome on 13+
- **Setup**: app installed; emulator API 33+.
- **Steps**: find the icon on the launcher (round mask) and in settings/app-info (squircle or
  square); on API 33+ enable themed icons in the launcher's wallpaper settings; long-press
  the icon for the shortcut popup's small icon.
- **Expect**: every mask shows the `>_` glyph in flavour blue on crust — the same art as the
  iOS icon, never the Expo template's — with the glyph comfortably inside every mask shape
  (safe-zone margins hold). Themed mode shows the monochrome `>_` tinted to the wallpaper
  palette. No white box, no letterboxed square.
- Android: [ ]

### T12A.6 — Splash on cold start, both system themes
- **Steps**: force-stop; launch with the system in dark mode; force-stop; switch the system
  to light; launch again.
- **Expect**: dark start shows the `>_` glyph on Mocha crust, light start Latte crust with
  Latte blue — the same split the iOS splash has (the plugin's root props feed Android 12+'s
  splash). The splash holds until fonts + persisted settings are in (no flash of the wrong
  flavour), then the app is simply there.
- Android: [ ]

### T12A.7 — Status bar and gesture pill across all four flavours
- **Setup**: connected, gesture navigation on.
- **Steps**: in Settings tap Latte, Frappé, Macchiato, Mocha; look at the status bar icons
  and the gesture-pill area each time; then switch the emulator to 3-button navigation and
  glance again.
- **Expect**: edge-to-edge everywhere — the app paints under both bars, SafeAreaView keeps
  content clear. Status bar icons flip dark-on-Latte / light-on-the-dark-three (the themed
  `<StatusBar>` in `_layout`). The pill area is transparent over the app's own background in
  every flavour — no opaque system strip. 3-button nav may draw its own contrast scrim over
  the buttons; that is the system's, not a bug.
- Android: [ ]

### T12A.8 — Pickers open and the permission flow (Files / Photo / Camera)
- **Setup**: fresh install (no permissions granted yet).
- **Steps**: ⋯ → Files (pick any file); ⋯ → Photo or video (pick from the photo picker);
  ⋯ → Camera (expect the CAMERA runtime prompt, grant, take a photo); deny-path: revoke
  camera in app settings, try Camera again, deny the prompt.
- **Expect**: Files opens the system document UI with no permission prompt (SAF needs none);
  Photo/video opens the Android photo picker with no permission prompt (13+); Camera prompts
  once for CAMERA only — never microphone (`microphonePermission: false` blocks
  RECORD_AUDIO) — and a denial alerts "Could not read the file" at worst, types nothing.
  Each picked file then lands in the destination browser flow (§T8's cases own the upload).
- Android: [ ]

### T12A.9 — Gboard sanity: voice input and held backspace
- **Setup**: connected, empty prompt line, Gboard with voice input enabled.
- **Steps**: type `echo hi` by key; hold backspace until the line is empty and keep holding
  ~2s more; then tap the Gboard mic and dictate "hello world"; inspect what the shell got.
- **Expect**: held backspace auto-repeats DELs while the line has content; once the field is
  empty the `onKeyPress` fallback keeps sending — watch for repeats stopping early (Android's
  soft-keyboard `onKeyPress` coverage is the risky half; iOS is the proven path). Dictation:
  the leading-space filter was built against iOS dictation's prepended space — Gboard commits
  text differently (often no leading space, sometimes via a composing region that arrives as
  one chunk). Expected difference, not failure: dictated text may keep or lack a leading
  space; what must hold is that a real spacebar press is never eaten (a single-space insert
  always passes) and multi-char commits reach the PTY intact.
- Android: [ ]

## T14 — Search across every window (deferred to the device phase, 2026-08-10)

Both platforms walk every case; T14.7 is Android-only. Android is **the same layout and the same
chrome as iOS**, not a Material restyle of it (2026-08-16 — AGENTS.md, "One app, two platforms").
`SEARCH_RADIUS` no longer branches: the switcher's field is 13 and the terminal's 38pt field is 12,
on both platforms (b427712).

### T14.1 — The grid narrows on all four match surfaces
- **Setup**: connected, tmux with ≥3 windows: one named `logs`, one whose pane cwd is
  `~/port22`, one running `htop`, and scrollback in some window containing a string (e.g. run
  `echo search-beacon-502`) that appears in no name/cwd/process.
- **Steps**: open the switcher; type, one after another, a window name fragment (`log`), a cwd
  fragment (`port2`), a process name (`htop`), and the scrollback-only string (`beacon-502`).
  Watch the count label and the cards between queries.
- **Expect**: each query narrows the grid to just the matching window(s) — filtered-out cards
  fade in place, survivors pack into the top slots; the label reads "N of M Tabs" (Android:
  "N of M tabs"); metadata matches narrow instantly, the scrollback match lands after the
  ~300ms settle + one grep round trip. Name/cwd fragments show the yellow highlight on the
  card's name/directory label.
- iOS: [ ]
- Android: [ ]

### T14.2 — First occurrence visible and highlighted in the card
- **Setup**: a window whose scrollback holds the query far above the visible screen (e.g.
  `echo needle-x99; seq 1 200`), search armed with `needle-x99`.
- **Steps**: read the surviving card without tapping it.
- **Expect**: the card shows the context *around the hit* (not the pane's bottom), the hit
  ~40% down the card, painted yellow with dark ink. Card colours around it survive (the
  context is a coloured capture). Disarm (✕): the card returns to the live bottom-of-pane
  snapshot on the next beat.
- iOS: [ ]
- Android: [ ]

### T14.3 — No window contains it
- **Steps**: with the switcher open, type a string in no window (`zzqx7`).
- **Expect**: every card falls away, the centered "No window contains “zzqx7”" state shows,
  the label reads "0 of M". Backspacing to a matching prefix brings cards back.
- iOS: [ ]
- Android: [ ]

### T14.4 — Card tap lands armed: highlights, i/N, prev/next, keys as you left them
- **Setup**: search armed on a string with ≥2 occurrences in one window's scrollback. Do it
  twice: once opening the grid with the keyboard down, once with it up.
- **Steps**: tap that window's card; watch arrival; then walk ∧/∨ through the occurrences;
  check the i/N label at each step; wrap past the last.
- **Expect**: the zoom lands with the keyboard **exactly as it was before the grid opened** —
  T14's original "a search hit is for reading, not typing, so land with the keys down" was
  overruled on device (user, 2026-08-15; `finishClose` no longer makes an exception of an armed
  search). The terminal's search bar is up holding the same string, every occurrence decorated,
  the active one distinct (yellow vs selection tint), the view scrolled to an occurrence, i/N
  counting correctly and wrapping. Prev/next buttons sit inert (dimmed) when the string has no
  occurrence in this window.
- **Known failing, do not re-diagnose**: the current hit neither scrolls into view nor draws
  differently — BUGS.md §1 and §2, root-caused into the xterm search addon's decoration path and
  open. Tick this case on the rest; note those two as the known fail.
- iOS: [ ]
- Android: [ ]

### T14.5 — Edit in the terminal, return to the grid: same search, new narrowing
- **Setup**: T14.4's end state.
- **Steps**: edit the string in the terminal's bar to one matching a *different* window; then
  open the switcher (tabs button or bar swipe up).
- **Expect**: while still in the terminal view the decorations re-run live per keystroke; the
  reopened grid arrives with the field already holding the edited string and the narrowing
  already re-run for it (grep settle ≤ ~1s after open). The search never disarmed in between.
- iOS: [ ]
- Android: [ ]

### T14.6 — Disarm from either side, birth disarms, reorder locked while filtered
- **Steps**: (a) with search armed, tap the field's ✕ in the switcher — check the terminal's
  bar is gone too when closing into a window. (b) Re-arm, tap into a window, tap Done on the
  terminal's search bar — reopen the switcher: field empty, grid full. (c) Re-arm in the
  switcher, long-press a surviving card and try to drag. (d) With search armed, tap +.
- **Expect**: (a)+(b) disarming from one view disarms both — no half-armed state anywhere.
  (c) the card never lifts: reorder is off while filtered (tap and swipe-to-close still
  work). (d) the new window births with the search disarmed and the keyboard up.
- iOS: [ ]
- Android: [ ]

### T14.7 — Android: back ladder (Android only; chrome assertions INVERTED 2026-08-16)
- **Steps**: walk T14.1 and T14.4 on the Android build; with search armed and the switcher
  open, press system back; in the terminal view with the search bar up, press back.
- **Expect**: the search field and bar look exactly as they do on iOS — same corner
  (`SEARCH_RADIUS.switcher` 13 / `.terminal` 12, unbranched), same opaque surface, same Inter
  type (**ask the user for the iOS shot**). The old Material assertions here are void and the
  `SEARCH_RADIUS` branch is deleted. Back from the open switcher closes the grid into the active pane with the search
  STILL armed (grid state preserved for the next open); back at the terminal goes home as
  before — the search bar does not eat the press.
- Android: [ ]

### T14.8 — Cost and cadence sanity
- **Setup**: 4+ windows, one with a deliberately huge scrollback (`seq 1 50000`), Metro logs
  visible (`[search]` lines).
- **Steps**: type a 6-char query at typing speed into the switcher's field; watch the log.
- **Expect**: greps fire once per settled pause (not per keystroke) — one `[search] grep
  settled` line per pause, N execs each; typing stays 60fps; the huge-scrollback window's
  grep answers within ~1s on Wi-Fi and its card carries only the context block (the 50k lines
  never crossed).
- iOS: [ ]
- Android: [ ]

### T14.9 — Leaving the grid onto a search hit: square top, keys where they were (iOS)
- **Setup**: iOS only — the fix is in `syncPad`/`finishClose` and the emulator cannot see it.
  A notched iPhone. `5791481`, the second half of BUGS.md's "search view keeps the zoom's
  chrome", and **not yet walked on device**.
- **Steps**: (a) with the keyboard **up**, arm a search in the switcher, tap a matching card,
  and watch the landing frame — the top of the page and the key bar. (b) Repeat with the
  keyboard **down** before opening the grid. (c) With the search row up, look at the page's top
  corners. (d) Disarm the search (Done on the terminal's bar) and check the corners again.
- **Expect**: (a) the keys come back up, and the bar travels with the keyboard rather than
  arriving already parked at its keyboard-up position over an empty band; (b) the keys stay
  down and the bar sits at the bottom — no dead band under it. (c) while the search row is up
  the page's **top** corners are square: that edge is not the top of anything, it is where the
  bar cuts the page off, the mirror of `kbSquare`. It is not stale zoom state — `pageRadius`
  returns the display's radius at rest too, and an armed row simply pushes the page down to
  where a 60pt corner is in plain sight. (d) with the row gone the corners are round again.
- **Watch the pad in the log**: the fix *corrects* rather than prevents — the probe walk showed
  `keyboardPad` going 286 → 0 on the way out. If that correction is visible as a frame of raised
  bar, that is the open "key bar is up before the keyboard is" entry in BUGS.md, which wants the
  announced frame read instead of `Keyboard.metrics()`; record which one you saw.
- 📸 the landing frame in both (a) and (b), plus one shot of the squared top corner.
- iOS: [ ]
