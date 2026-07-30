"""Phase 1 fixed panel layouts. Each preset is a list of panel dicts with
normalized (0-1) polygons, in reading order.

The actual preset data (panel polygons + reading-order groupings) lives in
web/layouts.json, not here — data-driven so adding a new preset is a JSON
edit, not a code change. It's under web/ (not presets/) specifically so the
JS live preview (web/panel_layout_preview.js) can fetch the exact same file
instead of hand-maintaining its own copy, which is what it used to do
before this and was a standing "keep these two files in sync by hand" risk.
This module just loads that file once and keeps the rotation/reading-order
math + the small runtime API the rest of the pack imports.
"""

import json
import os

from ..utils.geometry import polygon_centroid

_LAYOUTS_JSON_PATH = os.path.join(os.path.dirname(__file__), "..", "web", "layouts.json")

with open(_LAYOUTS_JSON_PATH, encoding="utf-8") as _f:
    _PRESETS = json.load(_f)

LAYOUT_NAMES = list(_PRESETS.keys())

# A flat dropdown of 11+ raw preset keys gets unwieldy, and ComfyUI's combo
# widget has no native grouping — so the dropdown shown to the user is
# "Category / Label" strings (grouped by construction: same-category entries
# share a prefix and sit together in list order) instead of raw keys, with
# LAYOUT_CHOICE_TO_NAME mapping the selected choice back to the real preset
# key. `category`/`label` live in layouts.json right alongside each preset's
# geometry, rather than a separate lookup table, so a new preset can't add
# geometry but forget to also make itself selectable.
LAYOUT_CHOICES = [f"{data['category']} / {data['label']}" for data in _PRESETS.values()]
LAYOUT_CHOICE_TO_NAME = {
    f"{data['category']} / {data['label']}": name for name, data in _PRESETS.items()
}


def get_layout(preset_name):
    polygons = _PRESETS[preset_name]["panels"]
    return [
        {"id": i, "order": i, "polygon": [list(point) for point in polygon]}
        for i, polygon in enumerate(polygons)
    ]


# Structural grouping of each preset's panels, for reading-order purposes —
# a rotation-invariant fact about which panels were originally peers in a
# row/column, authored once per preset rather than auto-detected from bboxes
# (bbox-based row detection breaks on asymmetric presets, e.g.
# three_wedge_top_split's middle panel has a taller bbox than its neighbors).
# Nested lists = nested structure (e.g. four_grid is "2 rows, 2 panels
# each"); a bare id = a panel with no peers at its level. The actual ORDER
# is computed from this structure combined with each panel's *rotated*
# centroid (see apply_reading_order below), so it stays correct under
# rotation instead of being a fixed table that only works at rotation "0".
READING_GROUPS = {name: data["reading_groups"] for name, data in _PRESETS.items()}


def _group_centroid(group, centroids):
    """Average centroid of every panel id under `group` (recursively)."""
    if isinstance(group, int):
        return centroids[group]
    points = [_group_centroid(g, centroids) for g in group]
    return (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))


def _ordered_ids(group, centroids, reading_order):
    """Flattens `group` into a list of panel ids in reading order, sorting at
    each nesting level by whichever axis (X or Y) has more spread among that
    level's sub-groups — Y (rows, top-to-bottom) is never reversed by
    reading_order; X (left-right within a row) is reversed for
    right_to_left. This is what makes the order adapt correctly to
    whatever the *rotated* geometry looks like, rather than assuming the
    layout is still in its original (rotation="0") orientation."""
    if isinstance(group, int):
        return [group]

    sub_centroids = [_group_centroid(g, centroids) for g in group]
    xs = [c[0] for c in sub_centroids]
    ys = [c[1] for c in sub_centroids]
    y_spread = max(ys) - min(ys) if len(ys) > 1 else 0.0
    x_spread = max(xs) - min(xs) if len(xs) > 1 else 0.0

    indices = list(range(len(group)))
    if y_spread >= x_spread:
        indices.sort(key=lambda i: sub_centroids[i][1])
    else:
        indices.sort(key=lambda i: sub_centroids[i][0], reverse=(reading_order == "right_to_left"))

    ordered = []
    for i in indices:
        ordered.extend(_ordered_ids(group[i], centroids, reading_order))
    return ordered


def apply_reading_order(panels, reading_order, preset_name):
    """Reassigns each panel's `order` (never `id`, which stays a stable
    identity for the panel regardless of reading order or rotation) based
    on the panels' CURRENT polygons — call this after apply_rotation, not
    before, so the order reflects the final rotated layout. Returns the
    panels sorted by the new order."""
    group = READING_GROUPS.get(preset_name)
    if group is None:
        return sorted(panels, key=lambda p: p["order"])

    centroids = {p["id"]: polygon_centroid(p["polygon"]) for p in panels}
    ordered_ids = _ordered_ids(group, centroids, reading_order)
    order_by_id = {panel_id: order for order, panel_id in enumerate(ordered_ids)}

    panels = [{**p, "order": order_by_id[p["id"]]} for p in panels]
    return sorted(panels, key=lambda p: p["order"])


_ROTATION_TRANSFORMS = {
    "0": lambda x, y: [x, y],
    "90": lambda x, y: [1.0 - y, x],
    "180": lambda x, y: [1.0 - x, 1.0 - y],
    "270": lambda x, y: [y, 1.0 - x],
}


def apply_rotation(panels, rotation):
    """Rotates every panel's polygon by 0/90/180/270 degrees (clockwise)
    around the page center. `id` and `order` are untouched — this is a pure
    geometry transform."""
    if rotation == "0":
        return panels
    transform = _ROTATION_TRANSFORMS[rotation]
    return [
        {**p, "polygon": [transform(x, y) for x, y in p["polygon"]]}
        for p in panels
    ]
