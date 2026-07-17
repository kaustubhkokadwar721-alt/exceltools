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

/** A workbook = one or more sheets, plus provenance about the source file. */
export interface Workbook {
  fileName: string;
  fileSize: number;
  sheets: SheetData[];
}

/** Output formats the parser worker can serialize to. */
export type ExportFormat = 'xlsx' | 'csv' | 'tsv' | 'json' | 'md' | 'html';

// ---- Worker message contract (typed request/response) --------------------

export type WorkerRequest =
  | { id: number; kind: 'parse'; buffer: ArrayBuffer; fileName: string; fileSize: number; previewRows?: number }
  | { id: number; kind: 'serialize'; sheet: SheetData; format: ExportFormat };

export type WorkerResponse =
  | { id: number; ok: true; kind: 'parse'; workbook: Workbook }
  | { id: number; ok: true; kind: 'serialize'; blob: Blob; mime: string; ext: string }
  | { id: number; ok: false; error: string };
