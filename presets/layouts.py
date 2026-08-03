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

Phase 2 (PHASE2_SPEC.md §7): user-drawn presets saved from the "Draw
Panels" dialog live in a second file, web/layouts_user.json, same schema,
merged in after the built-ins so LAYOUT_CHOICES lists built-ins first. That
file ships absent/empty so a node-pack update (which overwrites
web/layouts.json wholesale) can never delete a user's saved layouts.
"""

import json
import math
import os
import re
import threading
import uuid

from ..utils.geometry import polygon_centroid

_WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "web")
_LAYOUTS_JSON_PATH = os.path.join(_WEB_DIR, "layouts.json")
_USER_LAYOUTS_JSON_PATH = os.path.join(_WEB_DIR, "layouts_user.json")

# Guards the read-modify-write sequence in save_user_layout — the atomic
# os.replace() alone prevents a corrupted file, but not a lost update if two
# saves land close together (PHASE2_SPEC.md §9b).
_save_lock = threading.Lock()

with open(_LAYOUTS_JSON_PATH, encoding="utf-8") as _f:
    _BUILTIN_PRESETS = json.load(_f)


def _load_user_presets():
    if not os.path.exists(_USER_LAYOUTS_JSON_PATH):
        return {}
    try:
        with open(_USER_LAYOUTS_JSON_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as err:
        # save_user_layout() itself writes atomically (§9b — temp file +
        # os.replace), but this file can still end up corrupted by
        # something outside that path entirely (a manual edit gone wrong,
        # a stray editor autosave, disk corruption). The whole point of
        # keeping user presets in a SEPARATE file from the built-in
        # layouts.json is that a problem with one doesn't take down the
        # other — a hard crash here would defeat that: it currently
        # breaks every node in the pack, not just the user presets,
        # since this runs unconditionally at import time. Degrade
        # instead: log it and fall back to "no user presets," the same
        # as a missing file, so built-ins keep working regardless.
        print(f"[ComfyUI-PanelComposer] WARNING: {_USER_LAYOUTS_JSON_PATH} is corrupted ({err}) — "
              f"ignoring it, built-in presets are unaffected. Fix or delete the file to restore your saved presets.")
        return {}


def _validate_presets(raw_presets, source_label):
    """Filters `raw_presets` down to entries with a usable 'category'/
    'label'/'panels' shape, warning and skipping anything else instead of
    letting it through. `_rebuild()` runs unconditionally at import — every
    node in the pack depends on it succeeding — so one malformed entry
    (e.g. from hand-editing, a documented-as-supported workflow, or any
    future write path that doesn't go through save_user_layout's own
    validation) must not be able to take down the whole node pack the way
    a single bad entry already couldn't for whole-file JSON corruption
    (see _load_user_presets)."""
    valid = {}
    for name, data in raw_presets.items():
        if (
            isinstance(data, dict)
            and isinstance(data.get("category"), str)
            and isinstance(data.get("label"), str)
            and isinstance(data.get("panels"), list)
        ):
            valid[name] = data
        else:
            print(
                f"[ComfyUI-PanelComposer] WARNING: skipping malformed preset {name!r} in "
                f"{source_label} (needs string 'category'/'label' and a list "
                f"'panels') — fix or remove this entry to restore it."
            )
    return valid


def _rebuild():
    """Recomputes every module-level derived table from the current
    built-in + on-disk user preset data. Called once at import and again
    after every successful save_user_layout()/delete_user_layout(), so a
    change is immediately reflected in the same server process — no
    restart needed."""
    global _PRESETS, LAYOUT_NAMES, LAYOUT_CHOICES, LAYOUT_CHOICE_TO_NAME, READING_GROUPS
    # `is_builtin` is a runtime-only tag for the in-memory merged view (used
    # by the frontend to decide which presets show a Delete button — never
    # written back to layouts_user.json, since save_user_layout/
    # _dump_presets build their own entry dict from scratch rather than
    # round-tripping through _PRESETS).
    _PRESETS = {
        **{
            name: {**data, "is_builtin": True}
            for name, data in _validate_presets(_BUILTIN_PRESETS, "web/layouts.json").items()
        },
        **{
            name: {**data, "is_builtin": False}
            for name, data in _validate_presets(_load_user_presets(), "web/layouts_user.json").items()
        },
    }
    LAYOUT_NAMES = list(_PRESETS.keys())
    # A flat dropdown of built-in + user preset keys gets unwieldy, and
    # ComfyUI's combo widget has no native grouping — so the dropdown shown
    # to the user is "Category / Label" strings (grouped by construction:
    # same-category entries share a prefix and sit together in list order)
    # instead of raw keys, with LAYOUT_CHOICE_TO_NAME mapping the selected
    # choice back to the real preset key.
    LAYOUT_CHOICES = [f"{data['category']} / {data['label']}" for data in _PRESETS.values()]
    LAYOUT_CHOICE_TO_NAME = {
        f"{data['category']} / {data['label']}": name for name, data in _PRESETS.items()
    }
    # A user-saved preset may have no reading_groups at all (see
    # save_user_layout's docstring) — apply_reading_order already treats a
    # missing/None entry as "use literal panel-array order," so .get()
    # rather than [] is the right lookup here.
    READING_GROUPS = {name: data.get("reading_groups") for name, data in _PRESETS.items()}


_rebuild()


def get_layout(preset_name):
    polygons = _PRESETS[preset_name]["panels"]
    return [
        {"id": i, "order": i, "polygon": [list(point) for point in polygon]}
        for i, polygon in enumerate(polygons)
    ]


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
    panels sorted by the new order.

    `group is None` (no reading_groups at all) falls back to literal
    panel-array order (`p["order"]`, which apply_rotation never touches) —
    this is deliberately how a user-drawn preset saved with a *manual*
    reading-order override is represented (see save_user_layout): there is
    no way to encode an arbitrary literal order through the centroid-sort
    structure below (nested groups always re-sort by geometry, regardless
    of array position — that's the whole point, so built-in presets stay
    correct under rotation), so a manual override instead omits
    reading_groups entirely and bakes the order directly into the saved
    panels array's position. The trade-off: an explicitly manual-ordered
    preset doesn't adapt to canvas_rotation the way an auto-derived one
    does — an accepted cost for honoring the user's explicit choice."""
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


_MAX_READING_GROUP_DEPTH = 50


def _validate_reading_groups(group, num_panels, depth=0):
    """Recursively checks `reading_groups` has the shape _group_centroid/
    _ordered_ids actually expect: arbitrarily-nested lists bottoming out at
    panel-id ints in range. Without this, a saved preset with a bad id
    (e.g. out of range) only fails later, at node-execution time, with a
    raw KeyError out of _group_centroid; a group nested deeper than any
    real layout would ever need can blow Python's recursion limit — both
    are just the disk-write boundary's job to reject up front, same as the
    panels/points checks above."""
    if depth > _MAX_READING_GROUP_DEPTH:
        raise ValueError("reading_groups is nested too deeply")
    if isinstance(group, bool) or not isinstance(group, (int, list)):
        raise ValueError("reading_groups must be made of panel-id ints and lists of them")
    if isinstance(group, int):
        if not (0 <= group < num_panels):
            raise ValueError(
                f"reading_groups references panel id {group}, but only {num_panels} panels were supplied"
            )
        return
    if len(group) == 0:
        raise ValueError("reading_groups must not contain an empty group")
    for sub in group:
        _validate_reading_groups(sub, num_panels, depth + 1)


def _slugify(label):
    slug = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_")
    return slug or "layout"


def _dump_presets(data):
    """Compact one-line-per-array formatting matching web/layouts.json's
    hand-authored style (see TODO.md's "ballooned to ~4,000 lines" note) —
    each polygon and the reading_groups value stays on one line instead of
    plain json.dump's default one-array-element-per-line explosion. Used
    for BOTH web/layouts.json and web/layouts_user.json (same schema),
    keeping either file as browsable/hand-editable as it was before any
    write this module makes to it."""
    keys = list(data.keys())
    lines = ["{"]
    for ki, key in enumerate(keys):
        entry = data[key]
        trailing = "," if ki < len(keys) - 1 else ""
        lines.append(f"  {json.dumps(key)}: {{")
        lines.append(f'    "category": {json.dumps(entry["category"])},')
        lines.append(f'    "label": {json.dumps(entry["label"])},')
        lines.append('    "panels": [')
        panel_lines = [f"      {json.dumps(polygon)}" for polygon in entry["panels"]]
        lines.append(",\n".join(panel_lines))
        has_reading_groups = entry.get("reading_groups") is not None
        lines.append("    ]" + ("," if has_reading_groups else ""))
        if has_reading_groups:
            lines.append(f'    "reading_groups": {json.dumps(entry["reading_groups"])}')
        lines.append("  }" + trailing)
    lines.append("}")
    return "\n".join(lines) + "\n"


def _atomic_write_presets(path, presets_dict):
    """Writes `presets_dict` (compact-formatted via _dump_presets)
    atomically to `path` — temp file in the same directory + os.replace +
    re-parse sanity check, per §9b. Shared by every write this module ever
    makes to either web/layouts.json or web/layouts_user.json (save and
    delete, for both user and — since built-in deletion is genuine now,
    not a separate hide-list — built-in presets alike). Caller is
    responsible for holding _save_lock."""
    text = _dump_presets(presets_dict)
    tmp_path = f"{path}.tmp-{uuid.uuid4().hex}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    with open(path, encoding="utf-8") as f:
        json.load(f)


def save_user_layout(category, label, panels, reading_groups):
    """Persists a new user-drawn preset to web/layouts_user.json — always a
    new entry (PHASE2_SPEC.md §3c: save never overwrites an existing one).
    `panels` is a list of polygons (list of [x, y] points) — the caller
    (the /panelcomposer/save_user_layout route) is responsible for winding
    normalization and validation already having happened client-side;
    this function does its own minimal shape checks as the actual
    disk-write boundary, not a re-run of the full validator.
    `reading_groups` may be None (see apply_reading_order's docstring for
    why a manual reading-order override is represented that way).

    Writes atomically (temp file in the same directory + os.replace, per
    §9b) under a lock guarding the whole read-modify-write sequence, so two
    near-simultaneous saves can't lose one's update to the other. Returns
    (key, choice) — the new preset's generated snake_case key and its
    "Category / Label" dropdown choice string.
    """
    if not isinstance(category, str) or not category.strip():
        raise ValueError("category must be a non-empty string")
    if not isinstance(label, str) or not label.strip():
        raise ValueError("label must be a non-empty string")
    if not isinstance(panels, list) or len(panels) == 0:
        raise ValueError("panels must be a non-empty list")
    for polygon in panels:
        if not isinstance(polygon, list) or len(polygon) < 3:
            raise ValueError("every panel needs at least 3 points")
        for point in polygon:
            if (
                not isinstance(point, list)
                or len(point) != 2
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in point)
            ):
                raise ValueError("every point must be an [x, y] pair of finite numbers")
    if reading_groups is not None:
        _validate_reading_groups(reading_groups, len(panels))

    category = category.strip()
    label = label.strip()
    key_base = _slugify(label)

    with _save_lock:
        existing = _load_user_presets()

        # The picker groups presets by exact-match `category` string (see
        # LAYOUT_CHOICES/the `<optgroup>`-equivalent grouping) — a category
        # typed with different capitalization than an existing one (e.g.
        # "Three Pannels" vs "Three pannels") would otherwise silently
        # create a second, visually-near-identical group instead of joining
        # the existing one, which is what a user typing free text expects.
        # Reuse an existing category's exact casing on a case-insensitive
        # match, checking both built-ins and other user presets, so the
        # FIRST-ever spelling used for a category wins going forward.
        for other in {**_BUILTIN_PRESETS, **existing}.values():
            if other["category"].lower() == category.lower():
                category = other["category"]
                break

        key = key_base
        suffix = 2
        while key in _BUILTIN_PRESETS or key in existing:
            key = f"{key_base}_{suffix}"
            suffix += 1

        entry = {"category": category, "label": label, "panels": panels}
        if reading_groups is not None:
            entry["reading_groups"] = reading_groups
        existing[key] = entry

        _atomic_write_presets(_USER_LAYOUTS_JSON_PATH, existing)
        _rebuild()

    return key, f"{category} / {label}"


def delete_user_layout(key):
    """Genuinely deletes a single preset, by its raw key (not its
    "Category / Label" choice string — the caller resolves that, same as
    anywhere else LAYOUT_CHOICE_TO_NAME is used) — from wherever it
    actually lives:

    - A USER-saved preset (key not in _BUILTIN_PRESETS) is deleted from
      web/layouts_user.json, as before.
    - A BUILT-IN preset is deleted from web/layouts.json itself. Per user
      request this is real deletion, not a reversible hide (an earlier
      version of this function recorded hidden built-ins in a separate
      file instead of touching layouts.json — the user explicitly asked
      for genuine deletion instead: "I want it to be able to geniouly
      delete it. not just hide it."). The trade-off, same one the user
      already accepted when asking for this: a node-pack update ships a
      fresh web/layouts.json and can silently restore (or remove) any
      preset in it, built-in deletions included — nothing this function
      can prevent, since it only controls what's on disk right now.

    Either way, same atomic-write pattern and lock, and same "no undo from
    the UI" one-way nature §3c already documents for saving.
    """
    if not isinstance(key, str) or not key:
        raise ValueError("key must be a non-empty string")

    with _save_lock:
        if key in _BUILTIN_PRESETS:
            del _BUILTIN_PRESETS[key]
            _atomic_write_presets(_LAYOUTS_JSON_PATH, _BUILTIN_PRESETS)
            _rebuild()
            return

        existing = _load_user_presets()
        if key not in existing:
            raise ValueError(f"no preset named {key!r} exists")
        del existing[key]

        _atomic_write_presets(_USER_LAYOUTS_JSON_PATH, existing)
        _rebuild()
