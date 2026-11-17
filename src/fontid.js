// Identification de la police d'un texte dessiné (image, scan, couche OCR) :
// le texte est connu (OCR) et sa forme est visible sur la page. On le redessine avec chaque police
// de la bibliothèque, à l'échelle déduite de la hauteur des lettres, avec l'interlettrage
// nécessaire, puis on garde la police dont la silhouette recouvre le mieux l'encre réelle.
import { LIB } from './fontdata.js';

export const WEIGHT_NAMES = { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold' };
export const libLabel = (c) => `${c.family}${c.weight === 400 ? '' : ' ' + WEIGHT_NAMES[c.weight]}`;
export { LIB };

let loading = null;
export function loadLib() {
  if (!loading) {
    loading = Promise.all(LIB.map(async (c) => {
      try { const ff = new FontFace('lib_' + c.id, c.data.slice()); await ff.load(); document.fonts.add(ff); c.ok = true; } catch (e) { c.ok = false; }
    }));
  }
  return loading;
}

const GH = 36;
let off, octx, small, sctx;
function ctxs() {
  if (!off) {
    off = document.createElement('canvas'); octx = off.getContext('2d', { willReadFrequently: true });
    small = document.createElement('canvas'); sctx = small.getContext('2d', { willReadFrequently: true });
  }
}
const HAS_LS = typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype;

// dessine `text` avec la police `c` (corps S0, interlettrage ls en px) et renvoie la boîte d'encre
function draw(c, text, S0, ls) {
  const font = `${c.weight} ${S0}px "lib_${c.id}"`;
  octx.font = font; if (HAS_LS) octx.letterSpacing = ls + 'px';
  const W = Math.ceil(octx.measureText(text).width + S0 * 1.5), H = Math.ceil(S0 * 2);
  off.width = Math.max(8, W); off.height = H;
  octx.font = font; if (HAS_LS) octx.letterSpacing = ls + 'px';
  octx.textBaseline = 'alphabetic'; octx.fillStyle = '#000';
  const x0 = S0 * 0.4, y0 = S0 * 1.4;
  octx.fillText(text, x0, y0);
  const d = octx.getImageData(0, 0, off.width, H).data;
  let x1 = -1, y1 = -1, xa = off.width, ya = H;
  for (let y = 0; y < H; y++) for (let x = 0; x < off.width; x++) if (d[(y * off.width + x) * 4 + 3] > 110) { if (x < xa) xa = x; if (x > x1) x1 = x; if (y < ya) ya = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  return { bx: xa, by: ya, bw: x1 - xa + 1, bh: y1 - ya + 1, baseOff: y0 - ya };
}
// grille binaire GW×GH d'une source (canvas) rognée sur sa boîte
function grid(src, sx, sy, sw, sh, GW) {
  small.width = GW; small.height = GH;
  sctx.clearRect(0, 0, GW, GH);
  sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(src, sx, sy, sw, sh, 0, 0, GW, GH);
  const d = sctx.getImageData(0, 0, GW, GH).data, g = new Uint8Array(GW * GH);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4 + 3] > 120 ? 1 : 0;
  return g;
}

/**
 * @param maskCanvas canvas dont le canal alpha vaut 255 sur l'encre (boîte serrée de la ligne)
 * @param text texte de la ligne
 * @param opt { words: [{a, b, text}] colonnes (px du masque) de chaque mot — comparaison mot à mot, sans dérive ; prefer: id préféré }
 * @returns { c, size (px de la page), baseOff (px, depuis le haut de l'encre), ls (px), iou, score, ranked }
 */
export async function identify(maskCanvas, text, opt = {}) {
  await loadLib(); ctxs();
  text = text.replace(/\s+/g, ' ').trim();
  const tw = maskCanvas.width, th = maskCanvas.height;
  if (!text || tw < 4 || th < 4) return null;
  const md = maskCanvas.getContext('2d').getImageData(0, 0, tw, th).data;
  let words = opt.words && opt.words.length > 1 ? opt.words : [{ a: 0, b: tw, text }];
  // cadre serré de l'encre de chaque mot (le mot n'a pas forcément d'ascendante ni de descendante)
  words = words.map((w) => {
    let xa = w.b, xb = w.a - 1, ya = th, yb = -1;
    for (let y = 0; y < th; y++) for (let x = w.a; x < w.b; x++) if (md[(y * tw + x) * 4 + 3] > 0) { if (x < xa) xa = x; if (x > xb) xb = x; if (y < ya) ya = y; if (y > yb) yb = y; }
    return xb < xa ? null : { ...w, xa, xb, ya, yb, tw: xb - xa + 1, th: yb - ya + 1 };
  }).filter(Boolean);
  if (!words.length) return null;
  for (const w of words) { w.GW = Math.max(6, Math.min(300, Math.round(GH * w.tw / w.th))); w.g = grid(maskCanvas, w.xa, w.ya, w.tw, w.th, w.GW); }
  const S0 = 72, ranked = [];
  for (const c of LIB) {
    if (!c.ok) continue;
    const m0 = draw(c, text, S0, 0);
    if (!m0) continue;
    const k = th / m0.bh; // échelle déduite de la hauteur de la ligne entière
    let sInter = 0, sUni = 0, lsSum = 0, lsN = 0, bad = false;
    const pw = [];
    for (const w of words) {
      const n = [...w.text].length - 1;
      const mw0 = draw(c, w.text, S0, 0);
      if (!mw0) { bad = true; break; }
      let ls = 0, mw = mw0;
      if (HAS_LS && n > 0) {
        ls = (w.tw / k - mw0.bw) / n;
        if (Math.abs(ls) > 0.5 * S0) { bad = true; break; }
        if (Math.abs(ls) > 0.01 * S0) mw = draw(c, w.text, S0, ls) || mw0; else ls = 0;
        lsSum += ls * n; lsN += n;
      } else if (Math.abs(w.tw / k / mw0.bw - 1) > 0.5) { bad = true; break; }
      const g = grid(off, mw.bx, mw.by, mw.bw, mw.bh, w.GW);
      let inter = 0, uni = 0;
      for (let i = 0; i < g.length; i++) { const a = g[i], b = w.g[i]; if (a & b) inter++; if (a | b) uni++; }
      sInter += inter * (w.tw * w.th) / g.length; sUni += uni * (w.tw * w.th) / g.length;
      pw.push({ iou: uni ? inter / uni : 0, ls });
    }
    if (bad || !sUni) continue;
    const ls = lsN ? lsSum / lsN : 0, iou = sInter / sUni;
    const pen = 1.5 * Math.abs(ls) / S0 + (opt.prefer && opt.prefer.includes(c.id) ? -0.03 : 0) + (opt.families && opt.families.includes(c.family) ? -0.045 : 0); // a priori : familles déjà reconnues avec certitude dans le document
    ranked.push({ c, score: iou - pen, iou, pw, ls: ls * k, size: S0 * k, baseOff: m0.baseOff * k, lsb: (m0.bx - S0 * 0.4) * k, k });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  // police propre à chaque mot (ex. « 6 compétences » en gras dans une ligne en romain) : seulement si le gain est net
  let top = ranked[0];
  if (opt.force) { const f = ranked.find((r) => r.c.id === opt.force); if (f && f.score >= top.score - 0.07) top = f; } // police imposée par le contexte (lignes voisines de même style)
  const wordFonts = words.map((w, i) => {
    if ([...w.text].length < 4 || words.length < 2) return null;
    let best = null, bs = -1;
    for (const r of ranked) { if (r.c.family !== top.c.family) continue; const sc = r.pw[i].iou - 1.5 * Math.abs(r.pw[i].ls) / S0; if (sc > bs) { bs = sc; best = r; } }
    const cur = top.pw[i].iou - 1.5 * Math.abs(top.pw[i].ls) / S0;
    return best && best.c !== top.c && bs - cur >= 0.12 && best.pw[i].iou > 0.5 ? best.c : null;
  });
  return { ...top, wordFonts, wordTexts: words.map((w) => w.text), ranked: ranked.slice(0, 5) };
}
