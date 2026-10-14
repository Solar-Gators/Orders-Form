"""Draws the app icons (the Solar Gators tile grid) for the installable app (PWA).
Run from the repo root: python tools/make-icons.py   (needs Pillow)"""
from PIL import Image, ImageDraw

ORANGE, BLUE, WHITE = (243, 120, 51), (0, 81, 156), (255, 255, 255)
# Which tiles are orange; the middle one is split diagonally.
LAYOUT = [['o', 'o', 'b'], ['o', 'x', 'b'], ['b', 'b', 'b']]


def tile(d, x, y, s, kind):
    c = s * 0.09  # chamfered corners
    pts = [(x + c, y), (x + s - c, y), (x + s, y + c), (x + s, y + s - c), (x + s - c, y + s), (x + c, y + s), (x, y + s - c), (x, y + c)]
    if kind != 'x':
        d.polygon(pts, fill=ORANGE if kind == 'o' else BLUE)
        return
    d.polygon(pts, fill=BLUE)
    g = s * 0.06  # white gap along the diagonal
    d.polygon([(x + c, y), (x + s - c - g, y), (x, y + s - c - g), (x, y + c)], fill=ORANGE)
    d.line([(x + s - c - g / 2, y - 1), (x - 1, y + s - c - g / 2)], fill=WHITE, width=max(1, round(g)))


def icon(size, grid, path):
    k = 4  # draw big, scale down for smooth edges
    S = size * k
    im = Image.new('RGB', (S, S), WHITE)
    d = ImageDraw.Draw(im)
    g = grid * k
    gap = g * 0.035
    s = (g - 2 * gap) / 3
    o = (S - g) / 2
    for r in range(3):
        for c in range(3):
            tile(d, o + c * (s + gap), o + r * (s + gap), s, LAYOUT[r][c])
    im.resize((size, size), Image.LANCZOS).save(path)


icon(192, 192 * 0.82, 'assets/icon-192.png')
icon(512, 512 * 0.82, 'assets/icon-512.png')
icon(512, 512 * 0.55, 'assets/icon-maskable-512.png')  # stays inside the circle Android crops to
print('Wrote assets/icon-192.png, icon-512.png, icon-maskable-512.png')
