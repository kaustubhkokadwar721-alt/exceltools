// Convert: one spreadsheet → CSV / TSV / JSON / Markdown / HTML / XLSX.
// Reuses the worker's per-sheet serializer; picks a sheet, picks a format,
// downloads locally.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { selectField, button, el } from '../ui/controls';
import { parseFile, serializeSheet } from '../core/parser';
import { downloadBlob, withExtension } from '../core/fileio';
import type { Workbook, ExportFormat, SheetData } from '../core/types';

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV (.csv)' },
  { value: 'tsv', label: 'TSV (.tsv)' },
  { value: 'json', label: 'JSON (.json)' },
  { value: 'md', label: 'Markdown (.md)' },
  { value: 'html', label: 'HTML (.html)' },
  { value: 'xlsx', label: 'Excel (.xlsx)' },
];

const PREVIEW_ROWS = 2000;

export function mountConverter(root: HTMLElement): void {
  root.innerHTML = `
    <div class="tool-head"><h2>Convert</h2>
    <p class="tool-blurb">Turn a spreadsheet into CSV, TSV, JSON, Markdown, HTML, or Excel — locally.</p></div>
    <div class="tool-body" id="body"></div>`;
  const body = root.querySelector<HTMLElement>('#body')!;
  reset(body);
}

function reset(body: HTMLElement): void {
  body.innerHTML = '';
  body.append(
    createDropzone({
      onError: (m) => toast(m, 'error'),
      onWarning: (m) => toast(m, 'warning', 7000),
      onFiles: async (files) => {
        const file = files[0];
        body.innerHTML = `<div class="loading">Parsing <strong>${file.name}</strong>…</div>`;
        try {
          const wb = await parseFile(file);
          renderConfig(body, file.name, wb);
        } catch (e) {
          toast(`Could not parse "${file.name}": ${msg(e)}`, 'error', 8000);
          reset(body);
        }
      },
    }),
  );
}

function renderConfig(body: HTMLElement, fileName: string, wb: Workbook): void {
  body.innerHTML = '';

  const sheetOpts = wb.sheets.map((s, i) => ({ value: String(i), label: `${s.name} (${s.totalRows} rows)` }));
  const { wrap: sheetWrap, select: sheetSel } = selectField('Sheet', sheetOpts, '0');
  const { wrap: fmtWrap, select: fmtSel } = selectField('Output format', FORMATS.map((f) => ({ value: f.value, label: f.label })), 'csv');

  const gridHost = el('div', { class: 'grid-host' });
  const renderPreview = () => {
    const sheet = previewSheet(wb.sheets[Number(sheetSel.value)]);
    gridHost.innerHTML = '';
    if (!sheet.rows.length) {
      gridHost.append(el('div', { class: 'empty' }, ['This sheet has no data rows.']));
    } else {
      gridHost.append(createDataGrid(sheet));
    }
  };
  sheetSel.addEventListener('change', renderPreview);

  const convertBtn = button('Convert & download', async () => {
    const sheet = wb.sheets[Number(sheetSel.value)];
    const fmt = fmtSel.value as ExportFormat;
    try {
      const { blob, ext } = await serializeSheet(sheet, fmt);
      downloadBlob(blob, withExtension(fileName, ext));
      toast(`Converted "${sheet.name}" → .${ext}`, 'success', 3500);
    } catch (e) {
      toast(`Conversion failed: ${msg(e)}`, 'error', 8000);
    }
  });

  const bar = el('div', { class: 'config-bar' }, [sheetWrap, fmtWrap, convertBtn]);
  const openAnother = button('Open another', () => reset(body), 'btn-ghost');
  const head = el('div', { class: 'workbook-bar' }, [
    el('span', { class: 'wb-name' }, [fileName]),
    el('span', { class: 'wb-meta' }, [`${wb.sheets.length} sheet${wb.sheets.length === 1 ? '' : 's'}`]),
    openAnother,
  ]);

  body.append(head, bar, gridHost);
  renderPreview();
}

function previewSheet(sheet: SheetData): SheetData {
  return sheet.rows.length > PREVIEW_ROWS ? { ...sheet, rows: sheet.rows.slice(0, PREVIEW_ROWS) } : sheet;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
