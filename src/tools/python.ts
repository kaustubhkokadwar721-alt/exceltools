// Python notebook — a notebook for people who don't write Python.
//
// The engine is Pyodide in a worker; everything here is the part that makes it
// usable by an accountant: your spreadsheets arrive as named tables, a recipe
// list writes the first version of each step with your own column names, errors
// come back as sentences instead of tracebacks, work is saved as you type, and
// a run that goes wrong can be stopped.
//
// Layout of this file: state → staging → right rail → toolbar → cell views →
// outputs → execution → recipes → save/open/autosave.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { el, button } from '../ui/controls';
import { createCodeEditor, type CodeEditor } from '../ui/codeeditor';
import { tableSetupCard, type SourceSetup } from '../ui/source-setup';
import { parseFile } from '../core/parser';
import { resolveSource } from '../core/source';
import { downloadBlob, pickFiles } from '../core/fileio';
import { toIpynb, fromIpynb, renderMarkdown, type NotebookCell } from '../core/notebook';
import { inferColumnKind, schemaTextForAI } from '../core/schema';
import { explainPythonError } from '../core/pyerrors';
import { snippetsFor, type Snippet } from '../core/snippets';
import { saveDraft, loadDraft, clearDraft, describeAge, isDraftEnabled, setDraftEnabled } from '../core/nbstore';
import type { SheetData, TableDef } from '../core/types';
import type { CellResult, EngineInfo, PyVariable } from '../core/python';

const PREVIEW_ROWS = 2000;
const AUTOSAVE_MS = 800;

interface Registered {
  name: string;
  sheet: SheetData;
}

interface PendingSheet {
  sheet: SheetData;
  source: string;
  defaultName: string;
}

interface CellView {
  root: HTMLElement;
  gutter: HTMLElement;
  body: HTMLElement;
  out: HTMLElement;
  runBtn?: HTMLButtonElement;
  editor?: CodeEditor;
}

interface UICell extends NotebookCell {
  id: number;
  mdEditing?: boolean;
  running?: boolean;
  view?: CellView;
}

const state = {
  root: null as HTMLElement | null,
  registered: [] as Registered[],
  pendingTables: [] as TableDef[],
  pendingSheets: [] as PendingSheet[],
  engine: null as EngineInfo | null,
  starting: false,
  cells: [] as UICell[],
  cellSeq: 1,
  execSeq: 1,
  rail: 'tables' as 'tables' | 'variables',
  variables: [] as PyVariable[],
  saveTimer: 0 as unknown as ReturnType<typeof setTimeout>,
};

const root = (): HTMLElement => state.root!;
const q = <T extends HTMLElement>(sel: string): T => root().querySelector<T>(sel)!;
const newCell = (kind: 'code' | 'markdown', source = ''): UICell => ({ id: state.cellSeq++, kind, source });

export function mountPython(host: HTMLElement): void {
  // A debounced save from the previous visit would otherwise fire against the
  // empty state below and wipe the draft we are about to offer back.
  clearTimeout(state.saveTimer);
  attachFlush();
  state.root = host;
  state.registered = [];
  state.pendingTables = [];
  state.pendingSheets = [];
  state.engine = null;
  state.starting = false;
  state.variables = [];
  state.rail = 'tables';
  state.cells = [newCell('code')];

  host.innerHTML = `
    <div class="tool-head"><h2>Python notebook</h2>
    <p class="tool-blurb">Analyse your spreadsheets with Python — in this browser, with no Python installed. Files never leave this device.</p></div>
    <div class="tool-body">
      <div id="restore"></div>
      <div id="dz"></div>
      <div id="setup"></div>
      <div class="query-work">
        <div class="query-main">
          <div id="nbtools"></div>
          <div id="recipes" class="nb-recipes" hidden></div>
          <div id="nb"></div>
        </div>
        <aside class="query-schema" id="schema" aria-label="Your tables and variables"></aside>
      </div>
    </div>`;

  attachHelp(host, 'python');
  q('#dz').append(
    createDropzone({
      multiple: true,
      onError: (m) => toast(m, 'error'),
      onWarning: (m) => toast(m, 'warning', 7000),
      onFiles: (files) => addFiles(files),
    }),
  );

  renderToolbar();
  renderAllCells();
  renderRail();
  offerRestore();
}

// ---- staging (same flow as Query) ------------------------------------------

async function addFiles(files: File[]): Promise<void> {
  const setupHost = q('#setup');
  setupHost.innerHTML = `<div class="loading">Reading files…</div>`;
  for (const file of files) {
    try {
      const wb = await parseFile(file);
      if (wb.tables.length) state.pendingTables.push(...wb.tables);
      else
        for (const sheet of wb.sheets) {
          const label = wb.sheets.length > 1 ? `${file.name}_${sheet.name}` : file.name;
          state.pendingSheets.push({ sheet, source: file.name, defaultName: label });
        }
    } catch (e) {
      toast(`Skipped "${file.name}": ${msg(e)}`, 'error', 8000);
    }
  }
  renderSetup();
}

function renderSetup(): void {
  const host = q('#setup');
  host.innerHTML = '';
  if (!state.pendingTables.length && !state.pendingSheets.length) return;

  const sheetRows = state.pendingSheets.map((p) => {
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
  const setups: SourceSetup[] = state.pendingTables.map((def) => tableSetupCard(def));
  const total = sheetRows.length + setups.length;

  const registerBtn = button(`Register ${total} table(s)`, async () => {
    host.innerHTML = `<div class="loading">Starting Python (the first time, this takes a few seconds)…</div>`;
    try {
      const pyMod = await import('../core/python');
      state.engine = await pyMod.initPython();
      const used = new Set(state.registered.map((r) => r.name));
      for (const r of sheetRows) {
        if (!r.include.checked) continue;
        const name = pyMod.pyIdent(r.name.value.trim() || r.p.defaultName, used);
        await pyMod.registerPyTable(name, r.p.sheet);
        state.registered.push({ name, sheet: r.p.sheet });
      }
      for (const s of setups) {
        const spec = s.getSpec();
        const sheet = resolveSource(s.def, spec);
        const name = pyMod.pyIdent(spec.name, used);
        await pyMod.registerPyTable(name, sheet);
        state.registered.push({ name, sheet });
      }
      state.pendingTables = [];
      state.pendingSheets = [];
      renderSetup();
      renderRail();
      renderToolbar();
      updateEmptyState();
      toast(`${state.registered.length} table(s) ready to use.`, 'success', 3000);
    } catch (e) {
      host.innerHTML = '';
      renderSetup();
      toast(`Python could not start: ${msg(e)}`, 'error', 9000);
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

/** Re-register every table into a freshly restarted engine. */
async function reregister(): Promise<void> {
  const pyMod = await import('../core/python');
  for (const r of state.registered) await pyMod.registerPyTable(r.name, r.sheet);
}

// ---- right rail: your tables, and what's in memory --------------------------

function railTabs(): HTMLElement {
  const tab = (id: 'tables' | 'variables', label: string): HTMLButtonElement => {
    const b = button(label, () => {
      state.rail = id;
      renderRail();
      if (id === 'variables') void refreshVariables();
    }, `rail-tab${state.rail === id ? ' is-on' : ''}`);
    b.setAttribute('aria-pressed', String(state.rail === id));
    return b;
  };
  return el('div', { class: 'rail-tabs' }, [tab('tables', 'Your tables'), tab('variables', 'In memory')]);
}

function renderRail(): void {
  const host = q('#schema');
  host.innerHTML = '';
  host.append(railTabs());

  if (state.rail === 'variables') {
    host.append(renderVariables());
    return;
  }

  if (!state.registered.length) {
    host.append(
      el('div', { class: 'rail-empty' }, [
        el('p', {}, ['No tables yet.']),
        el('p', {}, ['Drop a spreadsheet above and select Register. Each sheet becomes a table you can use by name.']),
      ]),
    );
    return;
  }

  const copyBtn = button('Copy for AI assistant', async () => {
    const text = schemaTextForAI(state.registered, state.engine ?? { pandas: true, charts: true });
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied. Paste it into your AI assistant, add what you want in plain English, then paste the code back here.', 'success', 6000);
    } catch {
      const ta = el('textarea', { class: 'sql-editor', rows: '10', 'aria-label': 'Schema to copy' }) as HTMLTextAreaElement;
      ta.value = text;
      host.append(ta);
      ta.select();
    }
  }, 'btn-ghost');

  host.append(
    el('div', { class: 'schema-head' }, [
      el('div', { class: 'file-list-head' }, [state.engine?.pandas === false ? 'Tables (tables["name"])' : 'Tables (use df_<name>)']),
      copyBtn,
    ]),
  );

  const list = el('div', { class: 'schema-detail' });
  for (const r of state.registered) {
    list.append(
      el('details', { class: 'schema-block', open: '' }, [
        el('summary', {}, [
          el('span', { class: 'schema-name' }, [state.engine?.pandas === false ? r.name : `df_${r.name}`]),
          el('span', { class: 'schema-meta' }, [` — ${r.sheet.totalRows.toLocaleString()} rows`]),
        ]),
        el('div', { class: 'schema-cols-list' },
          r.sheet.headers.map((h, i) => {
            const col = el('div', { class: 'schema-col', title: `Insert "${h}" into the cell you are editing` }, [
              el('span', { class: 'schema-col-name' }, [h]),
              el('span', { class: 'schema-col-type' }, [inferColumnKind(r.sheet, i)]),
            ]);
            // Clicking a column drops its name into the focused cell — no typing,
            // no transcription errors on headings with spaces or odd casing.
            col.addEventListener('click', () => insertAtCursor(`"${h}"`));
            return col;
          }),
        ),
      ]),
    );
  }
  host.append(list);
}

function renderVariables(): HTMLElement {
  const wrap = el('div', { class: 'schema-detail' });
  if (!state.engine) {
    wrap.append(el('div', { class: 'rail-empty' }, [el('p', {}, ['Run a cell first — this shows everything Python is holding in memory.'])]));
    return wrap;
  }
  if (!state.variables.length) {
    wrap.append(el('div', { class: 'rail-empty' }, [el('p', {}, ['Nothing yet. Anything you create in a cell (a total, a filtered table) appears here.'])]));
    return wrap;
  }
  for (const v of state.variables) {
    wrap.append(
      el('div', { class: 'var-row' }, [
        el('span', { class: 'schema-name' }, [v.name]),
        el('span', { class: 'var-kind' }, [v.type]),
        el('span', { class: 'schema-meta' }, [v.detail]),
      ]),
    );
  }
  return wrap;
}

async function refreshVariables(): Promise<void> {
  if (!state.engine) return;
  const pyMod = await import('../core/python');
  state.variables = await pyMod.listVariables();
  if (state.rail === 'variables') renderRail();
}

// ---- toolbar ----------------------------------------------------------------

function renderToolbar(): void {
  const host = q('#nbtools');
  host.innerHTML = '';

  const runAllBtn = button('▶ Run all', () => void runAll());
  const stopBtn = button('■ Stop', () => void stopEngine(), 'btn-ghost nb-stop');
  stopBtn.disabled = !state.cells.some((c) => c.running);
  stopBtn.title = 'Stop the running cell by restarting Python';

  const recipesBtn = button('✚ Insert a step', () => toggleRecipes(), 'btn-ghost');
  recipesBtn.title = 'Common tasks, written out with your own column names';

  const toolbar = el('div', { class: 'nb-toolbar' }, [
    runAllBtn,
    stopBtn,
    recipesBtn,
    button('＋ Code', () => insertCell('code'), 'btn-ghost'),
    button('＋ Note', () => insertCell('markdown'), 'btn-ghost'),
    button('Save', () => saveIpynb(), 'btn-ghost'),
    button('Open', () => void openIpynb(), 'btn-ghost'),
    el('span', { class: 'nb-badge', id: 'nb-engine' }, [engineLabel()]),
  ]);

  // The rest of the suite writes nothing to disk; the draft does, so it is
  // stated plainly and can be switched off on a shared machine.
  const draftBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  draftBox.checked = isDraftEnabled();
  draftBox.addEventListener('change', () => {
    setDraftEnabled(draftBox.checked);
    if (draftBox.checked) flushSave();
    else toast('Drafts turned off and the saved one deleted. Use Save to keep your work.', 'success', 6000);
  });
  const draftToggle = el('label', { class: 'checkbox nb-draft', title: 'Kept in this browser only — never uploaded' }, [
    draftBox,
    el('span', {}, ['Keep a draft in this browser']),
  ]);

  const keys = el('details', { class: 'nb-keys' }, [
    el('summary', {}, ['Keyboard shortcuts']),
    el('div', { class: 'nb-keys-grid' }, [
      ...[
        ['Shift + Enter', 'Run this cell, go to the next'],
        ['Ctrl/⌘ + Enter', 'Run this cell, stay here'],
        ['Alt + Enter', 'Run, then add a new cell below'],
        ['Tab / Shift + Tab', 'Indent / outdent'],
        ['Ctrl/⌘ + /', 'Comment or uncomment lines'],
        ['↑ / ↓ at the edge', 'Move between cells'],
      ].flatMap(([k, v]) => [el('kbd', {}, [k]), el('span', {}, [v])]),
    ]),
  ]);

  host.append(toolbar, el('div', { class: 'nb-toolbar-foot' }, [keys, draftToggle]));
}

function engineLabel(): string {
  if (state.starting) return 'starting Python…';
  if (!state.engine) return 'Python starts on your first run';
  const bits = ['Python ready'];
  if (state.engine.pandas) bits.push('pandas');
  if (state.engine.charts) bits.push('charts');
  return bits.join(' · ');
}

function setEngineLabel(): void {
  const badge = root().querySelector('#nb-engine');
  if (badge) badge.textContent = engineLabel();
  const stop = root().querySelector<HTMLButtonElement>('.nb-stop');
  if (stop) stop.disabled = !state.cells.some((c) => c.running);
}

// ---- cell views -------------------------------------------------------------

function renderAllCells(): void {
  const host = q('#nb');
  host.innerHTML = '';
  const list = el('div', { class: 'nb-cells' });
  for (const cell of state.cells) list.append(buildCell(cell));
  host.append(list);
  updateEmptyState();
}

const cellList = (): HTMLElement => q('.nb-cells');

/**
 * Build one cell's DOM. Cells own their nodes for the rest of their life — the
 * notebook is never wiped and rebuilt, so focus, scroll position, selection and
 * a half-typed line all survive every run, insert, move and delete.
 */
function buildCell(cell: UICell): HTMLElement {
  const gutter = el('div', { class: 'nb-gutter' });
  const body = el('div', { class: 'nb-body' });
  const out = el('div', { class: 'nb-out-host' });
  const rootEl = el('div', { class: `nb-cell nb-${cell.kind}` });

  const view: CellView = { root: rootEl, gutter, body, out };
  cell.view = view;

  const actions = el('div', { class: 'nb-actions' });
  if (cell.kind === 'code') {
    view.runBtn = button('▶', () => void runOne(cell, 'stay'), 'btn-ghost nb-act nb-run');
    view.runBtn.title = 'Run this cell (Ctrl+Enter)';
    actions.append(view.runBtn);
  } else {
    const toggle = button('Edit', () => {
      cell.mdEditing = !cell.mdEditing;
      fillBody(cell);
      toggle.textContent = cell.mdEditing ? 'Done' : 'Edit';
      if (cell.mdEditing) cell.view?.editor?.focus();
    }, 'btn-ghost nb-act');
    actions.append(toggle);
  }
  const up = button('↑', () => moveCell(cell, -1), 'btn-ghost nb-act');
  up.title = 'Move up';
  const down = button('↓', () => moveCell(cell, 1), 'btn-ghost nb-act');
  down.title = 'Move down';
  const del = button('✕', () => deleteCell(cell), 'btn-ghost nb-act nb-del');
  del.title = 'Delete this cell';
  actions.append(up, down, del);

  rootEl.append(gutter, body, actions);
  body.append(out);
  fillBody(cell);
  refreshGutter(cell);
  refreshOutput(cell);
  return rootEl;
}

/** (Re)build the editing area of one cell — the only place that swaps content. */
function fillBody(cell: UICell): void {
  const view = cell.view!;
  view.body.querySelector('.ce')?.remove();
  view.body.querySelector('.nb-md')?.remove();

  if (cell.kind === 'markdown' && !cell.mdEditing) {
    const md = el('div', { class: 'nb-md' });
    md.innerHTML = cell.source.trim()
      ? renderMarkdown(cell.source)
      : '<p class="nb-md-empty">Empty note — double-click to write something.</p>';
    md.addEventListener('dblclick', () => {
      cell.mdEditing = true;
      fillBody(cell);
      cell.view?.editor?.focus();
    });
    view.body.prepend(md);
    view.editor = undefined;
    return;
  }

  const editor = createCodeEditor({
    value: cell.source,
    mode: cell.kind === 'code' ? 'python' : 'text',
    placeholder:
      cell.kind === 'code'
        ? state.registered.length
          ? `Python — try Insert a step above, or df_${state.registered[0].name}.head()`
          : 'Python — or add a spreadsheet above to work with your own data'
        : 'A note for whoever reads this later (markdown works)',
    onChange: (v) => {
      cell.source = v;
      scheduleSave();
      updateEmptyState();
    },
    onRunAdvance: () => (cell.kind === 'code' ? void runOne(cell, 'advance') : finishMarkdown(cell)),
    onRun: () => (cell.kind === 'code' ? void runOne(cell, 'stay') : finishMarkdown(cell)),
    onRunInsert: () => (cell.kind === 'code' ? void runOne(cell, 'insert') : finishMarkdown(cell)),
    onDelete: () => deleteCell(cell),
    onLeave: (dir) => focusNeighbour(cell, dir),
  });
  view.editor = editor;
  view.body.prepend(editor.el);
}

function finishMarkdown(cell: UICell): void {
  cell.mdEditing = false;
  fillBody(cell);
  const toggle = cell.view?.root.querySelector<HTMLButtonElement>('.nb-actions .nb-act');
  if (toggle) toggle.textContent = 'Edit';
  scheduleSave();
}

function refreshGutter(cell: UICell): void {
  const view = cell.view!;
  view.gutter.innerHTML = '';
  const label = cell.kind !== 'code' ? 'note' : cell.running ? '[*]' : `[${cell.execCount ?? ' '}]`;
  view.gutter.append(el('span', { class: 'nb-count' }, [label]));
  view.root.classList.toggle('is-running', !!cell.running);
  if (view.runBtn) view.runBtn.disabled = !!cell.running;
}

function insertCell(kind: 'code' | 'markdown', after?: UICell, source = ''): UICell {
  const cell = newCell(kind, source);
  if (kind === 'markdown') cell.mdEditing = true;
  const idx = after ? state.cells.indexOf(after) + 1 : state.cells.length;
  state.cells.splice(idx, 0, cell);
  const node = buildCell(cell);
  const list = cellList();
  const before = list.children[idx] ?? null;
  list.insertBefore(node, before);
  cell.view?.editor?.focus();
  updateEmptyState();
  scheduleSave();
  return cell;
}

function moveCell(cell: UICell, dir: -1 | 1): void {
  const idx = state.cells.indexOf(cell);
  const to = idx + dir;
  if (to < 0 || to >= state.cells.length) return;
  [state.cells[idx], state.cells[to]] = [state.cells[to], state.cells[idx]];
  const list = cellList();
  const node = cell.view!.root;
  const other = state.cells[idx].view!.root;
  if (dir === -1) list.insertBefore(node, other);
  else list.insertBefore(other, node);
  scheduleSave();
}

function deleteCell(cell: UICell): void {
  const idx = state.cells.indexOf(cell);
  if (idx < 0) return;
  state.cells.splice(idx, 1);
  cell.view?.root.remove();
  if (!state.cells.length) {
    const fresh = newCell('code');
    state.cells.push(fresh);
    cellList().append(buildCell(fresh));
  }
  const next = state.cells[Math.min(idx, state.cells.length - 1)];
  next?.view?.editor?.focus();
  updateEmptyState();
  scheduleSave();
}

function focusNeighbour(cell: UICell, dir: -1 | 1): void {
  const next = state.cells[state.cells.indexOf(cell) + dir];
  if (!next) return;
  if (next.kind === 'markdown' && !next.mdEditing) next.view?.root.scrollIntoView({ block: 'nearest' });
  next.view?.editor?.focus();
}

/** Drop text into whichever editor was last focused — used by the column list. */
function insertAtCursor(text: string): void {
  const active = document.activeElement;
  const target =
    active instanceof HTMLTextAreaElement && active.classList.contains('ce-input')
      ? active
      : state.cells.find((c) => c.kind === 'code' && c.view?.editor)?.view?.editor?.textarea;
  if (!target) return;
  target.focus();
  document.execCommand('insertText', false, text);
  const cell = state.cells.find((c) => c.view?.editor?.textarea === target);
  if (cell) {
    cell.source = target.value;
    scheduleSave();
  }
}

// ---- outputs and errors -----------------------------------------------------

function refreshOutput(cell: UICell): void {
  const host = cell.view!.out;
  host.innerHTML = '';
  if (cell.kind !== 'code') return;

  if (cell.stdout) host.append(el('pre', { class: 'nb-stdout' }, [cell.stdout]));

  for (const o of cell.outputs ?? []) {
    if (o.type === 'table') {
      const rows = o.rows.slice(0, PREVIEW_ROWS);
      host.append(createDataGrid({ name: 'Result', headers: o.headers, rows, totalRows: o.rows.length }));
      if (o.rows.length > PREVIEW_ROWS) {
        host.append(el('div', { class: 'sheet-meta' }, [`showing the first ${PREVIEW_ROWS.toLocaleString()} of ${o.rows.length.toLocaleString()} rows`]));
      }
    } else if (o.type === 'image') {
      const img = el('img', { class: 'nb-img', alt: 'Chart produced by this cell' }) as HTMLImageElement;
      img.src = 'data:image/png;base64,' + o.png;
      host.append(img);
    } else {
      host.append(el('pre', { class: 'nb-repr' }, [o.text]));
    }
  }

  if (cell.error) host.append(errorEl(cell.error));
}

/** The traceback, translated. The original is always one click away. */
function errorEl(raw: string): HTMLElement {
  const columns = state.registered.flatMap((r) => r.sheet.headers);
  const names = [
    ...state.registered.map((r) => (state.engine?.pandas === false ? r.name : `df_${r.name}`)),
    ...state.variables.map((v) => v.name),
  ];
  const ex = explainPythonError(raw, { columns, names });

  const head = el('div', { class: 'nb-err-title' }, [ex.title]);
  const parts: (Node | string)[] = [head];
  if (ex.hint) parts.push(el('p', { class: 'nb-err-hint' }, [ex.hint]));
  if (ex.line !== undefined) parts.push(el('p', { class: 'nb-err-where' }, [`Line ${ex.line} of this cell.`]));
  parts.push(
    el('details', { class: 'nb-err-raw' }, [
      el('summary', {}, ['Technical details']),
      el('pre', { class: 'nb-tb' }, [raw]),
    ]),
  );
  return el('div', { class: 'nb-err' }, parts);
}

// ---- execution --------------------------------------------------------------

async function ensureEngine(): Promise<void> {
  if (state.engine) return;
  state.starting = true;
  setEngineLabel();
  try {
    const pyMod = await import('../core/python');
    state.engine = await pyMod.initPython();
  } finally {
    state.starting = false;
    setEngineLabel();
  }
}

async function runOne(cell: UICell, then: 'stay' | 'advance' | 'insert'): Promise<boolean> {
  if (cell.kind !== 'code' || cell.running) return true;
  if (!cell.source.trim()) {
    if (then !== 'stay') focusNeighbour(cell, 1);
    return true;
  }

  cell.running = true;
  refreshGutter(cell);
  setEngineLabel();
  try {
    await ensureEngine();
  } catch (e) {
    cell.running = false;
    refreshGutter(cell);
    toast(`Python could not start: ${msg(e)}`, 'error', 9000);
    return false;
  }

  const pyMod = await import('../core/python');
  let res: CellResult;
  try {
    res = await pyMod.runCell(cell.source);
  } finally {
    cell.running = false;
  }

  cell.execCount = state.execSeq++;
  cell.stdout = res.stdout || undefined;
  cell.outputs = res.outputs.length ? res.outputs : undefined;
  cell.error = res.ok ? undefined : res.error;
  refreshGutter(cell);
  refreshOutput(cell);
  setEngineLabel();
  scheduleSave();
  void refreshVariables();

  if (!res.ok) cell.view?.root.scrollIntoView({ block: 'nearest' });
  else if (then === 'insert') insertCell('code', cell);
  else if (then === 'advance') {
    const next = state.cells[state.cells.indexOf(cell) + 1];
    if (next) next.view?.editor?.focus();
    else insertCell('code', cell);
  }
  return res.ok;
}

async function runAll(): Promise<void> {
  const code = state.cells.filter((c) => c.kind === 'code' && c.source.trim());
  if (!code.length) {
    toast('Nothing to run yet — add a step first.', 'warning', 4000);
    return;
  }
  for (const cell of code) {
    const ok = await runOne(cell, 'stay');
    if (!ok) {
      toast('Stopped at the first step that failed — the explanation is under that cell.', 'warning', 6000);
      return;
    }
  }
  toast(`Ran ${code.length} step(s).`, 'success', 3000);
}

/**
 * Stop = restart. Pyodide cannot be interrupted mid-cell without cross-origin
 * isolation, so the honest fast path is to kill the worker, boot a new one and
 * put the tables back. Variables from earlier cells are gone; we say so.
 */
async function stopEngine(): Promise<void> {
  const pyMod = await import('../core/python');
  for (const c of state.cells) {
    if (c.running) {
      c.running = false;
      refreshGutter(c);
    }
  }
  setEngineLabel();
  toast('Stopping…', 'warning', 2000);
  try {
    state.engine = await pyMod.restartPython();
    await reregister();
    state.variables = [];
    if (state.rail === 'variables') renderRail();
    toast('Stopped. Your tables are still here; anything else in memory was cleared — use Run all to rebuild it.', 'success', 7000);
  } catch (e) {
    toast(`Could not restart Python: ${msg(e)}`, 'error', 8000);
  }
  setEngineLabel();
}

// ---- recipes ----------------------------------------------------------------

function recipeContext(): Parameters<typeof snippetsFor>[0] {
  return {
    pandas: state.engine?.pandas !== false,
    charts: state.engine?.charts !== false,
    tables: state.registered.map((r) => ({
      name: r.name,
      columns: r.sheet.headers.map((h, i) => ({ name: h, kind: inferColumnKind(r.sheet, i) })),
    })),
  };
}

function toggleRecipes(): void {
  const host = q('#recipes');
  if (!host.hidden) {
    host.hidden = true;
    return;
  }
  renderRecipes(host, false);
  host.hidden = false;
}

function renderRecipes(host: HTMLElement, inline: boolean): void {
  host.innerHTML = '';
  const list = snippetsFor(recipeContext());
  if (!list.length) {
    host.append(
      el('div', { class: 'nb-recipes-empty' }, [
        'Add a spreadsheet above and select Register — the steps here are written using your own column names.',
      ]),
    );
    return;
  }

  host.append(
    el('div', { class: 'nb-recipes-head' }, [
      el('strong', {}, [inline ? 'Start with a common step' : 'Insert a step']),
      el('span', {}, ['Each one inserts working code using your columns. Change it afterwards — nothing is locked.']),
    ]),
  );

  const groups = new Map<string, Snippet[]>();
  for (const s of list) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);

  for (const [group, items] of groups) {
    host.append(el('div', { class: 'nb-recipe-group' }, [group]));
    const grid = el('div', { class: 'nb-recipe-grid' });
    for (const s of items) {
      const card = el('button', { class: 'nb-recipe', type: 'button' }, [
        el('span', { class: 'nb-recipe-label' }, [s.label]),
        el('span', { class: 'nb-recipe-blurb' }, [s.blurb]),
      ]);
      card.addEventListener('click', () => useRecipe(s));
      grid.append(card);
    }
    host.append(grid);
  }
}

/** Put a recipe into the first empty cell, or a new one after the last cell. */
function useRecipe(s: Snippet): void {
  q('#recipes').hidden = true;
  const empty = state.cells.find((c) => c.kind === 'code' && !c.source.trim());
  const cell = empty ?? insertCell('code');
  cell.source = s.code;
  cell.view?.editor?.setValue(s.code);
  cell.view?.editor?.focus();
  cell.view?.root.scrollIntoView({ block: 'nearest' });
  updateEmptyState();
  scheduleSave();
  void runOne(cell, 'stay');
}

/**
 * The first thing a new user sees. An empty notebook shows the recipe list
 * inline rather than a blank box, so there is always something to click.
 */
function updateEmptyState(): void {
  const host = q('#nb');
  const blank = state.cells.length === 1 && !state.cells[0].source.trim() && state.cells[0].kind === 'code';
  const existing = host.querySelector('.nb-start');
  if (!blank || !state.registered.length) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const start = el('div', { class: 'nb-recipes nb-start' });
  renderRecipes(start, true);
  host.prepend(start);
}

// ---- save, open, autosave ---------------------------------------------------

function asNotebookCells(): NotebookCell[] {
  return state.cells.map((c) => ({
    kind: c.kind,
    source: c.source,
    stdout: c.stdout,
    outputs: c.outputs,
    execCount: c.execCount,
    error: c.error,
  }));
}

function saveIpynb(): void {
  const blob = new Blob([toIpynb(asNotebookCells())], { type: 'application/x-ipynb+json' });
  downloadBlob(blob, 'notebook.ipynb');
  toast('Saved — with your results and charts. The file opens in real Jupyter too.', 'success', 5000);
}

async function openIpynb(): Promise<void> {
  const files = await pickFiles('.ipynb,application/x-ipynb+json', false);
  if (!files.length) return;
  try {
    const text = await files[0].text();
    const loaded = fromIpynb(text);
    if (!loaded.length) {
      toast('That notebook has no cells in it.', 'warning', 5000);
      return;
    }
    loadCells(loaded);
    toast(`Opened "${files[0].name}" — ${loaded.length} cell(s), results included.`, 'success', 5000);
  } catch (e) {
    toast(`Could not open that notebook: ${msg(e)}`, 'error', 7000);
  }
}

function loadCells(cells: NotebookCell[]): void {
  state.cells = cells.map((c) => ({ ...c, id: state.cellSeq++ }));
  state.execSeq = Math.max(1, ...state.cells.map((c) => (c.execCount ?? 0) + 1));
  renderAllCells();
  scheduleSave();
}

function flushSave(): void {
  clearTimeout(state.saveTimer);
  if (state.root?.isConnected) saveDraft(asNotebookCells(), state.registered.map((r) => r.name));
}

function scheduleSave(): void {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, AUTOSAVE_MS);
}

let flushAttached = false;
/** Closing the tab shouldn't cost the last few seconds of typing. */
function attachFlush(): void {
  if (flushAttached) return;
  flushAttached = true;
  addEventListener('pagehide', flushSave);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
}

/** On arrival, offer back whatever was open when the tab last closed. */
function offerRestore(): void {
  const draft = loadDraft();
  if (!draft) return;
  const host = q('#restore');
  const tables = draft.tables.length ? ` It used ${draft.tables.length} table(s): ${draft.tables.join(', ')} — add those files again to re-run it.` : '';
  host.append(
    el('div', { class: 'nb-restore' }, [
      el('div', {}, [
        el('strong', {}, ['You have unsaved work from ' + describeAge(draft.savedAt) + '.']),
        el('span', {}, [` ${draft.cells.length} cell(s).${tables}`]),
      ]),
      el('div', { class: 'nb-restore-acts' }, [
        button('Restore it', () => {
          loadCells(draft.cells);
          host.innerHTML = '';
          toast('Restored. Re-register your files, then use Run all.', 'success', 6000);
        }),
        button('Discard', () => {
          clearDraft();
          host.innerHTML = '';
        }, 'btn-ghost'),
      ]),
    ]),
  );
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
