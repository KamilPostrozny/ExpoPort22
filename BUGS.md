# Open bugs

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
exonerated — then check the zoom's own visibility gating, since bug 3 shows the same transition
already releases things a frame early.

---

## 6. Terminal search only sees the visible screen, not the session's scrollback

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

Note that `scrollback: 10_000` is therefore also close to dead weight while a session is under
tmux; it only earns its memory on a bare shell without tmux.

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
