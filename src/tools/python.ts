// Python (pandas) — analysis tool on the Pyodide engine. Same shape as Query:
// stage dropped sheets/tables (include + rename), register, write Python with a
// sticky schema rail and a copy-for-AI button, preview `result`, download.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { el, button, selectField } from '../ui/controls';
import { tableSetupCard, type SourceSetup } from '../ui/source-setup';
import { parseFile, serializeSheet } from '../core/parser';
import { resolveSource } from '../core/source';
import { downloadBlob } from '../core/fileio';
import type { SheetData, ExportFormat, TableDef } from '../core/types';

const PREVIEW_ROWS = 5000;

interface Registered {
  name: string;
  sheet: SheetData;
}

interface PendingSheet {
  sheet: SheetData;
  source: string;
  defaultName: string;
}

let registered: Registered[] = [];
let pendingTables: TableDef[] = [];
let pendingSheets: PendingSheet[] = [];
let pandasAvailable: boolean | null = null;

export function mountPython(root: HTMLElement): void {
  registered = [];
  pendingTables = [];
  pendingSheets = [];
  root.innerHTML = `
    <div class="tool-head"><h2>Python</h2>
    <p class="tool-blurb">Drop spreadsheets, then analyse them with Python${''} — pandas DataFrames, custom cleaning, anything SQL can't express. Runs in this browser, fully offline.</p></div>
    <div class="tool-body">
      <div id="dz"></div>
      <div id="setup"></div>
      <div class="query-work">
        <div class="query-main">
          <div id="editor"></div>
          <div id="result"></div>
        </div>
        <aside class="query-schema" id="schema" aria-label="Table reference"></aside>
      </div>
    </div>`;

  attachHelp(root, 'python');
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
  const setupHost = root.querySelector<HTMLElement>('#setup')!;
  setupHost.innerHTML = `<div class="loading">Reading files…</div>`;
  for (const file of files) {
    try {
      const wb = await parseFile(file);
      if (wb.tables.length) pendingTables.push(...wb.tables);
      else
        for (const sheet of wb.sheets) {
          const label = wb.sheets.length > 1 ? `${file.name}_${sheet.name}` : file.name;
          pendingSheets.push({ sheet, source: file.name, defaultName: label });
        }
    } catch (e) {
      toast(`Skipped "${file.name}": ${msg(e)}`, 'error', 8000);
    }
  }
  renderSetup(root);
}

function renderSetup(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#setup')!;
  host.innerHTML = '';
  if (!pendingTables.length && !pendingSheets.length) return;

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

  const setups: SourceSetup[] = pendingTables.map((def) => tableSetupCard(def));
  const total = sheetRows.length + setups.length;

  const registerBtn = button(`Register ${total} table(s)`, async () => {
    host.innerHTML = `<div class="loading">Starting the Python engine (first use downloads it once)…</div>`;
    try {
      const pyMod = await import('../core/python');
      const { pandas } = await pyMod.initPython();
      pandasAvailable = pandas;
      const used = new Set(registered.map((r) => r.name));
      for (const r of sheetRows) {
        if (!r.include.checked) continue;
        const name = pyMod.pyIdent(r.name.value.trim() || r.p.defaultName, used);
        await pyMod.registerPyTable(name, r.p.sheet);
        registered.push({ name, sheet: r.p.sheet });
      }
      for (const s of setups) {
        const spec = s.getSpec();
        const sheet = resolveSource(s.def, spec);
        const name = pyMod.pyIdent(spec.name, used);
        await pyMod.registerPyTable(name, sheet);
        registered.push({ name, sheet });
      }
      pendingTables = [];
      pendingSheets = [];
      renderSetup(root);
      renderSchema(root);
      renderEditor(root);
      toast(pandas ? 'Tables registered — pandas is available.' : 'Tables registered (pure Python — pandas wheels not present in this build).', 'success', 5000);
    } catch (e) {
      host.innerHTML = '';
      renderSetup(root);
      toast(`Python engine failed to start: ${msg(e)}`, 'error', 9000);
    }
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

// ---- schema rail (kinds inferred from values; pandas names shown) ----------

function colKind(sheet: SheetData, i: number): string {
  const vals = sheet.rows.slice(0, 200).map((r) => r[i]).filter((v) => v !== null && v !== undefined);
  if (vals.length && vals.every((v) => typeof v === 'number')) return 'number';
  if (vals.length && vals.every((v) => typeof v === 'boolean')) return 'boolean';
  return 'text';
}

function schemaTextForAI(): string {
  const lines = [
    pandasAvailable
      ? 'I have these tables loaded in Python (Pyodide) as pandas DataFrames named df_<table>. Please write Python that assigns the answer to a variable called `result` (a DataFrame is ideal), using exactly these names:'
      : 'I have these tables loaded in Python as lists of dicts in tables["<name>"]. Please write pure-Python (no pandas) that assigns the answer to a variable called `result`, using exactly these names:',
    '',
  ];
  for (const r of registered) {
    lines.push(`Table "${r.name}"${pandasAvailable ? ` (DataFrame df_${r.name})` : ''} — ${r.sheet.totalRows.toLocaleString()} rows:`);
    r.sheet.headers.forEach((h, i) => lines.push(`  - "${h}" ${colKind(r.sheet, i)}`));
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function renderSchema(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#schema')!;
  host.innerHTML = '';
  if (!registered.length) return;

  const copyBtn = button('Copy schema for AI', async () => {
    const text = schemaTextForAI();
    try {
      await navigator.clipboard.writeText(text);
      toast('Schema copied — paste it into your AI assistant along with what you want.', 'success', 5000);
    } catch {
      const ta = el('textarea', { class: 'sql-editor', rows: '10' }) as HTMLTextAreaElement;
      ta.value = text;
      host.append(ta);
      ta.select();
    }
  }, 'btn-ghost');

  const head = el('div', { class: 'schema-head' }, [
    el('div', { class: 'file-list-head' }, [pandasAvailable ? 'DataFrames (df_<name>)' : 'Tables (tables["name"])']),
    copyBtn,
  ]);

  const list = el('div', { class: 'schema-detail' });
  for (const r of registered) {
    list.append(
      el('details', { class: 'schema-block', open: '' }, [
        el('summary', {}, [
          el('span', { class: 'schema-name' }, [pandasAvailable ? `df_${r.name}` : r.name]),
          el('span', { class: 'schema-meta' }, [` — ${r.sheet.totalRows.toLocaleString()} rows`]),
        ]),
        el('div', { class: 'schema-cols-list' },
          r.sheet.headers.map((h, i) => el('div', { class: 'schema-col' }, [
            el('span', { class: 'schema-col-name' }, [h]),
            el('span', { class: 'schema-col-type' }, [colKind(r.sheet, i)]),
          ])),
        ),
      ]),
    );
  }
  host.append(head, list);
}

// ---- editor + result -------------------------------------------------------

function renderEditor(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#editor')!;
  host.innerHTML = '';
  if (!registered.length) return;

  const first = registered[0].name;
  const ta = el('textarea', { class: 'sql-editor', spellcheck: 'false', rows: '7' }) as HTMLTextAreaElement;
  ta.value = pandasAvailable
    ? `# assign your answer to \`result\`\nresult = df_${first}.head(20)`
    : `# assign your answer to \`result\` (pure Python: tables["${first}"] is a list of dicts)\nresult = tables["${first}"][:20]`;

  const runBtn = button('Run Python  (Ctrl/⌘+Enter)', () => run(root, ta.value));
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run(root, ta.value);
    }
  });

  host.append(el('div', { class: 'file-list-head' }, ['Python']), ta, el('div', { class: 'config-bar' }, [runBtn]));
}

async function run(root: HTMLElement, code: string): Promise<void> {
  const host = root.querySelector<HTMLElement>('#result')!;
  if (!code.trim()) return;
  host.innerHTML = `<div class="loading">Running…</div>`;
  try {
    const pyMod = await import('../core/python');
    const { sheet, elapsedMs } = await pyMod.runPython(code);
    renderResult(host, sheet, elapsedMs);
  } catch (e) {
    host.innerHTML = '';
    host.append(el('div', { class: 'sql-error' }, [`Python error: ${msg(e)}`]));
  }
}

function renderResult(host: HTMLElement, sheet: SheetData, elapsedMs: number): void {
  host.innerHTML = '';
  host.append(
    el('div', { class: 'sheet-meta' }, [
      `${sheet.totalRows.toLocaleString()} row(s) · ${sheet.headers.length} column(s) · ${elapsedMs.toFixed(0)} ms` +
        (sheet.totalRows > PREVIEW_ROWS ? ` (showing first ${PREVIEW_ROWS.toLocaleString()})` : ''),
    ]),
  );
  const dl = selectField('Download as', [
    { value: 'csv', label: 'CSV (.csv)' },
    { value: 'xlsx', label: 'Excel (.xlsx)' },
    { value: 'json', label: 'JSON (.json)' },
  ], 'csv');
  const dlBtn = button('Download result', async () => {
    const { blob, ext } = await serializeSheet(sheet, dl.select.value as ExportFormat);
    downloadBlob(blob, `python_result.${ext}`);
    toast(`Result downloaded (.${ext})`, 'success', 3000);
  });
  host.append(el('div', { class: 'config-bar' }, [dl.wrap, dlBtn]));
  if (sheet.rows.length) {
    const view: SheetData = sheet.rows.length > PREVIEW_ROWS ? { ...sheet, rows: sheet.rows.slice(0, PREVIEW_ROWS) } : sheet;
    host.append(createDataGrid(view));
  } else {
    host.append(el('div', { class: 'empty' }, ['result is empty — assign something to `result`.']));
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
