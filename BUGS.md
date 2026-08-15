# Open bugs

Found on device during the T-perf accept walk (2026-08-15). Everything here is reproducible on a
real phone against a live tmux session; none of it is caused by the performance branch — where that
was in doubt it was settled by checking out `fa4cb78` (the commit before the perf work), reloading,
and reproducing the fault with the changes absent.

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

## Also open, found the same session, lower priority

### The key bar is up before the keyboard is

**Repro.** With the keyboard up, open the tabs grid, then come back to the terminal.

**Symptom.** The key bar is *already* at its keyboard-up position when the terminal appears, sitting
over an empty band, and the keyboard then slides up to meet it. It should start at the bottom and
travel up with the keyboard (user, 2026-08-15).

**Where to look.** `finishClose`'s `keysWereUp` branch raises the keys (`kbSettle` + `focusSignal`)
but never touches `keyboardPad`, which the grid froze at whatever it was before the open — a full
keyboard's worth. So the bar renders raised on the landing frame, hundreds of ms before the keyboard
it is making room for exists.

Zeroing the pad on that branch would put the bar back at the bottom, but `syncPad()` cannot be what
does it: it reads `Keyboard.metrics()`, which mid-hide still reports the departing keyboard (the
same trap the fixed chrome bug hit, and why a `keyboardDidHide` backstop had to be added). The
honest version is to record the pad the last `keyboardWillChangeFrame` ANNOUNCED — the listener
already computes it, and the freeze only needs to skip the render, not the record — and have
`syncPad` read that. It removes the backstop's own 286 → 0 flicker at the same time (device probe,
2026-08-15: the bar sits raised for the rest of every such hide). Written and then withdrawn
unverified in that session; it wants its own device walk.

That write is a plain `setState`, though, and iOS fires the event *before* the animation — so the
bar would still lead the keyboard by an animation, rather than travelling with it. Genuinely
together is an animated pad on the keyboard's own curve, which is the KeyboardAvoidingView
behaviour `keyboardPad`'s note at the top of the file deliberately does not use; read that note
before choosing which of the two this wants.

### Grid tap intermittently does nothing

Tapping a card in the tabs grid sometimes does nothing at all, then recovers by itself on the next
touch. `[switcher] select` never logs when it fails, so the tap is not reaching the handler — this
is gesture arbitration, not the select path.

`src/switcher.tsx:837` composes `Gesture.Race(drag, swipe, tap)`, where `drag` is a
`.activateAfterLongPress(300)` pan and `tap` is a `Gesture.Tap().maxDuration(300)` — the same 300ms
on both sides of the race. The file's own T10.9 note at `:765` already describes the failure mode
("the timer maturing a touch iOS already cancelled into a drag with no finger… The handler recovers
by itself on the next touch"), which matches the symptom exactly, including the self-recovery.

Reproduced on `fa4cb78` as well as on the perf branch.

### `DOM ERROR null` on every refit

Every keyboard open/close, rotation, font-size change and theme change logs a bare `DOM ERROR null`
from inside the webview, and surfaces the dev-client error overlay:

```
[terminal] tap
[terminal] size 51 × 25 … padTop 1.00     ← report() ran
DOM ERROR null
```

`[terminal] size …` is logged inside `report()` immediately before `latest.current.onResize(…)`.
That call — like all ~15 `latest.current.*` bridge calls in `src/terminal.tsx` — is a floating
promise: never awaited, never `.catch()`ed. A rejection therefore lands as an unhandled rejection,
which is what `ERROR null` is.

Reproduced on `fa4cb78`, so it predates the perf branch. The fix is to catch them where
`latest.current` is assembled (`src/terminal.tsx:315`) rather than at each call site — but note
that wrapping every handler adds a promise per call on paths as hot as `onData`, so the wrapper
should not allocate on the keystroke path.

A first attempt at catching only `onResize` did **not** silence it, so confirm which call is
actually rejecting before fixing — and log the rejection reason, because `null` says nothing.
