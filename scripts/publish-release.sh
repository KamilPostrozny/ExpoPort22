#!/usr/bin/env bash
# Replace one rolling prerelease (`prod` or `dev`) with the given assets. Used by both of
# ipa.yml's publishing jobs (`package`, `reembed`) so they publish the same way.
#
#   scripts/publish-release.sh <tag> <title> <notes> <asset>...
#
# Delete-then-create rather than clobber-in-place, so the tag points at the commit that was
# actually built (GITHUB_SHA). Needs GH_TOKEN.
set -euo pipefail

tag=${1:?usage: publish-release.sh <tag> <title> <notes> <asset>...}
title=${2:?}
notes=${3:?}
shift 3
[ "$#" -gt 0 ] || { echo "no assets to publish" >&2; exit 2; }

gh release delete "$tag" --yes --cleanup-tag || true
# The delete and the create race: deleting the tag is not instant on GitHub's side, and
# creating one over it came back HTTP 500 (2026-08-13). Retry rather than throw away a
# build that succeeded — the workflow's artifact upload is the backstop if even this gives up.
for attempt in 1 2 3; do
  if gh release create "$tag" "$@" --prerelease --target "${GITHUB_SHA:?}" \
       --title "$title" --notes "$notes"; then
    exit 0
  fi
  echo "release create failed (attempt $attempt) — waiting"
  sleep 15
done
echo "could not publish; the IPA is on this run as an artifact"
exit 1
