# The ribbon on a real phone — the walk

The order we run TESTS.md's T11.7–T11.22 in, on device, together. It is ordered so the host is set
up once, the cheap and foundational things fail early, and the destructive / theme-changing cases
come last. Cases are defined in TESTS.md; this file is only the sequence, the host setup, and where
the screenshots go.

**Division of labour.** You drive the phone. I run Metro, read the log stream, and tell you what the
log said after each block. I take no screenshots — where a shot is needed it is marked 📸 and you
take it; I read it when you send it.

**Branch**: `worktree-ribbon-design-research`, served by Metro from
`.claude/worktrees/ribbon-design-research`. `src/`-only change, so no CI build — a reload is enough.

---

## Block 0 — bring it up (~5 min)

**Me**: take port 8081 if something else owns it, start Metro from this worktree, arm the log watch.

**You**, on the host, before connecting:

```bash
tmux kill-server                       # start from a known state
tmux new -d -s port22                  # window 1
tmux new-window -t port22              # window 2
tmux new-window -t port22              # window 3
tmux select-window -t port22:1
tmux new -d -s other 'htop'            # the second session that used to poison the poll
tmux send-keys -t port22:3 'sleep 999' Enter
```

**You**, on the phone: relaunch the app (it was talking to the old bundler), connect, land on
window 1 with the keyboard up.

**Gate before anything else**: I read the log for `[tmux] poll aimed at session port22`. If it says
`nothing (untargeted)` your start mode is `custom` or `shell` — T11.19 is then expected to flap and
we note it rather than chase it.

---

## Block A — the gate and the arrival · T11.16, T11.7

1. At the prompt, fire a dozen quick commands: `ls`, `git status`, `echo hi`, `ls -la`, … 
   **Nothing may appear.** One flash of a chip is a fail.
2. `sleep 100⏎`. Count three seconds. The chip fades up on the trailing edge: green ▶, `sleep`,
   ticking clock. It nudges sideways three times and then holds **perfectly still**.
   📸 **shot 1** — chip at rest, ~`0:06`, terminal behind it.
3. Confirm the terminal did **not** rewrap when it arrived (no line reflow, no `[terminal] size`).
4. Tap the chip. The band unrolls leftward. 📸 **shot 2** — band open.
5. Tap `^C stop`. Band rolls up, `^C` prints, chip leaves on the next beat.

I report: `[ribbon] run #…`, `[ribbon] open sleep`, `[ribbon] cap ^C`.

---

## Block B — the clock · T11.18

The fix I most want on the phone: the clock was frozen at `0:00` for a whole session, and every
window hop restarted it.

1. `sleep 300⏎`. Watch the clock for a full 30 seconds without touching the phone. It must tick
   every second and the digits must not jitter.
2. Bar-swipe to window 2 (idle). The band leaves.
3. Wait 5s. Swipe back to window 1.
4. The chip returns. **Up to one poll beat of `0:00` is allowed**, then it must jump to the real
   elapsed time (~`0:40`) and carry on. A chip that settles at `0:00` and counts up from there is
   the bug, not a pass.
   📸 **shot 3** — the chip right after the hop back, once it has settled.
5. `^C` to clear.

---

## Block C — whose window is it · T11.19, T11.20

`sleep 999` is running in window 3 and `htop` in the `other` session; that is the environment that
broke the poll.

1. `sleep 300⏎` on window 1. Sit **completely still** for 60 seconds. Watch the chip, the tabs
   badge, and let me watch `[tmux]`. Nothing may flicker, swap process, or animate in twice.
2. Hop to window 2 and watch the trailing edge for three seconds after the slide lands. The band
   must not come back for a beat. Hop back and forth five or six times.
3. `^C` to clear.

I report: whether `windowIndex` held constant across ~30 beats.

---

## Block D — suspend and kill · T11.8, T11.15

1. `sleep 100⏎`; arm Ctrl on the key bar, tap `Z` in the chord strip. Shell prints `[1]+ Stopped`.
2. Within ~2s the chip goes grey ⏸ and reads `sleep · stopped`, **with no 3s wait**.
   📸 **shot 4** — the stopped chip.
3. Tap it: caps are `! kill force` · `bg run behind` · `fg resume`. Tap `fg resume` — the green
   running chip is back on the next beat with a fresh clock.
4. `sleep 100⏎` again, open the band, tap the red `! kill force`. Shell prints `Killed`.

I report: `[ribbon] kill-force: pgrep -P <pid> | xargs kill -9 …` and its `[ssh] exec` line — it
must go out on an exec channel, never typed into the PTY.

---

## Block E — the named recipes · T11.9, T11.10, T11.11

Vim first, because it carries the scrim fix.

1. `vim /tmp/t11.txt⏎`, press `i`, type a line, **stay in insert mode**.
2. Tap the chip to open the band. **With the band open, tap `Esc` on the key bar.** It must fire
   Esc. (The old full-screen scrim ate that tap — the first tap on any bar key only closed the
   panel, so combining a cap with a modifier was impossible.) 📸 **shot 5** — band open with the key
   bar visible below it.
3. Close it four ways in turn: chip tap · tap the terminal well above the band · Android hardware
   back (skip on iOS) · a cap tap. On iOS also open it by swiping the chip left.
4. Caps left→right: `! :q! discard` · `:q quit` · `/ search` · `ZZ save+quit` · `:w save`. Tap `:w`
   from insert mode — it must save. Type more, open, `ZZ`. Reopen vim, dirty it, tap red `:q!`.
5. `man ls⏎`: `G` to the end, `g` to the top, then `/` — the keyboard must rise **and the band stay
   open, riding up with the bar in one step**, no gap and no second animation. Type `SYNOPSIS⏎`,
   then tap `n` without reopening. `q` exits.
6. `htop⏎`: `/` filter (keyboard up, band still open), Esc; `F9` opens SendSignal, Esc; `F6` sorts;
   `q` exits. Four caps, no scrolling.

---

## Block F — the agent band · T11.12

Needs `claude` (or `codex`/`aider`/`gemini`) running in the pane.

1. Start it. The peach ✳ chip appears on the first beat — **named recipes are not gated** — with a
   ticking clock.
2. Tap it. The band is still exactly the same 52pt as `sleep`'s three caps. Ten caps in one flat
   row, resting at the leading end: `! ^C^C quit` · `/clear` · `/context`, and a `›` chevron in its
   own gutter. 📸 **shot 6** — the ten-cap band. **Check the chevron sits beside the caps, never on
   top of one slicing its label.**
3. Flick the row left and right. It must not scroll vertically, and a near-vertical drag must do
   nothing.
4. Tap `/context` — types the command, presses Return, band closes.
5. Reopen, `⇧⇥ plan mode`.
6. Reopen, `📎 attach`, pick a photo. **During the send only that cap tints accent and goes inert**;
   the others stay live. The remote path plus one trailing space is typed — no Return.
   📸 **shot 7** — mid-send, the inert 📎 cap.
7. Reopen, tap the red `^C ^C quit` **once**: one interrupt goes, the band stays open, the cap
   re-labels `tap again` with a stronger red ring. 📸 **shot 8** — the armed cap. Now tap `/clear`
   instead — it must disarm without firing the second interrupt, and run /clear.
8. Reopen, arm it again, tap it twice. Claude quits, band closes.

I report: `[ribbon] band 9xx/2xx scroll=true` — the overflow is measured, not counted.

---

## Block G — geometry · T11.14

1. `sleep 300⏎`. Raise and dismiss the keyboard. The band rides up and down **in the same step as
   the bar**, always 6pt above the bar stack, never lagging on its own baseline.
2. Arm Ctrl so the chord strip appears; disarm. Same thing, ~172pt of bottom chrome while armed.
   📸 **shot 9** — band open with the keyboard up and the chord strip armed (the worst-case stack).
3. Open the band, then grab the bar and swipe up into the switcher. The band closes and fades out
   with the bar — never left hanging mid-zoom.
4. Through all of it the terminal's rows must never rewrap except for the keyboard's own refit.

---

## Block H — readability, the adversarial pass · T11.17, T11.21

The case the old design never had. Dark first, light second.

1. `htop` on the host (full-width colour bars), band open. 📸 **shot 10**.
2. `bat CLAUDE.md` (dense syntax colour), band open. 📸 **shot 11**.
3. Switch to **Latte**, repeat both at full brightness. 📸 **shots 12, 13**. Check the red danger
   cap — bold, with a ⚠ — is legible; on Latte it is the tightest ratio in the design.
4. Switch to a generated light scheme (**Rose Pine Dawn**). 📸 **shot 14**. Here the question is not
   the text but the **plate**: can you find the band's edge against the pane at all? It floats on a
   shadow, plus a 6% ground on light schemes.
5. Back to your usual scheme.

In every shot the plate must be fully opaque: no colour bar and no syntax highlight may show through
it or change any of its colours.

---

## Block I — motion and accessibility · T11.22

1. iOS Settings → Accessibility → Motion → **Reduce Motion on**.
2. `sleep 100⏎`. The chip **fades** in, plays no nudge, is fully visible and perfectly still. Open
   and close twice — instant, no glide.
3. Reduce Motion **off**. Confirm the nudge is back: three cycles, then still forever.
4. Optional, if you want it covered: VoiceOver on, `sleep 100⏎` — it announces "sleep actions
   available" without stealing focus, and the chip reads as a button with an expanded state.

---

## Block J — the silences · T11.13

Last, because it is the cheapest and proves the quiet cases are decisions rather than misses.

1. Sit at the prompt 5s — nothing.
2. `python3`, sit at `>>>` 5s — nothing. `exit()`.
3. `nano` (or any alt-screen app on no list) 5s — nothing.

I confirm from `[tmux]` that the foreground genuinely changed each time.

---

## Scoreboard

Tick TESTS.md as we go. Anything that fails: I want the shot, the log window around it, and we stop
and fix rather than carrying on — the last five commits on this branch all came out of exactly this
kind of walk.
