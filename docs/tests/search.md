# Search across windows and scrollback

Status: current cases, not results. Scope: both platforms; T14.7 is Android Back, T14.9 includes
an iOS-origin regression to compare on both. Sources: `src/search-model.ts`, `src/switcher.tsx`,
`src/terminal.tsx`, `src/app/terminal.tsx`.
Follow [run/evidence rules](../../TESTS.md) and [test safety](../ship.md).

Setup: named disposable tmux session with distinct window names/directories and numbered output;
place unique terms in metadata, visible rows, and deep scrollback. Use a second disposable window
for controlled search failure; do not terminate the user's window. Keep history intact (`clear -x`
on fish). Capture host results and timestamps alongside screenshots.

| ID | Setup/action | Expect |
|---|---|---|
| T14.1 | Search terms present only in name, directory, visible output, or deep history | Grid narrows correctly across the intended surfaces; failed/unsearched windows are not silently labelled no-match. |
| T14.2 | Query with off-screen matches; inspect card | Relevant occurrence visible and distinctly highlighted. |
| T14.3 | Query an absent term, then force a disposable window's search to fail | No-match and failed/pending states remain distinguishable. |
| T14.4 | Tap matching card; step prev/next through multiple hits | Shared query remains armed; correct count, current-hit highlight, scroll position, and wrap behaviour. Preserve pre-grid keyboard state, not an obsolete forced-up/down rule. |
| T14.5 | Edit query in terminal, return to grid; add new host output | Shared query and fresh narrowing/counts agree; stale responses ignored. |
| T14.6 | Clear from each UI; create a window; attempt reorder while filtered | Clear disarms both, birth disarms, filtered reorder is unavailable. |
| T14.7 | Android Back through search field/keyboard/grid states | Topmost applicable state dismisses first; no unexpected route loss; shared chrome matches iPhone. |
| T14.8 | Type rapidly, add windows, resize, switch targets during searches | Bounded channel use/cadence; no stale-target result, unhandled rejection, or permanently pending state. Measure actual response timing. |
| T14.9 | Leave grid on search hit with keys initially up and down | Square top while search row is visible, correct key-bar position, no dead keyboard gap or terminal left card-sized. Compare both devices. |

Repeat stepping after tmux redraws, keyboard resize, and theme changes: historical inactive marks
could decay even when the current yellow mark worked. Do not use a current-source inspection as a
substitute for reproducing that historical risk.
