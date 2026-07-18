// Merge: combine several files into one. Two modes —
//  • Stack rows: append all rows into a single sheet, aligning columns by
//    header name (great for splitting-then-recombining, monthly exports, etc.)
//  • Separate sheets: each input sheet becomes a tab in one .xlsx workbook.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { el, button, selectField, radioGroup } from '../ui/controls';
import { parseFile, serializeSheet, serializeWorkbook } from '../core/parser';
import { downloadBlob } from '../core/fileio';
import { mergeStack, type NamedSheet } from '../core/transform';
import type { ExportFormat, SheetData } from '../core/types';

const PREVIEW_ROWS = 2000;
const STACK_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'xlsx', label: 'Excel (.xlsx)' },
  { value: 'csv', label: 'CSV (.csv)' },
  { value: 'json', label: 'JSON (.json)' },
  { value: 'md', label: 'Markdown (.md)' },
];

let loaded: NamedSheet[] = [];
let mode: 'stack' | 'sheets' = 'stack';
let addSource = true;

export function mountMerge(root: HTMLElement): void {
  loaded = [];
  mode = 'stack';
  addSource = true;
  root.innerHTML = `
    <div class="tool-head"><h2>Merge</h2>
    <p class="tool-blurb">Combine multiple files into one. Stack their rows, or keep each as a separate sheet.</p></div>
    <div class="tool-body">
      <div id="dz"></div>
      <div id="files"></div>
      <div id="options"></div>
      <div id="preview"></div>
    </div>`;

  root.querySelector('#dz')!.append(
    createDropzone({
      multiple: true,
      onError: (m) => toast(m, 'error'),
      onWarning: (m) => toast(m, 'warning', 7000),
      onFiles: (files) => addFiles(root, files),
    }),
  );
  renderFiles(root);
  renderOptions(root);
  attachHelp(root, 'merge');
}

async function addFiles(root: HTMLElement, files: File[]): Promise<void> {
  for (const file of files) {
    try {
      const wb = await parseFile(file);
      wb.sheets.forEach((sheet) => {
        const source = wb.sheets.length > 1 ? `${file.name}#${sheet.name}` : file.name;
        loaded.push({ source, sheet });
      });
    } catch (e) {
      toast(`Skipped "${file.name}": ${msg(e)}`, 'error', 7000);
    }
  }
  renderFiles(root);
  renderPreview(root);
}

function renderFiles(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#files')!;
  host.innerHTML = '';
  if (!loaded.length) return;
  const list = el('div', { class: 'file-list' });
  loaded.forEach((ns, i) => {
    const remove = button('✕', () => {
      loaded.splice(i, 1);
      renderFiles(root);
      renderPreview(root);
    }, 'btn-x');
    list.append(
      el('div', { class: 'file-row' }, [
        el('span', { class: 'file-name' }, [ns.source]),
        el('span', { class: 'file-meta' }, [`${ns.sheet.headers.length} cols · ${ns.sheet.totalRows} rows`]),
        remove,
      ]),
    );
  });
  host.append(el('div', { class: 'file-list-head' }, [`${loaded.length} sheet(s) loaded`]), list);
}

function renderOptions(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#options')!;
  host.innerHTML = '';

  const modeCtrl = radioGroup(
    'merge-mode',
    [
      { value: 'stack', label: 'Stack rows', hint: 'append all rows into one sheet, aligned by column name' },
      { value: 'sheets', label: 'Separate sheets', hint: 'each input becomes a tab in one .xlsx' },
    ],
    mode,
    (v) => {
      mode = v as typeof mode;
      renderOptions(root);
      renderPreview(root);
    },
  );

  const controls = el('div', { class: 'config-bar' }, []);
  let getFormat: () => ExportFormat = () => 'xlsx';

  if (mode === 'stack') {
    const { wrap, select } = selectField('Output format', STACK_FORMATS.map((f) => ({ value: f.value, label: f.label })), 'xlsx');
    getFormat = () => select.value as ExportFormat;

    const srcToggle = el('input', { type: 'checkbox' });
    srcToggle.checked = addSource;
    srcToggle.addEventListener('change', () => {
      addSource = srcToggle.checked;
      renderPreview(root);
    });
    const srcLabel = el('label', { class: 'checkbox' }, [srcToggle, el('span', {}, ['Add "Source" column'])]);
    controls.append(wrap, srcLabel);
  }

  const go = button('Merge & download', () => runMerge(getFormat()));
  controls.append(go);
  host.append(el('div', { class: 'options-panel' }, [modeCtrl, controls]));
}

function renderPreview(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#preview')!;
  host.innerHTML = '';
  if (loaded.length < 1) return;

  if (mode === 'stack') {
    const merged = mergeStack(loaded, addSource);
    host.append(el('div', { class: 'sheet-meta' }, [
      `Preview — ${merged.headers.length} columns · ${merged.totalRows.toLocaleString()} rows` +
        (merged.totalRows > PREVIEW_ROWS ? ` (showing first ${PREVIEW_ROWS.toLocaleString()})` : ''),
    ]));
    host.append(createDataGrid(limit(merged)));
  } else {
    host.append(el('div', { class: 'sheet-meta' }, [
      `Will produce one .xlsx with ${loaded.length} sheet(s).`,
    ]));
  }
}

async function runMerge(format: ExportFormat): Promise<void> {
  if (!loaded.length) {
    toast('Add at least one file first.', 'warning');
    return;
  }
  try {
    if (mode === 'stack') {
      const merged = mergeStack(loaded, addSource);
      const { blob, ext } = await serializeSheet(merged, format);
      downloadBlob(blob, `merged.${ext}`);
      toast(`Merged ${loaded.length} sheet(s) → merged.${ext}`, 'success', 3500);
    } else {
      const sheets: SheetData[] = loaded.map((ns, i) => ({
        ...ns.sheet,
        name: sheetName(ns.source, i),
      }));
      const { blob, ext } = await serializeWorkbook(sheets);
      downloadBlob(blob, `merged.${ext}`);
      toast(`Merged into one workbook with ${sheets.length} sheet(s)`, 'success', 3500);
    }
  } catch (e) {
    toast(`Merge failed: ${msg(e)}`, 'error', 8000);
  }
}

function sheetName(source: string, i: number): string {
  const base = source.replace(/\.[^.]+$/, '').replace(/.*[#/]/, '');
  return base.slice(0, 31) || `Sheet${i + 1}`;
}

function limit(sheet: SheetData): SheetData {
  return sheet.rows.length > PREVIEW_ROWS ? { ...sheet, rows: sheet.rows.slice(0, PREVIEW_ROWS) } : sheet;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
