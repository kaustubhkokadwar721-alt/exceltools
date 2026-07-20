// Stage the Python engine's static assets into public/pyodide/ so Vite ships
// them as-is (they are runtime-fetched by indexURL, not bundled).
//
// 1. Core (always, from node_modules — offline-safe).
// 2. pandas wheel set (best-effort download from the Pyodide CDN; CI has
//    internet, a sandboxed/offline dev box may not). Missing wheels only
//    disable the pandas path — the Python tool still runs pure Python.
import { mkdirSync, copyFileSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'node_modules', 'pyodide');
const dst = join(root, 'public', 'pyodide');
mkdirSync(dst, { recursive: true });

const CORE = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
for (const f of CORE) copyFileSync(join(src, f), join(dst, f));
console.log(`pyodide core staged (${CORE.length} files)`);

const lock = (await import('file://' + join(src, 'pyodide-lock.json'), { with: { type: 'json' } })).default;
const version = JSON.parse((await import('node:fs')).readFileSync(join(src, 'package.json'), 'utf8')).version;
const WANT = [
  // pandas set
  'pandas', 'numpy', 'python-dateutil', 'pytz', 'six',
  // matplotlib set (charts in the notebook)
  'matplotlib', 'contourpy', 'cycler', 'fonttools', 'kiwisolver', 'packaging', 'pillow', 'pyparsing',
];
const wheels = WANT.map((n) => lock.packages[n]?.file_name).filter(Boolean);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) return download(res.headers.location, dest).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject).setTimeout(60000, function () { this.destroy(new Error('timeout')); });
  });
}

let ok = 0;
for (const w of wheels) {
  const dest = join(dst, w);
  if (existsSync(dest) && statSync(dest).size > 0) { ok++; continue; }
  try {
    await download(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${w}`, dest);
    ok++;
    console.log(`wheel: ${w}`);
  } catch (e) {
    console.warn(`wheel unavailable (${e.message}): ${w} — pandas path will be disabled in this build`);
  }
}
console.log(`wheels staged: ${ok}/${wheels.length}`);
