// Split: break one sheet into many files, delivered as a single .zip.
// Five modes — a column's distinct values, fixed-size row chunks, one file per
// sheet, a key derived from part of a value, or a custom value → file grouping.
// Each piece is written as .xlsx or .csv.
import { createDropzone } from '../ui/dropzone';
import { toast } from '../ui/toast';
import { el, button, selectField, radioGroup } from '../ui/controls';
import { parseFile, serializeSheet } from '../core/parser';
import { downloadBlob } from '../core/fileio';
import {
  splitByColumn,
  splitByRows,
  splitBySheet,
  splitByDerived,
  splitByGroups,
  distinctValues,
  UNMATCHED_KEY,
  type SplitPart,
  type KeyRule,
} from '../core/transform';
import { makeZip, blobToBytes, type ZipEntry } from '../core/zip';
import type { Workbook, SheetData, ExportFormat } from '../core/types';

type Mode = 'column' | 'rows' | 'sheet' | 'derived' | 'group';

// A column with thousands of distinct values makes an unusable assignment list.
// Show the commonest and let the rest fall through to the unassigned rule.
const GROUP_LIST_CAP = 300;

let wb: Workbook | null = null;
let baseName = 'data';
let sheetIdx = 0;
let mode: Mode = 'column';
let outFormat: ExportFormat = 'xlsx';
// Rebuilt by renderModeControls each time the mode, sheet or a rule changes.
let getParts: () => SplitPart[] = () => [];

export function mountSplit(root: HTMLElement): void {
  wb = null;
  mode = 'column';
  outFormat = 'xlsx';
  sheetIdx = 0;
  getParts = () => [];
  root.innerHTML = `
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

/** A labelled input, matching the shape selectField() produces for selects. */
function field(label: string, input: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, [el('span', { class: 'field-label' }, [label]), input]);
}

function renderConfig(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#config')!;
  host.innerHTML = '';
  if (!wb) return;
  const workbook = wb;

  const sheetOpts = workbook.sheets.map((s, i) => ({ value: String(i), label: `${s.name} (${s.totalRows} rows)` }));
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
      { value: 'sheet', label: 'By sheet', hint: 'one file per tab' },
      { value: 'derived', label: 'By part of a value', hint: 'cut, prefix or pattern' },
      { value: 'group', label: 'Custom grouping', hint: 'assign values to files' },
    ],
    mode,
    (v) => {
      mode = v as Mode;
      renderModeControls();
    },
  );

  const modeHost = el('div', { class: 'mode-host' });
  const estimate = el('div', { class: 'sheet-meta' });
  const goBtn = button('Split & download .zip', () => runSplit());

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

  // A rule the user is midway through typing (an unfinished regex, say) throws
  // out of getParts. Report it on the estimate line instead of on the console,
  // and keep the button live so a corrected rule needs no reload.
  const updateEstimate = () => {
    let parts: SplitPart[];
    try {
      parts = getParts();
    } catch (e) {
      estimate.textContent = `Cannot split: ${msg(e)}`;
      return;
    }
    const n = parts.length;
    const stray = parts.find((p) => p.key === UNMATCHED_KEY);
    estimate.textContent =
      `Will produce ${n} file${n === 1 ? '' : 's'}.` +
      (stray ? ` ${stray.sheet.rows.length} row(s) had no usable key — collected in ${UNMATCHED_KEY}.` : '');
  };

  const renderModeControls = () => {
    modeHost.innerHTML = '';
    // `hidden` loses to .field's display:flex, so drive display directly.
    sheetWrap.style.display = mode === 'sheet' ? 'none' : '';
    const sheet = workbook.sheets[sheetIdx];

    if (mode === 'column') {
      // Column select stays the first (and only) select here — the e2e test
      // and muscle memory both reach for `.mode-host select`.
      const { wrap, select } = selectField('Column', columnOptions(sheet), '0');
      select.addEventListener('change', updateEstimate);
      modeHost.append(wrap);
      getParts = () => splitByColumn(sheet, Number(select.value));
    } else if (mode === 'rows') {
      const input = el('input', { type: 'number', class: 'field-input', value: '1000', min: '1' });
      input.addEventListener('input', updateEstimate);
      modeHost.append(field('Rows per file', input));
      getParts = () => splitByRows(sheet, Math.max(1, Number(input.value) || 1000));
    } else if (mode === 'sheet') {
      const n = workbook.sheets.length;
      modeHost.append(
        el('div', { class: 'sheet-meta' }, [
          `Every sheet in this workbook becomes its own file — ${n} tab${n === 1 ? '' : 's'}, named after the tab.`,
        ]),
      );
      getParts = () => splitBySheet(workbook.sheets);
    } else if (mode === 'derived') {
      buildDerivedControls(sheet, modeHost, updateEstimate);
    } else {
      buildGroupControls(sheet, modeHost, updateEstimate);
    }
    updateEstimate();
  };

  renderModeControls();
}

function columnOptions(sheet: SheetData): { value: string; label: string }[] {
  return sheet.headers.map((h, i) => ({ value: String(i), label: h }));
}

/** "By part of a value": pick a column, then how to cut a key out of it. */
function buildDerivedControls(sheet: SheetData, modeHost: HTMLElement, onChange: () => void): void {
  const { wrap: colWrap, select: colSel } = selectField('Column', columnOptions(sheet), '0');
  const { wrap: ruleWrap, select: ruleSel } = selectField(
    'Key from',
    [
      { value: 'separator', label: 'Piece after a character' },
      { value: 'prefix', label: 'First N characters' },
      { value: 'pattern', label: 'Pattern (regex)' },
    ],
    'separator',
  );
  const argHost = el('div', { class: 'mode-host' });

  const sepInput = el('input', { class: 'field-input', value: '-', maxlength: '8' });
  const pieceInput = el('input', { type: 'number', class: 'field-input', value: '1', min: '1' });
  const lenInput = el('input', { type: 'number', class: 'field-input', value: '3', min: '1' });
  const patInput = el('input', { class: 'field-input', value: '^(\\w+)' });
  for (const i of [sepInput, pieceInput, lenInput, patInput]) i.addEventListener('input', onChange);

  const rule = (): KeyRule => {
    switch (ruleSel.value) {
      case 'prefix':
        return { kind: 'prefix', length: Math.max(1, Number(lenInput.value) || 1) };
      case 'pattern':
        return { kind: 'pattern', source: patInput.value };
      default:
        return { kind: 'separator', sep: sepInput.value, piece: Math.max(1, Number(pieceInput.value) || 1) };
    }
  };

  const renderArgs = () => {
    argHost.innerHTML = '';
    if (ruleSel.value === 'prefix') argHost.append(field('How many characters', lenInput));
    else if (ruleSel.value === 'pattern') argHost.append(field('Pattern', patInput));
    else argHost.append(field('Split on', sepInput), field('Keep piece', pieceInput));
    onChange();
  };
  ruleSel.addEventListener('change', renderArgs);
  colSel.addEventListener('change', onChange);

  modeHost.append(colWrap, ruleWrap, argHost);
  renderArgs();
  getParts = () => splitByDerived(sheet, Number(colSel.value), rule());
}

/** "Custom grouping": name the file each distinct value should land in. */
function buildGroupControls(sheet: SheetData, modeHost: HTMLElement, onChange: () => void): void {
  const { wrap: colWrap, select: colSel } = selectField('Column', columnOptions(sheet), '0');
  const { wrap: restWrap, select: restSel } = selectField(
    'Unassigned values',
    [
      { value: 'own', label: 'Each gets its own file' },
      { value: 'other', label: 'Collect into (other)' },
    ],
    'own',
  );
  const listHost = el('div', { class: 'keys-host' });
  const inputs = new Map<string, HTMLInputElement>();

  const rebuild = () => {
    inputs.clear();
    listHost.innerHTML = '';
    const values = distinctValues(sheet, Number(colSel.value));
    const shown = values.slice(0, GROUP_LIST_CAP);
    const list = el('div', { class: 'checkbox-list' });
    for (const { value, count } of shown) {
      const input = el('input', { class: 'field-input', placeholder: 'own file' });
      input.addEventListener('input', onChange);
      inputs.set(value, input);
      list.append(
        el('div', { class: 'group-row' }, [
          el('span', { class: 'group-value', title: value }, [value]),
          el('span', { class: 'group-count' }, [`${count}`]),
          input,
        ]),
      );
    }
    listHost.append(el('span', { class: 'field-label' }, ['Send value to file']), list);
    if (values.length > shown.length) {
      listHost.append(
        el('div', { class: 'sheet-meta' }, [
          `Showing the ${shown.length} commonest of ${values.length} values — the rest follow the rule on the left.`,
        ]),
      );
    }
    onChange();
  };

  colSel.addEventListener('change', rebuild);
  restSel.addEventListener('change', onChange);
  modeHost.append(colWrap, restWrap, listHost);
  rebuild();

  getParts = () => {
    const assign = new Map<string, string>();
    for (const [value, input] of inputs) {
      const name = input.value.trim();
      if (name) assign.set(value, name);
    }
    return splitByGroups(sheet, Number(colSel.value), assign, restSel.value as 'own' | 'other');
  };
}

async function runSplit(): Promise<void> {
  let parts: SplitPart[];
  try {
    parts = getParts();
  } catch (e) {
    toast(`Cannot split: ${msg(e)}`, 'error', 8000);
    return;
  }
  if (!parts.length) {
    toast('Nothing to split.', 'warning');
    return;
  }
  if (parts.length > 500 && !confirm(`This will create ${parts.length} files. Continue?`)) return;

  try {
    const entries: ZipEntry[] = [];
    const used = new Set<string>();
    for (const part of parts) {
      const { blob, ext } = await serializeSheet(part.sheet, outFormat);
      entries.push({ name: `${uniqueName(safe(part.key), ext, used)}`, data: await blobToBytes(blob) });
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

/**
 * Distinct keys can sanitise to the same file name ("A/B" and "A|B" both become
 * "A_B"), and a zip with two identical entries loses one. Suffix the repeats.
 */
function uniqueName(base: string, ext: string, used: Set<string>): string {
  let name = `${base}.${ext}`;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}.${ext}`;
  used.add(name);
  return name;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
