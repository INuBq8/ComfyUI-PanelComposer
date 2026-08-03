import json

from ..presets import layouts
from ..presets.layouts import apply_reading_order, apply_rotation, get_layout
from ..utils.compositing import pil_to_tensor
from ..utils.geometry import (
    ASPECT_RATIO_CHOICES,
    FIXED_PRESET_MEGAPIXELS,
    compute_panel_dimensions,
    parse_aspect_ratio,
    resolve_oriented_aspect_ratio,
    solve_dimensions_from_megapixels,
)
from ..utils.region_map import render_region_map

ASPECT_RATIOS = list(ASPECT_RATIO_CHOICES.keys())
FIXED_PRESET_SIZES = list(FIXED_PRESET_MEGAPIXELS.keys())


class PanelLayoutProvider:
    """Phase 1: outputs panel geometry from a fixed preset. Never touches pixels
    for the actual page (area_image is the one exception — see below).
    Also decides the actual page canvas size/shape (orientation + aspect_ratio
    + resolution) — Panel Compositor's 'auto' canvas_mode reads it straight
    from layout_json instead of deciding independently, so the two nodes
    can't quietly disagree on page shape. The page layout is shown directly
    on the node — drawn client-side, live, with no execution needed — see
    web/panel_layout_preview.js, which fetches the same web/layouts.json
    presets/layouts.py loads and mirrors this same orientation math.

    area_image/area_colors are a shortcut for regional conditioning: rather
    than a downstream workflow re-deriving each panel's mask from
    layout_json's polygons by hand, area_image is a flat-color region map
    (one solid, distinct color per panel, index-aligned with area_colors'
    decimal 0xRRGGBB integers) that can be fed straight into an
    exact-color-match/mask node."""

    CATEGORY = "PanelComposer/Layout"
    FUNCTION = "get_layout"
    RETURN_TYPES = ("STRING", "PANEL_DIMENSIONS", "IMAGE", "COLOR_LIST")
    RETURN_NAMES = ("layout_json", "panel_dimensions", "area_image", "area_colors")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Read fresh off the `layouts` module (not a name imported
                # once at server-startup) so a preset saved through the
                # Draw Panels dialog is selectable/runnable immediately —
                # save_user_layout() rebinds layouts.LAYOUT_CHOICES to a
                # new list object on every save rather than mutating it in
                # place, so a stale direct-name import would never see it.
                "layout_preset": (layouts.LAYOUT_CHOICES,),
                "reading_order": (["left_to_right", "right_to_left"],),
                "canvas_rotation": (["0", "90", "180", "270"],),
                "aspect_ratio": (ASPECT_RATIOS,),
                "page_orientation": (["portrait", "landscape"],),
                "canvas_size_mode": (["fixed_preset", "fixed_custom"],),
                "fixed_preset_size": (FIXED_PRESET_SIZES,),
                "fixed_custom_megapixels": ("FLOAT", {"default": 2.0, "min": 0.1, "max": 64.0, "step": 0.1}),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 16.0, "step": 0.01}),
                "multiple": ("INT", {"default": 64, "min": 1, "max": 256, "step": 1}),
            }
        }

    def get_layout(
        self,
        layout_preset,
        reading_order,
        canvas_rotation,
        aspect_ratio,
        page_orientation,
        canvas_size_mode,
        fixed_preset_size,
        fixed_custom_megapixels,
        megapixels,
        multiple,
    ):
        # The widget shows "Category / Label" (grouped dropdown); resolve it
        # back to the actual preset key everything below expects. Same
        # staleness reasoning as INPUT_TYPES above — read live off the
        # module, not a name captured at import time.
        layout_preset = layouts.LAYOUT_CHOICE_TO_NAME[layout_preset]

        # Rotation only rotates the panel polygons — it does not touch the
        # page's own shape. aspect_ratio/page_orientation alone decide the
        # canvas; a rotated layout is fit onto that same, unchanged canvas.
        panels = get_layout(layout_preset)
        panels = apply_rotation(panels, canvas_rotation)
        # Reading order is computed from the panels' CURRENT (rotated)
        # polygons, so "which panel is read first" adapts to how rotation
        # actually repositioned them, rather than assuming rotation="0".
        panels = apply_reading_order(panels, reading_order, layout_preset)

        # aspect_ratio picks the ratio's magnitude (e.g. '16:9' -> 1.778);
        # page_orientation decides which way it points. This is the single
        # source of truth for the page's shape — used for both the per-panel
        # dimension suggestions below and the real canvas size.
        page_ar = resolve_oriented_aspect_ratio(parse_aspect_ratio(aspect_ratio), page_orientation)

        panel_dimensions = compute_panel_dimensions(panels, page_ar, megapixels, multiple)

        canvas_megapixels = (
            FIXED_PRESET_MEGAPIXELS[fixed_preset_size]
            if canvas_size_mode == "fixed_preset"
            else fixed_custom_megapixels
        )
        canvas_width, canvas_height = solve_dimensions_from_megapixels(page_ar, canvas_megapixels, multiple)

        layout_json = json.dumps({
            "panels": panels,
            "page_orientation": page_orientation,
            "canvas_width": canvas_width,
            "canvas_height": canvas_height,
        })

        region_map_image, area_colors = render_region_map(panels, canvas_width, canvas_height)
        area_image = pil_to_tensor(region_map_image)

        return (layout_json, panel_dimensions, area_image, area_colors)


NODE_CLASS_MAPPINGS = {"PanelLayoutProvider": PanelLayoutProvider}
NODE_DISPLAY_NAME_MAPPINGS = {"PanelLayoutProvider": "Panel Layout Provider (PanelComposer)"}
