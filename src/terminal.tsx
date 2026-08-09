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
     xterm turns selection off because it drives its own from mouse events, which a finger is not. */
  .xterm .xterm-rows { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
  /* The webview must not rubber-band: a pan is a scroll for the session, never for the page. */
  .xterm-viewport { overscroll-behavior: none; }
`;

export default function TerminalView({ theme, fontSize, ref, ...handlers }: TerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
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
    const resize = () => {
      fitAddon.fit();
      latest.current.onResize(term.cols, term.rows);
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(resize, 150);
    });
    observer.observe(host.current!);

    // The first fit has to wait for the font: xterm measures the cell when it opens, and a cell
    // measured in the fallback font is a whole session at the wrong width.
    document.fonts.load(`${fontSize}px ${MONO}`).then(resize, resize);

    return () => {
      clearTimeout(settle);
      observer.disconnect();
      term.dispose();
    };
  }, []);

  // A flavour change restyles the live session (§4.8); a font-size change resizes it (§4.2).
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    document.body.style.background = theme.background;
    term.options.theme = xtermTheme(theme);
    term.options.fontSize = fontSize;
    fit.current?.fit();
    latest.current.onResize(term.cols, term.rows);
  }, [theme, fontSize]);

  return (
    <>
      <style>{CSS}</style>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
    </>
  );
}
