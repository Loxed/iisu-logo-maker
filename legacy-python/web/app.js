"use strict";

const CONTROLS = [
  { title: "Canvas", items: [
    { key: "canvas_size", label: "Canvas size", type: "int", min: 256, max: 6000, step: 8 },
    { key: "padding", label: "Padding", type: "num", min: 0, max: 900, step: 1 },
    { key: "supersample", label: "Supersample", type: "select", options: [1, 2, 3, 4], cast: Number },
    { key: "fit_mode", label: "Fit mode", type: "select", options: ["composite", "front"] },
  ]},
  { title: "Logo", items: [
    { key: "logo_enabled", label: "Show logo", type: "check" },
    { key: "logo_color", label: "Logo color", type: "color" },
  ]},
  { title: "Border", items: [
    { key: "stroke_width", label: "Stroke width", type: "num", min: 0, max: 900, step: 1 },
    { key: "fill_holes", label: "Fill holes", type: "check" },
    { key: "gradient_stops", label: "Gradient", type: "stops" },
    { key: "gradient_angle", label: "Gradient angle", type: "num", min: 0, max: 360, step: 1 },
    { key: "gradient_space", label: "Gradient span", type: "select", options: ["shape", "canvas"] },
  ]},
  { title: "Extrusion", items: [
    { key: "extrusion_enabled", label: "Extrusion", type: "check" },
    { key: "extrusion_depth", label: "Depth", type: "num", min: 0, max: 1200, step: 1 },
    { key: "extrusion_angle", label: "Angle", type: "num", min: 0, max: 360, step: 1 },
    { key: "extrusion_color", label: "Color", type: "autocolor" },
  ]},
  { title: "Shading", items: [
    { key: "shading_enabled", label: "Shading", type: "check" },
    { key: "extrusion_darken", label: "Darken", type: "num", min: 0, max: 1, step: 0.01 },
    { key: "shading_strength", label: "Depth ramp", type: "num", min: 0, max: 1, step: 0.01 },
    { key: "shading_saturation", label: "Saturation", type: "num", min: 0, max: 1, step: 0.01 },
    { key: "smoothness", label: "Smoothness", type: "num", min: 0, max: 100, step: 1 },
    { key: "highlight_size", label: "Highlight size", type: "num", min: 0, max: 1, step: 0.01 },
    { key: "highlight_color", label: "Edge color", type: "color" },
    { key: "highlight_strength", label: "Edge amount", type: "num", min: 0, max: 1, step: 0.01 },
  ]},
];

const CLI_FLAGS = {
  canvas_size: "--canvas-size", padding: "--padding", supersample: "--supersample",
  fit_mode: "--fit-mode", logo_color: "--logo-color", stroke_width: "--stroke-width",
  gradient_angle: "--gradient-angle", gradient_space: "--gradient-space",
  extrusion_depth: "--extrusion-depth", extrusion_angle: "--extrusion-angle",
  extrusion_color: "--extrusion-color", shading_strength: "--shading-strength",
  smoothness: "--smoothness", highlight_size: "--highlight-size",
  extrusion_darken: "--extrusion-darken", shading_saturation: "--shading-saturation",
  highlight_color: "--highlight-color", highlight_strength: "--highlight-strength",
};

const S = {
  defaults: null, presets: {}, params: null,
  sourceId: null, sourceName: "icon.svg",
  timer: null, ctrl: null, busy: false, dirty: false,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function setStatus(text, kind) {
  const n = $("#status");
  n.textContent = text;
  n.className = kind || "";
}

// ---------------------------------------------------------------- controls
function row(label) {
  const r = el("div", "row");
  if (label !== null) r.appendChild(el("label", null, label));
  return r;
}

function numberControl(item) {
  const r = row(item.label);
  const range = el("input");
  range.type = "range";
  range.min = item.min; range.max = item.max; range.step = item.step;
  const box = el("input");
  box.type = "number";
  box.min = item.min; box.max = item.max; box.step = item.step;
  const push = (v) => {
    let x = Number(v);
    if (!isFinite(x)) return;
    x = Math.min(item.max, Math.max(item.min, x));
    if (item.type === "int") x = Math.round(x);
    S.params[item.key] = x;
    range.value = x; box.value = x;
    queue();
  };
  range.addEventListener("input", () => push(range.value));
  box.addEventListener("change", () => push(box.value));
  r.append(range, box);
  return { node: r, set: (v) => { range.value = v; box.value = v; } };
}

function colorControl(item) {
  const r = row(item.label);
  const c = el("input"); c.type = "color";
  const t = el("input"); t.type = "text"; t.className = "hex";
  t.style.flex = "1"; t.style.background = "var(--panel-2)";
  t.style.color = "var(--text)"; t.style.border = "1px solid var(--line)";
  t.style.borderRadius = "5px"; t.style.padding = "4px 6px"; t.style.minWidth = "0";
  const push = (v) => {
    if (!/^#[0-9a-f]{6}$/i.test(v)) return;
    S.params[item.key] = v.toUpperCase();
    c.value = v; t.value = v.toUpperCase();
    queue();
  };
  c.addEventListener("input", () => push(c.value));
  t.addEventListener("change", () => push(t.value.trim()));
  r.append(c, t);
  return { node: r, set: (v) => { c.value = v; t.value = v; } };
}

function checkControl(item) {
  const r = row(item.label);
  const c = el("input"); c.type = "checkbox";
  c.addEventListener("change", () => { S.params[item.key] = c.checked; queue(); });
  r.appendChild(c);
  return { node: r, set: (v) => { c.checked = !!v; } };
}

function selectControl(item) {
  const r = row(item.label);
  const s = el("select");
  item.options.forEach((o) => {
    const opt = el("option", null, String(o));
    opt.value = String(o);
    s.appendChild(opt);
  });
  s.addEventListener("change", () => {
    S.params[item.key] = item.cast ? item.cast(s.value) : s.value;
    queue();
  });
  r.appendChild(s);
  return { node: r, set: (v) => { s.value = String(v); } };
}

function autoColorControl(item) {
  const r = row(item.label);
  const sel = el("select");
  [["auto", "auto (bottom stop)"], ["gradient", "inherit gradient"], ["custom", "custom color"]]
    .forEach(([v, label]) => {
      const o = el("option", null, label);
      o.value = v;
      sel.appendChild(o);
    });
  const c = el("input");
  c.type = "color";
  const apply = () => {
    const custom = sel.value === "custom";
    c.disabled = !custom;
    c.style.opacity = custom ? 1 : 0.4;
    S.params[item.key] = custom ? c.value.toUpperCase() : sel.value;
    queue();
  };
  sel.addEventListener("change", apply);
  c.addEventListener("input", apply);
  r.append(sel, c);
  return {
    node: r,
    set: (v) => {
      const mode = String(v).toLowerCase();
      const known = mode === "auto" || mode === "gradient";
      sel.value = known ? mode : "custom";
      c.disabled = known;
      c.style.opacity = known ? 0.4 : 1;
      c.value = known
        ? (S.params.gradient_stops.slice(-1)[0] || [1, "#369052"])[1]
        : v;
    },
  };
}

function stopsControl(item) {
  const wrap = el("div", "stops");
  const head = row(item.label);
  const add = el("button", "small", "+ stop");
  add.addEventListener("click", () => {
    const st = S.params.gradient_stops;
    const mid = st.length > 1 ? (Number(st[0][0]) + Number(st[st.length - 1][0])) / 2 : 0.5;
    st.push([mid, "#31C463"]);
    st.sort((a, b) => a[0] - b[0]);
    build(); queue();
  });
  head.appendChild(add);
  const list = el("div");

  function build() {
    list.innerHTML = "";
    S.params.gradient_stops.forEach((st, i) => {
      const r = el("div", "stop");
      const pos = el("input"); pos.type = "number";
      pos.min = 0; pos.max = 1; pos.step = 0.01; pos.value = st[0];
      const col = el("input"); col.type = "color"; col.value = st[1];
      const del = el("button", null, "x");
      del.disabled = S.params.gradient_stops.length <= 2;
      pos.addEventListener("change", () => {
        S.params.gradient_stops[i][0] = Math.min(1, Math.max(0, Number(pos.value)));
        queue();
      });
      col.addEventListener("input", () => {
        S.params.gradient_stops[i][1] = col.value.toUpperCase();
        if (i === S.params.gradient_stops.length - 1) syncAutoColor();
        queue();
      });
      del.addEventListener("click", () => {
        S.params.gradient_stops.splice(i, 1);
        build(); queue();
      });
      r.append(pos, col, del);
      list.appendChild(r);
    });
  }
  wrap.append(head, list);
  return { node: wrap, set: () => build() };
}

const FACTORY = {
  num: numberControl, int: numberControl, color: colorControl,
  check: checkControl, select: selectControl, autocolor: autoColorControl,
  stops: stopsControl,
};
const WIDGETS = {};

function buildControls() {
  const host = $("#controls");
  host.innerHTML = "";
  CONTROLS.forEach((group) => {
    const box = el("div");
    box.appendChild(el("h2", null, group.title));
    group.items.forEach((item) => {
      const w = FACTORY[item.type](item);
      WIDGETS[item.key] = w;
      box.appendChild(w.node);
    });
    host.appendChild(box);
  });
}

function syncWidgets() {
  Object.keys(WIDGETS).forEach((k) => WIDGETS[k].set(S.params[k]));
  updateCliHint();
}
function syncAutoColor() {
  if (WIDGETS.extrusion_color) WIDGETS.extrusion_color.set(S.params.extrusion_color);
}

function updateCliHint() {
  const parts = ["python -m svgextrude.cli " + S.sourceName];
  Object.keys(CLI_FLAGS).forEach((k) => {
    if (JSON.stringify(S.params[k]) !== JSON.stringify(S.defaults[k])) {
      parts.push(CLI_FLAGS[k] + " " + S.params[k]);
    }
  });
  const stops = S.params.gradient_stops;
  if (JSON.stringify(stops) !== JSON.stringify(S.defaults.gradient_stops)) {
    parts.push('--gradient-stops "' + stops.map((s) => s[0] + ":" + s[1]).join(",") + '"');
  }
  if (S.params.fill_holes) parts.push("--fill-holes");
  if (!S.params.logo_enabled) parts.push("--no-logo");
  if (!S.params.extrusion_enabled) parts.push("--no-extrusion");
  if (!S.params.shading_enabled) parts.push("--no-shading");
  $("#cli-hint").textContent = parts.join(" ");
}

// ---------------------------------------------------------------- rendering
function queue() {
  updateCliHint();
  S.dirty = true;
  clearTimeout(S.timer);
  S.timer = setTimeout(preview, 110);
}

async function preview() {
  if (!S.sourceId) return;
  if (S.busy) { S.timer = setTimeout(preview, 60); return; }
  S.dirty = false;
  S.busy = true;
  if (S.ctrl) S.ctrl.abort();
  S.ctrl = new AbortController();
  setStatus("rendering", "busy");
  try {
    const res = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: S.ctrl.signal,
      body: JSON.stringify({
        id: S.sourceId,
        mode: "preview",
        preview_size: Number($("#preview-size").value),
        params: S.params,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const img = $("#preview");
    const old = img.src;
    img.src = url;
    if (old && old.startsWith("blob:")) URL.revokeObjectURL(old);
    const warn = res.headers.get("X-Warnings");
    $("#meta").textContent =
      `${res.headers.get("X-Canvas-Size")} px preview, ${res.headers.get("X-Render-Ms")} ms` +
      (warn ? " | " + warn : "");
    setStatus("ready");
  } catch (err) {
    if (err.name !== "AbortError") setStatus(String(err.message || err), "error");
  } finally {
    S.busy = false;
    if (S.dirty) queue();
  }
}

async function exportPng() {
  if (!S.sourceId) return;
  const btn = $("#export");
  btn.disabled = true;
  setStatus("exporting " + S.params.canvas_size + " px", "busy");
  try {
    const res = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: S.sourceId, mode: "export", params: S.params }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const blob = await res.blob();
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = S.sourceName.replace(/\.svg$/i, "") + "_extruded.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setStatus("exported in " + res.headers.get("X-Render-Ms") + " ms");
  } catch (err) {
    setStatus(String(err.message || err), "error");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- sources
function setSource(id, name) {
  S.sourceId = id;
  S.sourceName = name || "icon.svg";
  $("#source-list").value = id;
  updateCliHint();
  preview();
}

function fillSources(list) {
  const sel = $("#source-list");
  sel.innerHTML = "";
  list.forEach((s) => {
    const o = el("option", null, s.name);
    o.value = s.id;
    sel.appendChild(o);
  });
}

async function upload(file) {
  const fd = new FormData();
  fd.append("file", file);
  setStatus("uploading", "busy");
  const res = await fetch("/api/svg", { method: "POST", body: fd });
  if (!res.ok) { setStatus((await res.json()).detail || "upload failed", "error"); return; }
  const info = await res.json();
  const state = await (await fetch("/api/state")).json();
  fillSources(state.sources);
  setSource(info.id, info.name);
}

function applyParams(obj) {
  const merged = Object.assign({}, S.defaults, obj || {});
  if (merged.gradient_top || merged.gradient_bottom) {
    merged.gradient_stops = [
      [0, merged.gradient_top || "#FFFFFF"],
      [1, merged.gradient_bottom || merged.gradient_top || "#000000"],
    ];
  }
  merged.gradient_stops = (merged.gradient_stops || []).map((s) => [Number(s[0]), String(s[1])]);
  delete merged.gradient_top; delete merged.gradient_bottom; delete merged.name;
  S.params = merged;
  syncWidgets();
  queue();
}

// ---------------------------------------------------------------- boot
async function boot() {
  const state = await (await fetch("/api/state")).json();
  S.defaults = state.defaults;
  S.presets = state.presets;
  buildControls();
  applyParams(state.defaults);

  const psel = $("#preset");
  Object.keys(S.presets).forEach((name) => {
    const o = el("option", null, name);
    o.value = name;
    psel.appendChild(o);
  });
  fillSources(state.sources);
  if (state.sources.length) setSource(state.sources[0].id, state.sources[0].name);

  $("#apply-preset").addEventListener("click", () => applyParams(S.presets[psel.value]));
  $("#source-list").addEventListener("change", (e) => {
    const opt = e.target.selectedOptions[0];
    setSource(e.target.value, opt ? opt.textContent : "icon.svg");
  });
  $("#file").addEventListener("change", (e) => {
    if (e.target.files[0]) upload(e.target.files[0]);
    e.target.value = "";
  });
  $("#preview-size").addEventListener("change", preview);
  $("#export").addEventListener("click", exportPng);
  $("#reset").addEventListener("click", () => applyParams(S.defaults));
  $("#save-json").addEventListener("click", () => {
    const data = Object.assign({ name: "Custom" }, S.params);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "preset.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $("#load-json").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { applyParams(JSON.parse(await f.text())); }
    catch (err) { setStatus("bad preset file", "error"); }
    e.target.value = "";
  });
  document.querySelectorAll(".bg-toggle button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".bg-toggle button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $("#viewport").className = b.dataset.bg;
    });
  });
  const vp = $("#viewport");
  ["dragenter", "dragover", "dragleave", "drop"].forEach((ev) =>
    vp.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); }));
  vp.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) upload(f);
  });
}

boot();
