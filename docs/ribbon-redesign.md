# The ribbon, redesigned — three approaches

Research and design study for §4.4's context ribbon. Commissioned because every version so far has
been *"either not visible, or too intrusive and takes too much space, or is not readable enough if
not taking up space."*

Fourteen agents: one measured the app's real geometry from source, five swept the literature and
the shipping competition, one proposed six mechanisms, three judged them on independent axes, three
wrote full specs, and one adversarially verified every claim against the actual files and
`node_modules`.

**Full specs:** [Accessory](ribbon/spec-accessory.md) · [Compact](ribbon/spec-compact.md) ·
[Reader](ribbon/spec-reader.md)

> **Postscript, 2026-08-16 (b427712).** This study's central finding — that an opaque plate beats
> glass over unpredictable content, and that `expo-blur` cannot cross the WebView's window boundary
> on Android — was generalised from the ribbon to the whole app. Blur is gone everywhere,
> `expo-blur` is uninstalled, and `Glass` in `src/keybar.tsx` is now `Plate`: opaque
> `theme.surface`, a 0.5pt hairline, no shadow, one code path for both platforms. The dependency
> survey below is therefore out of date in one direction only — `@expo/ui`, `expo-glass-effect`
> and `expo-symbols` were all *uninstalled* rather than adopted. The reasoning is still worth
> reading; the package inventory is not.

---

## 1. The complaint is one bug, and it is measurable

The three symptoms are not three problems. They are one wrong decision — **a translucent plate
trying to work against two opposite extremes at once** — plus one wrong channel.

Measured from `src/ribbon.tsx` as shipped (sRGB relative luminance, WCAG 2.2):

| what | measured | needs | verdict |
|---|---|---|---|
| 12.5pt cap caption on `surface@0.62`, over bright output | **1.76 : 1** (APCA Lc 22.5) | 4.5 : 1 | unreadable |
| **red destructive label** over bright output | **1.69 : 1** | 4.5 : 1 | the most dangerous cap is the least legible |
| capsule body vs a normal dark pane | **1.17 : 1** | 3 : 1 (SC 1.4.11) | invisible |
| the 5pt closed tab | APCA **Lc ~15** | Lc 15 = *"treat as invisible"* | invisible by definition |

And the discovery cue is in the weakest channel there is. Bartram, Ware & Calvert (IJHCS 58(5),
2003) measured peripheral **colour** cues missed **25%** of the time versus **under 2%** for
motion — and ranked the motion families: *blink < slow linear oscillation < zoom < travel*. The
shipped handle pulses opacity **and** `scaleY` at 0.53 Hz: a blink/zoom hybrid, the two worst
families, encoded on a 5pt **colour** target. It is close to a worst case on the published
evidence.

Two more, found by reading the source rather than the design notes:

- **The open panel's scrim eats the key bar.** `RibbonPanel`'s full-screen `Pressable`
  (`src/ribbon.tsx:221`) renders *after* the key bar (`terminal.tsx:2376` vs `:2320`) and there is
  no `zIndex` in the tree — so while the panel is open, Ctrl / Esc / Tab / Paste / arrows / tabs are
  all dead, and the first tap on any of them only closes the panel. Combining a cap with a modifier
  is impossible today.
- **`BarMenu` and `ClipboardPopover` have the same unreadability defect**, unfiled. They are bare
  `Glass` (blur + a 0.08 tint + a hairline) over the live pane; they only get away with it because
  they open rarely.

**Corrected constraint.** The design notes say "never reserve vertical height". That is not quite
the rule the code implements: `barHeight` → `barPad` → `innerH` → `paneInsets.bottom`
(`terminal.tsx:1765-1787`), and arming Ctrl already takes the bar stack from 60 to ~120pt — i.e.
**the app already accepts a ~60pt terminal reflow on an explicit user action, today.** The real
rule is *don't reserve height **on a poll***. Also: `popBase` is **not** a fixed anchor; it moves
~60pt when Ctrl arms and again when the keyboard opens.

---

## 2. What the evidence actually says

Everything below was fetched and read, not recalled.

**Legibility over content you don't control**

- No *single* colour can pass SC 1.4.11 over this terminal, because the terminal draws in the same
  theme — every candidate role colour can land on itself at exactly **1.00 : 1**. The only
  construction that survives is W3C technique **C40**: two adjacent strokes of contrasting colours,
  so at least one always clears 3:1. ([C40](https://www.w3.org/WAI/WCAG22/Techniques/css/C40))
- Apple's own answer to glass over bright content is not thinner glass: *"consider adding a dark
  dimming layer of 35% opacity"*, and *"thicker materials… provide better contrast for text and
  other elements with fine features"*
  ([HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)). The
  Dynamic Island *"uses a black opaque background."* Apple shipped the failure and reversed it —
  Liquid Glass went clear → frosted between iOS 26 beta 1 and beta 3.
- Backdrop blur is the wrong tool for monospaced text specifically, and on Android it barely exists:
  `expo-blur` now needs the blurred content wrapped in `BlurTargetView` and **cannot cross window
  boundaries** — and our terminal is a WebView. Any translucent design was Android-broken from the
  start.

**Being noticed without interrupting**

- Slow linear oscillation is the peer-reviewed best "self-appearing but not intrusive" signal
  (Bartram et al., guideline G8: *"not considered intrusive or distracting"*); amplitude barely
  affects detection, so 2–4pt is enough.
- WCAG **2.2.2 Pause, Stop, Hide (Level A)**: motion that starts by itself and runs over five
  seconds must be stoppable. An indefinite `withRepeat(…, -1)` the user never started **fails at
  Level A**. Every proposal here is finite and self-terminating.
- Yantis & Jonides (1990): attentional capture by abrupt onset is **suppressed when attention is
  already focused**. A user reading terminal output will not be captured by anything, at any
  amplitude — so the cue must survive to their *next* glance rather than win the current one. That
  single finding is why the shipped tab could never have worked, and it is what separates the three
  finalists.
- Bailey & Konstan (2006, N=50): interrupting mid-task cost 3–27% more time, **2× the errors** and
  31–106% more annoyance — and *"deferring presentation for a short time, i.e. just a few seconds,
  can lead to a large mitigation of disruption."* Hence: gate arrival on output quiescence.

**Reach and size**

- Parhi, Karlson & Bederson (MobileHCI '06): **≥9.2mm** discrete / **≥9.6mm** serial for one-handed
  thumb use; 29.9% error at 3.8mm, because thumbs land where a target *looks*, not where its hit
  rect is — hit-slop on a 5pt tab was never going to work. Also: right-side targets *"should extend
  all the way to the edge."* 44pt ≈ 9.7mm at 3×.
- Hoober (1,333 observations): 49% one-handed, of those 67% right thumb.

**How many items a menu can carry**

- Kurtenbach's thesis: breadth-12 flat menus *"border on unreliability"*; Kurtenbach & Buxton
  (INTERCHI '93) measured <10% error only to breadth 8 / depth 2. Material caps FAB menus at 2–6.
  **The 12-cap agent recipe is over every documented ceiling for a menu you aim at from memory** —
  which is an argument for a *toolbar you read*, not a menu you aim at.
- NN/g (n=179): hidden navigation used in 57% of mobile cases vs **86%** for visible/combo, >20%
  lower discoverability, 15–39% longer tasks. Combo matched visible on nearly every measure.

**What the competition actually ships**

- **Termius**: *"The keyboard add-on displays the three first groups of hotkeys… sits directly
  above the system keyboard and is always visible while typing."*
- **Blink Shell**: SmartKeys live exactly as long as the on-screen keyboard; its Context Bar is
  summoned by **double-tapping the iOS home bar**.
- **Panic Prompt 3**: an Extra Keyboard Row, shipped **off by default**.
- **Adobe's Contextual Task Bar** (the closest analogue to a self-positioning contextual surface):
  the top user complaint is that it **repositions itself mid-task**; Adobe's shipped answer was a
  pin.
- Every shipping iOS terminal puts extra keys in a **horizontal band in the bottom chrome**. None
  of them reserves it permanently.

**Platform escape hatches, checked**

- `@expo/ui` (~57.0.9, was installed and referenced nowhere in `src/`; **uninstalled 2026-08-16**)
  gives a real SwiftUI `Menu` / Compose `DropdownMenu`. But: **a UIMenu cannot present itself** —
  programmatic open is Android-only. It can be the *open half*, never the whole design.
- `expo-glass-effect` (~57.0.1, was installed and unused; **uninstalled 2026-08-16**) is
  **iOS 26+ only**, falls back to a plain View — and an iOS-only surface is by definition not a
  design both platforms can draw.
- RNGH **will not** arbitrate against system edge gestures
  ([#833](https://github.com/software-mansion/react-native-gesture-handler/issues/833), closed as
  not planned) — and Android's back gesture owns **both** edges, with exclusion capped at 200dp and
  refused at the bottom. Any edge-pan design needs a native module written for it alone.
- The repo has **zero** accessibility code today: no `accessibilityLabel`, no `accessibilityRole`,
  no `useReducedMotion` anywhere in `src/`.

---

## 3. Six mechanisms, three judges

Six candidates were generated, then scored 0–10 by three independent judges who each saw only one
axis.

| # | candidate | discover­ability | legibility & restraint | implement­ability | total |
|---|---|---|---|---|---|
| 1 | **Accessory** — rotate the ribbon 90° into one 52pt band | 9 | 8.5 | 7 | **24.5** |
| 2 | **Compact** — the handle becomes a Live-Activity pill | 8 | 7.5 | 8 | **23.5** |
| 3 | **Reader** — the ⋯ key *becomes* the recipe | 4 | 9 | 9 | **22** |
| 4 | Clearing — find the emptiest band of text and park there | 7 | 6 | 5 | 18 |
| 5 | Native — a real SwiftUI Menu / Compose DropdownMenu | 3 | 9 | 4 | 16 |
| 6 | Flick — press the edge, a radial blooms under the thumb | 6 | 5 | 3 | 14 |

The three that died, and why — each is a lesson the survivors inherited:

- **Clearing** scans the pane for the emptiest rows and parks there. But four of six recipes
  (vim, pager, htop, agent) are **alt-screen apps that fill the pane edge to edge**: there is no
  empty band to find, so it degenerates to arbitrary placement, freezes there, and puts an opaque
  touch-eating rectangle in the middle of the scroll surface for the life of the process.
- **Native** cannot self-appear. That is the feature's defining requirement, so it is half a design
  by construction — and even as the open half it cannot carry a live elapsed timer, the two-tap arm,
  or the app's typography. Worth a device spike; not worth a build.
- **Flick** needs a 20pt trailing hot-zone that overlaps both Android's predictive-back edge *and*
  the terminal's own pan recogniser. A right-thumb user scrolling near the edge gets a full-screen
  dim and possibly a stray `^C` into a running job. The marking-menu evidence behind it is strong
  but was measured with a stylus and a mouse, not a thumb over a live scroll surface.

---

## 4. The three approaches

### 4.1 Accessory — rotate the ribbon 90° · [full spec](ribbon/spec-accessory.md)

**One 52pt-tall opaque band pinned at `popBase`.** At rest it is a 44pt identity chip flush to the
trailing edge — glyph, process name, live clock. Tap it and the band *unrolls leftward* into a
horizontal row of 44pt caps. A 12-cap agent recipe occupies **exactly the same footprint** as a
3-cap running recipe, forever.

```
│ ⠿ minifying …                                       │
│╭────────────────────────────────────────────────────┤ ┐
││          ╭──────╮╭──────────╮╭─────╮│╭────────────╮│ │
││          │! kill││  ^Z bg   ││ ^C  │││▶ npm · 0:16││ ├ 52pt, opaque theme.panel
││          │ force││background││stop ││╰────────────╯│ │  C40 two-colour perimeter
││          ╰──────╯╰──────────╯╰─────╯│              │ │
│╰────────────────────────────────────────────────────┤ ┘
│  ╭───╮ ╭─────────────────────────────╮ ╭───╮        │ ← STILL LIVE: the dismiss
│  │ ⋯ │ │ Ctrl │Esc│Tab│ Paste │  ↕   │ │ ▣ │        │   catcher stops at the band's
│  ╰───╯ ╰─────────────────────────────╯ ╰───╯        │   top edge (bug fix)
```

- **Why it's noticed:** two independent channels, neither behind a gesture. The 44pt chip, *and* —
  the stronger one — the caps sit in the strip the eye already scans for Ctrl/Esc/Tab whenever the
  keyboard is up, which in a terminal is constantly. It sidesteps Yantis & Jonides instead of
  fighting it: the cue is found on a glance the user is **already making**.
- **Why it's readable:** opaque `theme.panel`, no glass, no blur. Every contrast figure becomes a
  constant — `foreground` on `panel` = **12.13 : 1** on Mocha. Danger caps render in `MONO_BOLD`
  because Latte's `#d20f39` is 4.46:1 (fails regular, passes the 3:1 bold floor) — which doubles as
  the WCAG 1.4.1 "not colour alone" fix, alongside an inline ⚠.
- **Why it scales:** 12 caps × 44pt + 11 gaps = 660pt of *column* — taller than an iPhone safe area,
  which is what forces the `maxCapsHeight` clamp today. Rotated, it is 972pt of *horizontal*
  content in a band that is 52pt tall for every recipe. `maxCapsHeight` is **deleted**, not tuned.
  Four of six recipes never install a scroll recogniser at all (measured overflow, not a cap count).
- **Cost:** ~1 focused day + half a day on device. Five files; one change is adding `export` to a
  function. Zero new dependencies — `expo-blur` is *removed* from this path. Riskiest part is the
  animated layout `width`, which **already ships** in `NamePill` (`keybar.tsx:938-986`).
- **Honest cost:** caps past the fourth are off-screen for the agent recipe and need a flick. The
  open band is the widest surface of the three (full width × 52pt over the newest 3 rows), and the
  resting chip covers a corner permanently. With the chord strip up, bottom chrome stacks to ~172pt.

### 4.2 Compact — the handle as a Live Activity pill · [full spec](ribbon/spec-compact.md)

**The Dynamic Island's minimal presentation.** A 44pt opaque plate at the trailing edge carrying
glyph + process name + clock, announcing itself once with six finite cycles of a 4pt lateral nudge,
then holding perfectly still; tap and it grows **in place** into a 208pt-wide panel, with the pill
becoming the panel's bottom header row. The 12-cap agent recipe is split by a three-segment control
(SESSION / COMMANDS / NOW) so no column ever exceeds five rows.

```
│   Bash npx tsc ╭─────────────────────────────▐ │
│   ⎿  no errors │ SESSION │COMMANDS│   NOW    ▐ │ ← 30pt segments
│                ╭─────────────────────────────▐ │
│                │    📎    attach             ▐ │
│                ╭─────────────────────────────▐ │
│                │    ⇧⇥    plan mode          ▐ │
│                ╭─────────────────────────────▐ │
│                │ ✦  claude    0:41        ⌄  ▐ │ ← the pill, grown
│ ───────────────╰─────────────────────────────▐ │
```

It has the best-argued contrast reasoning of the three (a mathematically-worked C40 floor of
**3.58:1 against any luminance whatsoever**), and it is the smallest delta from shipping code.

**It did not survive verification.** Not because the geometry is wrong — because *the user rejected
the shape, not the material*. This is still a vertical column of capsules climbing over the output
from a small resting token, and its own first trade-off concedes it "will be read as 'the same thing
again'". Its 208 × 342pt panel is the **largest persistent-over-output surface** of the three. Kept
here in full because its motion table, its C40 arithmetic and its opaque-plate argument are the best
in the set and should be harvested into whatever ships.

### 4.3 Reader — the ⋯ key *becomes* the recipe · [full spec](ribbon/spec-reader.md)

**Delete the floating layer entirely.** Detection's whole ambient expression is the key bar's ⋯
circle filling with the recipe's identity colour and swapping its glyph — a shape-and-fill change on
a 49pt control at a fixed, already-visited location — announced once by three cycles of a 2pt nudge.
The caps become the **first section of the menu that key already opens**.

```
│  ╭───╮ ╭─────────────────────────────╮ ╭───╮   │
│  │ ✦ │ │ Ctrl │Esc│Tab│ Paste │  ↕   │ │ ▣ │   │  ⋯ → filled peach + ✦
│  ╰───╯ ╰─────────────────────────────╯ ╰───╯   │  nothing over the terminal
```

- **Zero occlusion of the pane at rest. Nothing new is drawn over the terminal, ever.** No new
  gesture, no new layer, no new BackHandler rung (the `open !== 'none'` rung already exists), no
  edge-gesture collision on either platform. `ribbon.tsx`'s 304 lines of breath/arm/swipe/capsule
  drawing go away; `ribbon-model.ts`, `ribbon-recipes.ts` and `onRibbonCap` are untouched.
- **It is mostly a deletion** — the cheapest and least risky build by a distance, and the only
  candidate that is *less* code than today.
- **What it cannot promise is that anyone will notice.** By its own cited literature: a 49pt disc
  changing fill at the bottom of the screen, on a control the eye has learned to ignore, against a
  pane full of masking transients, is the textbook change-blindness stimulus. And the ⋯ circle is on
  the **left** (`SIDE_MARGIN` 24pt) — the far side from a right thumb.
- Twelve caps make the menu 810pt tall, pushing Upload and Settings below the fold whenever an
  agent is running — an IA inversion the spec names but does not solve.

---

## 5. Corrections from the verification pass

The adversarial agent re-read the source and `node_modules` and caught real errors. These override
the spec bodies.

1. **All three specs repeat a false claim.** "Reanimated 4 neuters `withRepeat` under Reduce Motion,
   leaving the handle a *static invisible* 5pt bar." Traced in
   `node_modules/react-native-reanimated/lib/module/animation/{repeat,util}.js`: under Reduce Motion
   each `withTiming` jumps straight to its `toValue` and `withRepeat` stops after one rep. Since
   `ribbon.tsx:58` seeds `breath = 1` and the sequence ends on `withTiming(1)`, the handle resolves
   to `opacity: 0.95, scaleY: 1` — **fully visible and still**. Reduce Motion currently makes the
   shipped handle *brighter*. The real accessibility defect is the WCAG 2.2.2 violation for everyone
   else, which stands.
2. **Don't hand-roll `useReduceMotion()`** — `useReducedMotion` is exported by Reanimated 4.5.1
   (verified in `node_modules`). Only the Compact spec got this right.
3. **`theme.muted` is not safe on the generated schemes.** On Solarized Dark, `muted` on `surface`
   is **2.96 : 1** — Compact's "≈4.6:1 floor" is wrong and would ship a failing caption on an
   installed theme. Use `rgba(theme.foreground, 0.78)` everywhere and drop `theme.muted` from the
   design (Accessory's own fix, which it then failed to apply to its section markers).
4. **Accessory's C40 numbers don't reproduce.** With `rgba(0,0,0,0.9)` / `rgba(255,255,255,0.9)` the
   strokes composite against the background; the crossover is near L ≈ 0.165 where **both** sit at
   ≈4.2:1 — better than the stated 3.84/3.47, but the stated figures are wrong.
5. **Accessory contradicts itself on the destructive cap.** It claims the danger cap lands
   "off-screen until deliberately scrolled to" while its own mockup correctly shows it first at
   x = 0. Pick one — hiding it means reordering `ribbon-recipes.ts`, contradicting the "zero changes
   to recipes" claim.
6. **Reader's `inkOn` helper inverts on its own motivating example.** On Latte's grey dot it returns
   the 2.3:1 option by a margin of one unit. Drop the heuristic; pick by `theme.isDark`.
7. **The Safari Reader precedent is overstated.** iOS 18 Safari shows the *words* "Reader
   Available"; macOS adds a **new** button. The real precedent argues for a **worded** cue in
   existing chrome — arguably a point in Reader's favour, but not the mechanism it specced.
8. Parhi et al. is misquoted in all three specs: ≥9.2mm is *discrete*, ≥9.6mm is *serial* — both
   one-handed. "≥9.6mm one-handed" as a separate finding does not exist. The CHI '25 signifiers
   paper is Mackamul, **Chevalier, Casiez & Malacria** — Bailly is not an author.

---

## 6. The question nobody asked

**Every spec tunes *when within a process* the ribbon arrives. None asks whether the process
qualifies at all.**

The `running` recipe matches *any* non-shell foreground command. It fires for `git log`, `ls`,
`npm test`, every `rg` — dozens of times an hour. That is why an unrequested surface reads as
intrusive no matter how well it is drawn.

A **minimum-lifetime gate** in `ribbon-model.ts` — show `running` only once the process has been
alive ~3s, which is exactly when kill / bg / stop become useful — is a three-line pure change with a
unit test in a suite that already exists, and it would do more for "not intrusive" than any amount
of plate, blur or easing. It composes with all three designs.

The stronger version of the same thought: **make it pull, not push.** If long-pressing ⋯ (or a
Ctrl-chord cap) summons the recipe on demand, constraint 2 — "it appears by itself and must not
interrupt" — disappears entirely. That deserved to be one of the six and wasn't.

---

## 7. Recommendation

**Build Accessory. Add the lifetime gate first — it's three lines and it is the cheapest fix in
this document.**

Accessory is the only one of the three that answers the complaint **structurally** rather than
materially. The rejection was of a 5pt sliver for being invisible *and* a vertical capsule column
for being intrusive and unreadable; Accessory is the only design that **stops drawing a column at
all**. Worst case equals best case: 3 caps and 12 caps are the same 52pt. Both of its risky bets
have in-repo precedent that was verified rather than assumed — the animated `width` inside a clip
already ships in `NamePill`, and the opaque plate is the finished version of the `surface@0.62`
emergency patch the codebase already recorded as insufficient. It fixes the key-bar scrim bug for
free.

Compact is attempt B in a heavier coat. Reader is the safer, lazier build but bets everything on a
cue its own literature says will not be noticed.

**They are not mutually exclusive.** Reader's ⋯-circle fill is ~15 lines and composes with
Accessory. If the resting chip's corner occlusion becomes the new complaint, that pairing — loud
identity in the chrome, band summoned on demand — is the fallback, and it is also the "pull, not
push" design in disguise.

**Order of work**

1. The `running` minimum-lifetime gate in `ribbon-model.ts` (+ unit test). Three lines. Ship alone.
2. Spike `@expo/ui`'s `Menu` on both platforms with a screenshot — the cheapest high-value
   verification available, and it is what decides whether the open half can ever be a platform menu.
3. Accessory, with corrections §5 applied and `theme.muted` dropped from the design.
4. The adversarial contrast test: `htop` on a many-core box, `bat CLAUDE.md`, Latte at outdoor
   brightness. Sample the worst pixels along the perimeter and assert the ratio. The current design
   was never measured against anything harder than an idle prompt — which is exactly how it shipped
   at 1.69 : 1.

The Android emulator harness on this box means every Android divergence these specs concede — no
swipe, edge-gesture collisions, no blur — is **testable today** rather than assumed.

---

## 8. What actually shipped, and what the phone changed

Built 2026-08-16 on `worktree-ribbon-design-research`. The shape survived contact with the device;
four details did not, and one bug was found that no amount of design could have prevented.

**Deviations from the spec, all driven by what the screen showed:**

1. **No section markers.** SESSION / COMMANDS / NOW each cost a 44pt slot of thumb reach to label
   groups the caps already spell out, and on `theme.scrim` over `theme.panel` they read as empty
   dark blobs. The agent recipe is one flat row of ten caps; the grouping survives as order.
2. **The C40 light stroke is a hairline at 0.45, not 1pt at 0.9.** At 3× the specced value draws
   three pixels of near-white — louder than any text on a dark theme, and it read as a debug
   border. This trades the worked-out floor at the worst-case crossover luminance for a surface
   that does not shout; the ceiling is written at the constant.
3. **The chevrons live in gutters, not over the caps.** Overlaid, they sliced `COMMANDS` and
   `/clear` mid-word, which reads as a rendering fault rather than as "there is more".
4. **Light schemes need a shadow.** §4.1's "opaque plate makes every contrast figure a constant"
   is true of the *text* and false of the *plate*: `theme.panel` is `mix(bg, black, 0.04)` on the
   22 generated schemes — 4%, against 20% on dark ones — so on Rose Pine Dawn the band was
   invisible against the pane it floated over, and Latte's mantle on base is 1.05:1. An opaque
   plate cannot separate itself from a ground it matches. The band now floats on a shadow on both
   platforms, plus a 6% black ground on light schemes only. **The study measured figure against
   plate and never measured plate against pane** — that is the gap this pass found.

**The bug none of the specs could have caught.** `POLL` is `tmux display-message -p` with no
target, so tmux answers about whichever session/window it last considered current. On a host with
other work going on, that alternates every beat — measured, one poller, the user sitting still:
`win 7 null → win 6 claude → win 7 null → win 6 claude`. Every design in this document consumes
that signal, so every one of them would have flickered. Worse, §6's minimum-lifetime gate — the
recommendation this document is proudest of — was *unreachable* under it: each reappearance looked
like a new run with a fresh clock, so `now - startedAt` never reached three seconds and a plain
`sleep 30` could never appear at all. The ribbon now ignores answers about windows it is not
showing, and holds a null for a beat before believing it. The poll itself is filed in BUGS.md.

The lesson generalises past this feature: **a design study can measure everything it draws and
still be defeated by the truthfulness of the signal it reacts to.** None of the fourteen agents
asked whether the poll was answering about the right window.
