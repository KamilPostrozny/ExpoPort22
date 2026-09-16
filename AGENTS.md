# Read selectively

Load this file once. `CLAUDE.md` imports it; do not load a second copy. Read only the relevant
section of [current behaviour](docs/current.md), then the task's source and tests. Search headings
before opening large files. Exclude `docs/archive/**` from ordinary searches; it is historical,
not instructions. Do not bulk-read documentation.

# Expo and dependencies

Before the first code edit, read https://docs.expo.dev/versions/v57.0.0/ and the relevant API pages;
do not crawl the entire SDK. Check for an Expo SDK module or a maintained package before
writing native code, copied data, or algorithms. Documentation-only edits need no SDK research.

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
Tests/typechecks never substitute. Two harnesses already exist and neither needs the user's help:
Android — the `android-test` path (`. ~/Android/env.sh`, emulator, sshd on `10.0.2.2`); iPhone —
the `ship-and-watch` skill, which decides between a Metro reload and a full CI build plus sideload,
then watches the device log.

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

## Build

Use Bun 1.4.0 (lockfile: `bun.lock`) and Node.js >=22.22.1 (lint-staged's minimum, also covering
Expo SDK 57). From the repository root:

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
```

`build` runs Expo's production export for **iOS and Android**, including the terminal DOM bundle,
into ignored `dist/`. It validates JavaScript/assets, not native compilation, signing or installation.
For APK/IPA builds use [docs/ship.md](docs/ship.md); `bun run android` / `bun run ios` only start
Expo. Use custom native dev clients, never Expo Go. `typecheck` runs `tsc --noEmit` in strict mode.
`src/expo-types.d.ts` loads Expo's CSS/global types even before the CLI generates `expo-env.d.ts`.

## Test

```bash
bun run test
bun run test src/input-model.test.ts
bun run test src/input-model.test.ts -t 'a real spacebar'
```

Tests use `bun:test` and live beside source under `src/`. Run the full suite before pushing;
focused file/name filters are for iteration. Unit tests do not replace either device path below.

## Lint and format

```bash
bun run lint
bun run format:check
bun run format
```

ESLint uses the Expo flat config with Prettier's conflicting style rules disabled. ESLint stays on
major 9: Expo's React plugin currently crashes with ESLint 10. Prettier uses two spaces, single
quotes, semicolons and a 100-column target. Python uses four spaces (`.editorconfig`). The formatting
sweep covers supported code/config files; `.prettierignore` excludes generated/native output,
vendored patches, prose/history and local tool state. Swift/Kotlin/Python/shell have no Prettier
parser and are not rewritten.

The owner-approved `eslint-suppressions.json` records pre-existing errors from introducing the
linter. These remain technical debt, not verified-safe code. Normal `lint` and staged lint block
additional errors. ESLint's baseline counts by file/rule, not exact line, so it cannot distinguish
a replaced violation within the same count. To audit the debt without applying the baseline:

```bash
audit_dir=$(mktemp -d)
bun run lint --suppressions-location "$audit_dir/suppressions.json" # expected to fail until debt is fixed
rmdir "$audit_dir"
```

Do not regenerate/expand suppressions to pass a commit. When fixing debt, review changes from
`bun run lint --prune-suppressions`. Hook dependency warnings are still reported; avoid blind
callback-dependency fixes in the gesture/keyboard paths.

### Git hooks and CI

`bun install --frozen-lockfile` runs `prepare` to install Husky's hooks; on an existing checkout,
`bun run prepare` reinstalls them. `.husky/pre-commit` runs lint-staged: ESLint then Prettier for
staged JS/TS, Prettier for staged supported config/styles. It does not run the full test suite.
Only staged files are checked; review formatter changes before committing.

`.github/workflows/ipa.yml` runs the same build, typecheck, test, lint and format-check commands on
pull requests and non-doc pushes to `dev`/`main`, before native packaging. CI disables local hooks
with `HUSKY=0`; pull requests never package/publish. Unit/static checks are not device evidence.

## Architecture

```text
src/
  app/          Expo Router screens and orchestration (_layout.tsx, index.tsx, terminal.tsx)
  hooks/        Shared React hooks for theme and keyboard state
  *.tsx         UI and the xterm DOM terminal; add UI beside the feature it belongs to
  *-model.ts    Pure logic; colocate regression tests as *.test.ts
modules/
  expo-ssh/        Native SSH/SFTP bridge and TypeScript contract
  expo-pasteboard/ Native clipboard bridge
assets/
  fonts/        Bundled native fonts
  images/       App icons and splash images
public/
  fonts/        Matching fonts served to the DOM terminal
scripts/        Theme/font generation and device install/capture helpers
patches/        Bun-applied React Native dependency patch
.github/
  workflows/    Validation and native iOS packaging (ipa.yml)
docs/
  tests/        Device cases; current.md, issues.md and ship.md are the active references
```

Native modules each contain `src/` contracts plus `ios/` and `android/` implementations.
Put cross-platform app logic in `src/`, not in a native module. `@/` imports resolve to `src/`
(and `@/assets/` to `assets/`) via `tsconfig.json`.

## Conventions

### Naming

- App files use lowercase kebab-case: `src/host-keys.ts`, `src/download-sheet.tsx`.
- Router filenames follow Expo Router: `src/app/index.tsx`, `src/app/_layout.tsx`.
- Hooks use `use-` filenames and camelCase exports: `use-theme.ts` / `useTheme`.
- Components, types and classes use PascalCase: `Plate`, `Settings`, `ExpoSSHModule`.
- Functions and variables use camelCase: `trackLine`, `lineLen`.
- Shared constants use UPPER_SNAKE_CASE: `SHEET_DISMISS_DISTANCE`.
- Native bridge filenames match their PascalCase module: `ExpoSSHModule.ts` / `.swift`.
- Bun tests are colocated `*.test.ts`: `src/input-model.test.ts`; descriptions state behaviour.

### Commits

Recent history mostly uses `type(scope): description` or `type: description`, with a few legacy
subjects such as `Cleanup` and `Docs`. Continue Conventional Commits for new work: `feat`, `fix`,
`chore`, `docs`, `refactor`, `test`, `perf`, `ci` (for example, `fix(terminal): preserve selection`).
Do not rewrite history. Keep a whole-codebase formatting sweep in its own `chore` commit.

## Gotchas / Off-limits

- `android/`, `ios/`, `.expo/` and `dist/` are generated/ignored. Durable native configuration
  belongs in `app.json`, modules or plugins, not generated projects. Prebuild can rewrite scripts.
- `src/themes-generated.ts` is generated by `bun run themes`; do not hand-edit or format it.
- Keep font changes in sync between `assets/fonts/` and `public/fonts/` using `scripts/patch-font.py`.
- `patches/react-native@0.86.2.patch` is applied by Bun; do not reformat patches or vendored code.
- No environment variables are required to launch the app. `.env.example` explains Expo's injected
  base URL and optional shell tooling variables; SSH settings and keys belong in the app, not `.env`.
- Do not bulk-read or reformat `docs/archive/`, or commit device evidence containing private data.

# Task map

- Setup / source map: [README.md](README.md), [current.md](docs/current.md)
- Bugs / uncertain behaviour: [issues.md](docs/issues.md)
- Device cases / recording evidence: [TESTS.md](TESTS.md)
- Build / device tools / troubleshooting: [ship.md](docs/ship.md)
- Historical T-number or old § reference only: [PLAN.md](PLAN.md), [BUGS.md](BUGS.md)
