import * as pdfjsLib from 'pdfjs-dist/build/pdf.min.mjs';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as E from './engine.js';

/* =====================================================================
   Constantes, état
   ===================================================================== */
const PAD = 2;
const STD = {
  helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};
const STD_META = {
  helvetica: { A: 0.905, D: 0.212, css: 'Helvetica, Arial, "Liberation Sans", Arimo, sans-serif', label: 'Helvetica / Arial' },
  times: { A: 0.891, D: 0.216, css: '"Times New Roman", Times, "Liberation Serif", Tinos, serif', label: 'Times' },
  courier: { A: 0.833, D: 0.3, css: '"Courier New", Courier, "Liberation Mono", Cousine, monospace', label: 'Courier' },
};

const S = {
  name: 'document.pdf', origBytes: null, origDoc: null, pdf: null,
  pages: [], cur: 0, zoom: 1, tool: 'select',
  objs: [], analysis: [], lines: [], sel: null, editing: null,
  undo: [], redo: [], fonts: [], assets: {}, seq: 1,
  baseSig: '', rebuildSeq: 0, renderSeq: 0, canvasScale: 1, ghosts: new Set(), modified: false,
};
window.__pdfEditor = { S };

const $ = (s, r = document) => r.querySelector(s);
const stage = $('#stage'), cv = $('#cv'), wrap = $('#pagewrap'), work = $('#work');
const selEl = $('#sel'), hoverEl = $('#hover'), propsEl = $('#props');

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'value') e.value = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const r1 = (v) => Math.round(v * 10) / 10;
const uid = (p) => p + (S.seq++).toString(36) + Math.random().toString(36).slice(2, 5);
let toastT;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}

/* =====================================================================
   Polices
   ===================================================================== */
const MF = {}; // PDFFont de mesure (clé -> PDFFont)
let measureDoc;
async function initMeasure() {
  measureDoc = await PDFDocument.create();
  measureDoc.registerFontkit(fontkit);
  for (const fam of Object.keys(STD)) {
    for (let k = 0; k < 4; k++) MF[fam + (k & 1 ? 'B' : '') + (k & 2 ? 'I' : '')] = await measureDoc.embedFont(StandardFonts[STD[fam][k]]);
  }
}
const fkey = (f) => (f.fam.startsWith('f:') ? f.fam : f.fam + (f.b ? 'B' : '') + (f.i ? 'I' : ''));
function fontInfo(f) {
  if (f.fam.startsWith('f:')) {
    const cf = S.fonts.find((x) => 'f:' + x.id === f.fam);
    if (cf) return { A: cf.A, D: cf.D, css: `"cf_${cf.id}"`, weight: 400, style: 'normal' };
  }
  const m = STD_META[f.fam] || STD_META.helvetica;
  return { A: m.A, D: m.D, css: m.css, weight: f.b ? 700 : 400, style: f.i ? 'italic' : 'normal' };
}
const fontOf = (o) => MF[fkey(o.font)] || MF.helvetica;
const charSets = new Map();
function safeText(o, text) {
  const f = fontOf(o);
  let cs = charSets.get(f);
  if (!cs) { cs = new Set(f.getCharacterSet()); charSets.set(f, cs); }
  let out = '', bad = 0;
  for (const ch of text) {
    if (ch === '\n' || cs.has(ch.codePointAt(0))) out += ch;
    else if (ch === ' ' || ch === '\t') out += cs.has(32) ? ' ' : '?';
    else { out += '?'; bad++; }
  }
  return { text: out, bad };
}
async function addFontFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kf = fontkit.create(bytes);
    const id = uid('f');
    const upm = kf.unitsPerEm || 1000;
    const name = kf.fullName || kf.familyName || file.name;
    const ff = new FontFace('cf_' + id, bytes);
    await ff.load(); document.fonts.add(ff);
    MF['f:' + id] = await measureDoc.embedFont(bytes, { subset: false });
    S.fonts.push({ id, name, bytes, A: kf.ascent / upm, D: -kf.descent / upm });
    toast(`Police ajoutée : ${name}`);
    return 'f:' + id;
  } catch (e) {
    console.error(e); toast('Police illisible (formats pris en charge : TTF, OTF).');
    return null;
  }
}

/* =====================================================================
   Mise en page du texte (identique pour l'aperçu et l'export)
   ===================================================================== */
function layout(o) {
  const mf = fontOf(o), size = o.size, lh = size * (o.lh || 1.2);
  const { text } = safeText(o, o.text || '');
  const maxW = o.autoW ? Infinity : Math.max(10, o.w - 2 * PAD);
  const lines = [];
  for (const para of text.split('\n')) {
    if (maxW === Infinity) { lines.push(para); continue; }
    let cur = '';
    for (const word of para.split(/(?<= )/)) {
      const test = cur + word;
      if (cur && mf.widthOfTextAtSize(test.trimEnd(), size) > maxW) { lines.push(cur.trimEnd()); cur = word; } else cur = test;
      while (cur.length > 1 && mf.widthOfTextAtSize(cur.trimEnd(), size) > maxW) {
        let k = cur.length - 1;
        while (k > 1 && mf.widthOfTextAtSize(cur.slice(0, k), size) > maxW) k--;
        lines.push(cur.slice(0, k)); cur = cur.slice(k);
      }
    }
    lines.push(cur.trimEnd());
  }
  const ws = lines.map((t) => mf.widthOfTextAtSize(t, size));
  const innerW = o.autoW ? Math.max(size * 0.6, ...ws) : maxW;
  return { lines, ws, lh, innerW, w: innerW + 2 * PAD, h: lines.length * lh + 2 * PAD };
}
function baselineOff(o) {
  const fi = fontInfo(o.font), lh = o.size * (o.lh || 1.2);
  return (lh - (fi.A + fi.D) * o.size) / 2 + fi.A * o.size;
}
function normalize(o) {
  if (o.type !== 'text') return;
  const L = layout(o);
  if (o.autoW) o.w = L.w;
  o.h = Math.max(L.h, o.minH || 0);
}
const ALIGN = { left: 0, center: 0.5, right: 1 };

/* =====================================================================
   Rendu de l'objet dans la scène (unités = points, la scène est mise à l'échelle)
   ===================================================================== */
function objEl(o) {
  const d = h('div', { class: 'obj ' + o.type, 'data-id': o.id });
  d.style.cssText = `left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px;`;
  if (o.type === 'text') {
    const L = layout(o), fi = fontInfo(o.font);
    if (o.fill) d.style.background = o.fill;
    if (o.stroke && o.sw) d.style.boxShadow = `inset 0 0 0 ${o.sw}px ${o.stroke}`;
    L.lines.forEach((t, i) => {
      const left = PAD + (L.innerW - L.ws[i]) * (ALIGN[o.align] || 0);
      const ln = h('div', { class: 'ln' }, t);
      ln.style.cssText = `left:${left}px;top:${PAD + i * L.lh}px;font:${fi.style} ${fi.weight} ${o.size}px/${L.lh}px ${fi.css};color:${o.color};`;
      d.append(ln);
    });
  } else if (o.type === 'rect' || o.type === 'ellipse') {
    if (o.fill) d.style.background = hexA(o.fill, o.fop ?? 1);
    if (o.stroke && o.sw) d.style.boxShadow = `inset 0 0 0 ${o.sw}px ${o.stroke}`;
    if (o.type === 'ellipse') d.style.borderRadius = '50%';
  } else if (o.type === 'image') {
    const a = S.assets[o.assetId];
    d.style.opacity = o.op ?? 1;
    d.append(h('img', { src: a.url, draggable: 'false' }));
  } else if (o.type === 'pdfimage') {
    if (S.ghosts.has(o.id)) {
      const c = document.createElement('canvas'), k = S.canvasScale;
      c.width = Math.max(1, Math.round(o.ow * k)); c.height = Math.max(1, Math.round(o.oh * k));
      c.getContext('2d').drawImage(cv, o.ox * k, o.oy * k, o.ow * k, o.oh * k, 0, 0, c.width, c.height);
      d.append(c);
    }
  }
  return d;
}
function hexA(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function hexRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const pdfColor = (hex) => { const [r, g, b] = hexRgb(hex); return rgb(r / 255, g / 255, b / 255); };

function drawStage() {
  stage.querySelectorAll('.obj,.mask,textarea.edit').forEach((n) => n.remove());
  for (const o of S.objs[S.cur] || []) {
    if (o.deleted) continue;
    if (o.rm && o.maskNeeded) {
      const m = h('div', { class: 'mask' });
      const d = o.rm.disp;
      m.style.cssText = `left:${d.x}px;top:${d.y}px;width:${d.w}px;height:${d.h}px;background:${o.rm.bg};`;
      stage.insertBefore(m, hoverEl);
    }
    stage.insertBefore(objEl(o), hoverEl);
  }
  if (S.editing) startEditDom(S.editing);
  updateSel();
}
function refreshObj(o) {
  const old = stage.querySelector(`.obj[data-id="${o.id}"]`);
  const ne = objEl(o);
  if (old) old.replaceWith(ne); else stage.insertBefore(ne, hoverEl);
  updateSel();
}

/* =====================================================================
   Sélection
   ===================================================================== */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const curObj = () => (S.objs[S.cur] || []).find((o) => o.id === S.sel && !o.deleted);
function hpos(o, hd) {
  const x = hd.includes('w') ? o.x : hd.includes('e') ? o.x + o.w : o.x + o.w / 2;
  const y = hd.includes('n') ? o.y : hd.includes('s') ? o.y + o.h : o.y + o.h / 2;
  return [x, y];
}
function updateSel() {
  const o = curObj();
  stage.style.setProperty('--iz', 1 / S.zoom);
  if (!o) { selEl.style.display = 'none'; return; }
  selEl.style.display = 'block';
  selEl.style.cssText = `display:block;left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px;`;
  selEl.innerHTML = '';
  if (S.editing) return;
  for (const hd of HANDLES) {
    const [x, y] = hpos(o, hd);
    const i = document.createElement('i');
    i.style.left = x - o.x + 'px'; i.style.top = y - o.y + 'px';
    selEl.append(i);
  }
}
function select(id) {
  if (S.sel === id) return;
  const prev = curObj();
  S.sel = id;
  if (prev && prev.rm && !prev.dirty && prev.text === prev.orig) { removeObj(prev); scheduleRebuild(); }
  updateSel(); renderProps();
}
function removeObj(o) {
  const arr = S.objs[S.cur];
  const i = arr.indexOf(o);
  if (i >= 0) arr.splice(i, 1);
  if (S.sel === o.id) S.sel = null;
  drawStage();
}
function deleteSel() {
  const o = curObj(); if (!o) return;
  if (S.editing) endEdit(true);
  if (o.type === 'pdfimage') { o.deleted = true; S.sel = null; }
  else removeObj(o);
  drawStage(); renderProps(); commit(); scheduleRebuild();
}
function reorder(o, dir) {
  const arr = S.objs[S.cur], i = arr.indexOf(o);
  const first = arr.findIndex((x) => x.type !== 'pdfimage');
  arr.splice(i, 1);
  if (dir === 'front') arr.push(o); else arr.splice(Math.max(first < 0 ? 0 : first, 0), 0, o);
  drawStage(); commit();
}
function duplicate() {
  const o = curObj(); if (!o || o.type === 'pdfimage') return;
  const c = JSON.parse(JSON.stringify(o));
  c.id = uid('o'); c.x += 12; c.y += 12; delete c.rm; delete c.maskNeeded; delete c.orig;
  S.objs[S.cur].push(c); S.sel = c.id;
  drawStage(); renderProps(); commit();
}

/* =====================================================================
   Édition de texte (zone de saisie)
   ===================================================================== */
function startEditDom(o) {
  const el = stage.querySelector(`.obj[data-id="${o.id}"]`);
  if (el) el.querySelectorAll('.ln').forEach((n) => { n.style.visibility = 'hidden'; });
  const ta = h('textarea', { class: 'edit', spellcheck: 'false' });
  ta.value = o.text;
  stage.insertBefore(ta, hoverEl);
  S.ta = ta;
  styleTa(o);
  ta.addEventListener('input', () => {
    o.text = ta.value; o.dirty = true; normalize(o); styleTa(o); updateSel();
    const el2 = stage.querySelector(`.obj[data-id="${o.id}"]`);
    if (el2) { el2.style.width = o.w + 'px'; el2.style.height = o.h + 'px'; }
  });
  ta.addEventListener('blur', () => endEdit());
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); ta.blur(); }
  });
  ta.focus({ preventScroll: true });
}
function styleTa(o) {
  const ta = S.ta; if (!ta) return;
  const fi = fontInfo(o.font), lh = o.size * (o.lh || 1.2);
  ta.style.cssText = `left:${o.x}px;top:${o.y}px;width:${o.w + (o.autoW ? o.size * 1.5 : 0)}px;height:${o.h}px;padding:${PAD}px;` +
    `font:${fi.style} ${fi.weight} ${o.size}px/${lh}px ${fi.css};color:${o.color};text-align:${o.align || 'left'};` +
    `background:${o.fill || 'transparent'};white-space:${o.autoW ? 'pre' : 'pre-wrap'};overflow-wrap:anywhere;`;
}
function startEdit(o) {
  if (S.editing === o) return;
  endEdit();
  S.editing = o;
  select(o.id);
  drawStage();
  const ta = S.ta;
  if (ta) { ta.setSelectionRange(ta.value.length, ta.value.length); }
}
function endEdit(silent) {
  const o = S.editing; if (!o) return;
  S.editing = null;
  if (S.ta) { const t = S.ta; S.ta = null; t.remove(); }
  if (o.text === '' && !o.rm) { removeObj(o); S.sel = null; }
  else if (o.rm && o.text === '' && !o.dirty) { /* sera annulé à la désélection */ }
  if (!silent) { drawStage(); renderProps(); if (o.dirty) commit(); }
}

/* =====================================================================
   Historique
   ===================================================================== */
function snapJSON() { return JSON.stringify(S.objs); }
function commit() {
  const j = snapJSON();
  if (S.undo.length && S.undo[S.undo.length - 1] === j) return;
  S.undo.push(j); S.redo = []; S.modified = true;
  if (S.undo.length > 100) S.undo.shift();
  updateTop(); scheduleRebuild();
}
async function restore(j) {
  endEdit(true);
  S.objs = JSON.parse(j); S.sel = null;
  await ensureImgs(S.cur);
  drawStage(); renderProps(); updateTop(); scheduleRebuild(true);
}
function undo() { if (S.undo.length > 1) { S.redo.push(S.undo.pop()); restore(S.undo[S.undo.length - 1]); } }
function redo() { if (S.redo.length) { const j = S.redo.pop(); S.undo.push(j); restore(j); } }

/* =====================================================================
   Analyse des images (contenu d'origine) et lignes de texte
   ===================================================================== */
async function getAnalysis(pi) {
  if (S.analysis[pi]) return S.analysis[pi];
  let an;
  try {
    const pg = S.origDoc.getPages()[pi];
    an = E.analyze(S.origDoc, pg, [S.pages[pi].w, S.pages[pi].h]);
  } catch (e) { console.warn('analyse impossible', e); an = { placements: [], shows: [], src: '', depthEnd: 0 }; }
  S.analysis[pi] = an;
  return an;
}
async function ensureImgs(pi) {
  const an = await getAnalysis(pi);
  const vp = S.pages[pi].vp, arr = S.objs[pi];
  for (const p of an.placements) {
    const id = `pi${pi}_${p.idx}`;
    if (arr.some((o) => o.id === id)) continue;
    const [x0, y0, x1, y1] = p.bbox;
    const a = vp.convertToViewportPoint(x0, y0), b = vp.convertToViewportPoint(x1, y1);
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]), hh = Math.abs(a[1] - b[1]);
    if (w < 2 || hh < 2) continue;
    arr.unshift({ id, type: 'pdfimage', idx: p.idx, kind: p.kind, x, y, w, h: hh, ox: x, oy: y, ow: w, oh: hh, deleted: false });
  }
}

function guessFont(raw, info) {
  const n = (raw || '').replace(/^[A-Z]{6}\+/, '').toLowerCase();
  const bold = /bold|black|heavy|demi|semibold|-bd|,bd/.test(n) || !!(info && (info.bold || info.black));
  const italic = /italic|oblique|-it\b|,it\b|ital/.test(n) || !!(info && info.italic);
  let fam = 'helvetica';
  if (/courier|mono|consolas|menlo|typewriter|lucidaconsole/.test(n) || (info && info.isMonospace)) fam = 'courier';
  else if (/times|georgia|garamond|palatino|minion|cambria|roman|century|bookman|baskerville|serif/.test(n) && !/sans/.test(n)) fam = 'times';
  else if (info && info.isSerifFont && !/arial|helvet|calibri|verdana|tahoma|sans/.test(n)) fam = 'times';
  // police personnalisée de même nom ?
  const cf = S.fonts.find((f) => n && f.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(n.replace(/[^a-z0-9]/g, '').replace(/(bold|italic|regular|mt|ps)/g, '')));
  if (cf) return { fam: 'f:' + cf.id, b: false, i: false };
  return { fam, b: bold, i: italic };
}

async function computeLines() {
  S.lines[S.cur] = [];
  try {
    const page = await S.pdf.getPage(S.cur + 1);
    const tc = await page.getTextContent();
    const vp = S.pages[S.cur].vp;
    S.pageProxy = page;
    if (vp.rotation) return; // page pivotée : le texte d'origine n'est pas modifiable
    const lines = [];
    let last = null;
    for (const it of tc.items) {
      if (!it.str || !it.transform) continue;
      const t = it.transform;
      if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) { last = null; continue; }
      const size = Math.abs(t[3]);
      if (size < 1) continue;
      const e = t[4], f = t[5], x1 = e + it.width;
      if (last && last.fontName === it.fontName && Math.abs(last.size - size) < 0.2 && Math.abs(last.f - f) < 0.6) {
        const gap = e - last.x1;
        if (gap > -size * 0.3 && gap < size * 1.0) {
          if (gap > size * 0.15 && !last.str.endsWith(' ') && !it.str.startsWith(' ')) last.str += ' ';
          last.str += it.str; last.x1 = x1; continue;
        }
      }
      last = { str: it.str, e, f, x1, size, fontName: it.fontName };
      lines.push(last);
    }
    S.lines[S.cur] = lines.filter((l) => l.str.trim()).map((l) => {
      const a = vp.convertToViewportPoint(l.e, l.f), b = vp.convertToViewportPoint(l.x1, l.f);
      const base = a[1], x = Math.min(a[0], b[0]), w = Math.abs(b[0] - a[0]);
      return { ...l, dx: x, dw: w, base, rect: { x: x - 1, y: base - l.size * 0.88, w: w + 2, h: l.size * 1.15 } };
    });
    S.pageProxy = page;
  } catch (e) { console.warn(e); }
}
function lineAt(x, y) {
  for (const l of S.lines[S.cur] || []) {
    const r = l.rect;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      if ((S.objs[S.cur] || []).some((o) => o.rm && !o.deleted && Math.abs(o.rm.y - l.f) < 0.6 && l.e < o.rm.x1 && l.x1 > o.rm.x0)) continue;
      return l;
    }
  }
  return null;
}

function sampleColors(r) {
  const k = S.canvasScale, ctx = cv.getContext('2d');
  const x = Math.max(0, Math.floor((r.x) * k)), y = Math.max(0, Math.floor(r.y * k));
  const w = Math.max(2, Math.min(cv.width - x, Math.ceil(r.w * k))), hh = Math.max(2, Math.min(cv.height - y, Math.ceil(r.h * k)));
  const d = ctx.getImageData(x, y, w, hh).data;
  // fond = couleur la plus fréquente sur le pourtour
  const cnt = new Map();
  const at = (px, py) => { const i = (py * w + px) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const add = (c) => { const key = (c[0] >> 3) + ',' + (c[1] >> 3) + ',' + (c[2] >> 3); const e = cnt.get(key) || { n: 0, c }; e.n++; cnt.set(key, e); };
  for (let i = 0; i < w; i++) { add(at(i, 0)); add(at(i, hh - 1)); }
  for (let j = 0; j < hh; j++) { add(at(0, j)); add(at(w - 1, j)); }
  let bg = [255, 255, 255], best = 0;
  for (const e of cnt.values()) if (e.n > best) { best = e.n; bg = e.c; }
  const dist = (c) => (c[0] - bg[0]) ** 2 + (c[1] - bg[1]) ** 2 + (c[2] - bg[2]) ** 2;
  const px = [];
  for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) px.push(at(i, j));
  px.sort((a, b) => dist(b) - dist(a));
  const top = px.slice(0, Math.max(1, Math.floor(px.length * 0.03)));
  const fg = [0, 1, 2].map((c) => Math.round(top.reduce((s, p) => s + p[c], 0) / top.length));
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  return { bg: hex(bg), fg: dist(fg) < 600 ? '#000000' : hex(fg) };
}

function startEditLine(l) {
  const font = guessFont(l.rawName || fontNameOf(l.fontName), fontObjOf(l.fontName));
  const cols = sampleColors(l.rect);
  const o = {
    id: uid('o'), type: 'text', x: 0, y: 0, w: 10, h: 10, text: l.str, orig: l.str, font, size: r1(l.size * 100) / 100,
    color: cols.fg, align: 'left', lh: 1.2, autoW: true, fill: null, stroke: null, sw: 0, dirty: false,
    rm: { x0: l.e, x1: l.x1, y: l.f, size: l.size, bg: cols.bg, disp: { x: l.rect.x - 0.5, y: l.rect.y, w: l.rect.w + 1, h: l.rect.h } },
    maskNeeded: true,
  };
  o.x = l.dx - PAD; o.y = l.base - baselineOff(o) - PAD;
  normalize(o);
  S.objs[S.cur].push(o);
  scheduleRebuild();
  startEdit(o);
}
function fontObjOf(fontName) {
  try { const p = S.pageProxy; if (p && p.commonObjs.has(fontName)) return p.commonObjs.get(fontName); } catch (e) { /* */ }
  return null;
}
function fontNameOf(fontName) { const f = fontObjOf(fontName); return (f && (f.name || f.loadedName)) || ''; }

/* =====================================================================
   Construction du PDF : base (aperçu) et export
   ===================================================================== */
function collectEdits(pi) {
  const vp = S.pages[pi].vp, moves = [], regions = [];
  for (const o of S.objs[pi]) {
    if (o.type === 'pdfimage') {
      if (o.deleted) { moves.push({ idx: o.idx, del: true }); continue; }
      if (Math.abs(o.x - o.ox) > 0.05 || Math.abs(o.y - o.oy) > 0.05 || Math.abs(o.w - o.ow) > 0.05 || Math.abs(o.h - o.oh) > 0.05) {
        const a = vp.convertToPdfPoint(o.x, o.y), b = vp.convertToPdfPoint(o.x + o.w, o.y + o.h);
        moves.push({ idx: o.idx, bbox: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
      }
    } else if (o.rm) regions.push({ id: o.id, ...o.rm });
  }
  return { moves, regions };
}
function editSig() {
  return JSON.stringify(S.objs.map((_, pi) => { const e = collectEdits(pi); return [e.moves, e.regions.map((r) => [r.id, r.x0, r.x1, r.y, r.size])]; }));
}

async function buildPdf(draw) {
  const doc = await PDFDocument.load(S.origBytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const pages = doc.getPages();
  const removed = {};
  const fcache = {}, icache = {};
  const getFont = async (f) => {
    const k = fkey(f);
    if (fcache[k]) return fcache[k];
    if (k.startsWith('f:')) {
      const cf = S.fonts.find((x) => 'f:' + x.id === k);
      return (fcache[k] = await doc.embedFont(cf.bytes, { subset: true }));
    }
    return (fcache[k] = await doc.embedFont(StandardFonts[STD[f.fam][(f.b ? 1 : 0) + (f.i ? 2 : 0)]]));
  };
  for (let pi = 0; pi < pages.length; pi++) {
    const arr = S.objs[pi] || [];
    const edits = collectEdits(pi);
    const drawables = draw ? arr.filter((o) => !o.deleted && (o.type === 'rect' || o.type === 'ellipse' || o.type === 'image' || o.type === 'text')) : [];
    if (!edits.moves.length && !edits.regions.length && !drawables.length) continue;
    const an = await getAnalysis(pi);
    const page = pages[pi];
    if (an.src !== undefined && (an.src || edits.moves.length || edits.regions.length)) {
      const res = E.patch(an, edits);
      E.writeContents(doc, page, res.bytes);
      Object.assign(removed, res.removed);
    }
    const vp = S.pages[pi].vp, rot = vp.rotation || 0;
    const P = (x, y) => vp.convertToPdfPoint(x, y);
    const rectBox = (x, y, w, hh) => {
      const a = P(x, y), b = P(x + w, y + hh);
      return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
    };
    for (const o of drawables) {
      if (o.rm && o.maskNeeded) {
        const d = o.rm.disp;
        page.drawRectangle({ ...rectBox(d.x, d.y, d.w, d.h), color: pdfColor(o.rm.bg), borderWidth: 0 });
      }
      if (o.type === 'rect' || o.type === 'ellipse' || (o.type === 'text' && (o.fill || (o.stroke && o.sw)))) {
        const b = rectBox(o.x, o.y, o.w, o.h);
        const opts = {
          color: o.fill ? pdfColor(o.fill) : undefined, opacity: o.fill ? (o.fop ?? 1) : 0,
          borderColor: o.stroke && o.sw ? pdfColor(o.stroke) : undefined, borderWidth: o.stroke && o.sw ? o.sw : 0, borderOpacity: 1,
        };
        if (o.type === 'ellipse') {
          page.drawEllipse({ x: b.x + b.width / 2, y: b.y + b.height / 2, xScale: b.width / 2, yScale: b.height / 2, ...opts });
        } else page.drawRectangle({ ...b, ...opts });
      }
      if (o.type === 'image') {
        const a = S.assets[o.assetId];
        const img = icache[o.assetId] || (icache[o.assetId] = a.mime === 'image/jpeg' ? await doc.embedJpg(a.bytes) : await doc.embedPng(a.bytes));
        const bl = P(o.x, o.y + o.h);
        page.drawImage(img, { x: bl[0], y: bl[1], width: o.w, height: o.h, rotate: degrees(rot), opacity: o.op ?? 1 });
      }
      if (o.type === 'text') {
        const font = await getFont(o.font), L = layout(o), off = baselineOff(o);
        L.lines.forEach((t, i) => {
          if (!t) return;
          const left = o.x + PAD + (L.innerW - L.ws[i]) * (ALIGN[o.align] || 0);
          const p = P(left, o.y + PAD + i * L.lh + off);
          page.drawText(t, { x: p[0], y: p[1], size: o.size, font, color: pdfColor(o.color), rotate: degrees(rot) });
        });
      }
    }
  }
  return { bytes: await doc.save(), removed };
}

let rebuildTimer;
function scheduleRebuild(force) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuildBase(force), 120);
}
async function rebuildBase(force) {
  if (!S.pdf) return;
  const sig = editSig();
  if (sig === S.baseSig && !force) return;
  const my = ++S.rebuildSeq;
  $('#busy').hidden = false;
  try {
    const { bytes, removed } = await buildPdf(false);
    if (my !== S.rebuildSeq) return;
    for (const arr of S.objs) for (const o of arr) if (o.rm && o.id in removed) o.maskNeeded = removed[o.id] === 0;
    const oldTask = S.task;
    const task = pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true });
    S.pdf = await task.promise; S.task = task;
    S.baseSig = sig;
    if (oldTask) oldTask.destroy();
    await renderCanvas();
    S.ghosts.clear();
    await computeLines();
    if (!S.editing) drawStage(); else stage.querySelectorAll('.mask').forEach((n) => n.remove()), rebuildMasksOnly();
    renderThumb(S.cur);
  } catch (e) { console.error(e); toast('Erreur de mise à jour : ' + e.message); }
  if (my === S.rebuildSeq) $('#busy').hidden = true;
}
function rebuildMasksOnly() {
  for (const o of S.objs[S.cur]) {
    if (o.rm && o.maskNeeded && !o.deleted) {
      const m = h('div', { class: 'mask' }), d = o.rm.disp;
      m.style.cssText = `left:${d.x}px;top:${d.y}px;width:${d.w}px;height:${d.h}px;background:${o.rm.bg};`;
      stage.insertBefore(m, stage.firstChild);
    }
  }
}

/* =====================================================================
   Rendu de la page, vignettes, zoom
   ===================================================================== */
async function renderCanvas() {
  const seq = ++S.renderSeq;
  const page = await S.pdf.getPage(S.cur + 1);
  const pg = S.pages[S.cur];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale = S.zoom * dpr;
  const maxPx = 36e6;
  if (pg.w * pg.h * scale * scale > maxPx) scale = Math.sqrt(maxPx / (pg.w * pg.h));
  const vp = page.getViewport({ scale });
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
  await page.render({ canvas: off, canvasContext: off.getContext('2d'), viewport: vp }).promise;
  if (seq !== S.renderSeq) return;
  cv.width = off.width; cv.height = off.height;
  cv.getContext('2d').drawImage(off, 0, 0);
  cv.style.width = pg.w * S.zoom + 'px'; cv.style.height = pg.h * S.zoom + 'px';
  S.canvasScale = off.width / pg.w;
  S.pageProxy = page;
}
function applyZoom() {
  const pg = S.pages[S.cur];
  wrap.style.width = pg.w * S.zoom + 'px'; wrap.style.height = pg.h * S.zoom + 'px';
  stage.style.width = pg.w + 'px'; stage.style.height = pg.h + 'px';
  stage.style.transform = `scale(${S.zoom})`;
  stage.style.setProperty('--iz', 1 / S.zoom);
  $('#zInfo').textContent = Math.round(S.zoom * 100) + ' %';
}
let zoomT;
function setZoom(z, immediate) {
  S.zoom = Math.max(0.2, Math.min(5, z));
  applyZoom();
  clearTimeout(zoomT);
  zoomT = setTimeout(() => renderCanvas(), immediate ? 0 : 160);
}
function fit() {
  const pg = S.pages[S.cur];
  setZoom(Math.min(2, (work.clientWidth - 56) / pg.w), true);
}
async function renderThumb(i) {
  const box = $(`.th[data-i="${i}"] canvas`);
  if (!box) return;
  const page = await S.pdf.getPage(i + 1);
  const vp0 = page.getViewport({ scale: 1 });
  const k = 108 / vp0.width, vp = page.getViewport({ scale: k * 2 });
  box.width = vp.width; box.height = vp.height;
  box.style.width = '108px'; box.style.height = vp.height / 2 + 'px';
  await page.render({ canvas: box, canvasContext: box.getContext('2d'), viewport: vp }).promise;
}
async function buildThumbs() {
  const t = $('#thumbs'); t.innerHTML = '';
  for (let i = 0; i < S.pages.length; i++) {
    t.append(h('div', { class: 'th', 'data-i': i, onclick: () => gotoPage(i) }, h('canvas'), h('div', {}, String(i + 1))));
  }
  for (let i = 0; i < S.pages.length; i++) { await renderThumb(i); }
}
function markThumb() {
  document.querySelectorAll('.th').forEach((n) => n.classList.toggle('on', +n.dataset.i === S.cur));
  const t = $(`.th[data-i="${S.cur}"]`); if (t) t.scrollIntoView({ block: 'nearest' });
}
async function gotoPage(i) {
  if (i < 0 || i >= S.pages.length) return;
  endEdit(true);
  select(null);
  S.cur = i;
  await ensureImgs(i);
  applyZoom();
  await renderCanvas();
  await computeLines();
  drawStage(); renderProps(); markThumb(); updateTop();
}

/* =====================================================================
   Ouverture / enregistrement
   ===================================================================== */
async function openBytes(bytes, name) {
  try {
    $('#busy').hidden = false;
    const origDoc = await PDFDocument.load(bytes, { updateMetadata: false });
    const task = pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true });
    const pdf = await task.promise;
    if (S.task) S.task.destroy();
    Object.assign(S, {
      task,
      name, origBytes: bytes, origDoc, pdf, cur: 0, objs: [], analysis: [], lines: [], sel: null, editing: null,
      undo: [], redo: [], baseSig: '', modified: false, pages: [],
    });
    for (let i = 0; i < pdf.numPages; i++) {
      const p = await pdf.getPage(i + 1);
      const vp = p.getViewport({ scale: 1 });
      S.pages.push({ w: vp.width, h: vp.height, vp });
      S.objs.push([]);
    }
    await ensureImgs(0);
    $('#empty').hidden = true; wrap.hidden = false; work.classList.remove('noDoc');
    S.baseSig = editSig();
    S.undo = [snapJSON()];
    S.zoom = Math.min(2, (work.clientWidth - 56) / S.pages[0].w);
    applyZoom();
    await renderCanvas(); await computeLines();
    drawStage(); renderProps(); updateTop();
    buildThumbs().then(markThumb);
    setTool('text');
  } catch (e) {
    console.error(e);
    toast(/encrypt/i.test(e.message) ? 'Ce PDF est protégé par mot de passe : il ne peut pas être modifié ici.' : 'Impossible d\'ouvrir ce PDF : ' + e.message, 6000);
  }
  $('#busy').hidden = true;
}
async function save() {
  endEdit();
  $('#busy').hidden = false;
  try {
    const { bytes } = await buildPdf(true);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = h('a', { href: url, download: S.name.replace(/\.pdf$/i, '') + '-modifié.pdf' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    S.modified = false;
    toast('PDF enregistré.');
  } catch (e) { console.error(e); toast('Échec de l\'export : ' + e.message, 6000); }
  $('#busy').hidden = true;
}
function updateTop() {
  const has = !!S.pdf;
  $('#btnSave').disabled = !has;
  $('#btnUndo').disabled = S.undo.length < 2;
  $('#btnRedo').disabled = !S.redo.length;
  $('#btnPrev').disabled = !has || S.cur <= 0;
  $('#btnNext').disabled = !has || S.cur >= S.pages.length - 1;
  $('#pageInfo').textContent = has ? `${S.cur + 1} / ${S.pages.length}` : '–';
}

/* =====================================================================
   Outils & interactions
   ===================================================================== */
function setTool(t) {
  endEdit();
  S.tool = t;
  document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  stage.className = 't-' + t;
  hoverEl.style.display = 'none';
  if (t === 'image') { $('#imgIn').click(); }
  renderProps();
}
function ptr(e) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
}
function hitObj(x, y) {
  const arr = S.objs[S.cur] || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const o = arr[i];
    if (o.deleted) continue;
    if (o.type === 'pdfimage' && S.tool !== 'select') continue;
    if (x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h) return o;
  }
  return null;
}
function hitHandle(x, y) {
  const o = curObj(); if (!o || S.editing) return null;
  const hs = 8 / S.zoom;
  for (const hd of HANDLES) {
    const [hx, hy] = hpos(o, hd);
    if (Math.abs(x - hx) <= hs && Math.abs(y - hy) <= hs) return hd;
  }
  return null;
}
const CURS = { n: 'ns', s: 'ns', e: 'ew', w: 'ew', ne: 'nesw', sw: 'nesw', nw: 'nwse', se: 'nwse' };
let drag = null;

stage.addEventListener('mousedown', (e) => { if (e.target !== S.ta) e.preventDefault(); });
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !S.pdf) return;
  const p = ptr(e);
  if (S.editing && e.target === S.ta) return;
  if (S.editing) endEdit();
  stage.setPointerCapture(e.pointerId);
  const hd = hitHandle(p.x, p.y);
  if (hd && S.tool === 'select') {
    const o = curObj();
    drag = { kind: 'resize', hd, o, p0: p, start: { x: o.x, y: o.y, w: o.w, h: o.h }, moved: false };
    return;
  }
  if (S.tool === 'text') {
    const o = hitObj(p.x, p.y);
    if (o && o.type === 'text') { select(o.id); startEdit(o); return; }
    const l = lineAt(p.x, p.y);
    if (l) { startEditLine(l); return; }
    select(null);
    drag = { kind: 'newtext', p0: p, moved: false };
    return;
  }
  if (S.tool === 'rect' || S.tool === 'ellipse') {
    select(null);
    drag = { kind: 'newshape', p0: p, moved: false };
    return;
  }
  // sélection
  const o = hitObj(p.x, p.y);
  if (!o) {
    const l = lineAt(p.x, p.y);
    if (l) { startEditLine(l); return; }
    select(null); return;
  }
  select(o.id);
  if (e.detail === 2 && o.type === 'text') { startEdit(o); return; }
  drag = { kind: 'move', o, p0: p, start: { x: o.x, y: o.y }, moved: false };
});

stage.addEventListener('pointermove', (e) => {
  const p = ptr(e);
  if (!drag) {
    // survol
    let cursor = '';
    hoverEl.style.display = 'none';
    const hd = S.tool === 'select' ? hitHandle(p.x, p.y) : null;
    if (hd) cursor = CURS[hd] + '-resize';
    else if (S.tool === 'text') {
      const o = hitObj(p.x, p.y);
      const l = !o && lineAt(p.x, p.y);
      if (l) { showHover(l.rect); cursor = 'text'; }
    } else if (S.tool === 'select') {
      const o = hitObj(p.x, p.y);
      if (o) { cursor = 'move'; if (o.type === 'pdfimage') showHover(o); }
      else { const l = lineAt(p.x, p.y); if (l) { showHover(l.rect); cursor = 'text'; } }
    }
    stage.style.cursor = cursor;
    return;
  }
  const dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
  if (!drag.moved && Math.hypot(dx, dy) * S.zoom < 3) return;
  drag.moved = true;
  const pg = S.pages[S.cur];
  if (drag.kind === 'move') {
    const o = drag.o;
    if (o.type === 'pdfimage' && !S.ghosts.has(o.id)) { S.ghosts.add(o.id); }
    o.x = drag.start.x + dx; o.y = drag.start.y + dy; o.dirty = true;
    refreshObj(o);
  } else if (drag.kind === 'resize') {
    resizeObj(drag.o, drag.hd, dx, dy, drag.start, e.shiftKey);
    refreshObj(drag.o);
  } else if (drag.kind === 'newtext' || drag.kind === 'newshape') {
    const x = Math.min(drag.p0.x, p.x), y = Math.min(drag.p0.y, p.y), w = Math.abs(dx), hh = Math.abs(dy);
    drag.rect = { x, y, w, h: hh };
    hoverEl.style.display = 'block';
    hoverEl.style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${hh}px;`;
  }
});

function showHover(r) {
  hoverEl.style.cssText = `display:block;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;`;
}

function resizeObj(o, hd, dx, dy, st, keep) {
  let { x, y, w, h: hh } = st;
  if (hd.includes('w')) { x = st.x + dx; w = st.w - dx; }
  if (hd.includes('e')) w = st.w + dx;
  if (hd.includes('n')) { y = st.y + dy; hh = st.h - dy; }
  if (hd.includes('s')) hh = st.h + dy;
  const ratioLock = (o.type === 'image' || o.type === 'pdfimage') ? !keep : keep;
  if (ratioLock && hd.length === 2) {
    const ratio = st.w / st.h;
    const nw = Math.max(8, w), nh = nw / ratio;
    if (hd.includes('n')) y = st.y + st.h - nh;
    if (hd.includes('w')) x = st.x + st.w - nw;
    w = nw; hh = nh;
  }
  if (w < 8) { if (hd.includes('w')) x -= 8 - w; w = 8; }
  if (hh < 8) { if (hd.includes('n')) y -= 8 - hh; hh = 8; }
  o.x = x; o.y = y; o.w = w; o.h = hh; o.dirty = true;
  if (o.type === 'text') { o.autoW = false; if (hd.includes('n') || hd.includes('s')) o.minH = hh; normalize(o); }
}

stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null;
  hoverEl.style.display = 'none';
  const p = ptr(e);
  if (d.kind === 'move' || d.kind === 'resize') {
    if (d.moved) { drawStage(); renderProps(); commit(); }
  } else if (d.kind === 'newtext') {
    const r = d.rect && d.rect.w > 12 ? d.rect : null;
    const o = {
      id: uid('o'), type: 'text', x: r ? r.x : d.p0.x, y: r ? r.y : d.p0.y - 9, w: r ? r.w : 100, h: 20, text: '', font: { fam: 'helvetica', b: false, i: false },
      size: 14, color: '#000000', align: 'left', lh: 1.2, autoW: !r, fill: null, stroke: null, sw: 0, minH: r && r.h > 24 ? r.h : 0,
    };
    normalize(o);
    S.objs[S.cur].push(o);
    startEdit(o);
  } else if (d.kind === 'newshape') {
    const r = d.rect && d.rect.w > 4 && d.rect.h > 4 ? d.rect : { x: d.p0.x - 60, y: d.p0.y - 40, w: 120, h: 80 };
    const o = { id: uid('o'), type: S.tool === 'ellipse' ? 'ellipse' : 'rect', ...r, fill: '#ffe066', fop: 1, stroke: '#1f2937', sw: 1 };
    S.objs[S.cur].push(o);
    S.sel = o.id; setTool('select'); S.sel = o.id;
    drawStage(); renderProps(); commit();
  }
});
stage.addEventListener('dblclick', (e) => {
  const p = ptr(e), o = hitObj(p.x, p.y);
  if (o && o.type === 'text' && S.tool === 'select') startEdit(o);
});

/* =====================================================================
   Images & polices : import
   ===================================================================== */
async function importImage(file) {
  let bytes, mime = file.type, blob = file;
  if (mime !== 'image/png' && mime !== 'image/jpeg') {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    blob = await new Promise((res) => c.toBlob(res, 'image/png')); mime = 'image/png';
  }
  bytes = new Uint8Array(await blob.arrayBuffer());
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const id = uid('a');
  S.assets[id] = { bytes, mime, url: URL.createObjectURL(new Blob([bytes], { type: mime })), w: bmp.width, h: bmp.height };
  const pg = S.pages[S.cur];
  const k = Math.min(1, (pg.w * 0.5) / bmp.width, (pg.h * 0.5) / bmp.height) * (bmp.width > 400 ? 1 : 0.75);
  const w = bmp.width * k * (bmp.width > 400 ? 1 : 1.33), hh = bmp.height * (w / bmp.width);
  const o = { id: uid('o'), type: 'image', assetId: id, x: (pg.w - w) / 2, y: (pg.h - hh) / 2, w, h: hh, op: 1 };
  S.objs[S.cur].push(o);
  setTool('select');
  S.sel = o.id; drawStage(); renderProps(); commit();
}

/* =====================================================================
   Panneau de propriétés
   ===================================================================== */
function numField(label, get, set, opt = {}) {
  const inp = h('input', { type: 'number', step: opt.step ?? 1, min: opt.min, max: opt.max, value: r1(get()) });
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) { set(v); live(); } });
  inp.addEventListener('change', () => { commit(); renderProps(); });
  return h('label', { class: 'f' }, h('span', {}, label), inp);
}
function colorField(label, get, set) {
  const inp = h('input', { type: 'color', value: get() || '#000000' });
  inp.addEventListener('input', () => { set(inp.value); live(); });
  inp.addEventListener('change', () => commit());
  return h('label', { class: 'f' }, h('span', {}, label), inp);
}
function checkField(label, get, set, extra) {
  const inp = h('input', { type: 'checkbox' }); inp.checked = !!get();
  inp.addEventListener('change', () => { set(inp.checked); live(); commit(); renderProps(); });
  return h('label', { class: 'f' }, h('span', { class: 'chk' }, inp, label), extra || '');
}
function live() {
  const o = curObj(); if (!o) return;
  o.dirty = true;
  if (o.type === 'text') normalize(o);
  refreshObj(o);
  if (S.editing === o) { styleTa(o); }
}
function geom(o) {
  return [
    h('h3', {}, 'Position et taille (pt)'),
    numField('X', () => o.x, (v) => { o.x = v; }),
    numField('Y', () => o.y, (v) => { o.y = v; }),
    numField('Largeur', () => o.w, (v) => { o.w = Math.max(4, v); if (o.type === 'text') o.autoW = false; }),
    ...(o.type === 'text' ? [] : [numField('Hauteur', () => o.h, (v) => { o.h = Math.max(4, v); })]),
  ];
}
function orderButtons(o) {
  return h('div', { class: 'row' },
    h('button', { class: 'btn small', onclick: () => reorder(o, 'front') }, 'Premier plan'),
    h('button', { class: 'btn small', onclick: () => reorder(o, 'back') }, 'Arrière-plan'));
}
function actionButtons(o) {
  return h('div', { class: 'row' },
    o.type !== 'pdfimage' ? h('button', { class: 'btn small', onclick: duplicate }, 'Dupliquer') : null,
    h('button', { class: 'btn small danger', onclick: deleteSel }, 'Supprimer'));
}

const put = (...n) => propsEl.append(...n.flat().filter(Boolean));
function renderProps() {
  const o = curObj();
  propsEl.innerHTML = '';
  if (!S.pdf) { put(h('p', { class: 'hint' }, 'Ouvrez un PDF pour commencer.')); return; }
  if (!o) {
    const nl = (S.lines[S.cur] || []).length;
    const rot = S.pages[S.cur] && S.pages[S.cur].vp.rotation;
    put(
      nl === 0 ? h('div', { class: 'warn' }, rot
        ? 'Page pivotée : le texte existant n\'est pas modifiable ici (vous pouvez ajouter du texte, des zones et des images).'
        : 'Aucun texte modifiable détecté sur cette page : elle est probablement scannée (image) ou son texte est vectorisé. Vous pouvez quand même ajouter du texte, des zones et des images.') : null,
      h('h3', {}, 'Aide'),
      h('p', { class: 'hint' }, h('b', {}, 'Texte'), ' : cliquez sur un texte du document pour le modifier (police, taille et couleur sont repris), ou dans le vide pour en ajouter.'),
      h('p', { class: 'hint' }, h('b', {}, 'Sélection'), ' : cliquez une image du document, une zone ou un texte ajouté pour le déplacer ou le redimensionner. Les images du document sont surlignées au survol.'),
      h('p', { class: 'hint' }, 'Raccourcis : ', h('kbd', {}, 'V'), ' ', h('kbd', {}, 'T'), ' ', h('kbd', {}, 'R'), ' ', h('kbd', {}, 'E'), ' ', h('kbd', {}, 'I'), ' · ', h('kbd', {}, 'Suppr'), ' · ', h('kbd', {}, 'Ctrl+Z'), ' / ', h('kbd', {}, 'Ctrl+Y'), ' · flèches pour ajuster · ', h('kbd', {}, 'Ctrl+S'), ' pour enregistrer.'),
      h('h3', {}, 'Polices personnalisées'),
      h('p', { class: 'hint' }, 'Ajoutez un fichier .ttf ou .otf pour l\'utiliser dans vos textes (accents, caractères spéciaux, police de votre charte…). Elle est intégrée au PDF exporté.'),
      ...S.fonts.map((f) => h('div', { class: 'hint' }, '• ' + f.name)),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => { $('#fontIn').dataset.apply = ''; $('#fontIn').click(); } }, 'Ajouter une police…')),
    );
    return;
  }
  if (o.type === 'text') {
    const opts = [];
    for (const fam of Object.keys(STD)) opts.push(h('option', { value: fam }, STD_META[fam].label));
    for (const f of S.fonts) opts.push(h('option', { value: 'f:' + f.id }, f.name));
    const sel = h('select', {}, opts); sel.value = o.font.fam;
    sel.addEventListener('change', () => { o.font.fam = sel.value; live(); commit(); renderProps(); });
    const custom = o.font.fam.startsWith('f:');
    const bold = h('button', { class: o.font.b ? 'on' : '', onclick: () => { o.font.b = !o.font.b; live(); commit(); renderProps(); }, disabled: custom }, h('b', {}, 'G'));
    const ital = h('button', { class: o.font.i ? 'on' : '', onclick: () => { o.font.i = !o.font.i; live(); commit(); renderProps(); }, disabled: custom }, h('i', {}, 'I'));
    const al = h('div', { class: 'seg' }, ...[['left', '⬅'], ['center', '↔'], ['right', '➡']].map(([k, ic]) =>
      h('button', { class: (o.align || 'left') === k ? 'on' : '', title: k, onclick: () => { o.align = k; live(); commit(); renderProps(); } }, ic)));
    const bad = safeText(o, o.text || '').bad;
    put(
      h('h3', {}, o.rm ? 'Texte du document' : 'Texte'),
      h('label', { class: 'f' }, h('span', {}, 'Police'), sel),
      h('div', { class: 'f' }, h('span', {}, 'Style'), h('div', { class: 'seg' }, bold, ital)),
      numField('Taille', () => o.size, (v) => { o.size = Math.max(1, v); }, { step: 0.5, min: 1 }),
      numField('Interligne', () => o.lh || 1.2, (v) => { o.lh = Math.max(0.5, v); }, { step: 0.05, min: 0.5 }),
      colorField('Couleur', () => o.color, (v) => { o.color = v; }),
      h('div', { class: 'f' }, h('span', {}, 'Alignement'), al),
      bad ? h('div', { class: 'warn' }, `${bad} caractère(s) absent(s) de cette police s'affichent « ? ». Ajoutez une police .ttf/.otf couvrant ces caractères.`, h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: async () => { $('#fontIn').dataset.apply = '1'; $('#fontIn').click(); } }, 'Ajouter une police…'))) : null,
      h('h3', {}, 'Fond et bordure'),
      checkField('Fond', () => !!o.fill, (v) => { o.fill = v ? (o.fill || '#ffffff') : null; }, o.fill ? colorField('', () => o.fill, (v) => { o.fill = v; }) : null),
      checkField('Bordure', () => o.stroke && o.sw, (v) => { o.stroke = v ? (o.stroke || '#000000') : null; o.sw = v ? (o.sw || 1) : 0; }, o.stroke && o.sw ? colorField('', () => o.stroke, (v) => { o.stroke = v; }) : null),
      ...geom(o), orderButtons(o), actionButtons(o));
    return;
  }
  if (o.type === 'rect' || o.type === 'ellipse') {
    put(
      h('h3', {}, o.type === 'rect' ? 'Zone rectangulaire' : 'Zone elliptique'),
      checkField('Remplissage', () => !!o.fill, (v) => { o.fill = v ? (o.fill || '#ffe066') : null; }, o.fill ? colorField('', () => o.fill, (v) => { o.fill = v; }) : null),
      o.fill ? h('label', { class: 'f' }, h('span', {}, 'Opacité'), (() => { const r = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: o.fop ?? 1 }); r.addEventListener('input', () => { o.fop = parseFloat(r.value); live(); }); r.addEventListener('change', () => commit()); return r; })()) : null,
      checkField('Contour', () => o.stroke && o.sw, (v) => { o.stroke = v ? (o.stroke || '#1f2937') : null; o.sw = v ? (o.sw || 1) : 0; }, o.stroke && o.sw ? colorField('', () => o.stroke, (v) => { o.stroke = v; }) : null),
      o.stroke && o.sw ? numField('Épaisseur', () => o.sw, (v) => { o.sw = Math.max(0, v); }, { step: 0.5, min: 0 }) : null,
      ...geom(o), orderButtons(o), actionButtons(o));
    return;
  }
  if (o.type === 'image' || o.type === 'pdfimage') {
    put(
      h('h3', {}, o.type === 'image' ? 'Image ajoutée' : 'Image du document'),
      o.type === 'image' ? h('label', { class: 'f' }, h('span', {}, 'Opacité'), (() => { const r = h('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: o.op ?? 1 }); r.addEventListener('input', () => { o.op = parseFloat(r.value); live(); }); r.addEventListener('change', () => commit()); return r; })()) : null,
      h('p', { class: 'hint' }, 'Glissez pour déplacer. Poignées d\'angle : proportions conservées (Maj pour déformer).'),
      ...geom(o),
      o.type === 'pdfimage' ? h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => { o.x = o.ox; o.y = o.oy; o.w = o.ow; o.h = o.oh; drawStage(); renderProps(); commit(); } }, 'Position d\'origine'),
        h('button', { class: 'btn small', onclick: () => { replaceImage = o; $('#imgIn').click(); } }, 'Remplacer…')) : orderButtons(o),
      actionButtons(o));
  }
}
let replaceImage = null;

/* =====================================================================
   Branchements globaux
   ===================================================================== */
$('#btnOpen').onclick = $('#btnOpen2').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
};
$('#imgIn').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  const ro = replaceImage; replaceImage = null;
  if (!f) { if (S.tool === 'image') setTool('select'); return; }
  try {
    if (ro) { // remplacement : supprime l'ancienne, insère la nouvelle à la même place
      await importImage(f);
      const n = curObj();
      if (n) { n.x = ro.x; n.y = ro.y; n.w = ro.w; n.h = ro.h; }
      ro.deleted = true; drawStage(); renderProps(); commit();
    } else await importImage(f);
  } catch (err) { console.error(err); toast('Image illisible.'); }
};
$('#fontIn').onchange = async (e) => {
  const f = e.target.files[0]; const apply = e.target.dataset.apply; e.target.value = '';
  if (!f) return;
  const fam = await addFontFile(f);
  const o = curObj();
  if (fam && apply && o && o.type === 'text') { o.font = { fam, b: false, i: false }; normalize(o); drawStage(); commit(); }
  renderProps();
};
$('#btnSave').onclick = save;
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnPrev').onclick = () => gotoPage(S.cur - 1); $('#btnNext').onclick = () => gotoPage(S.cur + 1);
$('#zIn').onclick = () => setZoom(S.zoom * 1.2); $('#zOut').onclick = () => setZoom(S.zoom / 1.2);
$('#zFit').onclick = () => S.pdf && fit();
document.querySelectorAll('#tools button').forEach((b) => { b.onclick = () => S.pdf && setTool(b.dataset.tool); });
work.classList.add('noDoc');
work.addEventListener('wheel', (e) => {
  if (!S.pdf || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (S.pdf) save(); return; }
  if (inField || !S.pdf) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return; }
  if (mod) return;
  const k = e.key.toLowerCase();
  const map = { v: 'select', t: 'text', r: 'rect', e: 'ellipse', i: 'image' };
  if (map[k]) { setTool(map[k]); return; }
  const o = curObj();
  if (!o) { if (k === 'pagedown') gotoPage(S.cur + 1); if (k === 'pageup') gotoPage(S.cur - 1); return; }
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
  else if (k === 'enter' && o.type === 'text') { e.preventDefault(); startEdit(o); }
  else if (k === 'escape') select(null);
  else if (k.startsWith('arrow')) {
    e.preventDefault();
    const st = e.shiftKey ? 10 : 1;
    if (k === 'arrowleft') o.x -= st; if (k === 'arrowright') o.x += st; if (k === 'arrowup') o.y -= st; if (k === 'arrowdown') o.y += st;
    if (o.type === 'pdfimage') S.ghosts.add(o.id);
    o.dirty = true; refreshObj(o);
    clearTimeout(S.nudgeT); S.nudgeT = setTimeout(() => { renderProps(); commit(); }, 350);
  }
});

// glisser-déposer
const empty = $('#empty');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); empty.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return; empty.classList.remove('drag'); }));
document.addEventListener('drop', async (e) => {
  const f = [...(e.dataTransfer?.files || [])][0];
  if (!f) return;
  if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  else if (f.type.startsWith('image/') && S.pdf) importImage(f);
});
window.addEventListener('beforeunload', (e) => { if (S.modified) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('resize', () => { if (S.pdf) updateSel(); });

// pdf.js : le worker est intégré au bundle (globalThis.pdfjsWorker) : aucune ressource externe.
initMeasure().then(() => { window.__pdfEditor.ready = true; });
renderProps(); updateTop();
Object.assign(window.__pdfEditor, { openBytes, save, buildPdf, setTool, gotoPage, startEditLine, lineAt });
