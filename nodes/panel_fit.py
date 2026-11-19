"""Panel Fit: places each panel image inside its panel's bounding box the way you set it in the editor.

Output images are exactly the panel's bounding-box size on the page (same rounding as Panel Compositor),
so Panel Compositor's "cover" mode pastes them without cropping or scaling.

Per panel (the `fits` JSON list, index = panel in reading order):
    z   : zoom; 1 = image just covers the panel
    x, y: image centre offset from the panel centre, as a fraction of panel width / height
The math is mirrored in web/panel_fit.js; keep both in step.
"""
import json
import os
import random

import numpy as np
import torch
from PIL import Image, ImageColor

import folder_paths

from aiohttp import web
from server import PromptServer

PREVIEW_MAX = 2048
LAST = {}  # node id -> the panel images it last received, so the editor opens on them even after a cached run


@PromptServer.instance.routes.get("/panelcomposer/last/{kind}/{uid}")
async def get_last(request):
    data = LAST.get(request.match_info["uid"])
    return web.json_response(data) if data is not None else web.Response(status=404)


def panel_boxes(layout):
    cw, ch = layout["canvas_width"], layout["canvas_height"]
    boxes = []
    for p in sorted(layout["panels"], key=lambda p: p["order"]):
        xs, ys = [q[0] for q in p["polygon"]], [q[1] for q in p["polygon"]]
        x0, y0, x1, y1 = round(min(xs) * cw), round(min(ys) * ch), round(max(xs) * cw), round(max(ys) * ch)
        boxes.append((x0, y0, max(1, x1 - x0), max(1, y1 - y0)))
    return boxes


def place(img, bw, bh, fit, fill):
    iw, ih = img.size
    z = min(10.0, max(0.05, float(fit.get("z", 1))))
    s = max(bw / iw, bh / ih) * z
    cx, cy = bw / 2 + float(fit.get("x", 0)) * bw, bh / 2 + float(fit.get("y", 0)) * bh
    left, top = cx - iw * s / 2, cy - ih * s / 2
    out = Image.new("RGB", (bw, bh), fill)
    # visible part of the image inside the panel, in panel pixels
    vx0, vy0 = max(0, round(left)), max(0, round(top))
    vx1, vy1 = min(bw, round(left + iw * s)), min(bh, round(top + ih * s))
    if vx1 <= vx0 or vy1 <= vy0:
        return out
    src = (max(0.0, (vx0 - left) / s), max(0.0, (vy0 - top) / s), min(iw, (vx1 - left) / s), min(ih, (vy1 - top) / s))
    part = img.resize((vx1 - vx0, vy1 - vy0), Image.LANCZOS, box=src)
    out.paste(part, (vx0, vy0))
    return out


class PanelFit:
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "layout_json": ("STRING", {"multiline": True}),  # a linked widget, like Panel Compositor's; forceInput shifted saved values on load
            "fill_color": ("STRING", {"default": "#FFFFFF"}),
            "fits": ("STRING", {"default": "[]"}),
        }, "hidden": {"unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "run"
    CATEGORY = "PanelComposer/Compositing"

    def run(self, images, layout_json, fill_color, fits, unique_id=None):
        layout = json.loads(layout_json[0])
        try:
            fit_list = json.loads(fits[0] or "[]")
        except json.JSONDecodeError:
            fit_list = []
        fill = ImageColor.getrgb(fill_color[0])
        boxes = panel_boxes(layout)
        if len(images) > 1:  # a list: one image per panel
            panels = [t[0] for t in images[: len(boxes)]]
        else:  # a single batch: one image per panel
            panels = list(images[0][: len(boxes)])
        out, previews = [], []
        for i, t in enumerate(panels):
            img = to_pil(t)
            p = img.copy()
            p.thumbnail((PREVIEW_MAX, PREVIEW_MAX), Image.LANCZOS)
            name = f"panelfit_{random.randint(0, 10**9):09d}.png"
            p.save(os.path.join(folder_paths.get_temp_directory(), name), compress_level=1)
            previews.append({"filename": name, "subfolder": "", "type": "temp", "w": img.width, "h": img.height})
            fit = fit_list[i] if i < len(fit_list) and isinstance(fit_list[i], dict) else {}
            _, _, bw, bh = boxes[i]
            placed = place(img, bw, bh, fit, fill)
            out.append(torch.from_numpy(np.asarray(placed).astype(np.float32) / 255.0)[None])
        uid = (unique_id or [None])[0]
        if uid is not None:
            LAST[str(uid)] = {"images": previews, "layout": layout_json[0]}
        return {"ui": {"panel_images": previews, "panel_layout": [layout_json[0]]}, "result": (out,)}


def to_pil(t):
    return Image.fromarray(np.clip(t.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)).convert("RGB")
