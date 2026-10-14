"""Render maps/world.png: black country borders on white, for the default background map.

Data: Natural Earth 1:50m Admin 0 countries (public domain).
  curl -L -o countries.geojson \\
    https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson
  python3 maps/render_world.py countries.geojson maps/world.png

Equirectangular, 85°N to 60°S (Antarctica left out). Borders are 1px, unantialiased lines:
the flood fill spreads 4-way, so a 1px line is enough to keep each country a closed area.
No dependencies beyond the standard library.
"""

import json
import struct
import sys
import zlib

WIDTH = 4096
LAT_TOP, LAT_BOTTOM = 85.0, -60.0
HEIGHT = round(WIDTH * (LAT_TOP - LAT_BOTTOM) / 360)
SKIP = {'Antarctica'}


def project(lng, lat):
    x = (lng + 180) / 360 * (WIDTH - 1)
    y = (LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM) * (HEIGHT - 1)
    return round(x), round(y)


def draw_line(px, a, b):
    """Bresenham; points outside the image are skipped."""
    (x0, y0), (x1, y1) = a, b
    dx, dy = abs(x1 - x0), -abs(y1 - y0)
    sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
    err = dx + dy
    while True:
        if 0 <= x0 < WIDTH and 0 <= y0 < HEIGHT:
            px[y0 * WIDTH + x0] = 0
        if x0 == x1 and y0 == y1:
            return
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x0 += sx
        if e2 <= dx:
            err += dx
            y0 += sy


def rings(geometry):
    if geometry['type'] == 'Polygon':
        yield from geometry['coordinates']
    elif geometry['type'] == 'MultiPolygon':
        for polygon in geometry['coordinates']:
            yield from polygon


def write_png(path, px):
    """1-bit grayscale PNG (0 = black, 1 = white)."""
    raw = bytearray()
    for y in range(HEIGHT):
        raw.append(0)  # filter: none
        row = px[y * WIDTH:(y + 1) * WIDTH]
        for i in range(0, WIDTH, 8):
            byte = 0
            for bit, v in enumerate(row[i:i + 8]):
                byte |= (1 if v else 0) << (7 - bit)
            raw.append(byte)

    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', WIDTH, HEIGHT, 1, 0, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
        f.write(chunk(b'IEND', b''))


def main(src, out):
    with open(src, encoding='utf-8') as f:
        features = json.load(f)['features']
    px = bytearray([1]) * (WIDTH * HEIGHT)
    drawn = 0
    for feature in features:
        if feature['properties'].get('ADMIN') in SKIP or not feature.get('geometry'):
            continue
        for ring in rings(feature['geometry']):
            pts = [project(lng, lat) for lng, lat in ring]
            for a, b in zip(pts, pts[1:] + pts[:1]):
                draw_line(px, a, b)
        drawn += 1
    write_png(out, px)
    print(f'{out}: {WIDTH}x{HEIGHT}, {drawn} countries')


if __name__ == '__main__':
    main(*sys.argv[1:3])
