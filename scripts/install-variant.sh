#!/usr/bin/env bash
# Sign and install one of the two rolling IPA variants onto the phone (xtool over netmuxd, Wi-Fi).
#
#   scripts/install-variant.sh dev      # `dev` prerelease  — Port22-dev, Debug dev client (needs Metro)
#   scripts/install-variant.sh release  # `prod` prerelease — Port22,       Release, JS embedded
#
# Re-running it after ~7 days re-signs the same IPA — that is the free-provisioning renewal, no
# rebuild is needed (docs/ship.md).
set -euo pipefail

variant=${1:?usage: install-variant.sh dev|release}
case "$variant" in
  dev)     tag=dev  ;;
  release) tag=prod ;;
  *) echo "unknown variant '$variant' (want: dev|release)" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
# Both tags carry the asset under the same name (Port22.ipa) — -p filters by that name, -D picks
# the directory. The staging dir lives outside the repo: 30 MB in the working tree on every
# install is a mess, and xtool does not care where the file sits.
out="${TMPDIR:-/tmp}/port22-install/Port22-$variant.ipa"
mkdir -p "$(dirname "$out")"
gh release download "$tag" --clobber -D "$(dirname "$out")" -p "Port22.ipa"
mv "$(dirname "$out")/Port22.ipa" "$out"
echo "downloaded $tag → $out"

# The `UNIX:` prefix is load-bearing — without it libusbmuxd finds nothing. Never `pkill -f
# netmuxd`; the pattern matches this very shell.
systemctl --user is-active netmuxd || systemctl --user start netmuxd
if ! env USBMUXD_SOCKET_ADDRESS=UNIX:"$HOME/.local/share/port22/nm.sock" xtool devices; then
  echo "no device listed — plug the phone in and re-run." >&2
  exit 1
fi

# `script -qec` allocates a pty. Without a controlling terminal anything in xtool that touches the
# network or the device dies with `epoll_ctl(...): Operation not permitted`.
script -qec "env USBMUXD_SOCKET_ADDRESS=UNIX:$HOME/.local/share/port22/nm.sock xtool install $out" /dev/null

case "$variant" in
  dev)     echo "installed Port22-dev. Point it at the bundler: bunx expo start --dev-client" ;;
  release) echo "installed Port22 (release). Launch it directly — no bundler needed." ;;
esac
