# Getting a build onto the phone

This machine runs Linux, so nothing here can build an Expo app locally: `expo prebuild` needs
Xcode and CocoaPods. The loop is split — GitHub Actions builds, the laptop signs and installs.

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
