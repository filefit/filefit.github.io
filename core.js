// FileFit core: all processing happens locally in the browser.
// pdf-lib is loaded as a classic script (window.PDFLib); pdf.js is an ES module.
import * as pdfjs from "./pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;
const { PDFDocument, degrees } = window.PDFLib;

export const KB = 1024;

// Portals disagree on whether 1 KB is 1000 or 1024 bytes. Use the stricter meaning on each side:
// a maximum of N KB -> N*1000 bytes, a minimum of N KB -> N*1024 bytes. The result passes either check.
export const maxBytesFor = (kb) => Math.floor(kb * 1000);
export const minBytesFor = (kb) => Math.ceil(kb * 1024);

/**
 * Grow a JPEG to at least `target` bytes by adding comment (COM) segments right after the
 * start-of-image marker. Pixels are untouched; every JPEG reader skips comments.
 */
export async function padJpeg(blob, target) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Not a JPEG.");
  let need = target - bytes.length;
  if (need <= 0) return blob;
  const parts = [bytes.subarray(0, 2)];
  while (need > 0) {
    const payload = Math.max(1, Math.min(65533, need - 4));
    const seg = new Uint8Array(4 + payload);
    seg[0] = 0xff; seg[1] = 0xfe;
    seg[2] = ((payload + 2) >> 8) & 0xff; seg[3] = (payload + 2) & 0xff;
    seg.fill(0x20, 4);                       // spaces
    parts.push(seg);
    need -= seg.length;
  }
  parts.push(bytes.subarray(2));
  return new Blob(parts, { type: "image/jpeg" });
}

// ------------------------------------------------------------------ helpers
export function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
}

export function baseName(name) {
  return (name || "file").replace(/\.[^.]+$/, "");
}

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode image."))), type, quality));
}

export async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This file is not an image the browser can read (try JPG, PNG or WebP).");
  }
}

/** Draw `src` into a w×h canvas. fit: "cover" crops to fill, "contain" pads, "stretch" distorts. */
function draw(src, w, h, { fit = "cover", background = "#ffffff", grayscale = false } = {}) {
  const c = canvasOf(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  if (grayscale) ctx.filter = "grayscale(1)";
  const sw = src.width, sh = src.height;
  if (fit === "stretch") {
    ctx.drawImage(src, 0, 0, c.width, c.height);
  } else {
    const s = fit === "cover" ? Math.max(c.width / sw, c.height / sh) : Math.min(c.width / sw, c.height / sh);
    const dw = sw * s, dh = sh * s;
    ctx.drawImage(src, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
  }
  return c;
}

/** Largest quality in [lo, hi] whose encoding is <= maxBytes (binary search). */
async function bestQuality(encode, maxBytes, lo = 0.05, hi = 0.95, steps = 7) {
  let best = null;
  const top = await encode(hi);
  if (top.size <= maxBytes) return { blob: top, quality: hi };
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    const b = await encode(mid);
    if (b.size <= maxBytes) { best = { blob: b, quality: mid }; lo = mid; } else { hi = mid; }
  }
  if (!best) {
    const b = await encode(lo);
    if (b.size <= maxBytes) best = { blob: b, quality: lo };
  }
  return best;
}

// ------------------------------------------------------------------ images
/**
 * Fit an image into a size window.
 * opts: maxKB (required), minKB, width, height (exact pixels; omit to keep proportions),
 *       fit ("cover" | "contain" | "stretch"), format ("image/jpeg" | "image/webp"), grayscale
 * Returns { blob, width, height, quality, notes[] }.
 */
export async function fitImage(blob, opts) {
  const maxBytes = maxBytesFor(opts.maxKB);
  const minBytes = opts.minKB ? minBytesFor(opts.minKB) : 0;
  const type = opts.format || "image/jpeg";
  const img = await decodeImage(blob);
  const fixed = opts.width > 0 && opts.height > 0;
  const notes = [];
  let w, h;
  if (fixed) { w = opts.width; h = opts.height; }
  else if (opts.width > 0) { w = opts.width; h = img.height * (opts.width / img.width); }
  else if (opts.height > 0) { h = opts.height; w = img.width * (opts.height / img.height); }
  else { w = img.width; h = img.height; }

  const render = (W, H) => draw(img, W, H, { fit: opts.fit || "cover", grayscale: opts.grayscale });
  let scale = 1, result = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    const c = render(w * scale, h * scale);
    const r = await bestQuality((q) => toBlob(c, type, q), maxBytes);
    if (r) { result = { ...r, width: c.width, height: c.height }; break; }
    if (fixed) break;                     // exact pixels requested: cannot shrink further
    scale *= 0.85;
    if (w * scale < 16 || h * scale < 16) break;
  }
  if (!result) {
    throw new Error(fixed
      ? `Even at the lowest quality a ${w}×${h} image is larger than ${opts.maxKB} KB. Use smaller pixel dimensions or a bigger KB limit.`
      : `Could not get this image under ${opts.maxKB} KB.`);
  }
  if (scale < 1) notes.push(`Reduced to ${result.width}×${result.height} px to meet the size limit.`);

  // Below the minimum? Use the best quality first, then pad the file (pixels unchanged).
  if (minBytes && result.blob.size < minBytes) {
    const c = render(result.width, result.height);
    const b = await toBlob(c, type, 0.98);
    if (b.size <= maxBytes && b.size > result.blob.size) result = { ...result, blob: b, quality: 0.98 };
    if (result.blob.size < minBytes && type === "image/jpeg") {
      const target = Math.min(maxBytes, minBytes + 512);
      result = { ...result, blob: await padJpeg(result.blob, target) };
      notes.push(`Raised to ${(result.blob.size / KB).toFixed(1)} KB to meet the ${opts.minKB} KB minimum (the picture itself is unchanged).`);
    }
    if (result.blob.size < minBytes) {
      notes.push(`Could not reach the ${opts.minKB} KB minimum; the file is ${(result.blob.size / KB).toFixed(1)} KB.`);
    }
  }
  img.close?.();
  return { ...result, notes };
}

export function mmToPx(mm, dpi) {
  return Math.round((mm / 25.4) * dpi);
}

// ------------------------------------------------------------------ PDFs
async function loadPdfLib(bytes) {
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (e) {
    if (/encrypt/i.test(String(e))) throw new Error("This PDF is password-protected. Remove the password first.");
    throw new Error("This PDF could not be read. It may be damaged.");
  }
}

function pdfBlob(bytes) {
  return new Blob([bytes], { type: "application/pdf" });
}

export async function pageCount(blob) {
  const doc = await loadPdfLib(await blob.arrayBuffer());
  return doc.getPageCount();
}

/** "1-3, 5, 8-" -> zero-based indices (in order, duplicates removed). */
export function parseRanges(text, count) {
  const out = [];
  const seen = new Set();
  const parts = String(text || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Enter page numbers, e.g. 1-3, 5");
  for (const p of parts) {
    const m = p.match(/^(\d*)\s*(?:-\s*(\d*))?$/);
    if (!m || (m[1] === "" && m[2] === undefined)) throw new Error(`"${p}" is not a page range.`);
    const a = m[1] === "" ? 1 : parseInt(m[1], 10);
    const b = m[2] === undefined ? a : m[2] === "" ? count : parseInt(m[2], 10);
    if (a < 1 || b > count || a > b) throw new Error(`Pages "${p}" are outside 1–${count}.`);
    for (let i = a; i <= b; i++) if (!seen.has(i)) { seen.add(i); out.push(i - 1); }
  }
  return out;
}

export async function mergePdfs(blobs) {
  const out = await PDFDocument.create();
  for (const b of blobs) {
    const src = await loadPdfLib(await b.arrayBuffer());
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return pdfBlob(await out.save({ useObjectStreams: true }));
}

export async function extractPages(blob, indices) {
  const src = await loadPdfLib(await blob.arrayBuffer());
  const out = await PDFDocument.create();
  (await out.copyPages(src, indices)).forEach((p) => out.addPage(p));
  return pdfBlob(await out.save({ useObjectStreams: true }));
}

export async function removePages(blob, indices) {
  const src = await loadPdfLib(await blob.arrayBuffer());
  const drop = new Set(indices);
  const keep = src.getPageIndices().filter((i) => !drop.has(i));
  if (!keep.length) throw new Error("That would remove every page.");
  return extractPages(blob, keep);
}

/** One PDF per page (or per chunk of `every` pages). */
export async function splitPdf(blob, every = 1) {
  const src = await loadPdfLib(await blob.arrayBuffer());
  const n = src.getPageCount();
  const parts = [];
  for (let i = 0; i < n; i += every) {
    const idx = [];
    for (let j = i; j < Math.min(n, i + every); j++) idx.push(j);
    parts.push({ from: i + 1, to: idx[idx.length - 1] + 1, blob: await extractPages(blob, idx) });
  }
  return parts;
}

export async function rotatePdf(blob, indices, angle) {
  const doc = await loadPdfLib(await blob.arrayBuffer());
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees((((p.getRotation().angle + angle) % 360) + 360) % 360));
  }
  return pdfBlob(await doc.save({ useObjectStreams: true }));
}

const A4 = [595.28, 841.89];

/** Images -> one PDF. pageSize: "fit" (page = image) or "a4" (image centred with margins). */
export async function imagesToPdf(blobs, { pageSize = "a4", margin = 24, quality = 0.9 } = {}) {
  const doc = await PDFDocument.create();
  for (const b of blobs) {
    const img = await decodeImage(b);
    const c = draw(img, img.width, img.height, { fit: "stretch" });
    const jpg = await doc.embedJpg(await (await toBlob(c, "image/jpeg", quality)).arrayBuffer());
    img.close?.();
    if (pageSize === "fit") {
      const s = 72 / 150; // treat images as 150 dpi
      const page = doc.addPage([jpg.width * s, jpg.height * s]);
      page.drawImage(jpg, { x: 0, y: 0, width: jpg.width * s, height: jpg.height * s });
    } else {
      const landscape = jpg.width > jpg.height;
      const [W, H] = landscape ? [A4[1], A4[0]] : A4;
      const s = Math.min((W - 2 * margin) / jpg.width, (H - 2 * margin) / jpg.height);
      const page = doc.addPage([W, H]);
      page.drawImage(jpg, { x: (W - jpg.width * s) / 2, y: (H - jpg.height * s) / 2, width: jpg.width * s, height: jpg.height * s });
    }
  }
  return pdfBlob(await doc.save({ useObjectStreams: true }));
}

async function openPdfJs(blob) {
  try {
    return await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  } catch (e) {
    if (e && e.name === "PasswordException") throw new Error("This PDF is password-protected. Remove the password first.");
    throw new Error("This PDF could not be read. It may be damaged.");
  }
}

async function renderPage(pdf, pageNo, dpi, grayscale) {
  const page = await pdf.getPage(pageNo);
  const vp = page.getViewport({ scale: dpi / 72 });
  const c = canvasOf(vp.width, vp.height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const base = page.getViewport({ scale: 1 });
  page.cleanup();
  if (grayscale) {
    const g = canvasOf(c.width, c.height);
    const gctx = g.getContext("2d");
    gctx.filter = "grayscale(1)";
    gctx.drawImage(c, 0, 0);
    return { canvas: g, w: base.width, h: base.height };
  }
  return { canvas: c, w: base.width, h: base.height };
}

/** PDF -> images, one per page. */
export async function pdfToImages(blob, { dpi = 150, format = "image/jpeg", quality = 0.9, onProgress } = {}) {
  const pdf = await openPdfJs(blob);
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(`Rendering page ${i} of ${pdf.numPages}`);
    const { canvas } = await renderPage(pdf, i, dpi, false);
    out.push({ page: i, blob: await toBlob(canvas, format, quality) });
  }
  await pdf.destroy();
  return out;
}

async function buildRasterPdf(jpegs, sizes) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < jpegs.length; i++) {
    const img = await doc.embedJpg(await jpegs[i].arrayBuffer());
    const [w, h] = sizes[i];
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return pdfBlob(await doc.save({ useObjectStreams: true }));
}

/**
 * Compress a PDF to <= maxKB.
 * 1. Lossless re-save (keeps text). 2. If still too big, render pages to JPEG at decreasing
 *    resolution, binary-searching quality. The result looks the same but text is no longer selectable.
 * Returns { blob, method: "lossless" | "raster", dpi, quality, notes[] }.
 */
export async function compressPdf(blob, { maxKB, grayscale = false, onProgress } = {}) {
  const maxBytes = maxBytesFor(maxKB);
  const notes = [];
  onProgress?.("Trying lossless compression");
  const doc = await loadPdfLib(await blob.arrayBuffer());
  const lossless = pdfBlob(await doc.save({ useObjectStreams: true }));
  const smallest = lossless.size < blob.size ? lossless : blob;
  if (smallest.size <= maxBytes && !grayscale) {
    return { blob: smallest, method: "lossless", notes: ["Text and quality kept exactly; only the file structure was optimised."] };
  }

  const pdf = await openPdfJs(blob);
  const n = pdf.numPages;
  const overhead = 1200 + 700 * n;   // PDF structure bytes on top of the JPEGs (measured, slightly generous)
  let best = null;
  for (const dpi of [200, 150, 120, 100, 85, 72, 60, 50, 40]) {
    const pages = [];
    for (let i = 1; i <= n; i++) {
      onProgress?.(`Rendering page ${i} of ${n} at ${dpi} dpi`);
      pages.push(await renderPage(pdf, i, dpi, grayscale));
    }
    const sizes = pages.map((p) => [p.w, p.h]);
    const encodeAll = async (q) => {
      const jpgs = [];
      for (const p of pages) jpgs.push(await toBlob(p.canvas, "image/jpeg", q));
      return jpgs;
    };
    // Binary search the quality on the summed JPEG size, then build and verify.
    let lo = 0.1, hi = 0.85, pick = null;
    for (let step = 0; step < 6; step++) {
      const q = step === 0 ? hi : (lo + hi) / 2;
      onProgress?.(`Fitting to ${maxKB} KB (${dpi} dpi, quality ${Math.round(q * 100)})`);
      const jpgs = await encodeAll(q);
      const total = jpgs.reduce((s, b) => s + b.size, 0) + overhead;
      if (total <= maxBytes) { pick = { q, jpgs }; if (step === 0) break; lo = q; } else { hi = q; }
    }
    if (!pick) {
      const jpgs = await encodeAll(0.1);
      if (jpgs.reduce((s, b) => s + b.size, 0) + overhead <= maxBytes) pick = { q: 0.1, jpgs };
    }
    if (pick) {
      const out = await buildRasterPdf(pick.jpgs, sizes);
      if (out.size <= maxBytes) { best = { blob: out, dpi, quality: pick.q }; break; }
    }
  }
  await pdf.destroy();
  if (!best) {
    throw new Error(`Could not get this ${n}-page PDF under ${maxKB} KB while keeping it readable. Try a bigger limit, black & white, or split it into parts.`);
  }
  notes.push(`Pages were converted to images at ${best.dpi} dpi. It looks the same, but text can no longer be selected or searched.`);
  if (best.dpi <= 72) notes.push("Low resolution was needed: zoom in and check small print is still readable.");
  return { ...best, method: "raster", notes };
}

// ------------------------------------------------------------------ Pro: sign & fill
/**
 * Turn a photographed/scanned signature into a transparent PNG: near-white pixels become
 * transparent, ink is darkened, and the result is cropped to the ink.
 */
export async function signaturePng(blob, { threshold = 0.75 } = {}) {
  const img = await decodeImage(blob);
  const maxSide = 1200;
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = canvasOf(img.width * s, img.height * s);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, c.width, c.height);
  img.close?.();
  return inkToPng(c, threshold);
}

/** Canvas with dark ink on a light (or transparent) background -> cropped transparent PNG blob. */
export async function inkToPng(canvas, threshold = 0.75) {
  const ctx = canvas.getContext("2d");
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = d.data;
  let x0 = canvas.width, y0 = canvas.height, x1 = -1, y1 = -1;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    const lum = a === 0 ? 1 : (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
    const ink = a * Math.max(0, Math.min(1, (threshold - lum) / threshold * 2.2));
    if (ink < 0.04) { px[i + 3] = 0; continue; }
    px[i] = px[i] * 0.5; px[i + 1] = px[i + 1] * 0.5; px[i + 2] = px[i + 2] * 0.5;   // darken ink
    px[i + 3] = Math.round(255 * Math.min(1, ink));
    const p = i / 4, x = p % canvas.width, y = (p / canvas.width) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error("No signature found in that image. Use dark ink on light paper.");
  ctx.putImageData(d, 0, 0);
  const pad = 4;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(canvas.width - 1, x1 + pad); y1 = Math.min(canvas.height - 1, y1 + pad);
  const out = canvasOf(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { blob: await toBlob(out, "image/png"), width: out.width, height: out.height };
}

/** Render one page for on-screen placement. Returns { canvas, pageWidth, pageHeight (PDF points), pages }. */
export async function previewPage(blob, pageNo, cssWidth) {
  const pdf = await openPdfJs(blob);
  const page = await pdf.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const ratio = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: (cssWidth / base.width) * ratio });
  const c = canvasOf(vp.width, vp.height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const pages = pdf.numPages;
  await pdf.destroy();
  return { canvas: c, pageWidth: base.width, pageHeight: base.height, rotation: base.rotation, pages };
}

/**
 * Stamp signatures / text onto a PDF.
 * items: [{ page (1-based), kind: "image" | "text", fx, fy (0..1 from the top-left of the page as shown),
 *           fw (image width as fraction of page width), png (Blob), text, size (pt) }]
 */
export async function stampPdf(blob, items) {
  const doc = await loadPdfLib(await blob.arrayBuffer());
  const font = await doc.embedFont(window.PDFLib.StandardFonts.Helvetica);
  const cache = new Map();
  for (const it of items) {
    const page = doc.getPage(it.page - 1);
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    if (rot !== 0) throw new Error("Signing rotated pages is not supported yet. Rotate the page back to upright first (Pages tab).");
    const { width: W, height: H } = page.getSize();
    if (it.kind === "image") {
      if (!cache.has(it.png)) cache.set(it.png, await doc.embedPng(await it.png.arrayBuffer()));
      const img = cache.get(it.png);
      const w = it.fw * W, h = w * (img.height / img.width);
      page.drawImage(img, { x: it.fx * W - w / 2, y: H - it.fy * H - h / 2, width: w, height: h });
    } else {
      const size = it.size || 12;
      const text = String(it.text || "");
      const tw = font.widthOfTextAtSize(text, size);
      page.drawText(text, { x: it.fx * W - tw / 2, y: H - it.fy * H - size * 0.35, size, font, color: window.PDFLib.rgb(0, 0, 0) });
    }
  }
  return pdfBlob(await doc.save({ useObjectStreams: true }));
}

/** Fillable form fields in a PDF: [{ name, type: "text" | "checkbox" | "dropdown" | "radio", value, options }] */
export async function formFields(blob) {
  const doc = await loadPdfLib(await blob.arrayBuffer());
  const P = window.PDFLib;
  const out = [];
  for (const f of doc.getForm().getFields()) {
    const name = f.getName();
    if (f instanceof P.PDFTextField) out.push({ name, type: "text", value: f.getText() || "" });
    else if (f instanceof P.PDFCheckBox) out.push({ name, type: "checkbox", value: f.isChecked() });
    else if (f instanceof P.PDFDropdown) out.push({ name, type: "dropdown", value: (f.getSelected() || [])[0] || "", options: f.getOptions() });
    else if (f instanceof P.PDFRadioGroup) out.push({ name, type: "radio", value: f.getSelected() || "", options: f.getOptions() });
  }
  return out;
}

export async function fillForm(blob, values, { flatten = false } = {}) {
  const doc = await loadPdfLib(await blob.arrayBuffer());
  const P = window.PDFLib;
  const form = doc.getForm();
  for (const [name, v] of Object.entries(values)) {
    const f = form.getField(name);
    if (f instanceof P.PDFTextField) f.setText(String(v));
    else if (f instanceof P.PDFCheckBox) (v ? f.check() : f.uncheck());
    else if (f instanceof P.PDFDropdown && v) f.select(String(v));
    else if (f instanceof P.PDFRadioGroup && v) f.select(String(v));
  }
  if (flatten) form.flatten();
  return pdfBlob(await doc.save({ useObjectStreams: true }));
}
