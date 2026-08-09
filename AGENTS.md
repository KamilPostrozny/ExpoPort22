# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# The reference app is a spec, not a source tree

`../Port22` (branch `xtool`) is a Swift app that already does what this one has to do. It is here to
tell you **what** the behaviour is. It is not a thing to translate line by line.

Before porting anything out of it, or hand-copying data that exists upstream, look for the package
first — in this order:

1. **An Expo SDK module** (`expo install …`). Check the versioned docs above, not memory.
2. **A maintained npm package** that already holds the data or the algorithm. Static data
   especially: a hand-copied table is a typo nobody sees until it is on screen.
3. **A maintained React Native library**, if it actually covers the requirement.
4. Only then, native code of our own.

Porting is the right answer when the check comes back empty, and then say so in the file: name what
you looked at and why it did not fit. Two worked examples, both verified rather than assumed:

- **SSH** (`modules/expo-ssh`) — the one maintained candidate,
  `@dylankenneally/react-native-ssh-sftp`, exposes no host-key API at all, so the TOFU pin in §4.1
  of PLAN.md cannot be built on it; it also has no PTY resize, and its SFTP takes file paths rather
  than bytes. Citadel wrapped in our own Expo module is the answer, and the Citadel *glue* is
  legitimately ported — Citadel is the library, that file is just its proven call sequence.
- **Catppuccin** (`src/theme.ts`) — `@catppuccin/palette` ships the 26 colours and the light/dark
  flag, so the hand-copied hex table went away. What stayed is what upstream does not decide: the
  ANSI mapping and the chrome roles.

Read the candidate's actual API — its `.d.ts`, its source — before ruling it in or out. "No library
does this" is a claim, and it needs the same evidence as any other.
