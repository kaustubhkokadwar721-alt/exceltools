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
import { setHeadCompact, createSourceBar } from '../ui/toolchrome';
import { tableActions, imageActions } from '../ui/resultactions';
import { tableSetupCard, type SourceSetup } from '../ui/source-setup';
import { parseFile, serializeWorkbook } from '../core/parser';
import { resolveSource } from '../core/source';
import { downloadBlob, pickFiles } from '../core/fileio';
import { toIpynb, fromIpynb, titleFromIpynb, renderMarkdown, type NotebookCell } from '../core/notebook';
import { inferColumnKind, schemaTextForAI } from '../core/schema';
import { explainPythonError } from '../core/pyerrors';
import { snippetsFor, columnChoices, defaultValues, type Snippet } from '../core/snippets';
import { saveDraft, loadDraft, clearDraft, describeAge, isDraftEnabled, setDraftEnabled } from '../core/nbstore';
import type { SheetData, TableDef, ColumnKind } from '../core/types';
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
  foldBtn?: HTMLButtonElement;
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
  title: '',
  /** Table names a restored draft was written against, so staging can match. */
  expectedTables: [] as string[],
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
  state.title = '';
  state.expectedTables = [];
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
  renderDropzone(true);
  renderToolbar();
  renderAllCells();
  renderRail();
  offerRestore();
}

// ---- staging (same flow as Query) ------------------------------------------

/**
 * The drop area is onboarding. Once tables are registered it shrinks to a line
 * that says what is loaded, giving ~200px back to the notebook — with "Add more
 * files" to bring it back. Same for the heading block.
 */
function renderDropzone(expanded: boolean): void {
  const host = q('#dz');
  host.innerHTML = '';
  if (expanded || !state.registered.length) {
    host.append(
      createDropzone({
        multiple: true,
        onError: (m) => toast(m, 'error'),
        onWarning: (m) => toast(m, 'warning', 7000),
        onFiles: (files) => addFiles(files),
      }),
    );
    return;
  }
  const named = (r: Registered): string => (state.engine?.pandas === false ? r.name : `df_${r.name}`);
  host.append(
    createSourceBar({
      summary: `${state.registered.length} table${state.registered.length === 1 ? '' : 's'} ready`,
      items: state.registered.map((r) => ({ name: named(r), meta: `${r.sheet.totalRows.toLocaleString()} rows` })),
      addLabel: '＋ Add more files',
      onAdd: () => renderDropzone(true),
    }),
  );
}

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

  // A restored notebook expects its tables by name; offer those names in order
  // so re-adding the files takes one click rather than careful retyping.
  const wanted = state.expectedTables.filter((t) => !state.registered.some((r) => r.name === t));

  const sheetRows = state.pendingSheets.map((p, i) => {
    const include = el('input', { type: 'checkbox' }) as HTMLInputElement;
    include.checked = true;
    const name = el('input', { class: 'field-input col-name' }) as HTMLInputElement;
    name.value = wanted[i] ?? p.defaultName.replace(/\.[^.]+$/, '');
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
      refreshPlaceholders();
      updateEmptyState();
      // You are working now — the onboarding chrome gets out of the way.
      renderDropzone(false);
      setHeadCompact(root(), true);
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
  if (wanted.length) {
    children.push(
      el('div', { class: 'stage-expects' }, [
        `Your restored notebook uses ${wanted.length === 1 ? 'a table called' : 'tables called'} ${wanted.join(', ')} — keep ${wanted.length === 1 ? 'that name' : 'those names'} and its steps will run as they did.`,
      ]),
    );
  }
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

  // A wide table has fifty columns; scanning them by eye is not a plan.
  const totalCols = state.registered.reduce((n, r) => n + r.sheet.headers.length, 0);
  if (totalCols > 12) {
    const filter = el('input', {
      class: 'field-input rail-filter',
      type: 'search',
      placeholder: `Find a column (${totalCols})`,
      'aria-label': 'Filter columns',
    }) as HTMLInputElement;
    filter.addEventListener('input', () => {
      const term = filter.value.trim().toLowerCase();
      for (const col of host.querySelectorAll<HTMLElement>('.schema-col')) {
        col.hidden = !!term && !(col.dataset.name ?? '').includes(term);
      }
      for (const block of host.querySelectorAll<HTMLDetailsElement>('.schema-block')) {
        const hits = block.querySelectorAll('.schema-col:not([hidden])').length;
        block.hidden = !!term && hits === 0;
        if (term) block.open = true;
      }
    });
    host.append(filter);
  }

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
            const col = el('div', { class: 'schema-col', 'data-name': h.toLowerCase(), title: `Insert "${h}" into the cell you are editing` }, [
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

  // Grouped by what they do — run, build, file — so the controls read as three
  // decisions rather than a row of equal-weight buttons. The file group carries
  // short labels with full tooltips, because it is the least-used group and was
  // wrapping the row onto two lines.
  const divider = (): HTMLElement => el('span', { class: 'nb-tb-div', 'aria-hidden': 'true' });
  const fileBtn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = button(label, onClick, 'btn-ghost');
    b.title = title;
    return b;
  };
  const exportBtn = fileBtn('Export', 'Download every table result as one Excel workbook', () => void exportWorkbook());
  const clearBtn = fileBtn('Clear', 'Remove every result, keeping the code', () => clearResults());
  const saveBtn = fileBtn('Save', 'Download this notebook as an .ipynb file, results included', () => saveIpynb());
  const openBtn = fileBtn('Open', 'Open an .ipynb notebook file', () => void openIpynb());
  const toolbar = el('div', { class: 'nb-toolbar' }, [
    runAllBtn,
    stopBtn,
    divider(),
    recipesBtn,
    button('＋ Code', () => insertCell('code'), 'btn-ghost'),
    button('＋ Note', () => insertCell('markdown'), 'btn-ghost'),
    divider(),
    exportBtn,
    clearBtn,
    saveBtn,
    openBtn,
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

  // A filed working paper needs a name. It rides in the .ipynb and names the
  // files you export, so "which analysis was this?" has an answer later.
  const titleInput = el('input', {
    class: 'nb-title',
    placeholder: 'Name this analysis',
    'aria-label': 'Notebook name',
    maxlength: '80',
  }) as HTMLInputElement;
  titleInput.value = state.title;
  titleInput.addEventListener('input', () => {
    state.title = titleInput.value;
    scheduleSave();
  });

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

  host.append(
    el('div', { class: 'nb-titlebar' }, [titleInput]),
    toolbar,
    el('div', { class: 'nb-toolbar-foot' }, [
      keys,
      el('span', { class: 'nb-badge', id: 'nb-engine' }, [engineLabel()]),
      draftToggle,
    ]),
  );
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

  const fold = button('', () => {
    cell.sourceHidden = !cell.sourceHidden;
    fillBody(cell);
    refreshGutter(cell);
    scheduleSave();
  }, 'nb-fold');
  view.foldBtn = fold;

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

  // Adding a step in the middle used to mean "add at the end, then press ↑
  // four times". This strip appears in the gap under each cell on hover.
  const insertHere = el('div', { class: 'nb-insert' }, [
    button('＋ Code', () => insertCell('code', cell), 'nb-insert-btn'),
    button('＋ Note', () => insertCell('markdown', cell), 'nb-insert-btn'),
    button('⧉ Duplicate', () => insertCell(cell.kind, cell, cell.source), 'nb-insert-btn'),
  ]);

  rootEl.append(gutter, body, actions, insertHere);
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
  view.body.querySelector('.nb-folded')?.remove();

  // Folded code keeps its first line visible, so a long notebook still reads
  // as a list of steps rather than a column of empty boxes.
  if (cell.sourceHidden) {
    const lines = cell.source.split('\n');
    const first = lines.find((l) => l.trim()) ?? '(empty)';
    const preview = el('button', { class: 'nb-folded', type: 'button', title: 'Show the code' }, [
      el('code', {}, [first.trim().slice(0, 90) + (first.trim().length > 90 ? '…' : '')]),
      el('span', { class: 'nb-folded-meta' }, [`${lines.length} line${lines.length === 1 ? '' : 's'} hidden`]),
    ]);
    preview.addEventListener('click', () => {
      cell.sourceHidden = false;
      fillBody(cell);
      refreshGutter(cell);
      cell.view?.editor?.focus();
      scheduleSave();
    });
    view.body.prepend(preview);
    view.editor = undefined;
    return;
  }

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
    placeholder: cell.kind === 'code' ? codePlaceholder() : 'A note for whoever reads this later (markdown works)',
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

function codePlaceholder(): string {
  const first = state.registered[0];
  if (!first) return 'Python — or add a spreadsheet above to work with your own data';
  const name = state.engine?.pandas === false ? `tables["${first.name}"]` : `df_${first.name}.head()`;
  return `Python — try Insert a step above, or ${name}`;
}

/** Registering changes what the hint should say, so refresh the empty cells. */
function refreshPlaceholders(): void {
  const hint = codePlaceholder();
  for (const cell of state.cells) {
    if (cell.kind === 'code' && cell.view?.editor) cell.view.editor.textarea.placeholder = hint;
  }
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
  if (view.foldBtn) {
    view.foldBtn.textContent = cell.sourceHidden ? '▸' : '▾';
    view.foldBtn.title = cell.sourceHidden ? 'Show the code' : 'Hide the code';
    view.gutter.append(view.foldBtn);
  }

  // One glance should say what happened here: running, done, or broken.
  view.root.classList.toggle('is-running', !!cell.running);
  view.root.classList.toggle('is-error', !cell.running && !!cell.error);
  view.root.classList.toggle('is-ok', !cell.running && !cell.error && cell.execCount !== undefined);
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

/**
 * Delete, with a way back. A deleted cell is minutes of thinking, and there is
 * no other undo for it — so the gap it leaves offers to put it back before it
 * quietly disappears.
 */
function deleteCell(cell: UICell): void {
  const idx = state.cells.indexOf(cell);
  if (idx < 0) return;
  const node = cell.view!.root;
  const list = cellList();
  const wasEmpty = !cell.source.trim();
  state.cells.splice(idx, 1);

  if (wasEmpty) {
    node.remove();
  } else {
    const undo = el('div', { class: 'nb-undo' }, [
      el('span', {}, [`Deleted a ${cell.kind === 'code' ? 'code cell' : 'note'}.`]),
      button('Undo', () => {
        const at = Math.min(idx, state.cells.length);
        state.cells.splice(at, 0, cell);
        const restored = buildCell(cell); // rebuilds and re-owns cell.view
        list.insertBefore(restored, undo);
        undo.remove();
        restored.querySelector<HTMLTextAreaElement>('.ce-input')?.focus();
        updateEmptyState();
        scheduleSave();
      }, 'btn-ghost'),
    ]);
    list.insertBefore(undo, node);
    node.remove();
    setTimeout(() => undo.remove(), 15_000);
  }

  if (!state.cells.length) {
    const fresh = newCell('code');
    state.cells.push(fresh);
    list.append(buildCell(fresh));
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

/** One labelled, colour-coded result. The label says what it is; the actions
 *  say what you can do with it. */
function outBlock(kind: string, label: string, meta: string, body: Node, actions?: HTMLElement): HTMLElement {
  const head = el('div', { class: 'out-label' }, [
    el('span', { class: 'out-label-kind' }, [label]),
    ...(meta ? [el('span', { class: 'out-label-meta' }, [meta])] : []),
  ]);
  if (actions) head.append(actions);
  return el('section', { class: `out-block out-${kind}` }, [head, body]);
}

function refreshOutput(cell: UICell): void {
  const host = cell.view!.out;
  host.innerHTML = '';
  if (cell.kind !== 'code') return;

  const blocks: HTMLElement[] = [];

  if (cell.stdout) {
    blocks.push(outBlock('stdout', 'Printed', '', el('pre', { class: 'nb-stdout' }, [cell.stdout])));
  }

  (cell.outputs ?? []).forEach((o, i) => {
    if (o.type === 'table') {
      const rows = o.rows.slice(0, PREVIEW_ROWS);
      const sheet = { name: 'Result', headers: o.headers, rows: o.rows, totalRows: o.rows.length };
      // An empty grid looks broken. Say plainly that the step worked and found
      // nothing — for a reconciliation that is often the answer you wanted.
      const body = o.rows.length
        ? el('div', {}, [createDataGrid({ name: 'Result', headers: o.headers, rows, totalRows: o.rows.length }, { formatNumbers: true, sortable: true })])
        : el('div', { class: 'out-empty' }, [
            el('strong', {}, ['No rows.']),
            el('span', {}, [
              ' The step ran without error — nothing matched.' +
                (o.headers.length ? ` The columns would have been: ${o.headers.join(', ')}.` : ''),
            ]),
          ]);
      if (o.rows.length > PREVIEW_ROWS) {
        body.append(el('div', { class: 'sheet-meta' }, [
          `showing the first ${PREVIEW_ROWS.toLocaleString()} rows — an export contains all ${o.rows.length.toLocaleString()}`,
        ]));
      }
      const meta = `${o.rows.length.toLocaleString()} row${o.rows.length === 1 ? '' : 's'} × ${o.headers.length} column${o.headers.length === 1 ? '' : 's'}`;
      blocks.push(outBlock('table', 'Table', meta, body, tableActions(sheet, resultFileName(cell, i))));
    } else if (o.type === 'image') {
      const img = el('img', { class: 'nb-img', alt: 'Chart produced by this cell' }) as HTMLImageElement;
      img.src = 'data:image/png;base64,' + o.png;
      blocks.push(outBlock('image', 'Chart', '', img, imageActions(o.png, resultFileName(cell, i))));
    } else {
      blocks.push(outBlock('value', 'Value', '', el('pre', { class: 'nb-repr' }, [o.text])));
    }
  });

  if (blocks.length) {
    const body = el('div', { class: 'out-body' }, blocks);
    const foldBtn = button(cell.outputsHidden ? '▸' : '▾', () => {
      cell.outputsHidden = !cell.outputsHidden;
      refreshOutput(cell);
      scheduleSave();
    }, 'nb-fold out-fold');
    foldBtn.title = cell.outputsHidden ? 'Show the results' : 'Hide the results';
    const summary = cell.outputsHidden ? `${blocks.length} result${blocks.length === 1 ? '' : 's'} hidden` : '';
    const head = el('div', { class: 'out-head' }, [
      foldBtn,
      el('span', { class: 'out-head-label' }, ['Results']),
      el('span', { class: 'out-head-meta' }, [summary || (cell.elapsedMs !== undefined ? formatElapsed(cell.elapsedMs) : '')]),
    ]);
    host.append(head);
    if (!cell.outputsHidden) host.append(body);
  }

  // Errors sit outside the fold — the one thing that must never be hidden.
  if (cell.error) host.append(errorEl(cell.error));
}

/** A filename that says which step produced it: notebook-step-3-result.xlsx */
function resultFileName(cell: UICell, index: number): string {
  const step = cell.execCount ?? state.cells.indexOf(cell) + 1;
  return `notebook-step-${step}${index ? `-${index + 1}` : ''}-result`;
}

function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
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

  // A long step with no feedback is indistinguishable from a frozen tab, so
  // count the seconds out loud and say where the way out is.
  const startedAt = performance.now();
  const note = el('div', { class: 'nb-running-note' }, ['Running…']);
  cell.view!.out.prepend(note);
  const tick = setInterval(() => {
    const secs = Math.round((performance.now() - startedAt) / 1000);
    note.textContent = secs < 3 ? 'Running…' : `Running… ${secs}s — Stop is in the toolbar above`;
  }, 1000);

  const pyMod = await import('../core/python');
  let res: CellResult;
  try {
    res = await pyMod.runCell(cell.source);
  } finally {
    clearInterval(tick);
    note.remove();
    cell.running = false;
  }

  cell.execCount = state.execSeq++;
  cell.stdout = res.stdout || undefined;
  cell.outputs = res.outputs.length ? res.outputs : undefined;
  cell.error = res.ok ? undefined : res.error;
  cell.elapsedMs = res.elapsedMs;
  // A fresh result is worth seeing, even if the last one was folded away.
  if (cell.outputs?.length || cell.stdout) cell.outputsHidden = false;
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

/** Strip every result, so a notebook can be shared or saved as steps only. */
function clearResults(): void {
  let cleared = 0;
  for (const cell of state.cells) {
    if (cell.stdout || cell.outputs || cell.error || cell.execCount !== undefined) cleared++;
    cell.stdout = undefined;
    cell.outputs = undefined;
    cell.error = undefined;
    cell.execCount = undefined;
    cell.elapsedMs = undefined;
    refreshGutter(cell);
    refreshOutput(cell);
  }
  state.execSeq = 1;
  scheduleSave();
  toast(cleared ? `Cleared the results of ${cleared} cell(s). Your code is untouched.` : 'There were no results to clear.', 'success', 4000);
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
    for (const s of items) grid.append(recipeCard(s));
    host.append(grid);
  }
}

/**
 * One recipe, with its column choices inline: "Total [PrimaryAmount ▾] by
 * [Status ▾]". Changing a dropdown is the thing users want to do next, and it
 * has to be possible without editing Python.
 */
function recipeCard(s: Snippet): HTMLElement {
  const ctx = recipeContext();
  const values = defaultValues(s);
  const selects = new Map<string, HTMLSelectElement>();

  const makeSelect = (p: (typeof s.params)[number]): HTMLSelectElement => {
    const sel = el('select', { class: 'recipe-pick', 'aria-label': p.label }) as HTMLSelectElement;
    fillSelect(sel, p, values, ctx);
    sel.addEventListener('change', () => {
      values[p.id] = sel.value;
      // Changing the table changes which columns exist, so re-offer them.
      if (p.kind === 'table') {
        for (const other of s.params) {
          if (other.kind !== 'column' || (other.from ?? 'table') !== p.id) continue;
          const dependent = selects.get(other.id);
          if (dependent) {
            fillSelect(dependent, other, values, recipeContext());
            values[other.id] = dependent.value;
          }
        }
      }
    });
    selects.set(p.id, sel);
    return sel;
  };

  // Split the template so the dropdowns sit inside the sentence.
  const title = el('span', { class: 'nb-recipe-label' });
  for (const part of s.template.split(/(\{\w+\})/)) {
    const match = part.match(/^\{(\w+)\}$/);
    const param = match && s.params.find((p) => p.id === match[1]);
    if (param) title.append(makeSelect(param));
    else if (part) title.append(document.createTextNode(part));
  }

  const insert = button('Insert', () => useRecipe(s, { ...values }), 'btn recipe-insert');
  insert.title = 'Add this step to the notebook and run it';

  return el('div', { class: 'nb-recipe' }, [
    title,
    el('span', { class: 'nb-recipe-blurb' }, [s.blurb]),
    insert,
  ]);
}

function fillSelect(
  sel: HTMLSelectElement,
  p: { id: string; kind: 'table' | 'column'; kinds?: ColumnKind[]; from?: string; default: string },
  values: Record<string, string>,
  ctx: ReturnType<typeof recipeContext>,
): void {
  sel.innerHTML = '';
  const options =
    p.kind === 'table'
      ? ctx.tables.map((t) => t.name)
      : columnChoices(ctx, values[p.from ?? 'table'] ?? ctx.tables[0]?.name ?? '', p.kinds).map((c) => c.name);
  for (const name of options) sel.append(el('option', { value: name }, [name]));
  const wanted = options.includes(values[p.id]) ? values[p.id] : (options.includes(p.default) ? p.default : options[0]);
  sel.value = wanted ?? '';
  // A single choice is not a choice — show it as plain text.
  sel.classList.toggle('is-fixed', options.length < 2);
}

/** Put a recipe into the first empty cell, or a new one after the last cell. */
function useRecipe(s: Snippet, values: Record<string, string>): void {
  q('#recipes').hidden = true;
  const code = s.build(values, recipeContext());
  const empty = state.cells.find((c) => c.kind === 'code' && !c.source.trim());
  const cell = empty ?? insertCell('code');
  cell.source = code;
  cell.view?.editor?.setValue(code);
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

/** A filename someone can find again: what you called it, or the data + date. */
function baseFileName(): string {
  const named = state.title.trim().replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-');
  if (named) return named.slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 10);
  const source = state.registered[0]?.name;
  return `${source ? source.slice(0, 40) : 'notebook'}-${stamp}`;
}

function saveIpynb(): void {
  const blob = new Blob([toIpynb(asNotebookCells(), state.title)], { type: 'application/x-ipynb+json' });
  downloadBlob(blob, `${baseFileName()}.ipynb`);
  toast('Saved — with your results and charts. The file opens in real Jupyter too.', 'success', 5000);
}

/**
 * Every table result in the notebook, as one workbook with a sheet per step.
 * The single-result exports cover "I need this number"; this covers "I need to
 * hand the whole piece of work to someone", which is what actually gets filed.
 */
async function exportWorkbook(): Promise<void> {
  const sheets: SheetData[] = [];
  const used = new Set<string>();
  state.cells.forEach((cell, idx) => {
    const tables = (cell.outputs ?? []).filter((o) => o.type === 'table');
    tables.forEach((o, i) => {
      if (o.type !== 'table') return;
      // Excel sheet names: 31 chars, no []:*?/\ and no duplicates.
      let name = `Step ${cell.execCount ?? idx + 1}${tables.length > 1 ? ` (${i + 1})` : ''}`.slice(0, 31);
      for (let n = 2; used.has(name); n++) name = `${name.slice(0, 28)} ${n}`;
      used.add(name);
      sheets.push({ name, headers: o.headers, rows: o.rows, totalRows: o.rows.length });
    });
  });

  if (!sheets.length) {
    toast('No table results to export yet — run a step that produces a table first.', 'warning', 6000);
    return;
  }
  try {
    const { blob, ext } = await serializeWorkbook(sheets);
    downloadBlob(blob, `${baseFileName()}-results.${ext}`);
    toast(`Exported ${sheets.length} result${sheets.length === 1 ? '' : 's'}, one sheet each.`, 'success', 5000);
  } catch (e) {
    toast(`Could not build the workbook: ${msg(e)}`, 'error', 8000);
  }
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
    state.title = titleFromIpynb(text) || files[0].name.replace(/\.ipynb$/i, '');
    renderToolbar();
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
  if (state.root?.isConnected) saveDraftNow();
}

function scheduleSave(): void {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, AUTOSAVE_MS);
}

function saveDraftNow(): void {
  saveDraft(asNotebookCells(), state.registered.map((r) => r.name), state.title);
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
          state.title = draft.title ?? '';
          // The code refers to tables by name, so staging can pre-fill them and
          // the restored steps run instead of failing on a renamed table.
          state.expectedTables = draft.tables;
          renderToolbar();
          loadCells(draft.cells);
          host.innerHTML = '';
          toast(
            draft.tables.length
              ? `Restored. Add the file(s) again — the names ${draft.tables.join(', ')} are filled in for you — then use Run all.`
              : 'Restored.',
            'success',
            8000,
          );
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
