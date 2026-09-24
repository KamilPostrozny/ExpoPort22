#!/usr/bin/env bash
# Sign and install one of the two rolling IPA variants onto the phone (xtool over netmuxd, Wi-Fi).
#
#   scripts/install-variant.sh dev      # `dev` prerelease  — Port22-dev, Debug dev client (needs Metro)
#   scripts/install-variant.sh release  # `prod` prerelease — Port22,       Release, JS embedded
#   scripts/install-variant.sh release --local-js
#                                       # `prod`'s native half + THIS working tree's JS, re-embedded
#                                       # on this machine (scripts/reembed-js.sh) — no CI at all
#
# --local-js is a local, uncommitted build: only for a working tree whose native fingerprint
# equals `prod`'s (a JS-only change); it refuses otherwise. It carries this checkout's paths in
# stack traces, and depends on node_modules matching bun.lock (bun install --frozen-lockfile).
#
# Re-running it after ~7 days re-signs the same IPA — that is the free-provisioning renewal, no
# rebuild is needed (docs/ship.md).
set -euo pipefail

variant=${1:?usage: install-variant.sh dev|release [--local-js]}
local_js=false
case "${2:-}" in
  '') ;;
  --local-js) [ "$variant" = release ] || { echo "--local-js only applies to release" >&2; exit 2; }; local_js=true ;;
  *) echo "unknown option '$2' (want: --local-js)" >&2; exit 2 ;;
esac
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

if [ "$local_js" = true ]; then
  # The same comparison ipa.yml's gate makes: `prod`'s recorded native fingerprint against this
  # working tree's. Anything but an exact match means the base cannot run this JS safely.
  rm -f "$(dirname "$out")/fingerprint.json"
  if ! gh release download "$tag" --clobber -D "$(dirname "$out")" -p fingerprint.json; then
    echo "$tag has no fingerprint.json — cannot prove its native half matches this tree." >&2
    exit 1
  fi
  base_fp=$(node -p 'require(process.argv[1]).hash' "$(dirname "$out")/fingerprint.json")
  here_fp=$(bunx @expo/fingerprint fingerprint:generate --platform ios | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).hash')
  if [ "$base_fp" != "$here_fp" ]; then
    echo "native fingerprint differs ($tag $base_fp, here $here_fp) — this needs a native build." >&2
    exit 1
  fi
  scripts/reembed-js.sh "$out" "${out%.ipa}-local-js.ipa"
  out="${out%.ipa}-local-js.ipa"
fi

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
  release) echo "installed Port22 (release$([ "$local_js" = true ] && echo ', local JS')). Launch it directly — no bundler needed." ;;
esac
