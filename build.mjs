// Assemble un fichier HTML unique et autonome : index.html
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
let ver = 'dev'; try { ver = execSync('git rev-parse --short HEAD').toString().trim() + ' · ' + new Date().toISOString().slice(0, 16).replace('T', ' '); } catch (e) { /* */ }

const res = await build({
  entryPoints: ['src/app.js'],
  bundle: true, minify: !process.env.DEBUG_BUILD, write: false, format: 'iife', target: 'es2022',
  loader: { '.woff': 'binary' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const app = res.outputFiles[0].text;
const css = readFileSync('src/style.css', 'utf8');
const esc = (s) => s.replace(/<\/(script)/gi, '<\\/$1');
let html = readFileSync('src/index.html', 'utf8');
html = html
  .replace('/*STYLE*/', () => css)
  .replace('/*VER*/', () => ver)
  .replace('/*APP*/', () => esc(app));

writeFileSync('index.html', html);
console.log('index.html', (html.length / 1048576).toFixed(2), 'Mo');
