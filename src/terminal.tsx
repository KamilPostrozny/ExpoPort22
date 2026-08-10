'use dom';

/**
 * The terminal itself: xterm.js in a webview, driven from native through this file's props.
 *
 * xterm.js is the reason there is no native terminal view here — xterm-256color, DECCKM,
 * alt-screen tracking, mouse-protocol negotiation, OSC 8 and OSC 52, scrollback and selection are
 * all things it already does correctly, and all things a hand-written emulator gets wrong for a
 * year. What this file adds is only what xterm leaves to its embedder: the Catppuccin theme, the
 * bundled Nerd Font, the two sequences the app answers itself (§4.7 clipboard, §4.2 appearance
 * query), and the bridge back to native.
 *
 * Everything crossing that bridge is JSON: bytes come in base64 (a read can split a UTF-8
 * sequence, so xterm gets the `Uint8Array` and does the decoding), keystrokes go out as strings.
 */

import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useDOMImperativeHandle, type DOMImperativeFactory, type DOMProps } from 'expo/dom';
import { useEffect, useRef, type Ref } from 'react';

import { fromBase64 } from '@/base64';
import {
  COAST_MIN_VELOCITY,
  FLICK_MIN_VELOCITY,
  PAN_SLOP_PX,
  VelocityTracker,
  arrowKey,
  coastDistance,
  coastVelocity,
  isTwoFingerTap,
  modesEqual,
  scrollRoute,
  takeNotches,
  type ModeSignal,
} from '@/scroll-model';
import { isHttpLink, parseOsc52 } from '@/terminal-protocol';
import { MONO, type Theme } from '@/theme';
// (`ModeSignal` cannot be re-exported from here: a 'use dom' module allows only its default
//  export to leave. T11 imports it from '@/scroll-model', where it lives.)

// Deliberately not `extends DOMImperativeFactory`: its index signature types every method as
// taking `JSONValue`s, which would let a caller write a number at the terminal. The bridge only
// carries JSON either way, so the cast at the hook below is the whole cost of saying `string`.
export type TerminalHandle = {
  /** Shell output, base64 — the wire format `ExpoSSH` emits. */
  write(base64: string): void;
  /** T14: highlight every occurrence of `query` in the buffer and land on the next one. The
   *  incremental form — a growing query stays on the same hit while it still matches. */
  search(query: string): void;
  searchNext(query: string): void;
  searchPrev(query: string): void;
  /** Disarm: clear the decorations and the cached term. */
  searchOff(): void;
};

export type TerminalProps = {
  theme: Theme;
  fontSize: number;
  /** Keystrokes, and the replies this file writes on the app's behalf, on their way to the PTY. */
  onData: (data: string) => Promise<void>;
  /** After a settled rotation, keyboard move or font change — what the host's window size is now. */
  onResize: (cols: number, rows: number) => Promise<void>;
  /** The terminal exists and knows its size. Fires again on every reload of the webview — iOS reaps
   *  a backgrounded one — which is the moment the session has to be painted back in. */
  onBoot: () => Promise<void>;
  onBell: () => Promise<void>;
  /** An OSC 52 yank, already decoded. Reads are refused before they get here. */
  onClipboard: (text: string) => Promise<void>;
  /** An OSC 8 link the user tapped, always `http(s)`. */
  onLink: (url: string) => Promise<void>;
  /** The emulator-internal mode flags (§4.4 ribbon signals), fired on change and once per boot as
   *  the baseline. T11's context ribbon is the consumer; §4.3's scroll routing reads the same flags
   *  but inside the webview, where they are fresh rather than a bridge hop old. */
  onModes: (modes: ModeSignal) => Promise<void>;
  /** A two-finger tap on the grid — §4.8's second door to Settings. Detected here because the
   *  touch layer below already owns the two-finger *pan*, and only it can tell the two apart. */
  onTwoFingerTap: () => Promise<void>;
  /** T14: the search addon's live occurrence count — `index` is 0-based, −1 past the highlight
   *  limit; `count` 0 = no hits. Feeds the "i/N" label beside the terminal's search field. */
  onSearchResults: (index: number, count: number) => Promise<void>;
  ref?: Ref<TerminalHandle>;
  dom?: DOMProps;
};

/** tmux's appearance query (`CSI ? 996 n`), which every other `CSI ? … n` has to fall through. */
const COLOR_SCHEME_QUERY = 996;

const ANSI_SLOTS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

function xtermTheme(theme: Theme): ITheme {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    // The glyph under a block cursor. `background` inverts it against the cursor colour, which is
    // the only way a character stays readable while the cursor sits on it.
    cursorAccent: theme.background,
    selectionBackground: theme.selection,
    ...Object.fromEntries(ANSI_SLOTS.map((slot, i) => [slot, theme.ansi[i]])),
  };
}

/** The font the webview cannot get from the native side: same two files as `useFonts` loads for
 *  chrome, copied into `public/` because that is the one directory that reaches this bundle. */
const FONT_FACES = ['Regular', 'Bold']
  .map(
    (weight, i) => `@font-face {
      font-family: '${MONO}';
      src: url('${process.env.EXPO_BASE_URL ?? ''}fonts/JetBrainsMonoNerdFontMono-${weight}.ttf');
      font-weight: ${i === 0 ? 400 : 700};
    }`,
  )
  .join('\n');

const CSS = `
  ${FONT_FACES}
  html, body { margin: 0; height: 100%; overflow: hidden; }
  /* Long-press has to reach the system edit menu (§4.2), so the rows stay real selectable text —
     xterm turns selection off because it drives its own from mouse events, which a finger is not.
     The whole chain down to the rows has to allow it: WebKit starts the gesture from the container
     under the finger, so one "none" anywhere above the text is enough to stop it happening. */
  .xterm, .xterm .xterm-screen, .xterm .xterm-rows, .xterm .xterm-rows * {
    -webkit-user-select: text;
    user-select: text;
    -webkit-touch-callout: default;
  }
  /* Except the parts that are not text: the hidden textarea and the measuring elements. */
  .xterm .xterm-helpers { -webkit-user-select: none; user-select: none; }
  /* The webview must not rubber-band: a pan is a scroll for the session, never for the page. */
  .xterm-viewport { overscroll-behavior: none; }
`;

/**
 * One line saying whether the bundled font actually arrived. A webview that fell back to the system
 * monospace looks perfectly fine until a Nerd Font glyph turns up as a box, and by then the cell
 * width is wrong too — so measure it rather than trust it. In a monospaced font every glyph is one
 * cell wide, including the private-use ones; a fallback gives a different width for the glyph it
 * does not have. Logging is deliberate here (PLAN.md §7): this file has no other way to speak.
 */
function fontReport(fontSize: number): string {
  const loaded = document.fonts.check(`${fontSize}px ${MONO}`);
  const bold = document.fonts.check(`bold ${fontSize}px ${MONO}`);
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return `font ${MONO} loaded=${loaded} (no canvas to measure with)`;
  /** `font` is a full CSS font shorthand, so a weight can sit in front of the size. */
  const width = (font: string, text: string) => {
    context.font = font;
    return context.measureText(text).width.toFixed(2);
  };
  const regular = `${fontSize}px ${MONO}`;
  return (
    `font ${MONO} loaded=${loaded} bold=${bold} cell=${width(regular, 'M')} ` +
    `bold-cell=${width(`bold ${regular}`, 'M')} ` +
    `nerd-glyph=${width(regular, '')} system-mono-cell=${width(`${fontSize}px monospace`, 'M')}`
  );
}

export default function TerminalView({ theme, fontSize, ref, ...handlers }: TerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const resizer = useRef<(() => void) | null>(null);
  // Native re-marshals every prop on every render, so the terminal reads them through this ref
  // instead of being torn down and rebuilt each time a callback's identity changes.
  const latest = useRef({ theme, ...handlers });
  useEffect(() => {
    latest.current = { theme, ...handlers };
  });

  // The one decoration set both directions share. Backgrounds must be #RRGGBB (addon contract):
  // every role here is a palette hex. The ruler colours are required by the type; no ruler is on.
  const searchOptions = () => {
    const t = latest.current.theme;
    return {
      decorations: {
        matchBackground: t.selection,
        activeMatchBackground: t.warning,
        matchOverviewRuler: t.warning,
        activeMatchColorOverviewRuler: t.warning,
      },
    };
  };

  const handle: TerminalHandle = {
    write: (base64) => terminal.current?.write(fromBase64(base64)),
    search: (query) => {
      if (query === '') search.current?.clearDecorations();
      else search.current?.findNext(query, { ...searchOptions(), incremental: true });
    },
    searchNext: (query) => search.current?.findNext(query, searchOptions()),
    searchPrev: (query) => search.current?.findPrevious(query, searchOptions()),
    searchOff: () => search.current?.clearDecorations(),
  };
  useDOMImperativeHandle(
    (ref ?? null) as Ref<DOMImperativeFactory>,
    () => handle as DOMImperativeFactory,
    [],
  );

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    // xterm measures the cell once, when it opens, and never again on its own. Opening before the
    // bundled font has arrived measures the fallback, and every row is then laid out at a pitch the
    // glyphs do not fill — the letters end up spaced apart like a ransom note. So: font first,
    // terminal second. The file is local, so the wait is a frame, not a network round trip.
    // Both faces, not just the regular one: bold is a separate file, and a bold run rendered from
    // the system fallback is wider than the cell it was measured for.
    Promise.all([
      document.fonts.load(`${fontSize}px ${MONO}`),
      document.fonts.load(`bold ${fontSize}px ${MONO}`),
    ])
      .catch((error) => console.log('[terminal] font failed to load:', String(error)))
      .then(() => {
        if (disposed) return;
        console.log('[terminal]', fontReport(fontSize));
        cleanup = boot();
      });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  /** Builds the terminal and everything hanging off it; returns its teardown. */
  function boot() {
    const term = new Terminal({
      fontFamily: MONO,
      fontSize,
      theme: xtermTheme(theme),
      scrollback: 10_000,
      cursorBlink: true,
      // T14: the search addon's highlight decorations ride `registerDecoration`, which xterm 6
      // gates behind this flag (thrown on device: "You must set the allowProposedApi option").
      allowProposedApi: true,
      // xterm drops non-http schemes before this, and `isHttpLink` says so again: the host writes
      // these strings, and one of the two checks is a version bump away from changing.
      linkHandler: {
        activate: (_event, uri) => {
          if (isHttpLink(uri)) latest.current.onLink(uri);
        },
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // T14's terminal-side search. Checked (AGENTS.md): @xterm/addon-search 0.16.0 rides only the
    // public API (registerDecoration, translateToString), so xterm 6 carries it; its decorations
    // are the highlight, its result event the "i/N" label — nothing reimplemented here.
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    const searchResults = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      latest.current.onSearchResults(resultIndex, resultCount);
    });
    term.open(host.current!);
    terminal.current = term;
    fit.current = fitAddon;
    search.current = searchAddon;

    // T7: the keyboard is native now (T4's decision), so the webview must never take focus. The
    // helper textarea xterm keeps for real keyboards is disabled outright — xterm's own mousedown
    // focus call then no-ops and focus stays on the body, which is also exactly the state T4
    // measured long-press selection to need.
    if (term.textarea) term.textarea.disabled = true;

    // A long-press selection is the system's, not xterm's, so it fires no xterm event and leaves no
    // other trace: without this line there is no way to tell "the gesture never started" from "it
    // selected and the menu did not draw".
    const onSelectionChange = () => {
      const text = document.getSelection()?.toString() ?? '';
      console.log('[terminal] selection', JSON.stringify(text.slice(0, 40)));
    };
    document.addEventListener('selectionchange', onSelectionChange);

    // iOS synthesises a mouse pair when a touch gesture ends. xterm answers those by focusing its
    // textarea and clearing the document selection — which is the selection the finger just made,
    // so the edit menu is dismissed in the same frame it would have appeared. Touch is ours (§4.3
    // puts scrolling here too), so xterm sees only what this file hands it: the synthetic wheel
    // events `bindTouch` below dispatches when mouse reporting is on.
    // Long-press selection is the system's, and it comes with a platform constraint measured here
    // rather than assumed. An identical press on `.xterm-screen`, same target and same computed
    // `user-select`, selects when focus sits on the body and selects nothing when focus sits on
    // xterm's helper textarea — WebKit classifies the touch when it begins, from the focus state at
    // that moment. Releasing focus during the press is too late (measured: 2.4s hold, nothing
    // selected), and JS has no earlier hook. So: keyboard down, a long-press selects and the system
    // edit menu appears; keyboard up, it cannot, and no amount of CSS or event juggling changes it.
    //
    // ponytail: leaves §4.2's long-press behind the keyboard being down. The upgrade path, when the
    // key bar lands, is xterm's own selection (`term.select`, `getSelection()`) with a Copy control
    // on the bar — full control, no WebKit gesture involved, and what native iOS terminals do.

    term.onData((data) => latest.current.onData(data));
    term.onBell(() => latest.current.onBell());
    // Mouse reports xterm encodes for the wheels synthesized below. SGR (what tmux, htop and
    // anything from this decade negotiates) is ASCII and arrives via `onData`; only the legacy
    // single-byte DEFAULT encoding comes through here, as a string of raw char codes.
    // ponytail: a DEFAULT-encoded report with a coordinate byte over 127 gets UTF-8-mangled by the
    // native `send` path. Real only for a pre-SGR app past column 95; the upgrade path is a
    // `sendBase64` on the native module.
    term.onBinary((data) => latest.current.onData(data));

    // The mode flags: read on demand for scroll routing, pushed over the bridge when they change
    // (T11's ribbon). xterm exposes them read-only (`modes`, `buffer`) with no change event, so the
    // watch is the buffer-switch event plus a peek after every DECSET/DECRST — the handlers return
    // false so xterm still applies them, and the microtask runs after the write chunk has been
    // fully parsed, when `term.modes` is up to date.
    const currentModes = (): ModeSignal => ({
      altScreen: term.buffer.active.type === 'alternate',
      mouseReporting: term.modes.mouseTrackingMode !== 'none',
      decckm: term.modes.applicationCursorKeysMode,
      bracketedPaste: term.modes.bracketedPasteMode,
    });
    let reportedModes: ModeSignal | null = null;
    const reportModes = () => {
      const next = currentModes();
      if (reportedModes !== null && modesEqual(reportedModes, next)) return;
      reportedModes = next;
      console.log('[terminal] modes', JSON.stringify(next));
      latest.current.onModes(next);
    };
    term.buffer.onBufferChange(() => reportModes());
    const peek = () => {
      queueMicrotask(reportModes);
      return false; // ours is a peek, not a handler — xterm's own must still run
    };
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, peek);
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, peek);

    const teardownTouch = bindTouch(term, currentModes);

    term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52(data);
      if (text !== null) latest.current.onClipboard(text);
      return true; // Yanked or refused, an OSC 52 never travels any further.
    });
    term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
      if (params[0] !== COLOR_SCHEME_QUERY) return false;
      latest.current.onData(latest.current.theme.colorSchemeNotification);
      return true;
    });

    // One resize per settled gesture: rotation and the keyboard both animate, and tmux redraws the
    // whole session for every size it is told about (§4.2).
    let settle: ReturnType<typeof setTimeout>;
    let reported = { cols: 0, rows: 0 };
    // Only a size the host has not been told about is worth a round trip. Without this the same
    // `cols × rows` goes back on every fit, and since the answer re-renders the native side — which
    // re-marshals the props, which re-runs the effect below — it never stops.
    const resize = () => {
      fitAddon.fit();
      if (term.cols === reported.cols && term.rows === reported.rows) return;
      reported = { cols: term.cols, rows: term.rows };
      console.log('[terminal] size', term.cols, '×', term.rows);
      latest.current.onResize(term.cols, term.rows);
    };
    resizer.current = resize;
    const observer = new ResizeObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(resize, 150);
    });
    observer.observe(host.current!);
    resize();
    latest.current.onBoot();
    reportModes(); // the baseline: a webview that just booted owes T11 the current state

    return () => {
      clearTimeout(settle);
      observer.disconnect();
      teardownTouch();
      searchResults.dispose();
      term.dispose();
    };
  }

  /**
   * The §4.3 touch layer: any *moving* touch is a scroll — one or two fingers alike — while a
   * stationary long-press stays WebKit's, so the T4 selection path survives untouched. Movement
   * under the slop is left entirely alone (no preventDefault), which is exactly the window WebKit
   * needs to begin a long-press; past the slop the touch is claimed and every further move is
   * cancelled, which is also what kills WebKit's own pending gestures for it.
   *
   * Routing per notch, decided fresh from the mode flags each time pixels are spent:
   * - `wheel`: a synthetic WheelEvent at the finger's coordinates, dispatched at xterm. Checked in
   *   the xterm 6 source rather than assumed: its wheel listener feeds CoreMouseService, which
   *   derives the cell from `clientX/clientY` and encodes per the negotiated protocol (SGR via
   *   `onData`, legacy DEFAULT via `onBinary`) — so the encoding is xterm's, not reimplemented
   *   here, and `deltaMode: DOM_DELTA_LINE, deltaY: ±1` is exactly one report. Its always-on
   *   listener even downgrades a wheel to arrows itself for a protocol with no wheel (X10).
   * - `arrows`: one DECCKM-aware arrow per notch, through the same `onData` bridge as keystrokes.
   * - `local`: `term.scrollLines`, the public scrollback API.
   */
  function bindTouch(term: Terminal, currentModes: () => ModeSignal) {
    const el = host.current!;
    let pan: 'idle' | 'pending' | 'panning' = 'idle';
    let panX = 0;
    let panY = 0;
    let carry = 0;
    let tracker = new VelocityTracker();
    let coast: number | null = null;
    /** For the two-finger tap (§4.8): how many fingers this touch ever had, and when it began. */
    let fingers = 0;
    let downAt = 0;

    // Measured, not asked for: the screen element is exactly `rows` cells tall, and xterm's cell
    // metrics live on internal services.
    const cellHeight = () => {
      const screen = term.element?.querySelector('.xterm-screen');
      return screen && term.rows > 0 ? screen.getBoundingClientRect().height / term.rows : 0;
    };

    /** Turns accumulated pixels into notches and routes them. `x`/`y` is where the finger is —
     *  where a wheel report has to land. */
    const spend = (dy: number, x: number, y: number) => {
      const taken = takeNotches(carry, dy, cellHeight());
      carry = taken.carry;
      if (taken.notches === 0) return;
      const modes = currentModes();
      const route = scrollRoute(modes);
      const up = taken.notches > 0; // finger down the glass = toward earlier content
      console.log('[terminal] scroll', route, taken.notches);
      if (route === 'local') {
        term.scrollLines(-taken.notches);
        return;
      }
      for (let i = 0; i < Math.abs(taken.notches); i++) {
        if (route === 'wheel') {
          term.element?.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: up ? -1 : 1,
              deltaMode: WheelEvent.DOM_DELTA_LINE,
              clientX: x,
              clientY: y,
              cancelable: true,
            }),
          );
        } else {
          latest.current.onData(arrowKey(up, modes.decckm));
        }
      }
    };

    const stopCoast = () => {
      if (coast !== null) cancelAnimationFrame(coast);
      coast = null;
    };

    /** Momentum: spend `distance(now) − distance(already spent)` per frame off the analytic decay
     *  curve, so 60Hz and 120Hz walk the same offsets (proved in scroll-model.test.ts). The wheels
     *  keep landing where the finger last was. */
    const startCoast = (v0: number, x: number, y: number) => {
      if (Math.abs(v0) < FLICK_MIN_VELOCITY) return;
      console.log('[terminal] coast start', v0.toFixed(3), 'px/ms');
      const t0 = performance.now();
      let spent = 0;
      const step = () => {
        const t = performance.now() - t0;
        const d = coastDistance(v0, t);
        spend(d - spent, x, y);
        spent = d;
        coast =
          Math.abs(coastVelocity(v0, t)) < COAST_MIN_VELOCITY ? null : requestAnimationFrame(step);
      };
      coast = requestAnimationFrame(step);
    };

    const touchStart = (ev: TouchEvent) => {
      if (coast !== null) {
        // §4.3: a touch during the coast stops it and does nothing else — not a tap, not a
        // long-press, not a new pan. preventDefault is what makes WebKit agree about the rest.
        stopCoast();
        pan = 'idle';
        ev.preventDefault();
        return;
      }
      const t = ev.touches[0];
      if (pan !== 'idle') {
        // A second finger joining a pan: same scroll, rebased so the handover does not jump.
        panX = t.clientX;
        panY = t.clientY;
        fingers = Math.max(fingers, ev.touches.length);
        return;
      }
      pan = 'pending';
      panX = t.clientX;
      panY = t.clientY;
      carry = 0;
      fingers = ev.touches.length;
      downAt = ev.timeStamp;
      tracker = new VelocityTracker();
      tracker.add(ev.timeStamp, t.clientY);
    };

    const touchMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (pan === 'pending') {
        // Once WebKit has begun a selection, the moves are its drag handles, not a pan (T4).
        if (document.getSelection()?.isCollapsed === false) {
          pan = 'idle';
          return;
        }
        if (Math.hypot(t.clientX - panX, t.clientY - panY) < PAN_SLOP_PX) return;
        pan = 'panning';
        panY = t.clientY; // the slop is spent on deciding, not scrolled
        tracker = new VelocityTracker();
        tracker.add(ev.timeStamp, t.clientY);
        ev.preventDefault();
        return;
      }
      if (pan !== 'panning') return;
      ev.preventDefault();
      const dy = t.clientY - panY;
      panX = t.clientX;
      panY = t.clientY;
      tracker.add(ev.timeStamp, t.clientY);
      spend(dy, t.clientX, t.clientY);
    };

    const touchEnd = (ev: TouchEvent) => {
      if (ev.touches.length > 0) {
        // One of two fingers lifted: keep panning on the survivor, rebased.
        panX = ev.touches[0].clientX;
        panY = ev.touches[0].clientY;
        return;
      }
      if (pan === 'panning') startCoast(tracker.velocity(), panX, panY);
      // A one-finger tap on a live selection clears it. xterm would normally do this itself, off
      // the synthetic mouse pair iOS sends — but its textarea is disabled and touch is ours, so
      // that path is gone and without this the selection and its edit menu simply stay (T13/T6.7).
      if (pan === 'pending' && fingers === 1 && document.getSelection()?.isCollapsed === false) {
        document.getSelection()?.removeAllRanges();
      }
      // Two fingers that never became a pan and lifted quickly: §4.8's Settings door. Routed out
      // over the bridge — only this layer can tell the tap from the two-finger scroll it owns.
      if (pan === 'pending' && isTwoFingerTap(fingers, false, ev.timeStamp - downAt)) {
        console.log('[terminal] two-finger tap');
        latest.current.onTwoFingerTap();
      }
      pan = 'idle';
    };

    const touchCancel = () => {
      pan = 'idle';
    };

    // passive: false on start and move — both call preventDefault, and a passive listener's
    // preventDefault is a console warning, not a cancel.
    el.addEventListener('touchstart', touchStart, { passive: false });
    el.addEventListener('touchmove', touchMove, { passive: false });
    el.addEventListener('touchend', touchEnd);
    el.addEventListener('touchcancel', touchCancel);
    return () => {
      stopCoast();
      el.removeEventListener('touchstart', touchStart);
      el.removeEventListener('touchmove', touchMove);
      el.removeEventListener('touchend', touchEnd);
      el.removeEventListener('touchcancel', touchCancel);
    };
  }

  // A flavour change restyles the live session (§4.8); a font-size change resizes it (§4.2).
  // Keyed on the flavour's *name*, not the theme object: the object is rebuilt by the bridge on
  // every render, so an identity comparison here would make this effect run forever.
  const lastFlavour = useRef(theme.name);
  useEffect(() => {
    const flipped = lastFlavour.current !== theme.name;
    lastFlavour.current = theme.name;
    const term = terminal.current;
    if (!term) return;
    const { theme: current } = latest.current;
    document.body.style.background = current.background;
    term.options.theme = xtermTheme(current);
    term.options.fontSize = fontSize;
    resizer.current?.();
    // §4.2's other half: a mid-session flavour switch (`auto` following a system flip included)
    // *pushes* the DECSET 2031 notification at the host, so a vim or tmux that asked `?996n` once
    // is told the answer changed rather than left on the stale one. Subscribers (fish 4) treat it
    // as "re-query"; everyone else parses and drops it. Boot is not a switch — nothing asked yet.
    if (flipped) latest.current.onData(current.colorSchemeNotification);
  }, [theme.name, fontSize]);

  return (
    <>
      <style>{CSS}</style>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
    </>
  );
}
