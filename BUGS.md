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

## 5. `git log` cannot be scrolled with a finger

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
