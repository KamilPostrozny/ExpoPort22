# Issue triage

Status: **triage queue, not a fresh reproduction report**. Imported from historical walks during
the documentation cleanup; no device case was run as part of that cleanup. Unless stated otherwise,
reports date from 2026-08-17 and implementation status is unknown. Android/iPhone verification for
all entries below is **Unverified on the current checkout**. Do not infer "fixed" from code alone.
Scope: potentially active defects, acceptance decisions, and verification debt. Full old repros and
logs are in [issues-history.md](archive/issues-history.md); search its heading by the quoted symptom.

## Candidates requiring reproduction

| ID | Symptom / scope | Next action and source |
|---|---|---|
| I01 | Files/Camera background the app; upload browser races reconnect and spins | Walk each picker separately; inspect `src/upload-sheet.tsx`, `src/session.ts`. Historical heading: "Uploading a file is dead on Android". |
| I02 | Selection has handles but no Android edit menu | Compare long-press and Copy on both platforms; `src/terminal.tsx`. History: "Selecting text on Android offers no edit menu". |
| I03 | Long-press selection disables key-bar pan until relaunch | Select, clear, then swipe without relaunching; `src/keybar.tsx`, terminal gestures. |
| I04 | Keyboard not restored after Settings/new window/bar-up | Upward raise now exists in source; old "no code path" diagnosis is obsolete. Re-walk all restore paths with keys initially up/down. |
| I05 | Large in-memory upload OOM | Historical 46 MB failure; test safe fixtures on both devices. Whole-file transfers are a documented constraint, not proof of acceptable failure handling. |
| I06 | Clipboard pins duplicate after JS remount | Reload/relaunch repeatedly and count persisted pins; `src/clipboard.ts`. |
| I07 | TOFU/Forget host-key native dialogs differ visually | Security-sensitive parity review: compare prompts and destructive styling without weakening pinning or confirmation. |
| I08 | Spring alpha becomes exponential notation and causes a colour-parser error | Repeated card swipes/re-grabs; `src/switcher.tsx`. History: "A settling card-swipe spring". |
| I09 | Native SIGSEGV during relaunch | Preserve native crash traces; historical crashes were noted, not diagnosed. Do not assume I08 is the cause. |
| I10 | Android Back returns to Setup with a live session | Back/home/relaunch regression; `src/app/terminal.tsx`, native activity lifecycle. |
| I11 | Theme-change notification not observed through tmux | Separate direct-shell and tmux observations; test both devices before attributing it to Android. |
| I12 | Upload-sheet top gap does not dismiss | Compare scrim, grabber, and Back paths with iOS. |
| I13 | Neighbour preview can be stale; brief post-close swipes ignored | **Decision needed:** current code deliberately caches previews to avoid gesture-time capture. Measure age/latency; do not add capture-on-start blindly. |
| I14 | Inactive search highlights decay under redraw; terminal size warnings | Reproduce against current host-search/overlay implementation. Historical addon-specific diagnosis may no longer apply. |
| I15 | Phone clipboard photo/file paste unsupported (2026-09-01 report) | Source now includes media paste and a native module. Re-verify images/files end-to-end; do not keep asserting it is text-only or mark it fixed without devices. |
| I16 | Font scaling, Setup label wrapping, held-delete cadence, clipboard overlay | Recheck remaining parity findings at supported scale/keyboard settings. See historical "Small parity gaps", "More stale Expects (T12 section)", and T7A.2a in the archived tests. Raise unavoidable OS limits rather than silently accepting divergence. |
| I17 | **Android: the terminal cannot raise the soft keyboard** (2026-09-16, emulator + Gboard). The bar's up-swipe fires and the page focuses its helper textarea (`activeElement TEXTAREA`, `dumpsys input_method` stays `mInputShown=false`, no IME in the screenshot), so typing is impossible in the terminal on Android. Control on the same emulator/app: tapping the **native** Host field on Setup gives `mInputShown=true`, and Gboard appears — so the IME itself works and the failure is the WebView's programmatic focus. Introduced by `232033f` (the page owns the keyboard; a native-view gesture is not document user activation, which is what Chrome-for-Android requires to show the IME). Next action: decide between a native `InputMethodManager.showSoftInput` path (a module or a patch on `@expo/dom-webview`) and a document-side focus that a real page gesture grants. **Blocks Android verification of every keyboard case, T7.14 included.** |

## Verification debt, not necessarily unfixed code

Historical fixes include search navigation/highlighting, pager scrolling, grid reachability,
exec-pool limits, stable-ID/session targeting, key ordering, Ctrl-D refresh, and terminal size after
returning from a card. Many entries say **Android-verified only** or **awaiting a walk**. Their old
labels remain in the archive for attribution, not current certification. Select matching cases from
[TESTS.md](../TESTS.md), including iPhone, before closing the relevant debt.

## Retired or corrected assertions

- Ribbon visibility, timers, recipe caps, ribbon `/` in less, and ribbon-picker entry points:
  **retired feature**, not outstanding ribbon work. Shared transfer/resize risks remain covered above.
- "⋯ must dismiss the keyboard": superseded; the menu keeps it up. Settings/pickers own dismissal.
- Bar-up-to-switcher, closing the final grid window, numeric badge, hidden tabs button, fixed conf
  version/source-line insertion, four-scheme-only settings: obsolete assertions replaced in current
  docs/tests. Do not change the app to satisfy them.
- The generated tmux conf text in `src/tmux-model.ts` still says it appends a source line to the
  user's config. The actual apply path does not. **Source-comment debt only**; not changed by this
  documentation-only task. Likewise old T/§ references in code route through the root redirect docs.

## Updating this queue

For each triaged item record: implementation status (unknown/open/changed/retired), the tested
commit, Android result, iPhone result, and screenshot/log references. A source-only fix is not a
verified closure. Keep one short current entry; move long investigations to the archive. This table
is a navigation aid, not a claim that every old unchecked test has been exhaustively triaged.
