// Lazy Python engine (Pyodide) for the Python analysis tool. Everything is
// self-hosted under /pyodide/ (staged by scripts/pyodide-assets.mjs); pandas
// wheels are included in CI builds and the engine degrades to pure Python when
// they're absent. This module is only imported when the Python tool opens.
import PythonWorker from '../workers/python.worker?worker';
import type { SheetData, CellValue } from './types';

interface RunResult {
  sheet: SheetData;
  elapsedMs: number;
}

let worker: Worker | null = null;
let readyPromise: Promise<{ pandas: boolean }> | null = null;
let nextId = 1;
const pendingRuns = new Map<number, { resolve: (r: RunResult) => void; reject: (e: Error) => void }>();
let pendingRegister: { resolve: () => void; reject: (e: Error) => void } | null = null;

function indexURL(): string {
  return new URL(import.meta.env.BASE_URL + 'pyodide/', document.baseURI).href;
}

/** Boot the engine (idempotent). Resolves with pandas availability. */
export function initPython(): Promise<{ pandas: boolean }> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    worker = new PythonWorker();
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.kind === 'ready') resolve({ pandas: m.pandas });
      else if (m.kind === 'registered') pendingRegister?.resolve();
      else if (m.kind === 'error') {
        pendingRegister?.reject(new Error(m.error));
        reject(new Error(m.error));
      } else if (m.kind === 'result') {
        const p = pendingRuns.get(m.id);
        if (!p) return;
        pendingRuns.delete(m.id);
        if (m.ok) {
          const rows = (m.table.rows as CellValue[][]) ?? [];
          p.resolve({
            sheet: { name: 'Result', headers: m.table.headers ?? [], rows, totalRows: rows.length },
            elapsedMs: m.elapsedMs ?? 0,
          });
        } else p.reject(new Error(m.error));
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Python worker crashed'));
    worker.postMessage({ kind: 'init', indexURL: indexURL() });
  });
  return readyPromise;
}

/** Register a resolved sheet as `tables["name"]` (+ `df_name` when pandas). */
export async function registerPyTable(name: string, sheet: SheetData): Promise<void> {
  await initPython();
  return new Promise((resolve, reject) => {
    pendingRegister = { resolve, reject };
    worker!.postMessage({ kind: 'register', name, headers: sheet.headers, rows: sheet.rows });
  });
}

/** Run user Python; the code must assign `result`. */
export async function runPython(code: string): Promise<RunResult> {
  await initPython();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pendingRuns.set(id, { resolve, reject });
    worker!.postMessage({ kind: 'run', id, code });
  });
}

/** Sanitise a label into a valid Python identifier. */
export function pyIdent(label: string, used: Set<string>): string {
  let base = label.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  if (!base || /^\d/.test(base)) base = 't_' + base;
  base = base.slice(0, 50) || 'table';
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}
