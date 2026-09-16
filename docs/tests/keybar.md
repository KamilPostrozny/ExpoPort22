# Key bar, keyboard, prose mode

Status: current cases, not results. Scope: both platforms; T7A adds Android checks against iOS.
Source: `src/keybar.tsx`, `src/keybar-model.ts`, `src/input-model.ts`, `src/prose-model.ts`,
`src/hooks/use-terminal-keyboard.ts`. Follow [run/evidence rules](../../TESTS.md).
Setup: disposable connected shell, vim, and a known prose application. Test with keys initially
up and down. On Android measure IME state while the keyboard is visible, not after dismissing it.

| ID | Setup/action | Expect |
|---|---|---|
| T7.1 | Run sleep; send Ctrl-C | Interrupt reaches only the displayed test session. |
| T7.2 | Double-tap Ctrl; send two chords; unlock | Lock persists for both, then ordinary typing resumes. |
| T7.3 | Exercise C/Z/R/L/D in disposable processes | Each chord has its intended host effect; never send D/Z to unrelated work. |
| T7.4 | Enter vim insert mode; tap Esc | Returns to normal mode. |
| T7.5 | Type a partial filename; tap Tab | Shell completion works. |
| T7.6 | Paste with zero, one, and multiple yank slots | Zero falls back to phone pasteboard; one types; multiple opens chooser. No added Return. |
| T7.7 | Navigate vim and shell history with arrows | Correct directions and escape modes. |
| T7.8 | Use Home/End on a populated prompt | Cursor moves to the expected endpoints. |
| T7.9 | Swipe bar down/up | Keyboard hides/raises; bar-up does not open the switcher. |
| T7.10 | Begin swipes over individual keys | No key press leaks to the host. |
| T7.11 | Press each key while host echo is delayed | Dim/shrink and supported haptic start on touch, not roundtrip. |
| T7.12 | Two-finger tap terminal, then two-finger pan | Tap opens Settings; pan scrolls. |
| T7.13 | Select with keyboard up; clear; type and swipe | The page's keyboard input remains functional; selection does not strand the pan/focus responder. |
| T7.14 | Toggle prose override; type misspelled text, dictation, and shell syntax | Prose on: the IME corrects whole words at commit and the corrected text reaches the PTY, sentence capitalisation follows, and a dictated chunk loses its leading space at an empty line. Off: the identical taps arrive verbatim. The override still follows and is scoped to the foreground program, and mode switches do not dismiss or steal the keyboard. The hold-space trackpad is NOT part of this case: a WebView textarea never reports the caret leaving the end of the field, so there is no move to forward (measured 2026-09-16, see `src/terminal.tsx`'s prose block). |
| T7.15 | Change foreground program between shell, TUI, prose app and interpreter-hosted agent | Automatic mode follows actual program; override is scoped to that context. Unknown programs default raw; no stale async answer changes another window. |
| T7A.1 | Compare bar and popovers to iPhone | Opaque plates on both, no Android glass/material variation. |
| T7A.2 | Compare margins, radii, dimensions and keyboard-hidden position | Matches iOS at equivalent logical size. |
| T7A.2a | Repeat at supported Android font/display scales | No clipping, unexpected terminal font scaling, or overflowing controls. Record exact scale. |
| T7A.3 | Crop every icon at native resolution | Bundled glyphs match iOS; no tofu/system-font fallback. |
| T7A.4 | Raise/hide Gboard repeatedly | Bar docks without overlap or double inset; PTY loses/regains the actual rows. |
| T7A.5 | Repeat T7.9 after selection, popovers, and Settings | Keyboard gestures keep working; no relaunch needed to recover. |
| T7A.6 | Open chords/arrows/clipboard with keyboard up/down | Correct anchoring, hit targets, no unexpected terminal displacement; arrows include Enter. |
| T7A.7 | Exercise repeated presses/haptics | No crash; visible feedback still matches iOS. Emulator cannot certify physical haptic feel. |
| T7.16 | Attach a hardware keyboard; press Esc, Tab, arrows, Home/End, PgUp/Dn, Delete and F-keys in vim/shell | Each reaches the PTY with xterm's own encoding (vim modes, completion, history); the software keyboard and the bar are unaffected. |
| T7.17 | Raw mode (prose off): type a line, then HOLD the software-keyboard Backspace for several seconds | One character dies per tap; after ~300ms of holding the deletion continues at the app's own ~25/s until the finger lifts — the held press delivers one keydown and the page owns the repeat (`src/raw-hold-model.ts`). Deletion stops at the release (the IME's keyup reaches the DOM — measured on the Android emulator 2026-09-18), on a blur, on a mode flip and on any other key; a held deletion never outlives 6s even if the release is unobserved. Prose mode's own backspace path is unchanged. Both platforms. Android caveat, measured the same day: a HARDWARE key's release never reaches the DOM as a keyup in this WebView (the keydown does), so a held hardware Delete is bounded by the 6s cap, not the release. |
| T7.18 | Raw mode, iPhone: with the cursor mid-line, HOLD the spacebar and drag (the keyboard's trackpad) left and right within the line | The PTY cursor walks with the drag, character-counted, in both directions within the current line, and the field's mirror (the line at the PTY cursor, refreshed while no gesture is in flight) never over-deletes or mangles typed text — the walk sends arrows only. As the trackpad ends, iOS's caret restore is dropped (park) and the line re-anchors. A tap still types a space. iOS only: Android has no spacebar trackpad (parity gap, reported). `\[raw\]` console lines carry the mirrors, walks and parks. |
