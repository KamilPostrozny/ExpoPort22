# Port22

A personal iOS/Android SSH terminal for one host, with tmux window switching, terminal search,
clipboard integration, and SFTP uploads/downloads. iOS is the visual and interaction reference;
Android must match it.

## Development

Expo SDK 57, React Native, TypeScript, Expo Router, Bun. **Use a native development build, not
Expo Go:** the app includes custom SSH, pasteboard, and WebView modules. Linux builds Android
locally; iOS builds through GitHub Actions and is signed/installed locally.

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run test
bun run lint
bun run format:check
```

`build` exports iOS/Android production JavaScript and assets to `dist/`; it does not create an
APK/IPA. [AGENTS.md](AGENTS.md) documents formatting, hooks, the existing lint baseline, and focused
tests. For an already installed compatible development client:

```bash
bunx expo start --dev-client
```

Follow [the device workflow](docs/ship.md) for Metro ownership, initial builds, installation,
reloading, screenshots, and logs. JS changes usually need only a reload; native changes require
rebuilding the affected client. `bun run android` / `bun run ios` start Expo; they do not build the
custom native modules. There is no `reset-project` command.

## Source map

| Path | Responsibility |
|---|---|
| `src/app/` | Router screens: setup, terminal orchestration, layout |
| `src/terminal.tsx` | xterm.js DOM component, terminal protocols and touch input |
| `src/keybar.tsx`, `src/hooks/use-terminal-keyboard.ts` | Native text input, keys, keyboard docking |
| `src/session.ts`, `src/tmux.ts` | SSH lifecycle, tmux store and side-channel operations |
| `src/*-model.ts`, `src/*.test.ts` | Pure logic and Bun regression tests |
| `src/switcher.tsx` | Window cards and search UI |
| `src/theme.ts`, `src/fonts.ts`, `src/style.ts` | Shared appearance; generated themes come from `scripts/gen-themes.ts` |
| `src/upload*`, `src/download*`, `src/clipboard*` | Transfers and clipboard |
| `modules/` | Native `expo-ssh`, `expo-pasteboard`, `expo-webguard` |
| `assets/`, `public/` | Bundled app and DOM assets |
| `scripts/`, `.github/workflows/ipa.yml` | Font/theme tooling and device delivery |

`app.json`, `package.json`, and `bun.lock` define the build. Generated `android/` and `ios/` are
not the source of truth; do not make durable configuration changes only there.

## Documentation for small-context agents

[AGENTS.md](AGENTS.md) is the mandatory brief; [CLAUDE.md](CLAUDE.md) imports it. Agent runners must
be configured to load it once—model choice alone does not enable this. Skills are in
`.agents/skills/*/SKILL.md`; their paths are also linked explicitly for runners without discovery.
Avoid auto-loading the rest of the docs or external personal memory files.

| Need | Read on demand |
|---|---|
| Current behaviour and constraints | [docs/current.md](docs/current.md) |
| Active issue triage | [docs/issues.md](docs/issues.md) |
| Feature-specific verification | [TESTS.md](TESTS.md) |
| Device workflow | [docs/ship.md](docs/ship.md) |
| Old implementation/evidence | [archive index](docs/archive/README.md), only for historical investigation |

Keep current requirements, test procedures, and execution evidence separate. Update the relevant
current document when behaviour changes. Put long investigations in the archive, with a link from
the active issue. Do not append contradictory corrections beneath obsolete instructions.
