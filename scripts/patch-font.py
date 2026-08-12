#!/usr/bin/env python3
"""Fill the holes JetBrains Mono leaves in the codepoints our own screens draw.

A codepoint the face does not carry is not simply ugly here — it renders *twice*, differently. The
pane is xterm in a webview, so WebKit picks the substitute off its cascade and xterm then writes an
inline letter-spacing to squeeze it back into the cell; the swipe's snapshot is an RN <Text>, so
CoreText picks off a different cascade and no one squeezes anything. Same character, two glyphs, and
the swap between them is visible at the hand-over (user, 2026-08-12, `⏵⏵ bypass permissions on` in
the pane against the same line in the card). Nothing in either renderer can settle that; only the
font having the codepoint can.

No outlines are drawn. Every substitute below is a glyph already in the file, on the same 600
advance, so this is a cmap edit and nothing else — which is also why it survives a Nerd Fonts bump
with no more thought than re-running it.

`fonttools` is the package for this (AGENTS.md): it owns the cmap, and hand-editing the binary to
save a dependency would be the worst trade in this repo.

Idempotent — run it again after dropping in new upstream files:

    uv run --with fonttools scripts/patch-font.py
"""

import shutil
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'assets' / 'fonts'
# The webview cannot reach assets/, so the same two files are served from public/ (see terminal.tsx).
PUBLIC = ROOT / 'public' / 'fonts'

#: codepoint -> the glyph already in the file that stands in for it, and why that one.
FILL = {
    # Claude Code's permission-mode marker, on screen for the whole session. U+23F5 is the *medium*
    # solid triangle; the face has the large one and the small one, and ▶ is the closer of the two
    # in weight — ▸ reads as a bullet next to 13pt text.
    0x23F5: 'uni25B6',  # ⏵ -> ▶
    0x23F4: 'uni25C0',  # ⏴ -> ◀, the mirror, for the same reason before it is missed
    # Claude Code's window title, which tmux draws into the status line. The face has no asterisk
    # operator of any weight, so this is the honest approximation rather than a good match.
    0x2733: 'asterisk',  # ✳ -> *
}

ADVANCE = 600  # 0.6em at 1000upm — a substitute on any other advance would break the cell


def patch(path: Path) -> int:
    font = TTFont(path)
    hmtx, glyphs = font['hmtx'], font.getGlyphOrder()
    added = 0
    for codepoint, glyph in FILL.items():
        if glyph not in glyphs:
            sys.exit(f'{path.name}: stand-in {glyph} is not in the file')
        if hmtx[glyph][0] != ADVANCE:
            sys.exit(f'{path.name}: {glyph} advances {hmtx[glyph][0]}, not {ADVANCE}')
        for table in font['cmap'].tables:
            if not table.isUnicode() or codepoint in table.cmap:
                continue
            table.cmap[codepoint] = glyph
            added += 1
    if added:
        font.save(path)
    return added


def main() -> None:
    for regular_or_bold in sorted(ASSETS.glob('JetBrainsMono*.ttf')):
        added = patch(regular_or_bold)
        shutil.copyfile(regular_or_bold, PUBLIC / regular_or_bold.name)
        print(f'{regular_or_bold.name}: {added} cmap entries added')


if __name__ == '__main__':
    main()
