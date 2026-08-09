---
name: ship-and-watch
description: Close out a finished change in the ExpoPort22 repo — commit and push it, decide whether it needs only a Metro reload or a full CI build and sideload, drive whichever path it is end to end without asking, then arm a log watch and report what the device actually did. Use whenever a coding task, fix or task slice (T1–T13) is finished in /home/kamil/Projects/ExpoPort22, even if the user does not ask by name, and on "ship it", "get it on the phone", "install on device", "watch the logs", "does it work on device", "arm the logs".
---

# Ship ExpoPort22 to the phone, then watch it run

This machine is Linux: no Xcode, no local iOS build. A change is unverified until it is running on
the phone and its log has been read. That makes this the closing step of every development session
here — not an optional extra, and not something to ask permission for (user decision, 2026-08-09:
push automatically during the development phase, because it is the only route to a device).

Two paths lead to the phone. Picking the wrong one costs either 15 minutes of build or an hour of
debugging a runtime error that is really a stale dev client. Pick it deliberately.

## 1. Gate, commit, push — always

```bash
cd /home/kamil/Projects/ExpoPort22 && bun test && bunx tsc --noEmit
```

Both green before the push. A red push burns a full CI run and lands nothing installable.

Commit with the task slice in the subject (`feat: … (T4)`), then `git push origin main`. The push is
what starts the build; nothing else does.

Docs-only commits (`**.md`, `docs/**`) are excluded by `paths-ignore` in `.github/workflows/ipa.yml`
and produce no run. That is expected — do not go hunting for the missing workflow.

## 2. Which path

Read what the commit actually touched.

**Metro reload is enough** — the dev client already on the phone can run it:

- anything under `src/`, including DOM components (`'use dom'` files are bundled by Metro like any
  other JS);
- `public/**` — in dev the DOM middleware serves it from `/_expo/@dom` on the dev server; the copy
  into `www.bundle` only matters in an embedded build;
- a new dependency that is pure JS (`@xterm/*`, `@catppuccin/palette`, …);
- assets loaded through `require()`.

**Full CI build and sideload** — the native half of the app changed, and the installed dev client
does not contain it:

- a new or removed dependency carrying native code — anything with an `ios/` directory and an
  `expo-module.config.json` (every `expo-*` package: `expo-haptics`, `expo-clipboard`,
  `expo-image-picker`, …). Adding one and reloading Metro fails at runtime with
  `Cannot find native module '…'`, which reads like a JS bug and is not;
- `modules/expo-ssh/**` — Swift, Kotlin, or the podspec;
- `app.json` — plugins, `expo-build-properties`, Info.plist strings, orientation, icons;
- an Expo SDK or react-native version bump;
- **the build on the phone is more than 7 days old.** Free provisioning expires; the app simply
  stops launching. Same steps, but it is a re-sign, not a rebuild — skip straight to §4.3.

`@expo/dom-webview` is *not* one of these: it ships inside `expo` itself and is already autolinked
into every build.

When genuinely unsure, rebuild. A stale-native-module failure costs more to diagnose than a build
costs to wait for.

## 3. Metro path

```bash
cd /home/kamil/Projects/ExpoPort22 && bunx expo start --dev-client
```

Run it with `run_in_background: true` and keep the output file path from the tool result — §5 tails
it. Tell the user to reload the app (shake → Reload, or `r` in the bundler). Then go to §5.

**First check whether a bundler is already up**, because the logs are only readable from the process
that owns them:

```bash
ss -ltnp | grep :8081
```

If one is running in the user's own terminal, `expo start` here prints `Port 8081 is running this
app in another window` and skips the dev server — and any watch armed on its output file stays
silent forever, which reads exactly like a healthy quiet app. **Take the port**: `kill <pid>`, start
the bundler here, and say you did it. The logs are only readable from the process that owns them,
and reading them is the point of this skill (user decision, 2026-08-09).

The app then has to reconnect once — it was talking to the dead server. Ask for exactly one manual
step: relaunch the app from the phone. After that, reloads are yours to trigger (§5.1).

## 4. CI path

`docs/ship.md` is the authority and explains why each piece is there. The short form:

### 4.1 Wait for the build

```bash
gh run watch $(gh run list --workflow=IPA --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Run it with `run_in_background: true` — it exits when the run ends, which is one notification, and
a non-zero exit means the build failed. Roughly 15 minutes cold. Do the next task's reading while it
runs; do not block on it.

### 4.2 Download

```bash
gh release download dev --clobber -p Port22.ipa
```

`dev` is rolling — always the latest `main`, and its notes name the commit.

### 4.3 Confirm the phone before touching xtool

```bash
systemctl --user is-active netmuxd || systemctl --user start netmuxd
env USBMUXD_SOCKET_ADDRESS=UNIX:$HOME/.local/share/port22/nm.sock xtool devices
```

- The `UNIX:` prefix is load-bearing. Without it, libusbmuxd finds nothing and says
  `ERROR: Unable to retrieve device list!`, which looks exactly like a phone that is off the network.
- **Never `pkill -f netmuxd`** — the pattern matches the calling shell. `systemctl --user restart netmuxd`.
- No device listed, no install: `xtool` blocks on `Waiting for device...` until the command times out.

### 4.4 Sign and install

```bash
script -qec "env USBMUXD_SOCKET_ADDRESS=UNIX:$HOME/.local/share/port22/nm.sock \
  xtool install Port22.ipa" /dev/null
```

`script -qec … /dev/null` gives it a pty; without one, anything touching the network or the device
dies with `epoll_ctl(...): Operation not permitted`.

**If it asks to revoke a certificate, stop and ask the user.** Free provisioning holds one
certificate and xtool owns it; answering starts a ping-pong where each signing tool invalidates the
other's builds. That slot is the user's to spend.

Then start Metro as in §3 — the IPA is a dev client and ships no JS.

## 5. Arm the logs

Every `ExpoSSH` call, result and event goes to the Metro console, deliberately (PLAN.md §7), along
with `[keys]`, `[harness]` and `[terminal]`. Watch that stream with a persistent `Monitor` over the
bundler's output file:

```
tail -n +1 -f <metro output file> | grep -E --line-buffered \
  "\[ExpoSSH\]|\[terminal\]|\[harness\]|\[keys\]|ERROR|Error:|error:|Unable|Cannot find|Invariant|Unhandled|Bundling failed|Native module|Failed to"
```

`persistent: true`. The filter must catch a red box, not only the happy lines — silence is not
success, and a monitor that greps only for what you hoped to see stays quiet through a crash.

Then say, in one or two lines, what to tap on the phone and what the log should print if it worked.

## 5.1 Reload the app yourself

Metro's message socket broadcasts to every connected client, which is exactly what pressing `r` in
the bundler does. Use it after every fix — do not ask the user to reload:

```bash
bun -e 'const ws = new WebSocket("ws://localhost:8081/message");
  ws.onopen = () => { ws.send(JSON.stringify({ version: 2, method: "reload" }));
  setTimeout(() => process.exit(0), 500); };'
```

`"devMenu"` in place of `"reload"` opens the dev menu on the device. Both are silent no-ops when no
app is connected — after the reload, confirm from the log that a bundle was actually served
(`iOS Bundled … ms`), or you are watching a phone that is talking to nothing.

The edit → reload → read-the-log loop is yours to run end to end; the user's only manual step is the
first relaunch after a bundler takeover.

## 5.2 Screenshot the phone

The log cannot see pixels, and half of a terminal's bugs are pixels. `pymobiledevice3` takes a real
screenshot over the same netmuxd socket, with **no root** — it falls back to a userspace tunnel on
iOS 17+ by itself:

```bash
env USBMUXD_SOCKET_ADDRESS=$HOME/.local/share/port22/nm.sock \
  pymobiledevice3 developer dvt screenshot shot.png
```

Then Read the PNG. Two traps:

- **No `UNIX:` prefix here**, unlike xtool and libimobiledevice: pymobiledevice3 splits the value on
  `:` and dies with `invalid literal for int()`. The same variable wants a different format for the
  two toolchains.
- **A black frame means the screen is off**, not that the app crashed. Ask for the phone to be woken
  rather than debugging a rendering bug that is not there.

Installed with `uv tool install pymobiledevice3`. `idevicescreenshot` from libimobiledevice does
*not* work on iOS 17+ (`Could not start screenshotr service: Invalid service` — it wants a mounted
Developer Disk Image); pymobiledevice3 is the one that handles the modern tunnel.

Take a screenshot after any change that alters what is drawn, and before declaring a visual thing
fixed. Three bugs in T4 were invisible in the log and obvious in the picture: letters spaced like a
ransom note (cell measured before the webfont arrived), bold runs wider than their cells (only the
regular face was preloaded), and a long-press that did nothing (the `user-select` chain).

## 6. Report

Say which path was taken, what is now on the phone, and what the log showed — including the case
where it showed nothing. A quiet log after the user taps the thing that changed means the change did
not run, and that is a finding, not a pass.

Do not start the next slice while the current one is unverified: two unverified changes on the phone
leave two suspects and no way to tell which broke what.

## Failure modes

| Symptom | Cause |
|---|---|
| `Cannot find native module 'Expo…'` after a reload | §2 called it wrong — a native dependency was added; rebuild path. |
| App will not launch at all, no Metro connection | 7-day free-provisioning expiry. §4.3–4.4 again; no rebuild needed. |
| No CI run appeared after a push | Docs-only commit: `paths-ignore` in `ipa.yml`. |
| CI red inside `xcodebuild` on a toolchain error | Re-dispatch the workflow with a different `xcode` input (26.6 default). |
| `ERROR: Unable to retrieve device list!` | Missing `UNIX:` prefix, or netmuxd down — not necessarily the network. |
| `epoll_ctl(...): Operation not permitted` | The `script -qec` pty wrapper was dropped. |
| Metro says no apps connected | App not opened, or phone and laptop on different networks. |
| `Port 8081 is running this app in another window` | The user's own bundler owns the logs. §3 — ask before killing it; never arm a watch on the empty output file. |
| DOM component renders but its fonts are the fallback | `public/fonts` missing from the dev server; check the file is in `public/`, not only `assets/`. |
