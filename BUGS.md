# Open bugs

> **Session of 2026-08-17 — Android only; NOTHING here has been walked on the iPhone.** Four
> emulator walks. Fixed and Android-verified: bugs 1+2 (search mark, 30/30 taps after two failed
> attempts), 3, 4, 6, the key bar's landing frame, exec/kill by stale `@id`, the `MaxSessions`
> fan-out, `selectWindow`'s unhandled rejection, the ribbon on birth, the ribbon's `running` chip,
> and the grid's dead bottom bar. Closed as not reproducible (user): bug 5 and the grid tap — the
> speculative fixes for both were written and withdrawn unshipped. Still open below: the addon's
> grey matches decaying under tmux, and the two residuals at the end. Per AGENTS.md the iOS half is
> a finding, not a footnote: every fix in this session is unverified there.

Found on device during the T-perf accept walk (2026-08-15). Everything here is reproducible on a
real phone against a live tmux session; where a cause was in doubt it was settled by checking out
`fa4cb78` (the commit before the perf work), reloading, and reproducing the fault with the changes
absent. Everything settled that way is pre-existing — bug 5 is the one item still suspected of being
a regression from the performance branch, and it names the experiment that would confirm it.

Fixed and confirmed the same session, for context on what is *not* in this list: `less` refusing to
scroll (root-table wheel bindings missing from the pushed tmux conf), and the grid's tabs vanishing
and refilling while typing a query (`windowSurvives` treated "grep still in flight" as "no match").

Also gone, walked on device 2026-08-15: **the search view keeping the zoom's chrome after leaving
the grid** — the pane's rounded corners under the search bar and the key bar parked at its
keyboard-up position over dead space. Neither was leftover zoom state. The corner is what
`pageRadius` always returns (its "0 at rest" wording is the stale part); an armed search row simply
pushes the page below the notch, where a 60pt corner is in plain sight — so the top corners now
square while the row is up, the mirror of `kbSquare`. The key bar was `syncPad` reading
`Keyboard.metrics()`, which is the last frame the keyboard was *shown* at, not where it is: RN
clears `_currentlyShowing` only on `keyboardDidHide`, at the END of the hide, so a reconcile landing
mid-hide wrote the departing keyboard's overlap back — with nothing left to correct it, because the
hide's own `keyboardWillChangeFrame` was the event the zoom's freeze dropped. A `keyboardDidHide`
listener under the same freeze now closes it: the end of a hide is unambiguous. `finishClose` also
stopped making an exception of an armed search: the keys come back exactly as they were before the
grid (user, overruling T14).

---

## 1. Search does not scroll to the current hit

**Repro.** Arm the terminal search, type a query with matches off-screen, tap `∨`.

**Symptom.** The counter advances (`1/27` → `2/27`) but the viewport does not move to the match.

**What is already known.** The addon is being driven correctly — this is not a wiring fault:

```
[search] step next "sctp" occ {"i":0,"n":4}
[search] findNext "sctp" found true activeDecorations 1
[search] results i 1 n 4
```

`findNext` returns `true`, the index advances and wraps correctly, and the addon reports one active
decoration. In `@xterm/addon-search` 0.16.0 the scroll is done by `_selectResult`
(`SearchAddon.ts`), which scrolls only when `noScroll` is falsy — and the app passes no
`internalSearchOptions` at all from `handle.searchNext`, so `noScroll` is `undefined` and it should
scroll. Worth checking next whether `_selectResult` is reaching its scroll branch, and whether
`terminal.select()` is landing, since bug 2 suggests the active decoration's element may never be
rendered at all. **These two are probably one bug.**

---

## 2. No distinct highlight on the current hit

**Repro.** As above. Every match draws the same flat grey; the current one is not distinguishable.

**What is already known.**

- The active decoration object *is* created — the probe reports `activeDecorations 1` on every
  press.
- The colours passed are correct and very far apart: `matchBackground` `#313244` (surface0, dark
  grey) against `activeMatchBackground` `#f9e2af` (yellow).
- Nothing in this app's CSS targets `.xterm-find-*`, `outline`, or decoration z-index.
- `activeMatchBorder: #f9e2af` was tried, so the active hit would draw an outline instead of
  relying on a background that an overlapping decoration can cover. It made **no difference**, and
  that is the informative result: an outline is painted outside the box, so the element cannot
  merely be covered — it is not rendering at all. The option was reverted rather than left in as
  config that does nothing; a comment in `searchOptions()` points here.

**Upstream bug found while chasing this** — worth reporting to xterm.js, and worth knowing about
regardless. `DecorationManager.ts:147`, `@xterm/addon-search` 0.16.0:

```js
decoration.onRender((e) => this._applyStyles(e, isActiveResult ? options.activeMatchBorder : options.matchBorder, false))
//                                                                                            ^^^^^ hardcoded
```

The third parameter of `_applyStyles` is `isActiveResult`, and it is always passed `false`. So
`element.classList.add('xterm-find-active-result-decoration')` is unreachable and that class — plus
any CSS hung off it — is dead in this version. Only the background and the border reach the active
match, both via `registerDecoration`.

**Next step.** Stop depending on the addon's active decoration. The app already receives the hit
index through `onDidChangeResults`, and `SearchEngine` returns a `{col, row, size}` for the match;
marking the current hit ourselves (our own decoration, or a rendered overlay) removes both this bug
and, probably, bug 1. The alternative is vendoring `SearchAddon`.

**FIXED, Android-verified 2026-08-17 (walks 3-4: yellow on 30 of 30 taps, keyboard up and down,
stable at +3s and +6s).** It took two attempts; both are written up here because the first was
sound reasoning that still failed on glass.** `markHit` in `src/terminal.tsx` marks the hit itself and scrolls to it. Three
causes, all in xterm and none of them the colours — read out of the renderer rather than guessed.
The first two are why the addon's own active decoration is invisible:

- `DomRendererRowFactory` lets the LAST decoration at a cell win, and `SortedList._flushInserted`
  puts a newly inserted value AHEAD of the ones already at that line — so the grey match,
  registered first, is applied last and paints over the addon's yellow. Then the *selection*
  overwrites the survivor anyway (`_selectResult` goes to a hit via `term.select()`), and the
  selection colour here is `theme.selection` — the same grey. `layer: 'top'` beats both, whatever
  the insertion order; the addon exposes no way to ask for it.
- The decoration ELEMENT, where `activeMatchBorder`'s outline and the `xterm-find-*` classes live,
  is `display:none` while the alt buffer is active (`BufferDecorationRenderer._refreshStyle`) —
  under tmux, always. That, not the `isActiveResult` hardcode above, is why the border experiment
  changed nothing: only a decoration's *background* reaches the screen there, because the row
  factory paints it into the cells.
- **And a `layer: 'top'` decoration of our own is not enough either — that is what the failed walk
  found.** 22 taps of `∨` with the keyboard up put yellow on screen 9 times; 8 taps with the
  keyboard down, none. Not a capture race and not a flicker: 8 back-to-back screencaps after one
  failing tap, and again at +3s and +6s, all with zero yellow fill pixels. Binary per tap and
  permanent. The log was right every time (`marked 1`, never `marked 0`), so the decoration was
  always built. The tell is the second symptom: on the failing frames **most of the addon's GREY
  matches were gone too** — 20 results, 2 rows still carrying any decoration at all.

  **A decoration cannot outlive its marker, and tmux's redraw kills markers.**
  `DecorationService.registerDecoration` hangs `marker.onDispose → decoration.dispose()` on every
  decoration it makes, and `Buffer` disposes markers on two things tmux does constantly:
  `clearMarkers(ybase + y)` from `InputHandler._resetBufferLine` — every `CSI K` / `CSI J`, which
  is how a pane repaints a row — and `lines.onDelete`, any scroll of a DECSTBM region. So the mark
  dies the moment the host repaints the row under it, which is a coin flip inside the fraction of a
  second between the tap and the screenshot.

  The greys prove it on their own: the addon builds them once (`_highlightAllMatches` runs only
  when the term or the options change) and this file has stubbed out `_updateMatches`, the one
  thing that ever rebuilt them — so nothing *but* marker death can take them off the screen, and
  they demonstrably came off it. Markers on a tmux-driven buffer are structurally unreliable, and
  re-registering the mark would be a race against a stream that erases rows continuously.

  **So the mark stopped being a decoration.** It is now our own absolutely-positioned element
  inside `.xterm-rows` carrying the hit's own text: it inherits the row container's font, size and
  (this file's, zeroed) letter-spacing so its glyphs land on the same pitch as the ones underneath,
  it is placed from the cell `report()` already measures, and `z-index: 5` clears the selection
  layer's 1 while staying under the decoration container's 6/7. Nothing xterm does to the buffer
  can reach it. `term.onScroll` re-places it, which only matters on the `shell` start mode.

  Still open, same root cause, out of scope here: **the addon's grey matches decay** as tmux
  repaints, and with `_updateMatches` stubbed nothing rebuilds them, so a long-lived search ends up
  with most matches unhighlighted. Un-stubbing it brings back the drift T14 removed; drawing all
  matches ourselves is blocked on the addon exposing no public result list (`onDidChangeResults`
  gives an index and a count, nothing more).

And bug 1's scroll: on the alt screen there is nothing to scroll. That buffer has no scrollback
(`baseY` 0, `viewportY` 0), so every hit xterm can find is already on screen and `_selectResult`'s
scroll branch is unreachable by construction — the history the user means is tmux's, which only
its copy-mode can reach. So under tmux bug 1 IS bug 2: "it did not go to the match" is "I cannot
see which match it went to". In the normal buffer the scroll does run (`markHit` does it too now,
so the hit no longer depends on the addon reaching its own branch). Raising tmux's history to the
search is a separate piece of work and would have to drive copy-mode from `src/app/terminal.tsx`.

---

## 3. The outgoing card shows the incoming tab's contents for a frame

**Repro.** Switch tabs with any swipe. Watch the moment the switch is almost complete.

**Symptom.** While the *previous* tab's card is still on screen, its contents are replaced with the
contents of the tab being switched to. Brief, but visible every time.

**Settled: pre-existing, not the perf branch.** Reproduced on `fa4cb78` with the perf changes
absent (device, 2026-08-15). The suspicion below is kept because it is still the mechanism most
likely to make this *worse*, and whoever fixes it should know the timing moved.

`afterHostRedraw` (`src/app/terminal.tsx`) releases the flight on two facts: bytes arrived after a
baseline, and then a frame with no new bytes ("arrived, and quiet for a frame"). `e75141f` changed
when those bytes are counted — `session.emit` now buffers a turn's chunks and delivers them in one
batch on a zero timer, and the sink advances `dataSeq` once per batch instead of once per chunk. A
redraw that used to arrive as several events spread over several frames now lands as one, so the
quiet frame comes **one or more frames sooner**, and the flight is released earlier than it was.
Releasing early is exactly the shape of this symptom.

Note the file already documents a residual of this kind at the `selectCard` comment — "the card is
one frame of cut behind the live pane rather than a tenth of a second of double exposure" — so the
phenomenon pre-dates the branch. The open question is only whether the branch made it worse.

**Where a fix goes.** `afterHostRedraw` releases on "bytes arrived, then a frame with none". The
outgoing card is still on screen at that moment, so anything that lands between the release and the
card leaving is drawn into the wrong card. Either the release wants to be a frame later than the
first quiet frame, or the card wants to stop taking live content the instant the flight is armed
rather than when it ends.

---

## 4. `git log` cannot be scrolled with a finger

**Repro.** Run `git log` in a tmux pane, drag up or down over the output.

**Symptom.** The pager does not move. The pane scrolls into tmux's own history instead, taking the
git log off screen. Only the arrow keys scroll the log.

**Where to look.** `generateConf` in `src/tmux-model.ts:77` — the same root-table wheel binding that
fixed `less` and `man`. Its three cases are: the app asked for the mouse → `send -M`; `alternate_on`
→ one arrow per notch; otherwise → `copy-mode -e`. Git runs its pager with `LESS=FRX` by default,
and `-X` suppresses the termcap init/deinit — so **this** `less` never switches to the alternate
screen. `alternate_on` is false, so the notch falls through to the third case and opens copy mode,
which is exactly the reported symptom. Plain `less foo` takes the second case and works; that is why
the earlier fix looked complete.

Suspected, not yet confirmed on device — check `#{alternate_on}` and `#{pane_current_command}` in a
pane sitting in `git log` first. If it holds, the fix is to widen the second case's condition to
match a pager by name as well as by alternate screen, e.g.
`#{||:#{alternate_on},#{m:less,#{pane_current_command}}}`, plus a `tmux-model.test.ts` case. Setting
`LESS` for the user is the other option and is worse: it rewrites an environment the app does not
own.

---

## 5. Neighbour cards do not reliably leave during the swipe up — CLOSED 2026-08-17, not reproducible

**Closed by the user, who has walked it since: the symptom is gone and the entry is stale.** The
visible half went with `e576202` ("the held card goes to the grid alone — the neighbour row is
gone"), which deleted `heldAir`, the ceiling and the air branch of `rowJoins`, so a pure lift can no
longer join the row at all — that commit landed *after* this entry was written, which is why the
entry still describes it as open.

**The React Compiler is exonerated, and that is worth keeping** so nobody re-runs the experiment
below. Running babel-plugin-react-compiler with its logger reproduces the audit's claim exactly (8
`CompileError`, then `CompileSuccess` for `PageContent`, `NeighborPage`, `Status`) — but the memo it
gains is a no-op. `NeighborPage` reads no ref, holds no state and does not gate its own visibility:
visibility is `opacity: rowVisSV.value` on the *parent* `Animated.View` (`usePageCardStyle`),
outside the compiled component. Its one cached value, the style array, is keyed on `radii`, a stable
`useAnimatedStyle` object; and its `<PageContent>` cache is keyed on `insets` (`paneInsets`), a
fresh object literal every render, so it misses every time and is rebuilt anyway. `"use no memo"`
would have changed nothing — the surgical test this entry prescribes was never going to move.

A fix for a residual on the sideways-then-up path (adding `toGrid` to `onZoomEnd`'s fade condition)
was written on 2026-08-17 and **withdrawn unshipped** once the entry was known to be closed: no live
symptom, no fix. Recorded here so it is not rediscovered as an omission.

<details><summary>Original entry, kept for the record</summary>

**Repro.** Swipe a tab upward (the zoom toward the grid), slowly. Screenshot: 2026-08-15, 21:51.

**Symptom.** The neighbouring cards either side of the live one do not always go away, and during a
slow swipe they flash — appearing and disappearing — instead of leaving once and staying gone.

**Suspect: this one may be a regression from `e75141f`, and it is the strongest such suspicion of
the whole audit.** `NeighborPage` (`src/app/terminal.tsx`) is one of exactly three components that
began being compiled by the React Compiler as a result of that commit — the two block-form
`eslint-disable`s were making the compiler treat every function later in the file as suppressed, and
removing them took `PageContent`, `NeighborPage` and `Status` from `CompileError` to
`CompileSuccess` (verified by running babel-plugin-react-compiler with its logger: 0 before, 3
after).

So `NeighborPage` is memoized now and was not before. A conditionally-rendered component that has
just acquired automatic memoization is exactly the thing that starts rendering a frame late, or
holding a stale visibility, or flickering as its inputs settle — which is the reported symptom.
Nothing else in the branch touches the neighbours.

**How to settle it, surgically** — better than a full baseline checkout, because it isolates the one
component instead of the whole commit. Put `"use no memo"` at the top of `NeighborPage` and reload:
that opts only that component out of the compiler while leaving everything else compiled. If the
flashing stops, it is confirmed, and the fix is either to leave that one component opted out with a
comment saying why, or to find what the compiler is memoizing that should not be (a ref read during
render, a value whose identity is load-bearing for visibility).

If the flashing persists with the directive in place, it is pre-existing and the compiler is
exonerated — then check the zoom's own visibility gating, since bug 3 shows the same transition
already releases things a frame early.

</details>

---

## 6. Terminal search only sees the visible screen — FIXED, Android-verified 2026-08-17

**Repro.** Flood a pane (`yes "…" | head -200000`), then search the terminal for a word from the
flood. Expect thousands of hits; get about **20** (device, 2026-08-15).

**This is not an off-by-something — it is the architecture, and it makes the feature much weaker
than it looks.** Three numbers are involved and none of them is the one that bites:

| Limit | Value | Where |
|---|---|---|
| xterm `scrollback` | 10 000 rows | the phone, `src/terminal.tsx` |
| tmux `history-limit` | 50 000 lines | the host, `EXTRAS` in `src/tmux-model.ts` |
| `DEFAULT_HIGHLIGHT_LIMIT` | 1 000 results | `@xterm/addon-search`, `SearchAddon.ts:30` |

The observed 20 is far below all three, and the reason is that **under tmux the outer terminal's
scrollback is never filled**. tmux draws each pane inside a scroll region (DECSTBM); content
scrolling within a region does not leave the screen into the emulator's scrollback. That is the
same reason a tmux user needs copy-mode to scroll at all, and it is why this app pushes `mouse on`
and binds the wheel. So xterm's 10 000 configured rows sit essentially unused, and the search
addon — which walks *xterm's* buffer — has little more than the visible ~41 rows to search.

**The asymmetry worth noticing:** the *grid's* search does not have this problem. It greps the
host's real scrollback with `capture-pane -p -e -S -` (`searchPaneCommand`, `src/search-model.ts`),
so it sees all 50 000 lines tmux is keeping. Two searches, in the same app, over the same session,
with completely different reach — and the one that looks like "search this window" is the shallow
one.

**Where a fix goes.** The terminal search would have to stop searching xterm's buffer and search
what the grid already searches: one `capture-pane -S -` for the current window, matched host-side,
with the hits mapped back to positions. That is a different feature from what T14 built, so this is
a design question, not a patch. A cheaper honest half-measure: say so in the UI — the count is
"20" when the truth is "20 on screen", and nothing tells the user which they are looking at.

**Half-measure DONE, 2026-08-17. The design question is still open and unbuilt.** The count now
carries its own scope: `3/20 on screen`, `20 on screen`, `none on screen` while the buffer cannot
reach past the viewport, and the plain `3/20` / `20` / `none` when it genuinely can. Same `Text`,
same MONO 11 in `muted` — the scope is part of the number, no new chrome.

The signal is read, not guessed: `term.buffer.active.baseY === 0` (`screenOnly` in
`src/terminal.tsx`) says the buffer holds no history at all, so the addon had only the visible rows
to search. Under tmux that is permanent — the alternate buffer's `baseY` never leaves 0 — and on a
bare shell it is true only until the first screenful scrolls off, after which the suffix disappears
by itself. No `Platform.OS`, no "is this tmux" flag. It crosses the bridge on the existing
`onDidChangeResults` path, as a third argument to `onSearchResults(index, count, screenOnly)`, into
the same `occ` state that already holds "i/N".

What is NOT done, and is the actual fix: host-side `capture-pane` for the terminal search, so the
two searches in this app finally have the same reach. Still a design question.

**`scrollback: 10_000` — verdict: keep it (2026-08-17).** It is dead weight under tmux, as this
section says, but it is the *only* scrollback on the `shell` start mode (`startupLine`,
`src/settings.ts`), where there is no host-side history to fall back on. And unfilled it is nearly
free: xterm hands the number to `CircularList`, which does `new Array(maxLength)` and allocates a
line object only on push (`common/CircularList.ts`) — so an unused 10 000 is one empty 10k-slot
array, not 10 000 line buffers. Nothing to reclaim; a comment at the option now says so.

---

## 7. The grid's bottom bar is unreachable on Android — FIXED, Android-verified 2026-08-17 (walk 4)

**Repro (Android only).** Open the tabs grid. Tap `+`. Tap `✓`.

**Symptom.** `+` opens the terminal's **UPLOAD FILE** sheet instead of birthing a window; `✓` does
nothing at all. The grid can only be left with the system back button. Measured on the emulator
2026-08-17: the grid's `+` at `[89,2182][218,2311]` and `✓` at `[862,2182][991,2311]` are the same
rectangles as the key bar's `…` and tabs circles, the bar wins the hit test, and neither
`[switcher] new window` nor a window-count change is ever logged. `✓` reaches `openSwitcher`, which
returns early on `sw !== 'closed'` — a tap that does nothing and logs nothing. This is almost
certainly the true "the app is stuck, 13 taps did nothing, only the system back button recovered
it" report that was blamed on a blank grid.

**Cause.** The key bar and the ribbon band are SCREEN-STATIC chrome: they are deliberately rendered
*outside* the zoom box (see the comment above them in `src/app/terminal.tsx`) so a page swipe does
not slide them, which puts them AFTER the grid in paint order — in front of it. Through the flight
they are hidden by `barFadeStyle`, an opacity that reaches 0 a quarter of the way in.

Invisible is not untouchable. Android's `TouchTargetHelper` walks the view tree checking bounds and
`pointerEvents` and never looks at a view's alpha, so an opacity-0 key bar in front of the open
grid keeps every hit that lands on it. **iOS never showed the fault** because UIKit's `hitTest:`
skips any view with alpha ≤ 0.01 — the same JSX, two behaviours, and the phone's was the correct
one by accident. The zoom box itself has always carried
`pointerEvents={sw === 'closed' || 'closing' || 'drag' ? 'auto' : 'none'}`; when the bar moved out
of that box it silently left the gate behind, and its stale comment ("the bar rides inside this")
is what recorded the assumption.

The grid's own `Could not reach the host` Pressable was suspect for the same reason — it is an
absoluteFill and its lower band sits under the bar — and is fixed by the same change. Its centre,
where the taps went, was always clear; only the strip behind the bar was dead.

**Fix.** One `chromeLive` const in `src/app/terminal.tsx` (`sw === 'closed' || 'closing' ||
'drag'`), read by all three chrome layers: the zoom box, the key bar's wrapper, and the ribbon
band's layer (`box-none` → `none`). Says out loud what iOS was getting for free, so both platforms
do it for the same reason and no `Platform.OS` branch appears. `closing` and `drag` stay live
because the bar owns the drag gesture and the phase outlives the motion.

Nothing in `src/switcher.tsx` changed — the grid was always drawing and gating its controls
correctly (`interactive` is `sw === 'open'`), it just never got the touch.

---

## Also open, found the same session, lower priority

### The key bar is up before the keyboard is — FIXED, Android-verified 2026-08-17 (walk 4: bar at y2193-2320 on the landing)

**Repro.** With the keyboard up, open the tabs grid, then come back to the terminal.

**Symptom.** The key bar is *already* at its keyboard-up position when the terminal appears, sitting
over an empty band, and the keyboard then slides up to meet it. It should start at the bottom and
travel up with the keyboard (user, 2026-08-15).

**Cause, in two layers.** The first was the value: `finishClose`'s `keysWereUp` branch raised the
keys (`kbSettle` + `focusSignal`) but never touched `keyboardPad`, which the grid had frozen at
whatever it was before the open — a full keyboard's worth. `syncPad()` could not be what zeroed it,
because it read `Keyboard.metrics()`, which mid-hide still reports the departing keyboard (the same
trap the fixed chrome bug hit, and why a `keyboardDidHide` backstop had to be added). So the
listeners now record the pad every keyboard event ANNOUNCES — the freeze skips the render, not the
record — `syncPad` reads that record, and `finishClose` calls it on both branches. That also removed
the backstop's own 286 → 0 flicker.

The second layer was the TIMING, and it is what the 2026-08-16 Android walk caught: with the value
right, the bar still spent frames 66–69 at 1373–1501px (its keyboard-up geometry, over a ~900px
empty band with no keyboard on screen) after landing at frame 66, then DROPPED to 2193–2321px at
frame 70 and rose again as Gboard arrived at 76. Motion in the wrong direction — worse than the
symptom it replaced.

That is an ordering bug, not emulator noise, and it is late by construction rather than by
measurement: `finishClose` is `runOnJS`'d from the ZOOM_IN completion callback, so the UI thread has
already painted the frame at prog 0 — the frame the landing is pinned by — before the JS thread has
been handed the call at all, let alone rendered and committed. It can never be 0 frames late on any
build, and the commit it rides in is a heavy one (`setSw('closed')` unmounts the grid and releases
`holdSize`), which is why 4 frames at 30fps is plausible on a dev client with SwiftShader. A Release
build shortens that tail; it cannot delete it.

**Fix (2026-08-17, unwalked).** The thaw moved off the landing and onto the frame the close is
COMMITTED — `syncPad()` next to `setSw('closing')` in `closeTo` (the two-frame gap that already pays
the phase flip's costs) and in `springBack` (the drag release; a no-op on the `closeTo` path).
That is ~380ms before the landing, and `barFadeStyle` holds the bar at opacity 0 until prog < 0.25,
~140ms into the flight — so the bar fades in already at the bottom and is never seen anywhere else.
`holdSize` has been true and marshaled for the whole grid session, so the box change rides a
ResizeObserver that drops it: nothing refits, the host hears nothing, and the relayout moves off the
landing frame into the flight where it is invisible. `finishClose` keeps its `syncPad()` as the
reconcile for the no-flight `springBack` path and for any keyboard event that landed frozen mid-flight.

No animated pad was needed and none was added — read `keyboardPad`'s note at the top of
`src/app/terminal.tsx` for why an animated one would be wrong here anyway (the webview shrink has to
land BEFORE the keyboard animation starts, and Android's only event is `keyboardDidShow`, which
fires when the keyboard is already up).

**What the next Android walk must measure.** Same pin — the landing frame is where the zoomed card's
left edge reaches x=0.

- **Keys-were-UP (primary).** From the FIRST frame the bar is visible at all (it fades in over the
  last ~140ms of the flight, before the landing) it must be at the bottom, 2193–2321px. Zero frames
  at 1373–1501px, and no downward step anywhere. Gboard then rises and the bar rises with it.
- **Keys-were-DOWN (regression).** Unchanged: 2193–2321px from the landing frame on, never moves, no
  empty band.
- **Shell geometry (regression).** Unchanged: `pane_height` 26 rows with Gboard up, 44 down, and one
  report per settle — nothing drawn under Gboard.
- **New risk to watch:** the pad now changes on the flight's first frame instead of the landing.
  Watch the close flight for a hitch or a jump in the flying card's content that was not there
  before.

### Grid tap intermittently does nothing — CLOSED 2026-08-17, not reproducible

**Closed by the user, who has walked it since.** The entry below is kept because its analysis of the
race is sound and worth having if the symptom ever returns.

One thing was established while it was still thought open, and it inverts the fix this entry
implies: **moving the tap's `maxDuration` below the drag's `activateAfterLongPress` would make it
worse, not better.** The two 300ms deadlines are timers armed from the same touch-down
(`performSelector:@selector(cancel) afterDelay:` in `RNTapHandler.m` against
`@selector(activateAfterLongPress)` in `RNPanHandler.m`; two `postDelayed` runnables on Android), so
equal delays on one runloop have no defined order — a coin flip. Lowering the tap's deadline
converts that coin flip into a deterministic dead band `[maxDuration, 300)` in which the tap has
already failed and the drag has not yet lifted, so *every* release inside it is silently lost. If
this is ever reopened, the direction is to remove the tap's deadline, not to lower it.

That removal was written on 2026-08-17 and **withdrawn unshipped** once the entry was known to be
closed — it is a behaviour change (RNGH's 500ms default applies once reordering is off) with no live
bug behind it. `.maxDuration(300)` therefore still stands in `src/switcher.tsx`.

<details><summary>Original entry, kept for the record</summary>

Tapping a card in the tabs grid sometimes does nothing at all, then recovers by itself on the next
touch. `[switcher] select` never logs when it fails, so the tap is not reaching the handler — this
is gesture arbitration, not the select path.

`src/switcher.tsx:837` composes `Gesture.Race(drag, swipe, tap)`, where `drag` is a
`.activateAfterLongPress(300)` pan and `tap` is a `Gesture.Tap().maxDuration(300)` — the same 300ms
on both sides of the race. The file's own T10.9 note at `:765` already describes the failure mode
("the timer maturing a touch iOS already cancelled into a drag with no finger… The handler recovers
by itself on the next touch"), which matches the symptom exactly, including the self-recovery.

Reproduced on `fa4cb78` as well as on the perf branch.

</details>

### One exec per grid open fails, and kills fail the same way — ANSWERED 2026-08-17 (Android)

**"Always exactly one" was always the window you had just killed.** Settled on the emulator against
a live host, once the failure log was made to name its target. The single failure fires when a kill
races a capture that was already in flight for that same window:

```
'[switcher] kill', '@66'
'[switcher]', 1, 'of', 26, 'captures failed:', '@66(:4)', { … Command exited 1 }
```

`@66(:4)` is the card the finger had just closed, and the count is back to 0 of 25 within one beat.
Four grid opens at 7 windows and a sustained poll at **26** windows produced **zero** capture
failures otherwise — the same scale as the original "1 of 25".

**The dangerous half was real, and it was the opposite of what this entry feared.** A failed command
exits 1 and touches nothing, so "a kill that reports failure" was always the safe case. The unsafe
case was a stale index that *does* resolve: with `renumber-windows on`, killing a window slides every
higher index down, and `-t :N` also falls through to matching a window by *name*. Replayed on real
tmux 3.7b — list `a b c d`, kill index 1, then kill card `c` by its listed index 2 → **exit 0, and
`d` died instead**, silently, while `killCard`'s optimistic removal showed the user the right card
leaving. Verified on device too: a window *named* `5` at index `:3` survived a kill aimed at a
now-dead `@65` that had sat at index `:5`.

**Fixed** by addressing windows with tmux `@N` ids, which are unique server-wide and never reused —
`target()` in `src/tmux-model.ts` is the one guard every command routes through, including
`search-model`'s. `moveWindowCommand` keeps `:index` deliberately (a drop slot *is* a position; see
its `ponytail:` note). The failure log now names the window: `[switcher] 1 of 25 captures failed:
@31(:5) <error>`, and `killCard` re-lists and reports whether the window actually survived instead
of assuming.

**The saturation refutation below still stands for THIS mystery, but saturation is a separate real
fault found the same day** — see "The grid's fan-out exceeds MaxSessions" further down. Do not merge
the two: concurrency never explained "exactly one", and ids never fixed the channel count.

<details><summary>Original entry, kept for the record</summary>

Opening the tabs grid logs `[switcher] N of M captures failed` with **N always exactly 1** — 1 of
25, 1 of 18, 1 of 8 — and `[switcher] kill failed` throws the identical error:

```
Citadel.SSHClient.CommandFailed error 1
  (at ExpoModulesCore/ConcurrentFunctionDefinition.swift:90)
```

**Refuted:** SSH channel saturation. OpenSSH's `MaxSessions` defaults to 10 and the switcher opens
one exec channel per window, so 18–25 windows looked like an obvious cause — until the same single
failure appeared with only 8 windows open. Concurrency is not it; do not re-run that hypothesis.

**Current hypothesis, unverified:** a stale window index. Commands address windows by index, tmux
renumbers, and a command aimed at a window that no longer exists makes tmux exit 1, which Citadel
surfaces as `CommandFailed`. `killCard` already anticipates exactly this — "A renumber race can
leave the index stale — log, re-list, move on" — which is why the kill path degrades gracefully
and the capture path merely counts the loss. That "always exactly one" is what a single stale entry
in the list would look like.

**Why this one matters more than the cosmetic bugs above:** every other item here looks wrong. This
one is an action that does not happen. A kill that reports failure is survivable; a kill that
appears to succeed while the window lives would not be, and nothing has established which of those
is occurring.

</details>

### The grid's fan-out exceeds the host's `MaxSessions` — FIXED, Android-verified 2026-08-17 (walks 3-4)

*(The first fix was verified on the emulator and found half-right — the pool held, the arithmetic
around it did not. The second is unverified: it needs a 24-window walk on Android and on the phone.)*

The grid opens one exec channel per window for the card capture, and the scrollback search opens
another per window, **concurrently** — roughly 2N channels against sshd's `MaxSessions`, which
defaults to **10**. Measured on the emulator against a live host:

| windows | result |
|---|---|
| 24 | `16 of 24 greps failed`, `5 of 24 captures failed` |
| 7 | `3 of 7 greps failed` |

all with `Opening 'session' channel failed: open failed`.

**Why it matters more than it looks:** a window whose grep failed is currently indistinguishable
from a window that simply had no match, so the filtered grid silently under-reports — the search
looks like it answered when it never asked.

This is **not** the "always exactly one" bug above, and the refutation in that entry is not
overturned: concurrency was never what produced a single reliable failure at 8 windows. This one only
appears at scale and only when search and capture overlap.

**First fix (2026-08-17, partial)** — one shared pool, `execPool = makePool(4)` in `src/tmux.ts`
(`src/exec-pool.ts`, tested; nothing installed offered this and it is not worth a dependency). Both
fan-outs call through the *same* instance: two pools of four is precisely the bug, so the instance
lives at the exec seam rather than in a component. The captures were already batched at 4; the greps
were an unbounded `Promise.all`, so the peak was 4 + N, not 4.

**The second Android walk proved the pool works and the arithmetic did not.** The cap is real: a
`ps` on the host during a 24-window fan-out caught exactly four concurrent `tmux capture-pane`
children of the one sshd session and never five, greps came back `22 of 24`, `21 of 24` with **no**
`N of N greps failed`, and every card had content. But `open failed` still fired three times, at
three sites that were outside the pool:

| site | why it was outside |
|---|---|
| a fan-out capture for `@90(:19)` | the window was alive and untouched — not the understood just-killed case |
| `listWindows()` | `tmux.ts` never pooled it |
| `refreshCard`'s capture | deliberately un-pooled, so the zoom's landing card is never stale |

The old budget assumed **at most one** singleton in flight beside the pool's 4. Several overlap in
practice — the poll, a `listWindows`, the user's select, and the bar swipe's *two* neighbour warms —
so the unbounded classes summed past 10 while the pool itself was behaving.

**Fixed properly:** no exec class is outside a pool. Three of them, and the sum is the budget:

| slots | class | what spends it |
|---|---|---|
| 1 | the shell's PTY | held for the whole session |
| 3 | `execPool` | the grid's per-window fan-outs (captures + greps), shared |
| 2 | `singlePool` (private, via `run1`) | every non-fanned command: the ~2s poll, `listWindows`, select/kill/new/move, the probe, `cacheSessions`, `configure`'s two reads |
| 2 | `shotPool` | the un-fanned single captures — the zoom's `refreshCard` and the bar swipe's two neighbour warms |

**= 8 against a default `MaxSessions 10`**, and the two spare cover `configure`'s SFTP upload plus
whatever sshd counts that we do not. `capturePane` is still not pooled *inside* `tmux.ts`, and now
for a sharper reason than before: its two callers belong to different budgets, and pooling it in the
callee would nest one pool inside the other and collapse both.

**One retry, and only on `open failed`** (`retryRefused`, `src/exec-pool.ts`, tested). A channel
refusal happens strictly *before* the command reaches the remote shell, so re-asking cannot birth a
second window or kill a second pane — unlike `Command exited 1`, which means it ran, and which is
never retried. It waits 150ms first (an immediate re-ask meets the same full session table), it
spends the pool slot it already holds rather than a new channel, and a second refusal is the
caller's error: twice in a row is a host that is genuinely full, not a hiccup. Singletons only —
retrying 24 refused greps is how you re-saturate the host you just backed off from.

`ponytail:` ceiling recorded on the budget — three fixed numbers against the *default*; a host set
lower still saturates (but now says so instead of lying), a host set higher just fills slower. The
upgrade is probing upward until `open failed` returns, since sshd does not advertise the limit.

**And "not searched" no longer reads as "no hit".** `SearchAnswer` gained a third state, `'failed'`:
the card stays in the filtered grid and swaps its directory line for `not searched` in
`theme.warning` — same row, same style, no layout shift; `warning` rather than `danger` because the
next settled keystroke asks again.

**The worst thing the walk found was not a missing card — it was a blank screen.** In the run where
`listWindows()` was refused, the app was left on a bare `#11111b` (`theme.scrim`, the screen's own
root, seen because the stage fades to alpha 0 at `sw === 'open'`) with no cards, no bar and no
terminal, ignoring 13 further taps; only Android's system back button — which calls `doneToActive()`
when `sw === 'open'` — got out. Reproduced once in four attempts, so it is timing-dependent, but a
transient host hiccup must never be able to strand the user.

The cause is that `refresh()` logged and returned `undefined`, and the grid opened onto the `[]` it
had never left: the very first refresh fires at connect, inside the busiest moment of the channel
budget, and if it fails nothing else fills `cards` until the grid is live. Fixed on both halves:

- **It keeps what it had.** `setCards` is not called on failure — a list we could not fetch says
  nothing about the windows already in hand, and the last known grid is the best answer available.
- **It says so when it has nothing.** `useSwitcherCards` exposes `listFailed`; with zero cards the
  grid draws `Could not reach the host` over `The window list did not come back. Trying again — tap
  to go back.` (disabled over hidden, and the ~2s beat really is asking again). The block is a
  `Pressable` wired to `onDone`, deliberately filling the middle of the grid — the empty space where
  those 13 taps landed — so the way back is under the finger, not only on the ✓ in the corner.

### `selectWindow` rejects unhandled and the LogBox eats the tabs button — FIXED, Android-verified 2026-08-17

`void selectWindow(win.id)` is called bare in both `selectCard` and `settleBarSwipe`
(`src/app/terminal.tsx`), unlike `killWindow`/`capturePane`/`searchPane`, which all carry a `.catch`.
When the channel exhaustion above makes it reject, the unhandled rejection raises the dev-client
LogBox toast, which **sits on top of the key bar and swallows taps on the tabs button** until it is
dismissed:

```
ERROR  [Error: Uncaught (in promise, id: 0) Error: Call to function 'ExpoSSH.exec' has been rejected.
→ Caused by: Opening `session` channel failed: open failed
```

Note this is a genuine unhandled rejection with a real reason, and therefore **not** the same thing
as the `DOM ERROR null` entry above — that one was a window `ErrorEvent` with a null `.error` and is
confirmed fixed (zero occurrences across ~40 minutes of heavy keyboard, zoom and resize work on
2026-08-17).

**Fixed**: both routes to a tab now go through one `switchTo(win)` in `src/app/terminal.tsx`, which
carries the catch. Deliberately NOT pushed into `src/tmux.ts` — `killWindow`, `moveWindow` and
`capturePane` all reject and let the caller decide, and the decision here is one only the screen can
make: **the optimistic `active` flip is rolled back**. Both routes paint the tapped window active
before the host answers, so a select that never landed leaves the halo, the pills and the anchor
pointing at a tab we are not on. The rollback ASKS rather than remembers — `refresh(false)` is
list-only (no capture burst) and comes back with tmux's own `active` flag, the same move `killCard`
already makes when a kill fails. The failure names its window in the switcher's style:
`[terminal] select failed: @68(:28) — the tab did not change`.

**Next Android walk:** with a 20+ window session and the search armed (the channel exhaustion
above), tap a card and confirm (a) no LogBox toast, (b) the tabs button still takes a tap, (c) if a
select does fail, the halo ends up on the tab you are actually on, not the one you tapped.

### The ribbon chip never appears for `sleep` — FIXED, Android-verified 2026-08-17 (walk 4)

Second Android walk of the day: `sleep 30` and `sleep 15`, twice each, touching nothing. All four
runs were **detected** — `[ribbon] run #2 sleep pid=… startedAt=…`, `[ribbon] run #3 sleep …` — and
the chip region was **empty at every sample**: 2/4/6/8/10s, 40 samples across a full 30s run
(`chipband_nonbg=0`), and a full-frame screenshot at t≈17s showing nothing.

**This was never fixed, and the comment on `RIBBON_HOLD_MS` claiming it was is now corrected.**
`c6cfde4` ("A plain `sleep` could never raise the band") removed one of two blockers — the flapping
untargeted poll, which made every beat a new instance with a fresh `startedAt` — and shipped on a
green test run without ever putting a `sleep` on a screen. The second blocker went in with the gate
itself (`b02c949`) and had never worked a day:

**`RIBBON_MIN_RUN_MS` was a clock read inside a memoised expression.** The screen has

```js
const recipe = connected ? selectRecipe(ribbonCore, modes.altScreen, Date.now()) : null;
```

in its component body, and this app builds with `reactCompiler: true`. Running the actual compiler
over that line:

```js
if ($[0] !== connected || $[1] !== modes || $[2] !== ribbonCore) {
  t1 = connected ? selectRecipe(ribbonCore, modes.altScreen, Date.now()) : null;
} else { t1 = $[3]; }
```

`Date.now()` is not a dependency. A job that is simply running changes none of the three: an
identical poll answer returns the *same* core object by design (`ribbonPoll`'s "quiet beat"), and
`set` in `src/tmux.ts` drops it before that. So the screen's gate-beat timer — which does exist, and
does fire at `RIBBON_MIN_RUN_MS + 50` — re-rendered against an unchanged cache and read the stale
`null` straight back. The band could never appear for **any** unnamed command, at any duration.

Third of the same family in two days, and the diagnosis is always the same sentence: *a quantity
that moves with the wall clock cannot be recomputed by a re-render nobody's dependencies noticed.*
The chip clock frozen at 0:00 was this (`Date.now()` in `RibbonAccessory`'s body); `RIBBON_HOLD_MS`
never expiring was this (nothing woke the reducer); this is this.

**Fixed** — the same shape as the hold's fix, a timer rather than a hoped-for beat, and this one in
`src/ribbon.tsx` where the state lives:

- `selectRecipe` no longer gates on the clock. A non-shell, non-TUI, non-REPL foreground is
  `running` from its first beat, so the screen's memoised call is *correct* whenever it is cached.
- `ribbonAppearDelay(id)` (`src/ribbon-model.ts`) is the three seconds as data: `RIBBON_MIN_RUN_MS`
  for `running`, `0` for everything the user opened on purpose.
- `RibbonAccessory` holds that delay itself — `setTimeout` → `setRipe(true)`, keyed on
  `startedAt + delay`, returning `null` until it fires. State cannot be memoised away.
- The VoiceOver announcement moved behind the same gate: the band is mounted for every `ls` now,
  and announcing one would put back exactly the intrusion the gate exists to prevent.

`selectRecipe`'s third parameter is dead and marked `_now`; it stays only because the screen's call
site keeps its arity, and `src/app/terminal.tsx` was another agent's file this session.

Covered in `src/ribbon-model.test.ts` ("a run that never changes still earns the band: the gate is a
delay, not a render-time clock") — it drives the reducer with a run that starts and never changes,
asserts the poll really does return the identical object 60s later, and asserts the band is selected
anyway. The timer itself is in the component and is device-verified only.

**Next Android walk:** run `sleep 30`, touch nothing. `[ribbon] run #N sleep pid=… startedAt=T` at
t≈0. Chip region still empty at t = 2s. Chip present from **t ≈ 3.0–3.1s** (the 3000ms delay, armed
from `startedAt`, so a poll that noticed the run ~1s late still shows it 3s after it *began*),
reading `▶ sleep · 0:03` and ticking — 0:10 at t≈10s, 0:25 at t≈25s. `[ribbon] open sleep` if the
chip is tapped, with kill / ^Z bg / ^C. On exit at t≈30s the chip fades within
`RIBBON_HOLD_MS + 50` + one poll beat (≤4.6s) and does not tick on. Also run `ls` and confirm
**nothing** appears — the gate still has to swallow short commands.

**That walk happened and `sleep` still showed nothing.** This half really was fixed; there was a
second, independent blocker, written up immediately below.

### `running` is unreachable inside tmux: the TUI gate read the wrong terminal — FIXED, Android-verified 2026-08-17 (walk 4)

The walk the entry above asked for: `sleep 30`, twice, touching nothing. Detected both times
(`[ribbon] run #1 sleep pid=… startedAt=…`) and the chip region **empty at every sample** — t = 0.5,
1.5, 2.0, 2.5, 2.9, 3.2, 3.6, 5, 10, 15, 25, 29, 31, 33, 36s. Never `▶ sleep · 0:03`, never a tick.
So the appear-delay fix landed and something else was swallowing the same chip.

**The §4.4 "unknown TUI" gate was fed the OUTER terminal's buffer type.**

```js
if (altScreen) return null; // an unknown TUI: no caps beat wrong caps (§4.4)
return { id: 'running', proc: core.command };
```

`altScreen` is `term.buffer.active.type === 'alternate'` (`src/terminal.tsx:698`) — the xterm the app
draws the session in. **A tmux client is itself a full-screen app**, so inside tmux that flag is
permanently `1`: every tmux connect ends its mode log at `{"altScreen":true,…}` and it never flips
back. The gate therefore returned `null` for every unnamed command in every tmux session — which is
this app's own default start mode. `running` was not "rare", it was **unreachable in every
configuration**:

- `vim` had its chip only because `matchRecipe` hits *before* the gate. It proved nothing.
- Plain-`shell` start mode has `altScreen:false`, and no ribbon at all (`attached:false`,
  `foreground:null`) — the poll is what feeds the ribbon, so no tmux means nothing to gate.

The signal was measuring the wrong thing. The gate asks "is the pane's foreground app a full-screen
TUI"; the outer buffer answers "is tmux running". tmux can answer the real question itself —
`#{alternate_on}` is per pane, and the conf's own wheel binding already switches on it.

**Fixed** — the fact changed source, not meaning:

- `pollCommand` carries `#{alternate_on}` beside the pid it already reports, inserted *before*
  `pane_current_command` so the command stays the last field and a name full of separators still
  shifts nothing. `parsePoll` reads it as `paneAlt`, and deliberately does **not** reject a line for
  it: a tmux too old to know the format renders it empty, and the badge and tabs button must not go
  down with a field only the ribbon reads.
- `src/tmux.ts` carries `paneAlt` on `TmuxState` (in the dedupe compare, so a change actually
  propagates), false unless attached.
- `selectRecipe`'s gate takes that instead. §4.4 is untouched: a real full-screen TUI in the pane
  still gets no chip.

**`modes.altScreen` stays exactly where it is.** `scrollRoute` consumes the same-named flag and for
*it* the outer reading is correct — inside tmux a wheel notch should be arrows. Two facts, one
name; both call sites now say so in a comment.

**And the compiler could not see any of this**, which is why `selectRecipe` now takes
`{ paneAlt }` rather than a bare boolean: the wrong signal was passed for two months and `tsc` was
happy, because both are `boolean`. Named, only the tmux poll's answer fits (`useTmux()` satisfies it
structurally).

Covered in `src/tmux-model.test.ts` (the field parses, empty degrades to false, command still
rejoins from field 5) and `src/ribbon-model.test.ts` ("the TUI gate reads the PANE, not the outer
terminal"), which drives a real poll line with the pane flag `0` — the exact combination the bug
needs — and asserts `running`, plus that the old outer-flag value still swallows it.

`src/app/terminal.tsx` was another agent's file this session: its one call site,
`selectRecipe(ribbonCore, modes.altScreen)` at line 1825, becomes `selectRecipe(ribbonCore, tmux)`.
Until that is applied it is the single expected `tsc` error.

**Next Android walk:** in the default tmux mode, `sleep 30`, touch nothing. Chip **appears at
t ≈ 3.0–3.1s** reading `▶ sleep · 0:03` and ticks (0:10 at 10s, 0:25 at 25s); gone within ≤4.6s of
the exit. `ls` — **nothing**, ever (short-lived, the 3s delay swallows it). `vim` — the named chip,
at once, exactly as before. Worth one extra: open `htop` (named, chip) then something with no
recipe that takes the alt screen, e.g. `nethack` or `watch -n1 date | less`, and confirm **no**
chip — that is the §4.4 intent still holding on the new signal.

### The ribbon does not clear on a bar-swipe birth — FIXED, Android-verified 2026-08-17 (walk 4)

Swiping past the last tab to birth a new window lands correctly (`@68:28:fish` created and active,
fresh prompt drawn), but the ribbon chip keeps the *previous* window's run: it still read
`claude · 0:43`, then `1:10`, timer running, on an empty `fish` window, while `[tmux]` reported
`windowIndex 28, foreground: null`. No `[ribbon] forWindow 28` was ever emitted. Hopping away and
back fixes it instantly (`[ribbon] forWindow 28 fish`).

The report was right that the birth path never told the ribbon, but that was only half of it. **Two
faults, and the second is not about births at all.**

1. **The birth sent a poll-shaped null.** The hop path calls `ribbonForWindow`, which for an idle
   shell uses `ribbonSwitchedToIdle` — authoritative, clears at once. The birth commit called
   `ribbonPoll(core, null)` instead, which is exactly the signal `RIBBON_HOLD_MS` exists to
   disbelieve: it only armed `goneAt` and waited for a second null to confirm it. It also never
   armed `awaiting`, so the first poll answer still describing the window we *left* could put that
   window's run back on the new tab.

2. **`RIBBON_HOLD_MS` has no beat to expire on.** `set` in `src/tmux.ts` drops an answer identical
   to the last one, and the ribbon's poll effect is keyed on `[fgCommand, fgPid, frozen,
   windowIndex]`. Once the foreground has settled at null, *nothing wakes the reducer again* — so
   the second null the hold is waiting for never arrives and the hold never runs out. That is why
   the chip sat at `1:10` and climbing instead of clearing 2.5s in, and why hopping away and back
   (a `windowIndex` change) fixed it instantly. This was never specific to births: **any** command
   that simply exits while the user watches leaves its name and clock on the chip until something
   unrelated changes. The flapping untargeted poll used to supply that beat by accident; targeting
   the poll (entry below) took it away.

**Fixed** (`src/app/terminal.tsx`):

- `ribbonForBirth()` at the commit — `ribbonSwitchedToIdle`, so the band leaves with the slide, plus
  an `awaiting` placeholder (`index: -1`, an index no answer can match) that ignores the next few
  answers about the window being left. Its three-answer give-up is still the backstop.
- `settleBarSwipe`'s `newWindow().then(refresh(false))` now calls `ribbonForWindow(born, 'bar swipe
  birth')` with the fresh list's active window — the same thing `birthCard` does for the grid's ✚.
  That replaces the placeholder with the real index within a roundtrip and emits the
  `[ribbon] forWindow 28 fish` the report found missing.
- One timer arms whenever `goneAt` is set and re-applies the null at `RIBBON_HOLD_MS + 50`, so the
  hold expires on its own beat. Cancelled the moment the process comes back into view, so a
  blinking poll still costs nothing — which is the whole point of the hold.

Covered in `src/ribbon-model.test.ts` ("a birth clears the band now; the poll-shaped null the swipe
used to send would not") for the pure half; the timer and the `awaiting` placeholder live in the
component and are device-verified only.

**Next Android walk:** swipe past the last tab and watch for `[ribbon] forBirth` at the commit and
`[ribbon] forWindow <new index> fish` a beat later — the chip must be gone before the slide settles
and must not come back. Then, separately: run `sleep 30` on a window, touch nothing, and confirm the
chip clears ~2.5s after it exits rather than ticking on (fault 2, which no birth is needed to see).

### `DOM ERROR null` on every refit — FIXED 2026-08-16 in `10c949e`

Every keyboard open/close, rotation, font-size change and theme change logged a bare
`DOM ERROR null` from inside the webview, and surfaced the dev-client error overlay:

```
[terminal] tap
[terminal] size 51 × 25 … padTop 1.00     ← report() ran
DOM ERROR null
```

**It was not a promise rejection.** The diagnosis this entry used to carry — that the ~15
floating `latest.current.*` bridge calls in `src/terminal.tsx` are never `.catch()`ed, so a
rejection lands as an unhandled one — is why catching `onResize` did not silence it. Expo's
webview dev hooks (`expo/src/async-require/setupHMR.ts`) log the two cases separately:
`unhandledrejection` logs `event.reason`, and a bridge rejection's reason is an `Error` built by
`marshal.tsx`'s `errorFromJson`, so it would have printed a message and a stack. `window.error`
logs `event.error`, and that is the only one of the two that can be `null`.

It was ours: the `ResizeObserver` callback called `fitRows`, which writes `paddingTop` onto the
element being observed. Padding comes out of the *content* box, so the default content-box
observation saw its own inset as a resize, fired a second round, and Chromium reported the
deferred first one as "ResizeObserver loop completed with undelivered notifications" — a window
error with a null `.error`. Observing `{ box: 'border-box' }` breaks the feedback without
changing a measurement (`src/terminal.tsx`, the comment above `observer.observe`).

Evidence it is closed, from `/tmp/metro.log`: the last `DOM ERROR null` is at line 164, in the
pre-fix session whose `padTop 8.81, error, error, padTop 0.81` interleave the commit message
quotes. After it, **618 `[terminal] size …` reports and zero** — which also rules the rejection
theory out for good, since `onResize` fired 618 times without one.

Still open and NOT this: the `[terminal] box off by …pt` / `rowRemainder` warning, which survived
the change.

### The foreground poll answers about a window you are not looking at — FIXED 2026-08-16

`POLL` (`src/tmux-model.ts`) is `tmux display-message -p '…'` with **no target**. An exec channel
has no client and no current window of its own, so tmux resolves "current" against whichever
session/window it last considered current — which, on a host where anything else is working in
another window, alternates beat to beat.

Measured on device 2026-08-16, one poller at the normal 2s beat:

```
[tmux] {"windowIndex":7,"foreground":null}
[tmux] {"windowIndex":6,"foreground":{"command":"claude","pid":2299967}}
[tmux] {"windowIndex":7,"foreground":null}
[tmux] {"windowIndex":6,"foreground":{"command":"claude","pid":2299967}}
```

The user was on one window throughout. Everything downstream inherits the flap:

- **the badge** and `activePosIn` (`src/app/terminal.tsx:550`) read `tmux.windowIndex`, so the app's
  own idea of which window is active alternates too;
- **the ribbon** mounted and unmounted every beat, animating in twice around every window hop and
  flashing onto tabs with nothing running (user, 2026-08-16);
- **`ribbon-model`'s instance identity** treated each reappearance as a new run, restarting the
  elapsed clock — and, once `RIBBON_MIN_RUN_MS` existed, making it unreachable, so a plain
  `sleep 30` could never raise the band at all.

The ribbon now defends itself (`RIBBON_HOLD_MS`: a null has to survive one beat before it is
believed), which fixes the visible symptoms — but the badge is still wrong on those beats, and the
poll is still answering a question about somebody else's window.

**Fixed**: `pollCommand(session)` targets `=<session>:` — that session, its current window, its
active pane — with the untargeted form as a fallback so a renamed or killed session cannot drop
`attached` and take the tabs button with it. `pollSession` (settings.ts) supplies the name in
`session` mode (always `port22`) and in `attach` mode once a session has been picked; `custom` and
`shell` have no name to give, so the flap can still happen there. `[tmux] poll aimed at …` says
which it is.

Two things this did NOT fix, both handled in the ribbon:

- `select-window` is asynchronous, so for a beat after a hop the poll still describes the window
  you left. `awaiting` (app/terminal.tsx) ignores answers about other windows until the one we
  hopped to appears, and gives up after three answers so it cannot strand.
- The badge and `activePosIn` still read `windowIndex` directly; they are correct now for the
  targeted modes, and still exposed in the untargetable ones.

---

## RESOLVED: the one perf change nobody has measured — removed 2026-08-17

`package.json` carries `reanimated.staticFeatureFlags.IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS: true`
(added in `e75141f`). It is compiled into the native build, so it only takes effect in a fresh IPA.

It is recorded here because it is the single change from the performance audit with **no
measurement behind it**, and that fact is easy to lose. On the build where it first became active
the app "felt solid" and JS sat around 50 — but the flag targets the *UI* thread, not JS, and the
comparison was against a quieter session, so neither number says anything about it. It has not been
shown to help and has not been shown to hurt.

Either measure it — the perf overlay's UI figure, same session, same load, flag on and off — or
take it out. Do not leave it sitting here as something everyone assumes was justified.

**Taken out.** Measuring it needs the iPhone and a Release IPA, and the iOS half was deferred this
session, so the binary above resolves to removal rather than to an unmeasured flag surviving another
month on the strength of nobody having removed it.

Two facts that make removal the conservative direction rather than a coin flip: reanimated 4.5.1's
own default is `false` (`src/featureFlags/staticFlags.json:5` and `staticFeatureFlags.ts:17`), so
this is a return to upstream, not a new position; and the flag is compiled into the native build, so
nothing changes until the next IPA and **nothing on Android is affected at all**.

If an iOS measurement ever justifies it, restoring it is the same one block of `package.json` — but
then the number goes here with it.

---

## Residuals from the 2026-08-17 Android walks

Both found while verifying other fixes, both minor, neither caused by this session's changes.

### A bar swipe cannot start during the zoom-out's `closing` tail

The chrome hit-test fix keeps the key bar live through `closed`/`closing`/`drag`, on the stated
grounds that "the bar owns the drag gesture and the phase outlives the motion". Measured on the
emulator: a swipe issued 0.25–0.5s after `✓` does nothing — no hop, no log — while the same swipe
at ~0.75s commits, and from rest it always commits.

The pointer-events change is not the cause; the touch reaches the handler and the handler refuses
it. `onBarSwipe`'s start guards on `swRef.current !== 'closed' && !== 'drag'`, so `closing` is
rejected, and `ZOOM_IN` is 380ms. So `chromeLive` includes a phase the gesture itself will not
accept — harmless, but the comment justifying it is describing something that does not happen.
Either widen the handler to take `closing` or narrow `chromeLive` and correct the comment; do not
leave the two disagreeing.

### The ribbon's clock ticks on through `RIBBON_HOLD_MS` after the process exits

`sleep 8` ended at t=8.0 (the poll saw null at 8.42). The chip read `0:09` at t=10.0 and `0:10` at
t=11.0, then vanished by 12.0 — so it counts up for the ~2.5s the hold is disbelieving the null,
and disappears 3–4s after the exit.

The disappearance is inside the documented bound and the hold is doing exactly its job — a null has
to survive a beat before it is believed (see `RIBBON_HOLD_MS`). What is wrong is only that the
elapsed clock keeps *advancing* during the hold, so a job that ran 8s can be read as having run 10.
Freezing the displayed time at `goneAt` while the hold is open would fix it without touching the
hold; the number is then the run's true length whichever way the hold resolves.

---

## Found by the T13 acceptance walk (2026-08-17)

### Fast keystrokes are reordered in the terminal — FIXED 2026-08-17, awaiting its Android walk

`adb shell input text "less"` lands in the pane as `lses`. `/etc/services` lands as
`/ecst/ervcies`. Typed one character at a time ~350ms apart it is always correct, and the *same*
fast `input text` into the Setup screen's RN `TextInput` is correct — so the reordering is in the
terminal's own key path, not in adb and not in RN's text input.

This is silent input corruption on the app's primary function, and it invalidates any test that
types quickly. Note the shape: characters are transposed, not dropped, which is what a set of
concurrent async deliveries completing out of order looks like rather than a lost-event bug.

**The bridge was innocent; the order was lost in native dispatch.** Every hop above it is strictly
FIFO, traced one by one: xterm's `onData` is synchronous; expo's DOM proxy awaits `Promise.all(args)`
but with one argument per call the continuations resolve in enqueue order; `webview-wrapper` calls
the action synchronously inside `onMessage`; `ExpoSSH.send` is a synchronous JSI call; and
expo-modules-core launches each suspend function on `modulesQueue`, a single `HandlerThread`.

Then `ExpoSSHModule.kt` does `withContext(Dispatchers.IO) { session.send(text) }` — and
**`Dispatchers.IO` is a POOL**. Two launched sends land on two threads with no ordering relation,
both writing to sshj's unsynchronized `ChannelOutputStream`, which can reorder *and* corrupt a shared
buffer. That is the transposition signature exactly.

**iOS has the same hole latent**, for a different reason: `SSHSession.swift`'s actor method awaits
`writer.write(...)`, and Swift actors are **reentrant**, so a second `send` may enter while the first
is suspended. It is ordered today only because Citadel submits to a serial NIO event loop — nothing
in our code guarantees it.

**Fixed in JS, no rebuild.** `send()` in `src/session.ts` is one serialised writer: keystrokes append
to a string, one `ExpoSSH.send` is in flight at a time, and anything typed behind it coalesces into
the next batch. With never two calls in flight no native dispatcher can reorder anything, on either
platform. It also *shortens* the hot path — a burst costs one bridge crossing per round trip instead
of one per key. The startup line now goes through `send()` too, so there is exactly one writer and it
cannot interleave with a key typed into a freshly opened shell.

A `Mutex` in the Kotlin was rejected deliberately: it gives mutual exclusion but **not submission
order**, so it would have cost a rebuild without fixing the bug. The native `send` stays
order-agnostic by design and the JS queue is now its sole caller. `src/session.test.ts` locks it —
the mocked native `send` settles after a shuffled delay, longest first, and asserts no two writes
overlap and the burst arrives in submission order.

### Uploading a file is dead on Android — OPEN, and it is PICKER-SPECIFIC (refined 2026-08-17)

⋯ → UPLOAD FILE → Files launches the system Files activity, which backgrounds the app, and
backgrounding closes the shell (`[app] background` → `{"status":"disconnected"}`). On return the
destination sheet calls `exec` to resolve its start dir on the same tick as `[app] active`, before
the auto-reconnect lands:

```
[upload] sheet could not resolve a start dir: … IllegalStateException: Not connected
```

The reconnect succeeds ~1s later but the sheet never retries — it spins forever, shows no error, and
`Save here` stays disabled. Reproduced twice; nothing reaches the host.

**Refined by the T9/T8 walk: only two of the three pickers do this.** The SAF document picker
(Files) and the camera background the app and kill the shell. The **Android photo picker does not
background the app** — the session survives and the entire upload flow then works end to end:
browse, breadcrumb, descend, collision tint plus overwrite, the rename sanitiser, the silent save,
the remembered destination including its vanished-directory fallback to `$HOME`, and the
unwritable-directory alert. So the sheet and the SFTP path are fine; only the picker choice is fatal.

Two fix directions, and they are not exclusive: find whatever keeps the photo picker's activity
resumed and do the same for the other two, and/or make the sheet retry its start-dir resolution when
the session comes back instead of spinning. The retry is the smaller and more honest of the two —
per the disabled-over-hidden rule it should also say why it is waiting. Not a `Platform.OS` branch
either way.

### Selecting text on Android offers no edit menu — OPEN

A stationary long-press selects correctly (`[terminal] selection "PlasmaDesktop"`, both drag handles
drawn, no `scroll` line — the pan layer stands off as designed), and a tap elsewhere clears it. But
no floating toolbar ever appears: no Copy, nothing. So an Android user can select text and then do
nothing with it, while T4 proved the iOS system edit menu (Copy · Look Up · Translate) works.

Verified three ways — native-resolution crop, `uiautomator` finding no `Copy` node, and
`dumpsys window windows` during a live selection showing only the two handle `PopupWindow`s — and
from two injection paths.

**Starting point:** the DOM component installs no ActionMode callback, and Chromium WebView will not
raise its own toolbar for a selection on a non-editable body. Copy is core to a terminal, so this is
a parity gap that has to close, not a divergence to accept.

### The TOFU prompt cannot reach pixel parity while it is `Alert.alert`

`src/app/terminal.tsx:309` uses `Alert.alert`, so Android draws a Material dialog where iOS draws a
UIAlertController. Raised per AGENTS.md rather than fixed: parity here means building the prompt out
of the app's own sheet chrome, which is a change to a security-relevant flow and wants its own slice.

### The ribbon's caps can fire into a session the user is not in — OPEN, dangerous

Found while walking T7 (2026-08-17). In **plain-shell** start mode — where `src/ribbon-model.ts`'s
own comment claims "no ribbon at all" — a `✏ claude · 6:44` chip appeared. The untargeted tmux poll
had answered for the user's *real* `port22` session, on a phone that was not attached to it.

The chip is not the problem; its **caps** are. Tapping kill / `^Z` / `^C` there would have sent those
control characters into the user's live `claude` session from a screen showing an unrelated plain
shell. The walk agent did not tap them and moved to a private session — so this is reasoned from the
chip's presence plus what the caps do, not from an observed kill.

This is the same untargeted-poll family as the FIXED entry "The foreground poll answers about a
window you are not looking at". That fix targeted `pollCommand(session)` in `session` and `attach`
modes and explicitly left `custom` and `shell` unable to name a target — which is exactly the mode
this was found in. The conclusion there was that the flap was cosmetic in those modes; it is not.

**Where a fix goes.** Either the ribbon does not mount at all when the app has no session it can
name (the comment already believes this is the case — make it true), or the caps refuse to send when
the poll's answer cannot be attributed to the window on screen. The first is smaller and matches the
stated intent.

### A long-press selection kills the key bar's pan until relaunch — OPEN

Reproduced twice on the emulator (2026-08-17). From a fresh launch, a downward swipe on the key bar
hides Gboard as designed. Long-press any word in the terminal to select it, and the identical swipe
then does nothing — no `[terminal] size`, `mInputShown` stays true — while *taps* on the bar keep
working. Clearing the selection does not restore it. Only `am force-stop` and a relaunch does.

So the pan handler alone loses the touch stream, permanently, and the app has to be restarted.

**Where to look.** The WebKit selection path in `src/terminal.tsx` and its own note at `:1050` —
something in it appears to leave the touch stream claimed. Note the practical consequence for
testing: anyone walking a bar-gesture case must relaunch first, or a stale selection from an earlier
case will read as a gesture failure. It masqueraded as exactly that during this walk.

### The key bar's swipe up does not raise the keyboard — OPEN, and the iOS tick for it is stale

T7.9 / T7A.5. Swipe DOWN on the bar works (`50×26` → `50×45`, bar stays docked). Swipe UP does
nothing: `input swipe` at 250ms and 400ms, and a seven-step `input motionevent` drag, all leave
`mInputShown=false`, the grid at `50×45`, no `[terminal] size` and no switcher.

**This is not an Android divergence — the raise does not exist in the code at all.**
`src/keybar.tsx:548` makes the pan's only keyboard action `Keyboard.dismiss()`; `barDismisses`
(`src/keybar-model.ts:210`) is the sole vertical exit that touches the keyboard; and the upward
branch (`ty <= -KEYS_DROP_DY`) also only dismisses, for T10's drag. Nothing in the pan raises
`focusSignal`.

So the iOS boxes ticked for these two cases are stale by the same argument. Either restore the raise
or rewrite both cases to describe what the bar is actually meant to do — do not tick them again
without deciding which.

### `quickAttach` uses the picker that kills the session — OPEN

T8.16. The 📎 cap logs `[ribbon] cap 📎` and builds the right path
(`/tmp/port22/20260817T143236.txt`), then dies on `[session] disconnected` →
`[upload] failed … 'ExpoSSH.upload' has been rejected`, with one alert.

`quickAttach()` defaults to `'files'` (`src/upload.ts:128`) and is called bare at
`src/app/terminal.tsx:1871` — the SAF picker, the one that backgrounds the app and closes the shell.
TESTS.md's own case text says `quickAttach('photo')`, which is the picker that survives. So this is
a one-word fix that has been failing the case it was written against.

### A large file OOMs before anything is sent — OPEN

T8.14. A 46 MB JPEG: `FileSystemFile.base64` throws
`java.lang.OutOfMemoryError: Failed to allocate a 123507192 byte allocation … growth limit
201326592`, surfaced as one "Could not read the file" alert.

Whole-file base64 (`src/upload.ts:74-95`) needs roughly 2.7× the file size on the Java heap, so the
"tens of MB" the case specifies is unreachable on Android where iOS handled it. At 7.8 MB the case's
own Expect holds (⋯ goes solid accent `#89b4fa`, glyph in background colour, taps ignored, four
consecutive frames), so the ceiling is between the two.

The fix is to stop materialising the whole file as base64 — both natives already write bytes at
offsets (`RemoteFile.write` on Android is even chunked at 32 KB by hand), so the chunking wants to
start at the read rather than at the wire.

### Pinned clipboard slots duplicate across a JS remount — OPEN

Two identical `yank-two-bravo · pinned` rows appeared, with the log going `3 slots, 1 pinned` →
`3 slots, 2 pinned` and nothing pinned in between. `hydratePins()` appends onto live module state
(`src/clipboard.ts:62-68`) and `_layout.tsx:36-39`'s effect re-runs on **every JS root remount** —
every dev-client relaunch here, and a JS reload in production. Hydration has to be idempotent, or
replace rather than append.

### The ⋯ menu does not dismiss the keyboard — OPEN

T8.7. `mInputShown=true` before and after; Gboard stays full height with the menu squeezed above the
bar. iOS drops it (`52 × 26` → `52 × 41`). `src/keybar.tsx:693` is a bare `toggle('menu')` with no
`Keyboard.dismiss()` on that path, unlike `openSettings` (`src/app/terminal.tsx:355-363`) which does
it correctly — so this is a missed call, not a platform difference.

### Small parity gaps found the same walk

- **Camera filenames are `.jpeg`, not `.jpg`** (T8.11). `stampName` keeps the asset's extension and
  Android's camera hands back `.jpeg`. The stamp itself is correct UTC.
- **Android's own clipboard chip** pops over the bottom-left of the key bar for ~10s on every OSC 52
  yank and swallows taps there — it ate two Paste long-presses during the walk. No iOS counterpart,
  and nothing we can suppress from JS; worth knowing before blaming the key bar for a lost tap.

### TESTS.md carries three stale Expect clauses

Annotated in place during the walk rather than failed, because in each case the app is right and the
test is out of date: the conf marker is v4 not v1; the app no longer appends a `source-file` line to
the user's tmux conf (`src/tmux-model.ts:145-157`); and the tabs circle is greyed-not-hidden and no
longer keyed on the conf (`tabsAvailable = present && attached`). The numeric window badge no longer
exists as UI at all — the switcher's active card is now the only reader of `windowIndex`.

### The switcher lists — and can kill — windows of a session the phone is not attached to — FIXED, Android-verified 2026-08-17

Found by the T10 walk (2026-08-17). `LIST_WINDOWS` (`src/tmux-model.ts:230`) is `tmux list-windows
-F …` with **no `-t <session>`**, run on an exec channel that is outside any tmux client. tmux
resolves the target with its "best session" heuristic — newest `session_activity`, attachment
irrelevant. Reproduced by hand:

```
port22:   2 windows            # the user's real work, DETACHED
t13walk4: 5 windows (attached) # the phone's session
$ env -u TMUX tmux list-windows -F '#{window_id} #{window_name}'
@150 claude
@174 fish                      # port22's windows, not t13walk4's
```

Typing one character into the phone's PTY bumps its activity and the same command then answers
correctly — which is why this hides in normal use and surfaces when the phone has been idle.

**Twice during that walk the emulator's grid rendered the user's live Claude Code windows, each with
a working ✕ and one wearing the "active" ring.** Nothing was tapped. A tap would have killed real
work from a screen that looked like the phone's own tabs.

This is the same untargeted-command family as the FIXED entry "The foreground poll answers about a
window you are not looking at" — that fix targeted `pollCommand(session)` and left every *other*
command untargeted. `@id` addressing (fixed earlier today) makes each command hit the window it
names, but the *list* those ids come from is the wrong session's to begin with.

**Two fixes, both needed.** Scope every window command to the attached session, not just the poll —
and make `attached:false` tear the grid down. T10A.8 caught the second half: after the phone's own
session ended, the app logged `[tmux] {"attached":false}` and then re-listed onto the user's session
instead of dropping to §4.9 Disconnected.

### A settling card-swipe spring puts Reanimated's colour parser into exponential notation — OPEN

`src/switcher.tsx:903` builds `boxShadow: \`0 18px 30px rgba(0,0,0,${0.55 * lift.value})\``. As the
spring settles, `lift.value` gets small enough that JS renders the alpha in exponential form and
Reanimated rejects it:

```
Invalid color value: "rgba(0,0,0,7.852042303549444e-7)"
```

Red box, fires repeatedly on card swipes. Shared code, so iOS is likely exposed too — this is not an
Android divergence. Clamp or round the alpha before interpolating it into the string.

### `move-window` carries no `-d`, so a drag-reorder also switches the user's window — FIXED, Android-verified 2026-08-17

`src/tmux-model.ts:341`. Not in any Expect and not previously noticed; reordering cards in the grid
therefore moves the attached client to the window that was dragged. Needs a decision rather than a
reflexive fix — `-d` is one flag, but "reorder follows the finger" may be intended.

### `+` does not raise the keyboard on a birth (T10A.3)

`mInputShown=false` 8s after the new window lands, whether the keyboard was up or down beforehand.
Related to the key bar's missing raise (see "The key bar's swipe up does not raise the keyboard") —
both are cases where the app is expected to bring the keyboard back and no code path does it.

### Two native SIGSEGVs, noted not diagnosed

`MountingCoordinator::pullTransaction` on the `mqt_v_js` thread, twice while relaunching just after
the Reanimated red-box storm above; a third launch was clean. A separate one was seen at startup
during the T7 walk. Not deliberately reproduced, recorded so the next one is not treated as the
first.

### Walk hygiene: `/tmp/metro.log` is NOT a single-device stream

It is shared with the iOS build, so `[switcher]` / `[ribbon]` lines in it can come from another
device. A burst that looks like the emulator acting on its own may be a human on the phone. Any walk
that reasons from that log must corroborate against host-side `tmux list-windows -t <session>` or
video frames before blaming the app.

## Found by the T11 walk (2026-08-17)

### `less`'s `/` prompt and the keyboard are mutually exclusive — OPEN

T11.10. From a clean launch the cap logs `[ribbon] cap /`, raises the keyboard, and refits the
terminal `50 × 45` → `50 × 26`. The SIGWINCH redraw then **cancels less's pending `/` prompt** —
`capture-pane` shows the plain status line. When the keyboard does not rise, `/` stays up. So the
user can have the search prompt or the means to type into it, never both, and `n` is untestable in
consequence.

`htop` survives the identical resize (T11.11 passes), so this is specific to less's transient prompt
rather than a general resize fault. Worth checking whether the cap can raise the keyboard *first* and
send `/` only once the refit has settled — the reverse of the current order.

### The agent ribbon band has three caps instead of ten, and will not scroll — OPEN

T11.12, driven with a real process named `aider`. The row shows only
`⚠ ^C ^C quit · /clear · /context`; `/model`, `/usage`, `/config`, `/plugins`, 📎, ⇧⇥ and ⎋ are all
absent. Neither a 550px flick nor a slow 500px drag moves it, and the log reads
`[ribbon] band 259/252 scroll=true` — 259pt of content where the case predicts `9xx`.

The `›` chevron also sits on top of `/context` and slices it to `/conte›`, which is the exact thing
the Expect forbids.

Arming, `/context`, `/clear`-disarm, the 4s timeout and the two-tap quit all behave correctly, so the
band's machinery is fine — it is the recipe's cap list that is short.

### The neighbour preview during a bar swipe can be arbitrarily stale — DECISION NEEDED, not a plain bug

T11.2. With `watch -n1 date` running in the neighbour: last switcher visit 19:47:38, 45s of
stillness, swipe held open at 19:50:27 — the page read **19:49:11**, i.e. exactly when the *previous*
bar swipe ended. Repeated twice. So the preview is fresher than the last grid visit but has no bound.

This is a conflict between the test and a deliberate design, not a defect: `onBarSwipe('start')`
takes no capture, and the comment at `src/app/terminal.tsx:1679` says the refresh is skipped there on
purpose — "a capture per window on the JS thread is the stutter". Either the Expect gives, or the
warm-only design does. Do not "fix" it by adding the capture back without weighing that comment.

### More stale Expects in TESTS.md

Annotated in place during the T11 walk; in each case the app is right and the test is behind:
the bar has **no numeric badge** any more (the count lives in the grid footer); the last window no
longer rubber-bands leftward, because `slots = windows.length + 1` makes the new-tab page a real
neighbour that rides 1:1 and births a window when committed onto; fish prints
`terminated by signal SIGKILL (Forced quit)` rather than `Killed`; and T11.12's "peach ✳" is
U+F0D0, a wand, correctly peach.

### Harness note: drive the ribbon through the accessibility tree, not pixels

The chip and caps expose `content-desc` (`"htop actions"`, `"Destructive: kill"`, `"sort"`, …), so
`ui_tap` is far more reliable than coordinates, which shift the moment the keyboard state changes.
Two bogus results in the T11 run came from tapping stale coordinates.

## Found by the T12 / T12A walk (2026-08-17)

### The system back button loses the terminal route — OPEN

T12A.4. Back backgrounds the app but returning lands on **Setup with a live session** — the route is
gone while the session is not. `BackHandler.exitApp()` (`src/app/terminal.tsx:1403`) finishes and
recreates `MainActivity` on RN 0.86 / targetSdk 36 / API 36, so the React root remounts at the
initial route while the JS session survives underneath it.

The comment above that call asserts it does `moveTaskToBack`. It does not. Control: `keyevent 3`
(HOME) from the same state returns to the terminal correctly, which is exactly what back should have
done.

### The keyboard never returns after the settings sheet closes — OPEN

T12.2. With the keyboard up before opening, all three close paths (scrim, grabber, system back) leave
`mInputShown=false`. `keysWereUp` / `setFocusSignal` (`terminal.tsx:368,377`) does not raise the IME
on Android.

**This is the third instance of the same shape** — see also "The key bar's swipe up does not raise
the keyboard" and "`+` does not raise the keyboard on a birth". Every path that is supposed to bring
the keyboard back on Android fails to. Worth fixing as one thing: find what actually raises the IME
on Android and route all three through it, rather than three separate patches.

### `CSI ?2031n`'s push never reaches the host — OPEN, needs the iOS half before blaming Android

T12.12. The *query* half is perfect in both directions (`;1` / `;2` correctly). The theme flip never
pushes the unsolicited notification — four observations.

Caveat recorded honestly: every observation was under tmux, which may swallow an unsolicited DSR
reply. Walk the iOS half before calling this Android-specific.

### Android's `Alert` ignores `style: 'destructive'` — parity divergence

FORGET on the host-key dialog renders in the same Material teal `colorPrimary` as CANCEL, where iOS
draws it red. RN exposes no colour props for the native alert, so this cannot be fixed while the
dialog is `Alert.alert` — same class as the already-fixed Material switch-thumb teal, and the same
root as the TOFU-prompt parity entry above. Both point at building these dialogs out of the app's own
sheet chrome.

A destructive action that does not read as destructive is worth more than a cosmetic note.

### Tapping the gap above the upload sheet does not cancel it — OPEN

T12A.2. Measured while there: corner radius 24dp and top gap 60.2dp, both matching the values on
file, so the sheet's geometry is right and only the dismiss target is missing.

### Held-backspace repeat is flat on Android

~17–19 DEL/s at both 2s and 5s. The "accelerates" in the Expect is iOS's own keyboard curve, not
something the app drives — recorded as a divergence we probably cannot close rather than a bug.

## Harness corrections — these invalidate earlier "NOT PROVABLE" verdicts

- **Multitouch IS injectable after all**: protocol-B `sendevent` on `/dev/input/event2` after
  `adb root`. This drove §4.8's two-finger door in the T12A walk. Earlier walks (T6.6, T7.12, and the
  T10 two-finger cases) marked two-finger tests NOT PROVABLE on the strength of failed injection —
  **those verdicts are wrong and those cases are re-walkable.** Note `adb root` clears `adb reverse`;
  re-add it afterwards.
- **Velocity is still not injectable**: best achievable is ~250 dp/s over a short drag, against a
  500 dp/s flick threshold. Fling-specific cases remain genuinely unprovable here.
- `input swipe` does not reliably reach the RNGH ScrollView inside a sheet; a `sendevent` drag does.
- The accessibility dump lags the screen and reports garbage bounds for content scrolled out of a
  clipped ScrollView — screenshot-then-tap is needed inside the theme list.
- Gboard's stylus-handwriting onboarding overlay can hijack input mid-run:
  `settings put secure stylus_handwriting_enabled 0`.

### More stale Expects (T12 section)

T12.1's scrim is opaque `crust` so nothing shows behind the sheet, APPEARANCE is `Follow system` plus
26-scheme lists rather than "Auto + four flavour swatch rows", and TMUX has no status row. T12.6
describes a control that no longer exists at all. T12.4's "Mocha ↔ Latte" predates the two-slot
design and its "keyboard appearance" is iOS-only. T12.3's four flavours are reachable only with
`Follow system` off. And T11.1's rubber-band clause is wrong in a new way: hopping off the last
window now *creates* a third window.

**New, found while walking:** Setup's `Command` row label wraps as `Comman` / `d` beside a long start
line, in both flavours.

---

## Walk hygiene learned the hard way (2026-08-17)

- **A running app can serve a bundle older than the commit you think you are testing.** The T14 walk's
  first pass produced no `[search]` line and a blank count — it was running a pre-rewrite bundle
  because the process had been up since before the commit. `keyevent 82` does **not** open the dev
  menu on this AVD; a `force-stop` plus a deep-link relaunch is what gets a fresh bundle. Counting
  `Android Bundled` lines is necessary but not sufficient — check that the strings you are looking
  for actually appear.
- **fish's plain `clear` destroys tmux's history** (it emits E3), taking 50 012 hits to 0. Use
  `clear -x` when a case wants "clear the screen, keep the scrollback".
- **A pure connection-kill cannot produce the search's `failed` state** — the whole cycle is ~450ms
  (keystroke → 300ms debounce → ~50ms exec), so the kill lands either after the answer or before the
  debounce, and in the latter case the Disconnected overlay owns the screen anyway. Killing the
  *searched window* is the reachable route to the same rejection.
- Leaving the app's start mode on an `attach` to a session you then delete is a trap:
  `startupLine`'s fallback is `tmux new-session -A -D -s port22`, which attaches **and detaches** the
  user's live work. Park it on a custom command instead.
