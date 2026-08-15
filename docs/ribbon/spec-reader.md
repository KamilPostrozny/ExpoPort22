# Reader — the ⋯ key becomes the recipe

> Full design spec for the ribbon redesign. Written by a spec agent against the
> measured constraints of this repo, then adversarially verified. Read
> [../ribbon-redesign.md](../ribbon-redesign.md) first — it carries the diagnosis,
> the evidence base and the recommendation. **Corrections from the verification
> pass are at the bottom of this file and take precedence over the body.**

## Thesis

Delete the floating layer: detection's entire ambient expression is the key bar's ⋯ circle filling with the recipe's identity colour and swapping its glyph — a shape-and-fill change on a 49pt control at a fixed, already-visited location, announced once by three finite cycles of a 2pt lateral nudge — and the caps become the first section of the menu that key already opens. It beats the 5pt edge handle because the cue is 96× the area, sits where the thumb and eye already go when the user stops reading, and the caps land on an opaque `theme.panel` plate that does not depend on what is behind it, which is the root cause of both halves of "not visible / not readable".

## Precedent

- Safari on iPhone, Reader — a detector runs continuously and, when it fires, NO new chrome appears: the existing address-field control changes state and an entry becomes available in the menu it already opens. Zero layout change, zero new surface, one permanent place to look. This design is that mechanism exactly, with the judges' correction applied: the delta is fill + glyph (shape and figure), not a hue tweak, so no memory comparison is required. Source: Apple Support, "Hide distractions when reading articles in Safari on iPhone", https://support.apple.com/guide/iphone/iphdc30e3b86/ios
- Apple HIG, Notifications — foreground signals must be "discoverable but not distracting or invasive", and the badge veto: "Avoid creating a custom image or component that mimics the appearance or behavior of a badge. People can turn off notification badges if they choose, and will become frustrated… Make sure badging isn't the only method you use to communicate essential information." This is why the ⋯ circle CHANGES ITS OWN IDENTITY (fill + symbol) rather than acquiring a pip beside it. Source: https://developer.apple.com/design/human-interface-guidelines/notifications
- NN/g — Pernice & Budiu, "Hamburger Menus and Hidden Navigation Hurt UX Metrics" (n=179): hidden navigation used in 27% of desktop and 57% of mobile cases vs 48–50%/86% for visible and combo, >20% lower content discoverability, 21% higher perceived difficulty, 15–39% longer task times — and COMBO matched visible on nearly every measure. The recipe section is the top section of the menu, immediately visible on open with no scroll and no second level, and the process name + live timer sit in its header. Source: https://www.nngroup.com/articles/hamburger-menus/
- Apple HIG, Popovers (iOS/iPadOS) — "Avoid displaying popovers in compact views. Reserve popovers for wide views; for compact views, use all available screen space by presenting information in a full-screen modal view like a sheet instead." A portrait iPhone is a compact view. This is a standing argument against the free-floating anchored capsule column of attempt B, and for a bar-anchored, scrim-backed menu list. Source: https://developer.apple.com/design/human-interface-guidelines/popovers
- Bartram, Ware & Calvert, "Moticons: detection, distraction and task" (International Journal of Human-Computer Studies 58(5), 2003) — peripheral COLOUR cues were missed 25% of the time versus under 2% for motion; the distraction ranking is blink < slow linear oscillation < zoom < travel, and guideline G8 names slow linear oscillation as the best detection/irritation compromise, "not considered intrusive or distracting", while G7 flags zoom/popping. The old handle pulsed opacity + scaleY at 0.53 Hz — a blink/zoom hybrid, the two worst families. Replaced by a ±2pt lateral linear oscillation at 1 Hz. Source: https://www.sciencedirect.com/science/article/pii/S1071581903000258
- W3C WCAG 2.2 Success Criterion 2.2.2 Pause, Stop, Hide (Level A) — any motion that starts automatically, lasts more than five seconds and is presented in parallel with other content must be pausable or stoppable. An indefinite "breathing" loop the user never started fails this at Level A; three cycles totalling 3.0 s does not. Source: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- W3C WCAG technique C40, "Creating a two-color focus indicator to ensure sufficient contrast with all components" — where the background cannot be predicted, use two adjacent 1px strokes of contrasting colours so that at least one always clears the ratio. Applied to the menu's perimeter as a 1pt `theme.background` outer ring plus a 1pt `theme.foreground` inner ring, which is the only construction that survives an arbitrary terminal cell behind the edge. Source: https://www.w3.org/WAI/WCAG22/Techniques/css/C40
- Apple HIG, Context menus — the system DIMS the screen behind a context menu; and Apple HIG, Materials — "If the underlying content is bright, consider adding a dark dimming layer of 35% opacity", plus "thicker materials… provide better contrast for text and other elements with fine features". Apple's answer to legibility over unpredictable content is not thinner glass, it is an opaque ground plus a dimming layer. Here: an opaque `theme.panel` plate (no BlurView at all) over a `theme.scrim`@0.32 dim — Material 3's own scrim alpha. Sources: https://developer.apple.com/design/human-interface-guidelines/context-menus and https://developer.apple.com/design/human-interface-guidelines/materials
- Yantis, S. & Jonides, J. (1990), "Abrupt visual onsets and selective attention: voluntary versus automatic allocation" (Journal of Experimental Psychology: HPP 16(1), 121–134) — attentional capture by abrupt onset is suppressed when attention is already highly focused. A reader mid-terminal will not be captured by anything, at any amplitude, which is why the resting cue is placed at the destination of the user's NEXT glance (the key bar they are about to touch) rather than at an unvisited screen edge. Source: https://psycnet.apa.org/record/1990-14056-001
- Parhi, Karlson & Bederson, "Target Size Study for One-Handed Thumb Use on Small Touchscreen Devices" (Proc. MobileHCI '06, 203–210) — ≥9.2 mm for discrete targets, ≥9.6 mm one-handed, with 29.9% error at 3.8 mm because thumbs land where the target LOOKS, not where the hit rect is. The 49pt circle (≈10.4 mm) and the 44pt menu rows (≈9.7 mm) both clear it; the 5pt tab never could, hit slop or not. Source: https://www.microsoft.com/en-us/research/wp-content/uploads/2006/01/parhi-mobileHCI06.pdf
- Apple HIG, Alerts — "Avoid displaying alerts for common, undoable actions, even when they're destructive… when people take an uncommon destructive action that they can't undo, it's important to display an alert." Calibrates which caps get the filled-red destructive treatment and the two-tap arm (`kill`, `^C ^C quit`, `:q!`, `F9`) versus which stay plain (`^C stop`, `^Z bg`, `fg`). Source: https://developer.apple.com/design/human-interface-guidelines/alerts

## States

- IDLE — `recipe === null`. The ⋯ circle is exactly what it is today: `Glass radius={BAR_RADIUS}` + `SymbolView name="ellipsis" size={20} tintColor={theme.foreground}`. Trigger: `selectRecipe()` returns null (idle shell, REPL, unknown TUI, disconnected). Exit: a poll or `ribbonForWindow` yields a recipe.
- DETECTED (resting) — `recipe !== null`. An absoluteFill child inside the circle's Glass paints `theme.dots[recipe.dot]` at full opacity with its own `borderRadius: BAR_RADIUS`; the SymbolView's `name` and `tintColor` swap to the recipe's symbol and `inkOn(theme, dotColor)`. The change is INSTANTANEOUS — no crossfade, no scale (Matthews et al.'s 'make aware' transition class: one abrupt change in a small area, then stillness). Trigger: `ribbonCore.instance` becomes non-null. Exit: the process ends, the window is switched to an idle one, or the connection drops.
- ANNOUNCING — the resting state plus three cycles of ±2pt `translateX` on the circle, 1 Hz, linear, 3.0 s total, ending at exactly 0. Runs once per `ribbonCore.instance`. Trigger: the same effect that enters DETECTED, gated on `!reduceMotion && panSV.dragging.value !== 1 && open === 'none'`. Exit: after 3.0 s, by construction; nothing can restart it without a new process instance.
- SENDING (upload wins) — `props.sending === true`. The circle's fill becomes `theme.accent` and the glyph reverts to `ellipsis` in `theme.background`, exactly as today. This OUTRANKS the recipe fill: a transfer in flight is the more urgent state and its inert tint is the whole progress UI (§4.6). Unlike today the tap is NOT disabled when a recipe is active — `onPress={props.sending && recipe == null ? undefined : () => toggle('menu')}` — so `/clear` stays reachable during an upload, and the attach cap inside the menu carries the busy treatment instead. Exit: `useUploadBusy()` clears.
- MENU OPEN, no recipe — `open === 'menu' && recipe === null`. Today's menu, on the new opaque plate: UPLOAD FILE header, three rows, break, Settings. No scrim (nothing tall is covering the pane; see note in `legibility`). Trigger: tap ⋯. Exit: scrim tap, a row, Android Back.
- MENU OPEN, with recipe — `open === 'menu' && recipe !== null`. A `theme.scrim`@0.32 dim covers the pane; the menu carries a recipe header (dot + proc + live `m:ss` or `stopped`), then the cap rows, then the break, then UPLOAD FILE and Settings. Trigger: tap ⋯ while DETECTED. Exit: any cap that is not an un-fired `arm` cap, the scrim, Android Back, or `recipe.id` changing.
- CAP PRESSED — `pressed` on a plain row paints `KEY_TINT` (`rgba(127,132,156,0.16)`) behind it; on a destructive row it drops the row to `opacity: 0.75`. A light haptic fires on the COMPLETED tap only, never touch-down (the bar's existing `Key` rule).
- CAP ARMED — only the agent's `^C ^C quit` (`arm: true`). After the first tap the row keeps its `theme.danger` fill, gains `borderWidth: 2, borderColor: theme.foreground` (the same halo idiom the locked Ctrl key uses), and its caption becomes `tap again`. The menu stays open. Exits after `ARM_MS = 2800`, on the second tap (which fires the bytes again and closes), on any other cap being tapped, or on the menu closing.
- ATTACH BUSY — the agent recipe's `📎 attach` row while `busy`. `disabled`, row background `rgba(theme.accent, 0.5)`, label and caption in `theme.background`, caption text `sending…`. Exit: `useUploadBusy()` clears.
- RECIPE SCROLLED — the whole menu body is one `ScrollView`; when its content exceeds `maxBodyH` the standard vertical indicator shows. Only the agent recipe (and small screens / keyboard-up) reaches it. Exit: content fits again.
- BAR IN FLIGHT — during a switcher zoom the ⋯ circle fades out with the rest of the bar for free: it lives inside the wrapper that already carries `barFadeStyle` (terminal.tsx:2320-2324). No new wiring, and unlike the old ribbon layer there is nothing left hanging in the air.
- VOICEOVER FOCUSED — the circle reports `accessibilityRole="button"`, `accessibilityLabel` = `${recipe.proc} actions` (or `More` when idle), `accessibilityHint="Opens the menu"`. On DETECTED, one `AccessibilityInfo.announceForAccessibility(\`${proc} actions available\`)` fires; it never steals focus.

## Anatomy

ALL VALUES IN pt. Theme tokens are the real roles from src/theme.ts. Existing constants named as they appear in src/keybar.tsx.

=== A. THE RESTING CUE — the ⋯ circle (src/keybar.tsx:741-778) ===

Position and box: UNCHANGED. `styles.circleSlot` = 49×49, the first child of `styles.row`
(`paddingHorizontal: SIDE_MARGIN` = 24 iOS / 8 Android, `paddingTop: BAR_PAD_TOP` = 5,
`paddingBottom: 6`, `gap: 7`). The bar wrapper is `position:absolute; left:0; right:0;
bottom: keyboardPad + insets.bottom` (terminal.tsx:2320) and carries `barFadeStyle`.
Nothing here touches `paneInsets` — the terminal cannot reflow, by construction.

Layer stack inside the 49×49 slot, back to front:
  1. `Glass theme radius={BAR_RADIUS}` (24.5 iOS / 16 Android) — kept mounted always, in every
     state, so no subtree is ever built on a poll tick.
  2. THE FILL, new. Rendered when `sending || recipe != null`:
       `<View pointerEvents="none" style={[StyleSheet.absoluteFill, {
          backgroundColor: sending ? theme.accent : theme.dots[recipe.dot],
          borderRadius: BAR_RADIUS }]} />`
     Full opacity, no alpha. It carries its OWN `borderRadius` rather than relying on the
     parent's `overflow:'hidden'` — an absolutely-filled child squares off the circle's edge on
     device even inside a clip (the comment already at keybar.tsx:752 records this).
  3. `SymbolView size={20}` with a `Text` fallback at `fontSize: 18` in MONO.
       tintColor / colour = `sending ? theme.background : inkOn(theme, theme.dots[recipe.dot])`
     Recipe → symbol (SF Symbol / fallback glyph):
       running    `bolt.fill`                                  / "⚡"
       suspended  `pause.fill`                                 / "⏸"
       vim        `chevron.left.forwardslash.chevron.right`    / "</>"
       pager      `doc.plaintext.fill`                         / "▤"
       htop       `chart.bar.fill`                             / "▦"
       agent      `sparkles`                                   / "✦"
     idle / sending → `ellipsis` / "⋯", as today.
  4. The whole Glass sits inside an `Animated.View` carrying the nudge's `translateX`.
     Transform only — zero layout effect.

`inkOn`, the one new helper (put it beside `rgba()` at keybar.tsx:212, ~5 lines):
```ts
/** Which of the scheme's two extremes reads on an arbitrary dot colour. Latte's `grey` dot
 *  (#9ca0b0) against Latte's background is 2.4:1 — the one case a fixed choice breaks. */
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
};
const inkOn = (t: Theme, hex: string) =>
  lum(hex) > lum(t.background) === lum(hex) > lum(t.foreground)
    ? (lum(hex) > 140 ? '#000000' : '#ffffff')
    : (Math.abs(lum(hex) - lum(t.background)) > Math.abs(lum(hex) - lum(t.foreground))
        ? t.background : t.foreground);
```
(In practice this returns `theme.background` on every dark scheme and every Catppuccin light
dot; the black/white branch exists only so a pathological generated scheme cannot produce an
illegible glyph. `ponytail: two-extreme pick, swap for a real APCA calc if a scheme ever
lands between them.`)

NO ring, NO badge, NO pip, NO shadow. The disc IS the change.

=== B. THE OPEN SURFACE — BarMenu (src/keybar.tsx:1067) ===

Anchor: UNCHANGED. `styles.menuPop` = `{position:'absolute', left: SIDE_MARGIN, width: 256,
bottom}` with `bottom = popBase` (terminal.tsx:1787 = `barHeight + 6 + keyboardPad +
insets.bottom`). It grows UPWARD from the bar, directly above the control that opened it, and
its anchor never moves between recipes.

B1. THE PERIMETER — WCAG C40 two-colour outline, because the edge lands on unpredictable
    terminal cells:
      outer ring : `<View style={{borderRadius: 27, borderWidth: 1,
                     borderColor: theme.background, overflow: 'hidden'}}>`
      inner ring : the plate's own `borderWidth: 1, borderColor: theme.foreground`
    `theme.background` and `theme.foreground` are the scheme's own two extremes, so whatever
    colour sits behind the edge, at least one of the two strokes clears 3.8:1 against it.
    Visible box stays 256 wide; content box is 252.

B2. THE PLATE — Glass is GONE here. Replaced by an opaque view:
      `{borderRadius: 26, overflow: 'hidden', backgroundColor: theme.panel,
        borderWidth: 1, borderColor: theme.foreground,
        ...(Platform.OS === 'android' && {boxShadow: '0 1px 3px rgba(0,0,0,0.45)'})}`
    `theme.panel` = Catppuccin `mantle`, or `mix(bg, black, 0.2|0.04)` on a generated scheme —
    the role whose documented job is "the field a group of rows floats on… sits BEHIND
    background, so a sheet over a terminal still reads as a sheet rather than as more
    terminal" (theme.ts:66). Dropping the BlurView deletes a compositing pass, deletes the
    "a mounted BlurView keeps re-rendering its backdrop" hazard, and makes Reduce Transparency
    a no-op by construction. On Android `Glass` was already an opaque `theme.surface` box, so
    this is an iOS-only visual change.

B3. THE SCRIM — mounted only while `open === 'menu' && recipe !== null`:
      `<Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(180)}
         pointerEvents="none" style={[StyleSheet.absoluteFill,
         {backgroundColor: rgba(theme.scrim, 0.32)}]} />`
    placed as the first child of the existing popover layer (terminal.tsx:2395), under the
    dismiss `Pressable`. 0.32 is Material 3's scrim alpha; Apple's Materials guidance names 35%
    for the same job. Deliberately NOT applied to the arrows / clipboard / hint popovers: the
    arrows popover is pressed repeatedly to watch the cursor move, and dimming the pane there
    would be actively wrong.

B4. THE BODY — one `ScrollView`, `showsVerticalScrollIndicator`, with
      `maxHeight = Math.max(160, stage.h - popBase - insets.top - 8)`
    computed in terminal.tsx and passed as `maxBodyH`. One number, one clamp, no per-section
    arithmetic; the recipe section is first, so it is what is on screen, and Upload/Settings are
    one flick away. On a 390×844 iPhone, keyboard down: popBase = 100, insets.top = 47 →
    maxBodyH = 689. Keyboard up: popBase = 391 → maxBodyH = 398. Landscape 844×390:
    popBase ≈ 94, insets.top = 0 → maxBodyH = 288.

B5. RECIPE HEADER ROW — first child of the body, present only when `recipe != null`:
      container `{height: 34, flexDirection:'row', alignItems:'center', gap: 8,
                  paddingHorizontal: 18,
                  backgroundColor: rgba(theme.dots[recipe.dot], 0.14)}`
      dot       `{width: 8, height: 8, borderRadius: 4,
                  backgroundColor: theme.dots[recipe.dot]}`   — STATIC, never pulses.
      name      `{fontFamily: MONO, fontSize: 12, fontWeight: '600', letterSpacing: 0.3,
                  color: theme.foreground, flex: 1}` → `recipe.proc`
      trailing  `{fontFamily: MONO, fontSize: 12, color: SUB}` →
                  running   → `formatElapsed(Date.now() - startedAt)`  e.g. "2:41"
                  suspended → "stopped"
                  otherwise → omitted
    where `const SUB = rgba(theme.foreground, 0.85)`.
    The ticking numeral is the liveness signal, replacing the pulse — same information,
    static, and it also satisfies Differentiate Without Color.

B6. SECTION HEADER ROW — `Cap.header` (the agent's SESSION / COMMANDS / NOW):
      `{height: 28, justifyContent:'center', paddingHorizontal: 18,
        backgroundColor: theme.surface}`
      text `{fontSize: 11, fontWeight: '600', letterSpacing: 0.5, color: theme.foreground}`
      `accessibilityRole="header"`.
    Opaque `theme.surface` band, not bare text with a shadow — it is what chunks twelve rows.

B7. CAP ROW — plain:
      `{minHeight: 44, justifyContent:'center', paddingHorizontal: 18, paddingVertical: 0,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: HAIRLINE}`
      inner `{flexDirection:'row', alignItems:'center', gap: 10}`
      label   `{fontFamily: MONO, fontSize: 15, fontWeight: '500', color: theme.foreground}`
      spacer  `{flex: 1}`
      caption `{fontSize: 13, color: SUB}` `numberOfLines={1}`; omitted when `Cap.caption`
              is absent (the `/clear` family)
      pressed `{backgroundColor: KEY_TINT}` (`rgba(127,132,156,0.16)`)

B8. CAP ROW — destructive (`Cap.danger === true`): FILLED, not tinted.
      row     `{backgroundColor: theme.danger, borderTopColor: theme.danger}`
      leading `SymbolView name="exclamationmark.triangle.fill" size={13}
               tintColor={theme.onAccent}` / fallback Text "⚠" 12pt
      label + caption in `theme.onAccent` (= `theme.background` by construction, theme.ts:79)
      pressed `{opacity: 0.75}`
    Filled rather than red-on-plate because `theme.onAccent` is defined as `background`, and
    contrast is symmetric: a scheme whose red is legible on its background gives the inverse
    for free. Measured: Mocha 7.08:1, Latte 4.80:1. A red LABEL on the plate measures 4.46:1
    on Latte and 3.53:1 once the old `danger@0.16` tint is under it — i.e. the current
    treatment fails exactly on the caps that matter. The ⚠ glyph carries the meaning without
    colour (WCAG 1.4.1).
    Which caps: `kill` (running, suspended), `:q!`, `F9`, `^C ^C quit`. NOT `^C stop`,
    NOT `^Z bg`, NOT `fg` — those are common and reversible, and red on them dilutes the code
    (HIG Alerts).

B9. CAP ROW — armed (`Cap.arm && armed`): B8 plus `{borderWidth: 2, borderColor:
    theme.foreground}` and the caption text replaced by `tap again`.

B10. CAP ROW — attach busy (`busy && cap.action === 'attach'`): `disabled`,
     `{backgroundColor: rgba(theme.accent, 0.5)}`, label + caption in `theme.background`,
     caption text `sending…`.

B11. BREAK + TAIL — unchanged shape, new numbers:
      `styles.menuBreak` `{height: 6, backgroundColor: 'rgba(0,0,0,0.14)'}`
      `styles.menuHeader` "UPLOAD FILE" — colour changes from `theme.muted` to
        `theme.foreground`, everything else as-is (paddingH 18 / top 11 / bottom 6, 11pt, 600,
        ls 0.5, `opacity: 0.8`) → 30pt tall
      `styles.menuRow` gains `{minHeight: 44, justifyContent:'center', paddingVertical: 0}`
        (was `paddingVertical: 12`, i.e. ~42.5 — under the 44pt floor)
      three upload rows, break 6, Settings row 44.

=== C. HEIGHTS, THE AGENT RECIPE (the hard case) ===
  ring+plate borders            4
  recipe header               34
  SESSION header              28
  ^C ^C quit                  44
  COMMANDS header             28
  /clear /context /model
  /usage /config /plugins   6×44 = 264
  NOW header                  28
  📎 ⇧⇥ ⎋                    3×44 = 132
  break                        6
  UPLOAD FILE header          30
  Files / Photo / Camera    3×44 = 132
  break                        6
  Settings                    44
                            -------
  total                      810
Clamped by `maxBodyH` = 689 on a 390×844 phone → the body scrolls 121pt. Visible without
scrolling: the recipe header, SESSION + its cap, COMMANDS + all six slash commands, NOW + two
of three. Every cap of the hardest recipe is at most one short flick away, and the three
sections read as three sections.

=== D. Z-ORDER, unchanged document order (terminal.tsx has no zIndex anywhere) ===
  … 5. key bar wrapper (⋯ circle lives here, inside `barFadeStyle`)
    6. — was the ribbon handle layer — DELETED
    7. — was RibbonPanel — DELETED
    8. popover layer: [scrim tint] → [dismiss Pressable] → [BarMenu | arrows | hint | clipboard]
  The popover layer is drawn AFTER the bar, so while the menu is open the bar is behind the
  dismiss Pressable and eats one tap — the same contract every popover already has today.

=== E. SAFE AREAS ===
  Nothing new. `popBase` already carries `keyboardPad + insets.bottom`; `maxBodyH` subtracts
  `insets.top`. The menu never enters the home-indicator strip (it starts at `popBase`, which
  is above the bar, which is above `insets.bottom`) and never enters the notch band.

## Mockups

```
════════════════════════════════════════════════════════════════
 1. RESTING — agent recipe detected (`claude` in the pane). 390×844.
    Nothing floats over the terminal. Nothing was reflowed.
════════════════════════════════════════════════════════════════

 ┌────────────────────────────────────────────────────────────┐ ─┐
 │                                                            │  │ insets.top 47
 │▏● Update Todos                                             │ ─┘
 │▏  ⎿ ☒ Read src/theme.ts                                    │
 │▏    ☒ Read src/keybar.tsx                                  │
 │▏    ☐ Write the spec                                       │
 │▏                                                           │
 │▏✻ Weaving…  (esc to interrupt · 41s)                       │
 │▏                                                           │
 │▏╭────────────────────────────────────────────────────────╮ │
 │▏│ >                                                      │ │
 │▏╰────────────────────────────────────────────────────────╯ │
 │▏  ⏵⏵ accept edits on                    Opus 5 · 62% left  │
 │                                                            │ ← 7.8pt padH
 │  ╭─────╮ ╭────────────────────────────────────╮ ╭─────╮    │
 │  │▓▓✦▓▓│ │ Ctrl  Esc  Tab  Paste │ ✛          │ │  ▣  │    │ 60pt bar
 │  ╰─────╯ ╰────────────────────────────────────╯ ╰─────╯    │
 │     ▲                                                      │
 │     │  49×49. Glass still mounted underneath.              │
 │     │  FILL  theme.dots.peach @1.0, r=BAR_RADIUS 24.5      │
 │     │  GLYPH `sparkles` 20pt in inkOn(theme, peach)        │
 │     │  NUDGE ±2pt translateX, 1 Hz, linear, 3 cycles, stop │
 │     │  Was: ⋯ on plain glass, one poll ago.                │
 │                      ▁▁▁▁▁▁▁▁▁▁▁▁                          │ insets.bottom 34
 └────────────────────────────────────────────────────────────┘

    THE SAME SLOT ACROSS RECIPES — nothing else on screen changes:

      idle        running      suspended      vim        pager      htop      agent
    ╭─────╮     ╭─────╮      ╭─────╮      ╭─────╮     ╭─────╮    ╭─────╮   ╭─────╮
    │  ⋯  │     │▓▓⚡▓▓│      │▒▒⏸▒▒│      │▓</>▓│     │▓▓▤▓▓│    │▓▓▦▓▓│   │▓▓✦▓▓│
    ╰─────╯     ╰─────╯      ╰─────╯      ╰─────╯     ╰─────╯    ╰─────╯   ╰─────╯
     glass       green         grey        mauve        blue      yellow    peach
                dots.green   dots.grey   dots.mauve  dots.blue  dots.yellow dots.peach

    vs. WHAT IT REPLACES (attempt B, drawn to the same scale) — the whole cue
    was the 5pt sliver at the right margin, 46pt tall, breathing:

 │▏  ⏵⏵ accept edits on                    Opus 5 · 62% left ▐│  ← 5×46, that's it
 │  ╭─────╮ ╭────────────────────────────────────╮ ╭─────╮   ▐│
 │  │  ⋯  │ │ Ctrl  Esc  Tab  Paste │ ✛          │ │  ▣  │   ▐│


════════════════════════════════════════════════════════════════
 2. OPEN — the 12-cap agent recipe, three sections. Tap the ✦ circle.
    Menu: left: 24, width 256, bottom: popBase (100). Pane dimmed scrim@0.32.
════════════════════════════════════════════════════════════════

 ┌────────────────────────────────────────────────────────────┐
 │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  the terminal is
 │░░●░Update░Todos░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  still there and
 │░░░░⎿░☒░Read░src/theme.ts░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  still readable —
 │░╔══════════════════════════════════╗░░░░░░░░░░░░░░░░░░░░░░░│  dimmed, not
 │░║▒● claude                   2:41 ▒║░░░░░░░░░░░░░░░░░░░░░░░│  hidden.
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║████ SESSION ████████████████████ ║░░░░░░░░ 28  surface   │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║██ ⚠  ^C ^C                quit ██║░░░░░░░░ 44  FILLED    │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░  danger │
 │░║████ COMMANDS ███████████████████ ║░░░░░░░░ 28            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  /clear                          ║░░░░░░░░ 44            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  /context                        ║░░░░░░░░ 44            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  /model                          ║░░░░░░░░ 44            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  /usage                          ║░░░░░░░░ 44            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  /config                         ║░░░░░░░░ 44            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  /plugins                        ║░░░░░░░░ 44            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║████ NOW █████████████████████████║░░░░░░░░ 28            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  📎                     attach   ║░░░░░░░░ 44            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  ⇧⇥                  plan mode   ║░░░░░░░░ 44          ▐ │← scroll
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░  ▐ │  indicator
 │░║  ⎋                        stop   ║░░░░░░░░ 44          ▐ │
 │░╠══════════════════════════════════╣░░░░░░░ 6 menuBreak    │
 │░║ UPLOAD FILE                      ║░░░░░░░ 30            │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  Files                           ║░░░░░░░ 44   ← below   │
 │░║  Photo or video                  ║░░░░░░░ 44     the     │
 │░║  Camera                          ║░░░░░░░ 44     fold,   │
 │░╠══════════════════════════════════╣░░░░░░░ 6      one     │
 │░║  Settings                        ║░░░░░░░ 44     flick   │
 │░╚══════════════════════════════════╝░░░░░░░░░░░░░░░░░░░░░░░│
 │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
 │░ ╭─────╮ ╭────────────────────────────────────╮ ╭─────╮ ░░░│ ← bar is BEHIND
 │░ │▓▓✦▓▓│ │ Ctrl  Esc  Tab  Paste │ ✛          │ │  ▣  │ ░░░│   the dismiss
 │░ ╰─────╯ ╰────────────────────────────────────╯ ╰─────╯ ░░░│   Pressable
 │                      ▁▁▁▁▁▁▁▁▁▁▁▁                          │
 └────────────────────────────────────────────────────────────┘
   ▲                                    ▲
   │ left: SIDE_MARGIN 24               │ width 256 (252 content)
   ╚ ═ outer 1pt theme.background + inner 1pt theme.foreground (WCAG C40)
     ║ opaque theme.panel — no BlurView anywhere in this surface

   Row anatomy, one cap, actual size:
   ┌─ 18 ─┬──────── MONO 15 w500 ────────┬─ flex:1 ─┬─ 13pt SUB ─┬─ 18 ─┐
   │      │ /context                     │          │            │      │  44
   └──────┴──────────────────────────────┴──────────┴────────────┴──────┘
                                                     (no caption on the
                                                      slash caps — the
                                                      label says it all)

   Destructive row, filled:
   ┌─ 18 ─┬─ ⚠ ─┬─ 10 ─┬── ^C ^C ──┬─ flex:1 ─┬── quit ──┬─ 18 ─┐
   │██████│█████│██████│███████████│██████████│██████████│██████│  44
   └──────┴─────┴──────┴───────────┴──────────┴──────────┴──────┘
     bg theme.danger · ink theme.onAccent (= theme.background)

   Armed (after the first tap of ^C ^C):
   ╔══════════════════════════════════════════════════════════╗
   ║██ ⚠  ^C ^C                                 tap again   ██║  44
   ╚══════════════════════════════════════════════════════════╝
     + borderWidth 2, borderColor theme.foreground · 2800ms then disarms


════════════════════════════════════════════════════════════════
 3. OPEN — a 3-cap recipe (`running`, npm build, 14s in). Same anchor,
    same rows, nothing scrolls. This is the common case.
════════════════════════════════════════════════════════════════

 ┌────────────────────────────────────────────────────────────┐
 │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
 │░░~/p22░❯░npm░run░build░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
 │░░iOS░Bundling░░████████████░░░░░░░71%░░░░░░░░░░░░░░░░░░░░░░│
 │░╔══════════════════════════════════╗░░░░░░░░░░░░░░░░░░░░░░░│
 │░║▒● npm                      0:14 ▒║░░░ 34  dots.green@.14 │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║██ ⚠  kill                force ██║░░░ 44  FILLED danger  │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  ^Z bg              background   ║░░░ 44  plain          │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  ^C                      stop    ║░░░ 44  plain — common │
 │░╠══════════════════════════════════╣░░░ 6      + undoable, │
 │░║ UPLOAD FILE                      ║░░░ 30     so NOT red  │
 │░╟──────────────────────────────────╢░░░░░░░░░░░░░░░░░░░░░░░│
 │░║  Files                           ║░░░ 44                 │
 │░║  Photo or video                  ║░░░ 44                 │
 │░║  Camera                          ║░░░ 44                 │
 │░╠══════════════════════════════════╣░░░ 6                  │
 │░║  Settings                        ║░░░ 44                 │
 │░╚══════════════════════════════════╝░░░░░░░░░░░░░░░░░░░░░░░│
 │░ ╭─────╮ ╭────────────────────────────────────╮ ╭─────╮ ░░░│
 │░ │▓▓⚡▓▓│ │ Ctrl  Esc  Tab  Paste │ ✛          │ │  ▣  │ ░░░│
 │░ ╰─────╯ ╰────────────────────────────────────╯ ╰─────╯ ░░░│
 │                      ▁▁▁▁▁▁▁▁▁▁▁▁                          │
 └────────────────────────────────────────────────────────────┘
   total 388pt of 689 available — no scroll, no clamp, no arithmetic.


════════════════════════════════════════════════════════════════
 4. KEYBOARD UP — a `/` cap has just been tapped in the pager recipe.
    The menu closed on the tap; `focusSignal` raised the keyboard.
    popBase went 100 → 391 and the menu is already gone, so there is
    nothing to keep in sync. This is the failure mode every floating
    design had to engineer around, and here it does not exist.
════════════════════════════════════════════════════════════════

 ┌────────────────────────────────────────────────────────────┐
 │▏manpage(1)                                       manpage(1)│
 │▏  … dense text, untouched, unreflowed …                    │
 │▏/                                                          │ ← the "/" landed
 │  ╭─────╮ ╭────────────────────────────────────╮ ╭─────╮    │
 │  │▓▓▤▓▓│ │ Ctrl  Esc  Tab  Paste │ ✛          │ │  ▣  │    │ ← cue still on
 │  ╰─────╯ ╰────────────────────────────────────╯ ╰─────╯    │   the blue disc
 │ ┌────────────────────────────────────────────────────────┐ │
 │ │ q w e r t y u i o p                                    │ │
 │ │  a s d f g h j k l                                     │ │
 │ │ ⇧  z x c v b n m  ⌫                                    │ │
 │ │ 123      space          return                         │ │
 │ └────────────────────────────────────────────────────────┘ │
 └────────────────────────────────────────────────────────────┘
```

## Motion

Four animations total. Three of them already exist.

1. THE ARRIVAL NUDGE — the only new motion in the design.
   Property: `translateX` on the `Animated.View` wrapping the ⋯ circle's Glass. Transform
   only; no layout, no opacity, no scale.
   ```ts
   const nudge = useSharedValue(0);
   const reduceMotion = useReducedMotion();          // react-native-reanimated
   useEffect(() => {
     if (recipe == null || reduceMotion) return;
     if (panSV?.dragging.value === 1 || open !== 'none') return;   // never under a finger
     nudge.value = withRepeat(
       withSequence(
         withTiming( 2, { duration: 250, easing: Easing.linear }),
         withTiming(-2, { duration: 500, easing: Easing.linear }),
         withTiming( 0, { duration: 250, easing: Easing.linear }),
       ), 3, false);
   }, [recipe?.instance]);                            // once per process instance
   const nudgeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: nudge.value }] }));
   ```
   Amplitude ±2pt, frequency 1.0 Hz, easing linear, 3 cycles, 3000 ms, terminal value exactly 0.
   Rationale, all cited: Bartram/Ware/Calvert G8 names SLOW LINEAR OSCILLATION as the best
   detection-versus-irritation signal and flags zoom/blink (the old handle's opacity+scaleY at
   0.53 Hz) as the worst two; the same paper found amplitude essentially irrelevant to detection
   (0.5° and 1° performed alike), so 2pt is chosen for non-annoyance rather than for size. Axis
   is HORIZONTAL because terminal output scrolls vertically and a cue must not share the axis of
   the masking transients. Finite because WCAG 2.2.2 (Level A) forbids an unstoppable
   auto-starting loop; three cycles covers Bartram's sub-3-second worst-case detection time.
   REDUCE MOTION: not started at all. The fill + glyph change is a state change, not an
   animation, and remains the full signal — which is why the cue does not degrade to nothing
   the way the old breathing handle did (Reanimated disables `withRepeat` under Reduce Motion
   by default, leaving that handle a static invisible 5pt bar — an existing a11y bug this
   design deletes).

2. THE FILL + GLYPH SWAP — deliberately NOT animated. Instantaneous, on the React commit that
   sees the new recipe. Matthews et al.'s peripheral-display taxonomy maps the "make aware"
   notification level to "updating small pieces of the display abruptly"; a crossfade would put
   it in the "change blind" class, which is precisely where attempt B landed.

3. MENU IN / OUT — the existing `Animated.View` on `styles.menuPop`:
     `entering={FadeInDown.duration(180)}`
     `exiting={FadeOutDown.duration(180)}`   ← changed from 140
   180/180 because 2026-08-11 (aae62fe) recorded that a 140 exit against a 180 entry "read as
   the ribbon blinking out while the arrival glided". The other three popovers keep 180/140;
   this is the one that now carries the recipe.
   REDUCE MOTION: swap both for `FadeIn.duration(180)` / `FadeOut.duration(180)` — the same
   opacity curve with the 10pt translation removed. (`FadeInDown` is a positional layout
   animation and Reanimated does not strip it automatically.)

4. THE SCRIM — `FadeIn.duration(180)` / `FadeOut.duration(180)` on the tint view, matching the
   menu exactly so the two arrive and leave as one object. Opacity only. Unchanged under
   Reduce Motion (opacity is not motion), never bounced — every M3 "Effects" spring is
   damping 1.0 for exactly this reason.

WHAT IS GONE: the 950/950 ms opacity+scaleY breath on the handle, and the 800/800 ms dot pulse
in the panel. Both were indefinite `withRepeat(..., -1)`, both were Reduce Motion violations,
and both are replaced by the ticking `m:ss` numeral in the menu header, which carries the same
"this is live" information statically.

NO SPRINGS ANYWHERE IN THIS DESIGN. Nothing here is dragged, so nothing needs to follow a
finger, so there is no shared-value-per-frame path and no worklet beyond the 12-line nudge.

## Interaction

EVERY GESTURE AND TAP, in full.

OPEN
  • Tap the ⋯ circle (49×49, the same control, the same place, whether or not a recipe is
    active). `onPress = props.sending && recipe == null ? undefined : () => toggle('menu')`.
    `toggle` is the existing helper; `BarPopover` is single-valued, so this closes the arrows
    or clipboard popover for free.
  • That is the ONLY door. There is no swipe, no edge zone, no long-press.
    THE LONG-PRESS-ON-TERMINAL SECOND DOOR IS DROPPED (judges' fix, all three reviewers). It
    would have put a 420ms recogniser inside the DOM component against WebKit's own selection
    long-press, which src/terminal.tsx:710 deliberately does not `preventDefault` under the
    slop precisely so WebKit can start it. Select-and-copy output is a workflow that matters on
    a terminal; a contextual menu is not worth taking it. HIG Gestures also says a custom
    gesture may never be the only route, and the tap already is the route.
  • Consequence worth stating: the ribbon no longer owns ANY gesture. The right screen edge goes
    back to being free, the swipe-left/swipe-right pair is deleted, and the Android
    predictive-back collision on both edges (which RNGH cannot arbitrate — issue #833, closed
    as not planned) simply does not arise.

INSIDE THE MENU
  • Tap a cap row → `onCap(cap)` then, unless the cap armed on this tap, `onClose()`.
    `onRibbonCap` in terminal.tsx:1654 is unchanged: attach / kill / bg / fg / bg2 / bytes,
    and `cap.focus` bumps `focusSignal`.
    Order is cap-then-close, matching today's RibbonPanel; a `focus` cap therefore sends its
    byte, closes the menu, and raises the keyboard, in that order.
  • Haptics: `Haptics.impactAsync(ImpactFeedbackStyle.Light)` on the COMPLETED tap of a cap row
    only — the same rule the bar's `Key` follows (never on touch-down, because a bar swipe
    starting over a key buzzed on every hop). Upload and Settings rows keep their present
    silence; caps get the haptic because they send bytes to a live process.
  • THE TWO-TAP ARM (agent `^C ^C quit`, `Cap.arm`): first tap fires `bytes` and returns
    WITHOUT closing; the row keeps its red fill, gains a 2pt `theme.foreground` border, and its
    caption becomes `tap again`. `ARM_MS = 2800` (moved verbatim from ribbon.tsx:36) disarms it.
    The second tap fires again and closes. Tapping ANY other row disarms first — HIG Alerts'
    Cancel-button rule translated: an armed destructive state must have a visible way out that
    is not "hope it times out".
    Nothing else in any recipe arms. `^C stop`, `^Z bg`, `fg`, `bg` are common and reversible.

CLOSE
  • Tap the full-screen dismiss `Pressable` (terminal.tsx:2397) — "tap the terminal to close",
    exactly as today, one tap eaten.
  • Tap any cap that is not an un-fired arm cap.
  • Tap Upload or Settings (they close and run their flow, as today).
  • Android hardware Back — ALREADY WIRED. terminal.tsx:1244's ladder is
    `switcher → open !== 'none' → exitApp`, and `open === 'menu'` is that middle rung. This
    design is the only one that needs no new BackHandler registration.
  • `recipe.id` changing (see `edge_cases`).

WHAT IS NOT AN INTERACTION
  • The arrival. Nothing appears, nothing moves, nothing takes a touch, nothing reflows.
    Constraint 2's second half — "its arrival must never move the text under a finger or steal
    a touch" — is satisfied vacuously, not engineered around.
  • The bar's own pan (keybar.tsx:564-696) is untouched. It still owns both axes, the zoom, the
    keyboard dismiss and the window hop. The recipe fill is a paint on a child of the row the
    pan already covers; a `translateX` transform does not affect hit-testing of a 49×49 slot by
    2pt, and the nudge is suppressed while `panSV.dragging.value === 1` anyway.
  • The terminal surface's raw DOM listeners (src/terminal.tsx:724-918) are untouched: pan,
    momentum, one-finger tap-to-focus, two-finger tap-to-Settings, and WebKit's long-press
    selection all keep exactly the arbitration they have.
  • While the menu is open the bar is behind the dismiss Pressable, so a window-hop swipe cannot
    start. Identical to today's behaviour for all four popovers; no new rule to learn.

STEALING TOUCHES — the audit. The design adds exactly one new hit target (nothing: the ⋯
circle already existed) and one new full-screen `Pressable` (nothing: the popover layer already
had one). Net new gesture recognisers: ZERO.

## Legibility

THE ROOT CAUSE, AND WHY THIS FIXES IT
Attempt B's "not visible" and "not readable" are one bug: a single translucent colour
(`surface@0.62`) trying to work against two opposite extremes. Over a bright pane the 12.5pt
`muted` caption measured 1.76:1 (APCA Lc 22.5) and the red destructive label 1.69:1 — the most
dangerous cap was the least legible. Over a dark pane the capsule body measured 1.17:1 against
its own background. No alpha value can satisfy both. The fix is to stop depending on the
background at all.

1. THE PLATE IS OPAQUE. `backgroundColor: theme.panel`, full opacity, no BlurView in the
   surface. Every contrast ratio below is therefore a CONSTANT, not a function of what tmux
   happened to paint. Measured (sRGB relative luminance, WCAG 2.x):

     Catppuccin Mocha — panel = mantle #181825
       label   theme.foreground #cdd6f4 on #181825      11.7 : 1   (15pt MONO)
       caption fg@0.85 → #b2bad5 on #181825              8.9 : 1   (13pt)
       header  theme.foreground on surface0 #313244      7.5 : 1   (11pt/600)
       danger  onAccent #1e1e2e on danger #f38ba8        7.1 : 1   (15pt, filled)

     Catppuccin Latte — panel = mantle #e6e9ef
       label   theme.foreground #4c4f69 on #e6e9ef       6.6 : 1
       caption fg@0.85 → #63667d on #e6e9ef              4.6 : 1
       header  theme.foreground on surface0 #ccd0da      5.2 : 1
       danger  onAccent #eff1f5 on danger #d20f39        4.8 : 1

   All clear the 4.5:1 floor for body text at every size used. The floor case is Latte's
   caption at 4.6:1, which is why the caption alpha is 0.85 and not the 0.72 that would have
   been sufficient on dark schemes alone — one constant, both ends.
   `theme.muted` IS NOT USED ANYWHERE IN THIS SURFACE. On Latte, `muted` = subtext0 #6c6f85
   over mantle is 4.4:1 and over a `surface0` header band 3.4:1; it is the token that failed
   in fd4e8f2 and it is retired here (including from the existing "UPLOAD FILE" header, which
   changes to `theme.foreground`).

2. DESTRUCTIVE ROWS ARE FILLED, NOT TINTED. `backgroundColor: theme.danger`, ink in
   `theme.onAccent`. theme.ts:79 defines `onAccent` as `background` on purpose — "contrast is
   symmetric, so background-on-accent inherits the guarantee that accent-on-background holds".
   A scheme whose red is legible on its own background gives the inverse for free, on all 26
   themes, with no per-theme tuning. The alternative — red text on the plate — measures 4.46:1
   on Latte and collapses to 3.53:1 once the old `danger@0.16` tint is composited under it.
   The 14%-alpha destructive tint is deleted.

3. TWO-COLOUR PERIMETER (WCAG technique C40). The one place the design still touches an
   unpredictable background is the menu's outer edge. No single colour survives it: measured
   against all 26 Mocha colours plus pure white and black, every candidate border colour bottoms
   out at 1.00:1 because it can always land on itself. A 1pt `theme.background` outer ring plus a
   1pt `theme.foreground` inner ring never drops below 3.84:1 for at least one of the two
   strokes, against anything, because those two roles are the scheme's own maximum-contrast pair.

4. A SCRIM, NOT THICKER CHROME. `rgba(theme.scrim, 0.32)` over the whole pane while the recipe
   menu is open — Material 3's exact scrim alpha, and within Apple's "dark dimming layer of 35%
   opacity" prescription for bright content under a floating surface. It is what the system does
   behind a context menu. It costs zero layout height, it makes the menu's silhouette
   unambiguous against htop's colour bars, and it reads as lift rather than occlusion because
   the terminal stays visible. `theme.scrim` is the role explicitly defined as darker than the
   background even on light schemes, so the dim works on Latte too.

5. THE RESTING CUE DOES NOT DEPEND ON THE PANE AT ALL. It sits inside the key bar, on the bar's
   own already-proven ground, and is a full-opacity disc in `theme.dots[…]` with a glyph in
   `inkOn(theme, dot)`. Its worst case is Latte's `grey` dot (#9ca0b0), which is why `inkOn`
   exists rather than a hard-coded `theme.background`.

REDUCE TRANSPARENCY: nothing to do. There is no translucency in the menu to remove. The
existing bar Glass keeps its blur (a 49pt control over the card's quiet bottom band, where it
has never been the problem). If a future audit wants it gone, Glass's iOS branch is one
`Platform`-style guard; it is not required by this design and is not specified here.

INCREASE CONTRAST: the plate is already opaque and every ratio above clears 4.5:1; the honest
answer is that this design has no separate high-contrast variant and does not need one.

## Scaling

3 CAPS → 12 CAPS, and why the container does not change.

The 672pt arithmetic that kills a floating column — 12 caps × 44pt + 12 × 12pt padding, taller
than an iPhone safe area — does not apply to a transient, modal, SCROLLING menu. A floating
column must fit because it lives over content the user is reading; a menu is allowed to be
tall because it is temporary and the content behind it is already dimmed. That is the whole
structural argument for this design, and it is why one container serves both ends of the range.

THE THREE SIZES, all in the same 256pt menu at the same anchor:
  running / suspended (3 caps)   header 34 + 3×44         = 166pt of recipe section
  vim / pager (5 caps)           header 34 + 5×44         = 254pt
  htop (4 caps)                  header 34 + 4×44         = 210pt
  agent (12 caps, 3 sections)    header 34 + 3×28 + 12×44 = 646pt
Plus the invariant tail: break 6 + UPLOAD FILE 30 + 3×44 + break 6 + Settings 44 = 218pt.

OVERFLOW: one `ScrollView` wrapping the ENTIRE body — recipe section, break, upload rows,
Settings — with a single clamp:
  `maxBodyH = Math.max(160, stage.h - popBase - insets.top - 8)`
computed in terminal.tsx beside the old `maxCapsHeight` and passed down. One number, no
per-section arithmetic, and it degrades correctly in every configuration:
  390×844 portrait, keyboard down : popBase 100 → 689. Agent total 810 → scrolls 121pt.
                                     Everything through "⇧⇥ plan mode" is on screen.
  390×844 portrait, keyboard up   : popBase 391 → 398. Nine rows visible, scrolls.
  844×390 landscape               : popBase ≈ 94, insets.top 0 → 288. Six rows, scrolls.
  Every 3-cap recipe, portrait    : total 388 → NO SCROLL AT ALL. The common case never
                                     touches the mechanism.

WHY SECTIONS ARE FLAT AND NOT A SECOND LEVEL. The candidate originally proposed "top six plus
a More commands row". That is dropped. Nielsen's progressive-disclosure limit ("beyond 2
disclosure levels typically have low usability") permits it, but the ⋯ tap is already level
one, so "More commands" would be level three counting from the terminal, and NN/g's hidden-
navigation numbers apply to every level you hide behind. Twelve rows in a scroll is one level,
and it is what BarMenu already is. Skipped: the second level. Add it if a future recipe editor
lets users define recipes with more than about fifteen rows.

WHY SECTION HEADERS ARE OPAQUE BANDS. The agent recipe is at Apple's stated context-menu
ceiling ("no more than about three groups"), and Kurtenbach & Buxton put reliable breadth at 8.
Twelve rows is over the flat limit, so the chunking has to be doing real work — `theme.surface`
bands at 28pt are visible chunk boundaries at a glance, where the old 9.5pt bare text with a
`crust@0.9` shadow was not. Three visible chunks of 1 / 6 / 3 rows sit inside the well-supported
range even though the total does not.

THE ONE THING THAT DOES NOT SCALE, stated honestly: at 12 rows the recipe pushes Upload and
Settings below the fold, so the ⋯ menu's own original contents become a flick away while an
agent is running. That is the correct priority — the recipe is why you opened it — but it is a
real cost, and it is the argument for eventually giving the recipe section a `stickyHeaderIndices`
header so its identity stays pinned while you scroll past it.

## Accessibility

The repo has ZERO accessibility code today — no `accessibilityLabel`, no `accessibilityRole`, no
`AccessibilityInfo`, no `useReducedMotion` anywhere in src/. Everything below is greenfield, and
all of it is small because the design reuses controls rather than inventing surfaces.

VOICEOVER / TALKBACK ORDER AND LABELS
  ⋯ circle (keybar.tsx:741):
    `accessibilityRole="button"`
    `accessibilityLabel={recipe ? `${recipe.proc} actions` : 'More'}`
    `accessibilityHint="Opens the menu"`
    `accessibilityState={{ expanded: open === 'menu', disabled: sending && recipe == null }}`
    The label is the whole discoverability story for a screen-reader user, and it is strictly
    better than the old 5pt tab, which had no label, no role, and a 46×64 rect a rotor swipe
    would announce as nothing at all.

  SELF-APPEARING CONTENT MUST BE ANNOUNCED. On the effect that fires the nudge, once per
  `ribbonCore.instance`:
    `AccessibilityInfo.announceForAccessibility(`${recipe.proc} actions available`)`
  This is a polite announcement, not a focus change — it never steals focus from whatever the
  user is reading. Gate it on `AccessibilityInfo.isScreenReaderEnabled()` being true so the
  string is not built on every process start otherwise.

  Menu container (the `styles.menuPop` Animated.View):
    `accessibilityViewIsModal={true}` (iOS) so the rotor does not wander into the terminal
    behind the scrim. Android has no equivalent prop on RN; accepted, and Back closes the menu
    anyway.

  Recipe header row: `accessibilityRole="header"`,
    `accessibilityLabel={`${proc}, running ${formatElapsed(...)}`}` (or `${proc}, stopped`).
    The live timer is read on demand rather than announced — no `accessibilityLiveRegion`,
    because a per-second announcement is exactly the "distracting or invasive" failure.

  Section header rows: `accessibilityRole="header"`, label = the header text.

  Cap rows: `accessibilityRole="button"`,
    `accessibilityLabel = [danger && 'Destructive', label, caption].filter(Boolean).join(', ')`
      → "Destructive, kill, force" · "slash context" · "shift tab, plan mode"
    Armed cap: label becomes `${label}, tap again to confirm`, and
      `accessibilityHint="Sends control C a second time"`.
    Busy attach cap: `accessibilityState={{ disabled: true }}`, label suffix ", sending".

  Upload / Settings rows: `accessibilityRole="button"`, labels as written.

REDUCE MOTION (`useReducedMotion()` from react-native-reanimated)
  • The nudge is not started. The fill + glyph change carries the full signal — the design
    degrades to a *quieter* version of itself, not to nothing. Contrast with the shipped
    handle, where Reanimated's default of disabling `withRepeat` under Reduce Motion leaves a
    static, invisible 5pt bar: a live a11y bug this change deletes.
  • `FadeInDown`/`FadeOutDown` on the menu swap to `FadeIn`/`FadeOut` (same 180ms opacity, no
    10pt translation). Layout animations are not auto-stripped.
  • Nothing else moves. There are no springs, no scale, no blur-in (HIG Motion: "avoid
    animating into and out of blurs"), and no repeated animation anywhere in the design.

REDUCE TRANSPARENCY
  Nothing to do — the menu plate is opaque `theme.panel` with no BlurView, so the Reduce
  Transparency variant IS the default variant. The scrim is a flat colour, not a material.
  (Research finding applied directly: the Reduce Transparency version of a control over a
  terminal is the better default, and translucency belongs only in the small resting state,
  which here is a 49pt disc on the bar's existing glass.)

DYNAMIC TYPE
  Honest position: this app pins its type — the terminal renders at a user-set cell size and
  every chrome number in the repo is a literal. This design does not change that, and does not
  claim Dynamic Type support. What it DOES do is make the rows tolerant: `minHeight: 44` with
  `justifyContent: 'center'` and `paddingVertical: 0` means a row grows rather than clips if the
  system scales the 15pt label, and captions carry `numberOfLines={1}` so a long caption
  truncates instead of pushing the label out of the 252pt content box. Skipped: a real
  `allowFontScaling` audit. Add it when the app takes on Dynamic Type as a whole, not for one
  menu.

COLOUR-BLIND SAFETY (WCAG 1.4.1, "more than colour alone")
  • Recipe identity: the fill colour is PAIRED with a distinct symbol in every case
    (`bolt.fill` / `pause.fill` / `</>` / `doc.plaintext.fill` / `chart.bar.fill` / `sparkles`),
    and with the process name in text once the menu is open. Colour is never load-bearing.
    This matters specifically for `running` (green) vs `agent` (peach) and for `vim` (mauve) vs
    `pager` (blue), which are the two pairs a deuteranope or tritanope could confuse.
  • Destructive: red fill PLUS an `exclamationmark.triangle.fill` glyph PLUS the inverted ink
    (the row is the only one on the surface whose text is lighter-on-darker in reverse). Three
    independent codes.
  • Liveness: the ticking `m:ss` numeral, not a pulsing dot.

TOUCH TARGETS (Parhi et al. ≥9.6mm one-handed; HIG 44pt default)
  ⋯ circle 49×49 (≈10.4mm) · every menu row `minHeight: 44` × 252 wide (≈9.7mm × 56mm) ·
  Upload and Settings rows raised from ~42.5 to 44 as part of the same change. Nothing in the
  design is under 44pt in either axis. The 5pt × 46pt tab — 29.9% error territory at 3.8mm per
  Parhi, and below even HIG's 28pt absolute floor in one axis — is deleted.

ANDROID SPECIFICS
  Hardware Back closes the menu via the existing `open !== 'none'` rung (terminal.tsx:1244).
  Nothing auto-hides, so the M3 rule that floating-toolbar hide-on-scroll must be disabled under
  an active accessibility service has no analogue to violate here.

## Edge cases

- RECIPE CHANGES WHILE THE MENU IS OPEN — the dangerous one. If `^C ^C quit` is under the thumb and the rows shift, the tap lands on `/clear`. Fix, two lines in BarMenu: `useEffect(() => { if (mounted.current) onClose(); }, [recipe?.id ?? 'none'])` — the menu closes whenever the recipe IDENTITY changes, including agent→null when the process exits. A change of `proc`/`instance` within the same id (one npm build replaced by another) only resets `armed` and re-renders the same cap list, which is safe because the rows are identical. This replaces terminal.tsx:1606's blanket `setRbOpen(false)` on every instance change, which was heavier than it needed to be.
- PROCESS EXITS WHILE OPEN — covered by the same effect: `recipe?.id` goes from e.g. 'agent' to 'none', the menu closes. The alternative (shrinking the menu in place and letting Upload slide up under the finger) is the same mistap class, so closing is correct even though it is briefly surprising. The ⋯ circle simultaneously reverts to plain glass + `ellipsis`.
- KEYBOARD RISES OR FALLS WHILE OPEN — `bottom = popBase` recomputes and the menu JUMPS to the new baseline in one React commit; it does not animate, and `maxBodyH` re-clamps at the same time so it never ends up under the keyboard. This is exactly what all four existing popovers do today, so it is not a new behaviour to learn. Note the common case does not arise: the caps that raise the keyboard (`focus: true` — vim `/`, pager `/`, htop `/`) close the menu on the same tap, so the keyboard rises into an empty screen. Every floating design had to ride `imeAnimationSource→imeAnimationTarget` to survive this; this one has nothing to keep in sync.
- WINDOW SWITCH MID-OPEN — impossible to start. The bar's pan lives behind the popover layer's dismiss Pressable while the menu is open, so a horizontal drag on the bar closes the menu instead of hopping. Identical to today's popover contract. After the hop, `ribbonForWindow(win)` (terminal.tsx:1611) still sets the recipe at the commit, so the ⋯ circle changes colour and glyph WITH the slide rather than a poll beat later — that call site is unchanged and must be kept.
- SWITCHER ZOOM STARTS WHILE THE RECIPE IS SHOWING — the ⋯ circle is inside the bar wrapper that already carries `barFadeStyle` (`opacity: 1 - min(prog/0.25, 1)`), so the cue leaves with the bar at the start of the flight for free. The old ribbon handle needed its own layer explicitly sharing that style to avoid hanging in the air; that layer is deleted.
- UPLOAD IN FLIGHT — `sending` outranks the recipe on the circle: accent fill, `ellipsis`, glyph in `theme.background`, exactly §4.6. But the TAP is no longer disabled when a recipe is active (`onPress = sending && recipe == null ? undefined : toggle('menu')`), so `/clear` stays reachable during a transfer; inside the menu the attach cap alone carries the inert accent treatment and the `sending…` caption. Without this one-line change an upload would make the whole recipe unreachable — a regression against the edge handle.
- LANDSCAPE — `insets.top` goes to ~0 and `stage.h` to ~390, so `maxBodyH` lands near 288 and the body scrolls from about six rows. The `Math.max(160, …)` floor means the menu is never shorter than about three rows plus its header even on a small landscape window; it can then overlap the notch band, which is accepted (a transient menu may, a persistent surface may not).
- ANDROID — no blur anywhere already, so the opaque plate is a no-op visually; re-add `boxShadow: '0 1px 3px rgba(0,0,0,0.45)'` to the plate, which is what `Glass`'s Android branch was providing and what the plate now replaces. `SIDE_MARGIN` 8 and `BAR_RADIUS` 16 flow through unchanged. `SymbolView` renders its `Text` fallback everywhere (MONO carries the Nerd Font glyphs). Back is already wired. `accessibilityViewIsModal` is iOS-only and simply does not apply. AND: the whole class of Android edge-gesture collisions disappears, because the design binds no gesture at either edge — no `systemGestureExclusion` rects, no predictive-back arbitration, no 200dp-per-edge exclusion budget to spend.
- REDUCE MOTION + A NEW PROCESS — the nudge never starts and the fill/glyph swap is the entire arrival. Verify on device that the swap alone is noticed; if it is not, the evidenced next lever is a single 400ms `theme.foreground` ring flash on the circle (one abrupt change, still finite, still not a repeat), NOT a return to a loop.
- TOUCH DOWN DURING DETECTION — the nudge is suppressed when `panSV.dragging.value === 1` or a popover is already open. It does not re-arm afterwards; the persistent fill is the cue. Bailey & Konstan's boundary-deferral result argues for holding the announcement until a quiet moment rather than replaying it at a random one.
- VOICEOVER RUNNING WHEN A RECIPE ARRIVES — one polite `announceForAccessibility`, no focus steal, no repeat. If the screen reader is off the string is never built.
- TWO POPOVERS AT ONCE — impossible. `BarPopover` is a single-valued union, so opening the menu closes arrows/clipboard/hint and vice versa, at no cost. Same for the switcher: `openSwitcher` already calls `setOpen('none')` (terminal.tsx:919).
- `[ribbon] …` LOG LINES THAT TESTS.md T11 ASSERTS ON — `[ribbon] cap <label>` is unchanged in `onRibbonCap`; `[ribbon] kill-force: …` is unchanged; `[ribbon] open <proc>` must now be emitted where the menu opens, i.e. in terminal.tsx's `onOpenChange` when the next value is `'menu'` and `recipe !== null`. T11.9 and T11.14 name gestures (swipe to open/close) that this design deletes — those two cases need rewriting to 'tap ⋯', and T11.14's zero-reflow assertion becomes true by construction rather than by measurement.

## Implementation

FILES, IN DIFF ORDER. Net change is negative: roughly +200 lines in keybar.tsx, −45 in
terminal.tsx, −304 from a deleted file.

────────────────────────────────────────────────────────────────────────────
1. src/ribbon.tsx — DELETE THE FILE (304 lines).
   `RibbonHandle`, `RibbonPanel`, the breath, the dot pulse, the two swipe `Gesture.Pan`s, the
   capsule/label/stub styles, the local `rgba` copy, `SWIPE_PX`. `ARM_MS = 2800` moves to
   keybar.tsx.
   UNTOUCHED, and this is the point: `src/ribbon-model.ts` (196 tested lines), the
   `src/ribbon-model.test.ts` suite, `src/ribbon-recipes.ts` (`Cap`, `Recipe`, `RECIPES`,
   `REPL_NAMES`) and `onRibbonCap`. This is a rendering change only; zero model edits.

────────────────────────────────────────────────────────────────────────────
2. src/keybar.tsx — all the new code lives here, next to what it reuses.

   2a. Near `rgba()` (line 212): add `lum()` and `inkOn()` (5 lines, see `anatomy`), and
       `const ARM_MS = 2800;`.

   2b. `KeyBarProps` gains ONE prop:
       ```ts
       /** T11: the detected recipe, or null. The ⋯ circle IS the ribbon now — it takes the
        *  recipe's identity colour and symbol, and its menu carries the caps. `instance` is
        *  the reason a poll that re-detects the same process does not re-announce. */
       recipe?: { id: RecipeId; proc: string; dot: DotName; instance: number } | null;
       ```
       (`dot` is denormalised into the prop so KeyBar does not import RECIPES for one lookup.)

   2c. The ⋯ circle block (keybar.tsx:741-778). Wrap the `Glass` in
       `<Animated.View style={nudgeStyle}>`; add the fill `View` and the symbol/tint switch per
       `anatomy` §A; change `onPress` per `interaction`; add the four accessibility props.
       The `useSharedValue` / `useReducedMotion` / `useEffect` / `useAnimatedStyle` block for
       the nudge goes with the component's other hooks. `Easing` is a new import from
       react-native-reanimated; `useReducedMotion` likewise.
       The `memo()` on `KeyBarInner` (line 912) keeps working because `recipe` is passed as a
       memoised object (see 3b) — pass it raw and the bar re-renders on every 2s poll.

   2d. `BarMenu` (keybar.tsx:1067). Signature becomes:
       ```ts
       export function BarMenu({ theme, bottom, maxBodyH, recipe, startedAt, busy,
                                 onCap, onClose, onUpload, onOpenSettings }: {...})
       ```
       Body:
         • `const [armed, setArmed] = useState(false)` + an `armTimer` ref + the 2800ms
           `setTimeout` — lifted verbatim from ribbon.tsx:140-153, including its cleanup effect.
         • `const [, setBeat] = useState(0)` + a 1s `setInterval` when `recipe?.id === 'running'`
           — lifted verbatim from ribbon.tsx:116-121. It only runs while the menu is mounted,
           which is strictly less often than the old panel's.
         • `useEffect(() => { if (mounted.current) onClose(); }, [recipe?.id ?? 'none'])`.
         • Replace `<Glass radius={26}>` with the ring wrapper + opaque plate (anatomy §B1/B2).
         • Wrap everything in a `ScrollView style={{maxHeight: maxBodyH}}`.
         • Prepend the recipe header row and `recipe && RECIPES[recipe.id].caps.map(capRow)`.
           `capRow` is ~40 lines and is a direct port of ribbon.tsx:165-216 with the capsule
           geometry replaced by the list-row geometry of `anatomy` §B6-B10.
         • `styles.menuRow` gains `minHeight: 44, justifyContent: 'center', paddingVertical: 0`;
           `styles.menuHeader` colour moves to `theme.foreground` at the call site.
         • Import `RECIPES`, `type Cap`, `type RecipeId` from '@/ribbon-recipes' and
           `formatElapsed` from '@/ribbon-model'. keybar.tsx does not import these today; both
           are leaf modules with no cycle back to keybar.
         • `entering`/`exiting` both `.duration(180)`.

────────────────────────────────────────────────────────────────────────────
3. src/app/terminal.tsx

   3a. DELETE: the `import { RibbonHandle, RibbonPanel } from '@/ribbon'` (line 54); the
       `rbOpen` state and its `useEffect` (1592, 1606); the two mount blocks at 2360-2386
       (handle layer + panel), including the `maxCapsHeight` expression at 2382.

   3b. ADD, beside the existing `recipe` derivation (line 1618):
       ```ts
       const recipeProp = useMemo(
         () => (recipe === null ? null
             : { ...recipe, dot: RECIPES[recipe.id].dot, instance: ribbonCore.instance }),
         [recipe?.id, recipe?.proc, ribbonCore.instance],
       );
       const maxBodyH = Math.max(160, (stage?.h ?? 600) - popBase - insets.top - 8);
       ```
       and, in the same file, the announce effect:
       ```ts
       useEffect(() => {
         if (recipe === null) return;
         console.log('[ribbon] detect', recipe.proc);
         void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
           if (on) AccessibilityInfo.announceForAccessibility(`${recipe.proc} actions available`);
         });
       }, [ribbonCore.instance]);
       ```

   3c. `onOpenChange={setOpen}` (line 2331) becomes a stable trampoline that keeps T11's log:
       ```ts
       const kb_onOpenChange = useCallback((next: BarPopover) => { ... }, []);
       // inside: if (next === 'menu' && recipeRef.current) console.log('[ribbon] open', proc);
       //         setOpen(next);
       ```
       (Through the existing `kbH` ref trampoline pattern so `memo(KeyBar)` still bites.)

   3d. `<KeyBar … recipe={recipeProp} />`.

   3e. The popover layer (2395-2428): add the scrim as the first child, then pass the new props
       to `BarMenu`:
       ```tsx
       {open === 'menu' && recipeProp !== null && (
         <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(180)}
           pointerEvents="none"
           style={[StyleSheet.absoluteFill, { backgroundColor: rgba(theme.scrim, 0.32) }]} />
       )}
       <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen('none')} />
       … <BarMenu theme={theme} bottom={popBase} maxBodyH={maxBodyH} recipe={recipeProp}
                  startedAt={ribbonCore.startedAt} busy={sending} onCap={onRibbonCap}
                  onClose={() => setOpen('none')} onUpload={…} onOpenSettings={…} />
       ```

────────────────────────────────────────────────────────────────────────────
COMPONENT TREE, open, agent recipe

  terminal.tsx
   └ popover layer  View absoluteFill
      ├ Animated.View  scrim  rgba(theme.scrim, .32)          [FadeIn 180]
      ├ Pressable absoluteFill                                 → setOpen('none')
      └ BarMenu  Animated.View {position:absolute, left:24, width:256, bottom:popBase}
         └ View  ring   r27 · 1pt theme.background
            └ View plate r26 · 1pt theme.foreground · bg theme.panel · overflow hidden
               └ ScrollView {maxHeight: maxBodyH}
                  ├ View        recipe header  34   dot + proc + m:ss
                  ├ View        SESSION        28
                  ├ Pressable   ^C ^C quit     44   filled danger, arms
                  ├ View        COMMANDS       28
                  ├ Pressable   /clear …       44 × 6
                  ├ View        NOW            28
                  ├ Pressable   📎 ⇧⇥ ⎋        44 × 3
                  ├ View        menuBreak       6
                  ├ Text        UPLOAD FILE    30
                  ├ Pressable   Files/Photo/Camera 44 × 3
                  ├ View        menuBreak       6
                  └ Pressable   Settings       44

WHAT RUNS ON THE UI THREAD
  Exactly one worklet: the nudge's `useAnimatedStyle` reading one shared value and writing one
  `translateX`. It reads `panSV.dragging.value` once, in a JS effect, as a guard. Nothing else
  in this design is animated per-frame, nothing follows a finger, and no `Gesture` object is
  constructed — so none of the recorded hazards apply: no un-memoised gesture re-serialising
  worklets mid-gesture, no worklet closing over a shared value nested in a prop object, no
  React commit racing a worklet by a frame or two.

PRE-MOUNTING / BUILD COST
  The bar's `Glass` under the ⋯ circle stays mounted in every state, so a detection never
  builds a subtree (the recorded "building a subtree on a gesture's first frame is the hitch"
  rule). The menu itself is built on the tap, which is where every popover in this app already
  pays, and it is now CHEAPER than before: one fewer BlurView, because the plate is opaque.

TESTS
  `src/ribbon-model.test.ts` passes unchanged — nothing it covers moved. The one runnable check
  worth adding is a pure assertion beside `inkOn`, since it is the only new branching logic:
  `assert(inkOn(mocha, mocha.dots.green) === mocha.background)` and
  `assert(inkOn(latte, latte.dots.grey) !== latte.background)` over all 26 themes, asserting the
  returned ink differs from the fill by more than 3:1 in every case. One `it()` in a new
  `src/keybar-ink.test.ts`, ~15 lines.
  TESTS.md §T11.9 and §T11.14 need rewriting: the gestures they name no longer exist, and the
  zero-reflow rule they assert is now structural.

## Cost

Roughly half a day, and most of it is deletion. src/ribbon.tsx (304 lines) goes away whole;
terminal.tsx loses ~45 lines of mounting, state and clamp arithmetic; keybar.tsx gains ~200,
of which ~60 are ported verbatim from the file being deleted (the arm timer, the 1s beat, the
cap-tap dispatch). Zero new dependencies, zero new gesture recognisers, zero new animated
surfaces, zero new BackHandler rungs, zero changes to ribbon-model.ts / ribbon-recipes.ts /
onRibbonCap, and no reflow risk at all because nothing enters `paneInsets`.

RISKIEST PART: the ⋯ circle now has three mutually exclusive paint states (plain glass /
recipe fill / upload fill) on the single most-tapped control in the app, and it also carries a
transform. A wrong precedence there is a visible bug on every screen, on every theme, all day —
far more exposure than the old edge handle ever had. Get `sending` ranked above `recipe` and
verify the fill's own `borderRadius` on device (an absolutely-filled child squares off the
circle inside a clip — the failure is already documented at keybar.tsx:752, and this design
adds a second instance of exactly that construction).

SECOND RISK, cheaper but real: the plate swap changes the ⋯ menu's appearance for the existing
Upload and Settings rows too — glass becomes opaque `theme.panel` on iOS. That is a deliberate
visual change to a shipped surface, made for the reason fd4e8f2 already recorded, but it should
be looked at on both a Mocha and a Latte device before it is called done.

## Trade-offs

- IT COSTS A TAP. Every cap is one tap further away than in any floating design. NN/g's numbers on hidden versus visible navigation put mobile task time 15–39% higher and discoverability 20%+ lower when items live behind an affordance. The combo condition — which is what this is, since the recipe section is the first thing in the menu with no scroll and no second level — matched fully-visible on nearly every measure, but 'matched on nearly every measure' is not 'free'. This is the deliberate trade and it should be measured on device, not assumed.
- THE LIVE TIMER IS ONLY VISIBLE WITH THE MENU OPEN. At rest, a running job and a suspended one are told apart by fill colour (green vs grey) and glyph (bolt vs pause) but not by elapsed time — the single strongest liveness signal is behind a tap. The Live Activities precedent argues for showing live DATA in the compact state, and this design cannot: a 49pt circle has no room for '2:41'. Mitigation is the glyph pairing, which satisfies WCAG 1.4.1 but does not restore the information.
- IT IS THE QUIETEST OF THE CANDIDATES AT THE INSTANT OF DETECTION, and that is the hypothesis being tested. The judges' fixes push it as far as it can honestly go without adding a surface — shape and fill instead of hue, a symbol instead of a memory comparison, three cycles of linear oscillation instead of nothing — but a 49pt disc changing colour at the bottom of the screen is still a change to an EXISTING object, which is the textbook change-blindness stimulus, and a scrolling pane supplies masking transients continuously. Yantis & Jonides say no amplitude would fix that anyway; the bet is on the user's next glance, not on capture. If the user reports they still do not notice it, the failure is informative: it means the cue must be at the terminal's gaze point, not at the chrome, and every remaining design in the set is a variation on that.
- THE MENU BECOMES A MIXED BAG. Recipe caps, then file upload, then settings — three unrelated groups in one surface, right at HIG Context Menus' stated three-group ceiling and arguably past its spirit. With the 12-cap agent recipe, Upload and Settings are pushed below the fold, so the menu's ORIGINAL contents become the thing you have to scroll for. That inversion is correct by priority and wrong by information architecture.
- THE ANCHOR IS ON THE WRONG SIDE FOR A RIGHT THUMB. The ⋯ circle sits at the bar's LEFT edge, so the menu grows up the left of the screen — about 250pt of reach across the phone for the 49% of users Hoober observed holding one-handed, two thirds of them right-thumbed. Parhi et al.'s finding that right-edge targets should extend to the edge is simply forgone. The compensations are that the anchor NEVER MOVES (Adobe's documented Contextual Task Bar complaint is self-repositioning, not distance), that every row is 252pt wide so the horizontal aim is trivial, and that the rows sit in the middle-to-bottom band HIG names as comfortable. Mirroring for left-handers is not offered and would not help right-handers.
- IT ARGUABLY ANSWERS A DIFFERENT QUESTION THAN THE ONE ASKED. The brief is 'a contextual action menu that appears when a process is detected'. This proposes that it should not appear — that detection should change a control, not add a surface. That is a direct challenge to the premise, and it may be the wrong product answer even though it is by a wide margin the cheapest engineering one and the only one with no reflow risk, no gesture conflict, no keyboard-desync surface and no Android edge-gesture problem.
- AN IDENTITY RING ON AN EXISTING CONTROL IS ADJACENT TO BADGE MIMICRY. HIG Notifications forbids a custom component that mimics a badge, and the defence here is that the control changes its OWN identity — fill and glyph, no pip beside it — which is Safari's exact behaviour. It is a defensible line but it is a line, and a reviewer could reasonably read a coloured disc on a bar button as a status indicator by another name.
- GLASS SURVIVES BUT ITS ONLY REMAINING CONSUMERS ARE THE BAR AND THREE POPOVERS. Dropping it from BarMenu means the app now has two floating-surface treatments — blurred glass for arrows/hint/clipboard, opaque panel for the menu — where it had one. That is an honest inconsistency, introduced because only one of those surfaces is tall enough for the terminal behind it to matter. The tidy version is to move all four onto the opaque plate; that is a bigger change than this design needs and is deliberately not proposed here.

---

## Verification pass (adversarial)

**Survives: yes**

Survives, and it is by a distance the cheapest and the least risky: no new gesture, no new layer, no new BackHandler rung, no edge-gesture collision on either platform, and zero occlusion of the pane at rest. Its factual errors are two — the inkOn inversion and the Safari precedent overstatement — and both are small. What it cannot promise is that the cue will be noticed, which is the one thing the user actually complained about first.

### Corrections — these override the body above

- The `inkOn` helper picks the WRONG colour in the exact case it was written for. On Latte, dots.grey = overlay0 #9ca0b0; with the spec's non-linearised byte luma, lum(dot)=160.3, lum(background)=240.9, lum(foreground)=80.3, so |160−241| = 81 > |160−80| = 80 and it returns `theme.background` — the 2.3:1 option — by a margin of one unit. Either linearise properly and compare WCAG ratios, or (lazier and correct) drop the helper and always use `theme.background`/`theme.foreground` by `theme.isDark`, accepting that Latte's grey dot is the one weak glyph and picking a different dot for `suspended` there. A five-line heuristic that inverts on its own motivating example is worse than no heuristic.

- Same wrong Reduce Motion claim as the other two ("leaves a static, invisible 5pt bar"). Verified false in node_modules; the handle resolves to opacity 0.95.

- The Safari Reader precedent is not quite what is claimed. On iOS 18 Safari shows the words **"Reader Available"** in the address field when the detector fires — a text label added to existing chrome, not a fill-and-glyph state change on the menu button; on macOS Safari the affordance appears as a NEW button in the address bar. So the real precedent argues for a *worded* cue in existing chrome, which is arguably a point in this design's favour but not the mechanism the spec describes. The claim "NO new chrome appears" is the weaker reading of the two platforms.

- Self-contradiction on Apple HIG Popovers. The spec cites "Avoid displaying popovers in compact views… use a full-screen modal view like a sheet instead" as a standing argument against attempt B, then specs an 810pt-tall menu clamped to `maxBodyH` = 689 on a 390×844 phone — i.e. a popover occupying 82% of a compact view. By its own citation that should be a sheet.

- `ARM_MS` is described as "moved verbatim from ribbon.tsx:36" — correct (it is 2800 there) — but `SWIPE_PX` at :34 and the two `Gesture.Pan`s go away with the file, which the spec says; just note that TESTS.md T11.9/T11.14 assert on those gestures and the spec correctly flags the rewrite.

- Verified TRUE and load-bearing: the ⋯ circle really is disabled during an upload (`<Key onPress={props.sending ? undefined : () => toggle('menu')}>`, keybar.tsx ~740) so the one-line fix to keep `/clear` reachable is a genuine regression-preventer; the "absolutely-filled child squares off the circle" hazard is already commented at the exact construction the spec reuses; `menuRow` really is `paddingVertical: 12` ≈ 42pt, under 44; `menuPop` really is `left: SIDE_MARGIN, width: 256`; `menuHeader` really is `theme.muted`; the Android BackHandler ladder already has the `open !== 'none'` rung (app/terminal.tsx ~1244) so this design alone adds no rung; `Glass` on Android caps radius at 20, so the new 26/27 plate is a deliberate Android visual change worth calling out.

- One collision the spec doesn't mention: the ⋯ circle sits inside the GestureDetector that owns the whole bar row, and that Pan cancels children's touches once |dx|>10 or |dy|>10. That is already true for the ⋯ tap, so nothing breaks — but it means the *only* door to the ribbon is a tap that the bar's pan can steal, and there is no second door (the spec deliberately drops the terminal long-press). Worth stating as an accepted cost rather than leaving it implied.


### Constraints the spec left unaddressed

- Constraint 4, thumb reach: the anchor is the bar's LEFT circle (`SIDE_MARGIN` = 24 on iOS), so the cue and the menu live on the far side from a right thumb. The spec admits this honestly; it remains unaddressed, and "the rows are 252pt wide" only fixes aim, not travel.

- Constraint 2, "noticeable": this is the quietest cue of the three by a wide margin, and the spec knows it. A 49pt disc changing fill at the bottom of the screen, on a control the eye has already learned to ignore, against a scrolling pane full of masking transients, is the textbook change-blindness stimulus — its own Yantis & Jonides citation says no amplitude fixes that.

- Constraint 5, scale: 12 caps are handled by making the menu 810pt tall, which pushes Upload and Settings — the menu's original contents — below the fold whenever an agent is running. That is an IA inversion the spec names but does not solve.
