import { app } from "../../scripts/app.js";

// Preset data (panel polygons + reading-order groupings) is fetched from a
// backend route rather than layouts.json directly (Phase 2, PHASE2_SPEC.md
// §10) — presets/layouts.py merges the built-in web/layouts.json with any
// user-saved presets from web/layouts_user.json into one dict, and this
// route (/panelcomposer/all_layouts) is that same merged dict, keeping "how the
// two files combine" in exactly one place (Python) rather than duplicating
// the merge here. Fetched once and cached; every node instance's redraw
// awaits the same promise. invalidatePresetsCache() clears the cache after
// a new preset is saved through the drawing dialog, so the next
// loadPresets() call picks it up instead of serving stale data forever.
const LAYOUTS_URL = "/panelcomposer/all_layouts";
let presetsPromise = null;

export function loadPresets() {
    if (!presetsPromise) {
        presetsPromise = fetch(LAYOUTS_URL)
            .then((r) => r.json())
            .catch((err) => {
                console.error("PanelComposer.PanelLayoutPreview: failed to load layouts", err);
                return {};
            });
    }
    return presetsPromise;
}

export function invalidatePresetsCache() {
    presetsPromise = null;
}

export function panelsFromPreset(presets, presetName) {
    const polygons = presets[presetName]?.panels ?? presets.single_full_page?.panels ?? [];
    return polygons.map((polygon, order) => ({ order, polygon }));
}

// layout_preset's own dropdown shows "Category / Label" (grouped by
// construction — same-category entries share a prefix and sit together in
// list order), not raw preset keys — Python builds that same string from
// each preset's category+label (see presets/layouts.py's LAYOUT_CHOICES)
// and resolves it back via LAYOUT_CHOICE_TO_NAME. This does the same
// resolution here, from the same category/label fields in layouts.json, so
// the preview draws the right preset regardless of which display string is
// currently selected.
export function presetKeyFromChoice(presets, choiceValue) {
    for (const [name, data] of Object.entries(presets)) {
        if (`${data.category} / ${data.label}` === choiceValue) return name;
    }
    return choiceValue; // already a raw key (e.g. the panelsFromPreset fallback)
}

// LiteGraph's native combo widget won't cascade on "Category / Label" text,
// and overriding its click via a `.mouse` hook (tried first) turned out not
// to fire at all in practice — apparently this ComfyUI's bundled LiteGraph
// doesn't dispatch through that hook for combo-type widgets the way some
// other versions do, and there's no way to confirm the internals from here.
// Rather than keep guessing at undocumented click-dispatch behavior, this
// sidesteps LiteGraph's widget system entirely for the actual picking UI: a
// real HTML <select> with <optgroup> — genuinely nested, in every browser,
// by the HTML spec, not by hoping some internal hook fires. It lives in the
// DOM preview box (already a real DOM element we fully control) and just
// writes its choice into layout_preset's `.value` + fires its `.callback`,
// the same two calls any picker needs to make regardless of how it opens.
// Filters a presets object down to entries whose category or label
// contains `query` (case-insensitive substring) — shared by the node's own
// picker (below) and the freeform-drawing dialog's Load Preset control, so
// "how presets get searched" has exactly one implementation. An empty/
// whitespace-only query returns `presets` unchanged (no filtering).
export function filterPresetsByQuery(presets, query) {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    const out = {};
    for (const [key, data] of Object.entries(presets)) {
        if (data.category.toLowerCase().includes(q) || data.label.toLowerCase().includes(q)) out[key] = data;
    }
    return out;
}

// Each entry is { key, label } — the raw preset key travels alongside the
// label so callers (createPresetCombobox's delete button) can look up
// per-preset metadata like is_builtin without a second pass over `presets`.
function groupByCategory(presets) {
    const byCategory = new Map();
    for (const [key, data] of Object.entries(presets)) {
        if (!byCategory.has(data.category)) byCategory.set(data.category, []);
        byCategory.get(data.category).push({ key, label: data.label });
    }
    return byCategory;
}

// Every "Category / Label" choice string, in the same grouped order
// createPresetCombobox's dropdown panel renders them — the single source
// of order for anything that needs to walk the full preset list
// sequentially (the node picker's prev/next step buttons).
export function flatPresetChoices(presets) {
    const out = [];
    for (const [category, entries] of groupByCategory(presets)) {
        for (const { label } of entries) out.push(`${category} / ${label}`);
    }
    return out;
}

// Searchable combobox — one control that IS both the search box and the
// dropdown trigger. Replaces an earlier design (a separate search <input>
// sitting above a plain <select>) that live-testing showed was a bad
// two-step flow: type in the search box, then still have to separately
// open the dropdown. A single text input shows the current selection when
// idle; focusing or typing opens a floating grouped list (filtered live
// via filterPresetsByQuery); clicking a row, or pressing Enter on the
// highlighted one, commits the selection and closes the list; Escape or
// clicking/tabbing away closes it and reverts the input's text to the
// current selection, discarding any uncommitted search text. Shared by
// the node's own picker and the drawing dialog's Load Preset control —
// exactly one implementation of this UI pattern, not two.
// The floating dropdown panel used to be a `position: absolute` child of
// `wrap`. That works fine as long as every ancestor between `wrap` and the
// viewport allows overflow — but this combobox lives inside containers
// that deliberately don't (the node's own preview box has `overflow:
// hidden` for its rounded corners; the drawing dialog's side panel has
// `overflow-y: auto` for its own scrolling), so the panel was getting
// visually clipped, sometimes almost entirely — a real bug a user hit
// ("the dropdown menu looks like stuck inside the node ... had to increase
// the node size to see it"). Fixed by portaling the panel: it's appended
// to `document.body` directly instead of `wrap`, positioned with
// `position: fixed` computed from the input's own `getBoundingClientRect()`
// each time it opens, so it always renders on top of everything regardless
// of what clips its logical parent. Needs a z-index above the drawing
// dialog's own full-viewport overlay (OVERLAY_Z_INDEX in
// panel_drawing_dialog.js, 100000) since this same combobox is also used
// for that dialog's Load Preset control.
const COMBOBOX_PANEL_Z_INDEX = 1000000;

export function createPresetCombobox({ initialValue, onSelect, onDelete }) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position: relative;";

    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.cssText = `
        width: 100%;
        box-sizing: border-box;
        background: #1b1b26;
        color: #e6e6e6;
        border: 1px solid ${COLOR_BORDER};
        border-radius: 3px;
        padding: 3px 4px;
        font-size: 11px;
        font-family: inherit;
        cursor: text;
    `;

    const panel = document.createElement("div");
    panel.style.cssText = `
        position: fixed;
        max-height: 260px;
        overflow-y: auto;
        background: #1b1b26;
        border: 1px solid ${COLOR_BORDER};
        border-radius: 3px;
        z-index: ${COMBOBOX_PANEL_Z_INDEX};
        display: none;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    `;

    wrap.appendChild(input);
    document.body.appendChild(panel);

    function repositionPanel() {
        const rect = input.getBoundingClientRect();
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.bottom + 2}px`;
        panel.style.width = `${rect.width}px`;
    }
    // Keeps the panel glued under the input across a window resize (e.g.
    // the browser window itself, not LiteGraph's own zoom/pan — the input
    // moving under LiteGraph zoom/pan while the panel is open is a known,
    // narrower gap than the clipping bug this fixes, and closes itself
    // the moment the input blurs).
    window.addEventListener("resize", () => {
        if (panel.style.display !== "none") repositionPanel();
    });

    let presets = {};
    let currentValue = initialValue || "";
    let highlightedIndex = -1;
    let rows = []; // [{ value, el }]
    input.value = currentValue;

    function renderPanel(query) {
        panel.innerHTML = "";
        rows = [];
        const byCategory = groupByCategory(filterPresetsByQuery(presets, query));
        if (byCategory.size === 0) {
            const empty = document.createElement("div");
            empty.textContent = "No matching presets";
            empty.style.cssText = "padding: 6px 8px; font-size: 11px; color: #6a6880;";
            panel.appendChild(empty);
            highlightedIndex = -1;
            return;
        }
        for (const [category, entries] of byCategory) {
            const header = document.createElement("div");
            header.textContent = category;
            header.style.cssText = `
                padding: 4px 8px 2px;
                font-size: 10px;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                color: #6a6880;
            `;
            panel.appendChild(header);
            for (const { key, label } of entries) {
                const value = `${category} / ${label}`;
                const row = document.createElement("div");
                row.dataset.value = value;
                row.style.cssText = `
                    padding: 4px 8px;
                    font-size: 11px;
                    cursor: pointer;
                    color: #e6e6e6;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                `;
                const labelSpan = document.createElement("span");
                labelSpan.textContent = label;
                labelSpan.style.cssText = "flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;";
                row.appendChild(labelSpan);

                const idx = rows.length;
                row.addEventListener("mouseenter", () => setHighlight(idx));
                // mousedown (not click) + preventDefault, so the browser
                // never shifts focus away from the input in the first
                // place — no race against the input's own blur handler.
                row.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    commitSelection(value);
                });

                // Delete button — shown whenever the caller actually wired
                // onDelete (the dialog's Load Preset control and the
                // node's own picker both do; a combobox used read-only
                // somewhere else just wouldn't pass it). Per user request,
                // this covers BUILT-IN presets too, not just user-saved
                // ones, and genuinely deletes either (not a reversible
                // hide — an earlier version recorded hidden built-ins in a
                // separate file instead of touching layouts.json, but the
                // user explicitly asked for real deletion instead). Wording
                // still differs by `is_builtin` (a runtime-only tag
                // presets/layouts.py's _rebuild() adds to the merged view)
                // only to flag that a built-in could come back on a
                // node-pack update — both are equally "delete", both
                // equally permanent right now.
                if (onDelete) {
                    const isBuiltin = presets[key]?.is_builtin === true;
                    const deleteBtn = document.createElement("button");
                    deleteBtn.type = "button";
                    deleteBtn.textContent = "×";
                    deleteBtn.title = `Delete "${value}"`;
                    deleteBtn.style.cssText = `
                        flex: 0 0 auto;
                        background: transparent;
                        color: #9a9ab0;
                        border: none;
                        font-size: 13px;
                        line-height: 1;
                        cursor: pointer;
                        padding: 2px 4px;
                    `;
                    deleteBtn.addEventListener("mouseenter", () => (deleteBtn.style.color = "#d94848")); // matches panel_drawing_dialog.js's COLOR_INVALID
                    deleteBtn.addEventListener("mouseleave", () => (deleteBtn.style.color = "#9a9ab0"));
                    // mousedown, same reasoning as row selection above, plus
                    // stopPropagation so it doesn't also trigger the row's
                    // own mousedown-select handler right above it.
                    deleteBtn.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const confirmMsg = isBuiltin
                            ? `Delete the built-in preset "${value}"? This removes it from web/layouts.json — a future node-pack update could restore (or also remove) it, but right now this can't be undone from here.`
                            : `Delete the preset "${value}"? This can't be undone.`;
                        if (!window.confirm(confirmMsg)) return;
                        onDelete(key, value);
                    });
                    row.appendChild(deleteBtn);
                }

                panel.appendChild(row);
                rows.push({ value, el: row });
            }
        }
        setHighlight(rows.length > 0 ? 0 : -1);
    }

    function setHighlight(i) {
        if (highlightedIndex >= 0 && rows[highlightedIndex]) rows[highlightedIndex].el.style.background = "";
        highlightedIndex = i;
        if (highlightedIndex >= 0 && rows[highlightedIndex]) {
            rows[highlightedIndex].el.style.background = COLOR_ACCENT;
            rows[highlightedIndex].el.scrollIntoView?.({ block: "nearest" });
        }
    }

    function openPanel() {
        repositionPanel(); // compute fresh each open — the input may have moved since last time
        panel.style.display = "block";
        renderPanel(""); // always the full list on open, not filtered by the idle label text
        input.select?.();
    }
    function closePanel() {
        panel.style.display = "none";
        input.value = currentValue;
    }
    function commitSelection(value) {
        currentValue = value;
        input.value = value;
        closePanel();
        onSelect(value);
    }

    input.addEventListener("focus", openPanel);
    input.addEventListener("input", () => renderPanel(input.value));
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (panel.style.display === "none") openPanel();
            else setHighlight(Math.min(highlightedIndex + 1, rows.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight(Math.max(highlightedIndex - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (highlightedIndex >= 0 && rows[highlightedIndex]) commitSelection(rows[highlightedIndex].value);
        } else if (e.key === "Escape") {
            closePanel();
        }
    });
    input.addEventListener("blur", closePanel);

    return {
        el: wrap,
        setPresets(newPresets) {
            presets = newPresets;
        },
        setValue(value) {
            currentValue = value;
            input.value = value;
        },
        getValue() {
            return currentValue;
        },
        // The panel is now a document.body-level element (see the portal
        // comment above), not a descendant of `wrap` — it no longer gets
        // garbage-collected for free when whatever contains `wrap` (a node,
        // a drawing dialog) is torn down. Callers that have a teardown
        // hook (node.onRemoved, the dialog's close()) should call this so
        // the panel doesn't linger in the DOM indefinitely.
        destroy() {
            panel.remove();
        },
    };
}

export function groupCentroid(group, centroids) {
    if (typeof group === "number") return centroids[group];
    const points = group.map((g) => groupCentroid(g, centroids));
    return [
        points.reduce((s, p) => s + p[0], 0) / points.length,
        points.reduce((s, p) => s + p[1], 0) / points.length,
    ];
}

// Sorts at each nesting level by whichever axis (X or Y) has more spread —
// Y (rows) is never reversed by reading order, X (left-right within a row)
// reverses for right_to_left. Mirrors presets/layouts.py's _ordered_ids.
export function orderedIds(group, centroids, readingOrder) {
    if (typeof group === "number") return [group];

    const subCentroids = group.map((g) => groupCentroid(g, centroids));
    const xs = subCentroids.map((c) => c[0]);
    const ys = subCentroids.map((c) => c[1]);
    const ySpread = ys.length > 1 ? Math.max(...ys) - Math.min(...ys) : 0;
    const xSpread = xs.length > 1 ? Math.max(...xs) - Math.min(...xs) : 0;

    const indices = group.map((_, i) => i);
    if (ySpread >= xSpread) {
        indices.sort((a, b) => subCentroids[a][1] - subCentroids[b][1]);
    } else {
        indices.sort((a, b) =>
            readingOrder === "right_to_left"
                ? subCentroids[b][0] - subCentroids[a][0]
                : subCentroids[a][0] - subCentroids[b][0]
        );
    }

    const ordered = [];
    for (const i of indices) ordered.push(...orderedIds(group[i], centroids, readingOrder));
    return ordered;
}

// Derives a nested reading_groups structure from geometry alone — for
// presets that have no hand-authored structure (drawn/saved layouts;
// built-in presets always author their own instead and never call this).
//
// orderedIds/_ordered_ids (Python) makes exactly one X-vs-Y decision PER
// GROUP LEVEL, comparing the spread of that level's own sub-centroids. Fed
// a flat list of N singleton panels (the previous approach here), there is
// only ONE level — the comparison runs ONCE across every panel in the
// preset at once. That collapses "one full-width row + a split row below"
// (a common manga layout, and exactly what built-in presets like
// three_top_split need an AUTHORED `[[0, 1], [2]]` grouping to get right)
// into a single global sort: whichever axis has more spread across ALL
// panels wins, full stop — so if Y wins (as it should, for a stacked
// layout), reading_order (left_to_right/right_to_left) is never even
// consulted, since only the X branch reads it. Two panels in the same
// row that happen to differ in Y by a floating-point sliver (e.g. two
// trapezoids splitting a row on a diagonal — their area-weighted
// centroids aren't required to land on the exact same Y even though both
// span the same Y range) then get ordered by that meaningless sliver
// instead of by their actual left/right position.
//
// The fix isn't to change orderedIds — nested groups already do the right
// thing (a top-level 2-entry group of "row 0" vs "row 1" sorts by Y since
// that's the top-level spread; recursing into row 1's own 2-panel group,
// X spread now clearly dominates the same Y sliver, since the two panels'
// X positions differ far more than that sliver, so it correctly sorts by
// X and respects reading_order). What's missing for drawn presets is
// deriving that row structure in the first place — this function does
// that, then the result is fed into the existing, unchanged orderedIds.
//
// Rows are found by a single greedy sweep, sorted by each panel's bounding
// box top edge (min Y): a panel joins the current row if its Y-range
// overlaps the row's accumulated Y-range by MORE than a small tolerance,
// else it starts a new row. Good enough for manga panel layouts (same
// "good enough at this vertex/panel count" pragmatism as the
// self-intersection sweep elsewhere in this project) — a panel spanning
// two visually-distinct rows could over-merge them, but that's exactly
// the kind of unusual layout the manual reading-order override already
// exists to correct.
//
// The tolerance itself is deliberately NOT near-zero — confirmed as a real
// bug against actual hand-drawn user data: two panels meant to share a row
// had their top edge land at y=0.499 instead of an exact 0.5 (ordinary
// mouse/snap imprecision while freehand-drawing), giving a ~0.0009 sliver
// of genuine Y-overlap with the row above — enough to wrongly merge all
// three panels into one row under a near-zero threshold, silently
// re-breaking the exact bug this function exists to fix. A drawn preset's
// coordinates are normalized [0,1] regardless of the canvas's actual pixel
// size, so there's no single "N pixels" value to use directly, but this
// dialog's canvas is typically several hundred CSS px — 0.004 corresponds
// to roughly 2-3px at those sizes, comfortably covering ordinary drawing
// imprecision (a user-suggested fix, "treat a 1-2px difference as
// touching, not overlapping") while staying far below any genuine
// same-row overlap, which in practice spans a meaningful fraction of a
// row's own height, not a fraction of a percent of it.
const ROW_OVERLAP_TOLERANCE_NORM = 0.004;

function polygonYRange(points) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    return [minY, maxY];
}

export function deriveRowGroups(indices, polygonByIndex) {
    if (indices.length === 0) return [];
    const yRangeByIndex = new Map(indices.map((i) => [i, polygonYRange(polygonByIndex(i))]));
    const sorted = [...indices].sort((a, b) => yRangeByIndex.get(a)[0] - yRangeByIndex.get(b)[0]);

    const rows = [[sorted[0]]];
    let [rowMinY, rowMaxY] = yRangeByIndex.get(sorted[0]);
    for (let k = 1; k < sorted.length; k++) {
        const i = sorted[k];
        const [minY, maxY] = yRangeByIndex.get(i);
        const overlap = Math.min(rowMaxY, maxY) - Math.max(rowMinY, minY);
        if (overlap > ROW_OVERLAP_TOLERANCE_NORM) {
            rows[rows.length - 1].push(i);
            rowMinY = Math.min(rowMinY, minY);
            rowMaxY = Math.max(rowMaxY, maxY);
        } else {
            rows.push([i]);
            rowMinY = minY;
            rowMaxY = maxY;
        }
    }
    // Bare id for a solo row, matching the existing reading_groups
    // convention (see ADDING_PRESETS.md's "bare integer = no peers here").
    return rows.map((row) => (row.length === 1 ? row[0] : row));
}

function applyReadingOrder(panels, readingOrder, group) {
    if (!group) return [...panels].sort((a, b) => a.order - b.order);

    const centroids = {};
    for (const p of panels) centroids[p.order] = polygonCentroid(p.polygon);
    const ids = orderedIds(group, centroids, readingOrder);
    const orderById = {};
    ids.forEach((id, order) => (orderById[id] = order));

    panels = panels.map((p) => ({ ...p, order: orderById[p.order] }));
    return [...panels].sort((a, b) => a.order - b.order);
}

// Rotation only rotates the panel polygons — it does not touch the page's
// own shape (aspect_ratio/page_orientation alone decide the canvas).
const ROTATION_TRANSFORMS = {
    "0": ([x, y]) => [x, y],
    "90": ([x, y]) => [1 - y, x],
    "180": ([x, y]) => [1 - x, 1 - y],
    "270": ([x, y]) => [y, 1 - x],
};

function applyRotation(panels, rotation) {
    if (rotation === "0") return panels;
    const transform = ROTATION_TRANSFORMS[rotation];
    return panels.map((p) => ({ ...p, polygon: p.polygon.map(transform) }));
}

// ── PREVIEW BOX ──────────────────────────────────────────────────────────────
const PREVIEW_HEIGHT     = 260;   // default height of the preview box (px)
const PREVIEW_MIN_HEIGHT = 120;   // smallest the drag handle allows (px)
const PREVIEW_MAX_HEIGHT = 900;   // largest the drag handle allows (px)

// ── COLOURS ──────────────────────────────────────────────────────────────────
const COLOR_BOX_BG = "#13131a";
const COLOR_BORDER = "#2e2e3c";
const COLOR_ACCENT = "#4a90d9";
const COLOR_PAGE_BG = "#f5f5f5";
const COLOR_INK = "#141414";

// Mirrors utils/geometry.py's ASPECT_RATIO_CHOICES — keep in sync by hand.
// Exported so panel_drawing_dialog.js can size its canvas the same way,
// instead of hand-mirroring this table a second time.
export const ASPECT_RATIO_CHOICES = {
    "1:1 (Square)": 1.0,
    "9:7": 9 / 7,
    "4:3 (Standard)": 4 / 3,
    "A4": Math.SQRT2,
    "19:13": 19 / 13,
    "3:2 (Classic Photo)": 3 / 2,
    "7:4": 7 / 4,
    "16:9 (Widescreen)": 16 / 9,
    "21:9 (Ultrawide)": 21 / 9,
    "12:5 (Cinemascope)": 12 / 5,
};

export function parseAspectRatio(ratioChoice) {
    return ASPECT_RATIO_CHOICES[ratioChoice] ?? 1.0;
}

// Mirrors utils/geometry.py's resolve_oriented_aspect_ratio: aspect_ratio
// picks the ratio's magnitude, page_orientation decides which way it points.
export function resolveOrientedAspectRatio(ratioMagnitude, orientation) {
    const magnitude = Math.max(ratioMagnitude, 1 / ratioMagnitude);
    return orientation === "landscape" ? magnitude : 1 / magnitude;
}

// Area-weighted centroid, robust for concave polygons (e.g. the L-shape).
// Exported so panel_drawing_dialog.js can reuse it for reading-order
// derivation (§6) instead of a second copy.
export function polygonCentroid(points) {
    let area = 0, cx = 0, cy = 0;
    const n = points.length;
    for (let i = 0; i < n; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % n];
        const cross = x0 * y1 - x1 * y0;
        area += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    area *= 0.5;
    if (Math.abs(area) < 1e-9) {
        return [
            points.reduce((s, p) => s + p[0], 0) / n,
            points.reduce((s, p) => s + p[1], 0) / n,
        ];
    }
    return [cx / (6 * area), cy / (6 * area)];
}

function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
        case 0: [r, g, b] = [v, t, p]; break;
        case 1: [r, g, b] = [q, v, p]; break;
        case 2: [r, g, b] = [p, v, t]; break;
        case 3: [r, g, b] = [p, q, v]; break;
        case 4: [r, g, b] = [t, p, v]; break;
        default: [r, g, b] = [v, p, q]; break;
    }
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

// Exported so panel_drawing_dialog.js can color drawn-but-unsaved panels the
// same way the preview colors finished ones, instead of a third copy.
export function palette(n) {
    const colors = [];
    const count = Math.max(n, 1);
    for (let i = 0; i < count; i++) {
        colors.push(hsvToRgb(i / count, 0.35, 0.95));
    }
    return colors;
}

// "Contain"-fits the page (at pageAspectRatio) inside a boxW x boxH area,
// centered — same idea as CSS object-fit: contain, but computed by hand
// since we draw the page ourselves on canvas rather than scaling an <img>.
function fitPageRect(boxW, boxH, pageAspectRatio) {
    const boxAr = boxW / boxH;
    let w, h;
    if (pageAspectRatio > boxAr) {
        w = boxW;
        h = boxW / pageAspectRatio;
    } else {
        h = boxH;
        w = boxH * pageAspectRatio;
    }
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

function drawLayoutPreview(canvas, panels, pageAspectRatio) {
    const boxW = canvas.clientWidth;
    const boxH = canvas.clientHeight;
    if (!boxW || !boxH) return;

    // Render at device pixel resolution so the preview stays crisp at any
    // node zoom level, while all drawing below still happens in CSS px.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(boxW * dpr));
    canvas.height = Math.max(1, Math.round(boxH * dpr));

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);

    const page = fitPageRect(boxW, boxH, pageAspectRatio);

    ctx.fillStyle = COLOR_PAGE_BG;
    ctx.fillRect(page.x, page.y, page.w, page.h);

    const colors = palette(panels.length);
    const shortSide = Math.min(page.w, page.h);
    const outlineW = Math.max(1, Math.round(shortSide * 0.006));
    const labelSize = Math.max(10, Math.round(shortSide * 0.07));

    for (const [idx, panel] of panels.entries()) {
        const points = panel.polygon.map(([x, y]) => [page.x + x * page.w, page.y + y * page.h]);

        ctx.beginPath();
        points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = colors[idx];
        ctx.fill();
        ctx.strokeStyle = COLOR_INK;
        ctx.lineWidth = outlineW;
        ctx.stroke();

        const [cx, cy] = polygonCentroid(points);
        ctx.fillStyle = COLOR_INK;
        ctx.font = `${labelSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(panel.order), cx, cy);
    }

    ctx.strokeStyle = COLOR_INK;
    ctx.lineWidth = outlineW;
    ctx.strokeRect(page.x + outlineW / 2, page.y + outlineW / 2, page.w - outlineW, page.h - outlineW);
}

app.registerExtension({
    name: "PanelComposer.PanelLayoutPreview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PanelLayoutProvider") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            node.properties = node.properties || {};

            // ── PREVIEW BOX (resizable via the bottom drag handle) ────────────
            const previewBox = document.createElement("div");
            const initialHeight = Math.max(
                PREVIEW_MIN_HEIGHT,
                Math.min(PREVIEW_MAX_HEIGHT, node.properties["previewHeight"] || PREVIEW_HEIGHT)
            );
            previewBox.style.cssText = `
                background: ${COLOR_BOX_BG};
                border: 1px solid ${COLOR_BORDER};
                border-radius: 5px;
                height: ${initialHeight}px;
                overflow: hidden;
                position: relative;
                box-sizing: border-box;
                width: 100%;
                display: flex;
                flex-direction: column;
            `;

            // ── LAYOUT PICKER (searchable combobox — see createPresetCombobox
            // above for why this isn't a plain <select>: the search box IS the
            // dropdown trigger, not a separate control above it) ─────────────
            const pickerBar = document.createElement("div");
            pickerBar.style.cssText = `
                flex: 0 0 auto;
                padding: 4px;
                border-bottom: 1px solid ${COLOR_BORDER};
                box-sizing: border-box;
                display: flex;
                gap: 4px;
                align-items: stretch;
                position: relative;
            `;

            function makeStepButton(label, title) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = label;
                btn.title = title;
                btn.style.cssText = `
                    flex: 0 0 auto;
                    width: 20px;
                    background: #1b1b26;
                    color: #9a9ab0;
                    border: 1px solid ${COLOR_BORDER};
                    border-radius: 3px;
                    font-size: 11px;
                    line-height: 1;
                    cursor: pointer;
                    padding: 0;
                `;
                btn.addEventListener("mouseenter", () => (btn.style.color = COLOR_ACCENT));
                btn.addEventListener("mouseleave", () => (btn.style.color = "#9a9ab0"));
                return btn;
            }
            const prevButton = makeStepButton("◀", "Previous layout");
            const nextButton = makeStepButton("▶", "Next layout");

            // Looks up the widget fresh each time rather than capturing it in
            // a closure, since this is defined before loadPresets() resolves
            // below (the combobox needs its onSelect callback wired up
            // immediately, even though presets/the widget aren't ready yet).
            function commitPresetSelection(value) {
                presetCombobox.setValue(value);
                const w = node.widgets.find((ww) => ww.name === "layout_preset");
                if (!w) return;
                w.value = value;
                w.callback?.(value, app.canvas, node, null, null);
                redraw();
            }
            // Deletes a user-saved preset (never a built-in — see
            // createPresetCombobox's own guard, which only shows the
            // delete button for presets tagged is_builtin: false).
            // Confirmed by the browser's native confirm() one level up, in
            // createPresetCombobox itself, before this ever runs.
            async function deletePreset(key, value) {
                try {
                    const res = await fetch("/panelcomposer/delete_user_layout", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ key }),
                    });
                    const data = await res.json();
                    if (!res.ok || !data.success) throw new Error(data.error || `server returned ${res.status}`);
                } catch (err) {
                    window.alert?.(`Failed to delete preset: ${err.message}`);
                    return;
                }
                invalidatePresetsCache();
                presets = await loadPresets();
                presetCombobox.setPresets(presets);
                const presetWidget = node.widgets.find((w) => w.name === "layout_preset");
                if (presetWidget?.value === value) {
                    // The currently-selected preset was just deleted out from
                    // under the node — fall back to the first available
                    // choice rather than leaving layout_preset pointing at
                    // something that no longer exists (same staleness class
                    // of bug fixed earlier for saves, just from the other
                    // direction).
                    const fallback = flatPresetChoices(presets)[0];
                    if (fallback) commitPresetSelection(fallback);
                }
            }
            const presetCombobox = createPresetCombobox({
                initialValue: "",
                onSelect: commitPresetSelection,
                onDelete: deletePreset,
            });
            presetCombobox.el.style.cssText += "flex: 1 1 auto; min-width: 0;";

            pickerBar.appendChild(prevButton);
            pickerBar.appendChild(presetCombobox.el);
            pickerBar.appendChild(nextButton);
            previewBox.appendChild(pickerBar);

            const canvasWrap = document.createElement("div");
            canvasWrap.style.cssText = "flex:1 1 auto; min-height:0; position:relative;";
            const canvas = document.createElement("canvas");
            canvas.style.cssText = "display:block;width:100%;height:100%;";
            canvasWrap.appendChild(canvas);
            previewBox.appendChild(canvasWrap);

            const resizeHandle = document.createElement("div");
            resizeHandle.title = "Drag to resize preview";
            resizeHandle.innerHTML = `<span style="font-size:9px;color:#6a6880;letter-spacing:2px;line-height:1;">⠿</span>`;
            resizeHandle.style.cssText = `
                position:absolute;bottom:0;left:50%;transform:translateX(-50%);
                width:48px;height:14px;display:flex;align-items:center;justify-content:center;
                cursor:ns-resize;z-index:2;border-top-left-radius:4px;border-top-right-radius:4px;
                background:rgba(0,0,0,0.35);
            `;
            resizeHandle.addEventListener("mouseenter", () => (resizeHandle.firstElementChild.style.color = COLOR_ACCENT));
            resizeHandle.addEventListener("mouseleave", () => (resizeHandle.firstElementChild.style.color = "#6a6880"));
            previewBox.appendChild(resizeHandle);

            const widget = node.addDOMWidget("layout_preview", "preview", previewBox, { serialize: false });
            widget.serialize = false;
            widget.options.serialize = false;
            // Keep the DOM overlay pinned to the node's width — a DOM widget's
            // own `width` can otherwise drift from the node's actual width and
            // the box renders stale/overflowing (a documented ComfyUI gotcha).
            widget.computeSize = function (width) {
                widget.width = node.size[0];
                return [width, previewBox.offsetHeight + 8];
            };

            let presets = null; // set once loadPresets() resolves, below

            const redraw = () => {
                if (!presets) return; // not loaded yet — loadPresets().then(redraw) below covers first paint

                const presetWidget = node.widgets.find((w) => w.name === "layout_preset");
                const arWidget = node.widgets.find((w) => w.name === "aspect_ratio");
                const orientationWidget = node.widgets.find((w) => w.name === "page_orientation");
                const rotationWidget = node.widgets.find((w) => w.name === "canvas_rotation");
                const readingOrderWidget = node.widgets.find((w) => w.name === "reading_order");

                const presetName = presetKeyFromChoice(presets, presetWidget?.value ?? "single_full_page");
                const rotation = rotationWidget?.value ?? "0";
                let panels = panelsFromPreset(presets, presetName);
                panels = applyRotation(panels, rotation);
                const group = presets[presetName]?.reading_groups;
                panels = applyReadingOrder(panels, readingOrderWidget?.value ?? "left_to_right", group);

                const orientation = orientationWidget?.value ?? "portrait";
                const rawAr = parseAspectRatio(arWidget?.value ?? "1:1 (Square)");
                const ar = resolveOrientedAspectRatio(rawAr, orientation);
                drawLayoutPreview(canvas, panels, ar);
                node.setDirtyCanvas(true, true);
            };

            resizeHandle.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation(); // don't let LiteGraph start dragging the node
                resizeHandle.setPointerCapture?.(e.pointerId);
                const scale = app.canvas?.ds?.scale || 1; // overlay is CSS-scaled by zoom
                const startY = e.clientY;
                const startBoxH = previewBox.offsetHeight;
                const startNodeH = node.size[1];

                const onMove = (ev) => {
                    const delta = (ev.clientY - startY) / scale;
                    const boxH = Math.max(PREVIEW_MIN_HEIGHT, Math.min(PREVIEW_MAX_HEIGHT, startBoxH + delta));
                    previewBox.style.height = boxH + "px";
                    node.setSize([node.size[0], startNodeH + (boxH - startBoxH)]);
                    redraw();
                };
                const onUp = (ev) => {
                    resizeHandle.releasePointerCapture?.(ev.pointerId);
                    resizeHandle.removeEventListener("pointermove", onMove);
                    resizeHandle.removeEventListener("pointerup", onUp);
                    node.properties["previewHeight"] = previewBox.offsetHeight;
                    node.setDirtyCanvas(true, true);
                };
                resizeHandle.addEventListener("pointermove", onMove);
                resizeHandle.addEventListener("pointerup", onUp);
            });

            for (const name of ["layout_preset", "aspect_ratio", "page_orientation", "canvas_rotation", "reading_order"]) {
                const targetWidget = node.widgets.find((w) => w.name === name);
                if (!targetWidget) continue;
                const origCallback = targetWidget.callback;
                targetWidget.callback = function (...args) {
                    const r = origCallback?.apply(this, args);
                    redraw();
                    return r;
                };
            }

            // Redraw on node-width changes too (dragging the node's corner),
            // since the canvas's pixel buffer is sized from the box's CSS width.
            const origOnResize = node.onResize;
            node.onResize = function (size) {
                origOnResize?.call(this, size);
                redraw();
            };

            // presetCombobox's dropdown panel is portaled to document.body
            // (see createPresetCombobox's own comment) — clean it up when
            // this node goes away, or it lingers in the DOM forever.
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                presetCombobox.destroy();
                return origOnRemoved?.apply(this, arguments);
            };

            // Phase 2 hook (PHASE2_SPEC.md §10): the drawing dialog calls
            // this after a successful save to web/layouts_user.json, so the
            // node immediately reflects the newly-created preset as
            // selected without the user having to find it in the dropdown
            // themselves. Refetches the merged preset list (invalidating
            // the cache first, since loadPresets() caches its promise —
            // otherwise this node's own picker would keep serving the
            // pre-save snapshot forever) before selecting, via the same
            // commitPresetSelection path any other picker selection uses.
            node.panelComposerApplySavedLayout = function (choiceValue) {
                invalidatePresetsCache();
                loadPresets().then((loaded) => {
                    presets = loaded;
                    presetCombobox.setPresets(presets);
                    commitPresetSelection(choiceValue);
                });
            };

            loadPresets().then((loaded) => {
                presets = loaded;

                const presetWidget = node.widgets.find((w) => w.name === "layout_preset");
                if (presetWidget) {
                    presetCombobox.setPresets(presets);
                    presetCombobox.setValue(presetWidget.value);

                    // Step through the full ordered preset list (same order
                    // the combobox's own dropdown panel groups by), wrapping
                    // at both ends — independent of whatever the combobox's
                    // search box currently shows, since a search filter only
                    // affects the open dropdown, not this button-driven walk.
                    const step = (delta) => {
                        const choices = flatPresetChoices(presets);
                        if (choices.length === 0) return;
                        const currentIdx = choices.indexOf(presetCombobox.getValue());
                        const nextIdx = ((currentIdx < 0 ? 0 : currentIdx) + delta + choices.length) % choices.length;
                        commitPresetSelection(choices[nextIdx]);
                    };
                    prevButton.addEventListener("click", () => step(-1));
                    nextButton.addEventListener("click", () => step(1));

                    // The combobox above is now the real picker — collapse the
                    // native flat-list widget so there's still exactly one
                    // visible control, not two. Its value keeps working exactly
                    // as before (still the actual serialized backend input);
                    // this only changes how much vertical space it draws as.
                    presetWidget.computeSize = () => [0, -4];
                    try {
                        node.setSize(node.computeSize());
                    } catch (err) {
                        console.warn("PanelComposer.PanelLayoutPreview: couldn't resize node after hiding layout_preset", err);
                    }
                }

                requestAnimationFrame(redraw);
            });

            return result;
        };
    },
});
