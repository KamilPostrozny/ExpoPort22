# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# One app, two platforms — iOS is the spec

**The design files are gone** (`docs/design/`, deleted 2026-08-16) and they are not coming back. Do
not look for them, do not re-fetch them from the Claude Design project, and do not treat a surviving
reference to `Port22-Prototype.dc.html` or `Port22-Android-Prototype.dc.html` in an old comment as
authority — those comments are stale by definition, and the Android one is now the opposite of the
rule. There is no separate Android design. There is no "Material skin". There is one app.

**The iOS build is the spec.** Android has to be an exact copy of it: the same icons, the same
fonts, the same buttons, the same colours, the same corner radii, the same spacing, the same
animations. If the two builds sit side by side and anything reads as different, that is a bug on the
Android side, and the fix is to match iOS — never to pick a value that "suits Android better".

**No `Platform.OS` branching unless it is completely necessary.** Necessary means the system leaves
no choice:

- an API that exists on one platform only (`keyboardWillChangeFrame` has no Android twin;
  `presentationStyle="pageSheet"` is an iOS Modal mode; `ascii-capable` is an iOS `keyboardType`),
- a hardware or OS affordance the other platform does not have (Android's system back button, the
  gesture-nav edge, runtime permission prompts),
- an OS-level behaviour that would otherwise double up (Android resizes its own window for the
  keyboard, so iOS's manual padding would subtract it twice).

A branch that exists to make something *look* different is not necessary — delete it and take the
iOS value. When you do add a necessary branch, say in a comment which of the three it is and what
breaks without it; "Android is different" is not a reason, and neither is a design doc that no
longer exists. The look on both sides of a necessary branch still has to match: an Android sheet may
have to be built out of a different Modal mode, but it must come out the same size, the same corner
radius and the same colour as the iOS one.

Where a platform genuinely cannot reach parity, that is a finding to raise, not a divergence to
quietly ship.

# Nothing is done until it has run on both

**Every new implementation is tested on the Android emulator *and* on the real iPhone before it is
reported as working.** Not one of them, not "it type-checks", not "the Android half is the same
code so it must render the same" — both, on the actual screens, with a screenshot and a log read.
The whole point of the rule above is that the two builds look alike, and that is a claim about
pixels, which only a device can settle. Half the divergences this repo has found (a Material teal
switch thumb, a tofu chevron, an Android font scale) were invisible in the source and obvious on
the screen.

The two harnesses already exist and neither needs the user's help:

- Android — the `android-test` skill (`. ~/Android/env.sh`, emulator, sshd on `10.0.2.2`).
- iOS — the `ship-and-watch` skill, which decides between a Metro reload and a full CI build plus
  sideload and then watches the device log.

Read the log and the screenshot yourself and say per platform what passed; "did it work?" is not a
report. If one platform cannot be reached in the session, say which one and that the change is
therefore unverified there — an untested half is a finding, not a footnote.

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
