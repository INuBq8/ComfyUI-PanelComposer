"""Renders a flat-color 'region map' from layout panels — one solid,
maximally-distinct color per panel, black for any canvas area no panel
covers (floating-panel presets). This is a shortcut for regional
conditioning: paint/draw directly on this image (or feed it straight into
an exact-color-match node) to build each panel's mask by its reported
`area_colors` entry, instead of re-deriving each panel's geometry by hand
from layout_json.
"""

import colorsys

from PIL import Image, ImageDraw

BACKGROUND_COLOR = (0, 0, 0)


def _region_color(index, total):
    """High-saturation, high-value HSV rotation — deliberately more vivid
    than utils/placeholder.py's swatch palette (which is soft/pale by
    design for an under-the-image preview), since these colors need to
    stay exact-match-friendly and visually distinct from each other and
    from the pure-black background."""
    hue = index / max(total, 1)
    r, g, b = colorsys.hsv_to_rgb(hue, 0.85, 0.95)
    return (round(r * 255), round(g * 255), round(b * 255))


def _to_decimal(rgb):
    """(r, g, b) -> the single packed 0xRRGGBB value, as a plain int."""
    r, g, b = rgb
    return (r << 16) | (g << 8) | b


def render_region_map(panels, canvas_w, canvas_h):
    """panels: index-aligned to reading order, same as panel_dimensions.

    Returns (PIL.Image RGB of size canvas_w x canvas_h, [decimal 0xRRGGBB
    int per panel, same order as `panels`]). No anti-aliasing or gutter
    erosion — unlike the actual page compositing, this is meant to be an
    exact, unambiguous ID map, not a finished-looking render.
    """
    image = Image.new("RGB", (canvas_w, canvas_h), BACKGROUND_COLOR)
    draw = ImageDraw.Draw(image)
    colors = []
    for i, panel in enumerate(panels):
        rgb = _region_color(i, len(panels))
        colors.append(_to_decimal(rgb))
        scaled = [(x * canvas_w, y * canvas_h) for x, y in panel["polygon"]]
        draw.polygon(scaled, fill=rgb)
    return image, colors
