import * as core from "./core.js";
import * as licence from "./license.js";
import { CONFIG } from "./config.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
// size / photo hold a list (batch with Pro); pages / sign / sig hold one file; merge / convert accumulate.
const state = { size: [], photo: [], pages: null, sign: null, sig: null, merge: [], convert: [] };
const SINGLE_LIST = new Set(["size", "photo"]);   // a new drop replaces the selection
let urls = [];
let pro = { active: false };

// ------------------------------------------------------------------ formatting
function fmtSize(bytes) {
  return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function extFor(type) {
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[type] || "bin";
}

// ------------------------------------------------------------------ tabs
function showTab(name) {
  $$("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$("section[data-panel]").forEach((s) => (s.hidden = s.dataset.panel !== name));
  clearOutput();
  try { localStorage.setItem("filefit.tab", name); } catch {}
  if (name === "pro") renderPro();
}
$$("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ------------------------------------------------------------------ status / results
function setStatus(msg, isError = false) {
  const el = $("#status");
  el.hidden = !msg;
  el.textContent = msg || "";
  el.classList.toggle("error", isError);
}

function clearOutput() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  $("#results").hidden = true;
  $("#results").innerHTML = "";
  setStatus("");
}

/** items: [{ blob, name, detail, error }]; notes: string[] */
function showResults(title, items, notes = []) {
  const box = $("#results");
  box.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = title;
  box.append(h);
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "result";
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("b");
    name.textContent = it.name;
    meta.append(name);
    if (it.error) {
      const err = document.createElement("span");
      err.className = "err";
      err.textContent = it.error;
      meta.append(err);
      row.append(meta);
      box.append(row);
      continue;
    }
    const url = URL.createObjectURL(it.blob);
    urls.push(url);
    if (it.blob.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "Preview";
      row.append(img);
    }
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = fmtSize(it.blob.size);
    meta.append(size);
    if (it.detail) meta.append(document.createTextNode(" · " + it.detail));
    const a = document.createElement("a");
    a.className = "dl";
    a.href = url;
    a.download = it.name;
    a.textContent = "Download";
    row.append(meta, a);
    box.append(row);
  }
  if (notes.length) {
    const ul = document.createElement("ul");
    ul.className = "notes";
    [...new Set(notes)].forEach((n) => { const li = document.createElement("li"); li.textContent = n; ul.append(li); });
    box.append(ul);
  }
  box.hidden = false;
  setStatus("");
}

class ProRequired extends Error {}

async function run(button, fn) {
  clearOutput();
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ProRequired) {
      setStatus(e.message + " Open the Go Pro tab to unlock it.", true);
    } else {
      console.error(e);
      setStatus(e && e.message ? e.message : "Something went wrong.", true);
    }
  } finally {
    button.disabled = false;
  }
}

function requirePro(what) {
  if (!pro.active) throw new ProRequired(`${what} is a Pro feature.`);
}

// ------------------------------------------------------------------ file inputs
function renderList(key) {
  const ol = $("#" + key + "-list");
  ol.innerHTML = "";
  state[key].forEach((f, i) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = `${f.name} (${fmtSize(f.size)})`;
    const up = Object.assign(document.createElement("button"), { textContent: "↑", title: "Move up" });
    const down = Object.assign(document.createElement("button"), { textContent: "↓", title: "Move down" });
    const del = Object.assign(document.createElement("button"), { textContent: "✕", title: "Remove" });
    up.onclick = () => { if (i > 0) { [state[key][i - 1], state[key][i]] = [state[key][i], state[key][i - 1]]; renderList(key); } };
    down.onclick = () => { if (i < state[key].length - 1) { [state[key][i + 1], state[key][i]] = [state[key][i], state[key][i + 1]]; renderList(key); } };
    del.onclick = () => { state[key].splice(i, 1); renderList(key); };
    li.append(span, up, down, del);
    ol.append(li);
  });
}

const onPicked = {};

function accept(key, files) {
  files = [...files];
  if (!files.length) return;
  const picked = document.querySelector(`[data-for="${key}-file"] .picked`);
  if (SINGLE_LIST.has(key)) {
    state[key] = files;
    if (picked) picked.textContent = files.length === 1
      ? `${files[0].name} (${fmtSize(files[0].size)})`
      : `${files.length} files: ` + files.map((f) => f.name).join(", ");
  } else if (Array.isArray(state[key])) {
    state[key].push(...files);
    renderList(key);
  } else {
    state[key] = files[0];
    if (picked) picked.textContent = `${files[0].name} (${fmtSize(files[0].size)})`;
  }
  clearOutput();
  onPicked[key]?.(files[0]);
}

$$(".drop").forEach((zone) => {
  const input = zone.querySelector("input");
  const key = zone.dataset.for.replace(/-files?$/, "");
  input.addEventListener("change", () => { accept(key, input.files); input.value = ""; });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); accept(key, e.dataTransfer.files); });
});

$$(".chips button").forEach((b) => b.addEventListener("click", () => { $("#" + b.parentElement.dataset.target).value = b.dataset.v; }));

function need(file, what = "a file") {
  if (!file || (Array.isArray(file) && !file.length)) throw new Error(`Choose ${what} first.`);
  return file;
}

function num(id) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : 0;
}

/** Process a list of files one by one; one failure does not stop the batch. */
async function batch(files, label, fn) {
  const items = [], notes = [];
  for (let i = 0; i < files.length; i++) {
    if (files.length > 1) setStatus(`${label} ${i + 1} of ${files.length}: ${files[i].name}…`);
    try {
      const r = await fn(files[i]);
      items.push(r.item);
      notes.push(...(r.notes || []));
    } catch (e) {
      if (files.length === 1) throw e;
      items.push({ name: files[i].name, error: e.message });
    }
  }
  return { items, notes };
}

// ------------------------------------------------------------------ compress to size
$("#size-go").addEventListener("click", (e) => run(e.target, async () => {
  const files = need(state.size);
  if (files.length > 1) requirePro("Compressing several files at once");
  const maxKB = num("#size-max"), minKB = num("#size-min");
  if (maxKB <= 0) throw new Error("Enter a maximum size in KB.");
  if (minKB && minKB >= maxKB) throw new Error("Minimum must be smaller than maximum.");
  const gray = $("#size-gray").checked;
  const { items, notes } = await batch(files, "Compressing", async (file) => {
    if (core.isPdf(file)) {
      const r = await core.compressPdf(file, { maxKB, grayscale: gray, onProgress: files.length === 1 ? (m) => setStatus(m + "…") : null });
      const n = [...r.notes];
      if (minKB && r.blob.size < minKB * 1024) n.push(`Below your ${minKB} KB minimum. Most forms accept smaller files; check yours.`);
      return { item: { blob: r.blob, name: core.baseName(file.name) + "_" + Math.round(maxKB) + "KB.pdf", detail: `was ${fmtSize(file.size)}` }, notes: n };
    }
    if (files.length === 1) setStatus("Compressing…");
    const r = await core.fitImage(file, { maxKB, minKB, grayscale: gray });
    return { item: { blob: r.blob, name: core.baseName(file.name) + "_" + Math.round(maxKB) + "KB.jpg", detail: `${r.width}×${r.height} px, was ${fmtSize(file.size)}` }, notes: r.notes };
  });
  const ok = items.filter((i) => !i.error);
  showResults(files.length === 1 ? `Done: ${fmtSize(files[0].size)} → ${fmtSize(ok[0].blob.size)}` : `Done: ${ok.length} of ${files.length} files`, items, notes);
}));

// ------------------------------------------------------------------ photo & signature
const PRESETS = {
  passport: { w: core.mmToPx(35, 300), h: core.mmToPx(45, 300), min: "", max: 250, fit: "cover" },
  photo: { w: 200, h: 230, min: 20, max: 50, fit: "cover" },
  sign: { w: 140, h: 60, min: 10, max: 20, fit: "contain" },
  square: { w: 600, h: 600, min: "", max: 100, fit: "cover" },
};
function applyPreset() {
  const p = PRESETS[$("#photo-preset").value];
  if (!p) return;
  $("#photo-w").value = p.w; $("#photo-h").value = p.h;
  $("#photo-min").value = p.min; $("#photo-max").value = p.max;
  $("#photo-fit").value = p.fit;
}
$("#photo-preset").addEventListener("change", applyPreset);
["#photo-w", "#photo-h", "#photo-min", "#photo-max"].forEach((id) =>
  $(id).addEventListener("input", () => { $("#photo-preset").value = "custom"; }));
applyPreset();

$("#photo-go").addEventListener("click", (e) => run(e.target, async () => {
  const files = need(state.photo, "a photo");
  if (files.length > 1) requirePro("Resizing several photos at once");
  const w = Math.round(num("#photo-w")), h = Math.round(num("#photo-h"));
  const minKB = num("#photo-min"), maxKB = num("#photo-max");
  if (w < 16 || h < 16) throw new Error("Enter width and height in pixels.");
  if (maxKB <= 0) throw new Error("Enter a maximum size in KB.");
  if (minKB && minKB >= maxKB) throw new Error("Minimum must be smaller than maximum.");
  setStatus("Resizing…");
  const { items, notes } = await batch(files, "Resizing", async (file) => {
    const r = await core.fitImage(file, { width: w, height: h, minKB, maxKB, fit: $("#photo-fit").value, grayscale: $("#photo-gray").checked });
    return { item: { blob: r.blob, name: `${core.baseName(file.name)}_${r.width}x${r.height}.jpg`, detail: `${r.width}×${r.height} px` }, notes: r.notes };
  });
  const ok = items.filter((i) => !i.error);
  showResults(files.length === 1 ? `Ready: ${ok[0].name.match(/\d+x\d+/)[0].replace("x", "×")} px, ${fmtSize(ok[0].blob.size)}` : `Ready: ${ok.length} of ${files.length} photos`, items, notes);
}));

// ------------------------------------------------------------------ merge
$("#merge-go").addEventListener("click", (e) => run(e.target, async () => {
  if (state.merge.length < 2) throw new Error("Add at least two files to merge.");
  setStatus("Merging…");
  const pdfs = [];
  for (const f of state.merge) pdfs.push(core.isPdf(f) ? f : await core.imagesToPdf([f]));
  const out = await core.mergePdfs(pdfs);
  showResults("Merged", [{ blob: out, name: "merged.pdf", detail: `${state.merge.length} files` }]);
}));

// ------------------------------------------------------------------ pages
$("#pages-go").addEventListener("click", (e) => run(e.target, async () => {
  const file = need(state.pages, "a PDF");
  if (!core.isPdf(file)) throw new Error("Choose a PDF file.");
  const action = $("#pages-action").value;
  const base = core.baseName(file.name);
  setStatus("Working…");
  if (action === "split") {
    const parts = await core.splitPdf(file, 1);
    showResults(`Split into ${parts.length} files`, parts.map((p) => ({ blob: p.blob, name: `${base}_page${p.from}.pdf` })));
    return;
  }
  const n = await core.pageCount(file);
  const idx = core.parseRanges($("#pages-range").value, n);
  let out, label;
  if (action === "extract") { out = await core.extractPages(file, idx); label = `Kept ${idx.length} of ${n} pages`; }
  else if (action === "remove") { out = await core.removePages(file, idx); label = `Deleted ${idx.length} of ${n} pages`; }
  else {
    const angle = { rotate: 90, rotate180: 180, rotateL: -90 }[action];
    out = await core.rotatePdf(file, idx, angle);
    label = `Rotated ${idx.length} page${idx.length > 1 ? "s" : ""}`;
  }
  showResults(label, [{ blob: out, name: `${base}_edited.pdf` }]);
}));

// ------------------------------------------------------------------ convert
$("#convert-go").addEventListener("click", (e) => run(e.target, async () => {
  const files = state.convert;
  if (!files.length) throw new Error("Add files first.");
  const pdfs = files.filter(core.isPdf), imgs = files.filter((f) => !core.isPdf(f));
  if (pdfs.length && imgs.length) throw new Error("Convert either images (to a PDF) or PDFs (to images), not both at once.");
  if (imgs.length) {
    setStatus("Building PDF…");
    const out = await core.imagesToPdf(imgs, { pageSize: $("#convert-page").value });
    showResults("PDF ready", [{ blob: out, name: imgs.length === 1 ? core.baseName(imgs[0].name) + ".pdf" : "images.pdf", detail: `${imgs.length} page${imgs.length > 1 ? "s" : ""}` }]);
  } else {
    const format = $("#convert-format").value;
    const items = [];
    for (const f of pdfs) {
      const pages = await core.pdfToImages(f, { format, onProgress: (m) => setStatus(`${f.name}: ${m}…`) });
      pages.forEach((p) => items.push({ blob: p.blob, name: `${core.baseName(f.name)}_page${p.page}.${extFor(format)}` }));
    }
    showResults(`${items.length} image${items.length > 1 ? "s" : ""} ready`, items);
  }
}));

// ------------------------------------------------------------------ sign & fill (Pro)
const sign = { placed: [], png: null, pngUrl: null, page: 1, fields: [] };

async function drawSignPreview() {
  const file = state.sign;
  if (!file) return;
  const width = Math.min(760, $("#sign-work").clientWidth || 760);
  const r = await core.previewPage(file, sign.page, width);
  const cv = $("#sign-preview");
  cv.width = r.canvas.width;
  cv.height = r.canvas.height;
  cv.style.width = width + "px";
  cv.getContext("2d").drawImage(r.canvas, 0, 0);
  sign.pageWidth = r.pageWidth;
  if ($("#sign-page").options.length !== r.pages) {
    $("#sign-page").innerHTML = "";
    for (let i = 1; i <= r.pages; i++) $("#sign-page").append(new Option(`Page ${i} of ${r.pages}`, i));
  }
  $("#sign-page").value = String(sign.page);
  renderPlaced();
}

function renderPlaced() {
  const ov = $("#sign-overlay");
  ov.innerHTML = "";
  const W = $("#sign-preview").clientWidth;
  sign.placed.forEach((it, i) => {
    if (it.page !== sign.page) return;
    const el = document.createElement("div");
    el.className = "placed";
    el.style.left = it.fx * 100 + "%";
    el.style.top = it.fy * 100 + "%";
    if (it.kind === "image") {
      el.style.width = it.fw * 100 + "%";
      const img = document.createElement("img");
      img.src = it.url;
      img.alt = "Signature";
      el.append(img);
    } else {
      el.textContent = it.text;
      el.style.fontSize = (it.size * W / it.pageWidth) + "px";
      el.style.fontFamily = "Helvetica, Arial, sans-serif";
    }
    el.title = "Click to remove";
    el.addEventListener("click", (ev) => { ev.stopPropagation(); sign.placed.splice(i, 1); renderPlaced(); });
    ov.append(el);
  });
}

onPicked.sign = async (file) => {
  if (!core.isPdf(file)) { setStatus("Choose a PDF file.", true); return; }
  sign.placed = []; sign.page = 1;
  $("#sign-work").hidden = false;
  try {
    await drawSignPreview();
    sign.fields = await core.formFields(file);
    const list = $("#sign-field-list");
    list.innerHTML = "";
    $("#sign-fields").hidden = !sign.fields.length;
    sign.fields.forEach((f, i) => {
      const label = document.createElement("label");
      label.textContent = f.name;
      let input;
      if (f.type === "checkbox") {
        input = Object.assign(document.createElement("input"), { type: "checkbox", checked: f.value });
        label.className = "check";
        label.prepend(input);
      } else if (f.type === "dropdown" || f.type === "radio") {
        input = document.createElement("select");
        input.append(new Option("—", ""));
        f.options.forEach((o) => input.append(new Option(o, o, false, o === f.value)));
        label.append(input);
      } else {
        input = Object.assign(document.createElement("input"), { type: "text", value: f.value });
        label.append(input);
      }
      input.dataset.field = String(i);
      list.append(label);
    });
  } catch (e) {
    setStatus(e.message, true);
  }
};

$("#sign-page").addEventListener("change", () => { sign.page = parseInt($("#sign-page").value, 10); drawSignPreview(); });

async function setSignature(blob) {
  const r = await core.signaturePng(blob);
  if (sign.pngUrl) URL.revokeObjectURL(sign.pngUrl);
  sign.png = r.blob;
  sign.pngUrl = URL.createObjectURL(r.blob);
  $("#sign-kind").value = "image";
  setStatus("Signature ready. Click on the page to place it.");
}
onPicked.sig = (file) => setSignature(file).catch((e) => setStatus(e.message, true));

// drawing pad
const pad = $("#sig-pad"), pctx = pad.getContext("2d");
function clearPad() { pctx.fillStyle = "#fff"; pctx.fillRect(0, 0, pad.width, pad.height); }
clearPad();
let drawing = false;
const padPos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
pad.addEventListener("pointerdown", (e) => { drawing = true; pad.setPointerCapture(e.pointerId); pctx.beginPath(); pctx.moveTo(...padPos(e)); });
pad.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  pctx.lineWidth = 4; pctx.lineCap = "round"; pctx.lineJoin = "round"; pctx.strokeStyle = "#101828";
  pctx.lineTo(...padPos(e)); pctx.stroke();
});
pad.addEventListener("pointerup", () => { drawing = false; });
$("#sig-clear").addEventListener("click", clearPad);
$("#sig-use").addEventListener("click", async () => {
  try {
    const copy = document.createElement("canvas");
    copy.width = pad.width; copy.height = pad.height;
    copy.getContext("2d").drawImage(pad, 0, 0);
    const r = await core.inkToPng(copy);
    if (sign.pngUrl) URL.revokeObjectURL(sign.pngUrl);
    sign.png = r.blob; sign.pngUrl = URL.createObjectURL(r.blob);
    $("#sign-kind").value = "image";
    setStatus("Signature ready. Click on the page to place it.");
  } catch (e) { setStatus("Draw your signature in the white box first.", true); }
});

$("#sign-preview").parentElement.addEventListener("click", (e) => {
  if (!state.sign) return;
  const r = $("#sign-preview").getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
  const kind = $("#sign-kind").value;
  if (kind === "image") {
    if (!sign.png) { setStatus("Upload or draw a signature first.", true); return; }
    sign.placed.push({ page: sign.page, kind: "image", fx, fy, fw: Math.max(0.05, Math.min(0.9, num("#sign-width") / 100)), png: sign.png, url: sign.pngUrl });
  } else {
    const text = kind === "date" ? new Date().toLocaleDateString("en-GB") : $("#sign-text").value.trim();
    if (!text) { setStatus("Type the text to place first.", true); return; }
    sign.placed.push({ page: sign.page, kind: "text", fx, fy, text, size: 12, pageWidth: sign.pageWidth });
  }
  setStatus("");
  renderPlaced();
});

$("#sign-go").addEventListener("click", (e) => run(e.target, async () => {
  const file = need(state.sign, "a PDF");
  requirePro("Signing and filling PDFs");
  let out = file;
  if (sign.fields.length) {
    const values = {};
    $$("#sign-field-list [data-field]").forEach((el) => {
      const f = sign.fields[+el.dataset.field];
      values[f.name] = el.type === "checkbox" ? el.checked : el.value;
    });
    out = await core.fillForm(out, values, { flatten: $("#sign-flatten").checked });
  }
  if (!sign.placed.length && !sign.fields.length) throw new Error("Place a signature or some text on the page first.");
  if (sign.placed.length) out = await core.stampPdf(out, sign.placed);
  showResults("Signed PDF ready", [{ blob: out, name: core.baseName(file.name) + "_signed.pdf" }]);
}));

// ------------------------------------------------------------------ Pro tab
function applyPro(lic) {
  pro = lic || { active: false };
  document.body.classList.toggle("pro", !!pro.active);
  $("#pro-tab").textContent = pro.active ? "Pro" : "Go Pro";
}

function renderPro() {
  $("#pro-active").hidden = !pro.active;
  $("#pro-inactive").hidden = !!pro.active;
  if (pro.active) {
    const until = pro.expires ? "until " + new Date(pro.expires * 1000).toLocaleDateString() : "for life";
    $("#pro-details").textContent = `Plan: ${pro.plan || "Pro"} · active ${until} · ${pro.email || ""} · key ${pro.key || ""}`;
  }
  for (const [id, url] of [["#buy-usd", CONFIG.BUY_USD_URL], ["#buy-inr-m", CONFIG.BUY_INR_MONTHLY_URL], ["#buy-inr-y", CONFIG.BUY_INR_YEARLY_URL]]) {
    $(id).hidden = !url;
    if (url) $(id).href = url;
  }
  $("#prices").textContent = [CONFIG.BUY_USD_URL && CONFIG.PRICE_USD, (CONFIG.BUY_INR_MONTHLY_URL || CONFIG.BUY_INR_YEARLY_URL) && CONFIG.PRICE_INR].filter(Boolean).join("  ·  ")
    || "Purchases open soon.";
}

$("#act-go").addEventListener("click", (e) => run(e.target, async () => {
  const key = $("#act-key").value.trim();
  const email = $("#act-email").value.trim(), order = $("#act-order").value.trim();
  if (!key && !(email && order)) throw new Error("Enter your licence key, or your purchase email and order ID.");
  setStatus("Activating…");
  applyPro(await licence.activate(key ? { key } : { email, order }));
  if (!pro.active) throw new Error("This licence is not active.");
  renderPro();
  setStatus("Pro is active on this browser. Thank you!");
}));

$("#pro-deactivate").addEventListener("click", async () => {
  await licence.deactivate();
  applyPro({ active: false });
  renderPro();
  setStatus("Pro removed from this browser. Your key still works elsewhere.");
});

// ------------------------------------------------------------------ right-click "Open in FileFit"
async function loadFromHash() {
  const m = location.hash.match(/^#src=(.+)$/);
  if (!m) return;
  const src = decodeURIComponent(m[1]);
  const bar = $("#fetchbar");
  const name = decodeURIComponent((src.split(/[?#]/)[0].split("/").pop() || "file")) || "file";
  const go = async () => {
    const res = await fetch(src, { credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const pdf = blob.type === "application/pdf" || /\.pdf$/i.test(name);
    const file = new File([blob], pdf && !/\.pdf$/i.test(name) ? name + ".pdf" : name, { type: blob.type || (pdf ? "application/pdf" : "") });
    showTab(pdf ? "size" : "photo");
    accept(pdf ? "size" : "photo", [file]);
    bar.hidden = true;
    history.replaceState(null, "", location.pathname);
  };
  try {
    await go();
  } catch {
    let origin;
    try { origin = new URL(src).origin; } catch { return; }
    if (!(globalThis.chrome && chrome.permissions)) return;
    bar.hidden = false;
    bar.textContent = `FileFit needs your permission to read this file from ${new URL(src).host}. `;
    const btn = Object.assign(document.createElement("button"), { textContent: "Allow and load", className: "primary" });
    btn.onclick = async () => {
      const ok = await chrome.permissions.request({ origins: [origin + "/*"] });
      if (!ok) { bar.textContent = "Permission not given. Save the file and drop it here instead."; return; }
      try { await go(); } catch { bar.textContent = "Could not download the file. Save it and drop it here instead."; }
    };
    bar.append(btn);
  }
}

let startTab = "size";
try { startTab = localStorage.getItem("filefit.tab") || "size"; } catch {}
// Links from guide pages: ?tab=photo&preset=sign  or  ?tab=size&max=200&min=  or  ?tab=photo&w=..&h=..&min=..&max=..
const q = new URLSearchParams(location.search);
if (q.get("tab")) startTab = q.get("tab");
if (!$$("#tabs button").some((b) => b.dataset.tab === startTab)) startTab = "size";
showTab(startTab);
const numParam = (k) => (q.has(k) && /^\d+(\.\d+)?$/.test(q.get(k)) ? q.get(k) : null);
if (startTab === "size") {
  if (numParam("max")) $("#size-max").value = numParam("max");
  if (numParam("min")) $("#size-min").value = numParam("min");
}
if (startTab === "photo") {
  if (q.get("preset") && PRESETS[q.get("preset")]) { $("#photo-preset").value = q.get("preset"); applyPreset(); }
  const custom = { w: "#photo-w", h: "#photo-h", min: "#photo-min", max: "#photo-max" };
  let any = false;
  for (const [k, id] of Object.entries(custom)) if (numParam(k)) { $(id).value = numParam(k); any = true; }
  if (any && !q.get("preset")) $("#photo-preset").value = "custom";
}
loadFromHash();
licence.status().then(applyPro);

// test hook (used by the local test harness only)
window.__filefit = { core, state, accept, licence, applyPro };
