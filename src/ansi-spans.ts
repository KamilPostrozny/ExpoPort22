/**
 * ANSI (SGR) → styled spans, for T10's snapshot cards: `capture-pane -e` output rendered as
 * nested <Text> runs in a mini terminal. Pure — every decision runs under `bun test`.
 *
 * Checked on npm first (AGENTS.md): `anser` is already in the tree (react-native's LogBox pulls
 * it) and its actual API was read — it resolves colours to ITS OWN hardcoded palette ("187, 0, 0"
 * RGB strings, or HTML class names with `use_classes`), so mapping its output back onto the
 * theme's Catppuccin ANSI slots means reverse-engineering colour strings, and its single
 * `decoration` field is HTML-oriented besides. `ansi-parser` (last publish ~9 years ago) and
 * `ansi_up` / `ansi-to-react` (HTML/DOM renderers) fit worse. What a card needs — SGR subset,
 * slot indices kept symbolic so the theme maps them — is under 100 lines, so it is ported
 * minimal. The 256-colour cube/gray ramp is xterm's algorithm, computed, not a hand-copied table.
 */

/** `fg`/`bg`: `null` = terminal default, 0–255 = palette slot (theme maps 0–15, `xterm256` the
 *  rest), `#rrggbb` = truecolor passthrough. `hl` marks a T14 search hit — the renderer paints
 *  it over whatever colours the span had. */
export type Span = {
  text: string;
  fg: number | string | null;
  bg: number | string | null;
  bold: boolean;
  /** The attributes a full-size snapshot cannot skip: a page card of the T11 slide hands straight
   *  over to the live terminal, so anything dropped here is a line that changes the moment the
   *  overlay lifts — eza underlines its symlink targets, and the underline arriving late was the
   *  "rendering differs" (user, 2026-08-10). */
  underline: boolean;
  italic: boolean;
  inverse: boolean;
  /** SGR 2. The emulator draws it as half-strength ink, and so does the snapshot — it is how eza
   *  greys a backup file, so without it `.tmux.conf.bak` came back at full strength (user,
   *  2026-08-10). Cleared by 22, which per ECMA-48 ends bold and faint together. */
  dim: boolean;
  hl?: boolean;
};
export type SpanLine = Span[];

type Style = {
  fg: number | string | null;
  bg: number | string | null;
  bold: boolean;
  underline: boolean;
  italic: boolean;
  inverse: boolean;
  dim: boolean;
};

/** Apply one SGR parameter list (the `Ps ; Ps …` of `CSI Ps m`) to a style. Handles 0, 1/22,
 *  2/3/4/7 and their 22/23/24/27 undos, 30–37/90–97/39 (and the bg forms), 38/48 with `5;n` and `2;r;g;b`; skips
 *  what it does not know, swallowing the extended forms' arguments so `38;5;196;1` still bolds. */
function applySgr(params: string[], style: Style): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i] === '' ? 0 : Number(params[i]); // empty param = 0, per ECMA-48
    if (Number.isNaN(p)) continue;
    if (p === 0)
      Object.assign(style, {
        fg: null,
        bg: null,
        bold: false,
        underline: false,
        italic: false,
        inverse: false,
        dim: false,
      });
    else if (p === 1) style.bold = true;
    else if (p === 2) style.dim = true;
    else if (p === 22) Object.assign(style, { bold: false, dim: false });
    else if (p === 3) style.italic = true;
    else if (p === 23) style.italic = false;
    else if (p === 4) style.underline = true;
    else if (p === 24) style.underline = false;
    else if (p === 7) style.inverse = true;
    else if (p === 27) style.inverse = false;
    else if (p >= 30 && p <= 37) style.fg = p - 30;
    else if (p >= 90 && p <= 97) style.fg = p - 90 + 8;
    else if (p === 39) style.fg = null;
    else if (p >= 40 && p <= 47) style.bg = p - 40;
    else if (p >= 100 && p <= 107) style.bg = p - 100 + 8;
    else if (p === 49) style.bg = null;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'fg' : 'bg';
      const mode = Number(params[i + 1]);
      if (mode === 5) {
        const n = Number(params[i + 2]);
        if (Number.isInteger(n) && n >= 0 && n <= 255) style[key] = n;
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]].map(Number);
        if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
          style[key] = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        }
        i += 4;
      } else break; // malformed extension: drop the rest of this SGR rather than misread it
    }
    // everything else (blink, conceal, strike, …): ignored — nothing the emulator draws differently
  }
}

/**
 * Parse a captured pane into lines of styled spans. Only SGR changes style; every other escape
 * (other CSI finals, OSC, bare ESC pairs) is skipped over, and a truncated sequence at the end
 * of input is dropped rather than rendered. `\r` is dropped; `\n` breaks lines.
 */
export function parseAnsi(text: string): SpanLine[] {
  const lines: SpanLine[] = [[]];
  const style: Style = {
    fg: null,
    bg: null,
    bold: false,
    underline: false,
    italic: false,
    inverse: false,
    dim: false,
  };
  let run = '';

  const flush = () => {
    if (run === '') return;
    const line = lines[lines.length - 1];
    const last = line[line.length - 1];
    // Every attribute has to be in this comparison, not just the colours: two runs that differ
    // only by one of them would coalesce into a single span wearing the FIRST one's, which is the
    // same dropped underline by another route.
    if (
      last &&
      last.fg === style.fg &&
      last.bg === style.bg &&
      last.bold === style.bold &&
      last.underline === style.underline &&
      last.italic === style.italic &&
      last.inverse === style.inverse &&
      last.dim === style.dim
    ) {
      last.text += run; // coalesce: fewer <Text> nodes per card
    } else {
      line.push({ text: run, ...style });
    }
    run = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\x1b') {
      const next = text[i + 1];
      if (next === '[') {
        // CSI: params/intermediates until a final byte 0x40–0x7e.
        let j = i + 2;
        while (j < text.length && !(text[j] >= '@' && text[j] <= '~')) j++;
        if (j >= text.length) break; // truncated at end of capture: drop it
        if (text[j] === 'm') {
          flush();
          applySgr(text.slice(i + 2, j).split(';'), style);
        }
        i = j;
      } else if (next === ']') {
        // OSC: until BEL or ST (ESC \).
        let j = i + 2;
        while (j < text.length && text[j] !== '\x07' && !(text[j] === '\x1b' && text[j + 1] === '\\')) j++;
        i = j >= text.length ? text.length : text[j] === '\x1b' ? j + 1 : j;
      } else if (next === undefined) {
        break; // lone ESC at end
      } else {
        i++; // two-character escape (ESC 7, ESC =, …): skip
      }
    } else if (ch === '\n') {
      flush();
      lines.push([]);
    } else if (ch !== '\r') {
      run += ch;
    }
  }
  flush();
  return lines;
}

/**
 * T14's span surgery: mark every case-insensitive occurrence of `query` in a line of spans. The
 * match runs over the line's *joined* text, so a hit split across spans — a mid-word colour
 * change — still highlights whole, as k adjacent marked pieces; spans are split at the match
 * boundaries so the mark never bleeds into neighbouring text. Untouched lines are returned
 * as-is (same array), so a re-render without hits re-uses every node.
 */
export function highlightLine(line: SpanLine, query: string): SpanLine {
  const q = query.toLowerCase();
  if (q === '') return line;
  const joined = line.map((s) => s.text).join('').toLowerCase();
  if (!joined.includes(q)) return line;

  // Every position covered by some occurrence, in [start, end) ranges.
  const ranges: [number, number][] = [];
  for (let i = joined.indexOf(q); i >= 0; i = joined.indexOf(q, i + q.length)) {
    ranges.push([i, i + q.length]);
  }

  const out: SpanLine = [];
  let pos = 0;
  for (const span of line) {
    let offset = 0; // within this span
    for (const [start, end] of ranges) {
      const from = Math.max(start - pos, offset);
      const to = Math.min(end - pos, span.text.length);
      if (to <= from || from >= span.text.length) continue;
      if (from > offset) out.push({ ...span, text: span.text.slice(offset, from) });
      out.push({ ...span, text: span.text.slice(from, to), hl: true });
      offset = to;
    }
    if (offset < span.text.length) out.push({ ...span, text: span.text.slice(offset) });
    pos += span.text.length;
  }
  return out;
}

/** Slots 16–255 of the xterm palette, computed the way xterm computes them: a 6×6×6 colour cube
 *  (levels 0, then 95 + 40·k) and a 24-step gray ramp. 0–15 are the theme's — not answered here. */
export function xterm256(n: number): string {
  const hex = (r: number, g: number, b: number) =>
    '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  if (n < 232) {
    const c = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return hex(level(Math.floor(c / 36)), level(Math.floor(c / 6) % 6), level(c % 6));
  }
  const gray = 8 + (n - 232) * 10;
  return hex(gray, gray, gray);
}

/** A span colour as a CSS hex, given the theme's 16 ANSI slots. `null` in = `null` out — the
 *  caller falls back to the card's default foreground/background. */
export function spanColor(value: number | string | null, ansi: string[]): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return value < 16 ? ansi[value] : xterm256(value);
}
