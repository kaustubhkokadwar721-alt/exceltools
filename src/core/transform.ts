// Pure data transforms shared by the Merge, Split, and Compare tools. No
// SheetJS here — these operate on already-parsed SheetData, so they stay fast,
// testable, and free of the heavy parser bundle.
import { numberFromText, looksNumericButUnparsed } from './numtext';
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

// Catch-all keys. Every row lands in some group — a value the rule cannot key
// is visible in the output under one of these, never quietly dropped.
export const BLANK_KEY = '(blank)';
export const UNMATCHED_KEY = '(unmatched)';
export const OTHER_KEY = '(other)';

/** How a group key is derived from a cell's text. */
export type KeyRule =
  | { kind: 'whole' }
  | { kind: 'separator'; sep: string; piece: number } // piece is 1-based
  | { kind: 'prefix'; length: number }
  | { kind: 'pattern'; source: string }; // first capture group, else whole match

/** Excel rejects these characters in a sheet name and caps it at 31 chars. */
function toSheetName(key: string): string {
  return key.replace(/[\\/:?*[\]]/g, '_').slice(0, 31) || 'Sheet';
}

function cellText(v: CellValue): string {
  return v === null || v === undefined || v === '' ? '' : String(v);
}

/** Bucket rows by a caller-supplied key, preserving first-seen group order. */
function groupRows(sheet: SheetData, keyOf: (row: CellValue[]) => string): SplitPart[] {
  const groups = new Map<string, CellValue[][]>();
  for (const r of sheet.rows) {
    const key = keyOf(r);
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, (bucket = []));
    bucket.push(r);
  }
  return [...groups.entries()].map(([key, rows]) => ({
    key,
    sheet: { name: toSheetName(key), headers: sheet.headers, rows, totalRows: rows.length },
  }));
}

/** Split a sheet into groups, one per distinct value in `colIndex`. */
export function splitByColumn(sheet: SheetData, colIndex: number): SplitPart[] {
  return groupRows(sheet, (r) => cellText(r[colIndex]) || BLANK_KEY);
}

/**
 * Compile a rule into a key function. A bad pattern throws here — once, at
 * build time — rather than on every row. Returns null when the rule cannot key
 * the value, which the callers turn into the (unmatched) bucket.
 */
export function keyDeriver(rule: KeyRule): (value: string) => string | null {
  switch (rule.kind) {
    case 'whole':
      return (v) => v;
    case 'separator': {
      const piece = Math.max(1, Math.floor(rule.piece));
      return (v) => {
        if (!rule.sep) return v;
        const parts = v.split(rule.sep);
        return parts.length >= piece ? parts[piece - 1].trim() : null;
      };
    }
    case 'prefix': {
      const n = Math.max(1, Math.floor(rule.length));
      return (v) => v.slice(0, n).trim() || null;
    }
    case 'pattern': {
      const re = new RegExp(rule.source);
      return (v) => {
        const m = re.exec(v);
        return m ? m[1] ?? m[0] : null;
      };
    }
  }
}

/** Split on a key derived from part of a column's value, not the whole cell. */
export function splitByDerived(sheet: SheetData, colIndex: number, rule: KeyRule): SplitPart[] {
  const derive = keyDeriver(rule);
  return groupRows(sheet, (r) => {
    const text = cellText(r[colIndex]);
    if (!text) return BLANK_KEY;
    return derive(text) || UNMATCHED_KEY;
  });
}

/**
 * Split on a caller-supplied value → file-name assignment, so many distinct
 * values can collapse into a few files. Values with no assignment either keep
 * their own file or collect under (other).
 */
export function splitByGroups(
  sheet: SheetData,
  colIndex: number,
  assign: Map<string, string>,
  unassigned: 'own' | 'other',
): SplitPart[] {
  return groupRows(sheet, (r) => {
    const text = cellText(r[colIndex]) || BLANK_KEY;
    return assign.get(text) ?? (unassigned === 'own' ? text : OTHER_KEY);
  });
}

/** One part per sheet — the inverse of Merge's "separate sheets" mode. */
export function splitBySheet(sheets: SheetData[]): SplitPart[] {
  return sheets.map((s) => ({ key: s.name, sheet: s }));
}

/** Distinct values of a column with their row counts, commonest first. */
export function distinctValues(sheet: SheetData, colIndex: number): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of sheet.rows) {
    const v = cellText(r[colIndex]) || BLANK_KEY;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
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
/** Field separator for composite keys — cannot occur in cell text. */
const KEY_SEP = '\u0001';

export function dedupeByKeys(
  sheet: SheetData,
  keyIndices: number[],
  keep: 'first' | 'last',
): DedupeResult {
  const cols = keyIndices.length ? keyIndices : sheet.headers.map((_, i) => i);
  // Joined on a separator no spreadsheet cell can contain, written as an escape
  // rather than a raw control byte so it survives review and editing. Joining on
  // '' would make the key ambiguous across column boundaries: ("INV-1", "2ACME")
  // and ("INV-12", "ACME") would both flatten to the same signature.
  const sig = (r: CellValue[]) => cols.map((c) => normKey(r[c])).join(KEY_SEP);

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
  /** Cells that look like numbers but were left as text, with a few examples.
   *  Silence here would mean a total that is quietly short. */
  numbersUnconverted: number;
  unconvertedSamples: string[];
}

const UNCONVERTED_SAMPLES = 5;

/** Apply the selected cleaning operations, returning the new sheet + a tally. */
export function cleanSheet(sheet: SheetData, opts: CleanOptions): CleanResult {
  let cellsChanged = 0;
  let numbersConverted = 0;
  let numbersUnconverted = 0;
  const unconvertedSamples: string[] = [];

  const transformCell = (v: CellValue): CellValue => {
    if (typeof v !== 'string') return v;
    let s = v;
    if (opts.trim) s = s.trim();
    if (opts.collapseSpaces) s = s.replace(/\s+/g, ' ');
    if (opts.caseMode !== 'none') s = applyCase(s, opts.caseMode);
    if (opts.numbersFromText) {
      const parsed = numberFromText(s);
      if (parsed) {
        numbersConverted++;
        cellsChanged++;
        return parsed.value;
      }
      // Not parseable, but shaped like a figure — report rather than swallow.
      if (looksNumericButUnparsed(s)) {
        numbersUnconverted++;
        if (unconvertedSamples.length < UNCONVERTED_SAMPLES && !unconvertedSamples.includes(s)) {
          unconvertedSamples.push(s);
        }
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
    numbersUnconverted,
    unconvertedSamples,
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
