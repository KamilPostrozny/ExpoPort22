# Open bugs

Found on device during the T-perf accept walk (2026-08-15). Everything here is reproducible on a
real phone against a live tmux session; none of it is caused by the performance branch — where that
was in doubt it was settled by checking out `fa4cb78` (the commit before the perf work), reloading,
and reproducing the fault with the changes absent.

Fixed and confirmed the same session, for context on what is *not* in this list: `less` refusing to
scroll (root-table wheel bindings missing from the pushed tmux conf), and the grid's tabs vanishing
and refilling while typing a query (`windowSurvives` treated "grep still in flight" as "no match").

---

## 1. Terminal search view keeps the zoom's chrome after leaving the grid

**Repro.** Open the tabs grid, arm the search, leave the grid back to the terminal.

**Symptom.** Two things stay behind that belong to the grid/zoom state:

- the pane keeps its rounded corners under the search bar, instead of squaring off to the screen
  edge at rest;
- the key bar sits raised, at its keyboard-up position, with no keyboard on screen and dead space
  below it.

**Where to look.** `pageRadius(stageW)` in `src/barswipe-model.ts` is documented as "0 at rest", so
a non-zero radius means the page card still believes a swipe or zoom is live. The raised key bar is
the same shape of problem on the inset: something that is set on the way *into* the grid is not
being unset on this particular way out. The exit path taken when search is armed is the suspect —
the ordinary exit does not do this.

**Not yet investigated.** No instrumentation has been added for this one.

---

## 2. Search does not scroll to the current hit

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
`terminal.select()` is landing, since bug 3 suggests the active decoration's element may never be
rendered at all. **These two are probably one bug.**

---

## 3. No distinct highlight on the current hit

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
and, probably, bug 2. The alternative is vendoring `SearchAddon`.

---

## 4. The outgoing card shows the incoming tab's contents for a frame

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

## 5. Neighbour cards do not reliably leave during the swipe up

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
exonerated — then check the zoom's own visibility gating, since bug 4 shows the same transition
already releases things a frame early.

---

## Also open, found the same session, lower priority

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

### One exec per grid open fails, and kills fail the same way

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

**Where to look.** `killWindowCommand`/`capturePaneCommand` in `src/tmux-model.ts` take an index;
`src/switcher.tsx` schedules the captures. Logging the index alongside the failure would settle it
in one grid open — if the failing index is always one that is not in the current list, it is
confirmed.

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

---

## Not a bug: the one perf change nobody has measured

`package.json` carries `reanimated.staticFeatureFlags.IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS: true`
(added in `e75141f`). It is compiled into the native build, so it only takes effect in a fresh IPA.

It is recorded here because it is the single change from the performance audit with **no
measurement behind it**, and that fact is easy to lose. On the build where it first became active
the app "felt solid" and JS sat around 50 — but the flag targets the *UI* thread, not JS, and the
comparison was against a quieter session, so neither number says anything about it. It has not been
shown to help and has not been shown to hurt.

Either measure it — the perf overlay's UI figure, same session, same load, flag on and off — or
take it out. Do not leave it sitting here as something everyone assumes was justified.
