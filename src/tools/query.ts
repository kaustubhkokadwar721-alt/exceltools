// Query (SQL) — intermediate tier. Drop one or more spreadsheets, each sheet
// becomes a DuckDB table, then run arbitrary SQL (joins, filters, aggregation)
// entirely in-browser. Results preview in the grid and download locally.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { openDataPanel, closeDataPanel } from '../app/shell';
import { el, button, selectField } from '../ui/controls';
import { createSourceBar } from '../ui/toolchrome';
import { tableSetupCard, type SourceSetup } from '../ui/source-setup';
import { parseFile, serializeSheet } from '../core/parser';
import { resolveSource } from '../core/source';
import { downloadBlob } from '../core/fileio';
import type { SheetData, ExportFormat, TableDef } from '../core/types';

const PREVIEW_ROWS = 5000;
// Enough rows for an assistant to see how dates, amounts and codes are written,
// few enough that a careless paste is not a data dump.
const AI_SAMPLE_ROWS = 5;

interface TableInfo {
  name: string;
  columns: string[];
  rows: number;
  source: string;
}

interface PendingSheet {
  sheet: SheetData;
  source: string;
  defaultName: string;
}

let tables: TableInfo[] = [];
let pendingTables: TableDef[] = [];
let pendingSheets: PendingSheet[] = [];
let engineReady = false;

/**
 * Mount the SQL workspace into `root`.
 *
 * DuckDB keeps the registered tables in the engine, which outlives this DOM, so
 * resetting the list on every mount lost the *record* of tables that were still
 * there — leave for the privacy page, come back, and your data had apparently
 * vanished while the engine could still query it.
 */
export function mountQuery(root: HTMLElement): void {
  const resuming = tables.length > 0 || pendingTables.length > 0 || pendingSheets.length > 0;
  if (!resuming) {
    tables = [];
    pendingTables = [];
    pendingSheets = [];
    engineReady = false;
  }
  root.innerHTML = `
    <div class="tool-body">
      <div id="dz"></div>
      <div id="setup"></div>
      <div id="editor"></div>
      <div id="result"></div>
    </div>`;

  renderDropzone(root, !tables.length);
  if (resuming) {
    renderSetup(root);
    void renderSchema();
    renderEditor(root);
  }
}

/**
 * The drop area is onboarding. Once tables are registered it shrinks to a line
 * saying what is loaded, which is ~200px back for the editor and its results —
 * with "Add more files" to bring it back. Same collapse the notebook uses.
 */
function renderDropzone(root: HTMLElement, expanded: boolean): void {
  const host = root.querySelector<HTMLElement>('#dz')!;
  host.innerHTML = '';
  if (expanded || !tables.length) {
    host.append(
      createDropzone({
        multiple: true,
        onError: (m) => toast(m, 'error'),
        onWarning: (m) => toast(m, 'warning', 7000),
        onFiles: (files) => addFiles(root, files),
      }),
    );
    return;
  }
  host.append(
    createSourceBar({
      summary: `${tables.length} table${tables.length === 1 ? '' : 's'} ready`,
      items: tables.map((t) => ({ name: t.name, meta: `${t.rows.toLocaleString()} rows` })),
      addLabel: '＋ Add more files',
      onAdd: () => renderDropzone(root, true),
    }),
  );
}

async function addFiles(root: HTMLElement, files: File[]): Promise<void> {
  const setupHost = root.querySelector<HTMLElement>('#setup')!;
  setupHost.innerHTML = `<div class="loading">Reading files…</div>`;

  for (const file of files) {
    try {
      const wb = await parseFile(file);
      if (wb.tables.length) {
        // File defines Excel Tables → those are the source of truth.
        pendingTables.push(...wb.tables);
      } else {
        for (const sheet of wb.sheets) {
          const label = wb.sheets.length > 1 ? `${file.name}_${sheet.name}` : file.name;
          pendingSheets.push({ sheet, source: file.name, defaultName: label });
        }
      }
    } catch (e) {
      toast(`Skipped "${file.name}": ${msg(e)}`, 'error', 8000);
    }
  }
  engineReady = true;
  renderSetup(root);
  void renderSchema();
  renderEditor(root);
}

// Staged registration: every source (plain sheet or Excel Table) is listed for
// the user to include/exclude and rename before anything is registered.
function renderSetup(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#setup')!;
  host.innerHTML = '';
  if (!pendingTables.length && !pendingSheets.length) return;

  // Plain sheets: one compact row each — include + name.
  const sheetRows = pendingSheets.map((p) => {
    const include = el('input', { type: 'checkbox' }) as HTMLInputElement;
    include.checked = true;
    const name = el('input', { class: 'field-input col-name' }) as HTMLInputElement;
    name.value = p.defaultName.replace(/\.[^.]+$/, '');
    const row = el('div', { class: 'col-row sheet-stage-row' }, [
      el('label', { class: 'checkbox' }, [include, el('span', { class: 'col-src' }, [p.source + (p.sheet.name !== p.source ? ` › ${p.sheet.name}` : '')])]),
      name,
      el('span', { class: 'file-meta' }, [`${p.sheet.headers.length} cols · ${p.sheet.totalRows.toLocaleString()} rows`]),
    ]);
    return { p, include, name, row };
  });

  // Excel Tables: full setup cards (columns + types).
  const setups: SourceSetup[] = pendingTables.map((def) => tableSetupCard(def));

  const total = sheetRows.length + setups.length;
  const registerBtn = button(`Register ${total} table(s)`, async () => {
    const duck = await import('../core/duckdb');
    const used = new Set(tables.map((t) => t.name));
    for (const r of sheetRows) {
      if (!r.include.checked) continue;
      try {
        const name = duck.tableIdent(r.name.value.trim() || r.p.defaultName, used);
        await duck.registerSheet(name, r.p.sheet);
        tables.push({ name, columns: r.p.sheet.headers, rows: r.p.sheet.totalRows, source: r.p.source });
      } catch (e) {
        toast(`Could not register "${r.name.value}": ${msg(e)}`, 'error', 8000);
      }
    }
    for (const s of setups) {
      const spec = s.getSpec();
      try {
        const sheet = resolveSource(s.def, spec);
        const name = duck.tableIdent(spec.name, used);
        await duck.insertTable(name, sheet);
        tables.push({ name, columns: sheet.headers, rows: sheet.totalRows, source: `table: ${s.def.name}` });
      } catch (e) {
        toast(`Could not register table "${spec.name}": ${msg(e)}`, 'error', 8000);
      }
    }
    pendingTables = [];
    pendingSheets = [];
    renderSetup(root);
    await renderSchema();
    renderEditor(root);
    // You are working now — the onboarding chrome gets out of the way.
    renderDropzone(root, false);
    toast('Tables registered.', 'success', 3000);
  });

  const children: (Node | string)[] = [
    el('div', { class: 'file-list-head' }, ['Choose tables to register — untick to skip, rename as needed']),
  ];
  if (sheetRows.length) {
    children.push(
      el('div', { class: 'source-card' }, [
        el('div', { class: 'col-editor' }, [
          el('div', { class: 'col-row sheet-stage-row col-row-head' }, [
            el('span', {}, ['Include · source']),
            el('span', {}, ['Table name']),
            el('span', {}, ['Size']),
          ]),
          ...sheetRows.map((r) => r.row),
        ]),
      ]),
    );
  }
  if (setups.length) children.push(el('div', { class: 'setup-cards' }, setups.map((s) => s.el)));
  children.push(el('div', { class: 'config-bar' }, [registerBtn]));
  host.append(...children);
}

async function renderSchema(): Promise<void> {
  if (!tables.length) {
    closeDataPanel();
    return;
  }
  const host = openDataPanel({ title: 'Your data', label: 'Table schema reference' });
  host.innerHTML = '';

  // Real types from DuckDB — the reference users paste into an AI assistant.
  const duck = await import('../core/duckdb');
  let schemas: import('../core/duckdb').TableSchema[] = [];
  try {
    schemas = await duck.describeTables();
  } catch {
    // Fall back to name-only pills if describe fails.
  }

  // Two buttons rather than one with a tick-box: the second puts real cell
  // values from the file on the clipboard, and that is a decision the user
  // should make by choosing it, not by leaving a checkbox as they found it.
  const copy = async (withRows: boolean, note: string): Promise<void> => {
    if (!schemas.length) {
      await handOver(tables.map((t) => `Table "${t.name}": ${t.columns.join(', ')}`).join('\n'), note);
      return;
    }
    const samples = withRows ? await duck.sampleRows(schemas.map((s) => s.table), AI_SAMPLE_ROWS) : undefined;
    await handOver(duck.schemaText(schemas, samples), note);
  };

  const handOver = async (text: string, note: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast(note, 'success', 7000);
    } catch {
      // Clipboard can be blocked; show the text for manual copy.
      const ta = el('textarea', { class: 'sql-editor', rows: '10' }) as HTMLTextAreaElement;
      ta.value = text;
      host.append(ta);
      ta.select();
      toast('Select and copy the text below.', 'info', 5000);
    }
  };

  const copyBtn = button('Copy schema for AI', () => void copy(
    false,
    'Copied: your table and column names, no data. Paste it into your AI assistant along with what you want.',
  ), 'btn-ghost');
  copyBtn.title = 'Table names, column names and column types only — no cell values leave this panel';

  const copyRowsBtn = button(`Copy with first ${AI_SAMPLE_ROWS} rows`, () => void copy(
    true,
    `Copied, including the first ${AI_SAMPLE_ROWS} rows of each table — real data from your file. Check what you are pasting if the assistant is outside your firm.`,
  ), 'btn-ghost');
  copyRowsBtn.title = `Adds the first ${AI_SAMPLE_ROWS} rows of each table, so the assistant can see how dates, amounts and codes are actually written`;

  // The panel is already titled "Your data"; this says the one thing the title
  // does not — that these names are what your SQL has to say.
  const head = el('div', { class: 'schema-head' }, [
    el('div', { class: 'panel-hint' }, ['Use these names in your SQL']),
    el('div', { class: 'schema-copy' }, [copyBtn, copyRowsBtn]),
  ]);

  const list = el('div', { class: 'schema-detail' });
  if (schemas.length) {
    for (const s of schemas) {
      list.append(
        // Open by default — the schema is a live reference while writing SQL.
        el('details', { class: 'schema-block', open: '' }, [
          el('summary', {}, [
            el('span', { class: 'schema-name' }, [s.table]),
            el('span', { class: 'schema-meta' }, [` — ${s.rows.toLocaleString()} rows · ${s.columns.length} columns`]),
          ]),
          el('div', { class: 'schema-cols-list' },
            s.columns.map((c) => el('div', { class: 'schema-col' }, [
              el('span', { class: 'schema-col-name' }, [c.name]),
              el('span', { class: 'schema-col-type' }, [c.type]),
            ])),
          ),
        ]),
      );
    }
  } else {
    for (const t of tables) {
      list.append(
        el('div', { class: 'schema-table' }, [
          el('span', { class: 'schema-name' }, [t.name]),
          el('span', { class: 'schema-meta' }, [` — ${t.rows.toLocaleString()} rows`]),
        ]),
      );
    }
  }
  host.append(head, list);
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
