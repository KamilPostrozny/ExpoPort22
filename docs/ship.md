# Getting a build onto the phone

Two platforms, two very different loops, and the difference is one fact: **this machine can build
Android and cannot build iOS.** iOS goes out through CI because `expo prebuild -p ios` needs Xcode
and CocoaPods, which a Linux box does not have. Android is built right here.

# iOS — CI builds, the laptop signs

The loop is split — GitHub Actions builds, the laptop signs and installs.

```
push to main  →  .github/workflows/ipa.yml  →  `dev` prerelease  →  xtool install  →  phone
```

CI builds **unsigned**, on purpose. Signing there would mean putting a certificate in a repo
secret, and free provisioning holds exactly one certificate — xtool already owns it. Signing stays
on the laptop, where that certificate lives.

## 1. Wait for the build

```bash
gh run watch          # or: gh run list --workflow=IPA --limit 1
```

Roughly 15 minutes cold. There is no build cache yet; add one if this starts to hurt.

## 2. Download the rolling build

```bash
gh release download dev --clobber -p Port22.ipa
```

`dev` is replaced by every push to `main`, so this is always the latest `main`, and the release
notes name the commit it came from.

## 3. Confirm the phone is reachable

The install goes over Wi-Fi; the cable is not needed. `netmuxd` makes that work and runs as a
systemd **user** service, so it should already be up, including after a reboot:

```bash
systemctl --user is-active netmuxd || systemctl --user start netmuxd
env USBMUXD_SOCKET_ADDRESS=UNIX:$HOME/.local/share/port22/nm.sock xtool devices
```

Expect the phone and its UDID. Two things that look like "phone is offline" and are not:

- **The `UNIX:` prefix is load-bearing.** Without it libusbmuxd finds nothing and says
  `ERROR: Unable to retrieve device list!`.
- **Never `pkill -f netmuxd`** — the pattern matches the calling shell. `systemctl --user restart
  netmuxd`.

No device, no step 4: with nothing to talk to, xtool blocks on `Waiting for device...` until the
command times out.

## 4. Sign and install

```bash
script -qec "env USBMUXD_SOCKET_ADDRESS=UNIX:$HOME/.local/share/port22/nm.sock \
  xtool install Port22.ipa" /dev/null
```

`script -qec … /dev/null` allocates a pty. Without a controlling terminal anything in xtool that
touches the network or the device dies with `epoll_ctl(...): Operation not permitted`.

**If it asks to revoke a certificate, stop and ask.** Free provisioning has one slot; a revoke
prompt means another signing tool took it, and answering starts a ping-pong where each tool
invalidates the other's builds.

## 5. Point it at Metro

The IPA is a dev client: it ships no JS. Start the bundler on the laptop and open the app —
both on the same network.

```bash
bunx expo start --dev-client
```

## Re-signing

Free provisioning expires after 7 days. When the app stops launching, nothing is wrong with the
build: run steps 3 and 4 again.

# Android — everything is local

No CI, no signing dance, no release to download. `assembleDebug` signs with the SDK's own debug
keystore (`~/.android/debug.keystore`, `CN=Android Debug`, generated on first use), and `adb
install` takes that APK as-is — there is no provisioning profile, no certificate slot to fight
over, and nothing that expires after a week.

**Why there is no companion job to `ipa.yml`, deliberately:** the iOS workflow exists because this
box *cannot* produce an IPA at all. It can produce an APK, in ~6 minutes cold and seconds
incrementally, so a CI job would spend runner minutes rebuilding a file that is already sitting in
`android/app/build/outputs/apk/debug/`. It would also have to re-download the whole SDK and NDK per
run, and there is no second machine and no tester waiting on a URL. Add the job the day somebody
without this toolchain needs the APK; until then it is cost with no reader.

The toolchain lives outside the repo (JDK 21 + SDK 36 under `~/Android`); the one-time install is
in the `android-test` skill, which is also the harness for driving the emulator once the app is on
it. This section is only the build-and-install half.

## 1. Toolchain on PATH

```bash
. ~/Android/env.sh
```

Every command below needs it. `JAVA_HOME` must be the private JDK 21 — the system JDK 26 is
rejected by Gradle 9.3.1 + AGP 8.12, and the failure reads as an unsupported class file version.

## 2. Generate `android/` if it is missing

```bash
bunx expo prebuild -p android && git checkout package.json
```

`android/` is generated and gitignored, exactly like `ios/`; `app.json` is the source of truth.
The `git checkout` is not optional — prebuild rewrites `package.json`'s `android`/`ios` scripts to
`expo run:*`, which this repo does not want.

## 3. Build

```bash
(cd android && ./gradlew assembleDebug --no-daemon)
```

~6 minutes cold (726 tasks), seconds when only JS changed — but a JS-only change needs no rebuild
at all, just a Metro reload. Rebuild for `modules/expo-ssh/android/**`, `app.json`, a dependency
with native code, or an SDK bump. The APK lands at:

```
android/app/build/outputs/apk/debug/app-debug.apk      # ~288 MB, debug symbols and all
```

## 4. Install

```bash
adb devices                    # want exactly one, and `device` not `unauthorized`
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- **Emulator** — it is already attached; `adb devices` lists it as `emulator-5554`.
- **Physical device over USB** — Developer options → USB debugging, plug in, and accept the RSA
  prompt *on the phone*; until you do, `adb devices` says `unauthorized` and the install fails.
- **Physical device over Wi-Fi** (Android 11+, the netmuxd equivalent) — Developer options →
  Wireless debugging → Pair device with pairing code, then

  ```bash
  adb pair PHONE_IP:PAIR_PORT     # the six-digit code from that screen
  adb connect PHONE_IP:5555       # the port on the Wireless debugging screen itself, not the pair one
  ```

With both an emulator and a phone attached every `adb` call needs `-s <serial>` or it errors on
ambiguity — `adb -s emulator-5554 install -r …`.

## 5. Point it at Metro

The APK is a dev client and ships no JS, same as the IPA. `adb reverse` puts the bundler on the
device's own `localhost`, over USB and on the emulator alike:

```bash
adb reverse tcp:8081 tcp:8081
bunx expo start --dev-client                    # reuse the one already on 8081 if there is one
adb shell am start -a android.intent.action.VIEW \
  -d "expoport22://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```

The deep link skips the dev-client's server-picker list. Over a plain Wi-Fi `adb connect` there is
no reverse tunnel — put this box's LAN IP in the URL instead of `localhost`.

## No Release APK yet

`assembleRelease` needs a signing key of its own, so there is no Android twin of the `prod` IPA and
no embedded-bundle check. Every Android frame-rate number therefore carries the debug-build
constant that `ipa.yml` documents. Write it when a measurement needs it.
