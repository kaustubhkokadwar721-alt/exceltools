// Turning a sheet into a file. Pure functions, no worker plumbing and no DOM,
// so every format can be tested directly — these produce the files users hand
// to other people, which makes them the code most worth having tests for.
import * as XLSX from 'xlsx';
import { neutralizeSheet } from './csvsafe';
import { escapeHtml } from './escape';
import type { SheetData, CellValue, ExportFormat } from './types';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface Serialized {
  blob: Blob;
  mime: string;
  ext: string;
}

export function serializeSheetTo(sheet: SheetData, format: ExportFormat): Serialized {
  // CSV and TSV are re-read by Excel, which evaluates anything that starts like
  // a formula. Those two get a sheet whose text cells are neutralised; .xlsx
  // does not need it (SheetJS writes these as string cells, which Excel never
  // evaluates) and the machine-readable formats must stay verbatim.
  const textSafe = (): XLSX.WorkSheet => {
    const safe = neutralizeSheet(sheet);
    return XLSX.utils.aoa_to_sheet([safe.headers, ...safe.rows] as CellValue[][]);
  };

  switch (format) {
    case 'csv':
      return textBlob(XLSX.utils.sheet_to_csv(textSafe()), 'text/csv', 'csv');
    case 'tsv':
      return textBlob(XLSX.utils.sheet_to_csv(textSafe(), { FS: '\t' }), 'text/tab-separated-values', 'tsv');
    case 'html':
      return textBlob(toHtml(sheet), 'text/html', 'html');
    case 'json':
      return textBlob(JSON.stringify(rowsAsObjects(sheet), null, 2), 'application/json', 'json');
    case 'md':
      return textBlob(toMarkdown(sheet), 'text/markdown', 'md');
    case 'xlsx':
    default: {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows] as CellValue[][]);
      XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31) || 'Sheet1');
      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
      return { blob: new Blob([out], { type: XLSX_MIME }), mime: XLSX_MIME, ext: 'xlsx' };
    }
  }
}

/** One multi-sheet .xlsx (used by Merge "as separate sheets"). */
export function serializeSheetsToWorkbook(sheets: SheetData[]): Serialized {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  sheets.forEach((sheet, i) => {
    const ws = XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows] as CellValue[][]);
    XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(sheet.name || `Sheet${i + 1}`, used));
  });
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return { blob: new Blob([out], { type: XLSX_MIME }), mime: XLSX_MIME, ext: 'xlsx' };
}

/** Excel forbids `: \ / ? * [ ]` in sheet names and caps them at 31 chars. */
export function uniqueSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `_${n++}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Write the sheet as an HTML table, escaping every value ourselves.
 *
 * SheetJS's `sheet_to_html` escapes a cell's *text* but copies the raw value into
 * a `data-v` attribute, so a cell reading `"><img src=x onerror=...>` closes the
 * attribute and injects a live element. The export is opened from disk, where
 * that is script execution on the user's machine — the same class of defect as
 * CSV formula injection, without Excel's warning to stop it. Writing the table
 * here removes the dependency on someone else's escaping, and the output is
 * cleaner for carrying no `data-*` or `id` attributes nobody asked for.
 */
export function toHtml(sheet: SheetData): string {
  const cell = (v: CellValue): string => escapeHtml(String(v ?? ''));
  const head = sheet.headers.map((h) => `<th>${cell(h)}</th>`).join('');
  const body = sheet.rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('\n');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${cell(sheet.name || 'Sheet')}</title>`,
    '<style>table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>',
    '</head><body>',
    `<table><thead><tr>${head}</tr></thead>`,
    `<tbody>${body}</tbody></table>`,
    '</body></html>',
  ].join('\n');
}

export function toMarkdown(sheet: SheetData): string {
  const esc = (v: CellValue) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${sheet.headers.map(esc).join(' | ')} |`;
  const sep = `| ${sheet.headers.map(() => '---').join(' | ')} |`;
  const body = sheet.rows.map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

/**
 * Rows as objects for JSON export. Duplicate headers are disambiguated rather
 * than allowed to overwrite each other — ERP-printed reports routinely repeat a
 * column name, and losing one silently is worse than an ugly key.
 */
export function rowsAsObjects(sheet: SheetData): Record<string, CellValue>[] {
  const keys: string[] = [];
  const used = new Set<string>();
  for (const h of sheet.headers) {
    let key = h;
    let n = 2;
    while (used.has(key)) key = `${h}_${n++}`;
    used.add(key);
    keys.push(key);
  }
  return sheet.rows.map((r) => {
    const o: Record<string, CellValue> = {};
    keys.forEach((k, i) => (o[k] = r[i] ?? null));
    return o;
  });
}

function textBlob(text: string, mime: string, ext: string): Serialized {
  return { blob: new Blob([text], { type: mime }), mime, ext };
}
