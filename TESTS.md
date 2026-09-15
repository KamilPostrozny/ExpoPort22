# Device test index

Status: current acceptance catalogue. **No pass/fail result is implied by a case being listed.**
The cleanup retained historical IDs where useful but rewrote obsolete assertions. Old results live
only in [archived device verification](docs/archive/device-verification.md); they do not certify the
current checkout. No device walk was performed as part of this documentation migration.

Read [docs/ship.md](docs/ship.md) for build, isolated host/session setup, screenshots, logs, and
harness limitations. For an Expo code edit, execute the affected cases on Android and real iPhone,
plus connected-path regressions. The catalogue is a minimum, not permission to skip a new behaviour.

| Area | Cases / document | Main dependencies |
|---|---|---|
| Connection/security/lifecycle | [connection.md](docs/tests/connection.md), T3.0–T3.7 | SSH module, session, settings, host keys |
| Terminal/scroll/selection | [terminal.md](docs/tests/terminal.md), T6 | DOM terminal, input routing, PTY resize |
| Key bar/keyboard/prose | [keybar.md](docs/tests/keybar.md), T7/T7A | Native input, gestures, keyboard docking |
| Clipboard/transfers | [transfers.md](docs/tests/transfers.md), T8 + D1–D4 | Session lifecycle, native pasteboard, SFTP, pickers |
| Tmux/switcher/bar swipe | [tmux-switcher.md](docs/tests/tmux-switcher.md), T9–T11 | Named-session commands, exec pools, gestures |
| Settings/parity/performance | [settings.md](docs/tests/settings.md), T12/T12A | Appearance, keyboard, lifecycle, all screens |
| Search | [search.md](docs/tests/search.md), T14 | Tmux history, captures, switcher, terminal marks |

## Case and evidence conventions

Feature tables use **Setup/action → Expect**; shared setup is at the top of each file. Unless marked
Android-only, run on both platforms. For an OS-only affordance check the native side and parity of
shared UI. Match the iOS screen, not old Android-specific metrics. Crop small controls; use video
for gestures/animation and host observations for bytes/window identity.

Record each run separately, outside the case definitions. Keep private logs/screenshots outside git;
a short sanitized record may link to durable evidence where available:

```text
Run: <date/time>; commit + dirty diff: <identity>; native builds: <Android/iPhone>
Device / OS / keyboard / font scale: ...
Case IDs: ...; test host/session: ...
Android: pass | fail | blocked; screenshot/video: <path>; logs + observed action: <path/summary>
iPhone: pass | fail | blocked; screenshot/video: <path>; logs + observed action: <path/summary>
Finding / issue ID: ...; reproduction and remaining blocker: ...
```

No result, missing input capability, inaccessible evidence, or no matching action in logs means
**Unverified**, not pass. Current [issue triage](docs/issues.md) lists historical failures worth
re-walking. Do not copy old platform ticks into a new record.

## Retired assertions / ID migration

- T9.8 and ribbon T11.7–T11.18/T11.21–T11.22 are retired; T11.19–T11.20 still cover session isolation.
- T10.2 and T11.6 now check bar-up keyboard behaviour, not a removed drag-to-switcher interaction.
- T10.12/T10A.8 protect the last grid window and separately exercise external session termination.
- T9/T12 use source-defined conf versions, named-session tabs, and current appearance settings.
- T3 connection tests were historically Android-only; use their mirrored security/lifecycle cases on
  iPhone as well. D1–D4 cover downloads missing from the old catalogue.

Detailed historical fixtures and old evidence remain searchable by ID in the archive, but are not
current expected behaviour or safe executable instructions.
