# Build and device verification

Status: authoritative repository workflow. Scope: delivery, device evidence, and local tool setup.
Use with [AGENTS.md](../AGENTS.md) and the relevant [test cases](../TESTS.md).
Older personal skills and archived walks are not instructions when they disagree with this file.
Commands run from the repository root in a bash-compatible shell unless stated otherwise.

## 1. Choose the path

| Change | Required path |
|---|---|
| Markdown/documentation only | Check links, references, and diff. No app build/device run required; report both device rows as unverified for this docs-only change. |
| JS/TS, DOM component, public assets, pure-JS dependency | Compatible installed dev clients + Metro reload, then both-device evidence |
| Native dependency/module, app configuration, SDK/RN version, native patch | Rebuild affected native clients, then both-device evidence |
| Expired iPhone provisioning | Re-sign/reinstall the existing matching IPA; no rebuild solely for expiry |

For code changes run `bun test` and `bunx tsc --noEmit`; run relevant lint checks as well. These do
not replace device verification. Inspect the diff before choosing a build path. `dev` is the working
branch; `main` receives phone-tested changes and embeds JS in the release IPA. Do not merge or publish
unverified work as a tested release. A documentation cleanup is not itself an instruction to push.

## 2. Own Metro and identify the bundle

```bash
ss -ltnp 'sport = :8081'
# Inspect the listener; stop the identified existing Metro PID with kill <pid>.
# Do not use broad pkill patterns or terminate an unrelated service blindly.
bunx expo start --dev-client
```

Start Metro as a tracked background process in this agent session and retain its actual output
path. Take over an existing bundler rather than reusing someone else's output. One owned Metro can
serve both devices, but its logs are mixed: verify one device at a time or correlate actions with
native logs, timestamps, and the test session. A quiet stream alone is not a pass.

Reload connected clients through Metro (broadcasts to **all** connected devices):

```bash
bun -e 'const ws = new WebSocket("ws://localhost:8081/message");
  ws.onopen = () => { ws.send(JSON.stringify({version:2,method:"reload"}));
  setTimeout(() => process.exit(0), 500); };
  setTimeout(() => process.exit(1), 5000);'
```

Confirm a fresh platform bundle and an observable action from the changed path. Reload is a no-op
if the app is not connected. Use the platform launch path below after a bundler takeover.
Run long commands/watchers through your runner's background facility; in this harness use `bg_run`,
then completion notifications—not polling loops. Stop watchers when the walk is over.

## 3. Shared test safety and evidence

- Use a disposable host/account where possible: the app applies tmux options to the running server.
  On a shared host, create a uniquely named test session and select that exact existing session in
  Setup. Never use the user's `port22` session, an unnamed attach, or a fallback you cannot control.
- Have the user provision the test public key if needed; do not edit `authorized_keys` or the host's
  sshd configuration. Verify the actual host-key fingerprint, not one copied from an old walk.
- Do not run a global tmux-server kill or stop the host's real sshd. Mismatch/disconnect tests need
  a throwaway sshd with its own keys/port. Avoid destructive input until the target is confirmed.
- Before deleting the test session, disconnect and park the app in Plain shell. Delete only the
  session you created. Otherwise a stale attach can fall back to the user's real session.
- Save screenshots and bounded log extracts with platform, tested commit/dirty diff, native-build
  identity, case IDs, and timestamps. Keep private evidence outside version control. Record results
  using [TESTS.md](../TESTS.md); never carry old ticks forward as current verification.
- Inspect screenshots at native resolution, cropping small controls. Compare matching iPhone and
  Android states: glyphs, fonts, colours, geometry, pressed/disabled states, and animation recordings
  when motion matters. A static screenshot alone does not prove an animation.

## 4. Android: local build and emulator

Prerequisites on the maintained workstation: `~/Android/env.sh`, JDK 21, Android SDK, an AVD named
`port22`, and working KVM. These are host-local dependencies, not files shipped by this repository.
On another machine install the SDK/JDK compatible with the generated Gradle build and create an AVD;
do not change the system Java globally. If anything is missing, report the exact blocker.

```bash
. ~/Android/env.sh
emulator -list-avds
adb devices -l
# If no emulator is running, launch as a tracked background task:
emulator -avd port22 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect
```

Wait for boot readiness (`adb -s <serial> shell getprop sys.boot_completed` must be `1`) before
installing. Set the actual serial from `adb devices`; do not assume the first device is the test AVD.

Generate native files only when necessary:

```bash
bunx expo prebuild -p android
```

Prebuild can rewrite `package.json` scripts. Review `git diff -- package.json` and restore **only**
the script changes made by prebuild; preserve all pre-existing edits. Never restore the whole file
with `git checkout`. Durable config belongs in `app.json`, plugins, dependencies, and native modules,
not solely in generated directories.

```bash
(cd android && ./gradlew assembleDebug --no-daemon)
export ANDROID_SERIAL='<actual test serial>'
adb -s "$ANDROID_SERIAL" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_SERIAL" reverse tcp:8081 tcp:8081
adb -s "$ANDROID_SERIAL" shell am force-stop com.kamilpostrozny.port22
adb -s "$ANDROID_SERIAL" shell am start -a android.intent.action.VIEW \
  -d 'expoport22://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
```

The emulator reaches this machine's sshd at `10.0.2.2`, not localhost. Confirm its port; a stale
saved port can leave the app on a connection-failure overlay. For Wi-Fi adb use the connected device's
actual serial and check whether `adb reverse` succeeded; otherwise use the host LAN IP in the URL.

Drive controls with `adb shell input` and `uiautomator dump`; an optional `~/Android/ui.sh` provides
label-based helpers on this workstation. Do not depend on it: screenshots and accessibility bounds
are the fallback. Bounds can be stale after scrolling. Gboard must actually be raised during keyboard
tests—read `dumpsys input_method` while it is up, not after Back.

```bash
adb -s "$ANDROID_SERIAL" exec-out screencap -p > /tmp/port22-android.png
adb -s "$ANDROID_SERIAL" logcat -d -t 500 > /tmp/port22-android-logcat.txt
adb -s "$ANDROID_SERIAL" shell dumpsys input_method > /tmp/port22-android-ime.txt
```

Read the PNG, native log, and owned Metro output for the action. No crash banner is not proof of
correct behaviour. Multi-touch and velocity-sensitive cases need a working injector/recording;
report a blocked case rather than inferring success. Rooting/restarting adb may clear reverse tunnels.
Debug APKs are not release-performance evidence; a release-performance claim requires a release build.

## 5. iPhone: CI, signing, launch, screenshot

Linux has no Xcode. `.github/workflows/ipa.yml` is the build authority:

| Branch | App / bundle | Rolling release tag |
|---|---|---|
| `dev` | Port22-dev / `com.kamilpostrozny.port22.dev` | `dev` |
| `main` | Port22 / `com.kamilpostrozny.port22` | `prod` |

`dev` gates native builds; JS-only pushes can skip the build job. `main` builds embedded releases.
Docs-only paths are ignored. Check the workflow and changed dependencies rather than assuming a
missing IPA means CI is broken. When a push/build is required, identify its exact commit and run ID:

```bash
gh run list --workflow=IPA --branch dev
gh run watch <matching-run-id> --exit-status
```

Watch the run as a background task **before installing**. Install only after success and verify
that the rolling release corresponds to the intended native build; a tag may have advanced.

```bash
systemctl --user is-active netmuxd || systemctl --user start netmuxd
env USBMUXD_SOCKET_ADDRESS=UNIX:$HOME/.local/share/port22/nm.sock xtool devices
scripts/install-variant.sh dev
# For a verified release build, use: scripts/install-variant.sh release
```

Prerequisites: authenticated `gh`, `xtool` signing/pairing, `netmuxd` user service, reachable paired
phone. Do not install if the device list is empty. The script allocates the PTY required by xtool.
**Stop on any certificate-revocation prompt**; do not spend the user's signing slot. Free provisioning
expires after roughly seven days; reinstalling re-signs the IPA. Use `systemctl --user restart netmuxd`,
not `pkill -f netmuxd`.

Launch/relaunch the correct app with available device tooling; inspect
`pymobiledevice3 developer dvt --help` for the installed version's launch controls. The dev app needs
the owned Metro on the same network (`expoport22dev` scheme); the release embeds its JS and needs no
Metro. Confirm actual device connection before sending a reload. Do not claim automated gestures
worked if no input tool is available; record the limitation and request only the necessary physical
step if blocked (unlock, trust prompt, gesture), not the entire verification job.

Install screenshot tooling if absent (`uv tool install pymobiledevice3`), then:

```bash
env USBMUXD_SOCKET_ADDRESS=$HOME/.local/share/port22/nm.sock \
  pymobiledevice3 developer dvt screenshot /tmp/port22-iphone.png
```

Read the PNG yourself. **No `UNIX:` prefix for pymobiledevice3**; xtool needs the prefix. A black
frame can mean the screen is off. Device/pairing/unlock failures are blockers, not application passes.
For action-triggered screenshots, `scripts/watch-and-shoot.sh <owned-metro-log> <output-dir>` is an
optional background watcher; still inspect its images and errors. Dev logs come from owned Metro;
release verification needs an actual device/native log capture, not a disconnected Metro stream.

## 6. Troubleshooting worth retaining

- Edge-to-edge Android can keep a full-height window under Gboard. Measure IME visibility, bar
  position, terminal rows, and the host PTY together; do not assume OS resize is enough.
- Do not round-trip JS gesture scratch state through asynchronous Reanimated shared values. Keep
  gesture identities stable; reorder/re-grab tests catch UI-thread races that JS logs cannot see.
- `fish`'s ordinary clear can erase tmux scrollback; use `clear -x` when the test needs history.
- Missing native modules after reload mean the dev client may be stale: rebuild before chasing JS.
- The verbose SSH proxy is disabled in source. App traces, host effects, and native logs are still
  required; do not wait for every SSH call to print or turn on unbounded payload logs for profiling.

End with separate Android/iPhone screenshot and log findings. An incomplete platform is
**Unverified**, with its concrete blocker. Neither a passing unit test nor the other platform is
substitute evidence.
