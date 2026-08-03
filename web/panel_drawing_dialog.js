import { app } from "../../scripts/app.js";
import {
    ASPECT_RATIO_CHOICES,
    parseAspectRatio,
    resolveOrientedAspectRatio,
    palette,
    polygonCentroid,
    orderedIds,
    deriveRowGroups,
    loadPresets,
    invalidatePresetsCache,
    panelsFromPreset,
    presetKeyFromChoice,
    createPresetCombobox,
} from "./panel_layout_preview.js";

// Phase 2 (see PHASE2_SPEC.md §11): the freeform panel-drawing dialog.
// Step 1 done: shell (open/close, sized canvas, toolbar/side-panel laid
// out). Step 2 done: real point placement, panel closing, vertex/whole-panel
// dragging, delete, undo/redo. Step 3 done: snapping — vertex, edge,
// alignment guides, canvas boundary/center, grid, in the priority order
// from §3b, each independently toggleable via the 5 toolbar toggles; plus
// the Shift straight-line/45°-angle helper while placing points. Step 4
// done: winding normalization (§4), pre-save validation (§5), and a
// best-effort auto-repair pass (out-of-bounds clamp + self-intersection
// fix attempt via centroid-angle reordering) that runs before validation
// at shape-close and on Save, so most broken shapes fix themselves instead
// of just getting flagged — anything the repair can't actually fix still
// gets flagged rather than silently accepted. Step 5 done: reading order
// (§6) — auto-derived via the same axis-spread logic every built-in
// preset already uses (reused from panel_layout_preview.js, not
// re-derived), recomputed whenever the panel set changes; shown as a
// numbered badge on each closed panel and a matching "#N" prefix in the
// Panels list, with manual up/down override via buttons on each row, plus
// an "Auto Order" button to explicitly discard a manual reorder and
// recompute fresh on demand (e.g. after dragging panels around, which
// doesn't auto-recompute by itself). Step 6 (this revision): Canvas Shape
// (aspect ratio + orientation selects, reshaping only the drawing surface —
// panel points stay normalized [0,1] and need no recalculating) and Load
// Preset (loads any existing preset's panels as an editable starting
// point; a searchable combobox — see createPresetCombobox in
// panel_layout_preview.js — shared with that file's own node picker,
// after user feedback that an earlier "separate search box above a plain
// dropdown" design was a bad two-step flow). Per user request, whatever
// preset the node's own layout_preset widget has selected loads
// automatically the moment the dialog opens — a toolbar Clear button is
// the explicit way to start from an empty canvas instead. Also added this
// revision, not part of the original 9-step order: an overlap policy
// (`polygonsOverlap`) — deliberate panel overlap is allowed, not blocked,
// since PanelCompositor already renders it deterministically (panels
// paint in reading order, later on top), but overlapping panels get a
// dashed amber warning (canvas + Panels list) distinct from the solid red
// invalid state, since accidental overlap is a real mistake worth
// surfacing even though it isn't technically broken. Step 7 done: the
// save flow (§7/§8) — a category/label prompt shown once §4/§5's
// repair+validation already pass, POSTing to the new
// /panelcomposer/save_user_layout backend route (nodes/routes.py, backed by
// presets/layouts.py's save_user_layout — see PHASE2_SPEC.md §9b for the
// atomic-write requirement that function implements), then writing the
// resulting preset straight back into the node's own picker via
// node.panelComposerApplySavedLayout (a hook panel_layout_preview.js attaches per
// node instance) so it's immediately selected without the user having to
// find it in the dropdown. See the readingOrderManuallySet declaration
// above for how a manual reading-order override is represented in the
// saved data despite the reading_groups schema only being able to encode
// geometry-derived structure, not an arbitrary literal order. Steps 8
// (already folded into step 7's build, since the save route can't work
// without presets/layouts.py's merge logic existing) and 9 (full
// round-trip live test) remain.
//
// Built as a fully independent, self-owned DOM overlay (position: fixed,
// full-viewport, appended to document.body) rather than any attempt to
// reuse ComfyUI's own Mask Editor — see the revision note at the top of
// PHASE2_SPEC.md for why that path was rejected before this was written.

const COLOR_BACKDROP = "rgba(0, 0, 0, 0.65)";
const COLOR_DIALOG_BG = "#181820";
const COLOR_PANEL_BG = "#13131a";
const COLOR_BORDER = "#2e2e3c";
const COLOR_INK = "#e6e6e6";
const COLOR_MUTED = "#9a9ab0";
const COLOR_ACCENT = "#4a90d9";
const COLOR_PAGE_BG = "#f5f5f5";
const COLOR_VERTEX = "#141414";
const COLOR_INVALID = "#d94848";
// Overlap policy: allowed, not blocked — PanelCompositor already handles
// it deterministically (panels paint in reading order, so a
// later-reading-order panel visually covers an earlier one where they
// overlap; see nodes/panel_compositor.py's Image.composite loop), and
// deliberate overlap is a legitimate technique (inset panels, bleed-over,
// splash effects). This is a non-blocking warning color, distinct from
// COLOR_INVALID — it never prevents Save.
const COLOR_OVERLAP_WARNING = "#d9a13f";

// Arbitrarily high — needs live verification against whatever z-index
// ComfyUI's own overlays (context menus, other dialogs) actually use; not
// verifiable without a running browser session (same standing gap as the
// rest of this project's DOM/widget code).
const OVERLAY_Z_INDEX = 100000;

const VERTEX_HIT_PX = 8;
const CLOSE_HIT_PX = 10;

// Snap tolerances, in canvas CSS pixels — deliberately distinct per type so
// the priority order in PHASE2_SPEC.md §3b (vertex > edge > guide > canvas >
// grid) tends to hold even when tolerances overlap: a point that's within
// the vertex tolerance is almost always also within the looser edge/guide
// ones, so checking vertex first and returning early is what actually makes
// it "highest priority" rather than just "checked first for no reason."
const SNAP_TOL_VERTEX_PX = 10;
const SNAP_TOL_EDGE_PX = 8;
const SNAP_TOL_GUIDE_PX = 6;
const SNAP_TOL_CANVAS_PX = 8;
// Grid spacing as a fraction of canvas size — matches the "every 5% of
// canvas width" example in PHASE2_SPEC.md §3b. Fixed for now rather than a
// configurable-spacing UI control, which the spec only suggests, not
// requires.
const GRID_SPACING_NORM = 0.05;

// Same idea as panel_layout_preview.js's fitPageRect (CSS object-fit:
// contain, computed by hand) — kept as its own small copy here rather than
// exported/imported, since dialog-specific canvas-fitting will likely grow
// its own needs (margins for toolbars, etc.) that would make a shared
// function awkward; the aspect-ratio *table* (the thing actually worth not
// duplicating) is still imported, not this.
function fitRect(boxW, boxH, aspectRatio) {
    const boxAr = boxW / boxH;
    let w, h;
    if (aspectRatio > boxAr) {
        w = boxW;
        h = boxW / aspectRatio;
    } else {
        h = boxH;
        w = boxH * aspectRatio;
    }
    return { w, h };
}

function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}

// ── NORMALIZE (user-requested cleanup button) ──────────────────────────────
// Freehand-drawn/snapped coordinates routinely end up as ugly long
// repeating decimals (e.g. 0.9990740740740741, 0.32592592592592595) — a
// side effect of pixel-quantized normalized coordinates, especially after
// resizing Canvas Shape mid-edit (a pixel position exact for one canvas
// size becomes a repeating fraction of a different one). Two independent
// cleanups, applied per-vertex:
//   1. If a coordinate is within NORMALIZE_SNAP_TOLERANCE of 0, 0.5, or 1
//      (by far the most common INTENDED positions — canvas edges/center),
//      snap to that exact value. Covers exactly the reported cases:
//      0.999... -> 1, 0.499...-> 0.5, 0.498...-> 0.5.
//   2. Otherwise, round to NORMALIZE_ROUND_DECIMALS decimal places — cleans
//      up trailing float noise (0.6000000000000001 -> 0.6) and shortens
//      genuine non-round positions (0.32592592592592595 -> 0.3259) without
//      forcing them onto an unrelated "nice" number.
// Vertices already get clamped into [0,1] on every interactive path
// (pixelToNorm) and again by autoRepairPanel at close/save time, so this
// clamp is a belt-and-suspenders safety net here too, same reasoning as
// autoRepairPanel's — not the primary way out-of-bounds points get fixed,
// but this button is explicitly also supposed to fix any that slipped
// through (e.g. from hand-editing layouts_user.json before loading it back
// in), diagonally-out points landing on the nearest canvas corner as a
// natural consequence of clamping each axis independently.
const NORMALIZE_SNAP_TARGETS = [0, 0.5, 1];
const NORMALIZE_SNAP_TOLERANCE = 0.006;
const NORMALIZE_ROUND_DECIMALS = 4;

function normalizeCoordinate(v) {
    const clamped = clamp01(v);
    for (const target of NORMALIZE_SNAP_TARGETS) {
        if (Math.abs(clamped - target) <= NORMALIZE_SNAP_TOLERANCE) return target;
    }
    const factor = 10 ** NORMALIZE_ROUND_DECIMALS;
    return Math.round(clamped * factor) / factor;
}

function normalizePanelPoints(points) {
    return points.map(([x, y]) => [normalizeCoordinate(x), normalizeCoordinate(y)]);
}

// Standard ray-casting point-in-polygon test.
function pointInPolygon(point, polygon) {
    const [px, py] = point;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        const crosses = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
        if (crosses) inside = !inside;
    }
    return inside;
}

// Nearest point to `p` on the segment a-b, clamped to the segment (not the
// infinite line) — used for edge snapping.
function closestPointOnSegment([px, py], [ax, ay], [bx, by]) {
    const abx = bx - ax;
    const aby = by - ay;
    const lenSq = abx * abx + aby * aby;
    if (lenSq < 1e-9) return [ax, ay];
    let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return [ax + abx * t, ay + aby * t];
}

// Constrains (px,py) to the nearest 45° increment relative to (prevPx,
// prevPy) — the Shift straight-line helper (PHASE2_SPEC.md §3b, last
// paragraph). Independent of the snap priority chain below; applied first,
// then the result still runs through normal snapping.
function angleConstrainPoint(prevPx, prevPy, px, py) {
    const dx = px - prevPx;
    const dy = py - prevPy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return [px, py];
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return [prevPx + Math.cos(angle) * dist, prevPy + Math.sin(angle) * dist];
}

// ── WINDING NORMALIZATION + VALIDATION (PHASE2_SPEC.md §4/§5) ─────────────
// Standard shoelace sum. In this pack's normalized [0,1] space, y grows
// downward (screen convention, per ADDING_PRESETS.md) — under that
// convention a POSITIVE result here means the points run clockwise on
// screen, which is the direction every existing layouts.json preset uses
// (verified against a plain TL,TR,BR,BL unit-square: (0,0),(1,0),(1,1),(0,1)
// gives +1, not -1).
function signedArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
}

// §4: reverse to clockwise if needed, then (4-vertex panels only) rotate so
// the array starts at the top-left-most vertex (min y, min x tiebreak) —
// matching every hand-authored quad preset's convention so fit_to_shape's
// corner-to-corner homography behaves the same for drawn shapes as for
// built-in ones. Runs once, at shape-close/save time only — never mid-drag,
// since reordering the array while a specific vertexIndex is selected/being
// dragged would silently retarget the drag to a different point.
function normalizeWinding(points) {
    if (points.length < 3) return points.slice();
    let pts = points.slice();
    if (signedArea(pts) < 0) pts = pts.slice().reverse();
    if (pts.length === 4) {
        let minIdx = 0;
        for (let i = 1; i < pts.length; i++) {
            const [x, y] = pts[i];
            const [mx, my] = pts[minIdx];
            if (y < my - 1e-9 || (Math.abs(y - my) <= 1e-9 && x < mx)) minIdx = i;
        }
        pts = pts.slice(minIdx).concat(pts.slice(0, minIdx));
    }
    return pts;
}

// Proper-crossing test (touching/collinear edges don't count) — good enough
// for "does this polygon cross itself," the failure class that actually
// caught 2 of the last 34 hand-authored presets per PHASE2_SPEC.md §5.
function segmentsProperlyIntersect(p1, p2, p3, p4) {
    function cross(o, a, b) {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }
    const d1 = cross(p3, p4, p1);
    const d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3);
    const d4 = cross(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function hasSelfIntersection(points) {
    const n = points.length;
    if (n < 4) return false; // a triangle can never self-intersect
    const adjacent = (i, j) => j === (i + 1) % n || i === (j + 1) % n;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (adjacent(i, j)) continue;
            if (segmentsProperlyIntersect(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true;
        }
    }
    return false;
}

// Reorders points by polar angle around their own centroid — the standard
// trick for recovering a simple (non-crossing) polygon from a point set
// that was connected in the wrong order (the common "clicked corners out
// of sequence" bowtie case). Not a general simple-polygonization solver:
// for a genuinely star-shaped/very-concave intended outline this can pick
// a different — still simple, but not what was intended — ordering, which
// is why it's only ever applied when the shape is ALREADY known to be
// self-intersecting (a valid concave shape like an L or wedge never
// reaches this function) and why the result is re-checked afterward rather
// than trusted blindly.
function sortPointsByCentroidAngle(points) {
    const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
    const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
    return points
        .map((p) => ({ p, angle: Math.atan2(p[1] - cy, p[0] - cx) }))
        .sort((a, b) => a.angle - b.angle)
        .map((e) => e.p);
}

// Best-effort auto-repair, run at shape-close and on Save (PHASE2_SPEC.md
// §5 flags silently saving a broken shape as the failure mode worth
// actively engineering against; auto-fixing what can be safely auto-fixed
// goes a step further than just blocking/flagging it). Two independent
// repairs:
//   1. Any vertex outside the canvas gets clamped back onto it. In normal
//      use this is already unreachable — every interactive path
//      (pixelToNorm) clamps as points are placed/dragged — but this is a
//      cheap, harmless safety net regardless of how a point got here.
//   2. A self-intersecting outline gets one repair attempt via the
//      centroid-angle reorder above. If that doesn't produce a simple
//      polygon either (rare — e.g. duplicate/collinear points), the
//      points are left as originally drawn and validatePanelPoints still
//      flags it, so a shape this function can't actually fix never gets
//      silently reported as fine.
function autoRepairPanel(points) {
    let pts = points.map(([x, y]) => [clamp01(x), clamp01(y)]);
    if (hasSelfIntersection(pts)) {
        const reordered = sortPointsByCentroidAngle(pts);
        if (!hasSelfIntersection(reordered)) pts = reordered;
    }
    return pts;
}

const VALIDATION_AREA_EPS = 1e-4;
const VALIDATION_BOUNDS_EPS = 1e-6;

// §5: the mandatory pre-save checks, ported from the same rules already
// proven against this project's own built-in preset batch. Returns a plain
// English reason (matching the Python validator's tone) or null if valid.
function validatePanelPoints(points) {
    if (points.length < 3) return "needs at least 3 points";
    const outOfBounds = points.some(
        ([x, y]) => x < -VALIDATION_BOUNDS_EPS || x > 1 + VALIDATION_BOUNDS_EPS || y < -VALIDATION_BOUNDS_EPS || y > 1 + VALIDATION_BOUNDS_EPS
    );
    if (outOfBounds) return "has a point outside the canvas";
    // Self-intersection before the area check: a self-crossing "bowtie"
    // shape's lobes have opposite winding and cancel in the shoelace sum
    // (a bowtie's signed area comes out exactly 0, same as a truly
    // degenerate sliver) — checking self-intersection first gives the
    // actionable, specific reason instead of a misleading "no area".
    if (hasSelfIntersection(points)) return "this panel's outline crosses itself";
    if (Math.abs(signedArea(points)) < VALIDATION_AREA_EPS) return "has almost no area";
    return null;
}

// ── OVERLAP DETECTION (advisory, not validation — see COLOR_OVERLAP_WARNING) ──
function bboxOf(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
}

function sharesCorner(a, b, eps = 1e-7) {
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

// True area overlap between two panels — touching (a shared edge or
// corner, the normal tiled/adjacent-panel case used by most presets) is
// NOT overlap and must never be flagged as one. Cheap bbox reject first,
// then: (a) any edge of one properly crosses an edge of the other, EXCEPT
// edge pairs that share an actual corner between the two panels (two
// panels sharing a diagonal or a corner point produce edges that touch
// exactly at that shared vertex — a "proper crossing" test is unreliable
// right at a shared endpoint, and this is exactly the touching-not-
// overlapping case); (b) each panel's own CENTROID (not a raw vertex,
// which could itself sit exactly on the other panel's boundary in the
// shared-corner case) tested for containment in the other, catching full/
// partial containment that produces no edge crossings at all.
//
// Verified against all 45 built-in presets (22 of which have
// bbox-overlapping-but-only-touching panel pairs, e.g. every diagonal/
// wedge/cascade split): zero false positives with this exact algorithm.
// It also caught one genuine pre-existing bug this way — see TODO.md's
// splash_with_corner_notch entry — so it's a real, working check, not
// just untested logic.
function polygonsOverlap(pointsA, pointsB) {
    const a = bboxOf(pointsA);
    const b = bboxOf(pointsB);
    if (a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY) return false;

    const nA = pointsA.length;
    const nB = pointsB.length;
    for (let i = 0; i < nA; i++) {
        const a1 = pointsA[i];
        const a2 = pointsA[(i + 1) % nA];
        for (let j = 0; j < nB; j++) {
            const b1 = pointsB[j];
            const b2 = pointsB[(j + 1) % nB];
            if (sharesCorner(a1, b1) || sharesCorner(a1, b2) || sharesCorner(a2, b1) || sharesCorner(a2, b2)) continue;
            if (segmentsProperlyIntersect(a1, a2, b1, b2)) return true;
        }
    }
    if (pointInPolygon(polygonCentroid(pointsA), pointsB)) return true;
    if (pointInPolygon(polygonCentroid(pointsB), pointsA)) return true;
    return false;
}

function makeToolbarButton(label, title) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.title = title || label;
    btn.style.cssText = `
        background: ${COLOR_PANEL_BG};
        color: ${COLOR_INK};
        border: 1px solid ${COLOR_BORDER};
        border-radius: 4px;
        padding: 5px 10px;
        font-size: 12px;
        cursor: pointer;
    `;
    btn.addEventListener("mouseenter", () => {
        if (btn.dataset.forceBorder !== "true") btn.style.borderColor = COLOR_ACCENT;
    });
    btn.addEventListener("mouseleave", () => {
        if (btn.dataset.forceBorder !== "true") btn.style.borderColor = COLOR_BORDER;
    });
    return btn;
}

function makeToggle(label, title) {
    const btn = makeToolbarButton(label, title);
    btn.dataset.active = "false";
    btn.addEventListener("click", () => {
        const active = btn.dataset.active === "true";
        btn.dataset.active = active ? "false" : "true";
        btn.style.background = active ? COLOR_PANEL_BG : COLOR_ACCENT;
        btn.style.color = active ? COLOR_INK : "#0a0a0a";
    });
    // Default on, per PHASE2_SPEC.md §3b ("all snap types on by default").
    btn.dataset.active = "true";
    btn.style.background = COLOR_ACCENT;
    btn.style.color = "#0a0a0a";
    return btn;
}

function sectionLabel(text) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = `
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: ${COLOR_MUTED};
        margin: 14px 0 6px;
    `;
    return el;
}

function openDrawingDialog(node) {
    const presetWidget = node.widgets.find((w) => w.name === "layout_preset");
    const arWidget = node.widgets.find((w) => w.name === "aspect_ratio");
    const orientationWidget = node.widgets.find((w) => w.name === "page_orientation");
    const readingOrderWidget = node.widgets.find((w) => w.name === "reading_order");
    const rawAr = parseAspectRatio(arWidget?.value ?? "1:1 (Square)");
    // §6/§2: the "Canvas Shape" side-panel control can change this mid-edit —
    // free to do, since every panel's points are normalized [0,1] and don't
    // need recalculating when the canvas outline reshapes around them.
    let pageAspectRatio = resolveOrientedAspectRatio(rawAr, orientationWidget?.value ?? "portrait");

    // ── STATE ────────────────────────────────────────────────────────────
    // Panels are stored as normalized [0,1] points from the first frame
    // (not pixels-then-converted-at-save) per PHASE2_SPEC.md §3, to avoid a
    // whole class of off-by-rounding bugs.
    let panelsState = []; // [{ points: [[x,y], ...] }, ...]
    let mode = "idle"; // "idle" | "drawing" | "select"
    let drawingPanelIndex = -1;
    let selection = null; // { panelIndex, vertexIndex } — vertexIndex null = whole-panel selection
    let cursorNorm = null; // mouse position while drawing, for the rubber-band line
    let dragState = null; // { kind: "vertex" | "panel", panelIndex, vertexIndex?, lastNorm? }
    let undoStack = [];
    let redoStack = [];
    let canvasCssW = 1;
    let canvasCssH = 1;
    // Guide-line pixel positions from the most recent snap, for rendering
    // only (null axis = no guide line to draw on that axis right now).
    let lastGuide = { x: null, y: null };
    // §6: panel indices (into panelsState) in reading order — always a
    // permutation of exactly the currently-closed panels' indices.
    // Recomputed fresh from geometry whenever the panel SET changes (a
    // panel closes or gets deleted); preserved as-is across drags, and
    // directly editable by the user via the Panels list's up/down
    // reordering (a "manual override" per PHASE2_SPEC.md §6).
    let readingOrderIds = [];
    // True once the user has manually reordered away from the geometry-
    // derived guess (moveReadingOrder), false again after any fresh
    // auto-derivation (recomputeAutoReadingOrder, incl. the Auto Order
    // button). Read only at save time (see buildSavePayload) — the
    // reading_groups schema can only encode *structure*, not an arbitrary
    // literal order (nested groups always re-sort by geometry regardless
    // of array position, which is exactly what makes built-in presets
    // rotation-correct), so there is no way to persist a genuine manual
    // override through that mechanism. Instead: a manual save omits
    // reading_groups entirely, which both apply_reading_order (Python) and
    // applyReadingOrder (JS) already treat as "use literal panel-array
    // order" — so panels are exported in readingOrderIds order and that
    // order sticks, at the cost of no longer adapting to canvas_rotation.
    // An auto-derived save instead exports flat reading_groups, which DOES
    // re-derive from geometry every time (adapting correctly to rotation),
    // matching PHASE2_SPEC.md §6's literal description of the default case.
    let readingOrderManuallySet = false;

    // ── DOM SHELL ────────────────────────────────────────────────────────
    const overlay = document.createElement("div");
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: ${COLOR_BACKDROP};
        z-index: ${OVERLAY_Z_INDEX};
        display: flex;
        align-items: center;
        justify-content: center;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
        position: relative;
        width: 90vw;
        height: 88vh;
        max-width: 1400px;
        background: ${COLOR_DIALOG_BG};
        border: 1px solid ${COLOR_BORDER};
        border-radius: 8px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
        font-family: inherit;
        color: ${COLOR_INK};
    `;
    // Don't let clicks inside the dialog bubble up to the backdrop's
    // close-on-click-outside handler.
    dialog.addEventListener("pointerdown", (e) => e.stopPropagation());

    // ── TOOLBAR ──────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.style.cssText = `
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        border-bottom: 1px solid ${COLOR_BORDER};
        background: ${COLOR_PANEL_BG};
    `;

    const title = document.createElement("div");
    title.textContent = "Draw Panels";
    title.style.cssText = "font-size: 13px; font-weight: 600; margin-right: 10px;";
    toolbar.appendChild(title);

    const newPanelBtn = makeToolbarButton("+ New Panel", "Start drawing a new panel");
    const selectBtn = makeToolbarButton("Select", "Select/move a panel or vertex");
    const deleteBtn = makeToolbarButton("Delete", "Delete the selected panel/vertex");
    const clearBtn = makeToolbarButton("Clear", "Clear all panels and start from an empty canvas");
    const normalizeBtn = makeToolbarButton(
        "Normalize",
        "Clean up messy coordinates (e.g. 0.9990740740740741 -> 1) and pull any out-of-bounds vertex back onto the canvas"
    );
    const undoBtn = makeToolbarButton("Undo", "Undo (Ctrl+Z)");
    const redoBtn = makeToolbarButton("Redo", "Redo (Ctrl+Y)");
    for (const b of [newPanelBtn, selectBtn, deleteBtn, clearBtn, normalizeBtn, undoBtn, redoBtn]) toolbar.appendChild(b);

    const spacer1 = document.createElement("div");
    spacer1.style.cssText = "width: 1px; align-self: stretch; background: " + COLOR_BORDER + "; margin: 0 4px;";
    toolbar.appendChild(spacer1);

    const snapVertexToggle = makeToggle("Vertex Snap", "Snap to other panels' vertices");
    const snapEdgeToggle = makeToggle("Edge Snap", "Snap to other panels' edges");
    const snapGuideToggle = makeToggle("Guides", "Alignment guides between vertices");
    const snapCanvasToggle = makeToggle("Canvas Snap", "Snap to canvas edges/center");
    const snapGridToggle = makeToggle("Grid", "Snap to a grid");
    for (const b of [snapVertexToggle, snapEdgeToggle, snapGuideToggle, snapCanvasToggle, snapGridToggle]) {
        toolbar.appendChild(b);
        // Re-render on toggle so the grid overlay appears/disappears
        // immediately rather than waiting for the next draw/drag frame.
        b.addEventListener("click", () => render());
    }

    const saveStatus = document.createElement("div");
    saveStatus.style.cssText = `font-size: 11px; color: ${COLOR_INVALID}; margin-right: 8px; max-width: 260px;`;
    toolbar.appendChild(saveStatus);

    const toolbarRightSpacer = document.createElement("div");
    toolbarRightSpacer.style.cssText = "flex: 1 1 auto;";
    toolbar.appendChild(toolbarRightSpacer);

    const cancelBtn = makeToolbarButton("Cancel", "Discard and close");
    const saveBtn = makeToolbarButton("Save", "Save as a new preset");
    saveBtn.style.background = COLOR_ACCENT;
    saveBtn.style.color = "#0a0a0a";
    saveBtn.style.fontWeight = "600";
    toolbar.appendChild(cancelBtn);
    toolbar.appendChild(saveBtn);

    dialog.appendChild(toolbar);

    // ── BODY: canvas area + side panel ──────────────────────────────────
    const body = document.createElement("div");
    body.style.cssText = "flex: 1 1 auto; display: flex; min-height: 0;";

    const canvasArea = document.createElement("div");
    canvasArea.style.cssText = `
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: ${COLOR_DIALOG_BG};
        overflow: auto;
        padding: 16px;
        box-sizing: border-box;
    `;

    const canvas = document.createElement("canvas");
    canvas.style.cssText = `border: 1px solid ${COLOR_BORDER}; background: ${COLOR_PAGE_BG}; cursor: crosshair;`;
    canvasArea.appendChild(canvas);
    body.appendChild(canvasArea);

    const sidePanel = document.createElement("div");
    sidePanel.style.cssText = `
        flex: 0 0 220px;
        border-left: 1px solid ${COLOR_BORDER};
        background: ${COLOR_PANEL_BG};
        padding: 10px 12px;
        overflow-y: auto;
        box-sizing: border-box;
        font-size: 12px;
    `;
    const panelsHeader = document.createElement("div");
    panelsHeader.style.cssText = "display: flex; align-items: center; justify-content: space-between;";
    panelsHeader.appendChild(sectionLabel("Panels"));
    const autoOrderBtn = makeToolbarButton("Auto Order", "Recompute reading order automatically, the same way it's derived when a panel closes");
    autoOrderBtn.style.fontSize = "10px";
    autoOrderBtn.style.padding = "3px 8px";
    panelsHeader.appendChild(autoOrderBtn);
    sidePanel.appendChild(panelsHeader);
    const panelsListContainer = document.createElement("div");
    sidePanel.appendChild(panelsListContainer);

    // §2/§6: Canvas Shape — free to change mid-edit (see the pageAspectRatio
    // comment above for why). Independent of the node's own aspect_ratio/
    // page_orientation widgets: this only affects how the dialog's drawing
    // surface is proportioned, not the node itself — the panels being drawn
    // are normalized [0,1] and work at any aspect ratio.
    sidePanel.appendChild(sectionLabel("Canvas Shape"));
    const canvasShapeRow = document.createElement("div");
    canvasShapeRow.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    const selectStyle = `width: 100%; font-size: 11px; background: ${COLOR_PANEL_BG}; color: ${COLOR_INK}; border: 1px solid ${COLOR_BORDER}; border-radius: 3px; padding: 3px;`;

    const arSelect = document.createElement("select");
    arSelect.style.cssText = selectStyle;
    for (const key of Object.keys(ASPECT_RATIO_CHOICES)) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = key;
        arSelect.appendChild(opt);
    }
    arSelect.value = arWidget?.value ?? "1:1 (Square)";
    canvasShapeRow.appendChild(arSelect);

    const orientationSelect = document.createElement("select");
    orientationSelect.style.cssText = selectStyle;
    for (const [value, label] of [
        ["portrait", "Portrait"],
        ["landscape", "Landscape"],
    ]) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        orientationSelect.appendChild(opt);
    }
    orientationSelect.value = orientationWidget?.value ?? "portrait";
    canvasShapeRow.appendChild(orientationSelect);

    sidePanel.appendChild(canvasShapeRow);

    // §2/§6: Load Preset — loads an existing preset's panels as the
    // starting point, editable from there. Per user request, whatever
    // preset the node's own layout_preset widget currently has selected is
    // the DEFAULT starting point (loaded automatically the moment the
    // dialog opens) rather than an empty canvas — the Clear button (in the
    // toolbar) is the explicit way to start blank instead. Changing this
    // dropdown afterward is snapshotted like any other action, so it's
    // undoable.
    sidePanel.appendChild(sectionLabel("Load Preset"));
    // Searchable combobox — the search box IS the dropdown trigger (see
    // createPresetCombobox in panel_layout_preview.js for why a separate
    // search input above a plain <select> was a bad two-step flow).
    // Selecting a preset here replaces the current panels wholesale (a
    // fresh starting point, not a merge) — snapshotted first, so it's
    // undoable.
    const presetCombobox = createPresetCombobox({
        initialValue: presetWidget?.value ?? "",
        onSelect: (value) => {
            if (mode === "drawing") cancelDrawing(); // don't leave an orphaned in-progress panel
            snapshotForUndo();
            loadPresetIntoCanvas(value);
            selection = null;
            recomputeAutoReadingOrder();
            render();
        },
        // Deletes a user-saved preset (never a built-in — see
        // createPresetCombobox's own guard). Only removes it from the
        // library; whatever's already drawn on the canvas (even if it was
        // loaded FROM this exact preset) is untouched — "Load Preset" is a
        // one-time starting point, not a live binding to the saved entry.
        onDelete: async (key) => {
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
            loadedPresets = await loadPresets();
            presetCombobox.setPresets(loadedPresets);
        },
    });
    sidePanel.appendChild(presetCombobox.el);
    let loadedPresets = null;

    function loadPresetIntoCanvas(choiceValue) {
        if (!loadedPresets) return;
        const key = presetKeyFromChoice(loadedPresets, choiceValue);
        const panels = panelsFromPreset(loadedPresets, key);
        // Deep-copy each polygon — panelsFromPreset's arrays come straight
        // from the shared loadedPresets object; mutating them in place (via
        // drag/snap/etc.) would corrupt that cache for any later load of
        // the same preset in this same dialog session.
        panelsState = panels.map((p) => ({ points: p.polygon.map(([x, y]) => [x, y]) }));
        presetCombobox.setValue(choiceValue);
    }
    loadPresets().then((presets) => {
        loadedPresets = presets;
        presetCombobox.setPresets(presets);
        // Auto-load the node's current preset as the starting canvas — not
        // snapshotted, since there's no meaningful prior in-dialog state to
        // undo back to at this point (this IS the dialog's starting state).
        loadPresetIntoCanvas(presetWidget?.value ?? "");
        recomputeAutoReadingOrder();
        render();
    });

    body.appendChild(sidePanel);
    dialog.appendChild(body);

    // ── SAVE PROMPT (§7/§8) ──────────────────────────────────────────────
    // Shown over the dialog (not a separate full-viewport overlay — it's
    // positioned relative to `dialog`, which got `position: relative`
    // above specifically for this) once Save's own validation has already
    // passed. Category defaults to "Custom" and can be left as-is, reused,
    // or replaced with a new name (the picker groups by whatever string
    // shows up here, no fixed list); Label has no default and is required.
    const savePromptOverlay = document.createElement("div");
    savePromptOverlay.style.cssText = `
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.55);
        z-index: 20;
    `;
    const savePromptCard = document.createElement("div");
    savePromptCard.style.cssText = `
        width: 320px;
        background: ${COLOR_PANEL_BG};
        border: 1px solid ${COLOR_BORDER};
        border-radius: 8px;
        padding: 16px;
        box-sizing: border-box;
    `;
    const savePromptTitle = document.createElement("div");
    savePromptTitle.textContent = "Save as New Preset";
    savePromptTitle.style.cssText = "font-size: 13px; font-weight: 600; margin-bottom: 6px;";
    savePromptCard.appendChild(savePromptTitle);

    const savePromptNote = document.createElement("div");
    // §3c: every save creates a new entry — there's no "overwrite" option
    // in this phase, and undoing a mistaken save means hand-editing
    // layouts_user.json. Stated up front so it isn't a surprise.
    savePromptNote.textContent = "Saves as a new preset — this can't be undone from here.";
    savePromptNote.style.cssText = `font-size: 11px; color: ${COLOR_MUTED}; margin-bottom: 12px;`;
    savePromptCard.appendChild(savePromptNote);

    function makePromptField(labelText, defaultValue) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "margin-bottom: 10px;";
        const lbl = document.createElement("div");
        lbl.textContent = labelText;
        lbl.style.cssText = `font-size: 11px; color: ${COLOR_MUTED}; margin-bottom: 3px;`;
        const input = document.createElement("input");
        input.type = "text";
        input.value = defaultValue;
        input.style.cssText = `
            width: 100%;
            box-sizing: border-box;
            background: #1b1b26;
            color: ${COLOR_INK};
            border: 1px solid ${COLOR_BORDER};
            border-radius: 3px;
            padding: 5px 6px;
            font-size: 12px;
            font-family: inherit;
        `;
        wrap.appendChild(lbl);
        wrap.appendChild(input);
        savePromptCard.appendChild(wrap);
        return input;
    }
    const categoryInput = makePromptField("Category", "Custom");
    const labelInput = makePromptField("Label", "");

    // Inline ghost-completion for Category — the classic address-bar-style
    // autocomplete: as the user types a prefix of an existing category
    // (built-in or previously user-saved, from the same loadedPresets this
    // dialog already fetched for Load Preset), the rest of that category's
    // name is appended and shown SELECTED — real browsers render an active
    // selection highlighted, which reads as the standard "grey suggested
    // remainder" pattern. Typing on continues normally (overwrites the
    // selection). This is purely a typing convenience — it never blocks a
    // genuinely new category name, and save_user_layout's own
    // case-insensitive category-matching (see presets/layouts.py) is what
    // actually prevents near-duplicate categories, independent of whether
    // a suggestion was accepted here.
    //
    // Real bug caught live: Backspace on a selection normally deletes the
    // whole selection in one step, which sounds like enough on its own —
    // but that deletion still fires an `input` event, and without the
    // inputType check below this same handler would see the shortened
    // value, find the SAME match again, and re-append the SAME suggestion
    // immediately — so Backspace visibly did nothing (delete-then-instant-
    // reinsert), making it look broken/stuck exactly as reported. Only
    // suggest on insertions, never on any deletion.
    categoryInput.addEventListener("input", (e) => {
        if (e.inputType && e.inputType.startsWith("delete")) return;
        const typed = categoryInput.value;
        if (!typed || !loadedPresets) return;
        // Only meaningful when the caret is at the very end — appending a
        // completion elsewhere would insert text unrelated to where the
        // user is actually editing.
        if (categoryInput.selectionStart !== typed.length) return;
        const categories = [...new Set(Object.values(loadedPresets).map((p) => p.category))];
        const match = categories.find(
            (c) => c.length > typed.length && c.toLowerCase().startsWith(typed.toLowerCase())
        );
        if (match) {
            categoryInput.value = typed + match.slice(typed.length);
            categoryInput.setSelectionRange?.(typed.length, categoryInput.value.length);
        }
    });

    const savePromptStatus = document.createElement("div");
    savePromptStatus.style.cssText = `font-size: 11px; color: ${COLOR_INVALID}; min-height: 14px; margin-bottom: 10px;`;
    savePromptCard.appendChild(savePromptStatus);

    const savePromptButtons = document.createElement("div");
    savePromptButtons.style.cssText = "display: flex; justify-content: flex-end; gap: 6px;";
    // Deliberately not labeled "Cancel" — the toolbar already has a Cancel
    // button that discards the whole drawing; this one only backs out of
    // the save prompt, so a distinct label avoids that ambiguity for real
    // users, not just test lookups.
    const savePromptCancelBtn = makeToolbarButton("Back", "Back to editing without saving");
    const savePromptConfirmBtn = makeToolbarButton("Save Preset", "Persist this layout");
    savePromptConfirmBtn.style.background = COLOR_ACCENT;
    savePromptConfirmBtn.style.color = "#0a0a0a";
    savePromptConfirmBtn.style.fontWeight = "600";
    savePromptButtons.appendChild(savePromptCancelBtn);
    savePromptButtons.appendChild(savePromptConfirmBtn);
    savePromptCard.appendChild(savePromptButtons);

    savePromptOverlay.appendChild(savePromptCard);
    dialog.appendChild(savePromptOverlay);
    // Don't let a click on the card bubble to the overlay's own backdrop —
    // not wired to close on backdrop click below anyway (accidental loss
    // of typed category/label would be worse than a no-op click), but this
    // keeps that intentional and explicit rather than incidental.
    savePromptCard.addEventListener("pointerdown", (e) => e.stopPropagation());

    // Tracked as a plain variable rather than read back off
    // savePromptOverlay.style.display — the dialog otherwise never
    // introspects its own inline styles, and this keeps state-checks
    // (e.g. onKeyDown's Escape handling below) independent of DOM/CSSOM
    // round-tripping quirks.
    let savePromptOpen = false;
    function openSavePrompt() {
        categoryInput.value = "Custom";
        labelInput.value = "";
        savePromptStatus.textContent = "";
        savePromptConfirmBtn.disabled = false;
        savePromptOverlay.style.display = "flex";
        savePromptOpen = true;
        labelInput.focus?.();
    }
    function closeSavePrompt() {
        savePromptOverlay.style.display = "none";
        savePromptOpen = false;
    }

    // Builds the persistence payload from the CURRENT panel/reading-order
    // state. Two different shapes depending on readingOrderManuallySet
    // (see its declaration above for the full reasoning):
    //  - Manual override: panels are reindexed to the user's chosen
    //    readingOrderIds sequence and reading_groups is omitted, so
    //    apply_reading_order's group=None fallback (literal panel-array
    //    order) bakes that exact order in permanently.
    //  - Auto (the default): panels stay in their original draw-order
    //    indices — array position is otherwise meaningless once
    //    reading_groups is present, since apply_reading_order/orderedIds
    //    always re-derive order from geometry + group structure regardless
    //    of array position — and reading_groups is deriveRowGroups' nested
    //    row structure (not a flat list), so the SAME geometry-adapts-to-
    //    rotation behavior a built-in preset gets "for free" applies here
    //    too, without collapsing multi-row layouts into one global sort
    //    (see deriveRowGroups' own comment for why that used to break).
    function buildSavePayload(category, label) {
        if (readingOrderManuallySet) {
            const orderedPanels = readingOrderIds.map((i) => panelsState[i].points.map(([x, y]) => [x, y]));
            return { category, label, panels: orderedPanels, reading_groups: null };
        }
        const panels = panelsState.map((p) => p.points.map(([x, y]) => [x, y]));
        const indices = panelsState.map((_, i) => i);
        const readingGroups = deriveRowGroups(indices, (i) => panelsState[i].points);
        return { category, label, panels, reading_groups: readingGroups };
    }

    async function submitSavePrompt() {
        const category = (categoryInput.value || "").trim() || "Custom";
        const label = (labelInput.value || "").trim();
        if (!label) {
            savePromptStatus.textContent = "Label is required.";
            return;
        }
        savePromptStatus.textContent = "Saving…";
        savePromptConfirmBtn.disabled = true;
        try {
            const payload = buildSavePayload(category, label);
            const res = await fetch("/panelcomposer/save_user_layout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `server returned ${res.status}`);
            }
            // §10: reflect the new preset as selected on the node
            // immediately, without the user having to find it in the
            // dropdown themselves.
            node.panelComposerApplySavedLayout?.(data.choice);
            close();
        } catch (err) {
            savePromptStatus.textContent = `Save failed: ${err.message}`;
            savePromptConfirmBtn.disabled = false;
        }
    }
    savePromptCancelBtn.addEventListener("click", closeSavePrompt);
    savePromptConfirmBtn.addEventListener("click", submitSavePrompt);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // ── COORDINATE HELPERS ───────────────────────────────────────────────
    function pixelToNorm(px, py) {
        return [clamp01(px / canvasCssW), clamp01(py / canvasCssH)];
    }
    function normToPixel([nx, ny]) {
        return [nx * canvasCssW, ny * canvasCssH];
    }
    function eventToCanvasPixel(e) {
        const rect = canvas.getBoundingClientRect();
        return [e.clientX - rect.left, e.clientY - rect.top];
    }

    // ── HIT TESTING ──────────────────────────────────────────────────────
    function findVertexAt(px, py) {
        for (let pi = panelsState.length - 1; pi >= 0; pi--) {
            const pts = panelsState[pi].points;
            for (let vi = 0; vi < pts.length; vi++) {
                const [vx, vy] = normToPixel(pts[vi]);
                if (Math.hypot(vx - px, vy - py) <= VERTEX_HIT_PX) return { panelIndex: pi, vertexIndex: vi };
            }
        }
        return null;
    }
    function findPanelAt(px, py) {
        const [nx, ny] = pixelToNorm(px, py);
        for (let pi = panelsState.length - 1; pi >= 0; pi--) {
            if (panelsState[pi].points.length >= 3 && pointInPolygon([nx, ny], panelsState[pi].points)) return pi;
        }
        return -1;
    }

    // ── SNAPPING (PHASE2_SPEC.md §3b) ───────────────────────────────────
    // Candidates exclude only the exact vertex being placed/dragged (by
    // identity, not by whole panel) — deliberately including the rest of
    // the *same* panel's vertices/edges, since aligning two corners of one
    // panel (e.g. a trapezoid's top edge) is as valid a use case as
    // aligning across panels, and the spec's alignment-guide wording
    // ("any other existing vertex") doesn't carve same-panel vertices out.
    function collectCandidateVertexPixels(excludePanelIndex, excludeVertexIndex) {
        const pts = [];
        panelsState.forEach((panel, pi) => {
            panel.points.forEach((pt, vi) => {
                if (pi === excludePanelIndex && vi === excludeVertexIndex) return;
                pts.push(normToPixel(pt));
            });
        });
        return pts;
    }
    function collectCandidateEdges(excludePanelIndex, excludeVertexIndex) {
        const edges = [];
        panelsState.forEach((panel, pi) => {
            const pts = panel.points;
            const n = pts.length;
            if (n < 2) return;
            // The in-progress drawing panel is an open polyline (no
            // closing edge back to point 0 yet) — every finished panel is
            // a closed polygon.
            const isOpenPolyline = pi === drawingPanelIndex && mode === "drawing";
            const segCount = isOpenPolyline ? n - 1 : n;
            for (let i = 0; i < segCount; i++) {
                const j = (i + 1) % n;
                // Skip the (at most two) edges touching the vertex being
                // dragged — its closest point on either is trivially
                // itself, which would just cancel the drag.
                if (pi === excludePanelIndex && (i === excludeVertexIndex || j === excludeVertexIndex)) continue;
                edges.push([normToPixel(pts[i]), normToPixel(pts[j])]);
            }
        });
        return edges;
    }

    // Runs the priority-ordered snap chain from PHASE2_SPEC.md §3b: vertex
    // > edge > alignment guides > canvas boundary/center > grid. Vertex/edge
    // matches lock both axes at once (they're point matches); guide/canvas/
    // grid lock one axis at a time, so e.g. a guide can lock X while canvas
    // center still locks Y in the same call. Returns the snapped pixel
    // point plus which guide lines (if any) fired, for rendering.
    function snapPixel(px, py, excludePanelIndex = -1, excludeVertexIndex = -1) {
        let lockedX = null;
        let lockedY = null;
        let guideX = null;
        let guideY = null;

        if (snapVertexToggle.dataset.active === "true") {
            const candidates = collectCandidateVertexPixels(excludePanelIndex, excludeVertexIndex);
            let best = null;
            let bestDist = SNAP_TOL_VERTEX_PX;
            for (const [vx, vy] of candidates) {
                const d = Math.hypot(vx - px, vy - py);
                if (d <= bestDist) {
                    bestDist = d;
                    best = [vx, vy];
                }
            }
            if (best) {
                lockedX = best[0];
                lockedY = best[1];
            }
        }

        if ((lockedX === null || lockedY === null) && snapEdgeToggle.dataset.active === "true") {
            const edges = collectCandidateEdges(excludePanelIndex, excludeVertexIndex);
            let best = null;
            let bestDist = SNAP_TOL_EDGE_PX;
            for (const [a, b] of edges) {
                const proj = closestPointOnSegment([px, py], a, b);
                const d = Math.hypot(proj[0] - px, proj[1] - py);
                if (d <= bestDist) {
                    bestDist = d;
                    best = proj;
                }
            }
            if (best) {
                if (lockedX === null) lockedX = best[0];
                if (lockedY === null) lockedY = best[1];
            }
        }

        if ((lockedX === null || lockedY === null) && snapGuideToggle.dataset.active === "true") {
            const candidates = collectCandidateVertexPixels(excludePanelIndex, excludeVertexIndex);
            for (const [vx, vy] of candidates) {
                if (lockedX === null && guideX === null && Math.abs(vx - px) <= SNAP_TOL_GUIDE_PX) guideX = vx;
                if (lockedY === null && guideY === null && Math.abs(vy - py) <= SNAP_TOL_GUIDE_PX) guideY = vy;
            }
            if (lockedX === null && guideX !== null) lockedX = guideX;
            if (lockedY === null && guideY !== null) lockedY = guideY;
        }

        if ((lockedX === null || lockedY === null) && snapCanvasToggle.dataset.active === "true") {
            const xTargets = [0, canvasCssW / 2, canvasCssW];
            const yTargets = [0, canvasCssH / 2, canvasCssH];
            if (lockedX === null) {
                for (const t of xTargets) {
                    if (Math.abs(t - px) <= SNAP_TOL_CANVAS_PX) {
                        lockedX = t;
                        break;
                    }
                }
            }
            if (lockedY === null) {
                for (const t of yTargets) {
                    if (Math.abs(t - py) <= SNAP_TOL_CANVAS_PX) {
                        lockedY = t;
                        break;
                    }
                }
            }
        }

        if ((lockedX === null || lockedY === null) && snapGridToggle.dataset.active === "true") {
            const gridPxX = GRID_SPACING_NORM * canvasCssW;
            const gridPxY = GRID_SPACING_NORM * canvasCssH;
            if (lockedX === null) lockedX = Math.round(px / gridPxX) * gridPxX;
            if (lockedY === null) lockedY = Math.round(py / gridPxY) * gridPxY;
        }

        return {
            x: lockedX !== null ? lockedX : px,
            y: lockedY !== null ? lockedY : py,
            guideX,
            guideY,
        };
    }

    // ── READING ORDER (PHASE2_SPEC.md §6) ───────────────────────────────
    // Only closed panels (>=3 points) participate, and the panel currently
    // being drawn is never included — it isn't a real panel yet.
    function closedPanelIndices() {
        const indices = [];
        panelsState.forEach((panel, i) => {
            if (mode === "drawing" && i === drawingPanelIndex) return;
            if (panel.points.length >= 3) indices.push(i);
        });
        return indices;
    }

    // Advisory only (see COLOR_OVERLAP_WARNING) — recomputed fresh every
    // render() call, same as validation, rather than cached/invalidated on
    // specific actions: O(closed-panel-count²) pairwise checks is cheap at
    // manga-panel counts, and this needs to stay live through drags (unlike
    // reading order, which only changes on structural edits).
    function computeOverlapMap() {
        const indices = closedPanelIndices();
        const map = new Map();
        for (let a = 0; a < indices.length; a++) {
            for (let b = a + 1; b < indices.length; b++) {
                const pi = indices[a];
                const pj = indices[b];
                if (polygonsOverlap(panelsState[pi].points, panelsState[pj].points)) {
                    if (!map.has(pi)) map.set(pi, new Set());
                    if (!map.has(pj)) map.set(pj, new Set());
                    map.get(pi).add(pj);
                    map.get(pj).add(pi);
                }
            }
        }
        return map;
    }

    // Default, automatic derivation: row structure derived from geometry
    // (deriveRowGroups — no authored row/column structure exists for a
    // drawn shape the way it does for hand-authored built-in presets) fed
    // through the exact same axis-spread sort every built-in preset's
    // reading order already uses, reusing panel_layout_preview.js's
    // deriveRowGroups/orderedIds/polygonCentroid rather than a second copy.
    // Nails ordinary stacks, side-by-sides, AND "one full row + a split row
    // below" layouts "for free" — deriveRowGroups' own comment covers why a
    // flat (ungrouped) fallback used to get that last case wrong. A
    // genuinely unusual layout (e.g. a panel deliberately spanning what a
    // human would call two rows) is exactly what the manual up/down
    // override below exists to correct.
    function recomputeAutoReadingOrder() {
        const indices = closedPanelIndices();
        readingOrderManuallySet = false;
        if (indices.length === 0) {
            readingOrderIds = [];
            return;
        }
        const centroids = {};
        indices.forEach((i) => {
            centroids[i] = polygonCentroid(panelsState[i].points);
        });
        const group = deriveRowGroups(indices, (i) => panelsState[i].points);
        readingOrderIds = orderedIds(group, centroids, readingOrderWidget?.value ?? "left_to_right");
    }

    // Manual override: swap this panel's position with its neighbor.
    // Snapshotted like any other user action, so it's independently
    // undoable.
    function moveReadingOrder(panelIndex, direction) {
        const pos = readingOrderIds.indexOf(panelIndex);
        const newPos = pos + direction;
        if (pos < 0 || newPos < 0 || newPos >= readingOrderIds.length) return;
        snapshotForUndo();
        [readingOrderIds[pos], readingOrderIds[newPos]] = [readingOrderIds[newPos], readingOrderIds[pos]];
        readingOrderManuallySet = true;
        render();
    }

    // ── UNDO / REDO ──────────────────────────────────────────────────────
    // Snapshotted at the start of each user-visible action (new panel,
    // vertex/panel drag start, delete) so one Undo reverts one whole
    // action, not one mouse-move increment.
    function snapshotForUndo() {
        undoStack.push({
            panels: JSON.parse(JSON.stringify(panelsState)),
            readingOrderIds: readingOrderIds.slice(),
            readingOrderManuallySet,
        });
        redoStack = [];
    }
    function undo() {
        if (mode === "drawing") {
            cancelDrawing();
            return;
        }
        if (undoStack.length === 0) return;
        redoStack.push({
            panels: JSON.parse(JSON.stringify(panelsState)),
            readingOrderIds: readingOrderIds.slice(),
            readingOrderManuallySet,
        });
        const prev = undoStack.pop();
        panelsState = prev.panels;
        readingOrderIds = prev.readingOrderIds;
        readingOrderManuallySet = prev.readingOrderManuallySet;
        selection = null;
        render();
    }
    function redo() {
        if (redoStack.length === 0) return;
        undoStack.push({
            panels: JSON.parse(JSON.stringify(panelsState)),
            readingOrderIds: readingOrderIds.slice(),
            readingOrderManuallySet,
        });
        const next = redoStack.pop();
        panelsState = next.panels;
        readingOrderIds = next.readingOrderIds;
        readingOrderManuallySet = next.readingOrderManuallySet;
        selection = null;
        render();
    }

    // ── DRAWING LIFECYCLE ────────────────────────────────────────────────
    function cancelDrawing() {
        if (drawingPanelIndex >= 0) panelsState.splice(drawingPanelIndex, 1);
        mode = "idle";
        drawingPanelIndex = -1;
        cursorNorm = null;
        lastGuide = { x: null, y: null };
        render();
    }
    function finishDrawing() {
        const panel = panelsState[drawingPanelIndex];
        // Not enough points for a real panel — discard outright (full
        // validation below still runs for everything with >=3 points; this
        // is just the absolute floor a shape needs to be worth keeping).
        const closedSuccessfully = panel.points.length >= 3;
        if (!closedSuccessfully) {
            panelsState.splice(drawingPanelIndex, 1);
        } else {
            // Auto-repair (out-of-bounds clamp + self-intersection fix
            // attempt) then §4 winding normalization, once, right as the
            // shape closes — safe here specifically because nothing is
            // selected/mid-drag on this panel at this exact moment.
            panel.points = normalizeWinding(autoRepairPanel(panel.points));
        }
        mode = "idle";
        drawingPanelIndex = -1;
        cursorNorm = null;
        lastGuide = { x: null, y: null };
        // §6: the panel set just grew by one closed panel — recompute after
        // resetting mode/drawingPanelIndex above, so closedPanelIndices()
        // actually counts the panel that just closed instead of still
        // treating it as "the one being drawn."
        if (closedSuccessfully) recomputeAutoReadingOrder();
        render();
    }

    // ── RENDER ───────────────────────────────────────────────────────────
    function render() {
        // Clear any stale "fix this panel" message from the last failed
        // Save attempt as soon as the user does anything else — it'll be
        // re-shown fresh if they click Save again and it's still invalid.
        saveStatus.textContent = "";
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvasCssW, canvasCssH);
        ctx.fillStyle = COLOR_PAGE_BG;
        ctx.fillRect(0, 0, canvasCssW, canvasCssH);

        // Faint grid, shown whenever grid snap is on (PHASE2_SPEC.md §2:
        // "renders ... a faint grid if grid-snap is on") — a visual cue for
        // where points will land, not just a snap-time effect.
        if (snapGridToggle.dataset.active === "true") {
            ctx.save();
            ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
            ctx.lineWidth = 1;
            const stepX = GRID_SPACING_NORM * canvasCssW;
            const stepY = GRID_SPACING_NORM * canvasCssH;
            for (let x = 0; x <= canvasCssW + 0.01; x += stepX) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, canvasCssH);
                ctx.stroke();
            }
            for (let y = 0; y <= canvasCssH + 0.01; y += stepY) {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(canvasCssW, y);
                ctx.stroke();
            }
            ctx.restore();
        }

        const colors = palette(Math.max(panelsState.length, 1));
        const overlapMap = computeOverlapMap();

        panelsState.forEach((panel, pi) => {
            const isDrawing = mode === "drawing" && pi === drawingPanelIndex;
            const pts = panel.points.map(normToPixel);
            if (pts.length === 0) return;

            // §5: validate closed panels only — an in-progress open
            // polyline isn't a polygon yet, so it's not meaningfully
            // "self-intersecting" or "zero-area" while still being drawn.
            const invalidReason = isDrawing ? null : validatePanelPoints(panel.points);
            // Overlap is advisory, not an error — only checked/shown for
            // panels that already pass validation, so the two warning
            // colors never compete for the same panel.
            const overlapsWith = !isDrawing && !invalidReason ? overlapMap.get(pi) : null;

            ctx.beginPath();
            pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
            if (isDrawing && cursorNorm) {
                const [cx, cy] = normToPixel(cursorNorm);
                ctx.lineTo(cx, cy);
            }
            if (!isDrawing && pts.length >= 3) {
                ctx.closePath();
                ctx.save();
                ctx.globalAlpha = 0.45;
                ctx.fillStyle = invalidReason ? COLOR_INVALID : colors[pi];
                ctx.fill();
                ctx.restore();
            }

            const isSelectedPanel = selection && selection.panelIndex === pi && selection.vertexIndex == null;
            ctx.save();
            if (overlapsWith) ctx.setLineDash([5, 3]);
            ctx.strokeStyle = invalidReason
                ? COLOR_INVALID
                : overlapsWith
                  ? COLOR_OVERLAP_WARNING
                  : isDrawing || isSelectedPanel
                    ? COLOR_ACCENT
                    : COLOR_VERTEX;
            ctx.lineWidth = isSelectedPanel || invalidReason || overlapsWith ? 3 : 2;
            ctx.stroke();
            ctx.restore();

            pts.forEach(([x, y], vi) => {
                const isSelectedVertex = selection && selection.panelIndex === pi && selection.vertexIndex === vi;
                ctx.beginPath();
                ctx.arc(x, y, isSelectedVertex ? 6 : 4, 0, Math.PI * 2);
                ctx.fillStyle = isSelectedVertex ? COLOR_ACCENT : COLOR_VERTEX;
                ctx.fill();
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = 1;
                ctx.stroke();
            });

            // §6: reading-order badge at the panel's centroid — only for
            // closed panels, which is exactly what's in readingOrderIds.
            if (!isDrawing) {
                const orderPos = readingOrderIds.indexOf(pi);
                if (orderPos >= 0) {
                    const [ncx, ncy] = polygonCentroid(panel.points);
                    const [bx, by] = normToPixel([ncx, ncy]);
                    ctx.beginPath();
                    ctx.arc(bx, by, 11, 0, Math.PI * 2);
                    ctx.fillStyle = COLOR_DIALOG_BG;
                    ctx.globalAlpha = 0.85;
                    ctx.fill();
                    ctx.globalAlpha = 1;
                    ctx.strokeStyle = COLOR_ACCENT;
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                    ctx.fillStyle = COLOR_INK;
                    ctx.font = "11px sans-serif";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(String(orderPos + 1), bx, by);
                }
            }
        });

        // Alignment-guide lines from the most recent snap (§3b) — only
        // meaningful while actively placing or dragging a vertex.
        if (lastGuide.x !== null || lastGuide.y !== null) {
            ctx.save();
            ctx.strokeStyle = COLOR_ACCENT;
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            if (lastGuide.x !== null) {
                ctx.beginPath();
                ctx.moveTo(lastGuide.x, 0);
                ctx.lineTo(lastGuide.x, canvasCssH);
                ctx.stroke();
            }
            if (lastGuide.y !== null) {
                ctx.beginPath();
                ctx.moveTo(0, lastGuide.y);
                ctx.lineTo(canvasCssW, lastGuide.y);
                ctx.stroke();
            }
            ctx.restore();
        }

        newPanelBtn.dataset.forceBorder = mode === "drawing" ? "true" : "false";
        newPanelBtn.style.borderColor = mode === "drawing" ? COLOR_ACCENT : COLOR_BORDER;
        selectBtn.dataset.forceBorder = mode === "select" ? "true" : "false";
        selectBtn.style.borderColor = mode === "select" ? COLOR_ACCENT : COLOR_BORDER;

        renderPanelsList(overlapMap);
    }

    function renderPanelsList(overlapMap) {
        panelsListContainer.innerHTML = "";
        if (panelsState.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "No panels yet — click + New Panel to start.";
            empty.style.cssText = `color: ${COLOR_MUTED}; font-size: 11px;`;
            panelsListContainer.appendChild(empty);
            return;
        }
        panelsState.forEach((panel, pi) => {
            const isDrawingThis = mode === "drawing" && pi === drawingPanelIndex;
            const invalidReason = isDrawingThis ? null : validatePanelPoints(panel.points);
            // Overlap is advisory — only surfaced for panels that already
            // pass validation, same rule as the canvas rendering above.
            const overlapsWith = !isDrawingThis && !invalidReason ? overlapMap?.get(pi) : null;
            // §6: this panel's position in the current reading order, or -1
            // if it's not a closed panel (still being drawn) and therefore
            // has no reading-order position at all.
            const orderPos = readingOrderIds.indexOf(pi);
            const isSelected = selection && selection.panelIndex === pi;

            const row = document.createElement("div");
            row.style.cssText = `
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 4px 6px;
                border-radius: 3px;
                cursor: pointer;
                font-size: 11px;
                margin-bottom: 2px;
                background: ${isSelected ? COLOR_ACCENT : "transparent"};
                color: ${invalidReason ? COLOR_INVALID : overlapsWith ? COLOR_OVERLAP_WARNING : isSelected ? "#0a0a0a" : COLOR_INK};
            `;

            const label = document.createElement("span");
            label.style.cssText = "flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;";
            const orderPrefix = orderPos >= 0 ? `#${orderPos + 1} ` : "";
            let suffix = "";
            if (invalidReason) {
                suffix = ` — ${invalidReason}`;
            } else if (overlapsWith) {
                // Reading order = paint order for overlapping regions
                // (PanelCompositor draws panels in reading order, later
                // ones on top) — naming the higher-reading-order panel as
                // the one "on top" tells the user which one currently wins
                // without them needing to know that mechanic already.
                const partners = [...overlapsWith]
                    .sort((x, y) => readingOrderIds.indexOf(x) - readingOrderIds.indexOf(y))
                    .map((idx) => `Panel ${idx + 1}`)
                    .join(", ");
                const thisPos = readingOrderIds.indexOf(pi);
                const topPartnerPos = Math.max(...[...overlapsWith].map((idx) => readingOrderIds.indexOf(idx)));
                const onTop = thisPos > topPartnerPos;
                suffix = ` — overlaps ${partners} (${onTop ? "on top" : "underneath"} by reading order)`;
            }
            label.textContent = `${orderPrefix}Panel ${pi + 1} (${panel.points.length} pts)${suffix}`;
            row.appendChild(label);

            // Manual reading-order override (PHASE2_SPEC.md §6) — only
            // meaningful for panels that actually have a reading-order
            // position (closed panels).
            if (orderPos >= 0) {
                const upBtn = document.createElement("button");
                upBtn.type = "button";
                upBtn.textContent = "▲";
                upBtn.title = "Move earlier in reading order";
                upBtn.dataset.reorderPanelIndex = String(pi);
                upBtn.dataset.reorderDir = "-1";
                upBtn.style.cssText = "font-size: 10px; padding: 1px 4px; cursor: pointer;";
                upBtn.disabled = orderPos === 0;
                upBtn.addEventListener("click", (e) => {
                    e.stopPropagation(); // don't also trigger the row's select-click below
                    moveReadingOrder(pi, -1);
                });
                row.appendChild(upBtn);

                const downBtn = document.createElement("button");
                downBtn.type = "button";
                downBtn.textContent = "▼";
                downBtn.title = "Move later in reading order";
                downBtn.dataset.reorderPanelIndex = String(pi);
                downBtn.dataset.reorderDir = "1";
                downBtn.style.cssText = "font-size: 10px; padding: 1px 4px; cursor: pointer;";
                downBtn.disabled = orderPos === readingOrderIds.length - 1;
                downBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    moveReadingOrder(pi, 1);
                });
                row.appendChild(downBtn);
            }

            row.addEventListener("click", () => {
                if (mode === "drawing") return; // finish/cancel drawing first
                mode = "select";
                selection = { panelIndex: pi, vertexIndex: null };
                render();
            });
            panelsListContainer.appendChild(row);
        });
    }

    // ── CANVAS SIZING ────────────────────────────────────────────────────
    function resizeCanvas() {
        const availW = canvasArea.clientWidth - 32; // minus its own padding
        const availH = canvasArea.clientHeight - 32;
        const { w, h } = fitRect(Math.max(availW, 1), Math.max(availH, 1), pageAspectRatio);
        canvasCssW = w;
        canvasCssH = h;
        const dpr = window.devicePixelRatio || 1;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
        canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
        render();
    }
    resizeCanvas();
    const onWindowResize = () => resizeCanvas();
    window.addEventListener("resize", onWindowResize);

    // ── TOOLBAR WIRING ───────────────────────────────────────────────────
    newPanelBtn.addEventListener("click", () => {
        if (mode === "drawing") cancelDrawing(); // starting fresh discards any incomplete one
        snapshotForUndo();
        panelsState.push({ points: [] });
        drawingPanelIndex = panelsState.length - 1;
        mode = "drawing";
        selection = null;
        cursorNorm = null;
        lastGuide = { x: null, y: null };
        render();
    });
    selectBtn.addEventListener("click", () => {
        if (mode === "drawing") cancelDrawing();
        mode = "select";
        lastGuide = { x: null, y: null };
        render();
    });
    deleteBtn.addEventListener("click", () => {
        if (!selection) return;
        snapshotForUndo();
        const panel = panelsState[selection.panelIndex];
        let panelRemoved = false;
        if (selection.vertexIndex == null) {
            panelsState.splice(selection.panelIndex, 1);
            panelRemoved = true;
        } else {
            panel.points.splice(selection.vertexIndex, 1);
            if (panel.points.length < 3) {
                panelsState.splice(selection.panelIndex, 1);
                panelRemoved = true;
            }
        }
        selection = null;
        // §6: only a whole-panel removal changes the reading-order set —
        // trimming one vertex off an otherwise-intact panel doesn't.
        if (panelRemoved) recomputeAutoReadingOrder();
        render();
    });
    clearBtn.addEventListener("click", () => {
        if (mode === "drawing") cancelDrawing();
        if (panelsState.length === 0) return; // nothing to clear
        snapshotForUndo();
        panelsState = [];
        selection = null;
        recomputeAutoReadingOrder();
        render();
    });
    // Geometry-only cleanup (see normalizePanelPoints above) — like a
    // whole-panel drag, this changes coordinates but not the panel SET, so
    // it deliberately does NOT recompute reading order (which would
    // discard a manual override for what's meant to be a cosmetic
    // cleanup).
    normalizeBtn.addEventListener("click", () => {
        if (panelsState.length === 0) return; // nothing to normalize
        snapshotForUndo();
        panelsState.forEach((panel) => {
            panel.points = normalizePanelPoints(panel.points);
        });
        render();
    });
    undoBtn.addEventListener("click", undo);
    redoBtn.addEventListener("click", redo);
    // §6 manual trigger: discard any manual reordering and recompute
    // reading order fresh from geometry — the same derivation that
    // already runs automatically when a panel closes/gets deleted, just
    // re-runnable on demand (e.g. after dragging panels around, which
    // doesn't auto-recompute on its own).
    autoOrderBtn.addEventListener("click", () => {
        snapshotForUndo();
        recomputeAutoReadingOrder();
        render();
    });

    // §2/§6: Canvas Shape — reshapes the drawing surface only; panel points
    // stay exactly as drawn (normalized [0,1], nothing to recalculate).
    function updateCanvasShape() {
        const rawArNow = parseAspectRatio(arSelect.value);
        pageAspectRatio = resolveOrientedAspectRatio(rawArNow, orientationSelect.value);
        resizeCanvas(); // recomputes canvasCssW/H and re-renders
    }
    arSelect.addEventListener("change", updateCanvasShape);
    orientationSelect.addEventListener("change", updateCanvasShape);

    // ── CANVAS INTERACTION ───────────────────────────────────────────────
    canvas.addEventListener("pointerdown", (e) => {
        const [px, py] = eventToCanvasPixel(e);

        if (mode === "drawing") {
            const panel = panelsState[drawingPanelIndex];
            if (panel.points.length >= 3) {
                // Close-detection uses the raw click position, not the
                // snapped one — it's a distinct gesture with its own
                // tolerance (CLOSE_HIT_PX), checked before general snapping
                // applies at all.
                const [firstX, firstY] = normToPixel(panel.points[0]);
                if (Math.hypot(firstX - px, firstY - py) <= CLOSE_HIT_PX) {
                    finishDrawing();
                    return;
                }
            }
            let targetPx = px;
            let targetPy = py;
            if (e.shiftKey && panel.points.length > 0) {
                const [prevPx, prevPy] = normToPixel(panel.points[panel.points.length - 1]);
                [targetPx, targetPy] = angleConstrainPoint(prevPx, prevPy, targetPx, targetPy);
            }
            const snapped = snapPixel(targetPx, targetPy);
            lastGuide = { x: snapped.guideX, y: snapped.guideY };
            panel.points.push(pixelToNorm(snapped.x, snapped.y));
            render();
            return;
        }

        if (mode === "select") {
            const hitVertex = findVertexAt(px, py);
            if (hitVertex) {
                selection = hitVertex;
                dragState = { kind: "vertex", panelIndex: hitVertex.panelIndex, vertexIndex: hitVertex.vertexIndex };
                snapshotForUndo();
                render();
                return;
            }
            const hitPanel = findPanelAt(px, py);
            if (hitPanel >= 0) {
                selection = { panelIndex: hitPanel, vertexIndex: null };
                dragState = { kind: "panel", panelIndex: hitPanel, lastNorm: pixelToNorm(px, py) };
                snapshotForUndo();
                render();
                return;
            }
            selection = null;
            render();
        }
    });

    canvas.addEventListener("pointermove", (e) => {
        const [px, py] = eventToCanvasPixel(e);

        if (mode === "drawing" && drawingPanelIndex >= 0) {
            const panel = panelsState[drawingPanelIndex];
            let targetPx = px;
            let targetPy = py;
            if (e.shiftKey && panel.points.length > 0) {
                const [prevPx, prevPy] = normToPixel(panel.points[panel.points.length - 1]);
                [targetPx, targetPy] = angleConstrainPoint(prevPx, prevPy, targetPx, targetPy);
            }
            const snapped = snapPixel(targetPx, targetPy);
            lastGuide = { x: snapped.guideX, y: snapped.guideY };
            cursorNorm = pixelToNorm(snapped.x, snapped.y);
            render();
            return;
        }

        if (dragState) {
            if (dragState.kind === "vertex") {
                // Vertex drag snaps against everything except the vertex
                // being moved itself (and its own two touching edges).
                const snapped = snapPixel(px, py, dragState.panelIndex, dragState.vertexIndex);
                lastGuide = { x: snapped.guideX, y: snapped.guideY };
                panelsState[dragState.panelIndex].points[dragState.vertexIndex] = pixelToNorm(snapped.x, snapped.y);
            } else {
                // Whole-panel drag stays a plain delta, unsnapped — snapping
                // any single vertex of a multi-vertex drag would distort the
                // panel's shape rather than just moving it (PHASE2_SPEC.md
                // §3b only describes snapping "as the user drags a point").
                lastGuide = { x: null, y: null };
                const norm = pixelToNorm(px, py);
                const dx = norm[0] - dragState.lastNorm[0];
                const dy = norm[1] - dragState.lastNorm[1];
                panelsState[dragState.panelIndex].points = panelsState[dragState.panelIndex].points.map(([x, y]) => [
                    x + dx,
                    y + dy,
                ]);
                dragState.lastNorm = norm;
            }
            render();
        }
    });

    canvas.addEventListener("dblclick", () => {
        if (mode !== "drawing") return;
        const panel = panelsState[drawingPanelIndex];
        // The second click of the double-click already added a (likely
        // near-duplicate) point via pointerdown above — drop it before
        // closing, so double-click doesn't leave a redundant vertex.
        if (panel.points.length > 3) panel.points.pop();
        finishDrawing();
    });

    function onPointerUp() {
        if (dragState) {
            dragState = null;
            lastGuide = { x: null, y: null };
            render();
        }
    }
    window.addEventListener("pointerup", onPointerUp);

    // ── CLOSE / KEYBOARD HANDLING ────────────────────────────────────────
    function close() {
        window.removeEventListener("resize", onWindowResize);
        window.removeEventListener("pointerup", onPointerUp);
        document.removeEventListener("keydown", onKeyDown);
        presetCombobox.destroy(); // its dropdown panel is portaled to document.body, not a descendant of overlay — doesn't get cleaned up by overlay.remove() below
        overlay.remove();
    }
    function onKeyDown(e) {
        if (e.key === "Escape") {
            if (savePromptOpen) {
                closeSavePrompt();
            } else if (mode === "drawing") {
                cancelDrawing();
            } else {
                close();
            }
            return;
        }
        if (e.key === "Enter" && mode === "drawing") {
            const panel = panelsState[drawingPanelIndex];
            if (panel.points.length >= 3) finishDrawing();
            return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
            if (mode === "select" && selection && document.activeElement === document.body) {
                deleteBtn.click();
            }
            return;
        }
        const ctrlOrCmd = e.ctrlKey || e.metaKey;
        if (ctrlOrCmd && e.key.toLowerCase() === "z") {
            e.preventDefault();
            if (e.shiftKey) redo();
            else undo();
        } else if (ctrlOrCmd && e.key.toLowerCase() === "y") {
            e.preventDefault();
            redo();
        }
    }
    document.addEventListener("keydown", onKeyDown);
    overlay.addEventListener("pointerdown", () => close()); // click on backdrop
    cancelBtn.addEventListener("click", close);
    // §4/§5 run here unconditionally (every panel gets a final auto-repair
    // pass — out-of-bounds clamp + self-intersection fix attempt — and
    // winding normalization, idempotent if already run at close time, THEN
    // validated) before the §7/§8 category/label prompt is even shown — a
    // save that would still persist a broken shape after repair is refused
    // rather than ever reaching the prompt.
    saveBtn.addEventListener("click", () => {
        if (mode === "drawing") {
            saveStatus.textContent = "Finish or cancel the panel you're drawing first.";
            return;
        }
        panelsState.forEach((panel) => {
            panel.points = normalizeWinding(autoRepairPanel(panel.points));
        });
        const firstInvalidIndex = panelsState.findIndex((panel) => validatePanelPoints(panel.points) !== null);
        if (firstInvalidIndex >= 0) {
            const reason = validatePanelPoints(panelsState[firstInvalidIndex].points);
            selection = { panelIndex: firstInvalidIndex, vertexIndex: null };
            mode = "select";
            // render() clears saveStatus at its start (see comment there) —
            // set the message after, so it survives the redraw it triggers.
            render();
            saveStatus.textContent = `Panel ${firstInvalidIndex + 1} ${reason} — fix it before saving.`;
            return;
        }
        if (panelsState.length === 0) {
            saveStatus.textContent = "Draw at least one panel before saving.";
            return;
        }
        openSavePrompt();
    });
}

app.registerExtension({
    name: "PanelComposer.PanelDrawingDialog",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PanelLayoutProvider") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            node.addWidget("button", "draw_panels", "Draw Panels", () => openDrawingDialog(node));
            return result;
        };
    },
});
