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
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useDOMImperativeHandle, type DOMImperativeFactory, type DOMProps } from 'expo/dom';
import { useEffect, useRef, type Ref } from 'react';

import { fromBase64 } from '@/base64';
import { isHttpLink, parseOsc52 } from '@/terminal-protocol';
import { MONO, type Theme } from '@/theme';

// Deliberately not `extends DOMImperativeFactory`: its index signature types every method as
// taking `JSONValue`s, which would let a caller write a number at the terminal. The bridge only
// carries JSON either way, so the cast at the hook below is the whole cost of saying `string`.
export type TerminalHandle = {
  /** Shell output, base64 — the wire format `ExpoSSH` emits. */
  write(base64: string): void;
  /** Raises the keyboard: the hidden textarea xterm keeps is what the OS is focusing. */
  focus(): void;
};

export type TerminalProps = {
  theme: Theme;
  fontSize: number;
  /** Keystrokes, and the replies this file writes on the app's behalf, on their way to the PTY. */
  onData: (data: string) => Promise<void>;
  /** After a settled rotation, keyboard move or font change — what the host's window size is now. */
  onResize: (cols: number, rows: number) => Promise<void>;
  onBell: () => Promise<void>;
  /** An OSC 52 yank, already decoded. Reads are refused before they get here. */
  onClipboard: (text: string) => Promise<void>;
  /** An OSC 8 link the user tapped, always `http(s)`. */
  onLink: (url: string) => Promise<void>;
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
  const resizer = useRef<(() => void) | null>(null);
  // Native re-marshals every prop on every render, so the terminal reads them through this ref
  // instead of being torn down and rebuilt each time a callback's identity changes.
  const latest = useRef({ theme, ...handlers });
  useEffect(() => {
    latest.current = { theme, ...handlers };
  });

  const handle: TerminalHandle = {
    write: (base64) => terminal.current?.write(fromBase64(base64)),
    focus: () => terminal.current?.focus(),
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
    term.open(host.current!);
    terminal.current = term;
    fit.current = fitAddon;

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
    // puts scrolling here too), so xterm sees only what this file hands it: nothing, for now.
    // T6 will need `mousedown`/`mousemove` back for mouse reporting, on the encoded path.
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

    return () => {
      clearTimeout(settle);
      observer.disconnect();
      term.dispose();
    };
  }

  // A flavour change restyles the live session (§4.8); a font-size change resizes it (§4.2).
  // Keyed on the flavour's *name*, not the theme object: the object is rebuilt by the bridge on
  // every render, so an identity comparison here would make this effect run forever.
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const { theme: current } = latest.current;
    document.body.style.background = current.background;
    term.options.theme = xtermTheme(current);
    term.options.fontSize = fontSize;
    resizer.current?.();
  }, [theme.name, fontSize]);

  return (
    <>
      <style>{CSS}</style>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
    </>
  );
}
