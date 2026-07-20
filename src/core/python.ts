// Lazy Python engine (Pyodide) behind the notebook tool. Self-hosted under
// /pyodide/ (staged by scripts/pyodide-assets.mjs); pandas + matplotlib wheels
// are included in CI builds and each degrades gracefully when absent. Globals
// persist across cells — that's what makes it a notebook.
import PythonWorker from '../workers/python.worker?worker';
import type { SheetData, CellValue } from './types';

export type CellOut =
  | { type: 'table'; headers: string[]; rows: CellValue[][] }
  | { type: 'image'; png: string }
  | { type: 'text'; text: string };

export interface CellResult {
  ok: boolean;
  stdout: string;
  outputs: CellOut[];
  error?: string;
  elapsedMs: number;
}

export interface EngineInfo {
  pandas: boolean;
  charts: boolean;
}

let worker: Worker | null = null;
let readyPromise: Promise<EngineInfo> | null = null;
let nextId = 1;
const pendingCells = new Map<number, { resolve: (r: CellResult) => void }>();
let pendingRegister: { resolve: () => void; reject: (e: Error) => void } | null = null;

function indexURL(): string {
  return new URL(import.meta.env.BASE_URL + 'pyodide/', document.baseURI).href;
}

/** Boot the engine (idempotent). Resolves with pandas/charts availability. */
export function initPython(): Promise<EngineInfo> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    worker = new PythonWorker();
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.kind === 'ready') resolve({ pandas: m.pandas, charts: m.charts });
      else if (m.kind === 'registered') pendingRegister?.resolve();
      else if (m.kind === 'error') {
        pendingRegister?.reject(new Error(m.error));
        reject(new Error(m.error));
      } else if (m.kind === 'cellResult') {
        const p = pendingCells.get(m.id);
        if (!p) return;
        pendingCells.delete(m.id);
        p.resolve({ ok: m.ok, stdout: m.stdout ?? '', outputs: m.outputs ?? [], error: m.error, elapsedMs: m.elapsedMs ?? 0 });
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

/** Run one notebook cell. Never rejects — errors come back in the result. */
export async function runCell(code: string): Promise<CellResult> {
  await initPython();
  const id = nextId++;
  return new Promise((resolve) => {
    pendingCells.set(id, { resolve });
    worker!.postMessage({ kind: 'runCell', id, code });
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
