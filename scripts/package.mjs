// Assemble the offline distributable: the built app + the standalone spike + a
// zero-dependency local-server launcher, zipped as exceltools-offline.zip.
// Run after `npm run build` (the `package` npm script does both).
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
if (!existsSync(dist)) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

const TOP = 'exceltools-offline';
const files = {}; // zip path -> bytes

function addDir(absDir, zipPrefix) {
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const zipPath = `${zipPrefix}/${name}`;
    if (statSync(abs).isDirectory()) addDir(abs, zipPath);
    else files[zipPath] = new Uint8Array(readFileSync(abs));
  }
}

addDir(dist, TOP); // the app sits at the root of the folder
if (existsSync(join(root, 'spike'))) addDir(join(root, 'spike'), `${TOP}/spike`);
for (const f of ['serve.py', 'serve.mjs', 'START-HERE.txt']) {
  files[`${TOP}/${f}`] = new Uint8Array(readFileSync(join(root, 'packaging', f)));
}

const zip = zipSync(files, { level: 6 });
const out = join(root, 'exceltools-offline.zip');
writeFileSync(out, zip);
console.log(
  `Wrote ${out}\n  ${Object.keys(files).length} files, ${(zip.length / 1024 / 1024).toFixed(1)} MB compressed`,
);
