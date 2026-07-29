import { app } from "../../scripts/app.js";

// Mirrors presets/layouts.py — these are Phase 1's fixed presets, so keep
// this in sync by hand if that file changes. Drawn entirely client-side so
// the preview updates instantly on widget change, with no execution needed.
const LAYOUTS = {
    single_full_page: [
        { order: 0, polygon: [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]] },
    ],
    two_vertical_split: [
        { order: 0, polygon: [[0.0, 0.0], [1.0, 0.0], [1.0, 0.5], [0.0, 0.5]] },
        { order: 1, polygon: [[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]] },
    ],
    two_horizontal_split: [
        { order: 0, polygon: [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]] },
        { order: 1, polygon: [[0.5, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 1.0]] },
    ],
    three_top_split: [
        { order: 0, polygon: [[0.0, 0.0], [0.5, 0.0], [0.5, 0.46], [0.0, 0.46]] },
        { order: 1, polygon: [[0.5, 0.0], [1.0, 0.0], [1.0, 0.46], [0.5, 0.46]] },
        { order: 2, polygon: [[0.0, 0.46], [1.0, 0.46], [1.0, 1.0], [0.0, 1.0]] },
    ],
    four_grid: [
        { order: 0, polygon: [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]] },
        { order: 1, polygon: [[0.5, 0.0], [1.0, 0.0], [1.0, 0.5], [0.5, 0.5]] },
        { order: 2, polygon: [[0.0, 0.5], [0.5, 0.5], [0.5, 1.0], [0.0, 1.0]] },
        { order: 3, polygon: [[0.5, 0.5], [1.0, 0.5], [1.0, 1.0], [0.5, 1.0]] },
    ],
    two_diagonal_split: [
        { order: 0, polygon: [[0.0, 0.0], [1.0, 0.0], [1.0, 0.7], [0.0, 0.3]] },
        { order: 1, polygon: [[0.0, 0.3], [1.0, 0.7], [1.0, 1.0], [0.0, 1.0]] },
    ],
    three_panel_cascade_diagonal: [
        { order: 0, polygon: [[0.0, 0.0], [0.3333, 0.0], [0.4533, 1.0], [0.0, 1.0]] },
        { order: 1, polygon: [[0.3333, 0.0], [0.6667, 0.0], [0.7867, 1.0], [0.4533, 1.0]] },
        { order: 2, polygon: [[0.6667, 0.0], [1.0, 0.0], [1.0, 1.0], [0.7867, 1.0]] },
    ],
    corner_inset_l_shape: [
        {
            order: 0,
            polygon: [
                [0.0, 0.0], [1.0, 0.0], [1.0, 0.65],
                [0.65, 0.65], [0.65, 1.0], [0.0, 1.0],
            ],
        },
        { order: 1, polygon: [[0.65, 0.65], [1.0, 0.65], [1.0, 1.0], [0.65, 1.0]] },
    ],
};

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

function parseAspectRatio(ratioStr) {
    const [w, h] = String(ratioStr).split(":").map(Number);
    return w / h;
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
            `;

            const canvas = document.createElement("canvas");
            canvas.style.cssText = "display:block;width:100%;height:100%;";
            previewBox.appendChild(canvas);

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

            const redraw = () => {
                const presetWidget = node.widgets.find((w) => w.name === "layout_preset");
                const arWidget = node.widgets.find((w) => w.name === "aspect_ratio");
                const panels = LAYOUTS[presetWidget?.value] ?? LAYOUTS.single_full_page;
                const ar = parseAspectRatio(arWidget?.value ?? "2:3");
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

            for (const name of ["layout_preset", "aspect_ratio"]) {
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

            requestAnimationFrame(redraw);

            return result;
        };
    },
});
