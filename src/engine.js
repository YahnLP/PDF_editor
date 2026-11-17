// Moteur PDF : analyse et réécriture du flux de contenu d'une page.
// - détecte les images (et figures contenant des images) placées au niveau de la page
// - les déplace / redimensionne / supprime EN PLACE (l'ordre d'empilement est conservé)
// - supprime les opérateurs d'affichage de texte situés dans une zone donnée
import {
  PDFName, PDFArray, PDFDict, PDFStream, PDFRawStream, PDFNumber, decodePDFRawStream,
} from 'pdf-lib';

/* ---------- matrices (convention PDF : vecteur ligne, p' = p × M) ---------- */
export const IDENT = [1, 0, 0, 1, 0, 0];
export const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
export const inv = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
};
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const fmt = (n) => (Math.abs(n) < 1e-9 ? '0' : +n.toFixed(5)).toString();

/* ---------- tokenizer ---------- */
const WS = ' \t\r\n\f\0';
const DELIM = '()<>[]{}/%';
const isNum = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function skipString(s, i) { // s[i] === '('
  let depth = 1; i++;
  while (i < s.length && depth > 0) {
    const d = s[i];
    if (d === '\\') i += 2;
    else { if (d === '(') depth++; else if (d === ')') depth--; i++; }
  }
  return i;
}

export function tokenize(s) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (WS.includes(c)) { i++; continue; }
    if (c === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    const st = i;
    if (c === '(') { i = skipString(s, i); out.push({ t: 'str', s: st, e: i }); continue; }
    if (c === '<') {
      if (s[i + 1] === '<') {
        let depth = 1; i += 2;
        while (i < n && depth > 0) {
          if (s[i] === '<' && s[i + 1] === '<') { depth++; i += 2; }
          else if (s[i] === '>' && s[i + 1] === '>') { depth--; i += 2; }
          else if (s[i] === '(') i = skipString(s, i);
          else i++;
        }
        out.push({ t: 'dict', s: st, e: i });
      } else {
        const j = s.indexOf('>', i);
        i = j < 0 ? n : j + 1;
        out.push({ t: 'hex', s: st, e: i });
      }
      continue;
    }
    if (c === '[') {
      let depth = 1; i++;
      while (i < n && depth > 0) {
        if (s[i] === '[') { depth++; i++; }
        else if (s[i] === ']') { depth--; i++; }
        else if (s[i] === '(') i = skipString(s, i);
        else i++;
      }
      out.push({ t: 'arr', s: st, e: i });
      continue;
    }
    if (')]>{}'.includes(c)) { i++; continue; }
    if (c === '/') {
      i++;
      while (i < n && !WS.includes(s[i]) && !DELIM.includes(s[i])) i++;
      out.push({ t: 'name', v: s.slice(st + 1, i), s: st, e: i });
      continue;
    }
    while (i < n && !WS.includes(s[i]) && !DELIM.includes(s[i])) i++;
    const w = s.slice(st, i);
    if (isNum.test(w)) { out.push({ t: 'num', v: parseFloat(w), s: st, e: i }); continue; }
    if (w === 'BI') { // image en ligne : BI ... ID <données> EI
      const reID = /\sID(\r\n|[ \t\r\n])/g; reID.lastIndex = i;
      const m = reID.exec(s);
      if (!m) { i = n; continue; }
      const dataStart = m.index + m[0].length;
      const reEI = /\sEI(?=[\s]|$)/g; reEI.lastIndex = dataStart;
      const m2 = reEI.exec(s);
      i = m2 ? m2.index + m2[0].length : n;
      out.push({ t: 'inline', s: st, e: i });
      continue;
    }
    out.push({ t: 'op', v: w, s: st, e: i });
  }
  return out;
}

/* ---------- octets <-> chaîne latin1 (bijectif, contrairement à TextDecoder) ---------- */
export function bytesToStr(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  return s;
}
export function strToBytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

/* ---------- accès aux flux pdf-lib ---------- */
function decodeStream(st) {
  if (st instanceof PDFRawStream) return decodePDFRawStream(st).decode();
  return st.getUnencodedContents();
}

function pageContents(doc, page) {
  const c = page.node.Contents();
  const list = [];
  if (c instanceof PDFArray) {
    for (let i = 0; i < c.size(); i++) list.push(doc.context.lookup(c.get(i)));
  } else if (c) list.push(c);
  const parts = list.filter((x) => x instanceof PDFStream).map((st) => bytesToStr(decodeStream(st)));
  return parts.join('\n');
}

function xobjectDict(doc, resources) {
  if (!resources) return null;
  return doc.context.lookupMaybe(resources.get(PDFName.of('XObject')), PDFDict) || null;
}

const numArr = (doc, v) => {
  const a = doc.context.lookupMaybe(v, PDFArray);
  if (!a) return null;
  const r = [];
  for (let i = 0; i < a.size(); i++) {
    const n = doc.context.lookupMaybe(a.get(i), PDFNumber);
    r.push(n ? n.asNumber() : 0);
  }
  return r;
};

// Renvoie {type:'image'} | {type:'form', bbox, matrix, hasImage} | null
function xobjInfo(doc, xdict, name, depth = 0) {
  if (!xdict) return null;
  const obj = doc.context.lookupMaybe(xdict.get(PDFName.of(name)), PDFStream);
  if (!obj) return null;
  const sub = obj.dict.get(PDFName.of('Subtype'));
  const subName = sub && sub.asString ? sub.asString() : String(sub);
  if (subName === '/Image') return { type: 'image' };
  if (subName === '/Form') {
    const bbox = numArr(doc, obj.dict.get(PDFName.of('BBox')));
    const matrix = numArr(doc, obj.dict.get(PDFName.of('Matrix'))) || IDENT;
    let hasImage = false;
    if (depth < 3) {
      try {
        const res = doc.context.lookupMaybe(obj.dict.get(PDFName.of('Resources')), PDFDict);
        const xd = xobjectDict(doc, res);
        const toks = tokenize(bytesToStr(decodeStream(obj)));
        let prev = null;
        for (const tk of toks) {
          if (tk.t === 'inline') hasImage = true;
          if (tk.t === 'op' && tk.v === 'Do' && prev && prev.t === 'name') {
            const inf = xobjInfo(doc, xd, prev.v, depth + 1);
            if (inf && (inf.type === 'image' || inf.hasImage)) hasImage = true;
          }
          prev = tk;
        }
      } catch (e) { /* flux illisible : on ignore */ }
    }
    return { type: 'form', bbox, matrix, hasImage };
  }
  return null;
}

/* ---------- analyse d'un flux de contenu ---------- */
// Renvoie { toks, placements: [{idx,kind,name,s,e,ctm,bbox:[x0,y0,x1,y1]}], shows: [...], depthEnd }
export function analyze(doc, page, pageSize) {
  const src = pageContents(doc, page);
  const xdict = xobjectDict(doc, page.node.Resources());
  const toks = tokenize(src);
  let ctm = IDENT.slice();
  const stack = [];
  let operands = [];
  let tm = IDENT.slice(), tlm = IDENT.slice(), leading = 0, fontSize = 0, cont = false, lastHead = -1, tr = 0;
  const placements = [];
  const shows = [];
  const opSet = new Set();
  const pageArea = pageSize ? pageSize[0] * pageSize[1] : Infinity;

  const bboxOf = (m, pts) => {
    const xs = [], ys = [];
    for (const [x, y] of pts) { const p = apply(m, x, y); xs.push(p[0]); ys.push(p[1]); }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const td = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); cont = false; };
  const show = (tk, opKind, firstOperand) => {
    const s0 = firstOperand ? firstOperand.s : tk.s;
    const head = !cont;
    const rec = { s: s0, e: tk.e, op: opKind, size: fontSize, head, pos: null, headIdx: -1, tr };
    if (head) {
      const p = mul(tm, ctm);
      rec.pos = [p[4], p[5]];
      lastHead = shows.length;
    }
    rec.headIdx = lastHead;
    if (opKind === "'" || opKind === '"') rec.args = operands.filter((o) => o.t === 'num').map((o) => o.v);
    shows.push(rec);
    cont = true;
  };

  for (const tk of toks) {
    if (tk.t !== 'op' && tk.t !== 'inline') { operands.push(tk); continue; }
    if (tk.t === 'inline') {
      const idx = placements.length;
      placements.push({ idx, kind: 'inline', name: null, s: tk.s, e: tk.e, ctm: ctm.slice(), bbox: bboxOf(ctm, [[0, 0], [1, 0], [1, 1], [0, 1]]) });
      operands = [];
      continue;
    }
    opSet.add(tk.v);
    const nums = operands.map((o) => o.v);
    switch (tk.v) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': if (stack.length) ctm = stack.pop(); break;
      case 'cm': if (nums.length >= 6 && nums.slice(-6).every(Number.isFinite)) ctm = mul(nums.slice(-6), ctm); break;
      case 'BT': tm = IDENT.slice(); tlm = IDENT.slice(); cont = false; break;
      case 'Tf': fontSize = Number.isFinite(nums[1]) ? nums[1] : fontSize; break;
      case 'TL': if (Number.isFinite(nums[0])) leading = nums[0]; break;
      case 'Tr': if (Number.isFinite(nums[0])) tr = nums[0]; break;
      case 'Td': if (nums.length >= 2) td(nums[0], nums[1]); break;
      case 'TD': if (nums.length >= 2) { leading = -nums[1]; td(nums[0], nums[1]); } break;
      case 'Tm': if (nums.length >= 6) { tm = nums.slice(-6); tlm = tm.slice(); cont = false; } break;
      case 'T*': td(0, -leading); break;
      case 'Tj': case 'TJ': show(tk, tk.v, operands[0]); break;
      case "'": td(0, -leading); show(tk, "'", operands[0]); break;
      case '"': td(0, -leading); show(tk, '"', operands[0]); break;
      case 'Do': {
        const nm = operands[operands.length - 1];
        if (nm && nm.t === 'name') {
          const inf = xobjInfo(doc, xdict, nm.v);
          if (inf && inf.type === 'image') {
            placements.push({ idx: placements.length, kind: 'image', name: nm.v, s: nm.s, e: tk.e, ctm: ctm.slice(), bbox: bboxOf(ctm, [[0, 0], [1, 0], [1, 1], [0, 1]]) });
          } else if (inf && inf.type === 'form' && inf.hasImage && inf.bbox && inf.bbox.length >= 4) {
            const b = inf.bbox, fm = mul(inf.matrix, ctm);
            const bb = bboxOf(fm, [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]);
            const area = (bb[2] - bb[0]) * (bb[3] - bb[1]);
            if (area < pageArea * 0.9) {
              placements.push({ idx: placements.length, kind: 'form', name: nm.v, s: nm.s, e: tk.e, ctm: ctm.slice(), bbox: bb });
            }
          }
        }
        break;
      }
      default: break;
    }
    operands = [];
  }
  return { src, placements, shows, ops: opSet, depthEnd: stack.length };
}

/* ---------- réécriture ---------- */
// edits = { moves: [{idx, bbox:[x0,y0,x1,y1]} | {idx, del:true}], regions: [{id, x0, x1, y, size}] }
// Renvoie { bytes, removed: {id: nbOpérateursSupprimés} }
export function patch(an, edits) {
  const reps = []; // {s,e,text}
  for (const m of edits.moves || []) {
    const p = an.placements[m.idx];
    if (!p) continue;
    if (m.del) { reps.push({ s: p.s, e: p.e, text: '' }); continue; }
    const [ox0, oy0, ox1, oy1] = p.bbox;
    const w = ox1 - ox0, h = oy1 - oy0;
    if (w < 1e-6 || h < 1e-6) continue;
    const [nx0, ny0, nx1, ny1] = m.bbox;
    const sx = (nx1 - nx0) / w, sy = (ny1 - ny0) / h;
    const T = [sx, 0, 0, sy, nx0 - ox0 * sx, ny0 - oy0 * sy];
    if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6 && Math.abs(T[4]) < 1e-6 && Math.abs(T[5]) < 1e-6) continue;
    const pi = inv(p.ctm);
    if (!pi) continue;
    const M = mul(mul(p.ctm, T), pi);
    reps.push({ s: p.s, e: p.e, text: `q ${M.map(fmt).join(' ')} cm ${an.src.slice(p.s, p.e)} Q` });
  }

  const removed = {};
  const removeShow = (i) => {
    const sh = an.shows[i];
    let text = '';
    if (sh.op === "'") text = 'T*';
    else if (sh.op === '"') text = `${fmt(sh.args[0] || 0)} Tw ${fmt(sh.args[1] || 0)} Tc T*`;
    reps.push({ s: sh.s, e: sh.e, text });
  };
  const done = new Set();
  for (const r of edits.regions || []) {
    removed[r.id] = 0;
    const tolY = Math.max(1.5, 0.22 * r.size);
    an.shows.forEach((sh, i) => {
      if (!sh.head || !sh.pos || done.has(i)) return;
      if (sh.pos[0] < r.x0 - 2 || sh.pos[0] > r.x1 + 2) return;
      if (Math.abs(sh.pos[1] - r.y) > tolY) return;
      // supprime la tête et ses continuations
      removeShow(i); done.add(i); removed[r.id]++;
      for (let j = i + 1; j < an.shows.length && !an.shows[j].head; j++) { removeShow(j); done.add(j); }
    });
  }

  reps.sort((a, b) => b.s - a.s);
  let out = an.src;
  for (const r of reps) out = out.slice(0, r.s) + r.text + out.slice(r.e);
  // équilibre q/Q pour que les objets ajoutés après partent d'un état propre
  const wrapped = 'q\n' + out + '\n' + 'Q\n'.repeat(an.depthEnd + 1);
  return { bytes: strToBytes(wrapped), removed };
}

export function writeContents(doc, page, bytes) {
  const ref = doc.context.register(doc.context.flateStream(bytes));
  page.node.set(PDFName.of('Contents'), ref);
}
