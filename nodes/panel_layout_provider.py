import json

from ..presets.layouts import LAYOUT_NAMES, get_layout
from ..utils.geometry import bbox_from_polygon, parse_aspect_ratio, solve_dimensions_from_megapixels

ASPECT_RATIOS = ["2:3", "1:1", "3:4", "16:9"]


class PanelLayoutProvider:
    """Phase 1: outputs panel geometry from a fixed preset. Never touches pixels.
    The page layout is shown directly on the node — drawn client-side, live,
    with no execution needed — see web/panel_layout_preview.js, which mirrors
    the preset polygons from presets/layouts.py."""

    CATEGORY = "Manga/Layout"
    FUNCTION = "get_layout"
    RETURN_TYPES = ("STRING", "PANEL_DIMENSIONS")
    RETURN_NAMES = ("layout_json", "panel_dimensions")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "layout_preset": (LAYOUT_NAMES,),
                "aspect_ratio": (ASPECT_RATIOS,),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 16.0, "step": 0.01}),
                "multiple": ("INT", {"default": 64, "min": 1, "max": 256, "step": 1}),
            }
        }

    def get_layout(self, layout_preset, aspect_ratio, megapixels, multiple):
        panels = get_layout(layout_preset)
        page_ar = parse_aspect_ratio(aspect_ratio)

        panel_dimensions = []
        for panel in panels:
            min_x, min_y, max_x, max_y = bbox_from_polygon(panel["polygon"])
            bbox_w, bbox_h = max_x - min_x, max_y - min_y
            panel_ar = page_ar * (bbox_w / bbox_h)
            panel_dimensions.append(
                solve_dimensions_from_megapixels(panel_ar, megapixels, multiple)
            )

        layout_json = json.dumps({"panels": panels})
        return (layout_json, panel_dimensions)


NODE_CLASS_MAPPINGS = {"PanelLayoutProvider": PanelLayoutProvider}
NODE_DISPLAY_NAME_MAPPINGS = {"PanelLayoutProvider": "Panel Layout Provider (Manga)"}
