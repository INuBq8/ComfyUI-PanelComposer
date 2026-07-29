"""Polygon/aspect-ratio math shared by the layout and compositing nodes."""

import math

# ISO 216 paper ratio (long side / short side), used by the compositor's
# A4-based canvas modes (fixed_preset, fixed_custom).
A4_RATIO = math.sqrt(2)


def parse_aspect_ratio(ratio_str):
    """'2:3' -> 0.666..., i.e. width/height."""
    w_str, h_str = ratio_str.split(":")
    return float(w_str) / float(h_str)


def bbox_from_polygon(polygon):
    """[[x,y], ...] -> (min_x, min_y, max_x, max_y)."""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return (min(xs), min(ys), max(xs), max(ys))


def round_to_multiple(value, multiple):
    if multiple <= 1:
        return max(1, int(round(value)))
    return max(multiple, int(round(value / multiple)) * multiple)


def solve_dimensions_from_megapixels(aspect_ratio, megapixels, multiple=1):
    """Solve width*height = megapixels*1e6, width/height = aspect_ratio.

    Returns (width, height) rounded to the nearest `multiple`.
    """
    area = megapixels * 1_000_000
    width = math.sqrt(area * aspect_ratio)
    height = area / width
    return round_to_multiple(width, multiple), round_to_multiple(height, multiple)


def page_aspect_ratio(orientation):
    """Exact ISO 216 ratio (width/height) for 'portrait' or 'landscape'."""
    return (1.0 / A4_RATIO) if orientation == "portrait" else A4_RATIO
