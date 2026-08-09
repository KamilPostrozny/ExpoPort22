#!/usr/bin/env bash
# Screenshot the phone whenever the app says something worth looking at.
#
# The person tapping is holding the same phone this is watching, so they cannot narrate what they
# just did — they cannot even be in another app. This closes that loop: the app logs what it is
# doing (`[app] active`, `[terminal] screen open`, `[terminal] bell`, …), and every such line takes
# a picture. One path per screenshot on stdout, which is what makes this usable as a Monitor.
#
# Usage: watch-and-shoot.sh <metro-log> [out-dir] [extra-grep-pattern]
set -uo pipefail

log=${1:?path to the Metro output file}
out=${2:-/tmp/port22-shots}
pattern=${3:-'\[app\]|\[terminal\]|\[harness\]|ERROR|Bundling failed'}

# Without the `UNIX:` prefix, unlike xtool and libimobiledevice — pymobiledevice3 splits on ":".
export USBMUXD_SOCKET_ADDRESS="$HOME/.local/share/port22/nm.sock"

mkdir -p "$out"
last=0

tail -n0 -F "$log" | grep -E --line-buffered "$pattern" | while read -r line; do
  # An emptied selection is the *end* of something, and shooting it wastes the debounce window that
  # the interesting frame — text selected, edit menu up — needed.
  [[ $line == *'selection ""'* ]] && continue
  # Leaving the app is not worth a picture — the frame is whatever replaced it. Coming back is.
  [[ $line == *'[app] inactive'* || $line == *'[app] background'* ]] && continue
  now=$(date +%s)
  # A tap produces a burst of log lines and a screenshot takes several seconds; one picture per
  # burst is the useful rate, and anything faster just queues up behind the tunnel setup.
  (( now - last < 2 )) && continue
  last=$now
  file="$out/$(date +%H%M%S).png"
  if timeout 90 pymobiledevice3 developer dvt screenshot "$file" >/dev/null 2>&1; then
    echo "$file <- $line"
  else
    # A failure here is usually the screen being off, which is worth saying rather than swallowing.
    echo "no screenshot (phone asleep?) after: $line"
  fi
done
