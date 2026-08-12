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
  TAP_MS,
  VelocityTracker,
  arrowKey,
  coastDistance,
  coastVelocity,
  compoundVelocity,
  isTwoFingerTap,
  modesEqual,
  scrollRoute,
  takeNotches,
  type ModeSignal,
} from '@/scroll-model';
import { MONO_ADVANCE } from '@/switcher-model';
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
  /** After a settled rotation, keyboard move or font change — what the host's window size is now,
   *  and the cell it is drawing on. The cell is measured rather than assumed because `cols` cells
   *  do NOT fill the box they sit in: the fit reserves a scrollbar gutter that never renders, ~15pt
   *  of it, so 48 cells occupy 374 of 395pt on device. A snapshot that spreads the same columns
   *  across the whole box therefore draws ~6% large — a step in size at the zoom's crossfade, which
   *  two photographs of the same card caught (2026-08-10). */
  onResize: (
    cols: number,
    rows: number,
    cellW: number,
    cellH: number,
    padTop: number,
  ) => Promise<void>;
  /** Hold the size where it is: no fit, no report, until it goes false again (then one of each).
   *  §4.5's zoom animates the stage's *height*, and the keyboard leaves on the way in — so an
   *  unheld transition walks the PTY through half a dozen row counts (26 → 41 → 29 → 26 on
   *  device), tmux reflows the pane for every one of them, and both the surface being scaled and
   *  every snapshot taken behind it rewrite themselves mid-flight. The terminal is not being
   *  looked at while this is true; it is being flown into a card. */
  holdSize: boolean;
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
  /** A plain one-finger tap on the terminal — §4.4's door to the keyboard, now that the bar's
   *  swipe ↑ always goes to the switcher. Detected here for the same reason as the two-finger
   *  tap: only this layer knows the touch was neither a scroll nor a long-press selection. */
  onTap: () => Promise<void>;
  /** T14: the search addon's live occurrence count — `index` is 0-based, −1 past the highlight
   *  limit; `count` 0 = no hits. Feeds the "i/N" label beside the terminal's search field. */
  onSearchResults: (index: number, count: number) => Promise<void>;
  ref?: Ref<TerminalHandle>;
  dom?: DOMProps;
};

/**
 * The gutter the fit addon holds back for a scrollbar, hung off the right edge instead of taken out
 * of the grid.
 *
 * `proposeDimensions` subtracts `overviewRuler.width || DEFAULT_SCROLL_BAR_WIDTH` from the box
 * before it divides by the cell — a constant it never measures, and one no option can zero: 0 is
 * falsy, so it falls straight back to the 14. With the bar hidden (see CSS) those 14 points were
 * simply dead background down the right of every session, at every size — about two columns of it.
 *
 * So the box is made 14pt wider than the space it sits in, and the fit's subtraction lands on the
 * overhang: `cols` then fills the visible width, and the sliver the flooring leaves over is off the
 * edge of the screen rather than inside it. Cheaper than the alternative, which is doing the
 * arithmetic here off xterm's private cell dimensions.
 */
const GUTTER = 14;

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
 *  chrome, copied into `public/` because that is the one directory that reaches this bundle. Both
 *  copies are upstream's, plus the cmap fills in `scripts/patch-font.py` — re-run it on a bump.
 *
 *  The ligature cut, deliberately. This was the no-ligature (NL) cut for a day, because the two
 *  renderers disagreed about `calt` at the hand-over: RN's <Text> goes through CoreText, which
 *  applies a font's default features, so `->` in a captured pane came out as an arrow, while xterm
 *  could not shape at all — WebKit drops shaping when letter-spacing is non-zero, and xterm sets a
 *  non-zero one to land glyphs on the cell. Taking the feature out of the file settled it by making
 *  neither side ligate.
 *
 *  The letter-spacing rule below then set that spacing to zero for its own reasons, which handed
 *  shaping back to WebKit and removed the disagreement at its source — both renderers now apply
 *  `calt` and agree. Verified on device (2026-08-12): `-> => != >= <= === |> ~~` all ligate in the
 *  pane, on grid, and the snapshot matches through the swipe. So the ligatures come back, which is
 *  what they were wanted for; if that rule ever goes back to a non-zero spacing, this file has to
 *  go back to the NL cut in the same commit or the hand-over splits again. */
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
  /* The webview and the snapshot draw the same font at the same size on the same pitch, and the
     glyphs still do not weigh the same: WebKit's default is subpixel-antialiased, which dilates
     stems, while RN's <Text> goes through UIKit's plain grayscale AA. So the swipe's snapshot
     looks lighter than the terminal it hands over to. 'antialiased' is grayscale AA — the native
     side's rendering, asked for on the side that can be told. Inherited, so body carries it. */
  body { -webkit-font-smoothing: antialiased; }
  /* xterm seats glyphs on its cell by setting a letter-spacing of the difference between that cell
     and the font's own advance, and the cell is the row width over the columns — rounded, so the
     spacing is a hundredth of a pixel that WebKit then quantises to 1/64 of one, landing the row on
     a pitch nobody asked for (7.7848pt where the fit meant 7.7959). Zero instead: the glyphs go on
     the font's own advance, which is a number both sides can name, and the 0.2px the row then
     overhangs its screen is behind an overflow:hidden. Marked important because xterm writes the
     value inline, and inline loses to it. Only the row container — a span with a spacing of its
     own keeps it, which is how a substituted glyph still gets squeezed into its cell.
     It also carries the ligatures now: WebKit only shapes at zero spacing, so this rule is what
     lets the pane draw '->' as the arrow the snapshot beside it draws. Putting a non-zero spacing
     back splits the hand-over again, and the font at the top of this file has to become the NL cut
     in the same commit. */
  .xterm .xterm-rows { letter-spacing: 0 !important; }
  /* An underline the font's own thickness, which is what the snapshot's <Text> draws: CoreText
     takes it from the face (0.05em, so two device pixels here) while WebKit's 'auto' will not go
     below one CSS pixel, which is three. Same link, same colour, a third thicker in the pane than
     in the card beside it (user, 2026-08-11; measured 3 rows against 2 in one swipe frame). Not
     inherited, so it goes on the spans that carry the decoration. */
  .xterm .xterm-rows span {
    text-decoration-thickness: from-font;
    /* And where it sits. 'from-font' is accepted here and then ignored — the rule stayed on
       WebKit's own 'auto' placement, two device pixels below the snapshot's. A length is honoured,
       but it is measured from the alphabetic baseline rather than added to that placement, which
       is why a negative one put the rule through the letters. The zero it is measured from is not
       the baseline and not the face's underlinePosition either, so this number is fitted rather
       than derived: -0.05em drew the rule on the letters and 0.13em left six device pixels under
       them against the snapshot's three, and the response is linear between the two — 0.08em to
       the three pixels, so about 0.0267em each (device, 2026-08-11, both rules in one held-swipe
       frame).
       ponytail: fitted at 13pt, and em does not carry it across sizes — the zero it is measured
       from is quantised, so it steps. The same size fitted to 0.05em at 12.78pt and wanted 0.10 at
       13. If the size setting starts moving the rule again, re-fit the same way (one held swipe,
       measure both rules, 0.0267em a pixel) or stop asking CSS and draw the rule as a border-bottom
       on the span, where the geometry is ours. */
    text-underline-offset: 0.1em;
  }
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
  /* And it must not draw a scrollbar. Not '::-webkit-scrollbar': xterm 6 does not use the browser's
     bar at all — the viewport is VS Code's SmoothScrollableElement, and the thing that fades in on
     the right is a div it fades between .visible and .invisible whenever the buffer scrolls. Which
     is why it turned up "sometimes on entering a terminal": a session being painted back in scrolls
     thousands of lines in one go. Scrolling here is §4.3's job and it has its own gesture, so the
     bar is nobody's affordance — and while shown it eats touches down the right edge of the grid. */
  .xterm .xterm-scrollable-element > .scrollbar { display: none; }
`;

/**
 * One line saying whether the bundled font actually arrived. A webview that fell back to the system
 * monospace looks perfectly fine until a Nerd Font glyph turns up as a box, and by then the cell
 * width is wrong too — so measure it rather than trust it. In a monospaced font every glyph is one
 * cell wide, including the private-use ones; a fallback gives a different width for the glyph it
 * does not have. Logging is deliberate here (PLAN.md §7): this file has no other way to speak.
 */
/** Five tries then boot regardless: a terminal on the wrong font still runs a shell, and one that
 *  never opens does not. The waits between them add up to 1.5s in the worst case. */
const FONT_TRIES = 5;

/** Whether the bundled face is the one being drawn, asked the only way that matters: in a mono
 *  font every glyph is one advance wide, so if 'M' does not measure `size * 0.6` the answer came
 *  from somewhere else. A tenth of a point of slack for the renderer's own rounding — a fallback
 *  is out by whole points (11.36 against 7.67, device). */
function monoArrived(fontSize: number): boolean {
  const context = document.createElement('canvas').getContext('2d');
  if (context === null) return true; // no way to tell; do not spin on it
  context.font = `${fontSize}px ${MONO}`;
  return Math.abs(context.measureText('M').width - fontSize * MONO_ADVANCE) < 0.1;
}

function fontReport(fontSize: number): string {
  const loaded = document.fonts.check(`${fontSize}px ${MONO}`);
  const bold = document.fonts.check(`bold ${fontSize}px ${MONO}`);
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return `font ${MONO} loaded=${loaded} (no canvas to measure with)`;
  /** `font` is a full CSS font shorthand, so a weight can sit in front of the size. */
  const width = (font: string, text: string) => {
    context.font = font;
    return (context.measureText(text).width / text.length).toFixed(4);
  };
  const regular = `${fontSize}px ${MONO}`;
  return (
    `font ${MONO} loaded=${loaded} bold=${bold} size=${fontSize.toFixed(4)} ` +
    `dpr=${window.devicePixelRatio} cell=${width(regular, 'M')} ` +
    `cell100=${width(regular, 'M'.repeat(100))} ` +
    `bold-cell=${width(`bold ${regular}`, 'M')} ` +
    `nerd-glyph=${width(regular, '')} system-mono-cell=${width(`${fontSize}px monospace`, 'M')}`
  );
}

/*
 * Once nudged, the size was: a cell of 23.4 device pixels starts on a different fraction of a pixel
 * in every column, the two renderers do not round that fraction the same way — one seats a glyph on
 * a whole pixel, the other draws it where the arithmetic put it — and the disagreement peaks about
 * every third column, so a few letters a line come out crisper in the pane than in the card beside
 * it. Rounding the size until `size * 0.6 * dpr` was whole removed it exactly.
 *
 * It is not done, because it is not the terminal's job to be a nice multiple: the sizes that
 * qualify at 3x are 5/9pt apart, so the pane the user asked 13pt for drew at 12.78 and gained a
 * column. A sub-pixel difference during a swipe does not buy that (user's call, 2026-08-11). The
 * advance is still MATCHED — `advance()` measures whatever the pane ends up on — so what is left
 * is where inside a pixel each glyph sits, and neither engine offers a say in that.
 */
export default function TerminalView({ theme, fontSize, holdSize, ref, ...handlers }: TerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const resizer = useRef<(() => void) | null>(null);
  const releaseFit = useRef<(() => void) | null>(null);
  // Native re-marshals every prop on every render, so the terminal reads them through this ref
  // instead of being torn down and rebuilt each time a callback's identity changes.
  const latest = useRef({ theme, holdSize, ...handlers });
  useEffect(() => {
    latest.current = { theme, holdSize, ...handlers };
  });

  // Coming out of a hold, the size is measured and reported exactly once — the layout it settles
  // in is the only one the host ever hears about.
  const held = useRef(holdSize);
  useEffect(() => {
    const released = held.current && !holdSize;
    held.current = holdSize;
    if (released) releaseFit.current?.();
  }, [holdSize]);

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
    //
    // And a failed load is retried rather than shrugged at. `fonts.load` rejected once with a bare
    // NetworkError and the terminal booted anyway, on a fallback measuring 11.36pt to the cell's
    // 7.67 — a whole session of wrong metrics that looks like a rendering bug and is not (device,
    // 2026-08-11). Nothing about the file changed between that boot and the next, so a retry is
    // the whole fix.
    (async () => {
      for (let attempt = 1; !disposed; attempt++) {
        try {
          await Promise.all([
            document.fonts.load(`${fontSize}px ${MONO}`),
            document.fonts.load(`bold ${fontSize}px ${MONO}`),
          ]);
        } catch (error) {
          console.log(`[terminal] font load attempt ${attempt} failed:`, String(error));
        }
        // Measured, not asked. `fonts.check` says false on boots whose glyphs are demonstrably the
        // bundled ones, so it cannot be the gate; the advance can, because the advance IS what
        // goes wrong — a fallback answers this question with somebody else's number.
        if (monoArrived(fontSize) || attempt >= FONT_TRIES) {
          if (disposed) return;
          console.log('[terminal]', fontReport(fontSize));
          cleanup = boot();
          return;
        }
        // Backing off rather than hammering: the one failure seen was a reload racing the bundler,
        // which is over in a frame or two, and a phone that never gets the file is better off at
        // the fallback than in a loop.
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    })();

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

    // One *report* per settled gesture: rotation and the keyboard both animate, and tmux redraws
    // the whole session for every size it is told about (§4.2). The fit itself is not debounced —
    // it is local and cheap, and holding it back is what made the keyboard look like it beat the
    // terminal up the screen: the box shrank with the layout while xterm kept drawing the old row
    // count, so the bottom lines sat under the keyboard for the length of the delay (T14, device).
    let settle: ReturnType<typeof setTimeout>;
    let reported = { cols: 0, rows: 0, padTop: -1 };
    // Only a size the host has not been told about is worth a round trip. Without this the same
    // `cols × rows` goes back on every fit, and since the answer re-renders the native side — which
    // re-marshals the props, which re-runs the effect below — it never stops.
    // The advance a row's glyphs actually land on — measured with a probe inside the row container,
    // so it inherits the font, the size and the letter-spacing the renderer set. NOT the screen
    // width over the columns: that is the fit's INTENT, and the glyphs miss it. xterm seats them by
    // setting `letter-spacing` to the difference between its cell and the font's own advance
    // (-0.004px here), and WebKit quantises that to 1/64px, so the drawn pitch comes out at
    // 7.7848pt where the fit meant 7.7959. Eleven thousandths of a point is nothing until it is
    // multiplied by the column: a snapshot drawn on the intent sits a pixel and a half off the pane
    // by the far end of a line, so a character mid-line stepped sideways at the swipe's settle
    // while its own line's first character did not (user, 2026-08-11; pitch then measured off a
    // device screenshot, 23.3516px at 3x against 23.3878 for the intent).
    const advance = () => {
      const rows = host.current?.querySelector('.xterm-rows') as HTMLElement | null;
      if (rows === null) return 0;
      const probe = document.createElement('span');
      // A thousand of them, not ten: the probe's own box is rounded before it is handed back, and
      // that rounding lands on the answer divided by the count. At 100 it was a hundredth of a
      // point — the same order as the error being measured.
      probe.textContent = 'M'.repeat(1000);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      rows.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width / 1000;
    };
    // The row pitch stays the screen's own: xterm lays rows out as boxes at that height, so unlike
    // the advance it is what is drawn.
    const cell = () => {
      const screen = host.current?.querySelector('.xterm-screen') as HTMLElement | null;
      if (screen === null || term.cols === 0 || term.rows === 0) return { w: 0, h: 0 };
      return { w: advance(), h: screen.clientHeight / term.rows };
    };
    // Whole rows, and the remainder above the first one rather than below the last — the gap
    // under the last line is the key bar's to fill, and it already has one (user, 2026-08-10).
    // It is done here, inside the document, because the box is known here: worked out on the
    // React side it took a second layout pass to settle, which is a visible bounce every time
    // the keyboard opens. Nothing is lost to it — the rows are counted before the inset is
    // applied, so the inset is exactly what they could not fill.
    //
    // ONE fit, and the padding is never taken off to take a measurement. This used to zero the
    // inset, fit at the taller box, work the remainder out and fit again — and that first pass is
    // a real reflow at a size the pane never keeps. The host's height comes from the layout above
    // it, not from its content, so its `clientHeight` does not move with its own padding: the
    // measurement the first pass went to get is the same number the second one already has.
    // Nothing was buying the churn, and it was on every fit — including the one 150ms after a
    // zoom lands, which is the pane visibly stepping up a beat after the tab does (user,
    // 2026-08-11). With the rows unchanged xterm's own resize is a no-op, so a fit that changes
    // nothing now costs nothing.
    let padTop = 0;
    const fitRows = () => {
      const el = host.current;
      if (el === null) return fitAddon.fit();
      const { h } = cell();
      padTop = h > 0 ? el.clientHeight % h : 0;
      el.style.paddingTop = `${padTop}px`;
      fitAddon.fit();
    };
    const report = () => {
      if (term.cols === reported.cols && term.rows === reported.rows && padTop === reported.padTop)
        return;
      reported = { cols: term.cols, rows: term.rows, padTop };
      const { w, h } = cell();
      console.log(
        '[terminal] size', term.cols, '×', term.rows,
        // Four places on the advance, not two: the thing that goes wrong with it is thousandths of
        // a point multiplied by fifty columns, and two places cannot show it.
        'cell', w.toFixed(4), '×', h.toFixed(2),
        'padTop', padTop.toFixed(2),
      );
      latest.current.onResize(term.cols, term.rows, w, h, padTop);
    };
    // `force` re-reports even a size the host was already told about: the only caller is the
    // release from a hold, and during that hold a report may have been dropped in flight (see
    // the screen's own guard) — so what the host last heard is not knowable from here.
    const resize = (force?: boolean) => {
      if (force) reported = { cols: 0, rows: 0, padTop: -1 };
      // probe (T10, temporary): the pane steps up a beat after a zoom lands and nothing on the
      // React side moves — no refit reported, no bytes held back. Text moving up by rows is the
      // BUFFER scrolling, so this watches what only this side can see: where the viewport sits in
      // the scrollback, and the row count and inset that would make it move.
      const b = term.buffer.active;
      const was = { y: b.viewportY, base: b.baseY, rows: term.rows, pad: padTop };
      fitRows();
      const now = term.buffer.active;
      if (now.viewportY !== was.y || now.baseY !== was.base || term.rows !== was.rows || padTop !== was.pad)
        console.log(
          `[probe] FITMOVED viewportY ${was.y}→${now.viewportY} baseY ${was.base}→${now.baseY} ` +
            `rows ${was.rows}→${term.rows} padTop ${was.pad.toFixed(1)}→${padTop.toFixed(1)}`,
        );
      report();
    };
    resizer.current = resize;
    // Coming out of a hold, the box this document sits in may not have caught up yet: the layout
    // that ended the hold reaches the webview as a native resize, and the flag that ended it as a
    // prop, and they do not arrive together. Fitting on the spot measured the stage the keyboard
    // had not returned to yet and reported 41 rows, then 26 a beat later — the two reflows the
    // hold exists to prevent (device). So: fit at the settle, and let a real resize preempt it —
    // the observer clears this timer, and its own flush is the one report.
    releaseFit.current = () => {
      clearTimeout(settle);
      settle = setTimeout(() => resize(true), 150);
    };
    // Throttled, not debounced. A keyboard edge is one discrete step and so produces exactly one
    // tick: a trailing debounce held the host off for 150ms for nothing, and until tmux repaints,
    // the rows the keyboard uncovers hold whatever the fit dragged out of scrollback — which is
    // what read as the terminal settling last, after the keyboard had gone (T14, device). A real
    // ramp (rotation, the font-size drag) still gets at most one report per window plus the final
    // one, which is all §4.2 ever wanted.
    let lastReport = 0;
    const flush = () => {
      if (latest.current.holdSize) return; // a timer that matured after the hold began
      lastReport = Date.now();
      report();
    };
    const observer = new ResizeObserver(() => {
      if (latest.current.holdSize) return; // the zoom's own height animation — see `holdSize`
      fitRows();
      clearTimeout(settle);
      const since = Date.now() - lastReport;
      if (since >= 150) flush();
      else settle = setTimeout(flush, 150 - since);
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
    /** The flick the running coast is decaying from, and when it started — so a finger that catches
     *  it can work out how much speed was left and hand that to its own flick (§4.3, compounding). */
    let coastV0 = 0;
    let coastT0 = 0;
    /** Speed inherited from a caught coast, spent by the next release. 0 when nothing was caught. */
    let carried = 0;
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
      coastV0 = v0;
      coastT0 = t0;
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
      // §4.3 said a touch during the coast stops it and does nothing else. On device that reads as
      // dead: the finger that caught the scroll cannot then drag it, so it takes a *third* touch to
      // move again. iOS hands the drag over inside the same gesture, so a catch goes straight to
      // 'panning' — no slop to spend, since a finger landing on moving text has already committed
      // to scrolling — and stays a scroll, never a tap or a long-press. preventDefault is what
      // makes WebKit agree about that last part.
      const caught = coast !== null;
      if (caught) {
        carried = coastVelocity(coastV0, performance.now() - coastT0);
        console.log('[terminal] coast caught', carried.toFixed(3), 'px/ms carried');
        stopCoast();
        ev.preventDefault();
      } else {
        carried = 0; // a pan that began on a still screen inherits nothing
      }
      const t = ev.touches[0];
      if (!caught && pan !== 'idle') {
        // A second finger joining a pan: same scroll, rebased so the handover does not jump.
        panX = t.clientX;
        panY = t.clientY;
        fingers = Math.max(fingers, ev.touches.length);
        return;
      }
      pan = caught ? 'panning' : 'pending';
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
      if (pan === 'panning') {
        startCoast(compoundVelocity(tracker.velocity(), carried), panX, panY);
        carried = 0;
      }
      // A one-finger tap on a live selection clears it. xterm would normally do this itself, off
      // the synthetic mouse pair iOS sends — but its textarea is disabled and touch is ours, so
      // that path is gone and without this the selection and its edit menu simply stay (T13/T6.7).
      if (pan === 'pending' && fingers === 1 && document.getSelection()?.isCollapsed === false) {
        document.getSelection()?.removeAllRanges();
      }
      // Otherwise a quick one-finger tap asks for the keyboard (§4.4). A tap that dismissed a
      // selection is that dismissal and nothing more; a slow press is WebKit's long-press.
      else if (pan === 'pending' && fingers === 1 && ev.timeStamp - downAt < TAP_MS) {
        console.log('[terminal] tap');
        latest.current.onTap();
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
      <div ref={host} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: -GUTTER }} />
    </>
  );
}
