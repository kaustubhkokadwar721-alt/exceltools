// Clean: normalise messy data so downstream lookups, joins and comparisons stop
// silently failing. Trims/collapses whitespace, fixes case, converts
// numbers-stored-as-text, and drops blank rows/columns. Each operation is an
// opt-in toggle; the result is previewed before download.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { el, button, selectField } from '../ui/controls';
import { parseFile, serializeSheet } from '../core/parser';
import { downloadBlob, withExtension } from '../core/fileio';
import { cleanSheet, type CleanOptions, type CleanResult, type CaseMode } from '../core/transform';
import type { Workbook, SheetData, ExportFormat } from '../core/types';

const PREVIEW_ROWS = 3000;

let wb: Workbook | null = null;
let fileName = 'data';

// Sensible defaults: the safe, near-always-wanted fixes are on; case change and
// number coercion (which alter values) start off.
const opts: CleanOptions = {
  trim: true,
  collapseSpaces: true,
  caseMode: 'none',
  numbersFromText: false,
  removeBlankRows: true,
  removeBlankCols: false,
};

export function mountClean(root: HTMLElement): void {
  wb = null;
  root.innerHTML = `
    <div class="tool-head"><h2>Clean</h2>
    <p class="tool-blurb">Tidy messy data so lookups, merges and comparisons work reliably. Choose what to fix, preview, then download.</p></div>
    <div class="tool-body"><div id="dz"></div><div id="config"></div><div id="result"></div></div>`;

  attachHelp(root, 'clean');
  root.querySelector('#dz')!.append(
    createDropzone({
      onError: (m) => toast(m, 'error'),
      onWarning: (m) => toast(m, 'warning', 7000),
      onFiles: async (files) => {
        const file = files[0];
        fileName = file.name;
        try {
          wb = await parseFile(file);
          renderConfig(root);
        } catch (e) {
          toast(`Could not parse "${file.name}": ${msg(e)}`, 'error', 8000);
        }
      },
    }),
  );
}

function toggle(key: keyof CleanOptions, label: string, hint: string): HTMLElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = Boolean(opts[key]);
  input.addEventListener('change', () => ((opts[key] as boolean) = input.checked));
  return el('label', { class: 'clean-toggle' }, [
    input,
    el('span', { class: 'radio-label' }, [label]),
    el('span', { class: 'radio-hint' }, [hint]),
  ]);
}

function renderConfig(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#config')!;
  host.innerHTML = '';
  if (!wb) return;

  const { wrap: sheetWrap, select: sheetSel } = selectField(
    'Sheet',
    wb.sheets.map((s, i) => ({ value: String(i), label: `${s.name} (${s.totalRows} rows)` })),
    '0',
  );

  const { wrap: caseWrap, select: caseSel } = selectField(
    'Text case',
    [
      { value: 'none', label: 'Leave as-is' },
      { value: 'lower', label: 'lowercase' },
      { value: 'upper', label: 'UPPERCASE' },
      { value: 'title', label: 'Title Case' },
    ],
    opts.caseMode,
  );
  caseSel.addEventListener('change', () => (opts.caseMode = caseSel.value as CaseMode));

  const toggles = el('div', { class: 'clean-toggles' }, [
    toggle('trim', 'Trim whitespace', 'remove leading/trailing spaces'),
    toggle('collapseSpaces', 'Collapse inner spaces', 'multiple spaces → one'),
    toggle('numbersFromText', 'Numbers from text', '"1,000" → 1000'),
    toggle('removeBlankRows', 'Remove blank rows', 'drop fully empty rows'),
    toggle('removeBlankCols', 'Remove blank columns', 'drop empty, unnamed columns'),
  ]);

  const run = button('Clean & preview', () => {
    const sheet = wb!.sheets[Number(sheetSel.value)];
    renderResult(root, cleanSheet(sheet, opts));
  });

  host.append(
    el('div', { class: 'workbook-bar' }, [
      el('span', { class: 'wb-name' }, [fileName]),
      button('Open another', () => mountClean(root), 'btn-ghost'),
    ]),
    el('div', { class: 'config-bar' }, [sheetWrap, caseWrap]),
    el('div', { class: 'options-panel' }, [toggles]),
    el('div', { class: 'config-bar' }, [run]),
  );
}

function renderResult(root: HTMLElement, result: CleanResult): void {
  const host = root.querySelector<HTMLElement>('#result')!;
  host.innerHTML = '';

  const chip = (label: string, n: number, cls = '') =>
    el('div', { class: `diff-chip ${cls}` }, [el('span', { class: 'chip-n' }, [n.toLocaleString()]), el('span', {}, [label])]);

  host.append(
    el('div', { class: 'diff-summary' }, [
      chip('Cells changed', result.cellsChanged, result.cellsChanged ? 'c-changed' : ''),
      chip('Numbers converted', result.numbersConverted, 'c-b'),
      chip('Rows removed', result.rowsRemoved, result.rowsRemoved ? 'c-a' : ''),
      chip('Columns removed', result.colsRemoved, result.colsRemoved ? 'c-a' : ''),
    ]),
  );

  const { wrap: fmtWrap, select: fmtSel } = selectField(
    'Download as',
    [{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV (.csv)' }, { value: 'json', label: 'JSON (.json)' }],
    'xlsx',
  );
  const dlBtn = button('Download cleaned', async () => {
    const { blob, ext } = await serializeSheet(result.sheet, fmtSel.value as ExportFormat);
    downloadBlob(blob, withExtension(fileName, `cleaned.${ext}`));
    toast(`Cleaned file downloaded (.${ext})`, 'success', 3000);
  });
  host.append(el('div', { class: 'config-bar' }, [fmtWrap, dlBtn]));

  const view: SheetData = { ...result.sheet, rows: result.sheet.rows.slice(0, PREVIEW_ROWS) };
  host.append(
    el('div', { class: 'sheet-meta' }, [
      `${result.sheet.totalRows.toLocaleString()} row(s) · ${result.sheet.headers.length} column(s)` +
        (result.sheet.totalRows > PREVIEW_ROWS ? ` (showing first ${PREVIEW_ROWS.toLocaleString()})` : ''),
    ]),
  );
  if (view.rows.length) host.append(createDataGrid(view));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
