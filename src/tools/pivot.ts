// Pivot — intermediate tier. Group-by + aggregate summaries (the 80% of what a
// spreadsheet pivot table is used for) built on DuckDB-WASM. Pick group columns,
// a value column and an aggregation; get a summary table you can download.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { el, button, selectField, checkboxList } from '../ui/controls';
import { parseFile, serializeSheet } from '../core/parser';
import { downloadBlob } from '../core/fileio';
import type { SheetData, ExportFormat } from '../core/types';

const PREVIEW_ROWS = 5000;
const AGGS = [
  { value: 'SUM', label: 'Sum' },
  { value: 'AVG', label: 'Average' },
  { value: 'COUNT', label: 'Count' },
  { value: 'COUNT_DISTINCT', label: 'Count (distinct)' },
  { value: 'MIN', label: 'Min' },
  { value: 'MAX', label: 'Max' },
];

let tableName = '';
let headers: string[] = [];
let fileBase = 'data';

export function mountPivot(root: HTMLElement): void {
  tableName = '';
  headers = [];
  root.innerHTML = `
    <div class="tool-head"><h2>Pivot</h2>
    <p class="tool-blurb">Summarise data by grouping and aggregating — like a pivot table. Runs on DuckDB-WASM, fully offline.</p></div>
    <div class="tool-body"><div id="dz"></div><div id="config"></div><div id="result"></div></div>`;

  attachHelp(root, 'pivot');
  root.querySelector('#dz')!.append(
    createDropzone({
      onError: (m) => toast(m, 'error'),
      onWarning: (m) => toast(m, 'warning', 7000),
      onFiles: async (files) => {
        const file = files[0];
        fileBase = file.name.replace(/\.[^.]+$/, '') || 'data';
        const cfg = root.querySelector<HTMLElement>('#config')!;
        cfg.innerHTML = `<div class="loading">Loading the engine and reading "${file.name}"…</div>`;
        try {
          const wb = await parseFile(file);
          const sheet = wb.sheets[0];
          const duck = await import('../core/duckdb');
          await duck.resetTables();
          tableName = duck.tableIdent(file.name, new Set());
          await duck.registerSheet(tableName, sheet);
          headers = sheet.headers;
          renderConfig(root);
        } catch (e) {
          cfg.innerHTML = '';
          toast(`Could not load "${file.name}": ${msg(e)}`, 'error', 8000);
        }
      },
    }),
  );
}

function renderConfig(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#config')!;
  host.innerHTML = '';

  const groupPick = checkboxList('Group by (rows)', headers);
  const { wrap: valWrap, select: valSel } = selectField('Value column', headers.map((h) => ({ value: h, label: h })), headers[0]);
  const { wrap: aggWrap, select: aggSel } = selectField('Aggregation', AGGS, 'SUM');

  const run = button('Build pivot', () => {
    const groups = groupPick.getChecked().map((i) => headers[i]);
    runPivot(root, groups, valSel.value, aggSel.value);
  });

  host.append(
    el('div', { class: 'workbook-bar' }, [
      el('span', { class: 'wb-name' }, [fileBase]),
      button('Open another', () => mountPivot(root), 'btn-ghost'),
    ]),
    el('div', { class: 'options-panel' }, [groupPick.wrap]),
    el('div', { class: 'config-bar' }, [valWrap, aggWrap, run]),
  );
}

async function runPivot(root: HTMLElement, groups: string[], value: string, agg: string): Promise<void> {
  const host = root.querySelector<HTMLElement>('#result')!;
  if (!groups.length) {
    toast('Pick at least one Group by column.', 'warning');
    return;
  }
  host.innerHTML = `<div class="loading">Aggregating…</div>`;

  const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
  const groupList = groups.map(q).join(', ');
  const aggExpr =
    agg === 'COUNT'
      ? `COUNT(${q(value)})`
      : agg === 'COUNT_DISTINCT'
        ? `COUNT(DISTINCT ${q(value)})`
        : `${agg}(${q(value)})`;
  const label = `${agg === 'COUNT_DISTINCT' ? 'COUNT DISTINCT' : agg} of ${value}`;
  const sql =
    `SELECT ${groupList}, ${aggExpr} AS ${q(label)} ` +
    `FROM ${tableName} GROUP BY ${groupList} ORDER BY ${groupList}`;

  try {
    const duck = await import('../core/duckdb');
    const { sheet, elapsedMs } = await duck.runQuery(sql);
    renderResult(host, sheet, elapsedMs);
  } catch (e) {
    host.innerHTML = '';
    host.append(el('div', { class: 'sql-error' }, [`Pivot failed: ${msg(e)}. Tip: for Sum/Average the value column must be numeric.`]));
  }
}

function renderResult(host: HTMLElement, sheet: SheetData, elapsedMs: number): void {
  host.innerHTML = '';
  host.append(
    el('div', { class: 'sheet-meta' }, [
      `${sheet.totalRows.toLocaleString()} group(s) · ${elapsedMs.toFixed(0)} ms` +
        (sheet.totalRows > PREVIEW_ROWS ? ` (showing first ${PREVIEW_ROWS.toLocaleString()})` : ''),
    ]),
  );

  const dl = selectField('Download as', [
    { value: 'xlsx', label: 'Excel (.xlsx)' },
    { value: 'csv', label: 'CSV (.csv)' },
    { value: 'json', label: 'JSON (.json)' },
  ], 'xlsx');
  const dlBtn = button('Download pivot', async () => {
    const { blob, ext } = await serializeSheet(sheet, dl.select.value as ExportFormat);
    downloadBlob(blob, `${fileBase}_pivot.${ext}`);
    toast(`Pivot downloaded (.${ext})`, 'success', 3000);
  });
  host.append(el('div', { class: 'config-bar' }, [dl.wrap, dlBtn]));

  if (sheet.rows.length) {
    const view: SheetData = sheet.rows.length > PREVIEW_ROWS ? { ...sheet, rows: sheet.rows.slice(0, PREVIEW_ROWS) } : sheet;
    host.append(createDataGrid(view));
  } else {
    host.append(el('div', { class: 'empty' }, ['No groups produced.']));
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
