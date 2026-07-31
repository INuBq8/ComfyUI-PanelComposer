"""Image fitting, polygon masking, and tensor<->PIL helpers for PanelCompositor."""

import math

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


def fit_image(image, target_w, target_h, fit_mode, scale_algo, pad_color, polygon_local=None):
    """Resize/fit `image` into an exact (target_w, target_h) box.

    `polygon_local` (panel polygon in target_w x target_h pixel space) is
    only required for fit_mode 'fit_to_shape'.
    """
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

    if fit_mode == "fit_to_shape":
        if polygon_local is None:
            raise ValueError("fit_image: fit_mode 'fit_to_shape' requires polygon_local.")
        if len(polygon_local) == 4:
            return _warp_quad(image, target_w, target_h, polygon_local, resample, pad_color)
        return _warp_to_polygon(image, target_w, target_h, polygon_local, resample, pad_color)

    raise ValueError(f"Unknown fit_mode: {fit_mode!r}")


def _cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _signed_area(polygon):
    area = 0.0
    n = len(polygon)
    for i in range(n):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % n]
        area += x0 * y1 - x1 * y0
    return area / 2.0


def _point_in_triangle(p, a, b, c):
    d1, d2, d3 = _cross(a, b, p), _cross(b, c, p), _cross(c, a, p)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def triangulate_polygon(polygon):
    """Ear-clipping triangulation of a simple polygon (convex or concave, no
    holes/self-intersections). Returns a list of (a, b, c) point triples.

    Handles the concave presets (three_wedge_top_split's notched panels,
    corner_inset_l_shape's L panel) that a single 4-corner perspective warp
    can't represent — this is what lets 'fit_to_shape' cover every panel
    shape with one code path instead of a quad-only special case.
    """
    poly = list(polygon)
    if _signed_area(poly) < 0:
        poly.reverse()  # ear clipping below assumes CCW winding

    indices = list(range(len(poly)))
    triangles = []
    while len(indices) > 3:
        n = len(indices)
        ear_found = False
        for i in range(n):
            i_prev, i_curr, i_next = indices[(i - 1) % n], indices[i], indices[(i + 1) % n]
            a, b, c = poly[i_prev], poly[i_curr], poly[i_next]
            if _cross(a, b, c) <= 0:
                continue  # reflex (or collinear) vertex, can't be an ear
            if any(
                _point_in_triangle(poly[j], a, b, c)
                for j in indices
                if j not in (i_prev, i_curr, i_next)
            ):
                continue
            triangles.append((a, b, c))
            del indices[i]
            ear_found = True
            break
        if not ear_found:
            break  # degenerate/collinear leftover — fan-triangulate below as a fallback

    if len(indices) >= 3:
        anchor = poly[indices[0]]
        for i in range(1, len(indices) - 1):
            triangles.append((anchor, poly[indices[i]], poly[indices[i + 1]]))

    return triangles


def _affine_dest_to_src(dest_tri, src_tri):
    """Solve the affine transform (as PIL's Image.transform AFFINE data,
    i.e. output-pixel -> input-pixel) mapping `dest_tri` onto `src_tri`,
    from 3 point correspondences."""
    a_matrix = np.array([[dx, dy, 1.0] for dx, dy in dest_tri])
    coeff_x = np.linalg.solve(a_matrix, np.array([sx for sx, sy in src_tri]))
    coeff_y = np.linalg.solve(a_matrix, np.array([sy for sx, sy in src_tri]))
    return (*coeff_x, *coeff_y)


def _point_on_unit_square_boundary(t):
    """Point at perimeter-fraction `t` (0-1) walking clockwise around
    [0,1]x[0,1] starting at (0,0): top edge, right edge, bottom edge, left
    edge — each 1/4 of the total perimeter (4)."""
    d = (t % 1.0) * 4.0
    if d < 1.0:
        return (d, 0.0)
    d -= 1.0
    if d < 1.0:
        return (1.0, d)
    d -= 1.0
    if d < 1.0:
        return (1.0 - d, 1.0)
    d -= 1.0
    return (0.0, 1.0 - d)


def _t_of_boundary_point(u, v, eps=1e-4):
    """Inverse of `_point_on_unit_square_boundary`, for a point already known
    to be on (or very near) the unit square's boundary."""
    if v <= eps:
        return u / 4.0
    if u >= 1.0 - eps:
        return 0.25 + v / 4.0
    if v >= 1.0 - eps:
        return 0.5 + (1.0 - u) / 4.0
    return 0.75 + (1.0 - v) / 4.0


def _boundary_source_uv(polygon_local, bbox):
    """Per-vertex source-image UV, one per polygon vertex, keyed for lookup
    by rounded (x, y) — see `_warp_to_polygon` for why this can't just be
    each vertex's own bounding-box-relative position (that collapses to a
    plain stretch for every shape, not just rectangles).

    Vertices already on the panel's own bounding-box boundary (every vertex
    of every straight-edged preset — rectangles, trapezoids, parallelograms
    — plus most vertices of the concave ones) are "anchors": their source
    correspondence is exact bbox-relative UV, i.e. that specific corner of
    the source image lands exactly on that corner of the panel, matching
    "drag each corner of the image onto the shape" the way Photoshop's free
    transform would for a quad. This is also why an ordinary rectangle
    reduces to a plain stretch.

    A vertex recessed *inside* the bbox (a concave notch's reflex vertex, a
    wedge's narrow tip) has no such unambiguous position, so it's placed by
    walking the source rectangle's boundary between its two nearest anchors
    (in polygon order), by the same arc-length fraction it sits at between
    them on the panel. Anchoring to real, well-separated neighbors (instead
    of e.g. projecting by angle from the polygon's centroid) is what keeps
    two differently-recessed vertices from ever landing on nearly the same
    source point — that was producing near-zero-area source triangles, i.e.
    a sliver of source pixels blown up across a huge destination region.
    """
    min_x, min_y, max_x, max_y = bbox
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    uv = [((x - min_x) / span_x, (y - min_y) / span_y) for x, y in polygon_local]
    n = len(uv)
    eps = 1e-4

    def on_boundary(u, v):
        return u <= eps or u >= 1.0 - eps or v <= eps or v >= 1.0 - eps

    anchors = {i for i in range(n) if on_boundary(*uv[i])} or set(range(n))
    seg_len = [math.hypot(uv[(i + 1) % n][0] - uv[i][0], uv[(i + 1) % n][1] - uv[i][1]) for i in range(n)]

    result = list(uv)
    for i in range(n):
        if i in anchors:
            continue

        j, back = i, 0.0
        while (j % n) not in anchors:
            back += seg_len[(j - 1) % n]
            j -= 1
        anchor_before = j % n

        k, fwd = i, 0.0
        while (k % n) not in anchors:
            fwd += seg_len[k % n]
            k += 1
        anchor_after = k % n

        t_before = _t_of_boundary_point(*uv[anchor_before])
        t_span = (_t_of_boundary_point(*uv[anchor_after]) - t_before) % 1.0
        frac = back / (back + fwd) if (back + fwd) > 1e-9 else 0.0
        bx, by = _point_on_unit_square_boundary((t_before + t_span * frac) % 1.0)
        # Nudge a hair off the exact boundary (toward the unit square's
        # center). Without this, an interpolated vertex landing exactly on
        # a corner shared with a neighboring anchor's edge makes that
        # triangle's source correspondence collinear (zero area) — see
        # `_warp_to_polygon`'s fallback. That per-triangle fallback fixes
        # the degenerate triangle itself but disagrees with its *neighbor*
        # at their shared vertex, leaving a visible seam; nudging here
        # avoids the exact collision for every triangle that touches this
        # vertex at once, so they all agree and the seam doesn't happen.
        nudge = 0.03
        result[i] = (bx * (1 - nudge) + 0.5 * nudge, by * (1 - nudge) + 0.5 * nudge)

    source_uv = {}
    for (x, y), (u, v) in zip(polygon_local, result):
        source_uv[(round(x, 4), round(y, 4))] = (u, v)
    return source_uv


def _find_perspective_coeffs(dest_pts, src_pts):
    """8 coefficients for PIL's Image.transform PERSPECTIVE method mapping
    each dest_pts[i] to src_pts[i] (4 point correspondences, output-pixel ->
    input-pixel per PIL's convention)."""
    a_rows, b_vals = [], []
    for (x, y), (sx, sy) in zip(dest_pts, src_pts):
        a_rows.append([x, y, 1, 0, 0, 0, -sx * x, -sx * y])
        b_vals.append(sx)
        a_rows.append([0, 0, 0, x, y, 1, -sy * x, -sy * y])
        b_vals.append(sy)
    return np.linalg.solve(np.array(a_rows), np.array(b_vals)).tolist()


def _rotate_to_top_left_start(polygon_local):
    """Rotates a 4-point polygon's array so it starts at whichever vertex is
    geometrically top-left-most (min y, then min x) — the same convention
    ADDING_PRESETS.md documents for hand-authored quads ("clockwise order
    starting from the top-left-most corner") and JS's normalizeWinding
    already enforces for drawn panels at draw/save time.

    Needed here too — this used to be a documented ASSUMPTION rather than
    something re-derived, on the claim that canvas_rotation is "orientation-
    preserving" so the convention just carries through. That's true for
    winding DIRECTION (a rotation is not a reflection, so clockwise stays
    clockwise) but false for which array INDEX ends up first: apply_rotation
    (presets/layouts.py) transforms each vertex's coordinates but has no
    reason to also re-derive which one is now closest to top-left of the
    panel's own (rotated) bounding box. A 180° rotation is the clearest
    case — confirmed by direct test, e.g. single_full_page's
    [[0,0],[1,0],[1,1],[0,1]] becomes [[1,1],[0,1],[0,0],[1,0]] at
    canvas_rotation=180: array position 0 is now the panel's own
    bottom-right, not top-left, so pairing it positionally with the source
    image's top-left corner (as this function does below) silently rotated
    every fit_to_shape panel's CONTENT by 180° while the panel's own
    border/position looked correctly rotated — real bug, `stretch` was
    unaffected since it never does per-vertex correspondence at all.
    """
    min_idx = 0
    for i in range(1, len(polygon_local)):
        x, y = polygon_local[i]
        mx, my = polygon_local[min_idx]
        if y < my - 1e-6 or (abs(y - my) <= 1e-6 and x < mx):
            min_idx = i
    return polygon_local[min_idx:] + polygon_local[:min_idx]


def _warp_quad(image, target_w, target_h, polygon_local, resample, pad_color):
    """True perspective (homography) warp for a 4-vertex panel: the source
    image's 4 actual corners map exactly onto the panel's 4 actual vertices
    — the same thing as dragging each corner of an image in Photoshop's
    Free Transform > Distort onto a target quad. Unlike matching by bbox-
    relative position (which only reduces to this for a vertex that happens
    to sit at an actual *corner* of its own bounding box, not just on one of
    its edges), this reaches every corner of the source image even for a
    quad like a slanted trapezoid whose 4th vertex sits partway along a bbox
    edge instead of at a bbox corner — otherwise the source content nearer
    that missing bbox corner just never appears anywhere in the panel,
    which is what made `fit_to_shape` visually indistinguishable from
    `stretch` for two_diagonal_split and three_panel_cascade_diagonal.
    Re-derives the top-left-most vertex itself (see
    `_rotate_to_top_left_start`) rather than trusting `polygon_local`'s
    array order — that order is NOT reliably preserved by canvas_rotation.
    """
    polygon_local = _rotate_to_top_left_start(list(polygon_local))
    src_w, src_h = image.size
    src_corners = [(0, 0), (src_w, 0), (src_w, src_h), (0, src_h)]
    coeffs = _find_perspective_coeffs(polygon_local, src_corners)
    warp_resample = Image.BICUBIC if resample == Image.LANCZOS else resample
    return image.transform(
        (target_w, target_h), Image.PERSPECTIVE, coeffs, resample=warp_resample, fillcolor=pad_color
    )


def _warp_to_polygon(image, target_w, target_h, polygon_local, resample, pad_color):
    """Mesh-warps the whole source image onto `polygon_local` (triangulated),
    so the panel's full shape is covered edge-to-edge with no cropping —
    the source image's own corners/edges land on the polygon's corners/edges
    instead of being clipped to a bounding rectangle first.

    Destination triangles come from robust ear-clipping (always exactly
    tiles the polygon, including concave ones, with no gaps/overlaps). Each
    triangle's source counterpart normally uses `_boundary_source_uv` for
    its 3 vertices — a plain rectangle panel reduces to an ordinary stretch,
    and any other shape gets genuine per-triangle warping instead of just
    inheriting one global affine map (see `_boundary_source_uv`'s
    docstring). But an interpolated (non-anchor) vertex can occasionally
    land in line with two anchor vertices that share the same source edge —
    e.g. a concave notch's corner interpolating to exactly the source
    rectangle's opposite corner, which an ear-clip diagonal then pairs with
    two vertices already on that corner's edge — collapsing that triangle's
    source correspondence onto a single line (zero area). Falling back to
    plain bounding-box-relative UV for just that one triangle sidesteps it:
    that mapping is a single global affine function of destination
    position, so it can never be degenerate for a non-degenerate
    destination triangle (which ear-clipping guarantees).
    """
    src_w, src_h = image.size
    bbox = (
        min(p[0] for p in polygon_local), min(p[1] for p in polygon_local),
        max(p[0] for p in polygon_local), max(p[1] for p in polygon_local),
    )
    min_x, min_y, max_x, max_y = bbox
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)

    boundary_uv = _boundary_source_uv(polygon_local, bbox)

    def to_source(key):
        u, v = boundary_uv[key]
        return (u * src_w, v * src_h)

    def to_source_bbox_relative(pt):
        return (((pt[0] - min_x) / span_x) * src_w, ((pt[1] - min_y) / span_y) * src_h)

    # PIL's Image.transform only supports NEAREST/BILINEAR/BICUBIC for AFFINE.
    warp_resample = Image.BICUBIC if resample == Image.LANCZOS else resample
    min_src_area = 1e-4 * src_w * src_h

    accum = Image.new("RGB", (target_w, target_h), pad_color)
    for dest_tri in triangulate_polygon(polygon_local):
        keys = [(round(x, 4), round(y, 4)) for x, y in dest_tri]
        src_tri = tuple(to_source(k) for k in keys)
        if abs(_signed_area(src_tri)) < min_src_area:
            src_tri = tuple(to_source_bbox_relative(p) for p in dest_tri)

        coeffs = _affine_dest_to_src(dest_tri, src_tri)
        warped = image.transform((target_w, target_h), Image.AFFINE, coeffs, resample=warp_resample)

        mask = Image.new("L", (target_w, target_h), 0)
        ImageDraw.Draw(mask).polygon(dest_tri, fill=255)
        accum = Image.composite(warped, accum, mask)

    return accum


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
