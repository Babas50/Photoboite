/* PhotoBoîte : conversion, retouche et métadonnées d'images, 100 % dans le navigateur. */
import { APP_NAME, APP_VERSION } from './config.js';

// ---------------------------------------------------------------------------
// Outils généraux
// ---------------------------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const piexif = window.piexif;

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Safari iOS refuse les canvas de plus de ~16,7 millions de pixels.
const MAX_PIXELS = isIOS ? 16_000_000 : 120_000_000;

const EXT = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif', bmp: '.bmp', pdf: '.pdf' };
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', pdf: 'application/pdf' };

function toast(msg, { ms = 3500, error = false } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function fmtSize(n) {
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' Ko';
  return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' Mo';
}

const scripts = {};
function loadScript(src) {
  return scripts[src] ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => { delete scripts[src]; rej(new Error('Impossible de charger ' + src)); };
    document.head.appendChild(s);
  });
}
let pdfjsP;
function getPdfjs() {
  return pdfjsP ??= import('../vendor/pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
    return m;
  });
}
const getPdfLib = () => loadScript('vendor/pdf-lib.min.js').then(() => window.PDFLib);
const getHeic = () => loadScript('vendor/heic2any.min.js').then(() => window.heic2any);
const getGifenc = () => import('../vendor/gifenc.esm.js');

const nextFrame = () => new Promise(r => setTimeout(r, 0));

function baseName(name) { return name.replace(/\.[^.]+$/, '') || 'image'; }

function uniqueNamer() {
  const used = new Set();
  return name => {
    let n = name, i = 2;
    const b = baseName(name), e = name.slice(b.length);
    while (used.has(n.toLowerCase())) n = `${b} (${i++})${e}`;
    used.add(n.toLowerCase());
    return n;
  };
}

function fileKind(file) {
  const n = (file.name || '').toLowerCase(), t = file.type || '';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/\.(heic|heif)$/.test(n) || /hei[cf]/.test(t)) return 'heic';
  if (t.startsWith('image/') || /\.(png|jpe?g|jfif|webp|gif|bmp|tiff?|avif|ico|svg)$/.test(n)) return 'image';
  return null;
}
const isJpeg = f => f.type === 'image/jpeg' || /\.(jpe?g|jfif)$/i.test(f.name || '');

// Binaire <-> « chaîne binaire » (format attendu par piexif)
function bufToBin(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return s;
}
function binToU8(s) {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
const ctx2d = c => c.getContext('2d', { willReadFrequently: false });

function capSize(w, h) {
  const px = w * h;
  if (px <= MAX_PIXELS) return { w, h, scaled: false };
  const k = Math.sqrt(MAX_PIXELS / px);
  return { w: Math.floor(w * k), h: Math.floor(h * k), scaled: true };
}

function blobToImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('format non lisible par ce navigateur')); };
    img.src = url;
  });
}

function imageToCanvas(img) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error('image vide');
  const { w, h, scaled } = capSize(w0, h0);
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  c._scaled = scaled;
  return c;
}

function flatten(src, color = '#ffffff') {
  const c = makeCanvas(src.width, src.height);
  const g = ctx2d(c);
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0);
  return c;
}

function hasAlpha(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

// Redimensionnement de qualité : réductions successives par moitié.
function resizeCanvas(src, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const half = makeCanvas(cur.width / 2, cur.height / 2);
    const g = ctx2d(half);
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = makeCanvas(w, h);
  const g = ctx2d(out);
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, w, h);
  return out;
}

function rotate90(src, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return src;
  const swap = deg === 90 || deg === 270;
  const c = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const g = ctx2d(c);
  g.translate(c.width / 2, c.height / 2);
  g.rotate(deg * Math.PI / 180);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function flip(src, h, v) {
  if (!h && !v) return src;
  const c = makeCanvas(src.width, src.height);
  const g = ctx2d(c);
  g.translate(h ? c.width : 0, v ? c.height : 0);
  g.scale(h ? -1 : 1, v ? -1 : 1);
  g.drawImage(src, 0, 0);
  return c;
}

function rotateFree(src, deg, fill) {
  if (!deg) return src;
  const r = deg * Math.PI / 180, cos = Math.abs(Math.cos(r)), sin = Math.abs(Math.sin(r));
  const c = makeCanvas(src.width * cos + src.height * sin, src.width * sin + src.height * cos);
  const g = ctx2d(c);
  if (fill) { g.fillStyle = fill; g.fillRect(0, 0, c.width, c.height); }
  g.imageSmoothingQuality = 'high';
  g.translate(c.width / 2, c.height / 2);
  g.rotate(r);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

// ---------------------------------------------------------------------------
// Encodage (PNG, JPG, WebP, GIF, BMP) + résolution d'impression
// ---------------------------------------------------------------------------
function canvasToBlob(c, type, q) {
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encodage impossible (image trop grande ?)')), type, q));
}

function encodeBMP(c) {
  const w = c.width, h = c.height;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const row = (w * 3 + 3) & ~3, size = 54 + row * h;
  const buf = new ArrayBuffer(size), v = new DataView(buf), out = new Uint8Array(buf);
  v.setUint16(0, 0x4D42, true); v.setUint32(2, size, true); v.setUint32(10, 54, true);
  v.setUint32(14, 40, true); v.setInt32(18, w, true); v.setInt32(22, h, true);
  v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, row * h, true);
  v.setInt32(38, 2835, true); v.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * row, i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) { out[o++] = d[i + 2]; out[o++] = d[i + 1]; out[o++] = d[i]; }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

async function encodeGIF(c, transparent) {
  const { GIFEncoder, quantize, applyPalette } = await getGifenc();
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  const gif = GIFEncoder();
  if (transparent) {
    const palette = quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true });
    const index = applyPalette(data, palette, 'rgba4444');
    const ti = palette.findIndex(p => p[3] === 0);
    gif.writeFrame(index, c.width, c.height, { palette, transparent: ti >= 0, transparentIndex: Math.max(0, ti) });
  } else {
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), c.width, c.height, { palette });
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Inscrit la résolution (dpi) pour que l'impression sorte à la bonne taille.
async function setDpi(blob, dpi) {
  const u = new Uint8Array(await blob.arrayBuffer());
  if (blob.type === 'image/jpeg' && u[2] === 0xFF && u[3] === 0xE0 && String.fromCharCode(...u.subarray(6, 10)) === 'JFIF') {
    u[13] = 1; u[14] = dpi >> 8; u[15] = dpi & 255; u[16] = dpi >> 8; u[17] = dpi & 255;
    return new Blob([u], { type: blob.type });
  }
  if (blob.type === 'image/png') {
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21), v = new DataView(chunk.buffer);
    v.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4);            // "pHYs"
    v.setUint32(8, ppm); v.setUint32(12, ppm); chunk[16] = 1;
    v.setUint32(17, crc32(chunk.subarray(4, 17)));
    const ihdrEnd = 8 + 8 + new DataView(u.buffer).getUint32(8) + 4;
    return new Blob([u.subarray(0, ihdrEnd), chunk, u.subarray(ihdrEnd)], { type: 'image/png' });
  }
  return blob;
}

let webpOk;
async function encode(c, fmt, { quality = 0.9, whiteBg = true, dpi = 0 } = {}) {
  let blob;
  if (fmt === 'jpeg') blob = await canvasToBlob(flatten(c), 'image/jpeg', quality);
  else if (fmt === 'png') blob = await canvasToBlob(whiteBg ? flatten(c) : c, 'image/png');
  else if (fmt === 'webp') {
    blob = await canvasToBlob(whiteBg ? flatten(c) : c, 'image/webp', quality);
    if (blob.type !== 'image/webp') {
      webpOk = false;
      throw new Error("ce navigateur ne sait pas créer de WebP (Safari) : choisissez PNG ou JPG");
    }
  }
  else if (fmt === 'bmp') blob = encodeBMP(flatten(c));
  else if (fmt === 'gif') blob = await encodeGIF(whiteBg ? flatten(c) : c, !whiteBg);
  else throw new Error('format inconnu ' + fmt);
  if (dpi && (fmt === 'jpeg' || fmt === 'png')) blob = await setDpi(blob, dpi);
  return blob;
}

// Recopie les métadonnées EXIF d'origine dans un JPEG recréé.
async function withExif(jpegBlob, exifObj, w, h) {
  try {
    const ex = JSON.parse(JSON.stringify(exifObj));
    ex['0th'][piexif.ImageIFD.Orientation] = 1;          // l'image est déjà redressée
    ex['1st'] = {}; ex.thumbnail = null;                   // vignette obsolète
    ex.Exif[piexif.ExifIFD.PixelXDimension] = w;
    ex.Exif[piexif.ExifIFD.PixelYDimension] = h;
    const bin = piexif.insert(safeDump(ex), bufToBin(await jpegBlob.arrayBuffer()));
    return new Blob([binToU8(bin)], { type: 'image/jpeg' });
  } catch (e) {
    console.warn('EXIF non recopié', e);
    return jpegBlob;
  }
}

// piexif.dump échoue sur certaines balises exotiques : on les écarte.
function safeDump(ex) {
  try { return piexif.dump(ex); } catch (e) { /* on nettoie */ }
  ex.Interop = {}; ex['1st'] = {}; ex.thumbnail = null;
  try { return piexif.dump(ex); } catch (e) { /* tri balise par balise */ }
  for (const ifd of ['0th', 'Exif', 'GPS']) {
    for (const tag of Object.keys(ex[ifd] || {})) {
      const test = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
      test[ifd][tag] = ex[ifd][tag];
      try { piexif.dump(test); } catch (e) { delete ex[ifd][tag]; }
    }
  }
  return piexif.dump(ex);
}

function readExif(buf) {
  try { return piexif.load(bufToBin(buf)); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Lecture des fichiers (images, HEIC, PDF)
// ---------------------------------------------------------------------------
function parsePages(text, total) {
  text = (text || '').trim().toLowerCase().replace(/\s+/g, '');
  if (['', 'tout', 'toutes', 'all', '*'].includes(text)) return [...Array(total).keys()];
  const pages = [];
  for (const part of text.split(/[,;]/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)(?:-(\d*))?$/);
    if (!m) throw new Error(`sélection de pages incorrecte : « ${part} »`);
    const a = +m[1], b = m[2] === undefined ? a : (m[2] === '' ? total : +m[2]);
    for (let p = a; p <= Math.min(b, total); p++) if (p >= 1 && !pages.includes(p - 1)) pages.push(p - 1);
  }
  if (!pages.length) throw new Error(`aucune page valide (le document en compte ${total})`);
  return pages;
}

async function decodeImage(file) {
  const kind = fileKind(file);
  if (kind === 'heic') {
    try { return imageToCanvas(await blobToImage(file)); } catch (e) { /* pas de HEIC natif : libheif */ }
    const heic2any = await getHeic();
    let out = await heic2any({ blob: file, toType: 'image/png' });
    if (Array.isArray(out)) out = out[0];
    return imageToCanvas(await blobToImage(out));
  }
  if (/\.tiff?$/i.test(file.name) || file.type === 'image/tiff') {
    try { return imageToCanvas(await blobToImage(file)); }
    catch (e) { throw new Error('TIFF lisible uniquement dans Safari'); }
  }
  return imageToCanvas(await blobToImage(file));
}

// Produit {canvas, name, exif} pour chaque image (une par page pour un PDF).
async function* decodeFile(file, { dpi = 150, pages = '', transparent = false } = {}) {
  const kind = fileKind(file);
  if (!kind) throw new Error('type de fichier non pris en charge');
  if (kind !== 'pdf') {
    const canvas = await decodeImage(file);
    const exif = isJpeg(file) ? readExif(await file.arrayBuffer()) : null;
    yield { canvas, name: baseName(file.name), exif };
    return;
  }
  const pdfjs = await getPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('PDF protégé par un mot de passe');
    throw new Error('PDF abîmé ou invalide');
  }
  try {
    const list = parsePages(pages, doc.numPages);
    for (const i of list) {
      const page = await doc.getPage(i + 1);
      let vp = page.getViewport({ scale: dpi / 72 });
      const cap = capSize(vp.width, vp.height);
      if (cap.scaled) vp = page.getViewport({ scale: dpi / 72 * cap.w / vp.width });
      const c = makeCanvas(vp.width, vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: transparent ? 'rgba(0,0,0,0)' : '#ffffff' }).promise;
      page.cleanup();
      const n = String(i + 1).padStart(doc.numPages >= 100 ? 3 : 2, '0');
      yield { canvas: c, name: `${baseName(file.name)} - page ${n}`, exif: null };
    }
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// Création de PDF
// ---------------------------------------------------------------------------
class PdfBuilder {
  constructor(pageMode) { this.pageMode = pageMode; this.count = 0; }
  async add(canvas) {
    const { PDFDocument } = await getPdfLib();
    this.doc ??= await PDFDocument.create();
    const alpha = hasAlpha(canvas);
    const blob = alpha ? await canvasToBlob(canvas, 'image/png') : await canvasToBlob(flatten(canvas), 'image/jpeg', 0.92);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = alpha ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes);
    const PT = 72 / 150; // une image est considérée à 150 dpi
    if (this.pageMode === 'a4') {
      const land = canvas.width > canvas.height;
      const W = land ? 841.89 : 595.28, H = land ? 595.28 : 841.89, m = 28.35;
      const k = Math.min((W - 2 * m) / canvas.width, (H - 2 * m) / canvas.height, PT);
      const w = canvas.width * k, h = canvas.height * k;
      this.doc.addPage([W, H]).drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
    } else {
      const w = canvas.width * PT, h = canvas.height * PT;
      this.doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
    }
    this.count++;
  }
  async blob() {
    this.doc.setProducer(APP_NAME);
    this.doc.setCreator(APP_NAME);
    return new Blob([await this.doc.save()], { type: 'application/pdf' });
  }
}

// ---------------------------------------------------------------------------
// Éléments d'interface communs
// ---------------------------------------------------------------------------
const FMT_LABEL = { png: 'PNG', jpeg: 'JPG', webp: 'WebP', gif: 'GIF', bmp: 'BMP', pdf: 'PDF' };
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function svgIcon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('class', 'ic');
  const u = document.createElementNS(ns, 'use');
  u.setAttribute('href', '#i-' + id);
  s.append(u);
  return s;
}
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}
function iconButton(icon, title, onclick) {
  return el('button', { type: 'button', title, 'aria-label': title, onclick: e => { e.stopPropagation(); onclick(e); } }, svgIcon(icon));
}

function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

function canShareFiles(files) {
  try { return !!navigator.canShare && navigator.canShare({ files }); } catch (e) { return false; }
}

async function zipBlob(items) {
  const zip = new window.JSZip();
  for (const it of items) zip.file(it.name, it.blob);
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

const PREVIEWABLE = /^image\/(png|jpeg|webp|gif|bmp|avif)$/;
function thumbEl(blob, label) {
  if (blob && PREVIEWABLE.test(blob.type)) {
    const url = URL.createObjectURL(blob);
    const img = el('img', { class: 'thumb', alt: '', loading: 'lazy', src: url });
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    img.addEventListener('error', () => { URL.revokeObjectURL(url); img.replaceWith(placeholder(label)); }, { once: true });
    return img;
  }
  return placeholder(label);
}
function placeholder(label) {
  return el('div', { class: 'thumb ph' }, label === 'PDF' ? svgIcon('file') : svgIcon('image'));
}
const extOf = name => (name.match(/\.([^.]+)$/)?.[1] || '').toUpperCase().slice(0, 4);

function tile({ blob, name, meta, tag, actions = [], onclick }) {
  const t = el('div', { class: 'tile', title: name },
    thumbEl(blob, tag),
    tag ? el('span', { class: 'tag', text: tag }) : null,
    el('div', { class: 'body' }, el('div', { class: 'name', text: name }), el('div', { class: 'meta', text: meta })),
  );
  if (actions.length) t.append(el('div', { class: 'actions' }, ...actions));
  if (onclick) { t.style.cursor = 'pointer'; t.addEventListener('click', onclick); }
  return t;
}

function showResults(box, items, errors, title) {
  box.innerHTML = '';
  if (!items.length && !errors.length) return;
  const total = items.reduce((s, it) => s + it.blob.size, 0);
  const head = el('div', { class: 'head' },
    el('div', { class: 'title' },
      el('span', { class: 'okdot' }, svgIcon(items.length ? 'check' : 'x')),
      el('div', {}, el('b', { text: title }), el('span', { text: items.length ? `${plural(items.length, 'fichier', 'fichiers')} · ${fmtSize(total)}` : 'Aucun fichier créé' }))));
  const actions = el('div', { class: 'row-actions' });
  if (items.length > 1) {
    const bz = el('button', { class: 'btn btn-primary', type: 'button' }, svgIcon('archive'), el('span', { text: 'Tout télécharger (ZIP)' }));
    bz.onclick = async () => {
      bz.disabled = true;
      try { download(await zipBlob(items), `${APP_NAME} ${new Date().toISOString().slice(0, 10)}.zip`); }
      catch (e) { toast('Création du ZIP impossible : ' + e.message, { error: true }); }
      finally { bz.disabled = false; }
    };
    actions.append(bz);
  } else if (items.length === 1) {
    actions.append(el('button', { class: 'btn btn-primary', type: 'button', onclick: () => download(items[0].blob, items[0].name) }, svgIcon('download'), el('span', { text: 'Télécharger' })));
  }
  const files = items.map(it => new File([it.blob], it.name, { type: it.blob.type }));
  if (items.length && canShareFiles(files)) {
    actions.append(el('button', {
      class: 'btn', type: 'button', onclick: async () => {
        try { await navigator.share({ files }); }
        catch (e) { if (e.name !== 'AbortError') toast('Partage impossible : ' + e.message, { error: true }); }
      },
    }, svgIcon('share'), el('span', { text: 'Partager ou enregistrer' })));
  }
  head.append(actions);
  box.append(head);
  if (items.length) {
    box.append(el('div', { class: 'tiles' }, ...items.map(it => tile({
      blob: it.blob, name: it.name, tag: extOf(it.name),
      meta: fmtSize(it.blob.size) + (it.note ? ' · ' + it.note : ''),
      actions: [iconButton('download', 'Télécharger', () => download(it.blob, it.name))],
      onclick: () => download(it.blob, it.name),
    }))));
  }
  if (errors.length) box.append(el('ul', { class: 'errors' }, ...errors.map(e => el('li', { text: e }))));
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setProgress(el, done, total, label) {
  el.hidden = false;
  el.firstElementChild.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  el.lastElementChild.textContent = label;
}

function bindPicker(input, onFiles) {
  input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); input.value = ''; });
}

// ---------------------------------------------------------------------------
// Onglets, installation, service worker, dépôt global
// ---------------------------------------------------------------------------
let activeTab = 'conv';
function showTab(name) {
  activeTab = name;
  $$('.tabs button').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  if (name === 'edit' && ed.cropper) setTimeout(() => fitView(), 60);
  localStorage.setItem('pb-tab', name);
}
$$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$$('[data-close]').forEach(b => b.addEventListener('click', () => {
  $('#' + b.dataset.close).hidden = true;
  localStorage.setItem('hide-' + b.dataset.close, '1');
}));

document.title = APP_NAME;
$('.brand-name').textContent = APP_NAME;
$('#appVersion').textContent = APP_VERSION;

let installEvt;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#btnInstall').hidden = false; });
window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; toast('PhotoBoîte est installée.'); });
$('#btnInstall').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null;
  $('#btnInstall').hidden = true;
});
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (isIOS && !standalone && !localStorage.getItem('hide-iosHint')) $('#iosHint').hidden = false;

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Nouvelle version disponible : rechargez la page.', { ms: 8000 });
      });
    });
  }).catch(e => console.warn('Service worker', e));
}

function routeFiles(files) {
  files = files.filter(f => fileKind(f));
  if (!files.length) return toast('Type de fichier non pris en charge.', { error: true });
  if (activeTab === 'edit') openInEditor(files[0]);
  else if (activeTab === 'tags') addTagFiles(files);
  else addConvFiles(files);
}

// Glisser-déposer n'importe où dans la fenêtre
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; });
document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  routeFiles([...e.dataTransfer.files]);
});

// Fichiers ouverts depuis Windows (« Ouvrir avec ») quand l'application est installée.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async p => {
    if (!p.files?.length) return;
    const files = await Promise.all(p.files.map(h => h.getFile()));
    if (files.length === 1 && fileKind(files[0]) !== 'pdf') { showTab('edit'); openInEditor(files[0]); }
    else { showTab('conv'); addConvFiles(files); }
  });
}

// Coller une image (Ctrl+V)
document.addEventListener('paste', e => {
  if (e.target.matches('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])].filter(f => fileKind(f));
  if (!files.length) return;
  routeFiles(files.map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : `collage-${i + 1}.png`, { type: f.type })));
});

// Mémorisation des réglages
const SAVED = ['quality', 'whiteBg', 'keepExif', 'pdfGroup', 'pdfPage', 'pdfDpi', 'resizeMode', 'maxW', 'maxH', 'pct'];
function saveSettings() {
  const s = { fmt: $('input[name=fmt]:checked').value, edfmt: $('input[name=edfmt]:checked').value };
  for (const id of SAVED) { const e = $('#' + id); s[id] = e.type === 'checkbox' ? e.checked : e.value; }
  localStorage.setItem('pb-settings', JSON.stringify(s));
}
function loadSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem('pb-settings') || 'null'); } catch (e) { s = null; }
  if (!s) return;
  for (const id of SAVED) {
    const e = $('#' + id);
    if (e && id in s) { if (e.type === 'checkbox') e.checked = !!s[id]; else e.value = s[id]; }
  }
  const f = $(`input[name=fmt][value="${s.fmt}"]`); if (f) f.checked = true;
  const g = $(`input[name=edfmt][value="${s.edfmt}"]`); if (g) g.checked = true;
}

// ---------------------------------------------------------------------------
// Onglet CONVERTIR
// ---------------------------------------------------------------------------
let convFiles = []; // { file, pages }

const FMT_HELP = {
  png: 'Sans perte, gère la transparence. Idéal pour les captures et les pages de PDF.',
  jpeg: 'Le plus compatible et le plus léger pour les photos.',
  webp: 'Très léger, lu par tous les navigateurs récents.',
  gif: 'Limité à 256 couleurs. Pour les logos et images simples.',
  bmp: 'Format Windows non compressé : fichiers volumineux.',
  pdf: 'Assemble les images (et pages de PDF) en document.',
};

function renderConvList() {
  const box = $('#convList');
  box.innerHTML = '';
  convFiles.forEach((it, idx) => {
    const f = it.file, kind = fileKind(f);
    const meta = fmtSize(f.size) + (it.pages ? ` · ${plural(it.pages, 'page', 'pages')}` : '');
    const actions = [];
    actions.push(iconButton('edit', 'Retoucher', () => { showTab('edit'); openInEditor(f); }));
    if (idx) actions.push(iconButton('up', 'Placer avant', () => { [convFiles[idx - 1], convFiles[idx]] = [convFiles[idx], convFiles[idx - 1]]; renderConvList(); }));
    actions.push(iconButton('x', 'Retirer', () => { convFiles.splice(idx, 1); renderConvList(); }));
    const previewable = kind === 'image' && !/\.tiff?$/i.test(f.name);
    box.append(tile({ blob: previewable ? f : null, name: f.name, meta, tag: kind === 'pdf' ? 'PDF' : extOf(f.name), actions }));
  });
  if (convFiles.length) {
    const input = el('input', { type: 'file', multiple: true, accept: 'image/*,.heic,.heif,.pdf,application/pdf' });
    bindPicker(input, addConvFiles);
    box.append(el('label', { class: 'tile add' }, input, el('div', {}, svgIcon('plus'), el('span', { text: 'Ajouter' }))));
  }
  const n = convFiles.length;
  $('#tab-conv .work-main').classList.toggle('has-files', n > 0);
  $('#convListActions').hidden = !n;
  const pdfs = convFiles.filter(it => fileKind(it.file) === 'pdf');
  const pages = pdfs.reduce((s, it) => s + (it.pages || 0), 0);
  const size = convFiles.reduce((s, it) => s + it.file.size, 0);
  $('#convSummary').textContent = n
    ? [plural(n, 'fichier', 'fichiers'), pdfs.length ? `dont ${plural(pdfs.length, 'PDF', 'PDF')}${pages ? ` (${plural(pages, 'page', 'pages')})` : ''}` : '', fmtSize(size)].filter(Boolean).join(' · ')
    : '';
  $('#pdfInOpts').hidden = !pdfs.length;
  updateConvButton();
}

function addConvFiles(files) {
  const ok = files.filter(f => fileKind(f));
  const ko = files.length - ok.length;
  for (const file of ok) {
    const it = { file, pages: 0 };
    convFiles.push(it);
    if (fileKind(file) === 'pdf') countPages(it);
  }
  renderConvList();
  $('#convResults').innerHTML = '';
  if (ko) toast(`${plural(ko, 'fichier ignoré', 'fichiers ignorés')} : type non pris en charge.`, { error: true });
}

async function countPages(it) {
  try {
    const pdfjs = await getPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await it.file.arrayBuffer()), isEvalSupported: false }).promise;
    it.pages = doc.numPages;
    doc.destroy();
    renderConvList();
  } catch (e) { /* signalé à la conversion */ }
}

bindPicker($('#inConv'), addConvFiles);
bindPicker($('#inConvMore'), addConvFiles);
$('#convClear').onclick = () => { convFiles = []; renderConvList(); $('#convResults').innerHTML = ''; };
$('#convSort').onclick = () => {
  convFiles.sort((a, b) => a.file.name.localeCompare(b.file.name, 'fr', { numeric: true }));
  renderConvList();
};

function updateConvButton() {
  const fmt = $('input[name=fmt]:checked').value;
  const n = convFiles.length, btn = $('#btnConvert');
  btn.disabled = !n || btn.dataset.busy === '1';
  if (btn.dataset.busy === '1') return;
  if (!n) btn.textContent = 'Ajoutez des fichiers';
  else if (fmt === 'pdf' && $('#pdfGroup').value === 'one' && n > 1) btn.textContent = `Réunir ${n} fichiers en un PDF`;
  else btn.textContent = `Convertir ${plural(n, 'fichier', 'fichiers')} en ${FMT_LABEL[fmt]}`;
}

function refreshConvOptions() {
  const fmt = $('input[name=fmt]:checked').value;
  $$('#tab-conv [data-show]').forEach(e => { e.hidden = !e.dataset.show.split(' ').includes(fmt); });
  const rm = $('#resizeMode').value;
  $$('#tab-conv [data-resize]').forEach(e => { e.hidden = e.dataset.resize !== rm; });
  $('#fmtHelp').textContent = FMT_HELP[fmt];
  $('#qOut').textContent = $('#quality').value + ' %';
  const pages = $('#pdfPages').value.trim();
  $('#pdfInBadge').textContent = `${$('#pdfDpi').value} dpi · ${pages ? 'p. ' + pages : 'toutes'}`;
  const parts = [];
  if (rm === 'fit' && (+$('#maxW').value || +$('#maxH').value)) parts.push(`max ${$('#maxW').value || '…'}×${$('#maxH').value || '…'}`);
  if (rm === 'percent') parts.push($('#pct').value + ' %');
  if (+$('#rot').value) parts.push($('#rot').value + '°');
  if ($('#flipH').checked || $('#flipV').checked) parts.push('miroir');
  const tb = $('#transBadge');
  tb.textContent = parts.length ? parts.join(', ') : 'Inchangées';
  tb.classList.toggle('on', parts.length > 0);
  updateConvButton();
}
$$('#tab-conv .panel input, #tab-conv .panel select').forEach(e => {
  e.addEventListener('input', () => { refreshConvOptions(); saveSettings(); });
  e.addEventListener('change', () => { refreshConvOptions(); saveSettings(); $$('.preset-btn').forEach(b => b.classList.remove('on')); });
});

const PRESETS = {
  png: { fmt: 'png', whiteBg: true, resizeMode: 'none' },
  pdfA4: { fmt: 'pdf', pdfGroup: 'one', pdfPage: 'a4', resizeMode: 'none' },
  web: { fmt: 'jpeg', quality: 85, keepExif: true, resizeMode: 'fit', maxW: 1920, maxH: 1920 },
  mail: { fmt: 'jpeg', quality: 80, keepExif: false, resizeMode: 'fit', maxW: 1280, maxH: 1280 },
};
$$('.preset-btn').forEach(b => b.addEventListener('click', () => {
  const p = PRESETS[b.dataset.preset];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'fmt') { $(`input[name=fmt][value=${v}]`).checked = true; continue; }
    const e = $('#' + k);
    if (e.type === 'checkbox') e.checked = v; else e.value = v;
  }
  $('#rot').value = '0'; $('#flipH').checked = false; $('#flipV').checked = false;
  if (p.resizeMode !== 'none') $('#transOpts').open = true;
  refreshConvOptions();
  saveSettings();
  $$('.preset-btn').forEach(x => x.classList.toggle('on', x === b));
  toast('Préréglage appliqué : ' + b.querySelector('b').textContent);
}));

function batchTransform(c, t) {
  if (t.resize === 'fit' && (t.maxW || t.maxH)) {
    const k = Math.min(t.maxW ? t.maxW / c.width : Infinity, t.maxH ? t.maxH / c.height : Infinity, 1);
    if (k < 1) c = resizeCanvas(c, c.width * k, c.height * k);
  } else if (t.resize === 'percent' && t.pct > 0 && t.pct !== 100) {
    const k = t.pct / 100;
    const cap = capSize(c.width * k, c.height * k);
    c = resizeCanvas(c, cap.w, cap.h);
  }
  c = rotate90(c, t.rot);
  return flip(c, t.flipH, t.flipV);
}

$('#btnConvert').addEventListener('click', async () => {
  const fmt = $('input[name=fmt]:checked').value;
  const opts = {
    quality: +$('#quality').value / 100,
    whiteBg: $('#whiteBg').checked || fmt === 'jpeg' || fmt === 'bmp',
    keepExif: $('#keepExif').checked,
  };
  const t = {
    resize: $('#resizeMode').value, maxW: +$('#maxW').value || 0, maxH: +$('#maxH').value || 0,
    pct: +$('#pct').value || 100, rot: +$('#rot').value, flipH: $('#flipH').checked, flipV: $('#flipV').checked,
  };
  const pdfOpts = { dpi: +$('#pdfDpi').value, pages: $('#pdfPages').value, transparent: !opts.whiteBg && fmt !== 'pdf' };
  const group = $('#pdfGroup').value, pageMode = $('#pdfPage').value;
  const list = convFiles.map(it => it.file);

  const btn = $('#btnConvert'), prog = $('#convProgress');
  btn.dataset.busy = '1'; btn.disabled = true; btn.textContent = 'Conversion en cours…';
  const items = [], errors = [], uniq = uniqueNamer(), notes = new Set();
  const shared = fmt === 'pdf' && group === 'one' && list.length > 1 ? new PdfBuilder(pageMode) : null;
  const t0 = performance.now();
  try {
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      setProgress(prog, i, list.length, `${i + 1} / ${list.length} · ${f.name}`);
      await nextFrame();
      const own = fmt === 'pdf' && !shared ? new PdfBuilder(pageMode) : null;
      try {
        for await (const it of decodeFile(f, pdfOpts)) {
          if (it.canvas._scaled) notes.add(`${f.name} a été réduite (taille maximale gérée par ${isIOS ? 'l’iPhone ou l’iPad' : 'ce navigateur'}).`);
          const c = batchTransform(it.canvas, t);
          if (fmt === 'pdf') { await (shared || own).add(c); continue; }
          let blob = await encode(c, fmt, opts);
          if (fmt === 'jpeg' && opts.keepExif && it.exif) blob = await withExif(blob, it.exif, c.width, c.height);
          items.push({ name: uniq(it.name + EXT[fmt]), blob, note: `${c.width}×${c.height}` });
          await nextFrame();
        }
        if (own) items.push({ name: uniq(baseName(f.name) + '.pdf'), blob: await own.blob(), note: plural(own.count, 'page', 'pages') });
      } catch (e) {
        console.error(e);
        errors.push(`${f.name} : ${e.message || e}`);
      }
    }
    if (shared && shared.count) items.push({ name: uniq((list.length === 1 ? baseName(list[0].name) : 'Images') + '.pdf'), blob: await shared.blob(), note: plural(shared.count, 'page', 'pages') });
  } finally {
    delete btn.dataset.busy;
    prog.hidden = true;
    updateConvButton();
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',');
  showResults($('#convResults'), items, [...errors, ...notes], items.length ? `Conversion terminée en ${secs} s` : 'Conversion impossible');
  if (items.length === 1 && !errors.length) download(items[0].blob, items[0].name);
});

// ---------------------------------------------------------------------------
// Onglet RETOUCHER
// ---------------------------------------------------------------------------
const ed = { canvas: null, history: [], future: [], name: 'image', exif: null, cropper: null, mode: 'crop', url: null };
const ID_RATIO = 35 / 45;

async function openInEditor(file) {
  if (!file) return;
  if (!fileKind(file)) return toast('Type de fichier non pris en charge.', { error: true });
  try {
    toast('Ouverture de ' + file.name + '…', { ms: 1500 });
    let first;
    for await (const it of decodeFile(file, { dpi: 150, pages: '1' })) { first = it; break; }
    ed.history = []; ed.future = [];
    ed.name = baseName(file.name);
    ed.exif = first.exif;
    $('#edKeepExif').closest('label').hidden = !ed.exif;
    $('#editEmpty').hidden = true;
    $('#editor').hidden = false;
    $('#edResults').innerHTML = '';
    $('#edName').textContent = file.name;
    await setWorking(first.canvas, false);
    if (first.canvas._scaled) toast('Image réduite : elle dépassait la taille maximale gérée par cet appareil.', { ms: 5000 });
  } catch (e) {
    console.error(e);
    toast(`Impossible d'ouvrir ${file.name} : ${e.message}`, { ms: 5000, error: true });
  }
}
bindPicker($('#inEdit'), f => openInEditor(f[0]));
bindPicker($('#inEdit2'), f => openInEditor(f[0]));

function updateHistoryButtons() {
  $('#edUndo').disabled = !ed.history.length;
  $('#edRedo').disabled = !ed.future.length;
}

async function setWorking(canvas, push = true) {
  if (push && ed.canvas) {
    ed.history.push(ed.canvas);
    if (ed.history.length > 15) ed.history.shift();
    ed.future = [];
  }
  ed.canvas = canvas;
  updateHistoryButtons();
  $('#edInfo').textContent = `${canvas.width} × ${canvas.height} px`;
  $('#edSizeBadge').textContent = `${canvas.width} × ${canvas.height}`;
  $('#edW').value = canvas.width; $('#edH').value = canvas.height;
  $('#straight').value = 0; $('#straightOut').textContent = '0°';
  // Aperçu affiché (JPEG si opaque : beaucoup plus rapide à produire)
  const blob = hasAlpha(canvas) ? await canvasToBlob(canvas, 'image/png') : await canvasToBlob(canvas, 'image/jpeg', 0.92);
  if (ed.url) URL.revokeObjectURL(ed.url);
  ed.url = URL.createObjectURL(blob);
  if (ed.cropper) ed.cropper.replace(ed.url);
  else {
    const img = $('#edImg');
    img.src = ed.url;
    ed.cropper = new window.Cropper(img, {
      viewMode: 1, autoCropArea: 1, background: false, responsive: true, restore: false,
      zoomOnWheel: true, wheelZoomRatio: 0.08, toggleDragModeOnDblclick: false, dragMode: 'move',
      ready() { applyRatio(); updateCropInfo(); },
      crop() { updateCropInfo(); },
    });
  }
}

function updateCropInfo() {
  if (!ed.cropper || !ed.canvas) return;
  const d = ed.cropper.getData(true);
  if (!d.width) return;
  const full = Math.abs(d.width - ed.canvas.width) < 2 && Math.abs(d.height - ed.canvas.height) < 2 && !d.rotate;
  $('#edCropInfo').textContent = full ? 'Image entière' : `Cadre : ${d.width} × ${d.height} px`;
}

function currentRatio() {
  if (ed.mode === 'id') return ID_RATIO;
  if (ed.mode === 'polaroid') return 1;
  const v = $('input[name=ratio]:checked').value;
  return v === 'free' ? NaN : +v;
}

function applyRatio() {
  if (!ed.cropper) return;
  ed.cropper.setAspectRatio(currentRatio());
  if (ed.mode !== 'crop') {
    // cadre centré occupant le maximum de l'image
    const img = ed.cropper.getImageData(), r = currentRatio();
    let w = img.width, h = w / r;
    if (h > img.height) { h = img.height; w = h * r; }
    const cv = ed.cropper.getCanvasData();
    ed.cropper.setCropBoxData({ left: cv.left + (cv.width - w) / 2, top: cv.top + (cv.height - h) / 2, width: w, height: h });
  }
  drawGuide();
}
function setMode(mode) {
  ed.mode = mode;
  $$('#tab-edit [data-mode]').forEach(s => { s.hidden = s.dataset.mode !== mode; });
  $('#edSave').closest('.panel-section').hidden = mode !== 'crop';
  applyRatio();
}
$$('input[name=edmode]').forEach(r => r.addEventListener('change', () => setMode(r.value)));
$$('input[name=ratio]').forEach(r => r.addEventListener('change', applyRatio));

// Repères visage pour la photo d'identité (norme : tête de 32 à 36 mm sur 45 mm).
function drawGuide() {
  const box = document.querySelector('.cropper-crop-box');
  if (!box) return;
  box.querySelector('.guide')?.remove();
  if (ed.mode !== 'id') return;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'guide');
  svg.setAttribute('viewBox', '0 0 35 45');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `
    <rect x="0" y="3" width="35" height="3" fill="rgba(34,197,94,.28)"/>
    <rect x="0" y="38" width="35" height="3" fill="rgba(34,197,94,.28)"/>
    <ellipse cx="17.5" cy="22" rx="10.5" ry="17" fill="none" stroke="#fff" stroke-width=".3" stroke-dasharray="1 .7"/>
    <line x1="17.5" y1="0" x2="17.5" y2="45" stroke="rgba(255,255,255,.45)" stroke-width=".12"/>
    <text x="1" y="5.1" font-size="1.5" fill="#fff" font-family="system-ui,sans-serif">haut du crâne</text>
    <text x="1" y="40.1" font-size="1.5" fill="#fff" font-family="system-ui,sans-serif">menton</text>`;
  box.appendChild(svg);
}

// Image actuellement dans le cadre (rognage + redressement)
function framed() {
  const d = ed.cropper.getData(true);
  const base = d.rotate ? rotateFree(ed.canvas, d.rotate, '#ffffff') : ed.canvas;
  const c = makeCanvas(d.width, d.height);
  ctx2d(c).drawImage(base, -d.x, -d.y);
  return c;
}

function fitView() {
  const cr = ed.cropper;
  if (!cr || !cr.ready) return;
  const box = cr.getContainerData(), img = cr.getImageData();
  const k = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  cr.zoomTo(k);
  const cv = cr.getCanvasData();
  cr.setCanvasData({ left: (box.width - cv.width) / 2, top: (box.height - cv.height) / 2 });
}

function undo() {
  if (!ed.history.length) return;
  ed.future.push(ed.canvas);
  const prev = ed.history.pop();
  setWorking(prev, false);
}
function redo() {
  if (!ed.future.length) return;
  ed.history.push(ed.canvas);
  setWorking(ed.future.pop(), false);
}
$('#edUndo').onclick = undo;
$('#edRedo').onclick = redo;
$('#edRotL').onclick = () => ed.canvas && setWorking(rotate90(ed.canvas, 270));
$('#edRotR').onclick = () => ed.canvas && setWorking(rotate90(ed.canvas, 90));
$('#edFlipH').onclick = () => ed.canvas && setWorking(flip(ed.canvas, true, false));
$('#edFlipV').onclick = () => ed.canvas && setWorking(flip(ed.canvas, false, true));
$('#edZoomIn').onclick = () => ed.cropper?.zoom(0.15);
$('#edZoomOut').onclick = () => ed.cropper?.zoom(-0.15);
$('#edFit').onclick = fitView;

$('#straight').addEventListener('input', () => {
  const v = +$('#straight').value;
  $('#straightOut').textContent = String(v).replace('.', ',') + '°';
  if (!ed.cropper) return;
  ed.cropper.rotateTo(v);
  // En mode libre, on cadre automatiquement le plus grand rectangle sans coins blancs.
  if (ed.mode === 'crop' && isNaN(currentRatio()) && ed.canvas) {
    const w = ed.canvas.width, h = ed.canvas.height, r = Math.abs(v) * Math.PI / 180;
    const cos = Math.cos(r), sin = Math.sin(r);
    const k = Math.min(w / (w * cos + h * sin), h / (w * sin + h * cos));
    const W = w * cos + h * sin, H = w * sin + h * cos;
    ed.cropper.setData({ x: (W - k * w) / 2, y: (H - k * h) / 2, width: k * w, height: k * h });
  }
});
$('#edCrop').onclick = () => { if (ed.canvas) { setWorking(framed()); toast('Cadre appliqué.'); } };
$('#edResetBox').onclick = () => {
  if (!ed.cropper) return;
  $('#straight').value = 0; $('#straightOut').textContent = '0°';
  ed.cropper.rotateTo(0);
  ed.cropper.reset();
  applyRatio();
};

$('#edLockBtn').onclick = () => {
  const on = !$('#edLock').checked;
  $('#edLock').checked = on;
  $('#edLockBtn').setAttribute('aria-pressed', on);
};
$('#edW').addEventListener('input', () => {
  if ($('#edLock').checked && ed.canvas) $('#edH').value = Math.max(1, Math.round(+$('#edW').value * ed.canvas.height / ed.canvas.width));
});
$('#edH').addEventListener('input', () => {
  if ($('#edLock').checked && ed.canvas) $('#edW').value = Math.max(1, Math.round(+$('#edH').value * ed.canvas.width / ed.canvas.height));
});
$('#edResize').onclick = () => {
  const w = +$('#edW').value, h = +$('#edH').value;
  if (!ed.canvas || !(w > 0 && h > 0)) return toast('Indiquez une largeur et une hauteur.', { error: true });
  const cap = capSize(w, h);
  if (cap.scaled) toast('Taille limitée par cet appareil.');
  setWorking(resizeCanvas(ed.canvas, cap.w, cap.h));
};

$$('input[name=edfmt]').forEach(r => r.addEventListener('change', saveSettings));

function deliver(item, title) {
  showResults($('#edResults'), [item], [], title);
  download(item.blob, item.name);
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { await fn(); }
  catch (e) { console.error(e); toast('Erreur : ' + e.message, { ms: 5000, error: true }); }
  finally { btn.disabled = false; }
}

$('#edSave').onclick = () => ed.canvas && busy($('#edSave'), async () => {
  const fmt = $('input[name=edfmt]:checked').value;
  const c = framed();
  let blob;
  if (fmt === 'pdf') { const b = new PdfBuilder('image'); await b.add(c); blob = await b.blob(); }
  else {
    blob = await encode(c, fmt, { quality: 0.92, whiteBg: false });
    if (fmt === 'jpeg' && ed.exif && $('#edKeepExif').checked) blob = await withExif(blob, ed.exif, c.width, c.height);
  }
  deliver({ name: ed.name + ' - retouche' + EXT[fmt], blob, note: `${c.width}×${c.height}` }, 'Image enregistrée');
});

// --- Photo d'identité : 35 × 45 mm à 300 dpi = 413 × 531 px
const MM = 300 / 25.4;
$('#idSingle').onclick = () => ed.canvas && busy($('#idSingle'), async () => {
  const photo = resizeCanvas(framed(), 413, 531);
  const blob = await encode(photo, 'jpeg', { quality: 0.95, dpi: 300 });
  deliver({ name: ed.name + ' - identite 35x45.jpg', blob, note: '35×45 mm' }, "Photo d'identité prête");
});
$('#idSheet').onclick = () => ed.canvas && busy($('#idSheet'), async () => {
  const photo = resizeCanvas(framed(), 413, 531);
  const W = Math.round(100 * MM), H = Math.round(150 * MM);   // 10 × 15 cm
  const sheet = makeCanvas(W, H);
  const g = ctx2d(sheet);
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  const gx = Math.round((W - 2 * 413) / 3), gy = Math.round((H - 3 * 531) / 4);
  g.strokeStyle = '#c8c8c8'; g.lineWidth = 1;
  for (let r = 0; r < 3; r++) for (let col = 0; col < 2; col++) {
    const x = gx + col * (413 + gx), y = gy + r * (531 + gy);
    g.drawImage(photo, x, y);
    g.strokeRect(x - .5, y - .5, 414, 532);
  }
  const blob = await encode(sheet, 'jpeg', { quality: 0.95, dpi: 300 });
  deliver({ name: ed.name + ' - planche identite 10x15.jpg', blob, note: 'tirage 10×15 sans marge' }, 'Planche prête à imprimer');
});

// --- Polaroid : image 79 × 79 mm, cadre 88 × 107 mm (300 dpi)
$('#polaMake').onclick = () => ed.canvas && busy($('#polaMake'), async () => {
  const side = Math.round(79 * MM);
  const img = resizeCanvas(framed(), side, side);
  const W = Math.round(88 * MM), H = Math.round(107 * MM);
  const left = Math.round((W - side) / 2), top = Math.round(6 * MM);
  const c = makeCanvas(W, H);
  const g = ctx2d(c);
  const color = $('input[name=polaColor]:checked').value;
  g.fillStyle = color; g.fillRect(0, 0, W, H);
  g.drawImage(img, left, top);
  const text = $('#polaText').value.trim();
  if (text) {
    g.fillStyle = color === '#1d1d1f' ? '#f2f2f2' : '#2b2b2b';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = Math.round(8 * MM);
    const font = s => `${s}px "Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive`;
    g.font = font(size);
    while (g.measureText(text).width > W - 2 * left && size > 10) g.font = font(size -= 4);
    g.fillText(text, W / 2, top + side + (H - top - side) / 2);
  }
  const blob = await encode(c, 'jpeg', { quality: 0.95, dpi: 300 });
  deliver({ name: ed.name + ' - polaroid.jpg', blob, note: '88×107 mm' }, 'Polaroid prêt');
});

// Raccourcis clavier
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'o') {
    e.preventDefault();
    ({ conv: $('#inConv'), edit: $('#inEdit'), tags: $('#inTags') })[activeTab].click();
    return;
  }
  if (activeTab !== 'edit' || !ed.canvas || e.target.matches('input[type=text], input[type=number]')) return;
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  else if (k === 's') { e.preventDefault(); if (ed.mode === 'crop') $('#edSave').click(); else if (ed.mode === 'id') $('#idSingle').click(); else $('#polaMake').click(); }
});

// ---------------------------------------------------------------------------
// Onglet TAGS (EXIF par lot)
// ---------------------------------------------------------------------------
let tagFiles = []; // {file, exif, error}
const I = piexif.ImageIFD, X = piexif.ExifIFD, G = piexif.GPSIFD;

const utf8Enc = s => unescape(encodeURIComponent(s));
const utf8Dec = s => { try { return decodeURIComponent(escape(s)); } catch (e) { return s; } };
const clean = s => (typeof s === 'string' ? s : '').replace(/\0+$/, '').trim();
function xpEnc(s) { const a = []; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a.push(c & 255, c >> 8); } a.push(0, 0); return a; }
function xpDec(a) {
  if (!Array.isArray(a)) return '';
  let s = '';
  for (let i = 0; i + 1 < a.length; i += 2) { const c = a[i] | (a[i + 1] << 8); if (!c) break; s += String.fromCharCode(c); }
  return s;
}
const exifDate = d => `${d.getFullYear()}:${String(d.getMonth() + 1).padStart(2, '0')}:${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
function parseExifDate(s) {
  const m = clean(s).match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
const showDate = s => { const d = parseExifDate(s); return d ? d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : ''; };

function summary(ex) {
  return {
    date: showDate(ex.Exif[X.DateTimeOriginal] || ex['0th'][I.DateTime]),
    title: xpDec(ex['0th'][I.XPTitle]) || utf8Dec(clean(ex['0th'][I.ImageDescription])),
    author: xpDec(ex['0th'][I.XPAuthor]) || utf8Dec(clean(ex['0th'][I.Artist])),
    camera: [clean(ex['0th'][I.Make]), clean(ex['0th'][I.Model])].filter(Boolean).join(' '),
    gps: ex.GPS && ex.GPS[G.GPSLatitude] ? 'Oui' : '',
  };
}

function renderTagTable() {
  const tb = $('#tagsTable tbody');
  tb.innerHTML = '';
  tagFiles.forEach((t, idx) => {
    const td = (txt, cls) => el('td', { text: txt || '—', class: cls });
    const mini = el('td', {}, isJpeg(t.file) ? (() => {
      const url = URL.createObjectURL(t.file);
      const img = el('img', { class: 'mini', alt: '', loading: 'lazy', src: url });
      img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      return img;
    })() : el('div', { class: 'mini' }));
    const tr = el('tr', {}, mini, td(t.file.name, 'fname'));
    if (t.error) { const c = td(t.error, 'err'); c.colSpan = 5; tr.append(c); }
    else { const s = summary(t.exif); tr.append(td(s.date), td(s.title), td(s.author), td(s.camera), td(s.gps)); }
    const btn = el('button', { class: 'icon-btn', type: 'button', title: 'Retirer', 'aria-label': 'Retirer', onclick: () => { tagFiles.splice(idx, 1); renderTagTable(); } }, svgIcon('x'));
    tr.append(el('td', {}, btn));
    tb.append(tr);
  });
  const n = tagFiles.length, ok = tagFiles.filter(t => t.exif).length;
  $('#tab-tags .work-main').classList.toggle('has-files', n > 0);
  $('#tagsTableWrap').hidden = !n;
  $('#tagsListActions').hidden = !n;
  const btn = $('#btnTags');
  if (btn.dataset.busy !== '1') {
    btn.disabled = !ok;
    btn.textContent = ok ? `Appliquer à ${plural(ok, 'photo', 'photos')}` : (n ? 'Aucune photo modifiable' : 'Ajoutez des photos');
  }
}

async function addTagFiles(files) {
  for (const file of files) {
    if (!isJpeg(file)) {
      tagFiles.push({ file, error: 'Seuls les JPG sont modifiables. Convertissez d’abord en JPG (onglet Convertir).' });
      continue;
    }
    const ex = readExif(await file.arrayBuffer());
    tagFiles.push(ex ? { file, exif: ex } : { file, error: 'Métadonnées illisibles (fichier abîmé ?)' });
  }
  $('#tagsResults').innerHTML = '';
  renderTagTable();
  const s = tagFiles.find(t => t.exif);
  if (s) { // pré-remplit avec les valeurs de la première photo
    const v = summary(s.exif);
    const fill = (id, val) => { if (!$(id).value && val) $(id).value = val; };
    fill('#tTitle', v.title); fill('#tAuthor', v.author);
    fill('#tCopyright', utf8Dec(clean(s.exif['0th'][I.Copyright])));
    fill('#tKeywords', xpDec(s.exif['0th'][I.XPKeywords]));
    fill('#tComment', xpDec(s.exif['0th'][I.XPComment]));
  }
}
bindPicker($('#inTags'), addTagFiles);
bindPicker($('#inTagsMore'), addTagFiles);
$('#tagsClear').onclick = () => { tagFiles = []; renderTagTable(); $('#tagsResults').innerHTML = ''; };

function syncTagField(cb) {
  const field = cb.closest('.tagfield');
  field.classList.toggle('off', !cb.checked);
  field.querySelectorAll('input:not([type=checkbox]), select').forEach(i => { i.disabled = !cb.checked; });
}
$$('[data-apply]').forEach(cb => {
  syncTagField(cb);
  cb.addEventListener('change', () => {
    syncTagField(cb);
    if (cb.checked) cb.closest('.tagfield').querySelector('input:not([type=checkbox]), select')?.focus();
  });
});
$('#tStripAll').addEventListener('change', () => $('#tagsForm').classList.toggle('stripping', $('#tStripAll').checked));
$('#tDateMode').addEventListener('change', () => {
  const shift = $('#tDateMode').value === 'shift';
  $('#tDate').hidden = shift; $('#tShift').hidden = !shift;
});
$('#tGpsMode').addEventListener('change', () => { $('#tGpsSet').hidden = $('#tGpsMode').value !== 'set'; });

function setText(ifd, tag, value, enc) {
  if (value) ifd[tag] = enc(value); else delete ifd[tag];
}
function toRational(deg) {
  deg = Math.abs(deg);
  const d = Math.floor(deg), mf = (deg - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60 * 10000);
  return [[d, 1], [m, 1], [s, 10000]];
}

function applyTagChanges(ex, ch) {
  const z = ex['0th'], e = ex.Exif;
  if (ch.title) { setText(z, I.ImageDescription, ch.title.v, utf8Enc); setText(z, I.XPTitle, ch.title.v, xpEnc); }
  if (ch.author) { setText(z, I.Artist, ch.author.v, utf8Enc); setText(z, I.XPAuthor, ch.author.v, xpEnc); }
  if (ch.copyright) setText(z, I.Copyright, ch.copyright.v, utf8Enc);
  if (ch.keywords) setText(z, I.XPKeywords, ch.keywords.v.split(/[;,]/).map(s => s.trim()).filter(Boolean).join(';'), xpEnc);
  if (ch.comment) setText(z, I.XPComment, ch.comment.v, xpEnc);
  if (ch.rating) {
    const r = +ch.rating.v;
    if (r) { z[I.Rating] = r; z[I.RatingPercent] = [0, 1, 25, 50, 75, 99][r]; }
    else { delete z[I.Rating]; delete z[I.RatingPercent]; }
  }
  if (ch.date) {
    let d;
    if (ch.date.mode === 'set') d = ch.date.date;
    else {
      const cur = parseExifDate(e[X.DateTimeOriginal] || z[I.DateTime] || e[X.DateTimeDigitized]);
      if (!cur) throw new Error('pas de date d’origine à décaler');
      d = new Date(cur.getTime() + ch.date.shiftMs);
    }
    const s = exifDate(d);
    e[X.DateTimeOriginal] = s; e[X.DateTimeDigitized] = s; z[I.DateTime] = s;
  }
  if (ch.gps) {
    if (ch.gps.mode === 'remove') { ex.GPS = {}; delete z[I.GPSTag]; }
    else {
      const { lat, lon } = ch.gps;
      ex.GPS = {
        [G.GPSVersionID]: [2, 3, 0, 0],
        [G.GPSLatitudeRef]: lat >= 0 ? 'N' : 'S', [G.GPSLatitude]: toRational(lat),
        [G.GPSLongitudeRef]: lon >= 0 ? 'E' : 'W', [G.GPSLongitude]: toRational(lon),
      };
    }
  }
  return ex;
}

$('#btnTags').addEventListener('click', async () => {
  const on = k => $(`[data-apply=${k}]`).checked;
  const strip = $('#tStripAll').checked;
  const ch = {};
  for (const [k, id] of [['title', 'tTitle'], ['author', 'tAuthor'], ['copyright', 'tCopyright'], ['keywords', 'tKeywords'], ['comment', 'tComment'], ['rating', 'tRating']])
    if (on(k)) ch[k] = { v: $('#' + id).value.trim() };
  if (!strip && on('date')) {
    if ($('#tDateMode').value === 'set') {
      const d = $('#tDate').value ? new Date($('#tDate').value) : null;
      if (!d || isNaN(d)) return toast('Indiquez la date à appliquer.', { error: true });
      ch.date = { mode: 'set', date: d };
    } else {
      const ms = ((+$('#tShiftD').value || 0) * 1440 + (+$('#tShiftH').value || 0) * 60 + (+$('#tShiftM').value || 0)) * 60000;
      if (!ms) return toast('Indiquez un décalage différent de zéro.', { error: true });
      ch.date = { mode: 'shift', shiftMs: ms };
    }
  }
  if (!strip && on('gps')) {
    if ($('#tGpsMode').value === 'set') {
      const lat = parseFloat($('#tLat').value.replace(',', '.')), lon = parseFloat($('#tLon').value.replace(',', '.'));
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return toast('Coordonnées GPS invalides (latitude de -90 à 90, longitude de -180 à 180).', { error: true });
      ch.gps = { mode: 'set', lat, lon };
    } else ch.gps = { mode: 'remove' };
  }
  if (!strip && !Object.keys(ch).length) return toast('Activez au moins une information à modifier.', { error: true });

  const todo = tagFiles.filter(t => t.exif);
  const items = [], errors = [], uniq = uniqueNamer();
  const prog = $('#tagsProgress'), btn = $('#btnTags');
  btn.dataset.busy = '1'; btn.disabled = true; btn.textContent = 'Modification en cours…';
  try {
    for (let i = 0; i < todo.length; i++) {
      const t = todo[i];
      setProgress(prog, i, todo.length, `${i + 1} / ${todo.length} · ${t.file.name}`);
      await nextFrame();
      try {
        const bin = bufToBin(await t.file.arrayBuffer());
        let out;
        if (strip) out = piexif.remove(bin);
        else out = piexif.insert(safeDump(applyTagChanges(JSON.parse(JSON.stringify(t.exif)), ch)), bin);
        const blob = new Blob([binToU8(out)], { type: 'image/jpeg' });
        items.push({ name: uniq(t.file.name), blob });
        t.file = new File([blob], t.file.name, { type: 'image/jpeg' });
        t.exif = readExif(await blob.arrayBuffer()) || t.exif;
      } catch (e) {
        console.error(e);
        errors.push(`${t.file.name} : ${e.message || e}`);
      }
    }
  } finally { delete btn.dataset.busy; prog.hidden = true; }
  renderTagTable();
  showResults($('#tagsResults'), items, errors, items.length ? 'Tags modifiés' : 'Aucune photo modifiée');
  if (items.length === 1) download(items[0].blob, items[0].name);
});

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
loadSettings();
refreshConvOptions();
renderConvList();
renderTagTable();
const lastTab = localStorage.getItem('pb-tab');
if (lastTab && lastTab !== 'conv' && $('#tab-' + lastTab)) showTab(lastTab);
