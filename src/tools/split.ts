// Split: break one sheet into many files, delivered as a single .zip.
// Two modes — by the distinct values in a column, or into fixed-size row chunks.
// Each piece is written as .xlsx or .csv.
import { createDropzone } from '../ui/dropzone';
import { toast } from '../ui/toast';
import { el, button, selectField, radioGroup } from '../ui/controls';
import { parseFile, serializeSheet } from '../core/parser';
import { downloadBlob } from '../core/fileio';
import { splitByColumn, splitByRows, type SplitPart } from '../core/transform';
import { makeZip, blobToBytes, type ZipEntry } from '../core/zip';
import type { Workbook, SheetData, ExportFormat } from '../core/types';

let wb: Workbook | null = null;
let baseName = 'data';
let sheetIdx = 0;
let mode: 'column' | 'rows' = 'column';
let outFormat: ExportFormat = 'xlsx';

export function mountSplit(root: HTMLElement): void {
  wb = null;
  mode = 'column';
  outFormat = 'xlsx';
  sheetIdx = 0;
  root.innerHTML = `
    <div class="tool-head"><h2>Split</h2>
    <p class="tool-blurb">Separate one sheet into many files — by a column's values, or into fixed-size chunks. Downloads as a .zip.</p></div>
    <div class="tool-body"><div id="dz"></div><div id="config"></div></div>`;

  root.querySelector('#dz')!.append(
    createDropzone({
      onError: (m) => toast(m, 'error'),
      onWarning: (m) => toast(m, 'warning', 7000),
      onFiles: async (files) => {
        const file = files[0];
        baseName = file.name.replace(/\.[^.]+$/, '') || 'data';
        try {
          wb = await parseFile(file);
          sheetIdx = 0;
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

  const sheetOpts = wb.sheets.map((s, i) => ({ value: String(i), label: `${s.name} (${s.totalRows} rows)` }));
  const { wrap: sheetWrap, select: sheetSel } = selectField('Sheet', sheetOpts, String(sheetIdx));
  sheetSel.addEventListener('change', () => {
    sheetIdx = Number(sheetSel.value);
    renderModeControls();
  });

  const { wrap: fmtWrap, select: fmtSel } = selectField(
    'Each file as',
    [{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV (.csv)' }],
    outFormat,
  );
  fmtSel.addEventListener('change', () => (outFormat = fmtSel.value as ExportFormat));

  const modeCtrl = radioGroup(
    'split-mode',
    [
      { value: 'column', label: 'By column value', hint: 'one file per distinct value' },
      { value: 'rows', label: 'By row count', hint: 'fixed-size chunks' },
    ],
    mode,
    (v) => {
      mode = v as typeof mode;
      renderModeControls();
    },
  );

  const modeHost = el('div', { class: 'mode-host' });
  const estimate = el('div', { class: 'sheet-meta' });
  const goBtn = button('Split & download .zip', () => runSplit(root));

  host.append(
    el('div', { class: 'workbook-bar' }, [
      el('span', { class: 'wb-name' }, [baseName]),
      button('Open another', () => mountSplit(root), 'btn-ghost'),
    ]),
    el('div', { class: 'config-bar' }, [sheetWrap, fmtWrap]),
    el('div', { class: 'options-panel' }, [modeCtrl, modeHost]),
    estimate,
    goBtn,
  );

  let getParts: () => SplitPart[] = () => [];

  const renderModeControls = () => {
    modeHost.innerHTML = '';
    const sheet = wb!.sheets[sheetIdx];
    if (mode === 'column') {
      const colOpts = sheet.headers.map((h, i) => ({ value: String(i), label: h }));
      const { wrap, select } = selectField('Column', colOpts, '0');
      select.addEventListener('change', updateEstimate);
      modeHost.append(wrap);
      getParts = () => splitByColumn(sheet, Number(select.value));
    } else {
      const input = el('input', { type: 'number', class: 'field-input', value: '1000', min: '1' });
      input.addEventListener('input', updateEstimate);
      modeHost.append(el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Rows per file']), input]));
      getParts = () => splitByRows(sheet, Math.max(1, Number(input.value) || 1000));
    }
    updateEstimate();
  };

  const updateEstimate = () => {
    const n = getParts().length;
    estimate.textContent = `Will produce ${n} file${n === 1 ? '' : 's'}.`;
  };

  // Expose the current getParts to runSplit via the config host element.
  (host as unknown as { _getParts: () => SplitPart[] })._getParts = () => getParts();
  renderModeControls();
}

async function runSplit(root: HTMLElement): Promise<void> {
  const host = root.querySelector<HTMLElement>('#config')! as unknown as { _getParts: () => SplitPart[] };
  const parts = host._getParts();
  if (!parts.length) {
    toast('Nothing to split.', 'warning');
    return;
  }
  if (parts.length > 500 && !confirm(`This will create ${parts.length} files. Continue?`)) return;

  try {
    const entries: ZipEntry[] = [];
    for (const part of parts) {
      const named: SheetData = { ...part.sheet, name: part.sheet.name };
      const { blob, ext } = await serializeSheet(named, outFormat);
      entries.push({ name: `${safe(part.key)}.${ext}`, data: await blobToBytes(blob) });
    }
    const zip = makeZip(entries);
    downloadBlob(zip, `${baseName}_split.zip`);
    toast(`Split into ${entries.length} file(s) → ${baseName}_split.zip`, 'success', 3500);
  } catch (e) {
    toast(`Split failed: ${msg(e)}`, 'error', 8000);
  }
}

function safe(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'part';
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
