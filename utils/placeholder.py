"""Placeholder swatch for a panel with no supplied image. Mirrors the same
palette/label look as the live schematic preview in Panel Layout Provider
(web/panel_layout_preview.js), so a missing panel in the composited page
visually matches what the user already saw there."""

import colorsys

from PIL import Image, ImageDraw, ImageFont


def _palette_color(index, total):
    hue = index / max(total, 1)
    r, g, b = colorsys.hsv_to_rgb(hue, 0.35, 0.95)
    return (int(r * 255), int(g * 255), int(b * 255))


def render_placeholder(width, height, order, total_panels):
    width, height = max(width, 1), max(height, 1)
    image = Image.new("RGB", (width, height), _palette_color(order, total_panels))
    draw = ImageDraw.Draw(image)

    outline_w = max(2, round(min(width, height) * 0.01))
    draw.rectangle(
        (outline_w / 2, outline_w / 2, width - 1 - outline_w / 2, height - 1 - outline_w / 2),
        outline=(20, 20, 20),
        width=outline_w,
    )

    label = str(order)
    label_size = max(14, round(min(width, height) * 0.12))
    try:
        font = ImageFont.load_default(size=label_size)
    except TypeError:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), label, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((width - tw) / 2, (height - th) / 2), label, fill=(20, 20, 20), font=font)

    return image
