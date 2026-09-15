# Connection, security, lifecycle

Status: current cases, not results. Scope: both platforms; T3 IDs retained from the Android catalogue.
Source: `src/session.ts`, `src/settings.ts`, `src/host-keys.ts`, `modules/expo-ssh/`.
Follow [run/evidence rules](../../TESTS.md) and [safe device setup](../ship.md).

Setup: reachable disposable SSH account, its authorized device public key installed by the user,
known fingerprint, and a uniquely named test tmux session. Use a throwaway sshd on a separate port
for mismatch/outage cases; do not replace the real host key, edit system sshd config, or kill its
listener. Start with no important work in the selected session.

| ID | Setup/action | Expect |
|---|---|---|
| T3.0 | Build/install the correct native client; launch Setup and connect | No missing native module or startup crash; live session effects prove calls ran. Verbose `[ssh]` logs are not required (`LOG = false`). |
| T3.1 | Forget only the test endpoint's pin; connect | Fingerprint equals the test host key; handshake does not proceed without Trust. Cancel refuses connection. Compare prompt parity. |
| T3.2 | Trust, disconnect, reconnect | First connection pins; second connects without another prompt. |
| T3.3 | Change only the throwaway endpoint's host key after pinning | Hard refusal, no silent repin or permissive Trust shortcut; explicit Forget is needed for recovery. |
| T3.4 | Trigger tmux probe/exec; also use a test environment without tmux | Side-channel effects do not echo as commands in the PTY. Missing tmux is handled without a crash; disabled tabs explain the reason on tap. |
| T3.5 | Type a known string rapidly; display UTF-8 split across output chunks; rotate and toggle keyboard in vim | Ordered bytes, no mojibake; remote rows/columns follow the actual terminal viewport. |
| T3.6 | Upload a small and multi-MB fixture through Files; inspect remote directory and checksum | Correct size/bytes and app-created private directory permissions; no reconnect spinner deadlock. See T8 for all pickers. |
| T3.7 | Background/foreground; stop only the disposable SSH connection/server; restore it | Dead socket is detected, reconnect reauthenticates without TOFU, two consecutive auto failures stop retries, manual reconnect recovers. No orphaned shell workers. |

Also check invalid host/port/username feedback and all start modes. A named attach must target the
chosen test session; its missing-target fallback must never be exercised against the user's live
`port22` session. Disconnect must not leave a hidden live session behind the Setup route.
