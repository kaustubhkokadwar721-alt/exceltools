// Query (SQL) — intermediate tier. Drop one or more spreadsheets, each sheet
// becomes a DuckDB table, then run arbitrary SQL (joins, filters, aggregation)
// entirely in-browser. Results preview in the grid and download locally.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { el, button, selectField } from '../ui/controls';
import { parseFile, serializeSheet } from '../core/parser';
import { downloadBlob } from '../core/fileio';
import type { SheetData, ExportFormat } from '../core/types';

const PREVIEW_ROWS = 5000;

interface TableInfo {
  name: string;
  columns: string[];
  rows: number;
  source: string;
}

let tables: TableInfo[] = [];
let engineReady = false;

export function mountQuery(root: HTMLElement): void {
  tables = [];
  engineReady = false;
  root.innerHTML = `
    <div class="tool-head"><h2>Query (SQL)</h2>
    <p class="tool-blurb">Drop spreadsheets, then run SQL over them — joins, filters, aggregation. Powered by DuckDB-WASM, fully offline.</p></div>
    <div class="tool-body">
      <div id="dz"></div>
      <div id="schema"></div>
      <div id="editor"></div>
      <div id="result"></div>
    </div>`;

  attachHelp(root, 'query');
  root.querySelector('#dz')!.append(
    createDropzone({
      multiple: true,
      onError: (m) => toast(m, 'error'),
      onWarning: (m) => toast(m, 'warning', 7000),
      onFiles: (files) => addFiles(root, files),
    }),
  );
}

async function addFiles(root: HTMLElement, files: File[]): Promise<void> {
  const schemaHost = root.querySelector<HTMLElement>('#schema')!;
  schemaHost.innerHTML = `<div class="loading">Loading the SQL engine and registering tables…</div>`;

  // Lazy-load DuckDB only now (first Tier-2 use).
  const duck = await import('../core/duckdb');
  const used = new Set(tables.map((t) => t.name));

  for (const file of files) {
    try {
      const wb = await parseFile(file);
      for (const sheet of wb.sheets) {
        const label = wb.sheets.length > 1 ? `${file.name}_${sheet.name}` : file.name;
        const name = duck.tableIdent(label, used);
        await duck.registerSheet(name, sheet);
        tables.push({ name, columns: sheet.headers, rows: sheet.totalRows, source: file.name });
      }
    } catch (e) {
      toast(`Skipped "${file.name}": ${msg(e)}`, 'error', 8000);
    }
  }
  engineReady = true;
  renderSchema(root);
  renderEditor(root);
}

function renderSchema(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#schema')!;
  host.innerHTML = '';
  if (!tables.length) return;

  const list = el('div', { class: 'schema-list' });
  for (const t of tables) {
    list.append(
      el('div', { class: 'schema-table' }, [
        el('div', { class: 'schema-name' }, [`${t.name}`, el('span', { class: 'schema-meta' }, [` — ${t.rows.toLocaleString()} rows`])]),
        el('div', { class: 'schema-cols' }, [t.columns.join(', ')]),
      ]),
    );
  }
  host.append(el('div', { class: 'file-list-head' }, ['Available tables (use these names in your SQL)']), list);
}

function renderEditor(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#editor')!;
  host.innerHTML = '';
  if (!engineReady || !tables.length) return;

  const ta = el('textarea', { class: 'sql-editor', spellcheck: 'false', rows: '5' }) as HTMLTextAreaElement;
  ta.value = `SELECT *\nFROM ${tables[0].name}\nLIMIT 100;`;

  const runBtn = button('Run query  (Ctrl/⌘+Enter)', () => run(root, ta.value));
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run(root, ta.value);
    }
  });

  host.append(
    el('div', { class: 'file-list-head' }, ['SQL']),
    ta,
    el('div', { class: 'config-bar' }, [runBtn]),
  );
}

async function run(root: HTMLElement, sql: string): Promise<void> {
  const resultHost = root.querySelector<HTMLElement>('#result')!;
  const trimmed = sql.trim();
  if (!trimmed) return;
  resultHost.innerHTML = `<div class="loading">Running…</div>`;
  try {
    const duck = await import('../core/duckdb');
    const { sheet, elapsedMs } = await duck.runQuery(trimmed);
    renderResult(resultHost, sheet, elapsedMs);
  } catch (e) {
    resultHost.innerHTML = '';
    resultHost.append(el('div', { class: 'sql-error' }, [`SQL error: ${msg(e)}`]));
  }
}

function renderResult(host: HTMLElement, sheet: SheetData, elapsedMs: number): void {
  host.innerHTML = '';
  const meta = el('div', { class: 'sheet-meta' }, [
    `${sheet.totalRows.toLocaleString()} row(s) · ${sheet.headers.length} column(s) · ${elapsedMs.toFixed(0)} ms` +
      (sheet.totalRows > PREVIEW_ROWS ? ` (showing first ${PREVIEW_ROWS.toLocaleString()})` : ''),
  ]);

  const dl = selectField('Download as', [
    { value: 'csv', label: 'CSV (.csv)' },
    { value: 'xlsx', label: 'Excel (.xlsx)' },
    { value: 'json', label: 'JSON (.json)' },
  ], 'csv');
  const dlBtn = button('Download result', async () => {
    const { blob, ext } = await serializeSheet(sheet, dl.select.value as ExportFormat);
    downloadBlob(blob, `query_result.${ext}`);
    toast(`Result downloaded (.${ext})`, 'success', 3000);
  });

  host.append(meta, el('div', { class: 'config-bar' }, [dl.wrap, dlBtn]));
  if (sheet.rows.length) {
    const view: SheetData = sheet.rows.length > PREVIEW_ROWS ? { ...sheet, rows: sheet.rows.slice(0, PREVIEW_ROWS) } : sheet;
    host.append(createDataGrid(view));
  } else {
    host.append(el('div', { class: 'empty' }, ['Query returned no rows.']));
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
