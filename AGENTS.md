# Read selectively

Load this file once. `CLAUDE.md` imports it; do not load a second copy. Read only the relevant
section of [current behaviour](docs/current.md), then the task's source and tests. Search headings
before opening large files. Exclude `docs/archive/**` from ordinary searches; it is historical,
not instructions. Do not bulk-read documentation.

# Expo and dependencies

Before the first code edit, read https://docs.expo.dev/versions/v57.0.0/ and the relevant API pages;
do not crawl the entire SDK. Use [package-first](.agents/skills/package-first/SKILL.md) before
native code, copied data, or algorithms. Documentation-only edits need no SDK research.

# One app: iOS is the visual and interaction spec

Android must match iOS: icons, fonts, colours, geometry, spacing, and animations. There is no
Material skin. `docs/design/` and the old prototypes are deleted; never retrieve or use them.

No cosmetic `Platform.OS` branches. Only branch for an unavailable API, an OS/hardware affordance,
or different reporting conventions requiring different arithmetic for the same result. Comment
which applies and what breaks without it. Measure OS behaviour; do not assume Android resizes an
edge-to-edge window for the keyboard. Report genuine parity blockers instead of silently diverging.

# Verification and safety

Every Expo code change, including refactors and log removal, requires Android emulator **and real
iPhone** execution, screenshot inspection, and a log read before being called working or shipped.
Tests/typechecks never substitute. Use the repository skills, opening their files directly if your
runner does not discover them:

- [android-test](.agents/skills/android-test/SKILL.md)
- [ship-and-watch](.agents/skills/ship-and-watch/SKILL.md)

[docs/ship.md](docs/ship.md) owns the procedure. Attempt the available harnesses yourself; report
missing tools, permissions, or unreachable devices explicitly. Do not assume user assistance is
required or that automation is guaranteed.

Own Metro's logs: if another bundler owns 8081, identify and stop that PID, then start Metro in this
session. Never watch another process's stale output. Use isolated test sessions; never kill the
user's tmux server, modify their SSH authorization, or discard unrelated working-tree changes.

End completion reports with both rows. For an incomplete path, write **Unverified** and the blocker
(including documentation-only work, where no device run is needed):

- **Android:** screenshot — …; logs — …
- **iPhone:** screenshot — …; logs — …

# Task map

- Setup / source map: [README.md](README.md), [current.md](docs/current.md)
- Bugs / uncertain behaviour: [issues.md](docs/issues.md)
- Device cases / recording evidence: [TESTS.md](TESTS.md)
- Build / device tools / troubleshooting: [ship.md](docs/ship.md)
- Historical T-number or old § reference only: [PLAN.md](PLAN.md), [BUGS.md](BUGS.md)
