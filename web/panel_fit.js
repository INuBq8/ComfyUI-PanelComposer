import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
// the node as it is now: ComfyUI rebuilds every node when it reconnects after a restart, so an editor opened
// before that must write into the rebuilt node, not the old one. The result is also kept in this browser as a backup.
function liveNode(node) {
    const live = app.graph?.getNodeById?.(node.id);
    return live && live.type === node.type ? live : node;
}
function backup(kind, node, value) {
    try {
        localStorage.setItem(`panelcomposer_backup:${kind}:${node.id}`, JSON.stringify({ at: Date.now(), value }));
    } catch {}
}

// the node's latest page from this server session (also after a cached run), else the copy saved in the workflow
async function lastUi(kind, node, saved) {
    try {
        const r = await api.fetchApi(`/panelcomposer/last/${kind}/${node.id}`);
        if (r.ok) return await r.json();
    } catch {}
    return saved;
}
// let ComfyUI's change tracker see the change, so switching workflow tabs or reloading doesn't roll it back
function track() {
    app.graph?.change?.();
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
}

// Placement math mirrors panel_fit.py; keep both in step.
const BTN = "height:34px;padding:0 14px;font:600 14px sans-serif;color:#eee;background:#333;border:1px solid #555;border-radius:4px;cursor:pointer;white-space:nowrap;";

function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
}

function boxes(layout) {
    const cw = layout.canvas_width, ch = layout.canvas_height;
    return [...layout.panels].sort((a, b) => a.order - b.order).map((p) => {
        const xs = p.polygon.map((q) => q[0]), ys = p.polygon.map((q) => q[1]);
        const x0 = Math.round(Math.min(...xs) * cw), y0 = Math.round(Math.min(...ys) * ch);
        const x1 = Math.round(Math.max(...xs) * cw), y1 = Math.round(Math.max(...ys) * ch);
        return { x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), poly: p.polygon.map(([x, y]) => [x * cw, y * ch]) };
    });
}

function inPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

async function openEditor(node) {
    const pf = await lastUi("pf", node, node.properties?.pf);
    if (!pf?.images?.length) {
        alert("Run the workflow once so the panel images exist.");
        return;
    }
    const layout = JSON.parse(pf.layout);
    const W = layout.canvas_width, H = layout.canvas_height;
    const B = boxes(layout);
    const imgs = await Promise.all(pf.images.map(async (m) => {
        const im = new Image();
        im.src = api.apiURL(`/view?filename=${encodeURIComponent(m.filename)}&subfolder=${encodeURIComponent(m.subfolder ?? "")}&type=${m.type}&t=${Date.now()}`);
        try {
            await im.decode();
        } catch {
            return null;
        }
        return { im, w: m.w, h: m.h };
    }));
    if (imgs.some((x) => !x)) {
        alert("Run the workflow once so the panel images exist.");
        return;
    }
    const fitsW = node.widgets.find((w) => w.name === "fits");
    const fill = node.widgets.find((w) => w.name === "fill_color")?.value || "#FFFFFF";
    let fits;
    try {
        fits = JSON.parse(fitsW.value || "[]");
    } catch {
        fits = [];
    }
    const n = Math.min(imgs.length, B.length);
    for (let i = 0; i < n; i++) fits[i] = { z: 1, x: 0, y: 0, ...(fits[i] || {}) };
    let sel = 0;

    // ---- layout
    const overlay = el("div", "position:fixed;inset:0;z-index:10000;background:#111;display:flex;flex-direction:column;");
    const bar = el("div", "display:flex;gap:8px;align-items:center;padding:8px;background:#1d1d1d;border-bottom:1px solid #333;");
    const wrapC = el("div", "flex:1;position:relative;min-height:0;");
    const canvas = el("canvas", "position:absolute;inset:0;width:100%;height:100%;");
    wrapC.append(canvas);
    overlay.append(bar, wrapC);
    const btn = (label, fn) => {
        const b = el("button", BTN, label);
        b.onclick = fn;
        bar.append(b);
        return b;
    };
    btn("Fill", () => set({ z: 1, x: 0, y: 0 }));
    btn("Fit", () => {
        const b = B[sel], m = imgs[sel];
        set({ z: Math.min(b.w / m.w, b.h / m.h) / Math.max(b.w / m.w, b.h / m.h), x: 0, y: 0 });
    });
    bar.append(el("div", "flex:1;"));
    btn("Cancel", () => close(false));
    btn("Done", () => close(true)).style.background = "#2d5a8a";
    const set = (f) => {
        if (sel < n) fits[sel] = f;
        draw();
    };

    // ---- drawing
    const view = { k: 1, ox: 0, oy: 0 };
    const ctx = canvas.getContext("2d");
    const draw = () => {
        const dpr = window.devicePixelRatio || 1;
        const cw = wrapC.clientWidth, ch = wrapC.clientHeight;
        if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
            canvas.width = Math.round(cw * dpr);
            canvas.height = Math.round(ch * dpr);
        }
        view.k = Math.min((cw - 24) / W, (ch - 24) / H);
        view.ox = (cw - W * view.k) / 2;
        view.oy = (ch - H * view.k) / 2;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.ox, dpr * view.oy);
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, W, H);
        const px = 1 / view.k;
        B.forEach((b, i) => {
            const path = new Path2D();
            b.poly.forEach(([x, y], j) => (j ? path.lineTo(x, y) : path.moveTo(x, y)));
            path.closePath();
            ctx.save();
            ctx.clip(path);
            if (i < n) {
                const m = imgs[i], f = fits[i];
                const s = Math.max(b.w / m.w, b.h / m.h) * f.z;
                const cx = b.x0 + b.w / 2 + f.x * b.w, cy = b.y0 + b.h / 2 + f.y * b.h;
                ctx.drawImage(m.im, cx - (m.w * s) / 2, cy - (m.h * s) / 2, m.w * s, m.h * s);
            } else {
                ctx.fillStyle = "#555";
                ctx.fillRect(b.x0, b.y0, b.w, b.h);
            }
            ctx.restore();
            ctx.lineWidth = (i === sel ? 4 : 2) * px;
            ctx.strokeStyle = i === sel ? "#2ec4ff" : "#888";
            ctx.stroke(path);
        });
    };

    // ---- mouse
    const toImg = (e) => {
        const r = canvas.getBoundingClientRect();
        return [(e.clientX - r.left - view.ox) / view.k, (e.clientY - r.top - view.oy) / view.k];
    };
    const hit = (x, y) => B.findIndex((b, i) => i < n && inPoly(x, y, b.poly));
    let drag = null;
    canvas.onpointerdown = (e) => {
        const [x, y] = toImg(e);
        const i = hit(x, y);
        if (i < 0) return;
        sel = i;
        drag = { x, y, fx: fits[i].x, fy: fits[i].y };
        canvas.setPointerCapture(e.pointerId);
        draw();
    };
    canvas.onpointermove = (e) => {
        const [x, y] = toImg(e);
        if (!drag) {
            canvas.style.cursor = hit(x, y) >= 0 ? "move" : "default";
            return;
        }
        const b = B[sel];
        fits[sel].x = drag.fx + (x - drag.x) / b.w;
        fits[sel].y = drag.fy + (y - drag.y) / b.h;
        draw();
    };
    canvas.onpointerup = () => (drag = null);
    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const [x, y] = toImg(e);
        let i = hit(x, y);
        if (i < 0) i = sel;
        if (i >= n) return;
        sel = i;
        const b = B[i], f = fits[i];
        const z = Math.min(10, Math.max(0.05, f.z * Math.exp(-e.deltaY * 0.0015)));
        // keep the point under the cursor in place
        const px = x - b.x0, py = y - b.y0;
        const cx = b.w / 2 + f.x * b.w, cy = b.h / 2 + f.y * b.h;
        const r = z / f.z;
        f.x = (px + (cx - px) * r - b.w / 2) / b.w;
        f.y = (py + (cy - py) * r - b.h / 2) / b.h;
        f.z = z;
        draw();
    }, { passive: false });

    overlay.addEventListener("keydown", (e) => e.stopPropagation());
    overlay.addEventListener("keyup", (e) => e.stopPropagation());
    overlay.tabIndex = -1;
    const onResize = () => draw();
    window.addEventListener("resize", onResize);

    const close = (save) => {
        if (save) {
            const r = (v) => Math.round(v * 1e5) / 1e5;
            const target = liveNode(node);
            const fitsWLive = target.widgets.find((w) => w.name === "fits");
            fitsWLive.value = JSON.stringify(fits.slice(0, Math.max(n, fits.length)).map((f) => ({ z: r(f.z), x: r(f.x), y: r(f.y) })));
            fitsWLive.callback?.(fitsWLive.value);
            backup("pf", target, fitsWLive.value);
            target.setDirtyCanvas(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
            track();
        }
        window.removeEventListener("resize", onResize);
        overlay.remove();
    };

    document.body.append(overlay);
    overlay.focus();
    draw();
}

app.registerExtension({
    name: "PanelFit.Editor",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PanelFit") return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = created?.apply(this, arguments);
            const w = this.widgets?.find((x) => x.name === "fits");
            if (w) {
                w.hidden = true;
                w.computeSize = () => [0, -4];
            }
            this.addWidget("button", "Fit Panels", null, () => openEditor(this), { serialize: false });
            return r;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (data) {
            executed?.apply(this, arguments);
            if (data?.panel_images?.length && data?.panel_layout?.[0]) {
                this.properties = this.properties || {};
                this.properties.pf = { images: data.panel_images, layout: data.panel_layout[0] };
                track();
            }
        };
    },
});
