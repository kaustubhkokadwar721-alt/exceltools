// Convert: one spreadsheet → CSV / TSV / JSON / Markdown / HTML / XLSX.
// Reuses the worker's per-sheet serializer; picks a sheet, picks a format,
// downloads locally.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { selectField, button, el } from '../ui/controls';
import { tableSetupCard, type SourceSetup } from '../ui/source-setup';
import { parseFile, serializeSheet } from '../core/parser';
import { resolveSource } from '../core/source';
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
  attachHelp(root, 'convert');
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

  // Sources = plain sheets + any native Excel Tables (which get a column setup).
  const sourceOpts = [
    ...wb.sheets.map((s, i) => ({ value: `s${i}`, label: `Sheet: ${s.name} (${s.totalRows} rows)` })),
    ...wb.tables.map((t, i) => ({ value: `t${i}`, label: `Table: ${t.name} (${t.grid.length - 1} rows)` })),
  ];
  const { wrap: srcWrap, select: srcSel } = selectField('Source', sourceOpts, 's0');
  const { wrap: fmtWrap, select: fmtSel } = selectField('Output format', FORMATS.map((f) => ({ value: f.value, label: f.label })), 'csv');

  const setupHost = el('div', { class: 'setup-cards' });
  const gridHost = el('div', { class: 'grid-host' });
  let setup: SourceSetup | null = null;

  // Resolve the current selection to a SheetData (live, honouring table edits).
  const currentSheet = (): SheetData =>
    setup ? resolveSource(setup.def, setup.getSpec()) : wb.sheets[Number(srcSel.value.slice(1))];

  const renderPreview = () => {
    const sheet = previewSheet(currentSheet());
    gridHost.innerHTML = '';
    gridHost.append(sheet.rows.length ? createDataGrid(sheet) : el('div', { class: 'empty' }, ['No data rows.']));
  };

  const onSourceChange = () => {
    const v = srcSel.value;
    setupHost.innerHTML = '';
    if (v.startsWith('t')) {
      setup = tableSetupCard(wb.tables[Number(v.slice(1))]);
      setupHost.append(setup.el);
    } else {
      setup = null;
    }
    renderPreview();
  };
  srcSel.addEventListener('change', onSourceChange);

  const convertBtn = button('Convert & download', async () => {
    try {
      const sheet = currentSheet();
      const { blob, ext } = await serializeSheet(sheet, fmtSel.value as ExportFormat);
      downloadBlob(blob, withExtension(fileName, ext));
      toast(`Converted "${sheet.name}" → .${ext}`, 'success', 3500);
    } catch (e) {
      toast(`Conversion failed: ${msg(e)}`, 'error', 8000);
    }
  });

  const openAnother = button('Open another', () => reset(body), 'btn-ghost');
  const head = el('div', { class: 'workbook-bar' }, [
    el('span', { class: 'wb-name' }, [fileName]),
    el('span', { class: 'wb-meta' }, [
      `${wb.sheets.length} sheet${wb.sheets.length === 1 ? '' : 's'}` + (wb.tables.length ? ` · ${wb.tables.length} table${wb.tables.length === 1 ? '' : 's'}` : ''),
    ]),
    openAnother,
  ]);

  body.append(head, el('div', { class: 'config-bar' }, [srcWrap, fmtWrap, convertBtn]), setupHost, gridHost);
  onSourceChange();
}

function previewSheet(sheet: SheetData): SheetData {
  return sheet.rows.length > PREVIEW_ROWS ? { ...sheet, rows: sheet.rows.slice(0, PREVIEW_ROWS) } : sheet;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
