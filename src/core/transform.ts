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
