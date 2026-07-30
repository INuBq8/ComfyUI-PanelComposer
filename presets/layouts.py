"""Phase 1 fixed panel layouts. Each preset is a list of panel dicts with
normalized (0-1) polygons, in reading order."""

from ..utils.geometry import polygon_centroid


def _panel(order, polygon):
    return {"id": order, "order": order, "polygon": polygon}


LAYOUTS = {
    "single_full_page": [
        _panel(0, [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]),
    ],
    "two_vertical_split": [
        _panel(0, [[0.0, 0.0], [1.0, 0.0], [1.0, 0.5], [0.0, 0.5]]),
        _panel(1, [[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]]),
    ],
    "two_horizontal_split": [
        _panel(0, [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]]),
        _panel(1, [[0.5, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 1.0]]),
    ],
    "three_top_split": [
        _panel(0, [[0.0, 0.0], [0.5, 0.0], [0.5, 0.46], [0.0, 0.46]]),
        _panel(1, [[0.5, 0.0], [1.0, 0.0], [1.0, 0.46], [0.5, 0.46]]),
        _panel(2, [[0.0, 0.46], [1.0, 0.46], [1.0, 1.0], [0.0, 1.0]]),
    ],
    "four_grid": [
        _panel(0, [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]),
        _panel(1, [[0.5, 0.0], [1.0, 0.0], [1.0, 0.5], [0.5, 0.5]]),
        _panel(2, [[0.0, 0.5], [0.5, 0.5], [0.5, 1.0], [0.0, 1.0]]),
        _panel(3, [[0.5, 0.5], [1.0, 0.5], [1.0, 1.0], [0.5, 1.0]]),
    ],
    # Diagonal cut instead of a straight split — both panels are trapezoids.
    "two_diagonal_split": [
        _panel(0, [[0.0, 0.0], [1.0, 0.0], [1.0, 0.7], [0.0, 0.3]]),
        _panel(1, [[0.0, 0.3], [1.0, 0.7], [1.0, 1.0], [0.0, 1.0]]),
    ],
    # Three slanted parallelograms, all sharing the same diagonal slope — a
    # common "dynamic/action" cascade layout in manga.
    "three_panel_cascade_diagonal": [
        _panel(0, [[0.0, 0.0], [0.3333, 0.0], [0.4533, 1.0], [0.0, 1.0]]),
        _panel(1, [[0.3333, 0.0], [0.6667, 0.0], [0.7867, 1.0], [0.4533, 1.0]]),
        _panel(2, [[0.6667, 0.0], [1.0, 0.0], [1.0, 1.0], [0.7867, 1.0]]),
    ],
    # Three non-rectangular panels on top — the two outer ones are trapezoids
    # (inner edge slants outward toward the bottom), the middle one is a
    # wedge that tapers down and dips below them — plus one big panel below
    # with a matching notch cut into its top. Roughly: |__\_/__| over a
    # full-width panel.
    "three_wedge_top_split": [
        _panel(0, [[0.0, 0.0], [0.30, 0.0], [0.40, 0.35], [0.0, 0.35]]),
        _panel(1, [
            [0.30, 0.0], [0.70, 0.0], [0.60, 0.35],
            [0.53, 0.50], [0.47, 0.50], [0.40, 0.35],
        ]),
        _panel(2, [[0.70, 0.0], [1.0, 0.0], [1.0, 0.35], [0.60, 0.35]]),
        _panel(3, [
            [0.0, 0.35], [0.40, 0.35], [0.47, 0.50], [0.53, 0.50],
            [0.60, 0.35], [1.0, 0.35], [1.0, 1.0], [0.0, 1.0],
        ]),
    ],
    # Concave L-shaped main panel wrapping a small square inset panel in the
    # bottom-right corner (e.g. a reaction/detail shot over the main scene).
    "corner_inset_l_shape": [
        _panel(0, [
            [0.0, 0.0], [1.0, 0.0], [1.0, 0.65],
            [0.65, 0.65], [0.65, 1.0], [0.0, 1.0],
        ]),
        _panel(1, [[0.65, 0.65], [1.0, 0.65], [1.0, 1.0], [0.65, 1.0]]),
    ],
}

LAYOUT_NAMES = list(LAYOUTS.keys())


def get_layout(preset_name):
    return [dict(p) for p in LAYOUTS[preset_name]]


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
READING_GROUPS = {
    "single_full_page": [0],
    "two_vertical_split": [[0], [1]],
    "two_horizontal_split": [[0, 1]],
    "three_top_split": [[0, 1], [2]],
    "four_grid": [[0, 1], [2, 3]],
    "two_diagonal_split": [[0], [1]],
    "three_panel_cascade_diagonal": [[0, 1, 2]],
    "three_wedge_top_split": [[0, 1, 2], [3]],
    "corner_inset_l_shape": [[0], [1]],
}


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
