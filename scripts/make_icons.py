"""Generate the extension icons (no third-party deps: raw PNG writer)."""

import struct
import zlib
from pathlib import Path

OUT = Path("extension")


def rounded_rect_mask(size, radius, ss=4):
    """Supersampled rounded-square coverage mask."""
    big = size * ss
    mask = [[0.0] * size for _ in range(size)]
    r = radius * ss
    for y in range(big):
        for x in range(big):
            inside_x = r <= x < big - r
            inside_y = r <= y < big - r
            if inside_x or inside_y:
                covered = True
            else:
                cx = r - 0.5 if x < r else big - r - 0.5
                cy = r - 0.5 if y < r else big - r - 0.5
                covered = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
            if covered:
                mask[y // ss][x // ss] += 1.0 / (ss * ss)
    return mask


def make_icon(size: int) -> bytes:
    ss = 4
    mask = rounded_rect_mask(size, max(2, int(size * 0.22)), ss)

    # page glyph geometry (fractions of the icon)
    page_l, page_r = size * 0.30, size * 0.70
    page_t, page_b = size * 0.22, size * 0.78
    line_h = max(1.0, size * 0.075)

    rows = []
    for y in range(size):
        row = bytearray()
        row.append(0)  # PNG filter type: none
        for x in range(size):
            cover = mask[y][x]

            # gradient background: blue -> green
            t = (x / max(1, size - 1)) * 0.75 + (y / max(1, size - 1)) * 0.25
            bg = (
                int(27 + (15 - 27) * t),
                int(110 + (122 - 110) * t),
                int(243 + (77 - 243) * t),
            )

            # white page with three text lines
            on_page = page_l <= x < page_r and page_t <= y < page_b
            line = False
            if on_page:
                for index, (ly, width) in enumerate(
                    ((0.16, 0.80), (0.36, 1.00), (0.56, 0.62), (0.76, 0.86))
                ):
                    top = page_t + (page_b - page_t) * ly
                    if top <= y < top + line_h:
                        left = page_l + (page_r - page_l) * 0.12
                        right = left + (page_r - page_l) * 0.76 * width
                        if left <= x < right:
                            line = True
                        break

            if cover <= 0:
                px = (0, 0, 0, 0)
            elif line:
                px = (22, 40, 66, int(255 * cover))
            elif on_page:
                px = (255, 255, 255, int(240 * cover))
            else:
                px = (bg[0], bg[1], bg[2], int(255 * cover))

            row.extend(px)
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


for size in (16, 32, 48, 128):
    path = OUT / f"icon{size}.png"
    path.write_bytes(make_icon(size))
    print(f"wrote {path} ({path.stat().st_size} bytes)")
