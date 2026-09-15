# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.
Do this before the first code edit, not later in implementation.

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

- an API that exists on one platform only (`keyboardWillChangeFrame` has no Android twin, so the
  keyboard pad is driven off `keyboardDidShow`/`Hide` there; `presentationStyle="pageSheet"` is an
  iOS Modal mode; `ascii-capable` is an iOS `keyboardType`),
- a hardware or OS affordance the other platform does not have (Android's system back button, the
  gesture-nav edge, runtime permission prompts),
- the same quantity reported in two conventions, where the arithmetic has to differ to reach one
  answer (the keyboard pad again: iOS gives a screen-space frame that runs to the bottom edge and
  the safe-area strip comes off it, Android reports a height that already stops at the gesture
  strip and nothing comes off).

**"Android does that for us" is a claim with a shelf life — measure it.**

- This file used to name a third kind: an OS behaviour that would double up, "Android resizes its
  own window for the keyboard".
- It does under `adjustResize`, and this app is edge-to-edge, where it does not — measured on the
  emulator 2026-08-16, IME inset at y=1517 and the activity's frame still the whole 1080×2400.
- On the strength of that sentence the terminal skipped the keyboard entirely on Android: the key
  bar sat under Gboard and the shell was never told it had lost eighteen rows, and nobody saw it
  because the emulator's keyboard had never been raised in a test.

A branch that exists to make something *look* different is not necessary — delete it and take the
iOS value. When you do add a necessary branch, say in a comment which of the three it is and what
breaks without it; "Android is different" is not a reason, and neither is a design doc that no
longer exists. The look on both sides of a necessary branch still has to match: an Android sheet may
have to be built out of a different Modal mode, but it must come out the same size, the same corner
radius and the same colour as the iOS one.

Where a platform genuinely cannot reach parity, that is a finding to raise, not a divergence to
quietly ship.

# Nothing is done until it has run on both

**No exceptions for supposedly non-visual changes:** an Expo code edit — including a refactor or
“pure log removal” — is not done or fixed until both device paths below have run. Typechecks and
tests are additional checks, never substitutes.

- **Every new implementation is tested on the Android emulator *and* on the real iPhone before it is
  reported as working.**
- Not one of them, not "it type-checks", not "the Android half is the same code so it must render the
  same" — both, on the actual screens, with a screenshot and a log read.
- The whole point of the rule above is that the two builds look alike, and that is a claim about
  pixels, which only a device can settle.
- Half the divergences this repo has found (a Material teal switch thumb, a tofu chevron, an Android
  font scale) were invisible in the source and obvious on the screen.

Before reporting any Expo change as shipped, invoke `ship-and-watch` and complete its
platform-specific verification path.

The two harnesses already exist and neither needs the user's help:

- Android — the `android-test` skill (`. ~/Android/env.sh`, emulator, sshd on `10.0.2.2`).
- iOS — the `ship-and-watch` skill, which decides between a Metro reload and a full CI build plus
  sideload and then watches the device log.

**A Metro bundler on 8081 is taken, not asked.** If one is already running (pid, port), `kill` it
and start the bundler in-session, because the device log is only readable from the process that
owns the port; never arm a log watch on someone else's bundler (user, 2026-09-11).

Completion reports must contain separate Android and iPhone entries, each stating what the
screenshot showed and what the logs showed. If one platform cannot be reached, explicitly mark it
unverified; typechecks, tests, static inspection, or evidence from only the other platform do not
substitute.

End every completion report with this checklist; never omit a row:

- **Android:** screenshot — …; logs — …
- **iPhone:** screenshot — …; logs — …

If a path did not complete, write **Unverified** and the blocker in its row; do not replace the row
with test or typecheck results.

