// Parser worker: reading a workbook happens here, off the main thread, so
// parsing a big file never freezes the UI. Serialization lives in core/serialize
// — it is pure and belongs where it can be unit-tested. This file is the message
// plumbing for the typed WorkerRequest/WorkerResponse contract in core/types.
import * as XLSX from 'xlsx';
import { extractTables } from '../core/tables';
import { serializeSheetTo, serializeSheetsToWorkbook } from '../core/serialize';
import type {
  WorkerRequest,
  WorkerResponse,
  SheetData,
  Workbook,
  TableDef,
  CellValue,
} from '../core/types';

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.kind === 'parse') {
      const workbook = parse(req.buffer, req.fileName, req.fileSize, req.previewRows);
      respond({ id: req.id, ok: true, kind: 'parse', workbook });
    } else if (req.kind === 'serialize') {
      const { blob, mime, ext } = serializeSheetTo(req.sheet, req.format);
      respond({ id: req.id, ok: true, kind: 'serialize', blob, mime, ext });
    } else if (req.kind === 'serializeWorkbook') {
      const { blob, mime, ext } = serializeSheetsToWorkbook(req.sheets);
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
