/**
 * The scroll gesture's brain (§4.3), kept out of the DOM component so `bun test` can reach it.
 * The webview side only reads fingers and executes what these functions decide.
 *
 * xterm.js was checked first (AGENTS.md): it already owns the hard parts — a WheelEvent dispatched
 * at the finger's coordinates is encoded by its CoreMouseService per the negotiated protocol
 * (SGR/X10/…), and `scrollLines` drives local scrollback — so wheel encoding is *not* reimplemented
 * here. What xterm does not decide is ours: when a pan is a wheel vs arrows vs local scroll, how
 * pixels become notches, which arrow bytes DECCKM wants, and how a flick decays.
 */

/** The emulator-internal mode flags T11's ribbon consumes, reported over the bridge on change. */
export type ModeSignal = {
  /** The alternate buffer is active (vim, less, htop — full-screen apps). */
  altScreen: boolean;
  /** Any mouse tracking mode is on (`CSI ?9/1000/1002/1003 h`). */
  mouseReporting: boolean;
  /** Application cursor keys (`CSI ?1 h`): arrows are SS3, not CSI. */
  decckm: boolean;
  /** Bracketed paste (`CSI ?2004 h`) — every modern shell turns it on. Pasted text has to be
   *  wrapped in `ESC[200~ … ESC[201~` while it is: without the markers the shell reads the
   *  newlines inside a paste as Return presses and runs the lines one by one, which is exactly
   *  the hazard bracketed paste exists to prevent (found on device, T13/T8.6). */
  bracketedPaste: boolean;
};

export function modesEqual(a: ModeSignal, b: ModeSignal): boolean {
  return (
    a.altScreen === b.altScreen &&
    a.mouseReporting === b.mouseReporting &&
    a.decckm === b.decckm &&
    a.bracketedPaste === b.bracketedPaste
  );
}

/** The three-way routing of §4.3. Mouse reporting wins even on the alt screen: an app that asked
 *  for the mouse wants wheel reports, and xterm falls back to arrows itself for the rare protocol
 *  that cannot carry a wheel. */
export type ScrollRoute = 'wheel' | 'arrows' | 'local';

export function scrollRoute(modes: ModeSignal): ScrollRoute {
  if (modes.mouseReporting) return 'wheel';
  if (modes.altScreen) return 'arrows';
  return 'local';
}

/** One arrow key per notch on the alt screen, DECCKM-aware: `CSI A/B` normally, `SS3 A/B` when the
 *  app (vim does, less does not) has switched the cursor keys to application mode. */
export function arrowKey(up: boolean, decckm: boolean): string {
  return `\x1b${decckm ? 'O' : '['}${up ? 'A' : 'B'}`;
}

/**
 * Pixels into whole notches — one notch per cell height — with the sub-cell remainder carried into
 * the next call, so a slow pan still adds up instead of being floored away frame after frame.
 * Positive `dy` is a finger moving down the glass, and comes back as positive notches.
 */
export function takeNotches(
  carry: number,
  dy: number,
  cellHeight: number,
): { notches: number; carry: number } {
  if (cellHeight <= 0) return { notches: 0, carry: 0 }; // no grid yet: swallow, don't divide by it
  const total = carry + dy;
  const notches = Math.trunc(total / cellHeight) || 0; // `|| 0` irons a -0 out of trunc
  return { notches, carry: total - notches * cellHeight };
}

/* --- momentum (§4.3: exponential decay, frame-rate independent) --- */

/** Decay time constant. iOS's own scroll views decelerate at 0.998/ms, which is a tau of ~500ms —
 *  matching it makes the coast feel like every other scroll on the phone. A tuning knob: the right
 *  value is decided by a thumb on hardware, not here. */
export const COAST_TAU_MS = 500;

/** A release slower than this is a stop, not a flick. px/ms; hardware-tunable like the tau. */
export const FLICK_MIN_VELOCITY = 0.25;

/** The coast is over once it has decayed below this. px/ms. */
export const COAST_MIN_VELOCITY = 0.05;

/** Nothing may coast faster than this, however many flicks stack up. A hard single flick measures
 *  ~6 px/ms on device, so this is about two of them — past that the notches per frame stop being a
 *  scroll and start being a seek. Hardware-tunable like the tau. px/ms. */
export const COAST_MAX_VELOCITY = 12;

/**
 * A flick released onto a coast the finger caught. iOS compounds these — swipe again the same way
 * and the scroll goes faster and faster — which is the behaviour a phone user expects and the one
 * an independent `startCoast(flick)` cannot give: every flick would reset to thumb speed.
 *
 * Same direction only. A flick *against* the coast is a reversal, and adding the leftover speed
 * there would subtract from what the finger just asked for — the scroll would crawl or briefly go
 * the wrong way, which is the opposite of compounding.
 *
 * A release too slow to be a flick is a stop and carries nothing — the threshold has to be read
 * against the finger's own speed, not the compounded total. Otherwise catching a fast coast and
 * then setting the scroll down deliberately would relaunch it at the speed it was caught at, which
 * is the one thing a person grabbing a runaway scroll is trying to prevent.
 */
export function compoundVelocity(flick: number, residual: number): number {
  if (Math.abs(flick) < FLICK_MIN_VELOCITY) return 0;
  const v = Math.sign(flick) === Math.sign(residual) ? flick + residual : flick;
  return Math.max(-COAST_MAX_VELOCITY, Math.min(COAST_MAX_VELOCITY, v));
}

/**
 * Where the coast has got to, `tMs` after release at `v0` px/ms: `v0·tau·(1 − e^(−t/tau))`.
 * Analytic in elapsed *time*, so a frame stepper spending `distance(now) − distance(before)` lands
 * on identical offsets at 60Hz and 120Hz — the frame-rate independence the spec demands, and the
 * thing a per-frame `v *= constant` loop gets wrong.
 */
export function coastDistance(v0: number, tMs: number): number {
  return v0 * COAST_TAU_MS * (1 - Math.exp(-tMs / COAST_TAU_MS));
}

/** How fast the coast still is, for deciding when it is over. */
export function coastVelocity(v0: number, tMs: number): number {
  return v0 * Math.exp(-tMs / COAST_TAU_MS);
}

/** How long ago a touch sample still says something about the finger's *current* speed. */
const VELOCITY_WINDOW_MS = 100;

/** Release velocity from the recent samples of a pan. A window, not the whole gesture: a pan that
 *  paused and then flicked should coast at the flick's speed, not the average's. */
export class VelocityTracker {
  private samples: { t: number; y: number }[] = [];

  add(t: number, y: number): void {
    this.samples.push({ t, y });
    while (this.samples.length > 0 && this.samples[0].t < t - VELOCITY_WINDOW_MS) {
      this.samples.shift();
    }
  }

  /** px/ms over the window; 0 until two samples exist (one position is not a velocity). */
  velocity(): number {
    const s = this.samples;
    if (s.length < 2) return 0;
    const dt = s[s.length - 1].t - s[0].t;
    return dt > 0 ? (s[s.length - 1].y - s[0].y) / dt : 0;
  }
}

/** How far a touch may wander before it stops being a possible long-press and becomes a pan. */
export const PAN_SLOP_PX = 8;

/** Longer than this and stationary fingers are a rest (or a long-press), not a tap. */
export const TAP_MS = 300;

/** A two-finger *tap* on the grid opens Settings (§4.8's second door): exactly two fingers, no
 *  finger ever moved past the slop (`panned` false), and quick. A two-finger *pan* is a scroll
 *  (§4.3) and never gets here. */
export function isTwoFingerTap(fingers: number, panned: boolean, durationMs: number): boolean {
  return fingers === 2 && !panned && durationMs < TAP_MS;
}
