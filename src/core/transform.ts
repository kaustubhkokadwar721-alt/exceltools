// Pure data transforms shared by the Merge, Split, and Compare tools. No
// SheetJS here — these operate on already-parsed SheetData, so they stay fast,
// testable, and free of the heavy parser bundle.
import type { SheetData, CellValue } from './types';

export interface NamedSheet {
  source: string; // file or sheet label, used for provenance
  sheet: SheetData;
}

// ---- Merge -----------------------------------------------------------------

/**
 * Stack multiple sheets into one, aligning columns by header NAME (not
 * position). Columns absent from a given sheet are filled with null. Optionally
 * prepends a "Source" column recording which input each row came from.
 */
export function mergeStack(inputs: NamedSheet[], addSource: boolean): SheetData {
  const headerOrder: string[] = [];
  const seen = new Set<string>();
  for (const { sheet } of inputs) {
    for (const h of sheet.headers) {
      if (!seen.has(h)) {
        seen.add(h);
        headerOrder.push(h);
      }
    }
  }

  const headers = addSource ? ['Source', ...headerOrder] : [...headerOrder];
  const rows: CellValue[][] = [];

  for (const { source, sheet } of inputs) {
    // Map each master header to this sheet's column index once, up front.
    const colIndex = headerOrder.map((h) => sheet.headers.indexOf(h));
    for (const r of sheet.rows) {
      const out: CellValue[] = addSource ? [source] : [];
      for (const ci of colIndex) out.push(ci === -1 ? null : r[ci] ?? null);
      rows.push(out);
    }
  }

  return { name: 'Merged', headers, rows, totalRows: rows.length };
}

// ---- Split -----------------------------------------------------------------

export interface SplitPart {
  key: string; // group label, used in the output file name
  sheet: SheetData;
}

/** Split a sheet into groups, one per distinct value in `colIndex`. */
export function splitByColumn(sheet: SheetData, colIndex: number): SplitPart[] {
  const groups = new Map<string, CellValue[][]>();
  for (const r of sheet.rows) {
    const raw = r[colIndex];
    const key = raw === null || raw === undefined || raw === '' ? '(blank)' : String(raw);
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, (bucket = []));
    bucket.push(r);
  }
  return [...groups.entries()].map(([key, rows]) => ({
    key,
    sheet: { name: key.slice(0, 31) || 'Sheet', headers: sheet.headers, rows, totalRows: rows.length },
  }));
}

/** Split a sheet into fixed-size chunks of `size` data rows each. */
export function splitByRows(sheet: SheetData, size: number): SplitPart[] {
  const parts: SplitPart[] = [];
  const n = Math.max(1, Math.floor(size));
  for (let start = 0; start < sheet.rows.length; start += n) {
    const rows = sheet.rows.slice(start, start + n);
    const from = start + 1;
    const to = start + rows.length;
    parts.push({
      key: `rows_${from}-${to}`,
      sheet: { name: `${from}-${to}`, headers: sheet.headers, rows, totalRows: rows.length },
    });
  }
  return parts;
}

// ---- Compare ---------------------------------------------------------------

export type DiffStatus = 'Only in A' | 'Only in B' | 'Changed' | 'Same';

export interface DiffResult {
  summary: { onlyA: number; onlyB: number; changed: number; same: number; dupKeysA: number; dupKeysB: number };
  /** A grid: leading "Status" + "Changed fields" columns, then the union of columns. */
  sheet: SheetData;
}

/**
 * Compare two sheets keyed on a column each. Reports rows only in A, only in B,
 * changed (same key, different non-key values), and unchanged. When a key
 * repeats within a sheet, the last occurrence wins and the collision is counted.
 */
export function diffSheets(
  a: SheetData,
  b: SheetData,
  keyColA: number,
  keyColB: number,
): DiffResult {
  const keyOf = (r: CellValue[], ci: number) => String(r[ci] ?? '');

  const indexRows = (sheet: SheetData, ci: number) => {
    const map = new Map<string, CellValue[]>();
    let dups = 0;
    for (const r of sheet.rows) {
      const k = keyOf(r, ci);
      if (map.has(k)) dups++;
      map.set(k, r);
    }
    return { map, dups };
  };

  const A = indexRows(a, keyColA);
  const B = indexRows(b, keyColB);

  // Union of columns by header name, driven by A then B (excluding B's key col
  // which corresponds to A's key col conceptually).
  const headerOrder: string[] = [];
  const seen = new Set<string>();
  const push = (h: string) => {
    if (!seen.has(h)) {
      seen.add(h);
      headerOrder.push(h);
    }
  };
  a.headers.forEach(push);
  b.headers.forEach(push);

  const aIdx = headerOrder.map((h) => a.headers.indexOf(h));
  const bIdx = headerOrder.map((h) => b.headers.indexOf(h));

  const outHeaders = ['Status', 'Changed fields', ...headerOrder];
  const rows: CellValue[][] = [];
  const summary = { onlyA: 0, onlyB: 0, changed: 0, same: 0, dupKeysA: A.dups, dupKeysB: B.dups };

  // Walk A's keys: classify as only-in-A, changed, or same.
  for (const [k, ra] of A.map) {
    const rb = B.map.get(k);
    if (!rb) {
      summary.onlyA++;
      rows.push(['Only in A', '', ...headerOrder.map((_, i) => (aIdx[i] === -1 ? null : ra[aIdx[i]] ?? null))]);
      continue;
    }
    // Compare non-key columns by header name.
    const changedFields: string[] = [];
    const merged: CellValue[] = headerOrder.map((h, i) => {
      const va = aIdx[i] === -1 ? null : ra[aIdx[i]] ?? null;
      const vb = bIdx[i] === -1 ? null : rb[bIdx[i]] ?? null;
      const isKey = i === headerOrder.indexOf(a.headers[keyColA]);
      if (!isKey && String(va ?? '') !== String(vb ?? '')) {
        changedFields.push(`${h}: ${fmt(va)}→${fmt(vb)}`);
        return vb; // show the new (B) value in the grid
      }
      return vb ?? va;
    });
    if (changedFields.length) {
      summary.changed++;
      rows.push(['Changed', changedFields.join('; '), ...merged]);
    } else {
      summary.same++;
      rows.push(['Same', '', ...merged]);
    }
  }

  // Walk B's keys for those absent from A.
  for (const [k, rb] of B.map) {
    if (A.map.has(k)) continue;
    summary.onlyB++;
    rows.push(['Only in B', '', ...headerOrder.map((_, i) => (bIdx[i] === -1 ? null : rb[bIdx[i]] ?? null))]);
  }

  return { summary, sheet: { name: 'Diff', headers: outHeaders, rows, totalRows: rows.length } };
}

function fmt(v: CellValue): string {
  if (v === null || v === undefined || v === '') return '∅';
  return String(v);
}

// ---- Dedupe ----------------------------------------------------------------

export interface DedupeResult {
  sheet: SheetData;
  kept: number;
  removed: number;
  duplicateGroups: number; // distinct keys that had more than one row
}

/**
 * Remove duplicate rows. Identity is defined by the values in `keyIndices`
 * (empty = use every column, i.e. exact whole-row match). `keep` chooses which
 * row of each duplicate group survives; original row order is preserved.
 */
export function dedupeByKeys(
  sheet: SheetData,
  keyIndices: number[],
  keep: 'first' | 'last',
): DedupeResult {
  const cols = keyIndices.length ? keyIndices : sheet.headers.map((_, i) => i);
  const sig = (r: CellValue[]) => cols.map((c) => normKey(r[c])).join('');

  const counts = new Map<string, number>();
  for (const r of sheet.rows) {
    const k = sig(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const duplicateGroups = [...counts.values()].filter((n) => n > 1).length;

  let out: CellValue[][];
  if (keep === 'first') {
    const seen = new Set<string>();
    out = sheet.rows.filter((r) => {
      const k = sig(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } else {
    // keep === 'last': the surviving row of each group is its final occurrence.
    const lastIndex = new Map<string, number>();
    sheet.rows.forEach((r, i) => lastIndex.set(sig(r), i));
    const keepIdx = new Set(lastIndex.values());
    out = sheet.rows.filter((_, i) => keepIdx.has(i));
  }

  return {
    sheet: { ...sheet, rows: out, totalRows: out.length },
    kept: out.length,
    removed: sheet.rows.length - out.length,
    duplicateGroups,
  };
}

function normKey(v: CellValue): string {
  // Case- and whitespace-insensitive so " Apple" and "apple" collide, matching
  // what users mean by "the same value".
  return String(v ?? '').trim().toLowerCase();
}

// ---- Clean -----------------------------------------------------------------

export type CaseMode = 'none' | 'lower' | 'upper' | 'title';

export interface CleanOptions {
  trim: boolean; // strip leading/trailing whitespace
  collapseSpaces: boolean; // collapse internal whitespace runs to one space
  caseMode: CaseMode; // normalise text case
  numbersFromText: boolean; // "1,000" / "42" text → real numbers
  removeBlankRows: boolean; // drop rows where every cell is empty
  removeBlankCols: boolean; // drop columns with an empty header and no data
}

export interface CleanResult {
  sheet: SheetData;
  cellsChanged: number;
  rowsRemoved: number;
  colsRemoved: number;
  numbersConverted: number;
}

const NUMERIC_TEXT = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/;

/** Apply the selected cleaning operations, returning the new sheet + a tally. */
export function cleanSheet(sheet: SheetData, opts: CleanOptions): CleanResult {
  let cellsChanged = 0;
  let numbersConverted = 0;

  const transformCell = (v: CellValue): CellValue => {
    if (typeof v !== 'string') return v;
    let s = v;
    if (opts.trim) s = s.trim();
    if (opts.collapseSpaces) s = s.replace(/\s+/g, ' ');
    if (opts.caseMode !== 'none') s = applyCase(s, opts.caseMode);
    if (opts.numbersFromText && NUMERIC_TEXT.test(s.trim())) {
      const n = Number(s.trim().replace(/,/g, ''));
      if (Number.isFinite(n)) {
        numbersConverted++;
        if (n !== (v as unknown as number)) cellsChanged++;
        return n;
      }
    }
    if (s !== v) cellsChanged++;
    return s;
  };

  let headers = [...sheet.headers];
  let rows = sheet.rows.map((r) => r.map(transformCell));

  let rowsRemoved = 0;
  if (opts.removeBlankRows) {
    const before = rows.length;
    rows = rows.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
    rowsRemoved = before - rows.length;
  }

  let colsRemoved = 0;
  if (opts.removeBlankCols) {
    const keepCol: number[] = [];
    headers.forEach((h, i) => {
      const headerEmpty = String(h ?? '').trim() === '' || /^[A-Z]+$/.test(h); // generated col name counts as "no header"
      const dataEmpty = rows.every((r) => r[i] === null || r[i] === undefined || String(r[i]).trim() === '');
      if (!(headerEmpty && dataEmpty)) keepCol.push(i);
    });
    colsRemoved = headers.length - keepCol.length;
    if (colsRemoved > 0) {
      headers = keepCol.map((i) => headers[i]);
      rows = rows.map((r) => keepCol.map((i) => r[i] ?? null));
    }
  }

  return {
    sheet: { ...sheet, headers, rows, totalRows: rows.length },
    cellsChanged,
    rowsRemoved,
    colsRemoved,
    numbersConverted,
  };
}

function applyCase(s: string, mode: CaseMode): string {
  switch (mode) {
    case 'lower':
      return s.toLowerCase();
    case 'upper':
      return s.toUpperCase();
    case 'title':
      return s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    default:
      return s;
  }
}
