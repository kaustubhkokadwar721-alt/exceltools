// Resolve a native table (its sliced grid) + a user SourceSpec into a normal
// SheetData: column selection, renaming, and type coercion (or skip). Pure and
// testable — no SheetJS, no DOM.
import type { TableDef, SourceSpec, SourceColumn, ColType, SheetData, CellValue } from './types';

// Numeric text like "1,000" or "-42.5" (shared shape with transform.ts).
const NUMERIC = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/;
const BOOL_TRUE = new Set(['true', 'yes', 'y', '1']);
const BOOL_FALSE = new Set(['false', 'no', 'n', '0']);

/** Default spec for a freshly detected table: all columns in, auto types. */
export function buildDefaultSpec(def: TableDef): SourceSpec {
  const header = (def.grid[0] as CellValue[] | undefined) ?? [];
  const names = def.columns.length ? def.columns : header.map((h, i) => String(h ?? colLetter(i)));
  return {
    name: def.name,
    columns: names.map((n) => ({ source: n, name: n, include: true, type: 'auto' as ColType })),
    skipTypeDetection: false,
  };
}

/** Resolve a table + spec into SheetData with coerced values. */
export function resolveSource(def: TableDef, spec: SourceSpec): SheetData {
  const header = (def.grid[0] as CellValue[] | undefined) ?? [];
  const body = def.grid.slice(1) as CellValue[][];

  // Map each spec column to a grid index (by header name, else declared order).
  const cols = spec.columns
    .map((c, specIdx) => {
      let gi = header.findIndex((h) => String(h ?? '') === c.source);
      if (gi === -1) gi = def.columns.indexOf(c.source);
      if (gi === -1) gi = specIdx;
      return { spec: c, gi };
    })
    .filter((c) => c.spec.include);

  const headers = cols.map((c) => c.spec.name);
  const rawCols = cols.map((c) => body.map((r) => r[c.gi] ?? null));

  const resolvedCols = rawCols.map((values, i) => {
    const t: ColType = spec.skipTypeDetection ? 'text' : cols[i].spec.type;
    return coerceColumn(values, t);
  });

  const rows: CellValue[][] = body.map((_, ri) => resolvedCols.map((col) => col[ri]));
  return { name: spec.name, headers, rows, totalRows: rows.length };
}

// ---- coercion --------------------------------------------------------------

function coerceColumn(values: CellValue[], type: ColType): CellValue[] {
  const effective = type === 'auto' ? inferType(values) : type;
  return values.map((v) => coerceCell(v, effective));
}

/** Auto: number if every non-empty value is numeric; boolean if all boolean-ish; else text. */
function inferType(values: CellValue[]): ColType {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (!nonEmpty.length) return 'text';
  if (nonEmpty.every(isNumeric)) return 'number';
  if (nonEmpty.every((v) => isBool(v) !== null)) return 'boolean';
  return 'text';
}

function coerceCell(v: CellValue, type: ColType): CellValue {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  switch (type) {
    case 'number': {
      if (typeof v === 'number') return v;
      const n = Number(String(v).trim().replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      const b = isBool(v);
      return b;
    }
    case 'date': {
      const d = v as unknown;
      if (d instanceof Date) return d.toISOString().slice(0, 10);
      return String(v);
    }
    case 'text':
    default:
      return typeof v === 'string' ? v : String(v);
  }
}

function isNumeric(v: CellValue): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && NUMERIC.test(v.trim());
}

function isBool(v: CellValue): boolean | null {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (BOOL_TRUE.has(s)) return true;
  if (BOOL_FALSE.has(s)) return false;
  return null;
}

function colLetter(i: number): string {
  let s = '';
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export type { SourceColumn };
