# Tmux, switcher, bar swipes

Status: current cases, not results. Scope: both platforms; T10A adds Android parity/system checks.
Source: `src/tmux.ts`, `src/tmux-model.ts`, `src/exec-pool.ts`, `src/switcher.tsx`,
`src/switcher-model.ts`, `src/barswipe-model.ts`, `src/app/terminal.tsx`.
Follow [run/evidence rules](../../TESTS.md) and [safe test setup](../ship.md).

Setup: explicitly selected disposable named session with multiple identifiable windows. Keep a
second disposable session for isolation tests. Observe via targeted `list-windows`/`capture-pane`,
not an attached desktop client that changes sizing. Never use the user's live session as a fixture.
For final-window/session-exit cases use only the disposable target.

## Configuration and side channel

| ID | Setup/action | Expect |
|---|---|---|
| T9.1 | Connect in tmux mode; inspect app conf and read-back | Content matches `generateConf`; version matches `CONF_VERSION` in source. User's tmux config is unchanged—no appended source line. |
| T9.2 | Repeat with fish login shell | Commands parse and apply; no POSIX-only quoting/heredoc assumption. |
| T9.3 | Turn tmux comforts off; reconnect | Required features remain; no new comforts are applied. Already-set server options are not automatically undone; no hidden-tabs requirement. |
| T9.4 | Connect to test environment without tmux | No crash or unsolicited error; disabled tabs explain missing tmux on tap. |
| T9.5 | Switch window from host in the named session | Active grid card tracks the actual window; no numeric badge assertion. |
| T9.6 | Capture a colour/bold/box-drawing fixture | Snapshot preserves intended ANSI appearance and font pitch. |
| T9.7 | Create/select/reorder/close; mutate other disposable session concurrently | Stable IDs and explicit session targeting; no wrong-session action or unhandled rejection. Reorder does not switch the selected window unexpectedly. |
| T9.9 | Put stale content in the app-owned test config; reconnect | Content is replaced and read-back verified; source-defined version, not hard-coded v1/v4. |
| T9.10 | Deny app-config write/apply in disposable environment | No false applied state or crash; observe actual available tabs and failure logs without reviving a removed Settings status row. |

T9.8 is retired. Configuration affects server-global options; isolation must be real, not just a
second desktop attachment to the user's work.

## Window grid

| ID | Setup/action | Expect |
|---|---|---|
| T10.1 | Tap tabs with keys up/down | Terminal zooms into its card; no blank/stale content flash. |
| T10.2 | Swipe bar up from terminal | Keyboard raises; this gesture no longer drags open the switcher. |
| T10.3 | Open multi-window grid | Only named-session windows; correct names, directories, colour snapshots. |
| T10.4 | Change active window and reopen | Correct accent ring. |
| T10.5 | Tap a card | Selects its stable ID and returns to live content; keyboard state preserved. |
| T10.6 | Produce output while grid stays open | Snapshots refresh without unbounded exec fan-out. |
| T10.7 | Close a non-final window with ✕ | Only that window disappears; failures re-list rather than pretending success. |
| T10.8 | Left-fling/right-swipe a card | Close versus rubber-band behaviours; no accidental tap. Use video and valid gesture injection. |
| T10.9 | Long-press/reorder/drop, immediately re-grab repeatedly | Stable lift/order; no teleport, stranded gesture, phantom move, or selected-window jump. |
| T10.10 | Tap + | New card appears and transitions to its terminal; search disarms; no card-sized terminal left behind. |
| T10.11 | Tap Done | Returns to the active live terminal and previous keyboard state. |
| T10.12 | Reduce to one window; try grid close, then end disposable session externally | Grid protects final window; external termination does not reveal another session or leave a fake live grid. |
| T10.13 | Select tabs | No tab-select haptic. |
| T10.14 | Add/close windows remotely and via UI | Visible count reflects reality, not an old numeric key-bar badge. |
| T10A.1 | Repeat enter/exit using tabs button | Same transform as iPhone, not a separate Material transition. |
| T10A.2 | Crop grid footer at rest and during keyboard transitions | iOS buttons/fonts/spacing; reachable above gesture area. |
| T10A.3 | Repeat + birth | Same iOS circle/card animation, no Android FAB; inspect keyboard restoration and PTY size. |
| T10A.4 | Done | Same target and keyboard behaviour as iPhone. |
| T10A.5 | Repeat select/close/reorder with input injection | Same semantics, no exponential-colour red box. |
| T10A.6 | System Back with grid open | Closes grid, not the connection/app route. |
| T10A.7 | Leave output running with grid open | Refresh and channel budget hold on Android. |
| T10A.8 | Repeat final-window protection/external termination | No switch into an unrelated session; final grid close remains unavailable. |

## Horizontal bar swipes

| ID | Setup/action | Expect |
|---|---|---|
| T11.1 | Swipe between labelled windows | Page follows finger, name pills match, correct live redraw; no stray key. |
| T11.2 | Run a clock in neighbour; wait and hold a preview open | Record actual preview age. Cached preview is intentional; freshness bound remains I13, not an automatic pass/fail against the old capture-on-start rule. |
| T11.3 | Swipe before first and after last window | First edge rubber-bands; after last is a real new-tab page that creates on commit. |
| T11.4 | Compare slow short drag and fast flick | Correct distance/velocity decision; record blocked if injector cannot reach the threshold. |
| T11.5 | Cancel under-threshold drag | Springs back cleanly without a window change. |
| T11.6 | Alternate horizontal swipe with vertical up/down | Vertical owns keyboard raise/hide; does not drag the switcher. |
| T11.19 | Work in second disposable session while phone is idle | Poll/grid remain tied to phone's named session, no cross-session flicker. |
| T11.20 | Rapidly hop back/forth while responses are delayed | Stale answers do not reset origin/active window for the next swipe. |

Ribbon-only IDs are retired; see [the migration map](../../TESTS.md#retired-assertions--id-migration).
