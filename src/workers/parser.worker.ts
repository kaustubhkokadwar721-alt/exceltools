// Parser worker: all SheetJS read/serialize work happens here, off the main
// thread, so parsing a big workbook never freezes the UI. Communicates via the
// typed WorkerRequest/WorkerResponse contract in core/types.
import * as XLSX from 'xlsx';
import type {
  WorkerRequest,
  WorkerResponse,
  SheetData,
  Workbook,
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

  return { fileName, fileSize, sheets };
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
