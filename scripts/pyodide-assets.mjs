// Stage the Python engine's static assets into public/pyodide/ so Vite ships
// them as-is (they are runtime-fetched by indexURL, not bundled).
//
// 1. Core (always, from node_modules — offline-safe, no download).
// 2. pandas + matplotlib wheels (best-effort download from the Pyodide CDN; CI
//    has internet, a sandboxed/offline dev box may not). Missing wheels only
//    disable the pandas path — the Python tool still runs pure Python.
//
// SECURITY — every downloaded wheel is verified against the SHA-256 recorded in
// `pyodide-lock.json`, which ships inside the pinned `pyodide` npm package and
// therefore comes from the same integrity-checked source as the rest of
// node_modules. These wheels become executable code inside every user's
// browser, so a compromised CDN, a hijacked build machine or a poisoned cache
// would otherwise put arbitrary code into the shipped product with nothing to
// notice it. Anything that fails the check is deleted, never staged, and the
// build continues without the pandas path rather than shipping something
// unverified. Files already present are re-verified on every run, so a wheel
// tampered with after download cannot survive to the next build.
import { mkdirSync, copyFileSync, existsSync, statSync, createWriteStream, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
const WANT = [
  // pandas set
  'pandas', 'numpy', 'python-dateutil', 'pytz', 'six',
  // matplotlib set (charts in the notebook)
  'matplotlib', 'contourpy', 'cycler', 'fonttools', 'kiwisolver', 'packaging', 'pillow', 'pyparsing',
];

// Carry the expected digest with each file name; a wheel with no recorded
// digest is not staged at all, because it could not be verified.
const wheels = WANT.map((n) => lock.packages[n]).filter(Boolean).map((p) => ({ file: p.file_name, sha256: p.sha256 }));
for (const n of WANT) {
  const p = lock.packages[n];
  if (p && !p.sha256) console.warn(`no digest recorded for ${n} — it will be skipped`);
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

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

/** Throw unless the file on disk is exactly what the lock file says it is. */
function verify(dest, expected, what) {
  const actual = sha256(dest);
  if (actual !== expected) {
    rmSync(dest, { force: true });
    throw new Error(`SHA-256 mismatch for ${what} — expected ${expected}, got ${actual}. File deleted, not staged.`);
  }
}

let ok = 0;
let rejected = 0;
for (const { file, sha256: expected } of wheels) {
  const dest = join(dst, file);
  if (!expected) {
    rejected++;
    console.warn(`skipped (no digest in lock file): ${file}`);
    continue;
  }
  try {
    if (existsSync(dest) && statSync(dest).size > 0) {
      // Re-verify what is already on disk: caches get poisoned too.
      verify(dest, expected, file);
      ok++;
      continue;
    }
    await download(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${file}`, dest);
    verify(dest, expected, file);
    ok++;
    console.log(`wheel: ${file} (sha256 verified)`);
  } catch (e) {
    if (e.message.startsWith('SHA-256 mismatch')) {
      rejected++;
      console.error(`REJECTED ${e.message}`);
    } else {
      console.warn(`wheel unavailable (${e.message}): ${file} — pandas path will be disabled in this build`);
    }
  }
}

console.log(`wheels staged: ${ok}/${wheels.length} (sha256-verified)${rejected ? `, ${rejected} REJECTED` : ''}`);

// A digest mismatch is not a flaky download — it means the bytes are not what
// the pinned Pyodide release says they should be. Fail the build loudly.
if (rejected) {
  console.error('\nBuild stopped: one or more Pyodide wheels failed integrity verification.');
  process.exit(1);
}
