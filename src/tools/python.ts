// Python notebook — Jupyter-style cells on the Pyodide engine, in the browser,
// no install. Staging + schema rail match the Query tool; below them sits a
// cell list: code cells (run, stdout, DataFrame grids, charts) and markdown
// cells, with .ipynb save/load that round-trips with real Jupyter.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { el, button } from '../ui/controls';
import { tableSetupCard, type SourceSetup } from '../ui/source-setup';
import { parseFile } from '../core/parser';
import { resolveSource } from '../core/source';
import { downloadBlob, pickFiles } from '../core/fileio';
import { toIpynb, fromIpynb, renderMarkdown, type NotebookCell } from '../core/notebook';
import type { SheetData, TableDef, CellValue } from '../core/types';
import type { CellResult, EngineInfo } from '../core/python';

const PREVIEW_ROWS = 2000;

interface Registered {
  name: string;
  sheet: SheetData;
}

interface PendingSheet {
  sheet: SheetData;
  source: string;
  defaultName: string;
}

interface UICell extends NotebookCell {
  id: number;
  execCount?: number;
  lastResult?: CellResult;
  mdEditing?: boolean;
}

let registered: Registered[] = [];
let pendingTables: TableDef[] = [];
let pendingSheets: PendingSheet[] = [];
let engine: EngineInfo | null = null;
let cells: UICell[] = [];
let cellSeq = 1;
let execSeq = 1;

export function mountPython(root: HTMLElement): void {
  registered = [];
  pendingTables = [];
  pendingSheets = [];
  engine = null;
  cells = [{ id: cellSeq++, kind: 'code', source: '' }];
  root.innerHTML = `
    <div class="tool-head"><h2>Python notebook</h2>
    <p class="tool-blurb">A Jupyter-style notebook in this browser — pandas, charts, no Python install. Files never leave this device.</p></div>
    <div class="tool-body">
      <div id="dz"></div>
      <div id="setup"></div>
      <div class="query-work">
        <div class="query-main"><div id="nb"></div></div>
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

// ---- staging (same flow as Query) ------------------------------------------

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
      engine = await pyMod.initPython();
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
      if (cells.length === 1 && !cells[0].source && registered.length) {
        cells[0].source = engine.pandas ? `df_${registered[0].name}.head(10)` : `tables["${registered[0].name}"][:10]`;
      }
      renderSetup(root);
      renderSchema(root);
      renderNotebook(root);
      toast('Tables registered.', 'success', 3000);
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

// ---- schema rail ------------------------------------------------------------

function colKind(sheet: SheetData, i: number): string {
  const vals = sheet.rows.slice(0, 200).map((r) => r[i]).filter((v) => v !== null && v !== undefined);
  if (vals.length && vals.every((v) => typeof v === 'number')) return 'number';
  if (vals.length && vals.every((v) => typeof v === 'boolean')) return 'boolean';
  return 'text';
}

function schemaTextForAI(): string {
  const pandas = engine?.pandas;
  const lines = [
    pandas
      ? 'I have a browser Jupyter notebook (Pyodide) with pandas' + (engine?.charts ? ' and matplotlib' : '') + '. Each table below is a pandas DataFrame named df_<table>. Please write notebook Python for my request using exactly these names. The last expression of a cell is displayed; matplotlib figures are shown automatically.'
      : 'I have a browser Python notebook. Each table below is a list of dicts in tables["<name>"]. Please write pure Python (no pandas) for my request; the last expression of a cell is displayed.',
    '',
  ];
  for (const r of registered) {
    lines.push(`Table "${r.name}"${pandas ? ` (DataFrame df_${r.name})` : ''} — ${r.sheet.totalRows.toLocaleString()} rows:`);
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
    el('div', { class: 'file-list-head' }, [engine?.pandas ? 'DataFrames (df_<name>)' : 'Tables (tables["name"])']),
    copyBtn,
  ]);

  const list = el('div', { class: 'schema-detail' });
  for (const r of registered) {
    list.append(
      el('details', { class: 'schema-block', open: '' }, [
        el('summary', {}, [
          el('span', { class: 'schema-name' }, [engine?.pandas ? `df_${r.name}` : r.name]),
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

// ---- notebook ---------------------------------------------------------------

function renderNotebook(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#nb')!;
  host.innerHTML = '';
  if (!registered.length && !cells.some((c) => c.source)) {
    if (!registered.length) return; // notebook appears after first registration
  }

  const badge = engine
    ? `pandas ${engine.pandas ? '✓' : '✗'} · charts ${engine.charts ? '✓' : '✗'}`
    : '';
  const toolbar = el('div', { class: 'nb-toolbar' }, [
    button('Run all', () => runAll(root)),
    button('+ Code', () => { cells.push({ id: cellSeq++, kind: 'code', source: '' }); renderNotebook(root); }, 'btn-ghost'),
    button('+ Markdown', () => { cells.push({ id: cellSeq++, kind: 'markdown', source: '', mdEditing: true }); renderNotebook(root); }, 'btn-ghost'),
    button('Save .ipynb', () => saveIpynb(), 'btn-ghost'),
    button('Open .ipynb', () => openIpynb(root), 'btn-ghost'),
    el('span', { class: 'nb-badge' }, [badge]),
  ]);

  const list = el('div', { class: 'nb-cells' });
  cells.forEach((cell, idx) => list.append(cellEl(root, cell, idx)));
  host.append(toolbar, list);
}

function cellEl(root: HTMLElement, cell: UICell, idx: number): HTMLElement {
  const wrap = el('div', { class: `nb-cell nb-${cell.kind}` });

  const gutter = el('div', { class: 'nb-gutter' }, [
    el('span', { class: 'nb-count' }, [cell.kind === 'code' ? `[${cell.execCount ?? ' '}]` : 'md']),
  ]);

  const bodyHost = el('div', { class: 'nb-body' });

  if (cell.kind === 'markdown' && !cell.mdEditing) {
    const view = el('div', { class: 'nb-md' });
    view.innerHTML = cell.source.trim() ? renderMarkdown(cell.source) : '<p class="nb-md-empty">Empty note — double-click to edit.</p>';
    view.addEventListener('dblclick', () => { cell.mdEditing = true; renderNotebook(root); });
    bodyHost.append(view);
  } else {
    const ta = el('textarea', { class: 'nb-src', spellcheck: 'false', rows: '1' }) as HTMLTextAreaElement;
    ta.value = cell.source;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(34, ta.scrollHeight) + 'px'; };
    ta.addEventListener('input', () => { cell.source = ta.value; grow(); });
    requestAnimationFrame(grow);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (cell.kind === 'markdown') { cell.mdEditing = false; renderNotebook(root); }
        else runOne(root, cell, true);
      }
    });
    bodyHost.append(ta);
  }

  // Output area (code cells)
  if (cell.kind === 'code' && cell.lastResult) {
    bodyHost.append(outputEl(cell.lastResult));
  }

  const actions = el('div', { class: 'nb-actions' }, [
    ...(cell.kind === 'code'
      ? [button('Run', () => runOne(root, cell, false), 'btn-ghost nb-act')]
      : [button(cell.mdEditing ? 'Done' : 'Edit', () => { cell.mdEditing = !cell.mdEditing; renderNotebook(root); }, 'btn-ghost nb-act')]),
    button('↑', () => { if (idx > 0) { [cells[idx - 1], cells[idx]] = [cells[idx], cells[idx - 1]]; renderNotebook(root); } }, 'btn-ghost nb-act'),
    button('↓', () => { if (idx < cells.length - 1) { [cells[idx + 1], cells[idx]] = [cells[idx], cells[idx + 1]]; renderNotebook(root); } }, 'btn-ghost nb-act'),
    button('✕', () => { cells.splice(idx, 1); if (!cells.length) cells.push({ id: cellSeq++, kind: 'code', source: '' }); renderNotebook(root); }, 'btn-ghost nb-act nb-del'),
  ]);

  wrap.append(gutter, bodyHost, actions);
  return wrap;
}

function outputEl(res: CellResult): HTMLElement {
  const out = el('div', { class: 'nb-out' });
  if (res.stdout) out.append(el('pre', { class: 'nb-stdout' }, [res.stdout]));
  for (const o of res.outputs) {
    if (o.type === 'table') {
      const rows = o.rows.slice(0, PREVIEW_ROWS) as CellValue[][];
      out.append(createDataGrid({ name: 'Out', headers: o.headers, rows, totalRows: o.rows.length }));
      if (o.rows.length > PREVIEW_ROWS) out.append(el('div', { class: 'sheet-meta' }, [`showing first ${PREVIEW_ROWS.toLocaleString()} of ${o.rows.length.toLocaleString()} rows`]));
    } else if (o.type === 'image') {
      const img = el('img', { class: 'nb-img', alt: 'chart' }) as HTMLImageElement;
      img.src = 'data:image/png;base64,' + o.png;
      out.append(img);
    } else {
      out.append(el('pre', { class: 'nb-repr' }, [o.text]));
    }
  }
  if (res.error) out.append(el('pre', { class: 'sql-error nb-tb' }, [res.error]));
  out.append(el('div', { class: 'nb-ms' }, [`${res.elapsedMs.toFixed(0)} ms`]));
  return out;
}

async function runOne(root: HTMLElement, cell: UICell, advance: boolean): Promise<boolean> {
  if (!cell.source.trim()) return true;
  const pyMod = await import('../core/python');
  const res = await pyMod.runCell(cell.source);
  cell.lastResult = res;
  cell.execCount = execSeq++;
  cell.stdout = res.stdout || undefined;
  cell.textResult = res.outputs.find((o) => o.type === 'text')?.type === 'text'
    ? (res.outputs.find((o) => o.type === 'text') as { type: 'text'; text: string }).text
    : undefined;
  if (advance) {
    const idx = cells.indexOf(cell);
    if (idx === cells.length - 1) cells.push({ id: cellSeq++, kind: 'code', source: '' });
  }
  renderNotebook(root);
  if (advance) {
    const idx = cells.indexOf(cell);
    root.querySelectorAll<HTMLTextAreaElement>('.nb-src')[Math.min(idx + 1, cells.length - 1)]?.focus();
  }
  return res.ok;
}

async function runAll(root: HTMLElement): Promise<void> {
  for (const cell of cells) {
    if (cell.kind !== 'code') continue;
    const ok = await runOne(root, cell, false);
    if (!ok) {
      toast('Run all stopped at the first error.', 'warning', 5000);
      return;
    }
  }
  toast('All cells ran.', 'success', 3000);
}

function saveIpynb(): void {
  const blob = new Blob([toIpynb(cells)], { type: 'application/x-ipynb+json' });
  downloadBlob(blob, 'notebook.ipynb');
  toast('Notebook saved — it opens in real Jupyter too.', 'success', 4000);
}

async function openIpynb(root: HTMLElement): Promise<void> {
  const files = await pickFiles('.ipynb,application/x-ipynb+json', false);
  if (!files.length) return;
  try {
    const text = await files[0].text();
    const loaded = fromIpynb(text);
    cells = loaded.length ? loaded.map((c) => ({ ...c, id: cellSeq++ })) : cells;
    renderNotebook(root);
    toast(`Loaded ${loaded.length} cell(s) from "${files[0].name}".`, 'success', 4000);
  } catch (e) {
    toast(`Could not open notebook: ${msg(e)}`, 'error', 7000);
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
