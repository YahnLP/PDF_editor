// Texte riche : modèle de paragraphes + éditeur ProseMirror (MIT, https://prosemirror.net)
// Modèle d'un objet texte : paras = [{ list?:'b'|'n', lvl?, align?, runs:[{ t, b?, i?, u?, c?, sz?, f? }] }]
// Seules les propriétés qui diffèrent des valeurs par défaut de l'objet sont stockées dans un run.
import { Schema } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';

export const IND = 18; // retrait par niveau (pt)
export const MW = 16; // largeur du repère (puce / numéro)

/* ---------- numérotation ---------- */
const alpha = (n) => String.fromCharCode(97 + ((n - 1) % 26));
const roman = (n) => { let s = ''; for (const [v, c] of [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) while (n >= v) { s += c; n -= v; } return s; };
export function listLabels(items) {
  const cnt = [0, 0, 0, 0], out = [];
  for (const p of items) {
    const l = Math.min(p.lvl || 0, 3);
    if (p.list === 'n') {
      cnt[l]++; for (let k = l + 1; k < 4; k++) cnt[k] = 0;
      out.push((l === 1 ? alpha(cnt[l]) : l === 2 ? roman(cnt[l]) : cnt[l]) + '.');
    } else if (p.list === 'b') { for (let k = l + 1; k < 4; k++) cnt[k] = 0; out.push(['•', '–', '•', '–'][l]); }
    else { cnt.fill(0); out.push(null); }
  }
  return out;
}

/* ---------- schéma ---------- */
let fontCss = () => 'sans-serif';
export const setFontCss = (fn) => { fontCss = fn; };
const boolMark = (prop, on, off, tags) => ({
  attrs: { v: { default: true } },
  toDOM: (m) => ['span', { style: m.attrs.v ? on : off }, 0],
  parseDOM: tags,
});
export const schema = new Schema({
  nodes: {
    doc: { content: 'para+' },
    para: {
      content: 'inline*', attrs: { list: { default: null }, lvl: { default: 0 }, align: { default: null } },
      toDOM: (n) => {
        const lvl = n.attrs.lvl || 0;
        const a = { style: `padding-left:${lvl * IND + (n.attrs.list ? MW : 0)}px;--ml:${lvl * IND}px;${n.attrs.align ? `text-align:${n.attrs.align};` : ''}` };
        if (n.attrs.list) a['data-list'] = n.attrs.list;
        return ['div', a, 0];
      },
      parseDOM: [{ tag: 'div,p', getAttrs: (d) => ({ align: d.style.textAlign || null }) }],
    },
    text: { group: 'inline' },
    br: { inline: true, group: 'inline', selectable: false, toDOM: () => ['br'], parseDOM: [{ tag: 'br' }] },
  },
  marks: {
    b: boolMark('b', 'font-weight:700', 'font-weight:400', [{ tag: 'b' }, { tag: 'strong' }]),
    i: boolMark('i', 'font-style:italic', 'font-style:normal', [{ tag: 'i' }, { tag: 'em' }]),
    u: boolMark('u', 'text-decoration:underline', 'text-decoration:none', [{ tag: 'u' }]),
    c: { attrs: { v: { default: '#000000' } }, toDOM: (m) => ['span', { style: `color:${m.attrs.v}` }, 0] },
    sz: { attrs: { v: { default: 12 } }, toDOM: (m) => ['span', { style: `font-size:${m.attrs.v}px` }, 0] },
    f: { attrs: { v: { default: 'helvetica' } }, toDOM: (m) => ['span', { style: `font-family:${fontCss(m.attrs.v)}` }, 0] },
  },
});
const MARKS = ['b', 'i', 'u', 'c', 'sz', 'f'];

/* ---------- conversions modèle <-> document ProseMirror ---------- */
export function docFromParas(paras) {
  return schema.node('doc', null, paras.map((p) => {
    const kids = [];
    for (const r of p.runs) {
      const marks = MARKS.filter((k) => r[k] !== undefined).map((k) => schema.marks[k].create({ v: r[k] }));
      r.t.split('\n').forEach((seg, si) => {
        if (si > 0) kids.push(schema.nodes.br.create());
        if (seg) kids.push(schema.text(seg, marks));
      });
    }
    return schema.node('para', { list: p.list || null, lvl: p.lvl || 0, align: p.align || null }, kids);
  }));
}
const sameProps = (a, b) => MARKS.every((k) => a[k] === b[k]);
export function parasFromDoc(doc) {
  const out = [];
  doc.forEach((pn) => {
    const para = { runs: [] };
    if (pn.attrs.list) para.list = pn.attrs.list;
    if (pn.attrs.lvl) para.lvl = pn.attrs.lvl;
    if (pn.attrs.align) para.align = pn.attrs.align;
    pn.forEach((ch) => {
      let run;
      if (ch.type.name === 'br') run = { t: '\n' };
      else { run = { t: ch.text }; for (const m of ch.marks) run[m.type.name] = m.attrs.v; }
      const last = para.runs[para.runs.length - 1];
      if (last && sameProps(last, run)) last.t += run.t; else para.runs.push(run);
    });
    out.push(para);
  });
  return out;
}

/* ---------- commandes ---------- */
function enter(state, dispatch) {
  const { $from } = state.selection;
  const node = $from.parent;
  if (node.type.name !== 'para') return false;
  if (node.attrs.list && node.content.size === 0) { // Entrée sur une puce vide : sort de la liste
    dispatch(state.tr.setNodeMarkup($from.before(), null, { ...node.attrs, list: null, lvl: 0 }));
    return true;
  }
  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  tr.split(tr.selection.from, 1, [{ type: schema.nodes.para, attrs: node.attrs }]);
  dispatch(tr.scrollIntoView());
  return true;
}
const indent = (dir) => (state, dispatch) => {
  const { from, to } = state.selection;
  const tr = state.tr;
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (n.type.name === 'para') tr.setNodeMarkup(pos, null, { ...n.attrs, lvl: Math.max(0, Math.min(3, (n.attrs.lvl || 0) + dir)) });
    return false;
  });
  if (dispatch) dispatch(tr);
  return true;
};
const numbering = new Plugin({
  props: {
    decorations(state) {
      const items = [];
      state.doc.forEach((n, pos) => items.push({ n, pos }));
      const labels = listLabels(items.map((x) => x.n.attrs));
      const decos = [];
      items.forEach((x, i) => { if (labels[i]) decos.push(Decoration.node(x.pos, x.pos + x.n.nodeSize, { 'data-m': labels[i] })); });
      return DecorationSet.create(state.doc, decos);
    },
  },
});

// h = { onChange(docChanged), toggle(key), blur() }
export function createEditor(mount, paras, h) {
  const km = keymap({
    Enter: enter,
    'Shift-Enter': (s, d) => { d(s.tr.replaceSelectionWith(schema.nodes.br.create()).scrollIntoView()); return true; },
    Tab: indent(1), 'Shift-Tab': indent(-1),
    'Mod-b': () => { h.toggle('b'); return true; }, 'Mod-i': () => { h.toggle('i'); return true; }, 'Mod-u': () => { h.toggle('u'); return true; },
    'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo,
    Escape: () => { h.blur(); return true; }, 'Mod-Enter': () => { h.blur(); return true; },
  });
  const doc = docFromParas(paras.length ? paras : [{ runs: [] }]);
  const state = EditorState.create({ doc, selection: TextSelection.atEnd(doc), plugins: [history(), km, keymap(baseKeymap), numbering] });
  const view = new EditorView({ mount }, {
    state, attributes: { spellcheck: 'false' },
    dispatchTransaction(tr) {
      const ns = view.state.apply(tr);
      view.updateState(ns);
      h.onChange(tr.docChanged);
    },
    handlePaste(v, e) { // collage en texte brut : prévisible
      const t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (t == null) return false;
      v.pasteText(t, e); return true;
    },
  });
  return view;
}
