# Terminal, scrolling, selection

Status: current cases, not results. Scope: both platforms.
Source: `src/terminal.tsx`, `src/scroll-model.ts`, `src/terminal-protocol.ts`.
Follow [run/evidence rules](../../TESTS.md). Setup: disposable host/session, long numbered output,
`less`, `vim`, `htop`, and a throwaway repository with enough history for `git log`. Observe the host
as well as the phone; confirm foreground program and terminal modes before interpreting a pan.

| ID | Setup/action | Expect |
|---|---|---|
| T6.1 | In plain shell, print long numbered output and pan both directions | Local scrollback moves without stray arrows in the shell. |
| T6.2 | Open a long file in less; pan up/down | Pager moves by intended lines, not a frozen tmux history overlay. |
| T6.3 | In mouse-enabled htop, pan at a known row/cell | Wheel reaches the intended cell and direction. |
| T6.4 | Repeat arrow-producing pans in vim and less | Correct DECCKM variant; no literal escape text. |
| T6.5 | Flick, then touch during coast | Momentum is smooth; touch stops it without an unintended key/tap. Capture video. |
| T6.6 | Repeat a pan with one and two fingers | Same scrolling semantics; no accidental selection/settings action. Block if injection cannot reproduce the gesture. |
| T6.7 | Stationary long-press, move handles, Copy, clear selection | Selection/edit menu works; no pan claimed. Then verify key-bar swipes still work without relaunch. |
| T6.8 | Drag by measured cell-height increments | One notch per cell, not five-line jumps. |
| T6.9 | Enter/leave vim and repeat pans | Mode changes take effect; no stale alternate-screen/mouse routing. |
| T6.10 | Scroll git log's pager, including no-alternate-screen mode | Pager moves rather than tmux's unrelated history. Scroll back to the live bottom; input is not trapped in copy mode. |
| T6.11 | Tap a control in a mouse-enabled TUI (htop), then tap an OSC 8 link in a plain shell | The click lands on the tapped cell and the link opens; the software keyboard stays down either way. |

Inspect glyphs, bold pitch, font loading, cursor position, ANSI colours, and box drawing during the
walk. Keyboard/rotation changes must update host PTY size, not only scale the image. When preserving
history on fish, use `clear -x`; ordinary clear can erase the evidence.
