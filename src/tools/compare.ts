// Compare: diff two spreadsheets on a key column each. Shows rows only in A,
// only in B, changed (same key, different values, with the changed fields), and
// unchanged. The full diff can be downloaded as a report.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { el, button, selectField } from '../ui/controls';
import { parseFile, serializeSheet } from '../core/parser';
import { downloadBlob } from '../core/fileio';
import { diffSheets, type DiffResult } from '../core/transform';
import type { Workbook, SheetData, ExportFormat } from '../core/types';

const PREVIEW_ROWS = 3000;

interface Side {
  fileName: string;
  wb: Workbook;
}

let A: Side | null = null;
let B: Side | null = null;

export function mountCompare(root: HTMLElement): void {
  A = null;
  B = null;
  root.innerHTML = `
    <div class="tool-head"><h2>Compare</h2>
    <p class="tool-blurb">Diff two spreadsheets on a shared key column — see what was added, removed, and changed.</p></div>
    <div class="tool-body">
      <div class="compare-drops">
        <div class="compare-slot"><div class="slot-label">File A (baseline)</div><div id="dzA"></div></div>
        <div class="compare-slot"><div class="slot-label">File B (compared)</div><div id="dzB"></div></div>
      </div>
      <div id="config"></div>
      <div id="result"></div>
    </div>`;

  mountSlot(root, 'A');
  mountSlot(root, 'B');
  attachHelp(root, 'compare');
}

function mountSlot(root: HTMLElement, side: 'A' | 'B'): void {
  const host = root.querySelector<HTMLElement>(`#dz${side}`)!;
  host.innerHTML = '';
  host.append(
    createDropzone({
      onError: (m) => toast(m, 'error'),
      onWarning: (m) => toast(m, 'warning', 7000),
      onFiles: async (files) => {
        const file = files[0];
        try {
          const wb = await parseFile(file);
          const loaded = { fileName: file.name, wb };
          if (side === 'A') A = loaded;
          else B = loaded;
          renderLoaded(root, side, file.name);
          renderConfig(root);
        } catch (e) {
          toast(`Could not parse "${file.name}": ${msg(e)}`, 'error', 8000);
        }
      },
    }),
  );
}

function renderLoaded(root: HTMLElement, side: 'A' | 'B', fileName: string): void {
  const host = root.querySelector<HTMLElement>(`#dz${side}`)!;
  host.innerHTML = '';
  host.append(
    el('div', { class: 'slot-loaded' }, [
      el('span', { class: 'file-name' }, [fileName]),
      button('Change', () => mountSlot(root, side), 'btn-ghost'),
    ]),
  );
}

function renderConfig(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#config')!;
  host.innerHTML = '';
  if (!A || !B) return;

  const sheetOptsA = A.wb.sheets.map((s, i) => ({ value: String(i), label: s.name }));
  const sheetOptsB = B.wb.sheets.map((s, i) => ({ value: String(i), label: s.name }));
  const { wrap: sA, select: selSheetA } = selectField('Sheet A', sheetOptsA, '0');
  const { wrap: sB, select: selSheetB } = selectField('Sheet B', sheetOptsB, '0');

  const keyHostA = el('span');
  const keyHostB = el('span');
  let selKeyA: HTMLSelectElement;
  let selKeyB: HTMLSelectElement;

  const rebuildKeys = () => {
    const shA = A!.wb.sheets[Number(selSheetA.value)];
    const shB = B!.wb.sheets[Number(selSheetB.value)];
    // Default the two key dropdowns to a shared header name if one exists.
    const shared = shA.headers.find((h) => shB.headers.includes(h));
    const kA = selectField('Key in A', shA.headers.map((h, i) => ({ value: String(i), label: h })), String(shared ? shA.headers.indexOf(shared) : 0));
    const kB = selectField('Key in B', shB.headers.map((h, i) => ({ value: String(i), label: h })), String(shared ? shB.headers.indexOf(shared) : 0));
    keyHostA.innerHTML = '';
    keyHostB.innerHTML = '';
    keyHostA.append(kA.wrap);
    keyHostB.append(kB.wrap);
    selKeyA = kA.select;
    selKeyB = kB.select;
  };
  selSheetA.addEventListener('change', rebuildKeys);
  selSheetB.addEventListener('change', rebuildKeys);
  rebuildKeys();

  const run = button('Compare', () => {
    const shA = A!.wb.sheets[Number(selSheetA.value)];
    const shB = B!.wb.sheets[Number(selSheetB.value)];
    const result = diffSheets(shA, shB, Number(selKeyA.value), Number(selKeyB.value));
    renderResult(root, result);
  });

  host.append(el('div', { class: 'config-bar' }, [sA, keyHostA, sB, keyHostB, run]));
}

function renderResult(root: HTMLElement, result: DiffResult): void {
  const host = root.querySelector<HTMLElement>('#result')!;
  host.innerHTML = '';
  const { summary } = result;

  const chip = (label: string, n: number, cls: string) =>
    el('div', { class: `diff-chip ${cls}` }, [el('span', { class: 'chip-n' }, [String(n)]), el('span', {}, [label])]);

  const chips = el('div', { class: 'diff-summary' }, [
    chip('Only in A', summary.onlyA, 'c-a'),
    chip('Only in B', summary.onlyB, 'c-b'),
    chip('Changed', summary.changed, 'c-changed'),
    chip('Unchanged', summary.same, 'c-same'),
  ]);

  // Filter: hide unchanged by default (usually the noise).
  let hideSame = true;
  const toggle = el('input', { type: 'checkbox' });
  toggle.checked = hideSame;
  const filterLabel = el('label', { class: 'checkbox' }, [toggle, el('span', {}, ['Hide unchanged rows'])]);

  const gridHost = el('div', { class: 'grid-host' });
  const renderGrid = () => {
    const rows = hideSame ? result.sheet.rows.filter((r) => r[0] !== 'Same') : result.sheet.rows;
    const view: SheetData = { ...result.sheet, rows: rows.slice(0, PREVIEW_ROWS), totalRows: rows.length };
    gridHost.innerHTML = '';
    gridHost.append(
      el('div', { class: 'sheet-meta' }, [
        `${rows.length.toLocaleString()} row(s)` + (rows.length > PREVIEW_ROWS ? ` (showing first ${PREVIEW_ROWS.toLocaleString()})` : ''),
      ]),
    );
    if (rows.length) gridHost.append(createDataGrid(view));
    else gridHost.append(el('div', { class: 'empty' }, ['No differences to show.']));
  };
  toggle.addEventListener('change', () => {
    hideSame = toggle.checked;
    renderGrid();
  });

  const dl = selectField('Download report as', [
    { value: 'xlsx', label: 'Excel (.xlsx)' },
    { value: 'csv', label: 'CSV (.csv)' },
  ], 'xlsx');
  const dlBtn = button('Download diff', async () => {
    const { blob, ext } = await serializeSheet(result.sheet, dl.select.value as ExportFormat);
    downloadBlob(blob, `diff.${ext}`);
    toast(`Diff report downloaded (.${ext})`, 'success', 3000);
  });

  if (summary.dupKeysA || summary.dupKeysB) {
    toast(`Note: duplicate keys found (A: ${summary.dupKeysA}, B: ${summary.dupKeysB}). Last occurrence used.`, 'warning', 9000);
  }

  host.append(chips, el('div', { class: 'config-bar' }, [filterLabel, dl.wrap, dlBtn]), gridHost);
  renderGrid();
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
