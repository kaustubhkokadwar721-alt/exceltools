// Lazy DuckDB-WASM engine for the intermediate tier (Query, Pivot). Everything
// is self-hosted — the .wasm and worker are bundled via Vite `?url` imports, so
// nothing is fetched from a CDN (offline-safe and CSP-clean). We ship the mvp +
// eh bundles only; the coi bundle needs cross-origin isolation that static Pages
// hosting doesn't provide, and the single-threaded bundles work fine without it.
//
// This whole module (and the ~multi-MB wasm) is loaded on demand — it is only
// imported when a Tier-2 tool is opened, keeping the light tools tiny.
import * as duckdb from '@duckdb/duckdb-wasm';
import mvp_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import eh_wasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { SheetData, CellValue } from './types';

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function getDB(): Promise<duckdb.AsyncDuckDB> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    // selectBundle picks eh vs mvp based on the browser's WASM exception support.
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: mvp_wasm, mainWorker: mvp_worker },
      eh: { mainModule: eh_wasm, mainWorker: eh_worker },
    });
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return db;
  })();
  return dbPromise;
}

/** Turn an arbitrary label into a safe, unique SQL identifier. */
export function tableIdent(label: string, used: Set<string>): string {
  let base = label.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base || /^\d/.test(base)) base = 't_' + base;
  base = base.toLowerCase().slice(0, 60) || 'sheet';
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

/**
 * Register a parsed sheet as a DuckDB table. The data goes in via CSV +
 * read_csv_auto so DuckDB infers column types (numbers become numbers, etc.).
 */
export async function registerSheet(tableName: string, sheet: SheetData): Promise<void> {
  const db = await getDB();
  const csv = toCSV(sheet);
  const fileName = `${tableName}.csv`;
  await db.registerFileText(fileName, csv);
  const conn = await db.connect();
  try {
    await conn.query(
      `CREATE OR REPLACE TABLE "${tableName}" AS ` +
        `SELECT * FROM read_csv_auto('${fileName}', header=true, sample_size=-1)`,
    );
  } finally {
    await conn.close();
  }
}

/**
 * Register a resolved table with **exact** per-column types. The rows were
 * already coerced by resolveSource, so each column's DuckDB type is read from its
 * values (all-number → DOUBLE, all-boolean → BOOLEAN, else VARCHAR — so a
 * text/skip import stays text). Loaded as all-text CSV then CAST, which keeps
 * types under our strict CSP (Arrow's codegen needs eval, which CSP forbids).
 */
export async function insertTable(tableName: string, sheet: SheetData): Promise<void> {
  const db = await getDB();
  const types = sheet.headers.map((_, i) => columnDuckType(sheet.rows.map((r) => r[i] ?? null)));
  const csv = toCSV(sheet);
  const fileName = `${tableName}.csv`;
  await db.registerFileText(fileName, csv);
  const selects = sheet.headers
    .map((h, i) => (types[i] === 'VARCHAR' ? `"${esc(h)}"` : `CAST("${esc(h)}" AS ${types[i]}) AS "${esc(h)}"`))
    .join(', ');
  const conn = await db.connect();
  try {
    await conn.query(
      `CREATE OR REPLACE TABLE "${esc(tableName)}" AS ` +
        `SELECT ${selects} FROM read_csv_auto('${fileName}', header=true, all_varchar=true, sample_size=-1)`,
    );
  } finally {
    await conn.close();
  }
}

function columnDuckType(values: CellValue[]): 'DOUBLE' | 'BOOLEAN' | 'VARCHAR' {
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  if (!nonNull.length) return 'VARCHAR';
  if (nonNull.every((v) => typeof v === 'number')) return 'DOUBLE';
  if (nonNull.every((v) => typeof v === 'boolean')) return 'BOOLEAN';
  return 'VARCHAR';
}

const esc = (id: string) => id.replace(/"/g, '""');

export interface QueryOutcome {
  sheet: SheetData;
  elapsedMs: number;
}

/** Run a SQL statement and return the result as a SheetData grid. */
export async function runQuery(sql: string): Promise<QueryOutcome> {
  const db = await getDB();
  const conn = await db.connect();
  const started = performance.now();
  try {
    const table = await conn.query(sql);
    const headers = table.schema.fields.map((f) => f.name);
    const rows: CellValue[][] = [];
    for (const row of table.toArray()) {
      rows.push(headers.map((h) => normalize((row as Record<string, unknown>)[h])));
    }
    return {
      sheet: { name: 'Result', headers, rows, totalRows: rows.length },
      elapsedMs: performance.now() - started,
    };
  } finally {
    await conn.close();
  }
}

/** Drop every user table — used when a tool reloads a fresh set of files. */
export async function resetTables(): Promise<void> {
  if (!dbPromise) return;
  const db = await getDB();
  const conn = await db.connect();
  try {
    const tables = await conn.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='main'`);
    for (const row of tables.toArray()) {
      const name = (row as Record<string, unknown>).table_name as string;
      await conn.query(`DROP TABLE IF EXISTS "${name}"`);
    }
  } finally {
    await conn.close();
  }
}

// ---- helpers ---------------------------------------------------------------

// Convert Arrow/DuckDB cell values into plain JS primitives for the grid and
// downstream serialization.
function normalize(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    // Keep exact integers as numbers when safe, else fall back to string.
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return String(v);
}

function toCSV(sheet: SheetData): string {
  const esc = (v: CellValue) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = sheet.headers.map(esc).join(',');
  const body = sheet.rows.map((r) => sheet.headers.map((_, i) => esc(r[i] ?? null)).join(',')).join('\n');
  return body ? `${head}\n${body}` : head;
}
