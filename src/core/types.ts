// Shared types across the shell, core, and workers.

/** A single parsed sheet: header row + data rows, all as strings/primitives. */
export interface SheetData {
  name: string;
  /** Column headers (first row if present, else generated A, B, C...). */
  headers: string[];
  /** Data rows, each aligned to `headers` length. */
  rows: CellValue[][];
  /** Total row count before any preview truncation. */
  totalRows: number;
}

export type CellValue = string | number | boolean | null;

/** A native Excel Table (ListObject), extracted with its own name + range and
 *  resolved to a raw grid (row 0 = the table's column headers). */
export interface TableDef {
  name: string; // Excel display name
  sheetName: string;
  ref: string; // A1 range, e.g. "C4:F120"
  columns: string[]; // declared table column names
  grid: CellValue[][]; // sliced values: header row + data rows
}

/** A workbook = one or more sheets, any native tables, plus source provenance. */
export interface Workbook {
  fileName: string;
  fileSize: number;
  sheets: SheetData[];
  tables: TableDef[];
}

// ---- Table import setup (user-controlled column/type spec) ----------------

export type ColType = 'auto' | 'text' | 'number' | 'date' | 'boolean';

export interface SourceColumn {
  source: string; // original column name (identity within the table)
  name: string; // output name (renamable)
  include: boolean;
  type: ColType;
}

export interface SourceSpec {
  name: string; // output table name
  columns: SourceColumn[];
  skipTypeDetection: boolean; // import every column as text
}

/** Output formats the parser worker can serialize to. */
export type ExportFormat = 'xlsx' | 'csv' | 'tsv' | 'json' | 'md' | 'html';

// ---- Worker message contract (typed request/response) --------------------

export type WorkerRequest =
  | { id: number; kind: 'parse'; buffer: ArrayBuffer; fileName: string; fileSize: number; previewRows?: number }
  | { id: number; kind: 'serialize'; sheet: SheetData; format: ExportFormat }
  | { id: number; kind: 'serializeWorkbook'; sheets: SheetData[] };

export type WorkerResponse =
  | { id: number; ok: true; kind: 'parse'; workbook: Workbook }
  | { id: number; ok: true; kind: 'serialize'; blob: Blob; mime: string; ext: string }
  | { id: number; ok: true; kind: 'serializeWorkbook'; blob: Blob; mime: string; ext: string }
  | { id: number; ok: false; error: string };
