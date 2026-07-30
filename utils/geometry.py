"""Polygon/aspect-ratio math shared by the layout and compositing nodes."""

import math

# ISO 216 paper ratio (long side / short side) — A4, A5, B5, etc. all share
# this exact ratio by definition, so it needs no size-specific constant.
A4_RATIO = math.sqrt(2)

# Shared megapixel budgets for the "fixed_preset" canvas-size option on both
# nodes (these are shorthand labels, not literal resolutions — see the
# Panel Compositor docs for why, e.g. 1080p here means ~2.1MP, not 1920x1080).
FIXED_PRESET_MEGAPIXELS = {"1080p": 2.1, "2K": 3.7, "4K": 8.3}

# aspect_ratio dropdown choices, shared by both nodes. Each entry stores only
# a magnitude (long side / short side, always >= 1) — page_orientation is
# what decides whether that magnitude ends up portrait or landscape, so e.g.
# "4:3" and "3:4" would be the same choice twice; only one is listed.
# Ordered by increasing magnitude. Named entries (e.g. "A4") use whatever
# name is actually recognizable rather than forcing an integer ratio label.
ASPECT_RATIO_CHOICES = {
    "1:1 (Square)": 1.0,
    "9:7": 9 / 7,
    "4:3 (Standard)": 4 / 3,
    "A4": A4_RATIO,
    "19:13": 19 / 13,
    "3:2 (Classic Photo)": 3 / 2,
    "7:4": 7 / 4,
    "16:9 (Widescreen)": 16 / 9,
    "21:9 (Ultrawide)": 21 / 9,
    "12:5 (Cinemascope)": 12 / 5,
}


def parse_aspect_ratio(ratio_choice):
    """aspect_ratio dropdown choice -> its magnitude (width/height, >= 1)."""
    try:
        return ASPECT_RATIO_CHOICES[ratio_choice]
    except KeyError:
        raise ValueError(f"Unknown aspect_ratio choice: {ratio_choice!r}")


def bbox_from_polygon(polygon):
    """[[x,y], ...] -> (min_x, min_y, max_x, max_y)."""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return (min(xs), min(ys), max(xs), max(ys))


def polygon_centroid(polygon):
    """Area-weighted centroid (cx, cy) — robust for concave polygons, unlike
    a plain vertex average (mirrors web/panel_layout_preview.js's version,
    used there for label placement; used here for reading-order sorting)."""
    area = 0.0
    cx = 0.0
    cy = 0.0
    n = len(polygon)
    for i in range(n):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % n]
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area *= 0.5
    if abs(area) < 1e-9:
        return (sum(p[0] for p in polygon) / n, sum(p[1] for p in polygon) / n)
    return (cx / (6 * area), cy / (6 * area))


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


def resolve_oriented_aspect_ratio(ratio_magnitude, orientation):
    """Combine a ratio's magnitude (e.g. from the aspect_ratio dropdown, or
    A4's fixed ratio) with an explicit portrait/landscape choice — decouples
    "which numbers" from "which way is up" so e.g. aspect_ratio='16:9' with
    orientation='portrait' gives a tall 9:16 shape rather than a wide one.
    """
    magnitude = max(ratio_magnitude, 1.0 / ratio_magnitude)
    return magnitude if orientation == "landscape" else 1.0 / magnitude


def compute_panel_dimensions(panels, page_aspect_ratio_value, megapixels, multiple=1):
    """Suggested (width, height) per panel, index-aligned to `panels`.

    Solving each panel independently for `width*height == megapixels*1e6`
    distorts panels whose bounding box doesn't reflect their "true" visual
    width (e.g. a slanted/diagonal panel) relative to same-row neighbors —
    a narrower bbox at equal area forces extra height, so a row of panels
    that should share one height comes out with mismatched heights instead.

    To avoid that: panels sharing the exact same vertical span (a "row")
    are solved together for one common height, with each panel's width
    following its own aspect ratio; panels sharing the exact same
    horizontal span (a "column", checked only among panels not already
    grouped into a row) are solved together for one common width instead.
    Anything left over falls back to the original independent solve.

    When a group's members already share the same aspect ratio (true of
    every symmetric preset — e.g. an even grid), this is mathematically
    identical to solving each panel independently, so it only changes
    output for genuinely asymmetric groups (e.g. a slanted cascade).
    """
    n = len(panels)
    bboxes = [bbox_from_polygon(p["polygon"]) for p in panels]
    aspect_ratios = []
    for (min_x, min_y, max_x, max_y) in bboxes:
        bbox_w, bbox_h = max_x - min_x, max_y - min_y
        aspect_ratios.append(page_aspect_ratio_value * (bbox_w / bbox_h))

    dims = [None] * n
    assigned = [False] * n

    def _solve_shared_height(indices):
        group_ars = [aspect_ratios[i] for i in indices]
        area_total = megapixels * 1_000_000 * len(indices)
        height = round_to_multiple(math.sqrt(area_total / sum(group_ars)), multiple)
        for i in indices:
            dims[i] = (round_to_multiple(height * aspect_ratios[i], multiple), height)
            assigned[i] = True

    def _solve_shared_width(indices):
        group_ars = [aspect_ratios[i] for i in indices]
        area_total = megapixels * 1_000_000 * len(indices)
        width = round_to_multiple(math.sqrt(area_total / sum(1 / ar for ar in group_ars)), multiple)
        for i in indices:
            dims[i] = (width, round_to_multiple(width / aspect_ratios[i], multiple))
            assigned[i] = True

    rows = {}
    for i in range(n):
        rows.setdefault((round(bboxes[i][1], 6), round(bboxes[i][3], 6)), []).append(i)
    for indices in rows.values():
        if len(indices) >= 2:
            _solve_shared_height(indices)

    remaining = [i for i in range(n) if not assigned[i]]
    cols = {}
    for i in remaining:
        cols.setdefault((round(bboxes[i][0], 6), round(bboxes[i][2], 6)), []).append(i)
    for indices in cols.values():
        if len(indices) >= 2:
            _solve_shared_width(indices)

    for i in range(n):
        if not assigned[i]:
            dims[i] = solve_dimensions_from_megapixels(aspect_ratios[i], megapixels, multiple)

    return dims
