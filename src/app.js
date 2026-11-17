import * as pdfjsLib from 'pdfjs-dist/build/pdf.min.mjs';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
import { PDFDocument, PDFName, PDFDict, StandardFonts, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as E from './engine.js';
import * as RT from './richtext.js';
import { identify, loadLib, LIB, libLabel } from './fontid.js';
const { IND, MW, listLabels } = RT;

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
  objs: [], analysis: [], lines: [], sel: null, editing: null, bgFix: [], imported: [],
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
function safeF(spec, text) {
  const f = MF[fkey(spec)] || MF.helvetica;
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
const safeText = (o, text) => safeF(o.font, text);
const libFont = (c) => S.fonts.find((f) => f.lib === c.id);
async function ensureLibFont(c) {
  const have = libFont(c);
  if (have) return 'f:' + have.id;
  await loadLib();
  const { id } = await registerFont(c.data.slice(), libLabel(c), { lib: c.id });
  return 'f:' + id;
}
async function registerFont(bytes, name, extra) {
  const kf = fontkit.create(bytes);
  const id = uid('f');
  const upm = kf.unitsPerEm || 1000;
  const ff = new FontFace('cf_' + id, bytes);
  await ff.load(); document.fonts.add(ff);
  MF['f:' + id] = await measureDoc.embedFont(bytes, { subset: false });
  S.fonts.push({ id, name: name || kf.fullName || kf.familyName, bytes, A: kf.ascent / upm, D: -kf.descent / upm, ...extra });
  fillFontSelect();
  return { id, kf };
}
// Police réellement intégrée au PDF (récupérée via pdf.js) : l'aperçu et l'export gardent la vraie forme des lettres.
const embCache = new Map();
async function embeddedFontFor(fontName) {
  const f = fontObjOf(fontName);
  if (!f || !f.data || f.missingFile || !f.data.length) return null;
  let hsh = 0; for (let i = 0; i < f.data.length; i += 97) hsh = (hsh * 31 + f.data[i]) | 0;
  const key = `${f.name}:${f.data.length}:${hsh}`; // loadedName change à chaque reconstruction de l'aperçu
  if (embCache.has(key)) return embCache.get(key);
  let res = null;
  try {
    const bytes = new Uint8Array(f.data);
    const clean = (f.name || '').replace(/^[A-Z]{6}\+/, '');
    const n = clean.toLowerCase();
    const { id, kf } = await registerFont(bytes, clean + ' (PDF)', {
      partial: true, serif: !!f.isSerifFont, mono: !!f.isMonospace,
      bold: /bold|black|heavy|demi|semibold/.test(n) || !!f.bold, italic: /italic|oblique/.test(n) || !!f.italic,
    });
    S.fonts.find((x) => x.id === id).cs = new Set(kf.characterSet);
    res = 'f:' + id;
  } catch (e) { console.info('police du PDF non réutilisable :', e.message); }
  embCache.set(key, res);
  return res;
}
async function addFontFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { id, kf } = await registerFont(bytes, null, {});
    const name = kf.fullName || kf.familyName || file.name;
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
const getParas = (o) => o.paras || (o.text || '').split('\n').map((t) => ({ runs: t ? [{ t }] : [] }));
const plainOf = (paras) => paras.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
const runStyle = (o, r) => ({ fam: r.f ?? o.font.fam, b: r.b ?? !!o.font.b, i: r.i ?? !!o.font.i, u: r.u ?? false, c: r.c ?? o.color, sz: r.sz ?? o.size, ls: o.ls || 0 });
const sameSt = (a, b) => a.fam === b.fam && a.b === b.b && a.i === b.i && a.u === b.u && a.c === b.c && a.sz === b.sz && (a.ls || 0) === (b.ls || 0);
const wOf = (st, text) => (MF[fkey(st)] || MF.helvetica).widthOfTextAtSize(text, st.sz) + (st.ls ? st.ls * st.sz * [...text].length : 0);

// Police extraite du PDF = sous-ensemble : les caractères absents passent dans une police standard de même graisse.
function splitFallback(st, text) {
  const cf = st.fam.startsWith('f:') ? S.fonts.find((x) => 'f:' + x.id === st.fam) : null;
  if (!cf || !cf.partial) return [[text, st]];
  const fb = { ...st, fam: cf.serif ? 'times' : cf.mono ? 'courier' : 'helvetica', b: cf.bold || st.b, i: cf.italic || st.i };
  const out = [];
  for (const ch of text) {
    const st2 = cf.cs.has(ch.codePointAt(0)) ? st : fb, last = out[out.length - 1];
    if (last && last[1] === st2) last[0] += ch; else out.push([ch, st2]);
  }
  return out;
}

// Mise en page partagée par l'aperçu et l'export : paragraphes, listes, retraits, styles par portion.
function layout(o) {
  const paras = getParas(o), labels = listLabels(paras), lhm = o.lh || 1.2;
  const maxInner = o.autoW ? Infinity : Math.max(10, o.w - 2 * PAD);
  let bad = 0;
  const measure = (st, text) => { const q = safeF(st, text); bad += q.bad; return { text: q.text, w: wOf(st, q.text) }; };
  const rowsAll = [];
  paras.forEach((p, pi) => {
    const lvl = Math.min(p.lvl || 0, 3), textX = lvl * IND + (p.list ? MW : 0);
    const avail = maxInner === Infinity ? Infinity : Math.max(8, maxInner - textX);
    const toks = [];
    for (const r of p.runs) {
      const st = runStyle(o, r);
      r.t.split('\n').forEach((seg, si) => {
        if (si > 0) toks.push({ br: true });
        for (const m of seg.matchAll(/\S+|\s+/g)) {
          for (const [piece, pst] of splitFallback(st, m[0])) { const q = measure(pst, piece); toks.push({ text: q.text, w: q.w, st: pst, sp: /^\s/.test(piece) }); }
        }
      });
    }
    const rows = [];
    let cur = [], curW = 0;
    const flush = () => { while (cur.length && cur[cur.length - 1].sp) curW -= cur.pop().w; rows.push({ items: cur, w: curW }); cur = []; curW = 0; };
    const pushTok = (t) => {
      if (avail !== Infinity && !t.sp && curW + t.w > avail && cur.some((x) => !x.sp)) flush();
      if (avail !== Infinity && t.sp && cur.length === 0 && rows.length > 0) return;
      cur.push(t); curW += t.w;
    };
    for (const t of toks) {
      if (t.br) { flush(); continue; }
      if (avail !== Infinity && !t.sp && t.w > avail) { // mot plus large que la ligne : coupe par caractères
        let rest = t.text;
        while (rest.length) {
          let k = 1;
          while (k < rest.length && wOf(t.st, rest.slice(0, k + 1)) <= avail) k++;
          const piece = rest.slice(0, k); rest = rest.slice(k);
          pushTok({ text: piece, w: wOf(t.st, piece), st: t.st, sp: false });
          if (rest.length) flush();
        }
        continue;
      }
      pushTok(t);
    }
    flush();
    rows.forEach((row, ri) => rowsAll.push({ p, pi, lvl, textX, row, first: ri === 0 }));
  });
  const innerW = maxInner === Infinity ? Math.max(o.size * 0.6, ...rowsAll.map((r) => r.textX + r.row.w)) : maxInner;
  const lines = [];
  let y = PAD;
  for (const { p, pi, lvl, textX, row, first } of rowsAll) {
    const items = [];
    for (const it of row.items) {
      const last = items[items.length - 1];
      if (last && sameSt(last.st, it.st)) { last.text += it.text; last.w += it.w; } else items.push({ text: it.text, w: it.w, st: it.st });
    }
    const sts = items.length ? items.map((i) => i.st) : [runStyle(o, p.runs.length ? p.runs[p.runs.length - 1] : {})];
    let asc = 0, desc = 0, lineH = 0;
    for (const st of sts) {
      const fi = fontInfo({ fam: st.fam, b: st.b, i: st.i });
      asc = Math.max(asc, fi.A * st.sz); desc = Math.max(desc, fi.D * st.sz); lineH = Math.max(lineH, st.sz * lhm);
    }
    const baseIn = (lineH - (asc + desc)) / 2 + asc;
    const k = ALIGN[p.align || o.align || 'left'] || 0;
    let x = PAD + textX + (innerW - textX - row.w) * k;
    const out = items.map((it) => { const r = { text: it.text, x, w: it.w, st: it.st }; x += it.w; return r; });
    const ln = { items: out, top: y, h: lineH, base: y + baseIn };
    if (first && labels[pi]) {
      const s0 = sts[0];
      ln.marker = { text: labels[pi], x: PAD + lvl * IND, w: 0, st: { fam: 'helvetica', b: s0.b && s0.fam === 'helvetica', i: false, u: false, c: s0.c, sz: s0.sz } };
    }
    lines.push(ln);
    y += lineH;
  }
  return { lines, innerW, w: innerW + 2 * PAD, h: y + PAD, bad };
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
function itemEl(it, base) {
  const fi = fontInfo({ fam: it.st.fam, b: it.st.b, i: it.st.i });
  const lhI = it.st.sz * 1.25, inBox = (lhI - (fi.A + fi.D) * it.st.sz) / 2 + fi.A * it.st.sz;
  const e = h('div', { class: 'ln' }, it.text);
  e.style.cssText = `left:${it.x}px;top:${base - inBox}px;font:${fi.style} ${fi.weight} ${it.st.sz}px/${lhI}px ${fi.css};color:${it.st.c};${it.st.ls ? `letter-spacing:${it.st.ls * it.st.sz}px;` : ''}`;
  return e;
}
function ulEl(it, base) {
  const e = h('div', { class: 'ul' });
  e.style.cssText = `left:${it.x}px;top:${base + it.st.sz * 0.1}px;width:${it.w}px;height:${Math.max(0.5, it.st.sz * 0.055)}px;background:${it.st.c};`;
  return e;
}
function objEl(o) {
  const d = h('div', { class: 'obj ' + o.type, 'data-id': o.id });
  d.style.cssText = `left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px;`;
  if (o.type === 'text') {
    const L = layout(o);
    if (o.fill) d.style.background = o.fill;
    if (o.stroke && o.sw) d.style.boxShadow = `inset 0 0 0 ${o.sw}px ${o.stroke}`;
    for (const ln of L.lines) {
      for (const it of ln.items) { d.append(itemEl(it, ln.base)); if (it.st.u && it.text.trim()) d.append(ulEl(it, ln.base)); }
      if (ln.marker) d.append(itemEl(ln.marker, ln.base));
    }
  } else if (o.type === 'rect' || o.type === 'ellipse') {
    if (o.fill) d.style.background = hexA(o.fill, o.fop ?? 1);
    if (o.stroke && o.sw) d.style.boxShadow = `inset 0 0 0 ${o.sw}px ${o.stroke}`;
    if (o.type === 'ellipse') d.style.borderRadius = '50%';
  } else if (o.type === 'field') {
    d.style.cssText += 'box-sizing:border-box;background:rgba(37,99,235,.09);border:1px solid #2563eb;overflow:hidden;';
    const fs = Math.min(o.size || 11, Math.max(6, o.h - 4));
    const lab = h('div', { class: 'ln' });
    lab.style.cssText = `left:3px;top:${o.ftype === 'multiline' ? 2 : 0}px;font:${fs}px/${o.ftype === 'multiline' ? fs * 1.2 : o.h - 2}px Helvetica,Arial,sans-serif;color:#111;white-space:pre-wrap;`;
    if (o.ftype === 'check') {
      lab.textContent = o.checked ? '✔' : ''; lab.style.cssText = `left:0;width:100%;text-align:center;top:0;font:${o.h * 0.8}px/${o.h - 2}px Helvetica,Arial,sans-serif;color:#111;`;
    } else if (o.ftype === 'dropdown') {
      lab.textContent = o.value || ''; const ar = h('div', { class: 'ln' }, '▾'); ar.style.cssText = `right:3px;top:0;font:${fs}px/${o.h - 2}px sans-serif;color:#2563eb;`; d.append(ar);
    } else lab.textContent = o.value || '';
    d.append(lab);
    const tag = h('div', { class: 'ln' }, `${o.name}`);
    tag.style.cssText = `left:0;top:-${12}px;font:600 9px/10px system-ui,sans-serif;color:#2563eb;white-space:nowrap;overflow:visible;`;
    d.style.overflow = 'visible'; d.append(tag);
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
  if (S.view) { S.view.destroy(); S.view = null; }
  stage.querySelectorAll('.obj,.mask,.edit').forEach((n) => n.remove());
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
function uniqueName(base) {
  const used = new Set();
  for (const arr of S.objs) for (const o of arr) if (o.type === 'field') used.add(o.name);
  let n = 1, nm = base;
  while (used.has(nm)) { n++; nm = base + '_' + n; }
  return nm;
}
function duplicate() {
  const o = curObj(); if (!o || o.type === 'pdfimage') return;
  const c = JSON.parse(JSON.stringify(o));
  c.id = uid('o'); c.x += 12; c.y += 12; delete c.rm; delete c.maskNeeded; delete c.orig;
  if (c.type === 'field') c.name = uniqueName(c.name.replace(/_\d+$/, ''));
  S.objs[S.cur].push(c); S.sel = c.id;
  drawStage(); renderProps(); commit();
}

/* =====================================================================
   Édition de texte (zone de saisie)
   ===================================================================== */
function startEditDom(o) {
  const el = stage.querySelector(`.obj[data-id="${o.id}"]`);
  if (el) el.querySelectorAll('.ln,.ul').forEach((n) => { n.style.visibility = 'hidden'; });
  const ed = h('div', { class: 'edit' });
  stage.insertBefore(ed, hoverEl);
  S.ta = ed;
  S.view = RT.createEditor(ed, getParas(o), {
    onChange: (docChanged) => { if (docChanged) pmChanged(o); syncFmt(); },
    toggle: (k) => fmtToggle(k),
    blur: () => { if (S.view) S.view.dom.blur(); },
  });
  ed.classList.toggle('inplace', !!o.rm);
  document.body.classList.toggle('inplace', !!o.rm);
  styleEd(o);
  S.view.dom.addEventListener('keydown', (e) => e.stopPropagation());
  S.view.dom.addEventListener('blur', (e) => {
    const rt = e.relatedTarget;
    if (rt && rt.closest && rt.closest('#fmt')) return;
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a.closest && a.closest('#fmt')) return;
      if (S.editing === o) endEdit();
    }, 0);
  });
  S.view.focus();
  syncFmt();
}
function pmChanged(o) {
  o.paras = RT.parasFromDoc(S.view.state.doc);
  o.text = plainOf(o.paras);
  o.dirty = true;
  normalize(o); styleEd(o); updateSel();
  const el2 = stage.querySelector(`.obj[data-id="${o.id}"]`);
  if (el2) { el2.style.width = o.w + 'px'; el2.style.height = o.h + 'px'; }
}
function styleEd(o) {
  const ed = S.ta; if (!ed) return;
  const fi = fontInfo(o.font);
  ed.style.cssText = `left:${o.x}px;top:${o.y}px;${o.autoW ? `width:max-content;min-width:${o.w}px;` : `width:${o.w}px;`}min-height:${o.h}px;padding:${PAD}px;box-sizing:border-box;` +
    `font:${fi.style} ${fi.weight} ${o.size}px/${o.lh || 1.2} ${fi.css};color:${o.color};text-align:${o.align || 'left'};background:${o.fill || 'transparent'};${o.ls ? `letter-spacing:${o.ls * o.size}px;` : ''}`;
}
function startEdit(o) {
  if (S.editing === o) return;
  endEdit();
  S.editing = o;
  select(o.id);
  drawStage();
}
function endEdit(silent) {
  const o = S.editing; if (!o) return;
  S.editing = null; document.body.classList.remove('inplace');
  if (S.view) { S.view.destroy(); S.view = null; }
  if (S.ta) { S.ta.remove(); S.ta = null; }
  if (o.text === '' && !o.rm) { removeObj(o); S.sel = null; }
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
          if (gap > size * 0.15 && !last.str.endsWith(' ') && !it.str.startsWith(' ')) { last.str += ' '; last.parts[last.parts.length - 1].str += ' '; }
          last.str += it.str; last.x1 = x1; last.parts.push({ str: it.str, e, x1 }); continue;
        }
      }
      last = { str: it.str, e, f, x1, size, fontName: it.fontName, parts: [{ str: it.str, e, x1 }] };
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
const rmsOf = (o) => (o.rms || (o.rm ? [o.rm] : []));
function lineCovered(l) {
  return (S.objs[S.cur] || []).some((o) => !o.deleted && rmsOf(o).some((r) => Math.abs(r.y - l.f) < 0.6 && l.e < r.x1 && l.x1 > r.x0));
}
function lineAt(x, y) {
  for (const l of S.lines[S.cur] || []) {
    const r = l.rect;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      if (lineCovered(l)) continue;
      return l;
    }
  }
  return null;
}

function sampleColors(r, src = cv, k = S.canvasScale) {
  const cv = src, ctx = cv.getContext('2d');
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

// Rendu de la page en haute définition (~288 ppi) pour analyser les lettres d'une image : l'écran, lui, est trop grossier.
async function hiRes(tries = 0) {
  try { return await hiResOnce(); } catch (e) { if (cancelled(e) && tries < 3) { await new Promise((r) => setTimeout(r, 150)); return hiRes(tries + 1); } throw e; }
}
async function hiResOnce() {
  const pi = S.cur;
  if (S.hi && S.hi.pi === pi && S.hi.sig === S.baseSig) return S.hi;
  const page = await S.pdf.getPage(pi + 1), pg = S.pages[pi];
  const scale = Math.max(S.canvasScale, Math.min(4, Math.sqrt(40e6 / (pg.w * pg.h))));
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  await page.render({ canvas: c, canvasContext: c.getContext('2d', { willReadFrequently: true }), viewport: vp }).promise;
  S.hi = { pi, sig: S.baseSig, cv: c, k: c.width / pg.w };
  return S.hi;
}
// Texte invisible (rendu 3 : couche OCR) ou police « Glyphless » : le texte affiché est une image ou un tracé.
function isInvisibleLine(l) {
  if (/glyphless/i.test(fontNameOf(l.fontName))) return true;
  const an = S.analysis[S.cur];
  if (!an || !an.shows) return false;
  const tolY = Math.max(1.5, 0.22 * l.size);
  const hit = an.shows.filter((sh) => sh.head && sh.pos && sh.pos[0] >= l.e - 2 && sh.pos[0] <= l.x1 + 2 && Math.abs(sh.pos[1] - l.f) <= tolY);
  return hit.length > 0 && hit.every((sh) => sh.tr === 3);
}
// Cherche, sur l'image de la page, la ligne de lettres réellement visible sous le clic (indépendamment de la couche texte).
function inkBand(l, pt, cv, k) {
  const ctx = cv.getContext('2d'), size = l.size;
  const x0 = Math.max(0, Math.floor((l.rect.x - size) * k)), y0 = Math.max(0, Math.floor((pt.y - size * 1.1) * k));
  const w = Math.min(cv.width - x0, Math.ceil((l.rect.w + size * 3) * k)), hh = Math.min(cv.height - y0, Math.ceil(size * 2.2 * k));
  if (w < 4 || hh < 4) return null;
  const d = ctx.getImageData(x0, y0, w, hh).data;
  const bg = hexRgb(ringBg(l.rect, cv, k) || sampleColors({ x: x0 / k, y: y0 / k, w: w / k, h: hh / k }, cv, k).bg); // fond local (autour de la ligne OCR), pas celui de toute la fenêtre
  const ink = (i, j) => { const q = (j * w + i) * 4; return (d[q] - bg[0]) ** 2 + (d[q + 1] - bg[1]) ** 2 + (d[q + 2] - bg[2]) ** 2 > 4000; };
  const row = new Array(hh).fill(0);
  // seules les colonnes de la ligne OCR comptent (± marge) : les filets et cadres voisins ne doivent pas fausser la bande
  const mg = Math.max(1, 0.008 * l.rect.w); // marge (pt) autour de l'étendue donnée par l'OCR : on n'y inclut ni puces ni filets voisins
  const lo = Math.max(0, Math.floor((l.rect.x - mg) * k - x0)), hi = Math.min(w - 1, Math.ceil((l.rect.x + l.rect.w + mg) * k - x0));
  for (let j = 0; j < hh; j++) for (let i = lo; i <= hi; i++) if (ink(i, j)) row[j]++;
  const cy = Math.round(pt.y * k) - y0;
  let r = -1;
  for (let dj = 0; dj < hh && r < 0; dj++) for (const j of [cy + dj, cy - dj]) if (j >= 0 && j < hh && row[j] >= 2) { r = j; break; }
  if (r < 0) return null;
  const maxH = 1.7 * size * k;
  let r0 = r, r1 = r;
  const live = (j) => (row[j] >= 1) || (row[j - 1] >= 1) || (row[j + 1] >= 1);
  while (r0 > 0 && live(r0 - 1) && r1 - r0 < maxH) r0--;
  while (r1 < hh - 1 && live(r1 + 1) && r1 - r0 < maxH) r1++;
  const col = new Array(w).fill(0);
  let n = 0;
  for (let j = r0; j <= r1; j++) for (let i = 0; i < w; i++) if (ink(i, j)) { col[i]++; if (i >= lo && i <= hi) n++; }
  const cx = Math.round(pt.x * k) - x0;
  let c = -1;
  for (let di = 0; di < w && c < 0; di++) for (const i of [cx + di, cx - di]) if (i >= 0 && i < w && col[i] > 0) { c = i; break; }
  if (c < 0) return null;
  const gap = Math.max(4, 0.6 * (r1 - r0));
  let c0 = c, c1 = c, miss = 0;
  for (let i = c; i >= lo; i--) if (col[i] > 0) c0 = i;
  for (let i = c; i <= hi; i++) if (col[i] > 0) c1 = i;
  const rect = { x: (x0 + c0) / k, y: (y0 + r0) / k, w: (c1 - c0 + 1) / k, h: (r1 - r0 + 1) / k };
  // silhouette de l'encre (alpha = encre) pour la reconnaissance de police ; trous entre les mots
  const mw = c1 - c0 + 1, mh = r1 - r0 + 1;
  const mask = document.createElement('canvas'); mask.width = mw; mask.height = mh;
  const mctx = mask.getContext('2d'), img = mctx.createImageData(mw, mh);
  // seuil à mi-contraste : l'épaisseur des traits (donc la graisse) n'est ni gonflée ni amincie par l'anti-crénelage
  const dists = [];
  for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) { const q = ((r0 + j) * w + c0 + i) * 4; dists.push((d[q] - bg[0]) ** 2 + (d[q + 1] - bg[1]) ** 2 + (d[q + 2] - bg[2]) ** 2); }
  const sorted = Float64Array.from(dists).sort();
  const fgD = sorted[Math.floor(sorted.length * 0.985)] || 4000, thr = Math.max(1500, 0.25 * fgD);
  for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) if (dists[j * mw + i] > thr) img.data[(j * mw + i) * 4 + 3] = 255;
  mctx.putImageData(img, 0, 0);
  const gaps = [];
  for (let i = c0; i <= c1;) { if (col[i] > 0) { i++; continue; } let e = i; while (e <= c1 && col[e] === 0) e++; if (i > c0 && e <= c1) gaps.push({ a: i - c0, b: e - c0 }); i = e; }
  return { rect, density: n / Math.max(1, mw * mh), mask, gaps, k };
}

// Couleur de fond autour d'une zone : moyenne des pixels dominants de l'anneau extérieur (pas du bord, souvent encré)
function ringBg(r, src, k) {
  const ctx = src.getContext('2d'), pad = Math.max(3, Math.round(0.3 * r.h * k));
  const x = Math.max(0, Math.floor(r.x * k) - pad), y = Math.max(0, Math.floor(r.y * k) - pad);
  const w = Math.min(src.width - x, Math.ceil(r.w * k) + 2 * pad), hh = Math.min(src.height - y, Math.ceil(r.h * k) + 2 * pad);
  const d = ctx.getImageData(x, y, w, hh).data;
  const ix0 = Math.floor(r.x * k) - x, iy0 = Math.floor(r.y * k) - y, ix1 = ix0 + Math.ceil(r.w * k), iy1 = iy0 + Math.ceil(r.h * k);
  const bins = new Map();
  for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) {
    if (i >= ix0 && i < ix1 && j >= iy0 && j < iy1) continue;
    const q = (j * w + i) * 4, key = (d[q] >> 3) * 1024 + (d[q + 1] >> 3) * 32 + (d[q + 2] >> 3);
    const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += d[q]; b.g += d[q + 1]; b.b += d[q + 2]; bins.set(key, b);
  }
  let best = null;
  for (const b of bins.values()) if (!best || b.n > best.n) best = b;
  if (!best) return null;
  return '#' + [best.r, best.g, best.b].map((v) => Math.round(v / best.n).toString(16).padStart(2, '0')).join('');
}
async function startEditLine(l, pt) {
  const r = await analyzeLine(l, pt);
  S.objs[S.cur].push(r.o);
  scheduleRebuild();
  startEdit(r.o);
}
async function analyzeLine(l, pt, opt = {}) {
  const vp = S.pages[S.cur].vp;
  let ink = null;
  if (pt && isInvisibleLine(l)) { const hr = await hiRes(); ink = inkBand(l, pt, hr.cv, hr.k); }
  const invisible = !!ink; if (ink) S.lastInk = ink;
  const emb = invisible ? null : await embeddedFontFor(l.fontName);
  let font = emb ? { fam: emb, b: false, i: false } : guessFont(l.rawName || fontNameOf(l.fontName), fontObjOf(l.fontName));
  if (invisible && ink.density > 0.28) font = { ...font, b: true };
  // mots repérés sur l'image : un vide d'encre entre chaque mot (les N-1 plus larges vides)
  let spans = null;
  const ns = (l.str.match(/\S+/g) || []);
  if (ink && ns.length > 1) {
    const big = ink.gaps.slice().sort((a, b) => (b.b - b.a) - (a.b - a.a)).slice(0, ns.length - 1).sort((a, b) => a.a - b.a);
    if (big.length === ns.length - 1) {
      const edges = [0, ...big.flatMap((g) => [g.a, g.b]), ink.mask.width];
      spans = ns.map((t, i) => ({ a: edges[i * 2], b: edges[i * 2 + 1], text: t }));
    }
  }
  let fit = null; // résultat de la reconnaissance : corps, interlettrage, ligne de base
  if (invisible) {
    try {
      fit = await identify(ink.mask, l.str, { words: spans, force: opt.force, prefer: (S.libVotes || []).filter((v) => Math.abs(v.h - ink.rect.h) < 0.15 * ink.rect.h).map((v) => v.id), families: [...new Set((S.libVotes || []).filter((v) => v.iou >= 0.78).map((v) => v.family))] });
      S.lastFit = fit && { ...fit, wordFonts: fit.wordFonts && fit.wordFonts.map((c) => c && c.id), ranked: fit.ranked.map((r) => [r.c.id, +r.iou.toFixed(3), +(r.ls / r.size).toFixed(3), +r.score.toFixed(3)]), c: fit.c.id };
      if (fit && fit.iou > 0.35) { font = { fam: await ensureLibFont(fit.c), b: false, i: false }; (S.libVotes = S.libVotes || []).push({ id: fit.c.id, family: fit.c.family, h: ink.rect.h, iou: fit.iou }); } else fit = null;
    } catch (e) { console.warn('reconnaissance de police impossible', e); fit = null; }
  }
  const area = ink ? ink.rect : l.rect; // zone réellement occupée par les lettres visibles
  const cols = ink ? sampleColors(area, S.hi.cv, S.hi.k) : sampleColors(area);
  if (ink) cols.bg = ringBg(area, S.hi.cv, S.hi.k) || cols.bg;
  // couleurs par portion (ex. un mot en orange dans un titre sombre) : positions en px de scène
  let paras = null, color = cols.fg;
  const toks = [];
  const parts = l.parts || [{ str: l.str, e: l.e, x1: l.x1 }];
  const raws = parts.map((pt2) => [...pt2.str.matchAll(/\S+|\s+/g)].map((m) => m[0]));
  if (ink) {
    const all = raws.flat();
    if (spans) {
      let wi = 0, lastX1 = area.x;
      all.forEach((t) => {
        if (/^\s/.test(t)) { toks.push({ t, x0: lastX1, x1: lastX1, sp: true }); return; }
        const sp = spans[wi++], x0 = area.x + sp.a / ink.k, x1 = area.x + sp.b / ink.k; lastX1 = x1;
        toks.push({ t, x0, x1, sp: false });
      });
    } else { // sinon répartition proportionnelle aux largeurs de la police
      const ws = all.map((t) => wOf({ ...font, sz: l.size }, safeF(font, t).text)), tot = ws.reduce((a, c) => a + c, 0) || 1;
      let x = area.x;
      all.forEach((t, i) => { const w = (ws[i] / tot) * area.w; toks.push({ t, x0: x, x1: x + w, sp: /^\s/.test(t) }); x += w; });
    }
  } else {
    parts.forEach((pt2, pi) => {
      const raw = raws[pi], ws = raw.map((t) => wOf({ ...font, sz: l.size }, safeF(font, t).text));
      const tot = ws.reduce((a, c) => a + c, 0) || 1, k = (pt2.x1 - pt2.e) / tot;
      let x = pt2.e;
      raw.forEach((t, i) => {
        const a = vp.convertToViewportPoint(x, l.f), b = vp.convertToViewportPoint(x + ws[i] * k, l.f);
        toks.push({ t, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), sp: /^\s/.test(t) });
        x += ws[i] * k;
      });
    });
  }
  if (toks.filter((t) => !t.sp).length > 1) {
    let prev = cols.fg;
    const smp = (r) => (ink ? sampleColors(r, S.hi.cv, S.hi.k) : sampleColors(r));
    const cs = toks.map((t) => (t.sp ? prev : (prev = smp({ x: t.x0, y: area.y, w: t.x1 - t.x0, h: area.h }).fg)));
    const near = (p, q) => { const [r1, g1, b1] = hexRgb(p), [r2, g2, b2] = hexRgb(q); return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2 < 2400; };
    // police par mot (mots dont la forme diffère nettement de la police de la ligne)
    const wf = [];
    if (fit && fit.wordFonts && spans) { let wi = 0; for (const t of toks) { if (t.sp) { wf.push(wf.length ? wf[wf.length - 1] : null); continue; } wf.push(fit.wordFonts[wi++] || null); } }
    const fams = {};
    for (const c of new Set(wf.filter(Boolean))) fams[c.id] = await ensureLibFont(c);
    const lineFam = font.fam, runs = [];
    toks.forEach((t, i) => {
      const fam = wf[i] ? fams[wf[i].id] : lineFam, last = runs[runs.length - 1];
      if (last && near(last.c, cs[i]) && last.fam === fam) last.t += t.t; else runs.push({ t: t.t, c: cs[i], fam });
    });
    if (runs.length > 1) {
      color = runs[0].c;
      paras = [{ runs: runs.map((r) => { const o2 = { t: r.t }; if (!near(r.c, color)) o2.c = r.c; if (r.fam !== lineFam) o2.f = r.fam; return o2; }) }];
    }
  }
  const pad = ink ? 2 : 0.5;
  const o = {
    id: uid('o'), type: 'text', x: 0, y: 0, w: 10, h: 10, text: l.str, orig: l.str, font, size: r1((fit ? fit.size / ink.k : l.size) * 100) / 100,
    ls: fit ? Math.round((fit.ls / fit.size) * 1000) / 1000 : 0,
    color, align: 'left', lh: 1.2, autoW: true, fill: null, stroke: null, sw: 0, dirty: false,
    rm: { x0: l.e, x1: l.x1, y: l.f, size: l.size, bg: cols.bg, disp: { x: area.x - pad, y: area.y - (ink ? pad : 0), w: area.w + 2 * pad, h: area.h + (ink ? 2 * pad : 0) } },
    maskNeeded: true, forceMask: invisible,
  };
  if (paras) o.paras = paras;
  normalize(o);
  o.x = (ink ? area.x - (fit ? fit.lsb / ink.k : 0) : l.dx) - PAD; // l'origine du texte précède l'encre de la marge gauche de la 1re lettre
  const baseY = ink ? area.y + (fit ? fit.baseOff / ink.k : 0.72 * l.size) : l.base;
  o.y = baseY - layout(o).lines[0].base;
  return { o, ink, fit, l, baseY, area, fam: font.fam };
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
    else if (o.rms) o.rms.forEach((r, i) => regions.push({ id: o.id + '#' + i, ...r }));
  }
  return { moves, regions };
}
const bgActive = (pi) => !!(S.bgFix[pi] && (S.objs[pi] || []).some((o) => S.bgFix[pi].ids.includes(o.id)));
function editSig() {
  return JSON.stringify(S.objs.map((_, pi) => { const e = collectEdits(pi); return [e.moves, e.regions.map((r) => [r.id, r.x0, r.x1, r.y, r.size]), bgActive(pi) ? S.bgFix[pi].v : 0]; }));
}

// Remplace l'image de fond de la page (même nom de ressource) par la version sans texte, sans toucher aux autres pages.
async function replaceBackground(doc, page, bf) {
  const res = page.node.Resources();
  const xd = res && res.lookup(PDFName.of('XObject'), PDFDict);
  if (!xd) return;
  const emb = await doc.embedJpg(bf.bytes);
  const nxd = doc.context.obj({}), nres = doc.context.obj({});
  for (const [k, v] of xd.entries()) nxd.set(k, v);
  nxd.set(PDFName.of(bf.name), emb.ref);
  for (const [k, v] of res.entries()) nres.set(k, v);
  nres.set(PDFName.of('XObject'), nxd);
  page.node.set(PDFName.of('Resources'), nres);
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
    const drawables = draw ? arr.filter((o) => !o.deleted && (o.type === 'rect' || o.type === 'ellipse' || o.type === 'image' || o.type === 'text' || o.type === 'field')) : [];
    if (!edits.moves.length && !edits.regions.length && !drawables.length && !bgActive(pi)) continue;
    const an = await getAnalysis(pi);
    const page = pages[pi];
    if (an.src !== undefined && (an.src || edits.moves.length || edits.regions.length)) {
      const res = E.patch(an, edits);
      E.writeContents(doc, page, res.bytes);
      Object.assign(removed, res.removed);
    }
    if (bgActive(pi)) await replaceBackground(doc, page, S.bgFix[pi]);
    const vp = S.pages[pi].vp, rot = vp.rotation || 0;
    const P = (x, y) => vp.convertToPdfPoint(x, y);
    const rectBox = (x, y, w, hh) => {
      const a = P(x, y), b = P(x + w, y + hh);
      return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
    };
    for (const o of drawables) {
      if (o.type === 'field') { await addField(doc, page, rectBox(o.x, o.y, o.w, o.h), o); continue; }
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
        const L = layout(o);
        for (const ln of L.lines) {
          for (const it of ln.marker ? [...ln.items, ln.marker] : ln.items) {
            if (!it.text.trim()) continue;
            const font = await getFont({ fam: it.st.fam, b: it.st.b, i: it.st.i });
            const col = pdfColor(it.st.c);
            const p0 = P(o.x + it.x, o.y + ln.base);
            if (it.st.ls) { // interlettrage : lettre par lettre
              let cx = 0;
              for (const ch of it.text) {
                const q = P(o.x + it.x + cx, o.y + ln.base);
                if (ch.trim()) page.drawText(ch, { x: q[0], y: q[1], size: it.st.sz, font, color: col, rotate: degrees(rot) });
                cx += font.widthOfTextAtSize(ch, it.st.sz) + it.st.ls * it.st.sz;
              }
            } else page.drawText(it.text, { x: p0[0], y: p0[1], size: it.st.sz, font, color: col, rotate: degrees(rot) });
            if (it.st.u) {
              const yy = o.y + ln.base + it.st.sz * 0.1, a = P(o.x + it.x, yy), b = P(o.x + it.x + it.w, yy);
              page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: Math.max(0.5, it.st.sz * 0.055), color: col });
            }
          }
        }
      }
    }
  }
  return { bytes: await doc.save(), removed };
}

async function addField(doc, page, b, o) {
  const form = doc.getForm();
  const used = new Set(form.getFields().map((f) => f.getName()));
  let name = o.name || 'champ', n = 1;
  while (used.has(name)) name = `${o.name}_${++n}`;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const opts = {
    x: b.x, y: b.y, width: b.width, height: b.height, font,
    borderWidth: o.border ? 1 : 0, borderColor: o.border ? rgb(0.15, 0.2, 0.3) : undefined, backgroundColor: rgb(0.93, 0.96, 1),
  };
  let f;
  if (o.ftype === 'check') { f = form.createCheckBox(name); if (o.checked) f.check(); f.addToPage(page, opts); }
  else if (o.ftype === 'dropdown') {
    f = form.createDropdown(name); f.addOptions(o.options.length ? o.options : ['']);
    if (o.value && o.options.includes(o.value)) f.select(o.value);
    f.addToPage(page, opts); f.setFontSize(o.size || 11);
  } else {
    f = form.createTextField(name);
    if (o.ftype === 'multiline') f.enableMultiline();
    if (o.value) f.setText(safeTextFor(o.value));
    f.addToPage(page, opts); f.setFontSize(o.size || 11);
  }
  if (o.required) f.enableRequired();
}
const safeTextFor = (t) => safeText({ font: { fam: 'helvetica', b: false, i: false } }, t).text;

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
    for (const arr of S.objs) for (const o of arr) if (o.rm && o.id in removed) o.maskNeeded = removed[o.id] === 0 || !!o.forceMask;
    const oldTask = S.task;
    const task = pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true });
    S.pdf = await task.promise; S.task = task;
    S.baseSig = sig;
    if (oldTask) oldTask.destroy();
    await renderCanvas();
    S.ghosts.clear();
    await computeLines();
    // Contrôle : si pdf.js voit encore le texte d'origine à cet endroit, la suppression n'a pas agi → on masque.
    for (const o of S.objs[S.cur] || []) {
      if (o.rm && !o.maskNeeded && !o.deleted && (S.lines[S.cur] || []).some((l) => Math.abs(l.f - o.rm.y) < 0.6 && l.e < o.rm.x1 - 0.5 && l.x1 > o.rm.x0 + 0.5)) o.maskNeeded = true;
    }
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
const cancelled = (e) => e && (e.name === 'RenderingCancelledException' || /destroyed|cancelled/i.test(e.message || ''));
async function renderCanvas(tries = 0) {
  try { await renderCanvasOnce(); } catch (e) { if (cancelled(e) && tries < 3) { await new Promise((r) => setTimeout(r, 150)); return renderCanvas(tries + 1); } throw e; }
}
async function renderCanvasOnce() {
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
/* =====================================================================
   Import d'une page : reconstitution du texte d'une page « image + couche OCR »
   (polices, couleurs, paragraphes) et effacement du texte dans l'image de fond
   ===================================================================== */
const OK_OPS = new Set(['q', 'Q', 'cm', 'Do', 'BT', 'ET', 'Tf', 'Tz', 'Tm', 'Tj', 'TJ', 'Tr', 'BDC', 'EMC', 'BMC', 'Td', 'TD', 'T*', 'Tc', 'Tw', 'TL', 'gs', 'g', 'G', 'rg', 'RG', 'k', 'K', 'MP', 'DP']);
function pageImage(an, pi) { // page = une seule image plein cadre + du texte : on peut en refaire l'image sans texte
  if (!an.ops) return null;
  for (const op of an.ops) if (!OK_OPS.has(op)) return null;
  const imgs = an.placements.filter((p) => p.kind === 'image');
  if (imgs.length !== 1) return null;
  const b = imgs[0].bbox, pg = S.pages[pi];
  return (b[2] - b[0]) * (b[3] - b[1]) >= 0.85 * pg.w * pg.h ? imgs[0] : null;
}
const nearColor = (p, q) => { const [r1, g1, b1] = hexRgb(p), [r2, g2, b2] = hexRgb(q); return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2 < 2400; };

// Efface l'encre : pixels du masque (dilaté) remplacés par interpolation verticale entre le fond au-dessus et au-dessous.
function eraseInk(cv, items) {
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  for (const it of items) {
    const mw = it.mask.width, mh = it.mask.height, r = Math.max(2, Math.round(mh * 0.05)), pad = r + 4;
    const x0 = Math.max(0, it.px - pad), y0 = Math.max(0, it.py - pad);
    const W = Math.min(cv.width, it.px + mw + pad) - x0, H = Math.min(cv.height, it.py + mh + pad) - y0;
    if (W < 2 || H < 2) continue;
    const img = ctx.getImageData(x0, y0, W, H), d = img.data;
    const md = it.mask.getContext('2d').getImageData(0, 0, mw, mh).data;
    let M = new Uint8Array(W * H);
    for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) if (md[(j * mw + i) * 4 + 3]) { const X = i + it.px - x0, Y = j + it.py - y0; if (X >= 0 && X < W && Y >= 0 && Y < H) M[Y * W + X] = 1; }
    const dil = (src, horiz) => { // dilatation séparable (rayon r)
      const out = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!src[y * W + x]) continue;
        if (horiz) for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) out[y * W + k] = 1;
        else for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) out[k * W + x] = 1;
      }
      return out;
    };
    M = dil(dil(M, true), false);
    const at = (x, y) => { const q = (y * W + x) * 4; return [d[q], d[q + 1], d[q + 2]]; };
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H;) {
        if (!M[y * W + x]) { y++; continue; }
        let e = y; while (e < H && M[e * W + x]) e++;
        const a = y - 1, b = e; // dernières lignes de fond au-dessus / au-dessous
        const ca = a >= 0 ? at(x, a) : null, cb = b < H ? at(x, b) : null;
        for (let t = y; t < e; t++) {
          const f = (t - a) / (b - a), q = (t * W + x) * 4;
          const c = ca && cb ? [0, 1, 2].map((i) => ca[i] + (cb[i] - ca[i]) * f) : (ca || cb);
          if (c) { d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; }
        }
        y = e;
      }
    }
    ctx.putImageData(img, x0, y0);
  }
}

// Regroupe les lignes en paragraphes (même police, même corps, même marge gauche, interligne régulier)
function groupBlocks(drafts) {
  drafts.sort((a, b) => a.baseY - b.baseY || a.area.x - b.area.x);
  const blocks = [];
  for (const d of drafts) {
    let tgt = null;
    for (const b of blocks) {
      const L = b.lines[b.lines.length - 1], sz = d.o.size, gap = d.baseY - L.baseY;
      if (d.fam === L.fam && Math.abs(sz - L.o.size) < 0.06 * sz && Math.abs(d.area.x - b.lines[0].area.x) < 0.6 * sz && gap > 1.05 * sz && gap < 2.2 * sz &&
        Math.abs((d.o.ls || 0) - (L.o.ls || 0)) < 0.02 && L.area.w >= 0.7 * b.maxW && d.area.w <= b.maxW * 1.03 && nearColor(L.o.color, d.o.color)) { tgt = b; break; }
    }
    if (tgt) { tgt.lines.push(d); tgt.maxW = Math.max(tgt.maxW, d.area.w); } else blocks.push({ lines: [d], maxW: d.area.w });
  }
  return blocks;
}
function singleObj(d, masked) {
  const o = d.o;
  o.rms = [o.rm]; delete o.rm;
  if (masked) { o.maskNeeded = true; o.forceMask = true; o.rm = o.rms[0]; delete o.rms; } else { o.maskNeeded = false; delete o.forceMask; }
  return o;
}
// Un paragraphe = un seul objet texte, largeur fixe : le texte se réorganise dans son bloc ; on vérifie que les retours à la ligne d'origine sont retrouvés.
function blockObjects(b) {
  if (b.lines.length === 1) return [singleObj(b.lines[0], false)];
  const first = b.lines[0], o0 = first.o;
  const runs = [];
  b.lines.forEach((d, i) => {
    if (i > 0 && runs.length && !/\s$/.test(runs[runs.length - 1].t)) runs[runs.length - 1].t += ' ';
    for (const r of getParas(d.o)[0].runs) {
      const c = r.c ?? d.o.color, f = r.f ?? d.o.font.fam, last = runs[runs.length - 1];
      if (last && nearColor(last.c, c) && last.f === f) last.t += r.t; else runs.push({ t: r.t, c, f });
    }
  });
  const base = runs[0].c;
  const paras = [{ runs: runs.map((r) => { const q = { t: r.t }; if (!nearColor(r.c, base)) q.c = r.c; if (r.f !== o0.font.fam) q.f = r.f; return q; }) }];
  const gaps = b.lines.slice(1).map((d, i) => (d.baseY - b.lines[i].baseY) / o0.size);
  const lh = Math.round((gaps.reduce((a, c) => a + c, 0) / gaps.length) * 100) / 100;
  const want = b.lines.map((d) => d.l.str.replace(/\s+/g, ' ').trim());
  const obj = { ...o0, id: uid('o'), paras, text: plainOf(paras), orig: plainOf(paras), color: base, lh, autoW: false, dirty: false };
  delete obj.rm; delete obj.forceMask; obj.maskNeeded = false;
  obj.rms = b.lines.map((d) => d.o.rm);
  for (const slack of [0, 0.01, 0.02, 0.035, 0.05, -0.012, -0.025]) {
    obj.w = b.maxW * (1 + slack) + 2 * PAD;
    const L = layout(obj), got = L.lines.map((ln) => ln.items.map((i) => i.text).join('').replace(/\s+/g, ' ').trim());
    if (got.length === want.length && got.every((t, i) => t === want[i])) {
      normalize(obj);
      obj.y = first.baseY - layout(obj).lines[0].base;
      return [obj];
    }
  }
  return b.lines.map((d) => singleObj(d, false)); // retours à la ligne non reproductibles : une ligne = un objet
}

async function importPage(pi, manual) {
  if (S.importing || !S.pdf || S.pages[pi].vp.rotation) return;
  S.importing = true; $('#busy').hidden = false;
  try {
    const an = await getAnalysis(pi);
    const lines = (S.lines[pi] || []).filter((l) => isInvisibleLine(l) && !lineCovered(l));
    if (!lines.length) { if (manual) toast('Aucun texte à reconstituer sur cette page.'); return; }
    const img = pageImage(an, pi);
    await hiRes();
    const drafts = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      toast(`Analyse de la page : ligne ${i + 1} sur ${lines.length}…`, 60000);
      await new Promise((r) => setTimeout(r, 0));
      try { const d = await analyzeLine(l, { x: l.rect.x + l.rect.w * 0.3, y: l.rect.y + l.rect.h * 0.55 }); if (d.ink) drafts.push(d); } catch (e) { console.warn('ligne ignorée', e); }
      if (S.cur !== pi) return;
    }
    if (!drafts.length) { if (manual) toast('Aucune ligne reconnue.'); return; }
    // cohérence de style : les lignes de même corps et de même couleur partagent la police dominante (vote pondéré par la longueur et la qualité de l'ajustement)
    const used = new Set();
    for (const d of drafts) {
      if (!d.fit || used.has(d)) continue;
      const cl = drafts.filter((e) => e.fit && Math.abs(e.o.size - d.o.size) < 0.06 * d.o.size && nearColor(e.o.color, d.o.color));
      const vote = {};
      for (const e of cl) { used.add(e); vote[e.fit.c.id] = (vote[e.fit.c.id] || 0) + e.l.str.length * e.fit.iou ** 2; }
      const lead = Object.entries(vote).sort((a, b) => b[1] - a[1])[0][0];
      for (const e of cl) {
        if (e.fit.c.id === lead) continue;
        try {
          const d2 = await analyzeLine(e.l, { x: e.l.rect.x + e.l.rect.w * 0.3, y: e.l.rect.y + e.l.rect.h * 0.55 }, { force: lead });
          if (d2.ink && d2.fit && d2.fit.c.id === lead) drafts[drafts.indexOf(e)] = d2;
        } catch (err) { /* on garde la première analyse */ }
      }
    }
    let objs;
    if (img) objs = groupBlocks(drafts.slice()).flatMap(blockObjects);
    else objs = drafts.map((d) => singleObj(d, true)); // page mêlant image et dessins : on masque ligne par ligne
    S.objs[pi].push(...objs);
    if (img) {
      const hr = S.hi, cv2 = document.createElement('canvas');
      cv2.width = hr.cv.width; cv2.height = hr.cv.height;
      cv2.getContext('2d').drawImage(hr.cv, 0, 0);
      eraseInk(cv2, drafts.map((d) => ({ mask: d.ink.mask, px: Math.round(d.ink.rect.x * d.ink.k), py: Math.round(d.ink.rect.y * d.ink.k) })));
      const blob = await new Promise((r) => cv2.toBlob(r, 'image/jpeg', 0.92));
      S.bgFix[pi] = { name: img.name, bytes: new Uint8Array(await blob.arrayBuffer()), ids: objs.map((o) => o.id), v: ((S.bgFix[pi] && S.bgFix[pi].v) || 0) + 1 };
    }
    S.hi = null;
    commit();
    if (S.cur === pi) drawStage();
    const nb = objs.length;
    toast(`Page analysée : ${drafts.length} lignes reconnues, ${nb} blocs de texte modifiables.`, 5000);
  } catch (e) { console.error(e); toast('Analyse de la page impossible : ' + e.message, 6000); }
  S.importing = false; $('#busy').hidden = true;
}
function maybeImport(manual) {
  const pi = S.cur;
  if (!manual && S.imported[pi]) return;
  S.imported[pi] = true;
  importPage(pi, manual);
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
  maybeImport();
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
    embCache.clear(); S.libVotes = []; S.hi = null; S.fonts = S.fonts.filter((f) => !f.partial); fillFontSelect();
    Object.assign(S, {
      task,
      name, origBytes: bytes, origDoc, pdf, cur: 0, objs: [], analysis: [], lines: [], sel: null, editing: null,
      undo: [], redo: [], baseSig: '', modified: false, pages: [], bgFix: [], imported: [],
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
    maybeImport();
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
  if (t === 'field' || t === 'rect' || t === 'ellipse') select(null);
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
    if (o.type === 'pdfimage' && (S.tool !== 'select' || o.w * o.h > 0.85 * S.pages[S.cur].w * S.pages[S.cur].h)) continue; // pas d'image : ou image plein page (fond)
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

stage.addEventListener('mousedown', (e) => { if (!(S.ta && S.ta.contains(e.target))) e.preventDefault(); });
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !S.pdf) return;
  const p = ptr(e);
  if (S.editing && S.ta && S.ta.contains(e.target)) return;
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
    if (l) { startEditLine(l, p); return; }
    select(null);
    drag = { kind: 'newtext', p0: p, moved: false };
    return;
  }
  if (S.tool === 'rect' || S.tool === 'ellipse' || S.tool === 'field') {
    select(null);
    drag = { kind: 'newshape', p0: p, moved: false };
    return;
  }
  // sélection
  const o = hitObj(p.x, p.y);
  if (!o) {
    const l = lineAt(p.x, p.y);
    if (l) { startEditLine(l, p); return; }
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
  } else if (d.kind === 'newshape' && S.tool === 'field') {
    if (S.pages[S.cur].vp.rotation) { toast('Les champs de formulaire ne sont pas disponibles sur les pages pivotées.'); return; }
    const ft = S.fieldType || 'text';
    const dflt = { text: [170, 22], multiline: [200, 70], check: [16, 16], dropdown: [170, 22] }[ft];
    let r = d.rect && d.rect.w > 6 && d.rect.h > 6 ? d.rect : { x: d.p0.x, y: d.p0.y - dflt[1] / 2, w: dflt[0], h: dflt[1] };
    if (ft === 'check') { const m = Math.max(12, Math.min(r.w, r.h)); r = { x: r.x, y: r.y, w: m, h: m }; }
    const o = { id: uid('o'), type: 'field', ftype: ft, name: uniqueName({ text: 'texte', multiline: 'zone_texte', check: 'case', dropdown: 'liste' }[ft]), ...r, size: 11, value: '', checked: false, options: ft === 'dropdown' ? ['Option 1', 'Option 2', 'Option 3'] : [], required: false, border: true };
    if (ft === 'dropdown') o.value = o.options[0];
    S.objs[S.cur].push(o);
    setTool('select'); S.sel = o.id;
    drawStage(); renderProps(); commit();
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
  if (S.editing === o) { styleEd(o); }
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
function renderProps() { renderPropsInner(); syncFmt(); }
function renderPropsInner() {
  const o = curObj();
  propsEl.innerHTML = '';
  if (!S.pdf) { put(h('p', { class: 'hint' }, 'Ouvrez un PDF pour commencer.')); return; }
  if (!o) {
    const nl = (S.lines[S.cur] || []).length;
    const rot = S.pages[S.cur] && S.pages[S.cur].vp.rotation;
    put(
      S.tool === 'field' ? [h('h3', {}, 'Type de champ à dessiner'), h('div', { class: 'row' }, ...[['text', 'Texte'], ['multiline', 'Multiligne'], ['check', 'Case à cocher'], ['dropdown', 'Liste déroulante']].map(([k, l]) => h('button', { class: 'btn small' + ((S.fieldType || 'text') === k ? ' primary' : ''), onclick: () => { S.fieldType = k; renderProps(); } }, l))), h('p', { class: 'hint' }, 'Glissez sur la page pour dessiner le champ (ou cliquez pour une taille par défaut).')] : null,
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
    const bad = layout(o).bad;
    put(
      h('h3', {}, o.rm ? 'Texte du document' : 'Texte'),
      h('p', { class: 'hint' }, 'Police, taille, styles, couleur, listes à puces ou numérotées, retraits et alignement : barre d\'outils au-dessus de la page (sur la sélection pendant la saisie, sur tout le texte sinon).'),
      numField('Interligne', () => o.lh || 1.2, (v) => { o.lh = Math.max(0.5, v); }, { step: 0.05, min: 0.5 }),
      bad ? h('div', { class: 'warn' }, `${bad} caractère(s) absent(s) de cette police s'affichent « ? ». Ajoutez une police .ttf/.otf couvrant ces caractères.`, h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => { $('#fontIn').dataset.apply = '1'; $('#fontIn').click(); } }, 'Ajouter une police…'))) : null,
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
  if (o.type === 'field') {
    const kinds = [['text', 'Texte'], ['multiline', 'Multiligne'], ['check', 'Case'], ['dropdown', 'Liste']];
    const nameInp = h('input', { type: 'text', value: o.name });
    nameInp.addEventListener('input', () => { o.name = nameInp.value.replace(/[.\s]+/g, '_'); live(); });
    nameInp.addEventListener('change', () => { if (!o.name) o.name = uniqueName('champ'); commit(); renderProps(); });
    put(
      h('h3', {}, 'Champ de formulaire'),
      h('div', { class: 'f' }, h('span', {}, 'Type'), h('div', { class: 'seg' }, ...kinds.map(([k, l]) => h('button', { class: o.ftype === k ? 'on' : '', style: 'padding:4px 6px;font-size:11px', onclick: () => { o.ftype = k; if (k === 'dropdown' && !o.options.length) o.options = ['Option 1', 'Option 2']; if (k === 'check') { o.w = o.h = Math.min(o.w, o.h, 20); } drawStage(); renderProps(); commit(); } }, l)))),
      h('label', { class: 'f' }, h('span', {}, 'Nom'), nameInp),
      o.ftype === 'check'
        ? checkField('Cochée par défaut', () => o.checked, (v) => { o.checked = v; })
        : o.ftype === 'dropdown'
          ? [h('div', { class: 'hint' }, 'Options (une par ligne)'), (() => {
            const t = h('textarea', { rows: 4, style: 'width:100%;border:1px solid var(--line);border-radius:6px;padding:4px 6px;font:inherit' }); t.value = o.options.join('\n');
            t.addEventListener('input', () => { o.options = t.value.split('\n').map((x) => x.trim()).filter(Boolean); if (!o.options.includes(o.value)) o.value = o.options[0] || ''; live(); });
            t.addEventListener('change', () => { commit(); renderProps(); }); return t; })(),
          (() => { const sl = h('select', {}, o.options.map((x) => h('option', { value: x }, x))); sl.value = o.value; sl.addEventListener('change', () => { o.value = sl.value; live(); commit(); }); return h('label', { class: 'f' }, h('span', {}, 'Valeur par défaut'), sl); })()]
          : (() => { const vi = h('input', { type: 'text', value: o.value }); vi.addEventListener('input', () => { o.value = vi.value; live(); }); vi.addEventListener('change', () => commit()); return h('label', { class: 'f' }, h('span', {}, 'Valeur par défaut'), vi); })(),
      o.ftype === 'check' ? null : numField('Taille police', () => o.size, (v) => { o.size = Math.max(4, v); }, { min: 4, step: 1 }),
      checkField('Obligatoire', () => o.required, (v) => { o.required = v; }),
      checkField('Bordure', () => o.border, (v) => { o.border = v; }),
      h('p', { class: 'hint' }, 'Ce champ reste remplissable dans tout lecteur PDF (Acrobat, navigateurs, aperçu…).'),
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
   Barre d'outils de mise en forme (type traitement de texte)
   ===================================================================== */
const F = {};
['fFont', 'fSize', 'fB', 'fI', 'fU', 'fColor', 'fBul', 'fNum', 'fOut', 'fInd', 'fAL', 'fAC', 'fAR'].forEach((id) => { F[id] = $('#' + id); });
function fillFontSelect() {
  F.fFont.innerHTML = '';
  for (const fam of Object.keys(STD)) F.fFont.append(h('option', { value: fam }, STD_META[fam].label));
  for (const f of S.fonts) if (!f.lib) F.fFont.append(h('option', { value: 'f:' + f.id }, f.name));
  const g = h('optgroup', { label: 'Polices libres incluses' });
  for (const c of LIB) { const f = libFont(c); g.append(h('option', { value: f ? 'f:' + f.id : 'lib:' + c.id }, libLabel(c))); }
  F.fFont.append(g);
}
const pmDef = (o) => ({ b: !!o.font.b, i: !!o.font.i, u: false, c: o.color, sz: o.size, f: o.font.fam });
const pmVal = (marks, key, def) => { const m = marks.find((x) => x.type.name === key); return m ? m.attrs.v : def; };
function pmEffective(key) { // valeurs effectives de la sélection de l'éditeur
  const st = S.view.state, { from, to, empty, $from } = st.selection, def = pmDef(curObj())[key], vals = [];
  if (empty) vals.push(pmVal(st.storedMarks || $from.marks(), key, def));
  else st.doc.nodesBetween(from, to, (n) => { if (n.isText) vals.push(pmVal(n.marks, key, def)); });
  return vals.length ? vals : [def];
}
function pmApply(key, val) {
  const o = curObj(), st = S.view.state, { from, to, empty } = st.selection, mt = RT.schema.marks[key], def = pmDef(o)[key];
  let tr = st.tr;
  if (empty) tr = val === def ? tr.removeStoredMark(mt) : tr.addStoredMark(mt.create({ v: val }));
  else tr = val === def ? tr.removeMark(from, to, mt) : tr.addMark(from, to, mt.create({ v: val }));
  S.view.dispatch(tr); S.view.focus();
}
function pmParaAttrs() {
  const st = S.view.state, out = [];
  st.doc.nodesBetween(st.selection.from, st.selection.to, (n) => { if (n.type.name === 'para') out.push(n.attrs); return false; });
  return out;
}
function ensureRich(o) {
  if (!o.paras) o.paras = getParas(o).map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r })) }));
  return o.paras;
}
function modelStyle(o, prop, val) { // sans édition en cours : s'applique à tout le texte
  ensureRich(o);
  if (prop === 'u') { for (const p of o.paras) for (const r of p.runs) { if (val) r.u = true; else delete r.u; } return; }
  if (prop === 'b' || prop === 'i') o.font[prop] = val;
  else if (prop === 'c') o.color = val;
  else if (prop === 'sz') o.size = val;
  else if (prop === 'f') { o.font.fam = val; if (val.startsWith('f:')) { o.font.b = false; o.font.i = false; } }
  for (const p of o.paras) for (const r of p.runs) delete r[prop];
}
function afterModel(o) { live(); commit(); syncFmt(); renderProps(); }
function fmtToggle(k) {
  const o = curObj(); if (!o || o.type !== 'text') return;
  if (S.view) { pmApply(k, !pmEffective(k).every(Boolean)); return; }
  const ps = getParas(o);
  const all = ps.some((p) => p.runs.length) && ps.every((p) => p.runs.every((r) => runStyle(o, r)[k]));
  modelStyle(o, k, !all); afterModel(o);
}
function fmtValue(key, val) {
  const o = curObj(); if (!o || o.type !== 'text') return;
  if (S.view) { pmApply(key, val); return; }
  modelStyle(o, key, val); afterModel(o);
}
function paraSet(fn) {
  const o = curObj(); if (!o || o.type !== 'text') return;
  if (S.view) {
    const st = S.view.state, tr = st.tr;
    st.doc.nodesBetween(st.selection.from, st.selection.to, (n, pos) => { if (n.type.name === 'para') tr.setNodeMarkup(pos, null, { ...n.attrs, ...fn(n.attrs) }); return false; });
    S.view.dispatch(tr); S.view.focus(); return;
  }
  for (const p of ensureRich(o)) {
    Object.assign(p, fn(p));
    for (const k of ['list', 'lvl', 'align']) if (!p[k]) delete p[k];
  }
  afterModel(o);
}
function toggleList(kind) {
  const o = curObj(); if (!o || o.type !== 'text') return;
  const items = S.view ? pmParaAttrs() : getParas(o);
  const all = items.length > 0 && items.every((p) => p.list === kind);
  paraSet(() => ({ list: all ? null : kind }));
}
const indentBy = (d) => paraSet((p) => ({ lvl: Math.max(0, Math.min(3, (p.lvl || 0) + d)) }));
const alignTo = (a) => paraSet(() => ({ align: a }));
function syncFmt() {
  const o = curObj(), on = !!o && o.type === 'text';
  for (const k in F) F[k].disabled = !on;
  if (!on) return;
  let st, pa;
  if (S.view) {
    const e = (k) => pmEffective(k)[0];
    st = { b: e('b'), i: e('i'), u: e('u'), c: e('c'), sz: e('sz'), f: e('f') };
    pa = S.view.state.selection.$from.parent.attrs;
  } else {
    const ps = getParas(o);
    st = runStyle(o, ps[0].runs[0] || {}); st.f = st.fam; pa = ps[0];
  }
  if (document.activeElement !== F.fSize) F.fSize.value = r1(st.sz);
  F.fFont.value = st.f;
  F.fColor.value = /^#[0-9a-f]{6}$/i.test(st.c) ? st.c : '#000000';
  F.fB.classList.toggle('on', !!st.b); F.fI.classList.toggle('on', !!st.i); F.fU.classList.toggle('on', !!st.u);
  F.fBul.classList.toggle('on', pa.list === 'b'); F.fNum.classList.toggle('on', pa.list === 'n');
  const al = pa.align || o.align || 'left';
  F.fAL.classList.toggle('on', al === 'left'); F.fAC.classList.toggle('on', al === 'center'); F.fAR.classList.toggle('on', al === 'right');
}
RT.setFontCss((fam) => fontInfo({ fam, b: false, i: false }).css);
fillFontSelect();
document.querySelectorAll('#fmt button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
F.fB.onclick = () => fmtToggle('b'); F.fI.onclick = () => fmtToggle('i'); F.fU.onclick = () => fmtToggle('u');
F.fFont.onchange = async () => {
  let v = F.fFont.value;
  if (v.startsWith('lib:')) { const c = LIB.find((x) => 'lib:' + x.id === v); v = await ensureLibFont(c); }
  fmtValue('f', v);
};
F.fSize.onchange = () => { const v = parseFloat(F.fSize.value); if (v >= 1) fmtValue('sz', v); };
F.fColor.oninput = () => fmtValue('c', F.fColor.value);
F.fBul.onclick = () => toggleList('b'); F.fNum.onclick = () => toggleList('n');
F.fOut.onclick = () => indentBy(-1); F.fInd.onclick = () => indentBy(1);
F.fAL.onclick = () => alignTo('left'); F.fAC.onclick = () => alignTo('center'); F.fAR.onclick = () => alignTo('right');

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
  if (fam && apply && o && o.type === 'text') { modelStyle(o, 'f', fam); normalize(o); drawStage(); commit(); }
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
  const map = { v: 'select', t: 'text', r: 'rect', e: 'ellipse', i: 'image', f: 'field' };
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
$('#btnImport').onclick = () => maybeImport(true);
Object.assign(window.__pdfEditor, { openBytes, save, buildPdf, setTool, gotoPage, startEditLine, lineAt, importPage, maybeImport, inkBand, hiRes, isInvisibleLine });
