"""Image fitting, polygon masking, and tensor<->PIL helpers for PanelCompositor."""

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter

RESAMPLE_FILTERS = {
    "nearest": Image.NEAREST,
    "bilinear": Image.BILINEAR,
    "bicubic": Image.BICUBIC,
    "lanczos": Image.LANCZOS,
}


def tensor_to_pil(image_tensor):
    """ComfyUI IMAGE tensor (1,H,W,C) or (H,W,C), float 0-1 -> RGB PIL.Image."""
    arr = image_tensor
    if arr.dim() == 4:
        arr = arr[0]
    arr = (arr.clamp(0, 1).cpu().numpy() * 255.0).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def pil_to_tensor(image):
    """RGB PIL.Image -> ComfyUI IMAGE tensor (1,H,W,C), float 0-1."""
    arr = np.array(image.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def fit_image(image, target_w, target_h, fit_mode, scale_algo, pad_color):
    """Resize/fit `image` into an exact (target_w, target_h) box."""
    resample = RESAMPLE_FILTERS[scale_algo]
    src_w, src_h = image.size

    if fit_mode == "stretch":
        return image.resize((target_w, target_h), resample)

    if fit_mode == "cover":
        scale = max(target_w / src_w, target_h / src_h)
        new_w, new_h = round(src_w * scale), round(src_h * scale)
        resized = image.resize((new_w, new_h), resample)
        left = (new_w - target_w) // 2
        top = (new_h - target_h) // 2
        return resized.crop((left, top, left + target_w, top + target_h))

    if fit_mode == "contain":
        scale = min(target_w / src_w, target_h / src_h)
        new_w, new_h = round(src_w * scale), round(src_h * scale)
        resized = image.resize((new_w, new_h), resample)
        canvas = Image.new("RGB", (target_w, target_h), pad_color)
        left = (target_w - new_w) // 2
        top = (target_h - new_h) // 2
        canvas.paste(resized, (left, top))
        return canvas

    raise ValueError(f"Unknown fit_mode: {fit_mode!r}")


def build_panel_mask(polygon_norm, canvas_w, canvas_h, gutter_px):
    """Rasterize a normalized polygon to a feathered, gutter-inset 'L' mask.

    Panels in the fixed presets share edges (touching polygons, no gap), so the
    gutter is carved out here via morphological erosion rather than relying on
    authored spacing between polygons. A square-kernel min-filter approximates
    an isotropic inset well enough for axis-aligned Phase 1 presets; arbitrary
    (non-rectangular) Phase 2 polygons will get slightly rounded corners from
    this, which is acceptable for a gutter line.
    """
    scaled = [(x * canvas_w, y * canvas_h) for x, y in polygon_norm]
    mask = Image.new("L", (canvas_w, canvas_h), 0)
    ImageDraw.Draw(mask).polygon(scaled, fill=255)

    if gutter_px > 0:
        erosion_radius = max(1, gutter_px // 2)
        kernel_size = erosion_radius * 2 + 1
        mask = mask.filter(ImageFilter.MinFilter(kernel_size))

    return mask.filter(ImageFilter.GaussianBlur(radius=1.2))
