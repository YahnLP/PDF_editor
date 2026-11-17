// Assemble un fichier HTML unique et autonome : dist/pdf-editor.html
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const res = await build({
  entryPoints: ['src/app.js'],
  bundle: true, minify: true, write: false, format: 'iife', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const app = res.outputFiles[0].text;
const css = readFileSync('src/style.css', 'utf8');
const esc = (s) => s.replace(/<\/(script)/gi, '<\\/$1');
let html = readFileSync('src/index.html', 'utf8');
html = html
  .replace('/*STYLE*/', () => css)
  .replace('/*APP*/', () => esc(app));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/pdf-editor.html', html);
console.log('dist/pdf-editor.html', (html.length / 1048576).toFixed(2), 'Mo');
