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
 *  rest), `#rrggbb` = truecolor passthrough. */
export type Span = { text: string; fg: number | string | null; bg: number | string | null; bold: boolean };
export type SpanLine = Span[];

type Style = { fg: number | string | null; bg: number | string | null; bold: boolean };

/** Apply one SGR parameter list (the `Ps ; Ps …` of `CSI Ps m`) to a style. Handles 0, 1, 22,
 *  30–37/90–97/39 (and the bg forms), 38/48 with `5;n` and `2;r;g;b`; skips what it does not
 *  know, swallowing the extended forms' arguments so `38;5;196;1` still bolds. */
function applySgr(params: string[], style: Style): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i] === '' ? 0 : Number(params[i]); // empty param = 0, per ECMA-48
    if (Number.isNaN(p)) continue;
    if (p === 0) Object.assign(style, { fg: null, bg: null, bold: false });
    else if (p === 1) style.bold = true;
    else if (p === 22) style.bold = false;
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
    // everything else (italic, underline, reverse, …): ignored, the card is 6pt tall
  }
}

/**
 * Parse a captured pane into lines of styled spans. Only SGR changes style; every other escape
 * (other CSI finals, OSC, bare ESC pairs) is skipped over, and a truncated sequence at the end
 * of input is dropped rather than rendered. `\r` is dropped; `\n` breaks lines.
 */
export function parseAnsi(text: string): SpanLine[] {
  const lines: SpanLine[] = [[]];
  const style: Style = { fg: null, bg: null, bold: false };
  let run = '';

  const flush = () => {
    if (run === '') return;
    const line = lines[lines.length - 1];
    const last = line[line.length - 1];
    if (last && last.fg === style.fg && last.bg === style.bg && last.bold === style.bold) {
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
