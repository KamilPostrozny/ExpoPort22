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

#: Every icon our own chrome draws, now that there is one icon set instead of two: SymbolView is
#: gone (expo-symbols was iOS-only, so its `fallback=` half was the only half Android ever drew),
#: and both platforms render these Nerd Font codepoints out of MONO / MONO_BOLD. A codepoint
#: missing here does not fail loudly: RN falls through to Noto and the button quietly comes out a
#: different weight and shape from the keys beside it, which is how ▣ U+25A3 and ✛ U+271B shipped
#: as the tabs and dpad icons until 2026-08-16. This dict is the guard against a repeat — add the
#: codepoint here in the same commit that draws it. FILL above is for what the *host* writes into
#: the pane, and is not the lever for these.
CHROME = {
    0xEB22: 'move — the arrows key (fa-arrows F047 was too heavy beside the letter keys)',
    0xF002: 'magnifyingglass — switcher search field',
    0xF00C: 'check — the settings theme tick and the switcher Done circle',
    0xF040: 'pencil — the vim recipe chip',
    0xF04B: 'play — the running recipe chip',
    0xF04C: 'pause — the suspended recipe chip',
    0xF067: 'plus — the switcher new-tab circle',
    0xF071: 'warning — the ribbon cap danger mark and the cannot-connect overlay',
    0xF077: 'chevron-up — the settings disclosure, open',
    0xF078: 'chevron-down — the settings disclosure, closed',
    0xF07B: 'folder — the upload browser rows',
    0xF080: 'chart-bar — the htop recipe chip',
    0xF08D: 'thumbtack — the clipboard slot pin',
    0xF09B: 'github — not drawn as an icon; the pane measures it to prove the face loaded',
    0xF0D0: 'wand-magic — the agent recipe chip',
    0xF0F6: 'file-text — the pager recipe chip',
    0xF141: 'ellipsis — the ⋯ menu key',
    0xF15B: 'file — the upload browser rows',
    0xF1E6: 'plug — the disconnected overlay',
    0xF24D: 'clone — the tabs circle',
}

#: The characters that are supposed to tile — box drawing and block elements. Everything else in a
#: terminal is a letter in the middle of its cell, where a hair of space on either side is what you
#: want; these two ranges are drawings that continue into the neighbouring cell, and a hair of space
#: is a seam straight through the picture.
TILING = ((0x2500, 0x257F), (0x2580, 0x259F))

# The glyph box these two ranges are drawn on: the full advance, and hhea's 1020/-300.
BOX_LEFT, BOX_RIGHT, BOX_BOTTOM, BOX_TOP = 0, ADVANCE, -300, 1020
EDGE = 20  # units; a point this near a side counts as sitting on it (0.78 device px at 13pt/3x)

# How far past the box those edges go. The two axes fail for different reasons and want different
# numbers, both measured against a 13pt pane at dpr 3 (`[terminal] size … cell 7.7999 × 18.00`):
#
#   x — the ink is already exactly one advance, so the columns tile in arithmetic and seam only in
#       rasterisation: a cell is 23.4 device pixels, so no column starts on a pixel boundary, and
#       two glyphs meeting mid-pixel each get partial coverage of it. Painted one after the other
#       rather than summed, two half-covered pinks over a black background leave a dark line. An
#       overlap of a whole pixel is what removes the shared edge; 16 a side is 1.25 of one.
#
#   y — this one is a real gap, not a rasterising artefact. The row box is what WebKit reports for
#       the face (1.3846em here, 54 device pixels) while the ink is hhea's 1.32em, 51.48 of them,
#       centred by half-leading. That leaves about 32 units bare above and below, and it is a ratio
#       rather than a length, so it is the same gap at every size. 56 a side clears it with about a
#       pixel to spare.
#
# ponytail: em-relative, so the overlap scales with the text while the pixel it has to cover does
# not. Sized for the pane; the swipe's thumbnail draws the same art several times smaller, where
# 32 units stops being a whole pixel and the x seams can come back. Invisible at thumbnail size,
# which is why it is not worth a second pair of numbers. If a pane ever gets very small, or the
# seams turn up somewhere that matters, the fix is to stop shipping geometry in a font and let a
# canvas renderer draw these two ranges as rectangles, the way SwiftTerm does in ../Port22.
BLEED_X, BLEED_Y = 16, 56


def bleed(font: TTFont, name: str) -> bool:
    """Push a tiling glyph's outer edges past its box, so its neighbours overlap instead of meeting.

    Only points already sitting on an edge move, and they move to a fixed place rather than by an
    offset — so a stroke's thickness and every interior division survive (the quadrant split at
    x=300 does not budge, and a `─` keeps its weight while growing sideways), and a second run is
    a no-op.
    """
    glyph = font['glyf'][name]
    if glyph.numberOfContours == 0:
        return False
    if glyph.isComposite():
        sys.exit(f'{name} is composite; this only knows how to move a simple outline')
    coordinates = glyph.coordinates
    moved = False
    for i, (x, y) in enumerate(coordinates):
        new = (
            -BLEED_X if x <= BOX_LEFT + EDGE else ADVANCE + BLEED_X if x >= BOX_RIGHT - EDGE else x,
            BOX_BOTTOM - BLEED_Y if y <= BOX_BOTTOM + EDGE else
            BOX_TOP + BLEED_Y if y >= BOX_TOP - EDGE else y,
        )
        if new != (x, y):
            coordinates[i] = new
            moved = True
    if moved:
        # The hinting was written for the outline that just changed, and its whole job is to snap
        # edges back onto the pixel grid — which is exactly the overlap being removed again. iOS
        # ignores TrueType instructions anyway, so dropping them from a rectangle costs nothing.
        if hasattr(glyph, 'program'):
            glyph.program.fromBytecode(b'')
        glyph.recalcBounds(font['glyf'])
        # A TrueType glyph's left side bearing is not decoration: the rasteriser trusts it over the
        # outline and shifts the whole thing by `lsb - xMin` when the two disagree. Moving the left
        # edge out without following it here bought nothing — the glyph came back 16 units to the
        # right, seam intact, and the left column of `█` still landed on 0 (measured, 2026-08-12).
        # The advance is untouched; only where the ink sits inside it moves.
        font['hmtx'][name] = (ADVANCE, glyph.xMin)
    return moved


def patch(path: Path) -> tuple[int, int]:
    """Returns (cmap entries added, tiling glyphs widened). Both zero means it was already done."""
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

    cmap = font.getBestCmap()
    for codepoint, what in CHROME.items():
        if codepoint not in cmap:
            sys.exit(f'{path.name}: U+{codepoint:04X} ({what}) is not in the face — it would fall '
                     f'through to a system font and draw at the wrong weight')

    tiling = {cmap[cp] for low, high in TILING for cp in range(low, high + 1) if cp in cmap}
    bled = sum(bleed(font, name) for name in sorted(tiling))

    if added or bled:
        font.save(path)
    return added, bled


def main() -> None:
    for regular_or_bold in sorted(ASSETS.glob('JetBrainsMono*.ttf')):
        added, bled = patch(regular_or_bold)
        # The check, and the reason the file can be re-run after an upstream bump without thinking:
        # everything here is written as a destination rather than a nudge, so a second pass over its
        # own output has nothing left to do. If this ever trips, something started compounding.
        assert patch(regular_or_bold) == (0, 0), f'{regular_or_bold.name}: patch is not idempotent'
        shutil.copyfile(regular_or_bold, PUBLIC / regular_or_bold.name)
        print(f'{regular_or_bold.name}: {added} cmap entries, {bled} tiling glyphs widened')


if __name__ == '__main__':
    main()
