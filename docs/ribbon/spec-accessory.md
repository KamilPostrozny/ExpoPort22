# Accessory

> Full design spec for the ribbon redesign. Written by a spec agent against the
> measured constraints of this repo, then adversarially verified. Read
> [../ribbon-redesign.md](../ribbon-redesign.md) first — it carries the diagnosis,
> the evidence base and the recommendation. **Corrections from the verification
> pass are at the bottom of this file and take precedence over the body.**

## Thesis

Rotate the ribbon 90°: one 52pt-tall opaque band pinned at the existing `popBase` anchor, resting as a 44pt identity chip flush to the trailing edge ("▶ npm · 0:14") and unrolling leftward into a horizontal row of 44pt caps — so a 12-cap agent recipe occupies exactly the same footprint as a 3-cap running recipe, forever. It beats the 5pt handle on all three of the user's complaints at once: the resting state is a legible, live, 44pt labelled control instead of a colour sliver; the open state is one row of chrome immediately above chrome the user already reads as chrome, instead of a column climbing over the output; and it is fully opaque with a neutral two-colour perimeter, so readability stops being a function of what the terminal happens to be printing.

## Precedent

- Apple HIG, Virtual Keyboards (iOS/iPadOS): "Some apps position an input accessory view containing custom controls above the keyboard to offer app-specific functionality related to the data people are working with… If your app offers custom controls that augment the keyboard, make sure they're relevant to the current task." https://developer.apple.com/design/human-interface-guidelines/virtual-keyboards — this is the HIG hook for a contextual cap row docked into the bottom chrome stack, and specifically for the `focus:true` caps (vim `/`, pager `/`, htop `/`) which must raise the keyboard and then still be usable.
- Apple HIG, Live Activities (Dynamic Island): the minimal/compact presentation is an opaque pill showing live data — "display updated information rather than just a logo" — and "prefer limiting it to a single element to help people avoid accidentally tapping the wrong control." https://developer.apple.com/design/human-interface-guidelines/live-activities — the resting chip is exactly that: one interactive element, opaque, carrying a ticking elapsed timer rather than a logo or a colour sliver. The Island's opacity is also Apple's own admission that a floating live indicator over arbitrary content is not made translucent.
- Apple HIG, Tab bars ▸ bottom accessory (Music MiniPlayer), and SwiftUI `tabViewBottomAccessory(content:)`: a control that exists only while something is running, sitting immediately above the persistent bottom bar, with an expanded floating placement and a minimized inline one — the same object in the same place at two sizes. https://developer.apple.com/design/human-interface-guidelines/tab-bars — the key bar is the tab bar, the band is the accessory, `popBase` is the attachment point.
- Apple HIG, Accessibility: iOS default control size 44×44pt, minimum 28×28pt, ~12pt padding around bezelled elements, 4.5:1 for body text. https://developer.apple.com/design/human-interface-guidelines/accessibility — 12 caps × 44pt + 12pt gaps = 672pt of column, taller than an iPhone safe area. That arithmetic is what forces the horizontal shape; it is not a stylistic preference.
- Parhi, Karlson & Bederson, "Target Size Study for One-Handed Thumb Use on Small Touchscreen Devices", MobileHCI '06, pp. 203–210. https://www.microsoft.com/en-us/research/wp-content/uploads/2006/01/parhi-mobileHCI06.pdf — ≥9.2mm single-target / ≥9.6mm one-handed (44pt ≈ 9.7mm at 3×, so the caps clear it and the 5pt tab never could, because thumbs land where the target *looks*), and "targets on the right side of the screen for right-handed users… should extend all the way to the edge", which is why the chip and the band both bleed to `right: 0` on iOS.
- Bartram, Ware & Calvert, "Moticons: detection, distraction and task", IJHCS 58(5), 2003 — peripheral colour cues were missed 25% of the time versus under 2% for motion; guideline G8 names slow linear oscillation as the best detection/irritation compromise while G7 flags zoom/popping as distracting and blink as least detectable. The shipped handle pulses opacity + scaleY at 0.53 Hz — a blink/zoom hybrid on a 5pt *colour* target, the two worst codes stacked. Replaced here by a finite 3-cycle 2.5pt lateral nudge on a 44pt object.
- W3C WCAG technique C40, "Creating a two-color focus indicator for sufficient contrast with any background". https://www.w3.org/WAI/WCAG22/Techniques/css/C40 — the only edge treatment that survives a background you do not control. Every single-colour plate or border can land on itself (1.00:1); a black+white 1pt pair bottoms out at ≈3.4:1 for whichever stroke wins (worked below).
- Bailey & Konstan, "On the need for attention-aware systems", Computers in Human Behavior 22(4), 2006, N=50 — interrupting mid-task rather than at a task boundary cost 3–27% more time, ~2× the errors, 31–106% more annoyance, and "deferring presentation for a short time, i.e. just a few seconds, can lead to a large mitigation of disruption." The ribbon self-appears on a 2s poll, so the poll latency is an asset: arrival is gated on 350ms of output quiescence.
- Mackamul, Bailly et al., CHI '25, N=33 — adding visual signifiers to standard-duration animated transitions did *not* improve discovery of hidden widgets. This is why the first-run behaviour is a self-terminating 4s promotion of the real band in its real place, not an onboarding animation or a coach-mark.
- Termius mobile terminal: "The keyboard add-on displays the three first groups of hotkeys from the extended keyboard and sits directly above the system keyboard and is always visible while typing." https://docs.termius.com/terminal/mobile-terminal — plus Blink Shell SmartKeys (row lives exactly as long as the on-screen keyboard) and Panic Prompt 3's Extra Keyboard Row (16 keys, shipped OFF by default). Every shipping iOS terminal puts extra keys in a horizontal band in the bottom chrome; none of them reserves it permanently. Corroborates the shape and constraint 1 at once.

## States

- **hidden** — `recipe === null`. Nothing mounted (no BlurView, no timer, no interval). Trigger: idle shell / REPL / unknown TUI, or `connected === false`. Exit: a recipe is selected AND the arrival gate opens.
- **arriving** — 0–180ms. The chip enters with `FadeInDown.duration(180)` at `bottom: popBase`, right-flush. Trigger: `selectRecipe()` returns non-null and `Date.now() - lastOutputAt > 350` (re-checked every 250ms, forced through after 3000ms). Exit: automatic → **chip**.
- **chip** — the resting state, and the state the design lives in 95% of the time. A 44pt-tall opaque pill: recipe glyph in `theme.dots[recipe.dot]`, process name at 12pt MONO in `theme.foreground`, and — for `pulse` recipes (running, agent) — ` · 4:07` elapsed, re-rendered once a second. Dead still. Trigger: arrival completes, or the band closes. Exit: chip tap / iOS left-swipe → **band**; process ends → **leaving**.
- **nudging** — a sub-state of **chip**, 0–3.15s after arrival only. Three cycles of a 2.5pt lateral `translateX` oscillation (525ms out, 525ms back), then permanently still. Skipped entirely under Reduce Motion. Never repeats, never restarts on a poll tick — only on a new `recipe.id`.
- **promo** — first-run only. On detection #1 and #2 of a given `recipe.id` (counted in `settings.ribbonSeen`), and only while `keyboardPad === 0`, the band auto-opens 700ms after the chip lands, holds 4000ms, then collapses back to **chip**. Any touch inside the band cancels the auto-collapse and promotes it to a user-owned **band**. Logs `[ribbon] promo <id> <n>`.
- **band** — open. The clip's width has animated from `chipW + 8` to `stage.w - padH`; the caps region has faded in. Full cap set, horizontally scrollable only if it overflows. Trigger: chip tap, iOS swipe-left on the chip, or promo. Exit: cap tap (unless `arm` or `focus`), chip tap, iOS swipe-right on the band, tap on the terminal above the band, Android hardware back, `recipe.id` change, or process end.
- **band-armed** — a cap with `arm: true` (only the agent's `^C ^C quit`) has been tapped once. Bytes were sent; the cap's caption becomes `tap again`, its label goes `theme.danger` + MONO_BOLD, its fill goes `rgba(theme.danger, 0.20)` and its border `rgba(theme.danger, 0.9)`. Auto-disarms after `ARM_MS = 2800`. Tapping any *other* cap disarms without firing the armed one (HIG Alerts' Cancel-button rule). Second tap on the armed cap fires and closes to **chip**.
- **band-focus** — a cap with `focus: true` (vim `/`, pager `/`, htop `/`) was tapped. Bytes sent, `focusSignal` incremented, keyboard rises, `keyboardPad` grows, `popBase` grows by the same amount in the same React commit, and the band is simply drawn higher — no independent animation. The band **stays open** so the next cap is one tap away. Exit: as **band**.
- **band-busy** — `sending === true` (an upload in flight). The agent's `📎 attach` cap takes `backgroundColor: theme.accent` at full opacity and `disabled`; every other cap is unaffected. That inert tint is the whole progress UI (§4.6, unchanged).
- **band-scrolled** — only reachable when content overflows (agent, and vim/pager on a ≤375pt phone). Leading `‹` and trailing `›` 16×44 chevron caps on `theme.panel` fade in/out per scroll offset, driven by `useAnimatedScrollHandler` shared values, never a JS re-render.
- **leaving** — 180ms. `FadeOutDown.duration(180)` on the whole layer. Trigger: `recipe === null`, or `connected === false`. Both entry and exit are 180 deliberately: the 2026-08-11 lesson (aae62fe) was that a 140ms exit against a 180ms entry "read as the ribbon blinking out while the arrival glided".
- **faded** — `barFadeStyle` (`opacity: 1 - min(prog/0.25, 1)`, terminal.tsx:1969) is applied to the ribbon layer, so the band leaves with the key bar at the start of a switcher flight and never hangs in the air mid-zoom. Reused, not reimplemented.
- **off** — `settings.ribbon === false`. Nothing ever mounts. Set from Settings ▸ Process actions, or by long-pressing the chip for 420ms (which closes the band, flips the setting, and shows the existing `TabsHintPopover` reading "Process actions off — turn back on in Settings"). This is HIG Live Activities' "consider offering controls that allow people to turn off a Live Activity", which the current design has no answer to.

## Anatomy

ALL VALUES IN pt. `W = stage.w` (390 typical, 402 design width). `padH = termPad(W) = (8/402)*W ≈ 7.8`. `popBase = barHeight + 6 + keyboardPad + insets.bottom` (terminal.tsx:1787) — consumed, never recomputed.

== THE ONE ANCHOR ==
Both states, every recipe, every keyboard state: `position: 'absolute'; right: 0 (iOS) / 8 (Android); bottom: popBase; height: 52`. There is no second geometry and no `keyboardWillChangeFrame` subscription of our own — `popBase` already folds in `keyboardPad` and the chord strip (through the remeasured `barHeight`), so the band moves with the keyboard and with Ctrl-armed in the same React commit that moves the key bar. That single fact is the answer to the Obsidian desync class of bug.

== LAYER 0: dismiss catcher (only while open) ==
`<Pressable accessible={false} style={{position:'absolute', left:0, right:0, top:0, bottom: popBase + 52}} onPress={close}/>`. It stops at the band's top edge, so — unlike today's `RibbonPanel` scrim — **the key bar stays live while the band is open**. That is a bug fix, not a style choice.

== LAYER 1: the clip (the animated silhouette + the whole C40 perimeter) ==
```
Animated.View {
  position:'absolute', right: EDGE_INSET, bottom: popBase,
  height: 52, overflow:'hidden', alignItems:'flex-end',
  borderTopLeftRadius: 26, borderBottomLeftRadius: 26,
  borderTopRightRadius: 0, borderBottomRightRadius: 0,
  borderWidth: 1, borderRightWidth: 0, borderColor: RIBBON_EDGE_DARK,
  width: <animated: chipW + 8 ↔ W - padH>,
}
```
`EDGE_INSET = Platform.OS === 'android' ? 8 : 0`. Square right corners + `right: 0` = the surface is attached to the trailing edge (Parhi: let the edge do the aiming), while the *visible* left end is inset to `padH`, aligning exactly with the terminal's own left text margin (HIG Layout's "inset from the edges", satisfied on the only edge where it can be).

Inner light stroke, a sibling absolute child of the clip, drawn first so the plate paints over nothing:
```
View { position:'absolute', left:0, top:0, right:0, bottom:0,
       borderWidth:1, borderRightWidth:0, borderColor: RIBBON_EDGE_LIGHT,
       borderTopLeftRadius:25, borderBottomLeftRadius:25, pointerEvents:'none' }
```
Two new cross-flavour neutral literals, sitting beside `GLASS_BORDER` in keybar.tsx:
`RIBBON_EDGE_DARK = 'rgba(0,0,0,0.9)'`, `RIBBON_EDGE_LIGHT = 'rgba(255,255,255,0.9)'`.
They are deliberately **outside the theme's gamut**. `theme.border`, `theme.scrim` and `theme.foreground` are all wrong here for one reason: the terminal draws in the *same theme*, so any role colour can land on itself at 1.00:1. Only neutral extremes escape.

Android only, on the clip: `boxShadow: '0 2px 6px rgba(0,0,0,0.5)'` (M3 Level3-ish). iOS gets none — a shadow on a rounded overlay draws as a rectangle here (ribbon.tsx:265, standing constraint).

== LAYER 2: the plate (fixed width, never animates) ==
```
View { width: W - padH, height: 50, flexDirection:'row', alignItems:'center',
       paddingLeft: 4, paddingRight: 4, backgroundColor: theme.panel }
```
Fully **opaque**. No `Glass`, no `BlurView`, no `rgba(surface, 0.62)`. That is the entire redesign in one line: thin glass and 62%-alpha grounds are what failed twice (fd4e8f2, and the user's "not readable enough if not taking up space"), and Apple's own answer over bright content is a dimming layer, not thinner material. Because the plate is opaque, Reduce Transparency is a **no-op** — there is nothing to swap.

Height 50 inside a 52 clip = 52 − 2×1pt border.

Plate children, leading → trailing:

(a) **caps region** — `{flex: 1, height: 44, overflow: 'hidden'}`.
    Contains an RNGH `ScrollView horizontal`, `directionalLockEnabled`, `showsHorizontalScrollIndicator={false}`, `scrollEnabled={overflows}`, `contentContainerStyle={{flexGrow:1, justifyContent:'flex-end', alignItems:'center', flexDirection:'row', gap:6, paddingHorizontal:2}}`.
    `justifyContent:'flex-end'` is load-bearing: when the caps fit (the common case) they sit right-aligned, hard against the divider and the chip, i.e. nearest the thumb. When they overflow, `flexGrow` is inert and content starts at x=0 (leading), which is where the scroll rests.
    Two chevron overlays, absolute, `pointerEvents:'none'`: `{left:0}` / `{right:0}`, each `{width:16, height:44, backgroundColor: theme.panel, alignItems:'center', justifyContent:'center'}` with a 13pt MONO `‹` / `›` in `theme.muted`. Opacity driven by `useAnimatedScrollHandler` shared values (`x > 2` and `x < contentW - viewW - 2`), 120ms `withTiming` — a worklet, no JS re-render per scroll frame.

(b) **divider** — `{width: 1, height: 28, marginHorizontal: 6, backgroundColor: theme.border, opacity: 0.6}`.

(c) **identity chip** — `Pressable` (the one always-present control):
```
{ height: 44, borderRadius: 22, flexDirection:'row', alignItems:'center', gap: 6,
  paddingLeft: 10, paddingRight: 12, maxWidth: 172, backgroundColor: theme.surface }
```
`theme.surface` on `theme.panel` = a filled control on the field it floats on — the roles used for the job they name. Contents:
  - glyph: `SymbolView size={15} tintColor={theme.dots[recipe.dot]}` with a **MONO_BOLD 13pt single-letter fallback** in the same colour, so there is no Nerd-Font tofu risk on any platform. Per recipe: running `play.fill` / `R`; suspended `pause.fill` / `Z`; vim `pencil` / `V`; pager `doc.plaintext` / `P`; htop `chart.bar.fill` / `H`; agent `sparkles` / `A`. Two fields added to `Recipe` (`sf`, `mark`) and nothing else in ribbon-recipes.ts changes.
  - name: `numberOfLines={1}`, `maxWidth: 96`, MONO 12pt, `theme.foreground`.
  - meta: MONO 12pt, `theme.foreground` at `opacity: 0.78`, `fontVariant:['tabular-nums']` so the timer does not jitter. `pulse` recipes → ` · 4:07` (from `formatElapsed(Date.now() - ribbonCore.startedAt)`); `suspended` → ` · stopped`; others → absent.
Chip `hitSlop={{top:10, bottom:10, left:6, right: EDGE_INSET}}` — the touch region reaches the physical edge on iOS while the visible pill does not.

== THE CAP ==
```
{ height: 44, minWidth: 52, paddingHorizontal: 10, borderRadius: 22,
  alignItems:'center', justifyContent:'center',
  backgroundColor: theme.surface,
  borderWidth: 1, borderColor: 'transparent' }
```
Two stacked lines, centred:
  - key: MONO **14pt**, weight 500 (`MONO_BOLD` when `danger`), `lineHeight 17`, `theme.foreground`, `numberOfLines={1}`.
  - caption: **10pt**, `lineHeight 12`, `theme.foreground` at `opacity: 0.78`, `numberOfLines={1}`, only when `cap.caption` exists. Deliberately *not* `theme.muted`: muted is `mix(bg,fg,0.78)` on the 22 generated schemes and its contrast against `panel` is unpredictable; a foreground alpha is a fixed composite.
17 + 12 = 29 in a 44pt box → 7.5pt of breathing room top and bottom. This is the chord strip's own two-line cap idiom (keybar.tsx:1241, 48pt wide, 16pt letter, 8.5pt caption) at ribbon scale, which is why it reads as "the Ctrl strip, but for vim" rather than as a new object.

Danger caps (`:q!`, `kill`, `F9`, `^C ^C`) additionally get:
  - `backgroundColor: rgba(theme.danger, 0.18)` over the surface fill,
  - `borderColor: rgba(theme.danger, 0.55)`,
  - key + caption in `theme.danger`, key in **MONO_BOLD**,
  - a leading `SymbolView name="exclamationmark.triangle.fill" size={10}` (fallback `!`) inline before the key, 3pt gap. Colour is never the only signal (WCAG 1.4.1); bold at 14pt also drops the contrast floor to 3:1, which is what rescues Latte's `#d20f39` (4.46:1, see legibility).

Armed: `backgroundColor: rgba(theme.danger, 0.20)`, `borderColor: rgba(theme.danger, 0.9)`, caption text `tap again`.
Pressed: handled by the reused `Key` from keybar.tsx — `opacity: 0.5`, `scale: 0.93`, `Haptics.impactAsync(Light)` on the *completed* tap only.

== SECTION MARKER (the agent recipe's SESSION / COMMANDS / NOW) ==
Not bare text with a shadow — that was a display-type rescue applied to letterspaced 9.5pt and it never worked. An opaque non-interactive chip in the flow:
```
{ height: 44, borderRadius: 22, paddingHorizontal: 10, alignItems:'center', justifyContent:'center',
  backgroundColor: theme.scrim }
Text { fontSize: 9, fontWeight:'700', letterSpacing: 0.8, color: theme.muted }
```
`theme.scrim` (darker than `panel`) makes it read as a recess between groups rather than as a cap. `accessibilityRole="header"`.

== MEASURED WIDTHS (MONO advance = 0.6em → 8.4pt at 14, 6.0pt at 10) ==
cap width = `max(labelW, captionW) + 20`, floor 52.
running:   kill/force 54 · ^Z bg/background 80 · ^C/stop 52 → 186 + 2×6 = **198**
suspended: kill/force 54 · bg/run behind 80 · fg/resume 56 → 190 + 12 = **202**
vim:       :q!/discard 62 · :q/quit 52 · //search 56 · ZZ/save+quit 74 · :w/save 52 → 296 + 4×6 = **320**
pager:     q/quit 52 · G/end 52 · g/top 52 · n/next hit 68 · //search 56 → 280 + 24 = **304**
htop:      F9/kill 52 · q/quit 52 · F6/sort 52 · //filter 56 → 212 + 18 = **230**
agent:     SESSION 58 · ^C^C/quit 66 · COMMANDS 63 · /clear 74 · /context 91 · /model 74 · /usage 74 · /config 83 · /plugins 91 · NOW 36 · 📎/attach 60 · ⇧⇥/plan mode 78 · ⎋/stop 52 → 900 + 12×6 = **972**
Viewport (caps region) at W=390: `390 − 7.8 − 4 − 4 − 13 (divider+margins) − chipW`. chipW: running ≈ 15+6+~26+~34+22 = **≈118**; agent ≈ **≈132**; vim/pager/htop (no meta) ≈ **≈72**.
→ vim viewport ≈ 289 vs content 320: scrolls by 31pt on a 390 phone, fits exactly at W=422+. running/suspended/htop never scroll on any phone. agent always scrolls, ~3 viewports of content.

== COLOUR ROLES USED (all real tokens from src/theme.ts) ==
`theme.panel` plate ground · `theme.surface` chip + cap fill · `theme.scrim` section markers · `theme.foreground` keys, name (and captions at 0.78 alpha) · `theme.muted` chevrons + section text · `theme.danger` destructive · `theme.accent` upload-busy attach cap · `theme.border` divider · `theme.dots[recipe.dot]` the glyph, and *only* the glyph. Nothing tints the surface with the identity colour — HIG Materials: don't pick a material for its apparent colour.

== WHAT IT OCCLUDES (honest numbers, W=390, cell.h≈18, keyboard down) ==
`popBase ≈ 60 + 6 + 0 + 34 = 100`. Band occupies 100→152 from the screen bottom. The terminal's last text row ends at ≈97. So: **open → the bottom 3 rows, full width; resting → the bottom ~3 rows of the trailing ~126pt only** (a corner, ~32% of one line × 3). Nothing is ever *reserved*: the layer is `position:'absolute'` inside the ribbon layer, participates in no Yoga flow, and never enters `paneInsets`. `rows × cell` is untouched, so there is no SSH resize, no tmux redraw, no settle overlay. Constraint 1 holds by construction.

== Z-ORDER ==
Unchanged from today: the ribbon layer stays at document position 6/7 in terminal.tsx — above the key bar wrapper (5), below the popover layer (8). No `zIndex` anywhere, matching the rest of the tree.

## Mockups

```
Scale for all frames: 1 column ≈ 6.3pt, 1 row ≈ 17pt. iPhone 390×844.

════════════════════════════════════════════════════════════════
STATE: chip (resting). `running` recipe, 44pt chip, flush trailing edge.
════════════════════════════════════════════════════════════════
┌──────────────────────────────────────────────────────────────┐
│ 9:41                                          ▂▄  ᯤ   ▓▓▓    │ insets.top — bare card face
├──────────────────────────────────────────────────────────────┤
│ ~/p/expoport22 on  main [!?]                                 │
│ ❯ npm run build                                              │
│                                                              │
│ > port22@1.0.0 build                                         │
│ > expo export --platform ios                                 │
│                                                              │
│ Starting Metro Bundler                                       │
│ ✔ 412 modules transpiled in 8.4s                             │
│ ⠿ writing sourcemaps …                       ╭───────────────┤ ┐
│ ⠿ minifying …                                │ ▶  npm · 0:14 │ ├ 52pt clip, bottom = popBase
│ ⠿ copying assets …                           ╰───────────────┤ ┘   right corners SQUARE, flush
│                                                              │ ← 6pt
│  ╭────╮ ╭──────────────────────────────────────╮ ╭────╮      │ ┐
│  │ ⋯  │ │ Ctrl │ Esc │ Tab │  Paste  │    ↕    │ │ ▣  │      │ ├ key bar, 60pt (barHeight)
│  ╰────╯ ╰──────────────────────────────────────╯ ╰────╯      │ ┘
│                        ▁▁▁▁▁▁▁▁▁▁▁▁                          │ insets.bottom (home indicator)
└──────────────────────────────────────────────────────────────┘
       ▲ glyph tinted theme.dots.green   ▲ MONO 12  ▲ tabular, ticks 1/s
       The whole resting footprint: 126×44 of opaque, labelled, live control.
       Compare: the shipped design's resting footprint is 5×46 of flat colour.

════════════════════════════════════════════════════════════════
STATE: band. `running` — 3 caps, content 198pt, viewport 249pt → NO SCROLL.
       Caps right-aligned against the divider, i.e. nearest the thumb.
       Destructive `kill` sits at the far end, furthest from the resting thumb.
════════════════════════════════════════════════════════════════
┌──────────────────────────────────────────────────────────────┐
│ ✔ 412 modules transpiled in 8.4s                             │
│ ⠿ writing sourcemaps …                                       │
│╭─────────────────────────────────────────────────────────────┤ ┐
││           ╭──────╮╭──────────╮╭─────╮│╭────────────────╮    │ │
││           │! kill││  ^Z bg   ││ ^C  │││ ▶  npm · 0:16  │    │ ├ 52pt
││           │ force││background││stop ││╰────────────────╯    │ │
││           ╰──────╯╰──────────╯╰─────╯│                      │ │
│╰─────────────────────────────────────────────────────────────┤ ┘
│  ╭────╮ ╭──────────────────────────────────────╮ ╭────╮      │
│  │ ⋯  │ │ Ctrl │ Esc │ Tab │  Paste  │    ↕    │ │ ▣  │      │ ← STILL LIVE. The dismiss
│  ╰────╯ ╰──────────────────────────────────────╯ ╰────╯      │   catcher stops at the band's
│                        ▁▁▁▁▁▁▁▁▁▁▁▁                          │   top edge, unlike today's
└──────────────────────────────────────────────────────────────┘   full-screen scrim.
  └ plate: opaque theme.panel      └ divider 1×28 theme.border
  └ perimeter: 1pt rgba(0,0,0,.9) outside, 1pt rgba(255,255,255,.9) inside
  └ `! kill` = MONO_BOLD in theme.danger + ⚠ symbol + danger@0.18 fill + danger@0.55 border

════════════════════════════════════════════════════════════════
STATE: band. `agent` — THE HARD CASE. 10 caps + 3 section markers = 972pt
       of content in a ~235pt viewport. Rests at scroll x = 0.
════════════════════════════════════════════════════════════════
┌──────────────────────────────────────────────────────────────┐
│ ● Read src/ribbon.tsx (304 lines)                            │
│ ● Bash rtk git status                                        │
│╭─────────────────────────────────────────────────────────────┤
││╭───────╮╭──────╮╭────────╮╭────────╮╭─│›│╭────────────────╮ │
││║SESSION║│! ^C^C││ /clear ││/context││/m│ ││ ✳ claude 4:07  │ │
││╰───────╯│ quit ││        ││        ││  │›│╰────────────────╯ │
││         ╰──────╯╰────────╯╰────────╯╰─│ │                    │
│╰─────────────────────────────────────────────────────────────┤
│  ╭────╮ ╭──────────────────────────────────────╮ ╭────╮      │
│  │ ⋯  │ │ Ctrl │ Esc │ Tab │  Paste  │    ↕    │ │ ▣  │      │
│  ╰────╯ ╰──────────────────────────────────────╯ ╰────╯      │
└──────────────────────────────────────────────────────────────┘
 ║SESSION║ = section marker: theme.scrim ground, 9pt/700, ls 0.8, role=header
 ›         = trailing chevron, 16×44 on theme.panel, fades in per scroll offset

  the scroll tape (972pt of content, viewport ≈235pt, rests at x=0):

  x=0                                                                    x=972
  ├──────────────────────────────────────────────────────────────────────────┤
  ║SESSION║ !^C^C ║COMMANDS║ /clear /context /model /usage /config /plugins ║NOW║ 📎 ⇧⇥ ⎋
  └── at rest ──┘
                 └──── one flick ────┘
                                     └──── two flicks (NOW group) ────┘
  ▲ destructive first = FURTHEST from the resting thumb, and armed on top of that
  ▲ /clear /context are visible without any scroll — the high-frequency set
  ▲ NOW (attach / plan mode / stop) is one flick away with the › chevron pointing at it

  The band is 52pt tall here. It is 52pt tall for the 3-cap `running` recipe too.
  Worst case == best case. No other shape can say that.

════════════════════════════════════════════════════════════════
STATE: band-armed. First tap on `^C ^C` has fired; 2800ms to confirm.
════════════════════════════════════════════════════════════════
││╭───────╮╭──────────╮╭────────╮╭────────╮│ ╭────────────────╮ │
││║SESSION║│! ^C ^C   ││ /clear ││/context││ ││ ✳ claude 4:07  │ │
││╰───────╯│ tap again││        ││        ││ │╰────────────────╯ │
││         ╰══════════╯╰────────╯╰────────╯│ │                   │
                └ border rgba(danger,0.9), fill rgba(danger,0.20)

════════════════════════════════════════════════════════════════
STATE: band-focus. `pager` recipe, `/` just tapped. keyboardPad ≈ 291.
       popBase grew by 291 in the SAME commit that moved the key bar.
       Nothing animated independently. The remaining caps sit one row up.
════════════════════════════════════════════════════════════════
┌──────────────────────────────────────────────────────────────┐
│ MOUNT(8)                 System Calls Manual                 │
│ NAME                                                         │
│      mount, umount - mount and unmount filesystems           │
│ SYNOPSIS                                                     │
│      mount [-dfnrsvw] [-t vfstype] …                         │
│/                                                             │ ← the `/` prompt, cursor live
│╭─────────────────────────────────────────────────────────────┤
││  ╭────╮╭────╮╭────╮╭──────────╮╭──────╮│╭─────────────────╮ │
││  │ q  ││ G  ││ g  ││    n     ││  /   │││ ≡  man          │ │
││  │quit││end ││top ││ next hit ││search│││                 │ │
││  ╰────╯╰────╯╰────╯╰──────────╯╰──────╯│╰─────────────────╯ │
│╰─────────────────────────────────────────────────────────────┤
│  ╭────╮ ╭──────────────────────────────────────╮ ╭────╮      │
│  │ ⋯  │ │ Ctrl │ Esc │ Tab │  Paste  │    ↕    │ │ ▣  │      │
│  ╰────╯ ╰──────────────────────────────────────╯ ╰────╯      │
├──────────────────────────────────────────────────────────────┤
│  q  w  e  r  t  y  u  i  o  p                                │
│   a  s  d  f  g  h  j  k  l          system keyboard         │
│  ⇧  z  x  c  v  b  n  m  ⌫                                   │
└──────────────────────────────────────────────────────────────┘
  Type the search term, then `n` is already under the thumb for the next hit.
  This is the payoff: HIG Virtual Keyboards' input accessory view, for free.

════════════════════════════════════════════════════════════════
STATE: chip, with the Ctrl chord strip up. barHeight ≈ 120, so popBase ≈ 160.
       Zero new code — the band reads the same number the popovers read.
════════════════════════════════════════════════════════════════
│ ⠿ minifying …                                ╭───────────────┤
│                                              │ ▶  npm · 0:22 │
│                                              ╰───────────────┤
│                                                              │
│        ╭──────────────────────────────────────────╮          │ ┐
│        │ A   C   D   L   R   U   W   Z            │          │ ├ chord strip
│        │ a   c   d   l   r   u   w   z            │          │ ┘
│  ╭────╮ ╭──────────────────────────────────────╮ ╭────╮      │
│  │ ⋯  │ │ Ctrl │ Esc │ Tab │  Paste  │    ↕    │ │ ▣  │      │
│  ╰────╯ ╰──────────────────────────────────────╯ ╰────╯      │
└──────────────────────────────────────────────────────────────┘
```

## Motion

Every animation below is finite. There is not one `withRepeat(..., -1)` in the design — the shipped handle's infinite breath is a WCAG 2.2.2 (Pause/Stop/Hide, Level A) violation for content the user did not start, and Reanimated 4 already neuters `withRepeat` under Reduce Motion, which today leaves the handle a *static invisible 5pt bar*: an existing a11y bug this design deletes.

1. **Chip arrival** — `entering={FadeInDown.duration(180)}` on the clip. House vocabulary (popovers, chord strip).
2. **Chip departure** — `exiting={FadeOutDown.duration(180)}`. 180, not 140: aae62fe (2026-08-11) recorded that a 140 exit against a 180 entry "read as the ribbon blinking out while the arrival glided".
3. **Arrival nudge — the make-aware cue, played exactly once.**
   `nudge.value = withRepeat(withSequence(withTiming(-2.5, {duration: 525, easing: Easing.inOut(Easing.sin)}), withTiming(0, {duration: 525, easing: Easing.inOut(Easing.sin)})), 3, false)`
   → `transform: [{ translateX: nudge.value }]`, 3 cycles ≈ 3.15s at ≈0.95 Hz, amplitude 2.5pt, then dead still forever. Fired on a new `recipe.id` only, never on a poll beat.
   Why these numbers: Bartram/Ware/Calvert measured amplitude as essentially irrelevant to detection (0.5° and 1° performed the same at ~3 Hz) and ranked slow *linear oscillation* as the best detection/irritation compromise, with zoom and blink the worst — the shipped design's opacity+scaleY breath is precisely zoom+blink. The axis is horizontal because the terminal's own transients are vertical (scrolling text), so a lateral motion is orthogonal to the masking signal (Rensink-class change blindness).
4. **Chip → band (open)** — `w.value = withTiming(bandW, {duration: 260, easing: Easing.bezier(0.32, 0.72, 0.3, 1)})` on the clip's `width`. That is the house slide easing (settings sheet, 340ms). Right-anchored because the clip is `alignItems:'flex-end'` over a fixed-width plate — the same `namePillClip` + anchor construction the tab-name pills already use, which is why it reads as *unrolling from the chip* and not as the left-anchored wipe that 6c23587 recorded as a failure.
   Caps region opacity: `withDelay(80, withTiming(1, {duration: 140, easing: Easing.out(Easing.quad)}))`.
5. **Band → chip (close)** — `withTiming(chipW + 8, {duration: 200, easing: Easing.bezier(0.32,0.72,0.3,1)})`; caps opacity `withTiming(0, {duration: 100})` with no delay, so the caps are gone before the silhouette catches up (nothing is ever seen clipped mid-glyph).
6. **Chevron fades** — `withTiming(0|1, {duration: 120})` driven from a `useAnimatedScrollHandler` worklet. Never a JS re-render; the JS thread stalls 40–300ms under SSH load and a React commit is 1–2 frames behind a worklet.
7. **Cap press** — inherited from `Key` (keybar.tsx:284): `opacity 0.5` + `scale 0.93` while pressed, `Haptics.impactAsync(Light)` on the *completed* tap only, never on touch-down.
8. **Arm timeout** — `ARM_MS = 2800`, unchanged, a `setTimeout` not an animation. No countdown ring: a repeating/looping progress indicator is exactly what rule 1 forbids.
9. **Keyboard show/hide** — **no animation of ours at all.** `popBase` changes as React state and the band is re-laid-out in the same commit that moves the key bar. Every Obsidian-class bug in the risk list (toolbar overlapping the nav bar, mixing with the text, going untappable) comes from keyboard-docked chrome animating on its own baseline. This design has no second baseline to desync.
10. **Switcher flight** — `barFadeStyle` (terminal.tsx:1969) is already applied to the ribbon layer. Reused verbatim.
11. **Promotion** — `setTimeout(open, 700)` after the chip lands, `setTimeout(close, 4700)`, both cleared on any touch inside the band and on unmount. The open/close themselves are (4) and (5).

**Reduce Motion** (`AccessibilityInfo.isReduceMotionEnabled()` + `reduceMotionChanged` listener; the repo has zero a11y code today, so this is a new 6-line hook `useReduceMotion()` in ribbon.tsx):
- (1)/(2) become `FadeIn.duration(180)` / `FadeOut.duration(180)` — no positional component.
- (3) is skipped entirely, `nudge.value = 0`. The ticking elapsed timer carries the liveness information statically, which is HIG Motion's "avoid using it as the only way to communicate important information" satisfied without inventing a second signal.
- (4)/(5): width jumps (`duration: 0`); the caps region cross-fades over 180ms. HIG explicitly names "avoiding animating into and out of blurs" — there is no blur here to animate, another consequence of the opaque plate.
- (6)/(7) unchanged (opacity-only, and the press feedback is a direct response to touch, not an automatic animation).

## Interaction

**Discovery — two independent channels, neither behind a gesture.**
Channel 1: the resting chip. 44pt tall, opaque, at a fixed location the thumb already owns, carrying a glyph, the process name and a running clock. Channel 2 is the stronger one and is the reason this shape was chosen: the caps sit in the band directly above the key bar, which is the strip the eye already scans for Ctrl / Esc / Tab whenever the keyboard is up — which in a terminal client is constantly, and is exactly the moment a contextual command is wanted. Discovery stops being a glance you must provoke (Yantis & Jonides: attentional capture by abrupt onset is *not* intentional and is suppressed under focused attention) and becomes a glance the user is already making.

**Open** — tap the chip anywhere in its 44pt box (hitSlop reaches the physical edge on iOS). Logs `[ribbon] open <proc>` (T11 asserts on this string).
**Open, iOS only, secondary** — `Gesture.Pan().activeOffsetX(-12).failOffsetX(12).failOffsetY([-12,12])`, fires at `translationX < -28` (`SWIPE_PX`, unchanged). Kept because it is fluent and already learned, but it is never the discovery route — HIG Gestures forbids a custom gesture as the only route, and the shipped design's failure is that the swipe *was* the fluent path with nothing to teach it.
**Open, Android** — tap only. The Android back gesture is an inward swipe from **both** edges, `systemGestureExclusion` is capped at 200dp per edge and cannot be claimed at the bottom at all, and RNGH will not arbitrate against system edge gestures (gesture-handler#833, closed as not planned). So on Android the chip is inset 8pt from the trailing edge and binds no pan. A genuine, stated per-platform divergence, not an oversight.

**Fire a cap** — one tap. `Key`'s haptic fires on completion only. Then:
- ordinary cap → bytes sent, band collapses to chip (200ms), `[ribbon] cap <label>`.
- `focus: true` cap (vim `/`, pager `/`, htop `/`) → bytes sent, `focusSignal` incremented, **band stays open**, keyboard rises, band rides up with `popBase`. The next cap is one tap away on the keyboard's top edge.
- `arm: true` cap (agent `^C ^C` only) → bytes sent, cap re-labels `tap again`, band stays open, 2800ms window. A tap on any *other* cap disarms it and fires that other cap instead (HIG Alerts' Cancel-button rule: the armed state must have a visible way out).
- `action: 'attach'` while `sending` → disabled, `theme.accent` fill. The inert tint is the progress UI (§4.6, unchanged).

**The two-tap arm is calibrated, not sprayed.** `kill -9` and `^C ^C quit` are uncommon and un-undoable → armed + red + ⚠ + placed furthest from the thumb. `^C stop`, `^Z bg`, `fg`, `q`, `:q` are common and reversible → plain caps, no red, no arm. HIG Alerts: "Avoid displaying alerts for common, undoable actions, even when they're destructive." The current design already gets this right and it is preserved exactly.

**Close** — five routes, all of which already exist as user habits:
1. tap the chip again (it is the same control, Dynamic-Island style);
2. fire any cap (except arm/focus);
3. tap the terminal above the band — the dismiss catcher is `top: 0 → bottom: popBase + 52`, so unlike today's full-screen scrim **it does not eat the key bar**;
4. iOS: `Gesture.Pan().activeOffsetX(12).failOffsetX(-12).failOffsetY([-12,12])` on the band, fires at `+28`;
5. Android hardware back (see below).

**Gesture arbitration — the judges' specific concern, resolved three ways.**
(a) *Geometrically*: the band's bottom edge is at `popBase = barHeight + 6 + …`, i.e. **6pt above the key bar's top**. The bar's Pan (keybar.tsx:564, `maxPointers 1`, owns ↔ window hop and ↑ zoom) only ever sees touches that *start on the bar*. The two recognisers physically cannot see the same touch. The collision the pitch worried about is removed by 6pt of existing gap, not by arbitration code.
(b) *By not installing the recogniser at all*: `scrollEnabled` is derived from **measured overflow** (`onContentSizeChange` width vs `onLayout` width, one boolean in state), not from a cap count. running / suspended / htop never overflow on any phone, so those recipes install no scroll responder whatsoever; vim and pager overflow only below ~420pt of width; only `agent` always scrolls. That is strictly better than the "disable at ≤5 caps" heuristic because it is true on every device.
(c) *Directionally*: when it does scroll, `directionalLockEnabled` (iOS) locks to the dominant axis at drag start; Android's `HorizontalScrollView.onInterceptTouchEvent` already requires a dominant-x delta. A near-vertical drag on the band therefore does nothing — and it must do nothing rather than fall through, because the band is opaque chrome and a drag that starts on chrome and lands in the terminal is worse than a drag that is ignored.

**Never steals a touch on arrival.** The chip mounts at `bottom: popBase`, in a region the key bar's 6pt gap and the last 3 output rows occupy; the arrival is gated on 350ms of output quiescence, which also means it does not appear on the frame the user is mid-scroll. The layer above the band is `pointerEvents="box-none"` while closed, so exactly one 126×44 rect of the terminal becomes untouchable, in the corner, and nothing under a finger moves — the band is absolutely positioned and never reflows the pane.

**Long-press the chip, 420ms** (matching the Paste key's `delayLongPress`) → the band closes, `settings.ribbon` flips to false, and the existing `TabsHintPopover` says "Process actions off — Settings ▸ Process actions". HIG Live Activities: "Live Activities that appear unexpectedly can be surprising or even unwanted. Consider offering controls that allow people to turn off a Live Activity." The shipped design has no off switch at all.

**Android hardware back ladder** (terminal.tsx's existing `BackHandler` chain) becomes: switcher → open popover / ⋯ menu → **ribbon band** → exitApp. This is the CAB contract ("Back closes the mode") and it is a required addition, not an optional one — androidx's own FAB Menu ships neither a scrim nor back handling, so those are gaps to fill rather than omissions to copy.

## Legibility

**The root cause of both halves of the user's complaint is one thing: a single translucent colour trying to work against two opposite extremes.** `rgba(theme.surface, 0.62)` over a bright pane gives the 12.5pt caption 1.76:1 (APCA Lc 22.5) and the *red destructive label* 1.69:1 — the most dangerous cap is the least legible — while over a normal dark pane the capsule body sits at 1.17:1 against its own background, i.e. invisible. Apple shipped the same failure and walked iOS 26 Liquid Glass back from clear to frosted between beta 1 and beta 3 for exactly this reason. So the answer is not thinner glass, thicker glass, or a higher alpha. It is **no glass**.

**1. The plate is opaque.** `backgroundColor: theme.panel`, alpha 1.0, no `BlurView`, no `Glass`. Every contrast number below is therefore a *constant*, independent of what the terminal is printing. htop's colour bars, a full CLAUDE.md, a `bat`-highlighted source file — none of them can change any of these figures.

Catppuccin Mocha (`panel` = mantle `#181825`, relative luminance 0.00983):
| element | colour | ratio vs plate | floor | verdict |
|---|---|---|---|---|
| cap key, 14pt/500 | `foreground` `#cdd6f4` | **12.13 : 1** | 4.5 | pass ×2.7 |
| cap caption, 10pt @0.78α | ≈ `#a0a6c0` | **7.9 : 1** | 4.5 | pass |
| danger key, 14pt bold | `danger` `#f38ba8` | **7.58 : 1** | 3.0 (bold ≥14) | pass ×2.5 |
| section marker text, 9pt | `muted` `#a6adc8` on `scrim` `#11111b` | **8.3 : 1** | 4.5 | pass |
| chip name, 12pt | `foreground` on `surface` `#313244` | **9.5 : 1** | 4.5 | pass |

Catppuccin Latte (`panel` = mantle `#e6e9ef`, luminance 0.8133) — the light-mode case that actually bites:
| element | colour | ratio | floor | verdict |
|---|---|---|---|---|
| cap key | `foreground` `#4c4f69` | **6.57 : 1** | 4.5 | pass |
| danger key | `danger` `#d20f39` | **4.46 : 1** | 4.5 @regular / **3.0 @bold ≥14pt** | fails regular, **passes bold** |
That single number is why **every danger cap renders in `MONO_BOLD`**. It is also, independently, the WCAG 1.4.1 "more than colour alone" fix, alongside the inline ⚠ `exclamationmark.triangle.fill`.

Captions use `theme.foreground` at `opacity: 0.78` rather than `theme.muted` on purpose: `muted` is `mix(bg, fg, 0.78)` on the 22 generated schemes, so its contrast against `panel` varies scheme to scheme; a foreground alpha over an opaque known ground is a fixed composite on all 26.

**2. The perimeter is the only thing that meets arbitrary content, and it is a two-colour C40 pair.**
This is the finding that decides the whole design. *No single colour can satisfy WCAG 1.4.11 over a terminal*, because the terminal draws in the same theme — every candidate role colour (`border`, `scrim`, `foreground`, `accent`) can land on itself at exactly 1.00:1. Even the plate itself can: `panel` over a pane whose background is `panel`-adjacent is invisible.

So the perimeter uses two neutral literals *outside the theme's gamut*, W3C technique C40 style: 1pt `rgba(0,0,0,0.9)` outside, 1pt `rgba(255,255,255,0.9)` immediately inside. Worked worst case, minimising `max(contrast_dark, contrast_light)` over all sRGB backgrounds: the crossover is at relative luminance L ≈ 0.23 (a mid grey), where the dark stroke gives **3.84:1** and the light stroke **3.47:1**. Both clear the 3:1 non-text floor with margin, at the *worst possible* background colour.
For comparison, the pair the earlier research proposed — `crust` + `text` — crosses over at 2.62:1 and **fails 1.4.11**, because both are inside the palette. Neutral extremes are load-bearing; theme roles are not good enough for this one job.
Sanity checks: against Mocha's green bar `#a6e3a1` the dark stroke reads 12.6:1; against pure white the dark stroke reads 18.8:1; against pure black the light stroke reads 14.5:1; against `#11111b` itself the light stroke reads 12.96:1; against `#cdd6f4` itself the dark stroke reads 12.96:1.

**3. There is no shadow, and none is needed.** iOS draws a shadow on a rounded overlay as a rectangle (ribbon.tsx:265, standing constraint), so the C40 perimeter carries every bit of figure/ground separation. Android gets `boxShadow: '0 2px 6px rgba(0,0,0,0.5)'` on top, matching the house Android-glass treatment.

**4. Reduce Transparency is a no-op.** There is nothing translucent to swap: no blur, no alpha ground, no vibrancy. The listener is still installed (and the state still threaded) purely so a future variant cannot regress silently, but the visual is identical in both settings. This is a deliberate inversion of the earlier plan — the research concluded the Reduce-Transparency variant is probably *more* readable over dense text than the default and should therefore **be** the default. Here it is the only variant.

**5. Increase Contrast** raises the caption alpha from 0.78 → 1.0 and the divider from `opacity 0.6` → 1.0. Two lines.

**6. The acceptance test is adversarial, not a prompt.** T11's new readability case runs against `htop` on a 64-core box (full-width colour bars behind the band), `bat CLAUDE.md` (dense high-frequency syntax colour), and Latte at 08:00 outdoor brightness. Screenshot each, sample the three worst pixels along the perimeter, and assert the computed ratio. The current design's contrast was never measured against anything harder than an idle prompt, which is exactly how it shipped at 1.69:1.

## Scaling

**The shape makes the question go away.** A 12-cap column at HIG's 44pt default with 12pt gaps is 672pt — taller than an iPhone's safe area, growing upward out of the thumb arc and under the status bar, which is why the shipped design needs a `maxCapsHeight` clamp and a ScrollView it cannot avoid. Rotated, the same 12 caps are 972pt of *horizontal* content in a band that is **52pt tall for every recipe, forever**. The 3-cap `running` recipe and the 13-row `agent` recipe have byte-identical footprints. No pagination, no segmented control, no scroll clamp, no reach problem, no growth into the pane, and no `maxCapsHeight` prop at all — it is deleted.

**Concretely, at W = 390:**
| recipe | items | content | viewport | scrolls? |
|---|---|---|---|---|
| running | 3 | 198 | 249 | no |
| suspended | 3 | 202 | 249 | no |
| htop | 4 | 230 | 295 | no |
| pager | 5 | 304 | 295 | 9pt — effectively no |
| vim | 5 | 320 | 289 | 31pt |
| agent | 13 | 972 | 235 | yes, ≈3 viewports |
`scrollEnabled` is computed from measured overflow, so four of six recipes never install a scroll recogniser. On a 402pt design-width phone vim and pager stop scrolling too.

**Sections survive without becoming a second disclosure level.** SESSION / COMMANDS / NOW render as inline 44pt marker chips on `theme.scrim` in the same linear flow. That keeps the agent recipe at **one flat revealed set with visual grouping** — not a two-level hierarchy. This matters against the evidence: Kurtenbach's thesis puts breadth-12/depth-1 menus at "border on unreliability" and Kurtenbach & Buxton measured error under 10% only to breadth 8 / depth 2, while Material caps FAB menus at 2–6 and speed dials at 6 including the target. Twelve items is over every documented ceiling *for a menu you must aim at from memory*. A horizontal band is not that: the caps are read left-to-right like a toolbar, there is no directional stroke to recall, and the grouping chips give three landmarks. The relevant precedent is a scrolling toolbar (Termius's grouped hotkey rows, Blink's SmartKeys), not a marking menu.

**Ordering is derived, not invented, and `ribbon-recipes.ts` needs zero changes.** The file's comment already says "the prototype puts the destructive cap at the top and the most-used one at the bottom, nearest the thumb". Render the array left→right and top→bottom becomes left→right: destructive lands at the leading edge (furthest from a right thumb, and off-screen until deliberately scrolled to, in the agent case), most-used lands hard against the divider under the thumb. HIG Context menus' "destructive items at the end" and Parhi's thumb-arc result agree here for once.

**The honest cost.** Caps past ~4 are off-screen for the agent recipe and must be flicked to — `/plugins` and the NOW group are one flick away, `⎋ stop` is two. That is the mirror image of the column's reach problem rather than a strict improvement, and it is the design's main trade. It is mitigated by (a) scroll resting at x = 0, where `/clear` and `/context` — the high-frequency commands — are already visible, (b) the `›` chevron as a persistent "there is more" signifier, and (c) the fact that the tail items (`/config`, `/plugins`) are genuinely rare. Not mitigated by memory: the scroll offset resets on every open, deliberately, so the caps are always in the same place.

**Dynamic Type scales for free in the one axis that has room.** Cap labels take `maxFontSizeMultiplier={1.3}`; the caps get *wider*, which a horizontal band absorbs at zero cost, where a column would get taller and hit the clamp. Above 1.3 the caption is dropped and only the 14pt key renders. No vertical shape can offer this.

## Accessibility

The repo has **zero** accessibility code today — no `accessibilityLabel`, no `accessibilityRole`, no `AccessibilityInfo`, no `useReducedMotion` anywhere in src/. Everything here is greenfield, so it is written out in full rather than referenced.

**VoiceOver order.** The ribbon layer renders after the key bar wrapper in terminal.tsx (document order is the z-order; there is no `zIndex` in the tree), so the swipe order is: terminal → key bar → chip/band → popovers. Do not reorder to fix this — it would invert the z-order. The arrival announcement (below) is what tells a VoiceOver user the surface exists; the fixed position is what lets them find it again.

**Labels.**
- Chip, `accessibilityRole="button"`:
  closed → `accessibilityLabel = "${proc} actions"`, `accessibilityValue={{text: elapsedSpoken}}` where `elapsedSpoken` is `"running 4 minutes 7 seconds"` (not `"4:07"`, which VoiceOver reads as a time of day), `accessibilityHint = "Shows ${n} actions for ${proc}"`, `accessibilityState={{expanded: false}}`.
  open → same label, `accessibilityState={{expanded: true}}`, hint `"Hides the actions"`.
  `accessibilityActions=[{name:'longpress', label:'Turn off process actions'}]`.
- Cap, `accessibilityRole="button"`: `accessibilityLabel = caption ?? label` (so `^Z bg` is announced as "background", not "caret Z B G" — the mono glyph is a visual affordance, the caption is the meaning), `accessibilityHint = "Sends ${label}"`. Danger caps prefix the label with `"Destructive: "`. The armed cap re-labels to `"Confirm quit"` with `accessibilityHint = "Double tap again to confirm"` and posts an `announceForAccessibility("Tap again to confirm")` on arming.
- Section marker: `accessibilityRole="header"`, label = the section name, not focusable as a control.
- Chevrons: `importantForAccessibility="no"`, `accessible={false}` — they are scroll affordances, and the horizontal ScrollView is already rotor-navigable.

**Self-appearing content must be announced.** On the transition to **chip**:
`AccessibilityInfo.announceForAccessibilityWithOptions(\`${proc} actions available\`, {queue: true})` on iOS (queued, so it never interrupts what the user is reading), `announceForAccessibility` on Android. On the transition to **band**: `announceForAccessibility(\`${n} actions\`)`. Focus is never stolen — the research is explicit that a self-appearing surface is invisible to VoiceOver unless announced, and equally explicit that it must not grab focus from whatever the user is reading.

**Never auto-hide under a screen reader.** If `AccessibilityInfo.isScreenReaderEnabled()` is true, the **promo** auto-collapse is disabled (the band stays open until dismissed) and the arrival nudge is skipped. This is M3's rule for the floating toolbar's hide-on-scroll, transplanted: motion-driven and timer-driven state changes are hostile to a screen-reader user who is mid-traversal.

**Reduce Motion** — new `useReduceMotion()` hook in ribbon.tsx (`AccessibilityInfo.isReduceMotionEnabled()` + a `reduceMotionChanged` listener, 6 lines). Effects listed in full under `motion`. The headline: the design has no infinite animation to strip, so Reduce Motion degrades it rather than breaking it — unlike the current handle, whose *only* liveness signal is an infinite `withRepeat` that Reanimated 4 already disables under Reduce Motion, leaving a static invisible 5pt bar.

**Reduce Transparency** — no-op by construction. Listener installed anyway so a regression is caught. **Increase Contrast** — caption alpha 0.78 → 1.0, divider opacity 0.6 → 1.0.

**Dynamic Type** — `maxFontSizeMultiplier={1.3}` on cap key, cap caption, chip name and chip meta. Caps widen (free, in a horizontal band); the band height stays 52 so nothing in the pane geometry can shift. Above 1.3, `cap.caption` is not rendered and the 14pt key stands alone. Section marker text scales to 1.3 too.

**Touch targets** — chip 44pt tall × ≥72pt wide, plus `hitSlop` reaching the physical edge on iOS. Caps 44 × ≥52. Gaps 6pt with 44pt of vertical slop above and below inside the 52pt band. Everything clears HIG's 44pt default and Parhi's 9.6mm one-handed recommendation (44pt ≈ 9.7mm at 3×). The section markers are the only non-interactive elements and they are visually distinct (`theme.scrim`, no radius change but a darker ground), so nothing looks tappable that is not.

**Colour-blind safety** — the recipe's identity is carried by *three* codes, never one: the `theme.dots[dot]` hue, a distinct SF Symbol per recipe (with a distinct MONO_BOLD letter fallback: R/Z/V/P/H/A), and the spelled-out process name. Destructive state is carried by four: red text, a bold weight, an inline ⚠ symbol, and position at the far end of the row. WCAG 1.4.1 is satisfied without spending a single point of layout.

**Contrast** — every figure computed and tabulated under `legibility`; the binding case is Latte's `#d20f39` at 4.46:1, resolved by rendering danger caps in `MONO_BOLD` (3:1 floor at ≥14pt bold).

## Edge cases

- **Recipe changes while the band is open.** Today `useEffect(() => setRbOpen(false), [ribbonCore.instance])` closes on every new *instance*. Change the dependency to `[recipe?.id]`: a new instance of the *same* recipe (a second `npm run build`) keeps the band open and just resets the timer; a different recipe id (vim → agent) collapses to the chip, because the caps under the finger genuinely changed. This is Material's snackbar contract — one mode at a time, a new one replaces the old — with the safety rationale the existing code already had.
- **Process exits while the band is open.** `recipe` goes null; the whole layer unmounts with `FadeOutDown.duration(180)`. The arm timeout, the 1s timer interval and the two promo timeouts are all cleared in the same `useEffect` cleanup that already exists for `armTimer`. Nothing is left ticking.
- **Keyboard rises while the band is open** (a `focus:true` cap, or the user tapping the terminal). `popBase` grows by `keyboardPad` in the same React commit that moves the key bar; the band is re-laid-out, not animated. The scroll offset is preserved. There is no `keyboardWillChangeFrame` subscription of our own to desync — this is the specific bug class the Obsidian mobile-toolbar threads catalogue, and the fix is to own no second baseline.
- **Keyboard falls while the band is open** — symmetric, and the band drops with the bar. It does not close: the user's next cap is usually the follow-up to the one that raised it.
- **Ctrl armed / locked while the band is open.** The chord strip appears, `barHeight` is remeasured 60 → ≈120 via the existing `onHeight`, `popBase` grows by 60, and the band is drawn above the chord strip. Zero new code — the band reads the same number the four popovers read. Bottom chrome then stacks to ≈172pt over the terminal, which is a lot; it is transient (the chord strip only exists while Ctrl is armed) and it is the one state where the band should arguably be dismissed. It is not, deliberately: closing chrome the user did not close is worse than a tall stack.
- **A popover opens over the band** (⋯ menu, arrows, clipboard, tabs hint). The popover layer is drawn after the ribbon layer and its full-screen dismiss scrim eats the first tap, so the band is inert while a popover is up — correct, and unchanged from today. The single-valued `open` state already guarantees only one popover at a time.
- **Window hop (bar ↔ swipe) mid-open.** `ribbonForWindow(win)` fires at the commit and sets the recipe from the window list, so the band's contents change *with* the transition instead of a poll beat later. If the id changes the band collapses. Keep calling `ribbonForWindow` — it exists for exactly this.
- **Switcher zoom starts mid-open.** `barFadeStyle` (already applied to the ribbon layer) fades the band out with the key bar over the first 25% of the zoom progress. Reuse it or the band hangs in the air. Add `setRbOpen(false)` in `onZoomGrab` so the band is closed when the flight lands.
- **Landscape.** `stage.w` grows, `bandW` grows, fewer recipes scroll (agent still does). `popBase` is unchanged in formula. The band occludes proportionally more of a short pane — accepted; the pane is short in landscape regardless and the band is dismissible.
- **Small phone (375pt: iPhone SE, 13 mini).** vim's 320pt of caps in a 274pt viewport → scrolls by 46pt. `scrollEnabled` is measured, so this is handled without a device check. `pager` scrolls by 24pt. The chip's `maxWidth: 172` and the name's `maxWidth: 96` with `numberOfLines={1}` keep a long process name from starving the caps region.
- **Android: predictive back / edge gestures.** The band's open swipe is not bound on Android at all and the chip is inset 8pt from the trailing edge, because the Android back gesture is an inward swipe from *both* edges, the exclusion API caps at 200dp per edge and refuses the bottom zone entirely, and RNGH will not arbitrate against system edge gestures (gesture-handler#833). Hardware back closes the band via the existing `BackHandler` ladder: switcher → popover → band → exitApp.
- **Android: no blur anywhere.** Irrelevant here — the plate is opaque and `Glass` is not used. `expo-blur` on Android now requires wrapping the blurred content in `BlurTargetView` and cannot cross window boundaries, and the terminal is a WebView, so any translucent design would have been Android-broken from the start. This one is identical on both platforms except for the 8pt inset and the shadow.
- **Android 13+ clipboard confirmation.** The system draws its own paste confirmation at the bottom of the screen, in the same band. The app-drawn confirmation must be suppressed on API 33+; treat the bottom band as shared with the system rather than app-owned. Unchanged obligation, but the band now competes for that space and it is worth re-testing the Paste pill on API 33+.
- **Upload in flight (`sending`).** The agent's `📎 attach` cap goes `theme.accent` and disabled; every other cap stays live; the ⋯ circle in the bar does the same thing it already does. Two independent inert-tint progress indicators for one upload is correct — they are two entry points to the same flow.
- **Poll flicker.** A command that finishes between two 2s polls could flash the chip in and out. The 350ms output-quiescence gate plus `FadeInDown 180 / FadeOutDown 180` already smooths this, but add a floor: once shown, the chip stays for at least 1200ms even if the recipe clears, so a fast job produces one calm appearance rather than a blink. This is a pure addition to `ribbon-model.ts` (`RIBBON_MIN_SHOW_MS = 1200`) and gets a unit test.
- **A touch is already down when the recipe is detected.** The arrival gate only checks output quiescence in the lazy version. If T11 shows a real problem here, extend the gate with a `touchDown` ref set from the terminal DOM component's existing touchstart/touchend listeners (src/terminal.tsx:724-918) — one boolean bridged through the existing message channel. Deferred until observed; the band never moves the text under a finger regardless, since it is absolutely positioned.
- **Frozen / disconnected session.** `ribbonPoll` is already gated on `frozen`, and `recipe` is `connected && selectRecipe(...)`. The band unmounts on disconnect along with everything else.

## Implementation

**Files that change. Five, and one of them is a single word.**

**1. `src/ribbon.tsx` — rewritten, ~240 lines.** `RibbonHandle` and `RibbonPanel` are deleted and replaced by one exported component:
```ts
export function RibbonAccessory(props: {
  theme: Theme;
  recipe: { id: RecipeId; proc: string };
  startedAt: number;      // ribbonCore.startedAt
  busy: boolean;          // sending
  bottom: number;         // popBase — the only geometry input
  width: number;          // stage.w
  padH: number;           // termPad(stage.w)
  open: boolean;
  onOpenChange: (open: boolean) => void;   // state LIFTED to the screen, house pattern
  onCap: (cap: Cap) => void;
  onDisable: () => void;  // long-press → settings.ribbon = false
}): JSX.Element
```
Internal structure exactly as in `anatomy`: `Animated.View` clip (animated `width`, C40 borders, `entering/exiting`) → inner-stroke `View` → plate `View` (row) → caps region (RNGH `ScrollView` + two chevron overlays) → divider → chip `Pressable`. Plus the dismiss catcher rendered as a sibling *before* the clip when `open`.
State inside: `chipW` (from `onLayout`), `overflows` (from `onContentSizeChange` vs `onLayout`), `armed` + `armTimer` (lifted verbatim from today's `RibbonPanel`), the 1s `setBeat` interval (verbatim), `reduceMotion`. Shared values: `w` (clip width), `caps` (opacity), `nudge` (translateX), `sx` (scroll x, from `useAnimatedScrollHandler`).

**2. `src/keybar.tsx` — three edits.**
- `function Key(` → `export function Key(` (one word). The ribbon currently duplicates it badly — a plain `Pressable`, no haptic, no scale — and this deletes that duplication.
- Add beside `GLASS_BORDER`: `export const RIBBON_EDGE_DARK = 'rgba(0,0,0,0.9)'; export const RIBBON_EDGE_LIGHT = 'rgba(255,255,255,0.9)';` with a comment naming C40 and the 3.84/3.47 worst case.
- Export `rgba` (it is already duplicated verbatim in keybar.tsx:212 and ribbon.tsx:38; do not write a third copy — export the one and import it).
`Glass` is **not** used by the new ribbon, and that is the point: on iOS it is blur+tint, which is exactly what failed twice. Leave `Glass` untouched for the bar and the popovers.

**3. `src/app/terminal.tsx` — four edits, all small.**
- Replace the two blocks at :2355–2386 with one `<RibbonAccessory …>` inside the existing `Animated.View absoluteFill pointerEvents="box-none"` + `barFadeStyle` wrapper, mounted whenever `recipe !== null && settings.ribbon`. Delete the `maxCapsHeight` expression at :2382 entirely.
- Change `useEffect(() => setRbOpen(false), [ribbonCore.instance])` → `[recipe?.id]`.
- Add `const lastOutputAt = useRef(0)` set to `Date.now()` in the existing terminal-output handler (the one the batching commit e75141f funnels through — "the terminal's output crosses once a turn"), and a `showRecipe` gate: a 250ms interval that flips a `ready` boolean once `Date.now() - lastOutputAt.current > 350`, forced true after 3000ms. Feed `recipe !== null && ready` to the mount condition.
- Add the band to the Android `BackHandler` ladder between "open popover" and "exitApp": `if (rbOpen) { setRbOpen(false); return true; }`.
- `setRbOpen(false)` in `onZoomGrab`.

**4. `src/ribbon-recipes.ts` — two fields, six lines of data.** `Recipe` gains `sf: string` (SF Symbol name) and `mark: string` (single-letter fallback): running `play.fill`/`R`, suspended `pause.fill`/`Z`, vim `pencil`/`V`, pager `doc.plaintext`/`P`, htop `chart.bar.fill`/`H`, agent `sparkles`/`A`. **Nothing else changes** — cap order, bytes, actions, `arm`, `danger`, `focus` are all consumed exactly as they are. `pulse` stops meaning "breathe" and starts meaning "show the elapsed timer"; retype the comment, keep the field.

**5. `src/ribbon-model.ts` + `src/ribbon-model.test.ts` — two pure additions with tests.**
- `RIBBON_MIN_SHOW_MS = 1200` and a `ribbonHold(core, now)` guard so a fast job produces one calm appearance rather than a blink.
- `ribbonPromo(seen: Record<string, number>, id: RecipeId): boolean` → `(seen[id] ?? 0) < RIBBON_PROMO_MAX` where `RIBBON_PROMO_MAX = 2`. Pure, three assertions, matching the file's existing style (196 lines of tests already).

**6. `src/settings.ts` + `src/settings-sheet.tsx` — two fields, one row.** `Settings` gains `ribbon: boolean` (default `true`) and `ribbonSeen: Record<string, number>` (default `{}`), both handled in `decode` alongside the existing fields; `updateSettings` persists to the same AsyncStorage blob. Settings sheet gains one toggle row, "Process actions", in the existing group idiom. That is the HIG Live Activities off-switch requirement, discharged in ~15 lines.

**What must run on the UI thread.** The clip's `width`, the caps region's `opacity`, the arrival `translateX`, and both chevron opacities — all Reanimated shared values driven by worklets. The JS thread stalls 40–300ms under SSH load and a React commit lands 1–2 frames behind a worklet, so nothing per-frame may be React state. Specifically, the scroll offset feeding the chevrons uses `useAnimatedScrollHandler`, not `onScroll` + `setState`. The `Gesture.Pan` objects must be memoised (`useMemo` on `[]`) — an un-memoised Gesture re-serialises its worklets and re-attaches the recogniser mid-gesture, a recorded failure in this repo.

**Component tree (open, agent):**
```
<Animated.View absoluteFill pointerEvents="box-none" style={barFadeStyle}>     terminal.tsx
  <RibbonAccessory>                                                            ribbon.tsx
    <Pressable dismiss/>                     top:0 → bottom: popBase+52
    <GestureDetector gesture={swipe}>        iOS only
      <Animated.View clip>                   width animated, C40 dark border
        <View innerStroke/>                  C40 light border
        <View plate>                         opaque theme.panel, row
          <View capsRegion>                  flex:1, overflow hidden
            <ScrollView horizontal>          RNGH, directionalLock, scrollEnabled={overflows}
              <SectionChip/> <Cap/> … ×13    Cap wraps the exported <Key/>
            </ScrollView>
            <Animated.View chevronL/> <Animated.View chevronR/>
          </View>
          <View divider/>
          <Pressable chip>                   SymbolView + name + tabular timer
        </View>
      </Animated.View>
    </GestureDetector>
```

**Instrumentation.** Keep every existing log line verbatim — TESTS.md T11 asserts on the exact strings `[ribbon] open <proc>`, `[ribbon] cap <label>`, `[ribbon] kill-force: …`. Add `[ribbon] promo <id> <n>`, `[ribbon] band <content>/<viewport> scroll=<bool>`, and `[ribbon] gate held <ms>` for the quiescence gate.

**TESTS.md.** §T11.7–T11.15 stay valid in substance (per-recipe cap lists, the two-tap arm, the silences, "the terminal's rows never rewrap") but T11.9 and T11.14 name the old gestures and must be rewritten for tap-to-open / tap-a-cap / tap-the-terminal / back-to-close, plus three new cases: the 350ms arrival gate, the first-run promotion firing twice and never a third time, and the adversarial contrast case (htop colour bars, `bat CLAUDE.md`, Latte) described under `legibility`.

## Cost

**Roughly one focused day, plus half a day of device testing.** `src/ribbon.tsx` is a clean rewrite of a 304-line file — call it 240 lines out. The other four files total under 40 lines of change, and one of them is adding `export` to a function. Zero new dependencies: RNGH, Reanimated, `expo-symbols`, `expo-haptics` and the settings store are all already in use, and `expo-blur` is *removed* from this feature's path rather than added to it. The pure-model additions (`ribbonHold`, `ribbonPromo`) are three assertions each in a test file that already exists.

**The riskiest part is the animated `width` on the clip.** It is a layout property, so every frame of the 260ms open runs a Yoga pass on a subtree that contains a horizontal ScrollView with up to 13 children. The mitigations are all already in the repo: the plate inside is a *fixed* width so its own layout never re-resolves, the construction is the same `namePillClip` + `alignItems:'flex-end'` anchor the tab-name pills already animate every window hop, and the whole subtree is pre-mounted at rest (building a subtree on a gesture's first frame is the recorded cause of the hitch at the start of every gesture in this app). If it still drops frames on a Release build, the fallback is a `translateX` on the plate inside a fixed-width clip — pure transform, no layout — at the cost of the plate's left rounded cap sliding in from off-screen instead of the silhouette growing. Measure before choosing; do not pre-optimise into the uglier one.

**Second risk, cheap to check:** an RNGH horizontal `ScrollView` in an absolutely-positioned overlay above a WebView. Android WebView overlays have historically been fussy about touch delivery to siblings. The key bar already proves the general case works (it is the same kind of overlay with a live Pan), so this is a verification, not an unknown — but it is the first thing to test on the emulator harness, before any of the visual work.

**Third, and the one most likely to cost an extra afternoon:** the first-run promotion and the arrival gate are both timing behaviours that can only be judged on a real phone against a real session. Expect to tune 350ms / 700ms / 4000ms / 1200ms by feel. They are all single constants at the top of two files, deliberately.

## Trade-offs

- **Caps past the fourth are off-screen for the agent recipe.** `/config`, `/plugins` and the whole NOW group need a flick. This is the mirror of the column's reach problem, not a strict improvement over it, and it is the single biggest honest cost of rotating the shape. The `›` chevron and the resting-at-x=0 choice (high-frequency `/clear` `/context` visible immediately) are mitigations, not fixes.
- **It occludes 3 output rows while open and ~3 rows of the trailing corner while resting.** HIG Layout's "don't obscure essential information" bites hardest on a terminal, where the bottom rows are the newest and most important. The band never *reserves* those rows — nothing reflows, `paneInsets` is untouched — but it does cover them, and the resting chip covers them persistently. The defence is that the band's open state coincides with the moment the user has stopped reading (they just tapped it) and that it collapses on the next cap; the chip's persistent corner occlusion is a real, permanent cost that a truly zero-footprint design would not pay.
- **Bottom chrome can stack to ~172pt** (chord strip 60 + key bar 60 + band 52) over a phone-sized terminal. Three bands is a lot of chrome even when none of it is reserved, and it is the state where the design looks worst. It is transient — the chord strip only exists while Ctrl is armed — but there is no clever answer to it.
- **Two of the six recipes cannot show all their caps at once on a 375pt phone.** vim overflows by 46pt on an SE. The band degrades gracefully (it scrolls) but the claim "the caps are simply there" is weaker on small hardware than on a 402pt design-width device.
- **It gives up the identity colour as a surface treatment.** HIG Materials forbids picking a material for its apparent colour, and the plate is a fixed `theme.panel` on every recipe, so the recipe's hue lives only in a 15pt glyph. The shipped design's whole 5pt tab was that hue; a user who had learned "green means a job is running" gets a much smaller colour cue, compensated by a glyph, a name and a timer. Bartram's finding that peripheral colour cues are missed 25% of the time versus 2% for motion says this is the right trade, but it is a trade.
- **The dismiss catcher still eats one tap on the terminal.** It is a strict improvement over today's full-screen scrim (the key bar stays live), but a user who taps the terminal to raise the keyboard while the band is open spends that tap on closing the band instead. There is no way around it that does not make the band undismissable by tapping away.
- **Reliance on `popBase` is a coupling.** The design's best property — no second geometry, no keyboard-frame subscription, nothing to desync — is also a hard dependency on `barHeight` being remeasured correctly on every chord-strip transition. If `onHeight` ever reports late, the band lands wrong along with all four popovers. That is a shared fate rather than a new risk, but it does mean the band inherits any bug in that measurement.
- **On Android the swipe affordance is simply gone.** The chip is tap-only and inset 8pt. Android users get a strictly less fluent version, and there is no way to fix it: the back gesture owns both edges, exclusion is capped at 200dp and refused at the bottom, and RNGH has closed the arbitration issue as not planned.
- **The first-run promotion is an unrequested 4s appearance.** It is the real UI in its real place and it self-terminates, which is the best-evidenced form of the thing (Mackamul et al. killed the alternative), but it is still the app doing something the user did not ask for — on top of a feature that already appears on its own. Twice per recipe, then never again, and the whole feature has an off switch; that is the ceiling of what can be defended.

---

## Verification pass (adversarial)

**Survives: yes**

Survives, and is the only one of the three that changes the SHAPE of the problem rather than the material. Its load-bearing engineering claims check out against the real files, including the one I most expected to break (animated layout width), which is already shipping in NamePill. Fix the Reduce Motion claim, the destructive-cap contradiction, the muted-on-scrim contrast, and the CHI citation, and it is buildable as written.

### Corrections — these override the body above

- FALSE, and repeated by all three specs: "Reanimated 4 neuters withRepeat under Reduce Motion, which today leaves the handle a static INVISIBLE 5pt bar." I traced it in node_modules/react-native-reanimated/lib/module/animation/{repeat,util}.js. Under Reduce Motion each withTiming jumps straight to its toValue (util.js:315 `if (animation.reduceMotion) { animation.current = animation.toValue; animation.onFrame = () => true; }`) and withRepeat stops after one rep (repeat.js: `if (animation.reduceMotion || …) return true`). ribbon.tsx:58 seeds `breath = 1` and the sequence ends on `withTiming(1)`, so breathStyle resolves to `opacity: 0.95, scaleY: 1` — the handle ends FULLY VISIBLE and still. Reduce Motion currently makes the shipped handle brighter, not invisible. Delete the "existing a11y bug this design deletes" argument; the real a11y bug is WCAG 2.2.2 (the infinite loop for everyone else), which the spec already argues correctly.

- Don't write a new `useReduceMotion()` hook. `useReducedMotion` is exported by react-native-reanimated 4.5.1 (verified: node_modules/react-native-reanimated/lib/typescript/hook/useReducedMotion.d.ts, re-exported from index.d.ts:31). The Compact spec cites it correctly; this one specs six lines of AccessibilityInfo that already exist upstream.

- Internal contradiction on the agent recipe's destructive cap. `scaling` says the destructive cap "lands at the leading edge (furthest from a right thumb, and off-screen until deliberately scrolled to, in the agent case)" while `interaction`/`ascii_mock` correctly show the scroll resting at x=0 with `║SESSION║ | ! ^C^C | /clear | /context` all visible — i.e. the destructive cap is the FIRST thing on screen when the band opens. Pick one. At x=0 with `justifyContent:'flex-end'` inert (content overflows), the array's index 0 is what you see; if the destructive cap must be hidden, the agent array has to be reordered or the ScrollView opened at a non-zero offset, and `ribbon-recipes.ts` then does need a change, contradicting "zero changes to ribbon-recipes.ts".

- Arithmetic: "12 caps × 44pt + 12pt gaps = 672pt" counts 12 gaps for 12 items. It is 12×44 + 11×12 = 660. Doesn't change the conclusion.

- The C40 worst case is misstated. With `rgba(0,0,0,0.9)` / `rgba(255,255,255,0.9)` the strokes are composited against the background, so their luminance is a function of it. Solving max(dark,light) numerically, the crossover is near relative luminance L≈0.165 where BOTH strokes sit at ≈4.2:1 — not "L ≈ 0.23, 3.84 and 3.47". The claim is conservative (real floor is better than stated) but the numbers are wrong and will not reproduce if anyone checks them.

- `theme.muted` for the section markers is not as safe as claimed. On the 22 generated schemes `muted = mix(bg,fg,0.78)` and `scrim = mix(bg,'#000',0.42)`; on Solarized Dark that is #667d81 on #00191f ≈ 4.15:1 for 9pt text — under the 4.5 floor. Use `rgba(theme.foreground, 0.78)` on the markers too, the same fix the spec already applies to captions, and drop `theme.muted` from the design entirely.

- Precedent citation is wrong on authorship: the CHI '25 paper is Mackamul, **Chevalier, Casiez & Malacria**, "Does Adding Visual Signifiers in Animated Transitions Improve Interaction Discoverability?" (10.1145/3706598.3713914, Honorable Mention). Bailly is not an author. The N=33 figure and the flat "did not improve discovery" reading are unverified — the paper is framed as a question over two studies on swipe-revealed hidden widgets, and it is doing more work in this spec than a title alone can support.

- Parhi et al. is misquoted the same way in all three specs: the MobileHCI '06 numbers are ≥9.2 mm for **discrete** tasks and ≥9.6 mm for **serial** tasks — both one-handed thumb. "≥9.6mm one-handed" as a separate finding does not exist.

- Verified TRUE and worth keeping (I checked these): `Key` is module-private at keybar.tsx:284 and does exactly what the spec says (opacity 0.5, scale 0.93, haptic on completed tap), while ribbon.tsx:197 duplicates it as a bare Pressable; `rgba` is byte-identical at keybar.tsx:212 and ribbon.tsx:38; `maxCapsHeight` is at the cited call site and is deletable; `dataSeq.current += chunks.length` (app/terminal.tsx:417) is the single output chokepoint for `lastOutputAt`; the animated-width-inside-a-clip construction is already shipping in `NamePill` (keybar.tsx:938-986, animated `width` + `alignItems` flip in a worklet), so the riskiest part of this spec has in-repo precedent; `SymbolView` takes a `fallback` and, with a plain string `name`, renders that fallback on Android (expo-symbols/build/SymbolView.js returns `props.fallback` when `name` is not an {android,web} object); nothing here enters `paneInsets`, so the zero-reflow claim holds by construction.


### Constraints the spec left unaddressed

- Constraint 2, the half about interruption: the spec engineers *when* the chip arrives (350ms quiescence) but never questions *how often*. The `running` recipe fires for every non-shell foreground process, so a 52pt band's chip appears for `git log`, `ls | less`, `npm test` — dozens of times an hour. A minimum-duration gate in ribbon-model.ts (show `running` only after the process has been alive ~3s) is a three-line change that would cut the appearance rate by an order of magnitude and is nowhere in the spec.

- Constraint 1 is met literally (no reflow) but the *open* state is the widest of the three candidates — full stage width, 52pt, over the newest three rows. The spec concedes occlusion but not that this is the most visually interruptive open state on offer, which is the exact word the user used to reject attempt B.

- The keyboard-rise case is claimed as smooth ("no second baseline to desync") but `keyboardPad` is React state derived from `keyboardWillChangeFrame`; the band steps in one commit while the iOS keyboard animates over ~250ms. That is the same imperfection the Compact spec admits to and this one does not.
