import { app } from "../../scripts/app.js";

// Preset data (panel polygons + reading-order groupings) lives in
// layouts.json, right next to this file — presets/layouts.py loads that
// same file from disk, so this fetch is what keeps the two in sync instead
// of hand-maintaining a duplicate copy here (which is what this file used
// to do, and was a standing "forgot to update the JS mirror" risk). Fetched
// once and cached; every node instance's redraw awaits the same promise.
const LAYOUTS_URL = new URL("./layouts.json", import.meta.url);
let presetsPromise = null;

function loadPresets() {
    if (!presetsPromise) {
        presetsPromise = fetch(LAYOUTS_URL)
            .then((r) => r.json())
            .catch((err) => {
                console.error("Manga.PanelLayoutPreview: failed to load layouts.json", err);
                return {};
            });
    }
    return presetsPromise;
}

function panelsFromPreset(presets, presetName) {
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
function presetKeyFromChoice(presets, choiceValue) {
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
function populateGroupedSelect(select, presets, currentValue) {
    select.innerHTML = "";
    const byCategory = new Map();
    for (const data of Object.values(presets)) {
        if (!byCategory.has(data.category)) byCategory.set(data.category, []);
        byCategory.get(data.category).push(data.label);
    }
    for (const [category, labels] of byCategory) {
        const group = document.createElement("optgroup");
        group.label = category;
        for (const label of labels) {
            const opt = document.createElement("option");
            opt.value = `${category} / ${label}`;
            opt.textContent = label;
            group.appendChild(opt);
        }
        select.appendChild(group);
    }
    select.value = currentValue;
}

function groupCentroid(group, centroids) {
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
function orderedIds(group, centroids, readingOrder) {
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
const ASPECT_RATIO_CHOICES = {
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

function parseAspectRatio(ratioChoice) {
    return ASPECT_RATIO_CHOICES[ratioChoice] ?? 1.0;
}

// Mirrors utils/geometry.py's resolve_oriented_aspect_ratio: aspect_ratio
// picks the ratio's magnitude, page_orientation decides which way it points.
function resolveOrientedAspectRatio(ratioMagnitude, orientation) {
    const magnitude = Math.max(ratioMagnitude, 1 / ratioMagnitude);
    return orientation === "landscape" ? magnitude : 1 / magnitude;
}

// Area-weighted centroid, robust for concave polygons (e.g. the L-shape).
function polygonCentroid(points) {
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

function palette(n) {
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
    name: "Manga.PanelLayoutPreview",
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

            // ── LAYOUT PICKER (real <optgroup> nesting — see populateGroupedSelect
            // above for why this isn't a LiteGraph widget) ────────────────────
            const pickerBar = document.createElement("div");
            pickerBar.style.cssText = `
                flex: 0 0 auto;
                padding: 4px;
                border-bottom: 1px solid ${COLOR_BORDER};
                box-sizing: border-box;
                display: flex;
                gap: 4px;
                align-items: stretch;
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

            const presetSelect = document.createElement("select");
            presetSelect.style.cssText = `
                flex: 1 1 auto;
                min-width: 0;
                background: #1b1b26;
                color: #e6e6e6;
                border: 1px solid ${COLOR_BORDER};
                border-radius: 3px;
                padding: 3px 4px;
                font-size: 11px;
                font-family: inherit;
                box-sizing: border-box;
            `;
            pickerBar.appendChild(prevButton);
            pickerBar.appendChild(presetSelect);
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

            loadPresets().then((loaded) => {
                presets = loaded;

                const presetWidget = node.widgets.find((w) => w.name === "layout_preset");
                if (presetWidget) {
                    populateGroupedSelect(presetSelect, presets, presetWidget.value);

                    const applySelection = () => {
                        presetWidget.value = presetSelect.value;
                        presetWidget.callback?.(presetSelect.value, app.canvas, node, null, null);
                        redraw();
                    };
                    presetSelect.addEventListener("change", applySelection);

                    // Step through presetSelect.options in DOM order — a flat
                    // walk across every <optgroup> in turn, same order as the
                    // dropdown itself, wrapping at both ends. Programmatically
                    // setting .selectedIndex doesn't fire "change" on its own,
                    // so both buttons call applySelection directly afterward.
                    const step = (delta) => {
                        const count = presetSelect.options.length;
                        if (count === 0) return;
                        presetSelect.selectedIndex = (presetSelect.selectedIndex + delta + count) % count;
                        applySelection();
                    };
                    prevButton.addEventListener("click", () => step(-1));
                    nextButton.addEventListener("click", () => step(1));

                    // The <select> above is now the real picker — collapse the
                    // native flat-list widget so there's still exactly one
                    // visible control, not two. Its value keeps working exactly
                    // as before (still the actual serialized backend input);
                    // this only changes how much vertical space it draws as.
                    presetWidget.computeSize = () => [0, -4];
                    try {
                        node.setSize(node.computeSize());
                    } catch (err) {
                        console.warn("Manga.PanelLayoutPreview: couldn't resize node after hiding layout_preset", err);
                    }
                }

                requestAnimationFrame(redraw);
            });

            return result;
        };
    },
});
