# Clipboard, uploads, downloads

Status: current cases, not results. Scope: both platforms.
Source: `src/clipboard*`, `src/upload*`, `src/download*`, `modules/expo-pasteboard/`, `src/keybar.tsx`.
Follow [run/evidence rules](../../TESTS.md) and [test safety](../ship.md). Setup: disposable host
files/directories, known checksum fixtures, and distinct OSC 52 yank strings. Test Files, Photo/video,
and Camera separately: they can have different activity/lifecycle behaviour.

| ID | Setup/action | Expect |
|---|---|---|
| T8.1 | Emit one OSC 52 write from test host | History slot and phone pasteboard contain the text; OSC 52 reads get no reply. |
| T8.2 | Emit four distinct yanks | Three-slot rotation keeps the intended most recent items without duplicates. |
| T8.3 | Pin a slot; rotate, reload JS, restart | Pin survives, stays unique, and does not grow on each remount. |
| T8.4 | Paste with one and multiple slots | One types; multiple opens chooser; neither automatically executes. |
| T8.5 | Long-press Paste; inspect previews/provenance and phone entry | Chooser opens, reads pasteboard at the intended moment, supports selection/pinning; accepted iOS banner is not triggered by routine polling. |
| T8.6 | Paste multiline text into a bracketed-paste-aware shell | Newlines are content, not an added execution command. |
| T8.7 | Open ⋯ with keyboard up; try each upload picker | Menu itself keeps keys up; picker manages dismissal. Return/cancel preserves or recovers a usable session. |
| T8.8 | Pick file; browse, breadcrumb, descend | Correct directories and current path; no spinner stuck after reconnect. |
| T8.9 | Choose a filename already in test directory; overwrite deliberately | Collision visible and overwrite affects only the intended fixture. |
| T8.10 | Edit filename with characters needing sanitization | Safe intended remote basename; bytes intact. |
| T8.11 | Take a test camera image | UTC timestamp name with a valid media extension; do not require `.jpg` instead of `.jpeg`. |
| T8.12 | Save through destination browser | File arrives silently; no remote path typed into PTY. |
| T8.13 | Save, reopen, then remove only the disposable destination directory | Remembers destination; a vanished directory has a usable fallback/error, not a permanent spinner. |
| T8.14 | Upload a large safe fixture; tap busy menu | Busy tint and inert control while sending; inspect memory/error behaviour. Whole-file OOM is a finding, not proof of streaming support. |
| T8.15 | Attempt a deliberately unwritable test destination | One intelligible error, no path typed, no unexpected partial artifact; inspect host. |
| T8.16 | Paste a non-text item for quick upload | File in `/tmp/port22/`; remote path plus space typed, no Return. No retired ribbon/picker entry point. |
| T8.17 | Copy image and file through supported phone sources; paste from fallback and chooser | Native bytes/name/type reach the transfer path on both platforms; source presence is not a device pass. |
| D1 | Open Download; navigate from home; choose known file | Correct listing, download bytes, cache file, and system share sheet; checksum/content matches. |
| D2 | Cancel browser/share sheet | No unwanted destination or success claim; browser/session remains usable. |
| D3 | Download missing/unreadable file or interrupt disposable connection | Visible failure, recoverable browser; busy control resets. |
| D4 | Exercise upload then download without restarting | Shared busy state clears on success/failure; keyboard and terminal remain usable. |

Remote listing is not file management: no rename/move/delete action is promised. Test unsupported
clipboard payloads/cancel paths without claiming universal system-pasteboard support.
