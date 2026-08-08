// PDF tables: pull the tables out of one or more PDFs and write them to Excel
// or CSV, either stacked into one sheet or kept separate.
//
// The two modes mirror Merge, because the job is the same one: a batch of
// same-format documents (a year of bank statements, a folder of ERP prints)
// either belongs in one table or in one workbook of tabs.
//
// Every table found is listed with its page and shape before anything is
// written, and each is individually excludable. That listing is the point — a
// PDF's structure is inferred, not declared, so the output is only trustworthy
// if you can see what was found and where it came from before you accept it.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { el, button, selectField, radioGroup } from '../ui/controls';
import { serializeSheet, serializeWorkbook } from '../core/parser';
import { downloadBlob } from '../core/fileio';
import { makeZip, blobToBytes, type ZipEntry } from '../core/zip';
import { uniqueSheetName } from '../core/serialize';
import { mergeStack, type NamedSheet } from '../core/transform';
import { PDF_EXTENSIONS } from '../core/validation';
import { readPdf, PdfPasswordRequired, PdfUnsupportedBrowser } from '../core/pdfextract';
import { extractTables, scannedPages, tableLabel, toSheet, type PdfPage, type PdfTable } from '../core/pdftable';
import type { ExportFormat, SheetData } from '../core/types';

const PREVIEW_ROWS = 2000;

const STACK_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'xlsx', label: 'Excel (.xlsx)' },
  { value: 'csv', label: 'CSV (.csv)' },
  { value: 'json', label: 'JSON (.json)' },
  { value: 'md', label: 'Markdown (.md)' },
];

interface LoadedPdf {
  name: string;
  /** Kept so the tables can be rebuilt when a reading option changes — the
   *  geometry pass is cheap, and re-reading the PDF is not. */
  pages: PdfPage[];
  scanned: number[];
  /** Excluded tables, keyed by `page:index`. */
  dropped: Set<string>;
}

interface Found {
  file: LoadedPdf;
  table: PdfTable;
  label: string;
  key: string;
}

let loaded: LoadedPdf[] = [];
let mode: 'stack' | 'sheets' = 'stack';
let addSource = true;
let joinWrapped = true;
let convertNumbers = true;
let busy = false;
/** Set when the browser cannot run pdf.js at all. Kept on screen rather than
 *  toasted away, because it is a standing fact about this machine. */
let unsupported: string | null = null;

export function mountPdf(root: HTMLElement): void {
  loaded = [];
  mode = 'stack';
  addSource = true;
  joinWrapped = true;
  convertNumbers = true;
  busy = false;
  unsupported = null;
  root.innerHTML = `
    <div class="tool-body">
      <div id="dz"></div>
      <div id="status"></div>
      <div id="found"></div>
      <div id="options"></div>
      <div id="preview"></div>
    </div>`;

  root.querySelector('#dz')!.append(
    createDropzone({
      multiple: true,
      extensions: PDF_EXTENSIONS,
      onError: (m) => toast(m, 'error'),
      onWarning: (m) => toast(m, 'warning', 7000),
      onFiles: (files) => addFiles(root, files),
    }),
  );
  render(root);
}

// ---- Loading ---------------------------------------------------------------

async function addFiles(root: HTMLElement, files: File[]): Promise<void> {
  if (busy) return;
  busy = true;
  const status = root.querySelector<HTMLElement>('#status')!;

  try {
    for (const file of files) {
      try {
        const pages = await readWithPassword(file, (done, total) => {
          status.textContent = `Reading ${file.name} — page ${done} of ${total}…`;
        });
        if (!pages) continue; // cancelled at the password prompt
        loaded.push({ name: file.name, pages, scanned: scannedPages(pages), dropped: new Set() });
      } catch (e) {
        // Too old a browser is not this file's fault, and the next file would
        // fail identically. Say it once, keep it on screen, and stop reading.
        if (e instanceof PdfUnsupportedBrowser) {
          unsupported = e.message;
          break;
        }
        toast(`Could not read "${file.name}": ${msg(e)}`, 'error', 8000);
      }
    }
  } finally {
    // A throw must not leave the tool wedged with `busy` set and the progress
    // line still on screen — every later drop would be ignored in silence.
    status.textContent = '';
    busy = false;
  }
  render(root);
}

/**
 * Read a PDF, asking for a password if it turns out to be encrypted. Bank
 * statements arrive locked as a matter of course, so this is the normal path
 * rather than an error case. The password is used for this read and never
 * stored.
 */
async function readWithPassword(
  file: File,
  onProgress: (done: number, total: number) => void,
): Promise<PdfPage[] | null> {
  let password: string | undefined;
  for (;;) {
    try {
      return await readPdf(file, { password, onProgress });
    } catch (e) {
      if (!(e instanceof PdfPasswordRequired)) throw e;
      const entered = prompt(`${e.message}\n\nPassword for "${file.name}":`);
      if (entered === null) return null;
      password = entered;
    }
  }
}

// ---- Derived state ---------------------------------------------------------

function foundIn(file: LoadedPdf): Found[] {
  const tables = extractTables(file.pages, { joinWrappedRows: joinWrapped, convertNumbers });
  const perPage = new Map<number, number>();
  for (const t of tables) perPage.set(t.page, (perPage.get(t.page) ?? 0) + 1);
  const base = file.name.replace(/\.[^.]+$/, '');
  return tables.map((table) => {
    const label = tableLabel(table, perPage.get(table.page) ?? 1);
    return { file, table, label: `${base} ${label}`, key: `${table.page}:${table.index}` };
  });
}

/** Every table across every file, in the order they were added. */
function allFound(): Found[] {
  return loaded.flatMap(foundIn);
}

function selected(): Found[] {
  return allFound().filter((f) => !f.file.dropped.has(f.key));
}

function render(root: HTMLElement): void {
  // With tables on screen the drop target is no longer the thing being looked
  // at, and at laptop height it would otherwise push the preview off the fold.
  root.querySelector('.dropzone')?.classList.toggle('compact', loaded.length > 0);
  renderFound(root);
  renderOptions(root);
  renderPreview(root);
}

// ---- The found-tables list -------------------------------------------------

function renderFound(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#found')!;
  host.innerHTML = '';
  if (unsupported) host.append(el('div', { class: 'tool-notice' }, [unsupported]));
  if (!loaded.length) return;

  const found = allFound();
  const on = found.filter((f) => !f.file.dropped.has(f.key)).length;
  host.append(
    el('div', { class: 'file-list-head' }, [
      `${found.length} table(s) found in ${loaded.length} PDF(s) — ${on} selected`,
    ]),
  );

  for (const file of loaded) {
    const rows = foundIn(file);
    const list = el('div', { class: 'file-list' });

    for (const f of rows) {
      const tick = el('input', { type: 'checkbox' });
      tick.checked = !file.dropped.has(f.key);
      tick.addEventListener('change', () => {
        if (tick.checked) file.dropped.delete(f.key);
        else file.dropped.add(f.key);
        render(root);
      });
      list.append(
        el('div', { class: 'file-row' }, [
          el('label', { class: 'checkbox' }, [
            tick,
            el('span', { class: 'file-name' }, [`Page ${f.table.page}${f.table.index > 1 ? ` · table ${f.table.index}` : ''}`]),
          ]),
          el('span', { class: 'file-meta' }, [
            `${f.table.headers.length} cols · ${f.table.totalRows} rows · ${f.table.headers.slice(0, 3).join(', ')}${f.table.headers.length > 3 ? '…' : ''}`,
          ]),
        ]),
      );
    }

    if (!rows.length) {
      list.append(el('div', { class: 'file-row' }, [
        el('span', { class: 'file-meta' }, ['No tables found — the pages hold no aligned columns.']),
      ]));
    }

    const remove = button('✕', () => {
      loaded = loaded.filter((l) => l !== file);
      render(root);
    }, 'btn-x');

    host.append(
      el('div', { class: 'options-panel' }, [
        el('div', { class: 'workbook-bar' }, [
          el('span', { class: 'wb-name' }, [`${file.name} · ${file.pages.length} page(s)`]),
          remove,
        ]),
        ...(file.scanned.length
          ? [el('div', { class: 'sheet-meta' }, [
              `Page${file.scanned.length === 1 ? '' : 's'} ${file.scanned.join(', ')} ${file.scanned.length === 1 ? 'has' : 'have'} no text layer — ` +
                'scanned image, skipped. Reading it would mean guessing at every digit.',
            ])]
          : []),
        list,
      ]),
    );
  }
}

// ---- Options ---------------------------------------------------------------

function renderOptions(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#options')!;
  host.innerHTML = '';
  if (!loaded.length) return;

  const modeCtrl = radioGroup(
    'pdf-mode',
    [
      { value: 'stack', label: 'Merge', hint: 'stack every table into one sheet, aligned by column name' },
      { value: 'sheets', label: 'Separate', hint: 'one sheet or file per table' },
    ],
    mode,
    (v) => {
      mode = v as typeof mode;
      render(root);
    },
  );

  const reading = el('div', { class: 'config-bar' }, [
    toggle('Join wrapped rows', joinWrapped, (v) => {
      joinWrapped = v;
      render(root);
    }, 'a line that starts with an empty first column continues the row above it'),
    toggle('Convert numbers', convertNumbers, (v) => {
      convertNumbers = v;
      render(root);
    }, 'figures written as text become real numbers; anything ambiguous is left alone'),
  ]);

  const controls = el('div', { class: 'config-bar' }, []);
  let getFormat: () => ExportFormat = () => 'xlsx';

  if (mode === 'stack') {
    const { wrap, select } = selectField('Output format', STACK_FORMATS, 'xlsx');
    getFormat = () => select.value as ExportFormat;
    controls.append(
      wrap,
      toggle('Add Source column', addSource, (v) => {
        addSource = v;
        renderPreview(root);
      }, 'records the file and page each row came from'),
    );
  } else {
    const { wrap, select } = selectField(
      'Each table as',
      [{ value: 'xlsx', label: 'Sheets in one Excel file' }, { value: 'csv', label: 'CSV files in a .zip' }],
      'xlsx',
    );
    getFormat = () => select.value as ExportFormat;
    controls.append(wrap);
  }

  controls.append(button('Extract & download', () => runExtract(getFormat())));
  host.append(el('div', { class: 'options-panel' }, [modeCtrl, reading, controls]));
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  const parts: (HTMLElement | string)[] = [input, el('span', {}, [label])];
  if (hint) parts.push(el('span', { class: 'radio-hint' }, [hint]));
  return el('label', { class: 'checkbox' }, parts);
}

// ---- Preview ---------------------------------------------------------------

function renderPreview(root: HTMLElement): void {
  const host = root.querySelector<HTMLElement>('#preview')!;
  host.innerHTML = '';
  const picked = selected();
  if (!picked.length) return;

  if (mode === 'stack') {
    const merged = mergeStack(asNamed(picked), addSource);
    host.append(el('div', { class: 'sheet-meta' }, [
      `Preview — ${merged.headers.length} columns · ${merged.totalRows.toLocaleString()} rows` +
        (merged.totalRows > PREVIEW_ROWS ? ` (showing first ${PREVIEW_ROWS.toLocaleString()})` : ''),
    ]));
    host.append(createDataGrid(limit(merged)));
  } else {
    host.append(el('div', { class: 'sheet-meta' }, [`Will produce ${picked.length} table(s).`]));
    host.append(createDataGrid(limit(toSheet(picked[0].table, picked[0].label))));
  }
}

function asNamed(found: Found[]): NamedSheet[] {
  return found.map((f) => ({ source: f.label, sheet: toSheet(f.table, f.label) }));
}

// ---- Output ----------------------------------------------------------------

async function runExtract(format: ExportFormat): Promise<void> {
  const picked = selected();
  if (!picked.length) {
    toast('No tables selected.', 'warning');
    return;
  }

  try {
    if (mode === 'stack') {
      const merged = mergeStack(asNamed(picked), addSource);
      const { blob, ext } = await serializeSheet(merged, format);
      downloadBlob(blob, `pdf_tables.${ext}`);
      toast(`${picked.length} table(s) → pdf_tables.${ext}`, 'success', 3500);
      return;
    }

    if (format === 'csv') {
      const entries: ZipEntry[] = [];
      const used = new Set<string>();
      for (const f of picked) {
        const name = uniqueSheetName(f.label, used);
        const { blob, ext } = await serializeSheet(toSheet(f.table, name), 'csv');
        entries.push({ name: `${safe(name)}.${ext}`, data: await blobToBytes(blob) });
      }
      downloadBlob(makeZip(entries), 'pdf_tables.zip');
      toast(`${entries.length} table(s) → pdf_tables.zip`, 'success', 3500);
      return;
    }

    const used = new Set<string>();
    const sheets: SheetData[] = picked.map((f) => toSheet(f.table, uniqueSheetName(f.label, used)));
    const { blob, ext } = await serializeWorkbook(sheets);
    downloadBlob(blob, `pdf_tables.${ext}`);
    toast(`${sheets.length} table(s) → pdf_tables.${ext}`, 'success', 3500);
  } catch (e) {
    toast(`Extract failed: ${msg(e)}`, 'error', 8000);
  }
}

function safe(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'table';
}

function limit(sheet: SheetData): SheetData {
  return sheet.rows.length > PREVIEW_ROWS ? { ...sheet, rows: sheet.rows.slice(0, PREVIEW_ROWS) } : sheet;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
