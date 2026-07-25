// Lazy Python engine (Pyodide) behind the notebook tool. Self-hosted under
// /pyodide/ (staged by scripts/pyodide-assets.mjs); pandas + matplotlib wheels
// are included in CI builds and each degrades gracefully when absent. Globals
// persist across cells — that's what makes it a notebook.
//
// Stopping a cell is a restart, not an interrupt: reliable Pyodide interruption
// needs SharedArrayBuffer, which needs cross-origin isolation (COOP/COEP), which
// neither GitHub Pages nor a file:// offline copy can provide. So Stop kills the
// worker and boots a fresh one; the tool re-registers the tables afterwards and
// tells the user their variables are gone. Honest and instant beats unavailable.
import PythonWorker from '../workers/python.worker?worker';
import type { SheetData, CellValue } from './types';
import type { NotebookOutput } from './notebook';

export type CellOut = NotebookOutput;

export interface CellResult {
  ok: boolean;
  stdout: string;
  outputs: CellOut[];
  error?: string;
  /** Exception class name, when the cell raised. */
  etype?: string;
  elapsedMs: number;
}

export interface EngineInfo {
  pandas: boolean;
  charts: boolean;
}

/** One entry in the variable inspector. */
export interface PyVariable {
  name: string;
  type: string;
  detail: string;
  columns?: string[];
}

let worker: Worker | null = null;
let readyPromise: Promise<EngineInfo> | null = null;
let info: EngineInfo | null = null;
let nextId = 1;
let running = 0;
const pendingCells = new Map<number, { resolve: (r: CellResult) => void }>();
let pendingRegister: { resolve: () => void; reject: (e: Error) => void } | null = null;
let pendingVars: { resolve: (v: PyVariable[]) => void } | null = null;

function indexURL(): string {
  return new URL(import.meta.env.BASE_URL + 'pyodide/', document.baseURI).href;
}

/** Boot the engine (idempotent). Resolves with pandas/charts availability. */
export function initPython(): Promise<EngineInfo> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    const w = new PythonWorker();
    worker = w;
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.kind === 'ready') {
        info = { pandas: m.pandas, charts: m.charts };
        resolve(info);
      } else if (m.kind === 'registered') {
        pendingRegister?.resolve();
        pendingRegister = null;
      } else if (m.kind === 'vars') {
        pendingVars?.resolve(m.vars ?? []);
        pendingVars = null;
      } else if (m.kind === 'error') {
        pendingRegister?.reject(new Error(m.error));
        pendingRegister = null;
        reject(new Error(m.error));
      } else if (m.kind === 'cellResult') {
        const p = pendingCells.get(m.id);
        if (!p) return;
        pendingCells.delete(m.id);
        running = Math.max(0, running - 1);
        p.resolve({
          ok: m.ok,
          stdout: m.stdout ?? '',
          outputs: m.outputs ?? [],
          error: m.error,
          etype: m.etype,
          elapsedMs: m.elapsedMs ?? 0,
        });
      }
    };
    w.onerror = (e) => reject(new Error(e.message || 'Python worker crashed'));
    w.postMessage({ kind: 'init', indexURL: indexURL() });
  });
  return readyPromise;
}

/** Engine capabilities once booted, or null before first use. */
export function engineInfo(): EngineInfo | null {
  return info;
}

/** True while at least one cell is executing. */
export function isBusy(): boolean {
  return running > 0;
}

/**
 * Kill the running engine and boot a clean one. Every in-flight cell settles as
 * interrupted; registered tables must be re-registered by the caller.
 */
export async function restartPython(): Promise<EngineInfo> {
  const dying = worker;
  worker = null;
  readyPromise = null;
  info = null;
  running = 0;
  for (const [, p] of pendingCells) {
    p.resolve({ ok: false, stdout: '', outputs: [], error: 'KeyboardInterrupt: stopped', etype: 'KeyboardInterrupt', elapsedMs: 0 });
  }
  pendingCells.clear();
  pendingRegister?.reject(new Error('Python engine restarted'));
  pendingRegister = null;
  pendingVars?.resolve([]);
  pendingVars = null;
  dying?.terminate();
  return initPython();
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
  running++;
  return new Promise((resolve) => {
    pendingCells.set(id, { resolve });
    worker!.postMessage({ kind: 'runCell', id, code });
  });
}

/** Everything currently in scope, for the variable inspector. */
export async function listVariables(): Promise<PyVariable[]> {
  if (!readyPromise) return [];
  await initPython();
  return new Promise((resolve) => {
    pendingVars = { resolve };
    worker!.postMessage({ kind: 'vars' });
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

export type { CellValue };
