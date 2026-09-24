#!/usr/bin/env bash
# Re-embed this checkout's JS into an existing unsigned Release IPA, on Linux, with no Xcode.
#
#   scripts/reembed-js.sh <base.ipa> <out.ipa>
#
# The native half of a Release `.app` (binary, frameworks, Assets.car, storyboards, Info.plist,
# EXConstants' app.config) comes from Xcode on macos-26 and cannot be rebuilt here: xtool only
# builds SwiftPM packages, and actool/ibtool have no Linux equivalent. The JS half is three
# things written by Xcode's "Bundle React Native code and images" phase — `main.jsbundle`,
# `www.bundle/` (the DOM terminal) and `assets/` — and that phase is a plain bash script. This
# runs the same script with the env Xcode would give it, then swaps its output into the base.
# On 1c90010 the output was byte-identical to Xcode's own when run at CI's checkout path; from
# any other path only embedded source paths differ (stack traces, the DOM HTML's hashed name),
# which is self-consistent within one bundle.
#
# The caller must know the base's native half matches this checkout — ipa.yml's gate compares
# `@expo/fingerprint` hashes before calling this; a Hermes bytecode-version check below is the
# last guard. Shared by ipa.yml's `reembed` job and `scripts/install-variant.sh release --local-js`.
# Needs Node, `unzip`, `zip` and `bun install --frozen-lockfile`'s node_modules.
set -euo pipefail

base=${1:?usage: reembed-js.sh <base.ipa> <out.ipa>}
out=${2:?usage: reembed-js.sh <base.ipa> <out.ipa>}
base=$(realpath "$base")
out=$(realpath -m "$out")

cd "$(dirname "$0")/.."
root=$PWD
hermesc=$root/node_modules/hermes-compiler/hermesc/linux64-bin/hermesc
[ -x "$hermesc" ] || { echo "no Linux hermesc at $hermesc — run bun install --frozen-lockfile" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/port22-reembed.XXXXXX")
trap 'rm -rf "$work"' EXIT

unzip -q "$base" -d "$work/ipa"
apps=("$work"/ipa/Payload/*.app)
[ "${#apps[@]}" -eq 1 ] && [ -d "${apps[0]}" ] || { echo "base IPA has no single Payload/*.app" >&2; exit 1; }
app=${apps[0]}
[ -f "$app/main.jsbundle" ] || { echo "base IPA has no main.jsbundle — not a Release build" >&2; exit 1; }

# The env of the generated Xcode phase (expo prebuild's "Bundle React Native code and images"):
# Expo sets ENTRY_FILE/CLI_PATH/BUNDLE_COMMAND, Xcode sets the build dirs. DEST is
# $CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH; the intermediate JS lands in
# $CONFIGURATION_BUILD_DIR and hermesc writes the bytecode into DEST. PODS_ROOT only needs to
# be a path — nothing under it is read when HERMES_CLI_PATH is set.
stage=$work/build/app
mkdir -p "$stage"
NODE_BINARY=$(command -v node)
ENTRY_FILE=$("$NODE_BINARY" -e "require('expo/scripts/resolveAppEntry')" "$root" ios absolute | tail -n 1)
CLI_PATH=$("$NODE_BINARY" --print "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })")
env PROJECT_ROOT="$root" NODE_BINARY="$NODE_BINARY" ENTRY_FILE="$ENTRY_FILE" CLI_PATH="$CLI_PATH" \
  CONFIGURATION=Release PLATFORM_NAME=iphoneos BUNDLE_COMMAND=export:embed \
  CONFIGURATION_BUILD_DIR="$work/build" UNLOCALIZED_RESOURCES_FOLDER_PATH=app \
  PODS_ROOT="$work/no-pods" HERMES_CLI_PATH="$hermesc" \
  bash node_modules/react-native/scripts/react-native-xcode.sh

# Hermes bytecode: 8 bytes of magic, then a little-endian u32 version. The runtime in the base's
# hermesvm.framework only runs its own version; a mismatch crashes at launch. react-native pins
# hermes-compiler and the fingerprint covers the RN version, so this should never trip.
hbc_version() { od -An -tu4 -j8 -N4 "$1" | tr -d ' '; }
want=$(hbc_version "$app/main.jsbundle")
got=$(hbc_version "$stage/main.jsbundle")
echo "HBC bytecode version: base $want, rebuilt $got"
if [ "$want" != "$got" ]; then
  echo "Hermes bytecode version mismatch — the base's runtime cannot run this bundle." >&2
  echo "A full native build is required (ipa.yml: workflow_dispatch with force_build=true)." >&2
  exit 1
fi

# Remove, then copy: an asset deleted by this change must not linger from the base.
rm -rf "$app/main.jsbundle" "$app/www.bundle" "$app/assets"
cp -R "$stage/." "$app/"

# The same presence assertions as ipa.yml's Release package step.
test -f "$app/main.jsbundle" || { echo "no main.jsbundle — export:embed did not run"; exit 1; }
test -d "$app/www.bundle" || { echo "no www.bundle — the DOM component would load nothing"; exit 1; }

rm -f "$out"
mkdir -p "$(dirname "$out")"
(cd "$work/ipa" && zip -qry "$out" Payload)
echo "re-embedded $(sha256sum "$app/main.jsbundle" | cut -c1-12)… main.jsbundle → $out"
