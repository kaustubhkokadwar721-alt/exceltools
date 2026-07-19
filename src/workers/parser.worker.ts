// Parser worker: all SheetJS read/serialize work happens here, off the main
// thread, so parsing a big workbook never freezes the UI. Communicates via the
// typed WorkerRequest/WorkerResponse contract in core/types.
import * as XLSX from 'xlsx';
import { extractTables } from '../core/tables';
import type {
  WorkerRequest,
  WorkerResponse,
  SheetData,
  Workbook,
  TableDef,
  CellValue,
  ExportFormat,
} from '../core/types';

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.kind === 'parse') {
      const workbook = parse(req.buffer, req.fileName, req.fileSize, req.previewRows);
      respond({ id: req.id, ok: true, kind: 'parse', workbook });
    } else if (req.kind === 'serialize') {
      const { blob, mime, ext } = serialize(req.sheet, req.format);
      respond({ id: req.id, ok: true, kind: 'serialize', blob, mime, ext });
    } else if (req.kind === 'serializeWorkbook') {
      const { blob, mime, ext } = serializeWorkbook(req.sheets);
      respond({ id: req.id, ok: true, kind: 'serializeWorkbook', blob, mime, ext });
    }
  } catch (e) {
    respond({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};

function respond(msg: WorkerResponse) {
  self.postMessage(msg);
}

function parse(buffer: ArrayBuffer, fileName: string, fileSize: number, previewRows?: number): Workbook {
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheets: SheetData[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    // array-of-arrays keeps everything positional and avoids header collisions.
    const aoa = XLSX.utils.sheet_to_json<CellValue[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });

    const totalRows = Math.max(0, aoa.length - (aoa.length ? 1 : 0));
    const headerRow = (aoa[0] as CellValue[] | undefined) ?? [];
    const width = aoa.reduce((m, r) => Math.max(m, r.length), 0);

    const headers = Array.from({ length: width }, (_, i) => {
      const h = headerRow[i];
      return h === null || h === undefined || h === '' ? XLSX.utils.encode_col(i) : String(h);
    });

    let dataRows = aoa.slice(1) as CellValue[][];
    if (previewRows !== undefined && dataRows.length > previewRows) {
      dataRows = dataRows.slice(0, previewRows);
    }
    // Pad short rows so every row matches header width (grid relies on this).
    const rows = dataRows.map((r) => {
      const out = r.slice(0, width) as CellValue[];
      while (out.length < width) out.push(null);
      return out;
    });

    return { name, headers, rows, totalRows };
  });

  const tables = extractTableDefs(wb, buffer);
  return { fileName, fileSize, sheets, tables };
}

// Extract native Excel Tables and slice each one's values from its range, so the
// table's own header row and cells are isolated from surrounding junk.
function extractTableDefs(wb: XLSX.WorkBook, buffer: ArrayBuffer): TableDef[] {
  const out: TableDef[] = [];
  for (const meta of extractTables(buffer)) {
    const ws = wb.Sheets[meta.sheetName];
    if (!ws) continue;
    const grid = XLSX.utils.sheet_to_json<CellValue[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
      range: meta.ref,
    });
    out.push({ name: meta.name, sheetName: meta.sheetName, ref: meta.ref, columns: meta.columns, grid });
  }
  return out;
}

function serialize(sheet: SheetData, format: ExportFormat): { blob: Blob; mime: string; ext: string } {
  const aoa: CellValue[][] = [sheet.headers, ...sheet.rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  switch (format) {
    case 'csv':
      return textBlob(XLSX.utils.sheet_to_csv(ws), 'text/csv', 'csv');
    case 'tsv':
      return textBlob(XLSX.utils.sheet_to_csv(ws, { FS: '\t' }), 'text/tab-separated-values', 'tsv');
    case 'html':
      return textBlob(XLSX.utils.sheet_to_html(ws), 'text/html', 'html');
    case 'json':
      return textBlob(JSON.stringify(rowsAsObjects(sheet), null, 2), 'application/json', 'json');
    case 'md':
      return textBlob(toMarkdown(sheet), 'text/markdown', 'md');
    case 'xlsx':
    default: {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31) || 'Sheet1');
      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
      return {
        blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ext: 'xlsx',
      };
    }
  }
}

// Build a single multi-sheet .xlsx (used by Merge "as separate sheets").
// Sheet names are made unique and trimmed to Excel's 31-char limit.
function serializeWorkbook(sheets: SheetData[]): { blob: Blob; mime: string; ext: string } {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  sheets.forEach((sheet, i) => {
    const aoa: CellValue[][] = [sheet.headers, ...sheet.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(sheet.name || `Sheet${i + 1}`, used));
  });
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return {
    blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  };
}

function uniqueSheetName(name: string, used: Set<string>): string {
  // Excel forbids : \ / ? * [ ] and caps names at 31 chars.
  let base = name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `_${n++}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function textBlob(text: string, mime: string, ext: string) {
  return { blob: new Blob([text], { type: mime }), mime, ext };
}

function rowsAsObjects(sheet: SheetData): Record<string, CellValue>[] {
  return sheet.rows.map((r) => {
    const o: Record<string, CellValue> = {};
    sheet.headers.forEach((h, i) => (o[h] = r[i] ?? null));
    return o;
  });
}

function toMarkdown(sheet: SheetData): string {
  const esc = (v: CellValue) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${sheet.headers.map(esc).join(' | ')} |`;
  const sep = `| ${sheet.headers.map(() => '---').join(' | ')} |`;
  const body = sheet.rows.map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}
