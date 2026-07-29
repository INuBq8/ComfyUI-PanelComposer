"""Phase 1 fixed panel layouts. Each preset is a list of panel dicts with
normalized (0-1) polygons, in reading order."""


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
