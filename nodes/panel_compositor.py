import json
import math

from PIL import Image, ImageColor

from ..utils.compositing import build_panel_mask, fit_image, pil_to_tensor, tensor_to_pil
from ..utils.geometry import (
    ASPECT_RATIO_CHOICES,
    FIXED_PRESET_MEGAPIXELS,
    bbox_from_polygon,
    resolve_oriented_aspect_ratio,
    solve_dimensions_from_megapixels,
)
from ..utils.placeholder import render_placeholder

ASPECT_RATIOS = list(ASPECT_RATIO_CHOICES.keys())


class PanelCompositor:
    """Stitches user-generated per-panel images into one page, per layout_json.
    Performs no generation; geometry comes entirely from Node 1's output."""

    CATEGORY = "PanelComposer/Compositing"
    FUNCTION = "composite"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("page_image",)

    # `images` is a variable-length list of independently-sized IMAGE tensors
    # (one per panel) — ComfyUI's native IMAGE batching requires uniform H/W,
    # so this node opts into list-mode inputs instead of a single batch tensor.
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (False,)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "layout_json": ("STRING", {"multiline": True}),
                "images": ("IMAGE",),
                "canvas_mode": (["auto", "fixed_preset", "fixed_custom", "scale_to_input"],),
                "aspect_ratio": (ASPECT_RATIOS,),
                "fixed_preset_size": (["1080p", "2K", "4K"],),
                "fixed_custom_megapixels": ("FLOAT", {"default": 2.0, "min": 0.1, "max": 64.0, "step": 0.1}),
                "page_orientation": (["auto", "portrait", "landscape"],),
                "scale_to_input_mode": (["largest", "smallest"],),
                "fit_mode": (
                    ["cover", "contain", "stretch", "fit_to_shape"],
                    {
                        "tooltip": (
                            "cover: fill panel, crop overflow. contain: fit inside panel, pad "
                            "the rest. stretch: fill panel exactly, ignore aspect ratio. "
                            "fit_to_shape: warp image to match non-rectangular panels "
                            "(EXPERIMENTAL — only the built-in presets are verified; check the "
                            "result on custom/drawn shapes)."
                        )
                    },
                ),
                "scale_algo": (["nearest", "bilinear", "bicubic", "lanczos"], {"default": "lanczos"}),
                "gutter_px": ("INT", {"default": 6, "min": 0, "max": 256}),
                "gutter_color": ("STRING", {"default": "#000000"}),
            }
        }

    def composite(
        self,
        layout_json,
        images,
        canvas_mode,
        aspect_ratio,
        fixed_preset_size,
        fixed_custom_megapixels,
        page_orientation,
        scale_to_input_mode,
        fit_mode,
        scale_algo,
        gutter_px,
        gutter_color,
    ):
        # INPUT_IS_LIST wraps every input in a list; `images` is meant to stay
        # a list (one tensor per panel), the rest are single scalar widgets.
        layout_json = layout_json[0]
        canvas_mode = canvas_mode[0]
        aspect_ratio = aspect_ratio[0]
        fixed_preset_size = fixed_preset_size[0]
        fixed_custom_megapixels = fixed_custom_megapixels[0]
        page_orientation = page_orientation[0]
        scale_to_input_mode = scale_to_input_mode[0]
        fit_mode = fit_mode[0]
        scale_algo = scale_algo[0]
        gutter_px = gutter_px[0]
        gutter_color = gutter_color[0]

        panels, layout_page_orientation, layout_canvas_w, layout_canvas_h = self._parse_layout(layout_json)

        # "auto" (the default) follows whatever orientation Panel Layout
        # Provider designed the layout for, read straight from layout_json —
        # explicit portrait/landscape here overrides that on purpose.
        if page_orientation == "auto":
            page_orientation = layout_page_orientation

        # More images than panels: drop the extras (matched by position, so
        # it's whatever's left over at the tail that gets dropped). Fewer
        # images than panels is also allowed: panels beyond the supplied
        # images render as the same numbered placeholder swatch shown live
        # in Panel Layout Provider, so a partial render still shows the
        # whole page.
        images = images[: len(panels)]

        pil_images = []
        for idx, img_tensor in enumerate(images):
            pil_img = tensor_to_pil(img_tensor)
            if pil_img.width <= 0 or pil_img.height <= 0:
                raise ValueError(f"Panel Compositor: image at index {idx} has zero width/height.")
            pil_images.append(pil_img)

        if canvas_mode == "scale_to_input" and not pil_images:
            raise ValueError(
                "Panel Compositor: canvas_mode 'scale_to_input' needs at least one real image "
                "to size the canvas from, but none were supplied."
            )

        try:
            gutter_rgb = ImageColor.getrgb(gutter_color)
        except ValueError as e:
            raise ValueError(f"Panel Compositor: gutter_color {gutter_color!r} is not a valid color: {e}")

        canvas_w, canvas_h = self._compute_canvas_size(
            panels,
            pil_images,
            canvas_mode,
            aspect_ratio,
            fixed_preset_size,
            fixed_custom_megapixels,
            page_orientation,
            scale_to_input_mode,
            layout_canvas_w,
            layout_canvas_h,
        )

        canvas = Image.new("RGB", (canvas_w, canvas_h), gutter_rgb)

        for i, panel in enumerate(panels):
            min_x, min_y, max_x, max_y = bbox_from_polygon(panel["polygon"])
            bbox_x0, bbox_y0 = round(min_x * canvas_w), round(min_y * canvas_h)
            bbox_x1, bbox_y1 = round(max_x * canvas_w), round(max_y * canvas_h)
            bbox_w, bbox_h = max(1, bbox_x1 - bbox_x0), max(1, bbox_y1 - bbox_y0)

            if i < len(pil_images):
                polygon_local = None
                if fit_mode == "fit_to_shape":
                    polygon_local = [
                        (x * canvas_w - bbox_x0, y * canvas_h - bbox_y0) for x, y in panel["polygon"]
                    ]
                fitted = fit_image(pil_images[i], bbox_w, bbox_h, fit_mode, scale_algo, gutter_rgb, polygon_local)
            else:
                fitted = render_placeholder(bbox_w, bbox_h, panel["order"], len(panels))

            layer = Image.new("RGB", (canvas_w, canvas_h), gutter_rgb)
            layer.paste(fitted, (bbox_x0, bbox_y0))

            mask = build_panel_mask(panel["polygon"], canvas_w, canvas_h, gutter_px)
            canvas = Image.composite(layer, canvas, mask)

        return (pil_to_tensor(canvas),)

    @staticmethod
    def _parse_layout(layout_json):
        try:
            data = json.loads(layout_json)
        except json.JSONDecodeError as e:
            raise ValueError(f"Panel Compositor: layout_json failed to parse: {e}")

        # layout_json is a free-text widget — it can come from a downstream
        # node, be hand-typed, or be baked into a shared workflow file from
        # anywhere, so nothing about its shape can be assumed past "valid
        # JSON." A non-object top level (a bare number/string/list/null)
        # would otherwise reach the "panels" not in data check below and
        # raise a raw, unclear TypeError instead of this module's own
        # consistent ValueError-with-context style.
        if not isinstance(data, dict):
            raise ValueError("Panel Compositor: layout_json must be a JSON object.")
        if "panels" not in data:
            raise ValueError("Panel Compositor: layout_json is missing required field 'panels'.")

        panels = data["panels"]
        if not isinstance(panels, list) or not panels:
            raise ValueError("Panel Compositor: layout_json's 'panels' must be a non-empty list.")
        for i, panel in enumerate(panels):
            if not isinstance(panel, dict) or "polygon" not in panel or "order" not in panel:
                raise ValueError(
                    f"Panel Compositor: panel at position {i} is missing 'polygon' or 'order'."
                )
            polygon = panel["polygon"]
            if not isinstance(polygon, list) or len(polygon) < 3:
                raise ValueError(
                    f"Panel Compositor: panel at position {i}'s polygon needs at least 3 points."
                )
            for point in polygon:
                if (
                    not isinstance(point, (list, tuple))
                    or len(point) != 2
                    or not all(
                        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                        for v in point
                    )
                ):
                    raise ValueError(
                        f"Panel Compositor: panel at position {i} has a malformed point "
                        "(every point must be an [x, y] pair of finite numbers)."
                    )

        # Older layout_json without these fields (or hand-written JSON) just
        # falls back to portrait / no canvas size, rather than erroring here —
        # canvas_mode 'auto' is what actually enforces canvas_width/height
        # being present, since that's the only mode that needs them.
        page_orientation = data.get("page_orientation", "portrait")
        canvas_width = data.get("canvas_width")
        canvas_height = data.get("canvas_height")
        for name, value in (("canvas_width", canvas_width), ("canvas_height", canvas_height)):
            if value is not None and (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
                or value <= 0
            ):
                raise ValueError(f"Panel Compositor: layout_json's '{name}' must be a positive number.")

        try:
            panels = sorted(panels, key=lambda p: p["order"])
        except TypeError:
            raise ValueError("Panel Compositor: every panel's 'order' must be a consistent, sortable type.")

        return panels, page_orientation, canvas_width, canvas_height

    @staticmethod
    def _compute_canvas_size(
        panels,
        pil_images,
        canvas_mode,
        aspect_ratio,
        fixed_preset_size,
        fixed_custom_megapixels,
        page_orientation,
        scale_to_input_mode,
        layout_canvas_w,
        layout_canvas_h,
    ):
        if canvas_mode == "auto":
            if layout_canvas_w is None or layout_canvas_h is None:
                raise ValueError(
                    "Panel Compositor: canvas_mode 'auto' needs canvas_width/canvas_height "
                    "from layout_json, but this layout_json doesn't have them (e.g. from an "
                    "older Panel Layout Provider). Pick 'fixed_preset', 'fixed_custom', or "
                    "'scale_to_input' instead, or reconnect a current Panel Layout Provider."
                )
            return layout_canvas_w, layout_canvas_h

        if canvas_mode == "fixed_preset":
            ar = resolve_oriented_aspect_ratio(ASPECT_RATIO_CHOICES[aspect_ratio], page_orientation)
            mp = FIXED_PRESET_MEGAPIXELS[fixed_preset_size]
            return solve_dimensions_from_megapixels(ar, mp)

        if canvas_mode == "fixed_custom":
            ar = resolve_oriented_aspect_ratio(ASPECT_RATIO_CHOICES[aspect_ratio], page_orientation)
            return solve_dimensions_from_megapixels(ar, fixed_custom_megapixels)

        if canvas_mode == "scale_to_input":
            areas = [img.width * img.height for img in pil_images]
            ref_idx = (max if scale_to_input_mode == "largest" else min)(
                range(len(areas)), key=lambda i: areas[i]
            )
            min_x, min_y, max_x, max_y = bbox_from_polygon(panels[ref_idx]["polygon"])
            bbox_w_norm, bbox_h_norm = max_x - min_x, max_y - min_y
            if bbox_w_norm <= 0 or bbox_h_norm <= 0:
                raise ValueError(
                    "Panel Compositor: canvas_mode 'scale_to_input' can't use a panel with a "
                    "zero-width or zero-height polygon as its size reference."
                )
            ref_img = pil_images[ref_idx]
            canvas_w = ref_img.width / bbox_w_norm
            canvas_h = ref_img.height / bbox_h_norm
            return round(canvas_w), round(canvas_h)

        raise ValueError(f"Panel Compositor: unknown canvas_mode {canvas_mode!r}")


NODE_CLASS_MAPPINGS = {"PanelCompositor": PanelCompositor}
NODE_DISPLAY_NAME_MAPPINGS = {"PanelCompositor": "Panel Compositor (PanelComposer)"}
