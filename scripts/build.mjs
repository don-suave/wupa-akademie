// Baut public/ aus app/app.html und app/shim.js.
// app/app.html ist dieselbe Datei, die auch in Claude läuft. Hier bekommt sie ein
// vollständiges HTML-Gerüst und den Server-Anschluss (shim.js).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'app/app.html'), 'utf8');

const title = (src.match(/<title>([\s\S]*?)<\/title>/) || [, 'Wupa Akademie'])[1].trim();
const links = [...src.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).join('\n');
const body = src
  .replace(/<title>[\s\S]*?<\/title>/, '')
  .replace(/<link\b[^>]*>/g, '')
  .replace(/<meta name="claude:viewport-fit-sides"[^>]*>/, '');

const icon = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#12A5BA"/><path d="M14 20l8 26 10-18 10 18 8-26" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
);

const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#12A5BA">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,${icon}">
${links}
<style>
:root{color-scheme:light;padding-block:env(safe-area-inset-top,0px) env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px system-ui,sans-serif}
img{max-width:100%}
[hidden]{display:none!important}
</style>
</head>
<body>
<script src="/shim.js"></script>
${body}
</body>
</html>
`;

const out = join(root, 'public');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), html);
copyFileSync(join(root, 'app/shim.js'), join(out, 'shim.js'));
writeFileSync(
  join(out, '_headers'),
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss:; frame-ancestors 'none'
/shim.js
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
`,
);
console.log('public/ gebaut:', (html.length / 1024).toFixed(0), 'KB');
