# Settings, parity, performance

Status: current cases, not results. Scope: both platforms, with explicit OS-only affordances below.
Source: `src/settings-sheet.tsx`, `src/appearance.tsx`, `src/settings.ts`, `src/theme.ts`,
`src/fonts.ts`, `src/app/terminal.tsx`, `app.json`.
Follow [run/evidence rules](../../TESTS.md). Setup: disposable connected session, keyboard up/down,
light/dark system appearances, and representative generated schemes as well as Catppuccin.

| ID | Setup/action | Expect |
|---|---|---|
| T12.1 | Open Settings from ⋯ and two-finger terminal tap | Same sheet/state; connection remains live. Compare actual opaque surfaces, not historical see-through scrim. |
| T12.2 | Dismiss via grabber/scrim/Back where supported | No Done button requirement; returns to prior keyboard state on both devices. |
| T12.3 | Choose manual schemes while connected | Terminal/chrome restyle immediately, no reconnect. |
| T12.4 | Enable Follow system, choose distinct light/dark slots, change system appearance | Correct selected slot appears live; keyboard-native appearance is OS-dependent and must be reported separately. |
| T12.5 | Step font size to both bounds; restart | 8 and 32 are limits; value persists and grid/PTY refit. |
| T12.6 | Change tmux comforts; reconnect | Required features stay; comforts apply on next connect. No retired master-tmux toggle/status-row expectation. |
| T12.7 | Disconnect | Setup appears without a live orphaned session. |
| T12.8 | Forget only test endpoint's host key; cancel then confirm | Cancel preserves pin; confirmed forget requires TOFU next time. Destructive styling matches iOS. |
| T12.9 | Dictate at empty prompt and mid-line | OS-inserted leading space is filtered where applicable; legitimate mid-line space kept. |
| T12.10 | Press real spacebar at empty prompt | Space is sent, not mistaken for dictation prefix. |
| T12.11 | Hold backspace for several seconds | Repeats without corruption/stuck input; record platform cadence rather than assuming identical acceleration is app-controlled. |
| T12.12 | Query colour scheme and subscribe to change notifications; flip theme | Correct light/dark query response and notification where enabled; test direct shell and tmux separately. |
| T12.13 | Scroll/coast under load on high-refresh device | Smoothness measured with recording/profiling; emulator or debug FPS alone cannot certify iPhone ProMotion. |
| T12.14 | Cold launch in light/dark | Correct splash/icon, no default template or stray flash. |
| T12.15 | Sweep all offered schemes across setup, terminal, switcher, sheets | No hard-coded strays; use source catalogue, not a frozen four-flavour count. |
| T12.16 | Connect → type/scroll → paste/transfer → switch/reorder/search → Settings → resume/disconnect | Features compose; no lost input, wrong target, stale geometry, or unhandled errors. |
| T12.17 | Hold-space cursor control where keyboard supports it, then edit | Edit lands at intended cursor without duplicating/deleting unrelated text; report unavailable OS affordance. |
| T12.18 | Compare generated schemes to their upstream terminal colours | Author's ANSI/chrome roles preserved; no invented palette arithmetic overriding supplied roles. |
| T12.19 | Inspect connection failure, mismatch, transfer browser/error, no-result states | Consistent current iOS typography, colours, geometry, and usable actions; no deleted prototype reference. |
| T12.20 | Profile representative scroll/switch/search in Release | Report build, device, workload, and measured result. Do not restore removed/unmeasured perf flags based on old notes. |
| T12A.1 | Settings on Android; dismiss all supported ways | Matches iPhone size/shape/colour; Back dismisses, keyboard restored. |
| T12A.2 | Upload browser; tap top gap; navigate then Back | Matching sheet; Back goes up a directory before dismissing at root; scrim dismissal works. |
| T12A.3 | Back with popover or ⋯ open | Topmost overlay closes before terminal route changes. |
| T12A.4 | Back at bare terminal; return from launcher | App backgrounds and returns to terminal, not Setup with live session. |
| T12A.5 | Inspect launcher, including themed icon where supported | Correct adaptive/monochrome icon, no clipped template. |
| T12A.6 | Cold start in both appearances | Correct splash; no wrong-theme flash. |
| T12A.7 | Inspect status/gesture areas through theme/keyboard changes | Correct contrast and docking, no obscured footer. |
| T12A.8 | Files, Photo/video, Camera; deny/grant/cancel permissions | Recoverable flow, no killed-session upload spinner or unintended retry loop. |
| T12A.9 | Gboard dictation, held delete, mode/focus changes | Correct content and responsive keyboard; record real IME state and any system-overlay obstruction. |

Record parity findings even when the named functional action succeeds. T12.13/T12.20 require the
appropriate build/device; mark unavailable measurements blocked rather than substituting a typecheck.
