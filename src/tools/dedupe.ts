// Dedupe: remove duplicate rows, keyed on chosen columns (not just whole-row
// exact match — "same invoice number" is what people usually mean). Reports how
// many rows and duplicate groups were removed, previews the result, downloads.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { el, button, selectField, radioGroup, checkboxList } from '../ui/controls';
import { parseFile, serializeSheet } from '../core/parser';
import { downloadBlob, withExtension } from '../core/fileio';
import { dedupeByKeys, type DedupeResult } from '../core/transform';
import type { Workbook, SheetData, ExportFormat } from '../core/types';

const PREVIEW_ROWS = 3000;
const FORMATS = [
  { value: 'xlsx', label: 'Excel (.xlsx)' },
  { value: 'csv', label: 'CSV (.csv)' },
  { value: 'json', label: 'JSON (.json)' },
];

let wb: Workbook | null = null;
let fileName = 'data';
let keep: 'first' | 'last' = 'first';

export function mountDedupe(root: HTMLElement): void {
  wb = null;
  keep = 'first';
  root.innerHTML = `
    <div class="tool-head"><h2>Dedupe</h2>
    <p class="tool-blurb">Remove duplicate rows. Pick the columns that define a duplicate (leave all unticked for exact whole-row matches).</p></div>
    <div class="tool-body"><div id="dz"></div><div id="config"></div><div id="result"></div></div>`;

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

function renderConfig(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#config')!;
  host.innerHTML = '';
  if (!wb) return;

  const { wrap: sheetWrap, select: sheetSel } = selectField(
    'Sheet',
    wb.sheets.map((s, i) => ({ value: String(i), label: `${s.name} (${s.totalRows} rows)` })),
    '0',
  );

  const keysHost = el('div', { class: 'keys-host' });
  let getKeys: () => number[] = () => [];
  const rebuildKeys = () => {
    const sheet = wb!.sheets[Number(sheetSel.value)];
    const cl = checkboxList('Duplicate key columns', sheet.headers);
    keysHost.innerHTML = '';
    keysHost.append(cl.wrap);
    getKeys = cl.getChecked;
  };
  sheetSel.addEventListener('change', rebuildKeys);
  rebuildKeys();

  const keepCtrl = radioGroup(
    'dedupe-keep',
    [
      { value: 'first', label: 'Keep first', hint: 'first occurrence of each group survives' },
      { value: 'last', label: 'Keep last', hint: 'last occurrence survives' },
    ],
    keep,
    (v) => (keep = v as typeof keep),
  );

  const { wrap: fmtWrap, select: fmtSel } = selectField('Download as', FORMATS, 'xlsx');

  const run = button('Remove duplicates', () => {
    const sheet = wb!.sheets[Number(sheetSel.value)];
    const result = dedupeByKeys(sheet, getKeys(), keep);
    renderResult(root, result, fmtSel.value as ExportFormat);
  });

  host.append(
    el('div', { class: 'workbook-bar' }, [
      el('span', { class: 'wb-name' }, [fileName]),
      button('Open another', () => mountDedupe(root), 'btn-ghost'),
    ]),
    el('div', { class: 'config-bar' }, [sheetWrap]),
    el('div', { class: 'options-panel' }, [keysHost, keepCtrl]),
    el('div', { class: 'config-bar' }, [fmtWrap, run]),
  );
}

function renderResult(root: HTMLElement, result: DedupeResult, format: ExportFormat): void {
  const host = root.querySelector<HTMLElement>('#result')!;
  host.innerHTML = '';

  const chip = (label: string, n: number, cls = '') =>
    el('div', { class: `diff-chip ${cls}` }, [el('span', { class: 'chip-n' }, [n.toLocaleString()]), el('span', {}, [label])]);

  host.append(
    el('div', { class: 'diff-summary' }, [
      chip('Kept', result.kept, 'c-b'),
      chip('Removed', result.removed, result.removed ? 'c-a' : ''),
      chip('Duplicate groups', result.duplicateGroups, 'c-changed'),
    ]),
  );

  const dlBtn = button('Download result', async () => {
    const { blob, ext } = await serializeSheet(result.sheet, format);
    downloadBlob(blob, withExtension(fileName, `deduped.${ext}`));
    toast(`Deduped file downloaded (.${ext})`, 'success', 3000);
  });
  host.append(el('div', { class: 'config-bar' }, [dlBtn]));

  const view: SheetData = { ...result.sheet, rows: result.sheet.rows.slice(0, PREVIEW_ROWS) };
  host.append(
    el('div', { class: 'sheet-meta' }, [
      `${result.sheet.totalRows.toLocaleString()} row(s) remain` +
        (result.sheet.totalRows > PREVIEW_ROWS ? ` (showing first ${PREVIEW_ROWS.toLocaleString()})` : ''),
    ]),
  );
  if (view.rows.length) host.append(createDataGrid(view));

  toast(`Removed ${result.removed.toLocaleString()} duplicate row(s).`, result.removed ? 'success' : 'info', 4000);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
