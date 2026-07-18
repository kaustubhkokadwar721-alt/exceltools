// Reference tool (Phase 1). It proves the whole light-tier stack end to end:
// dropzone → validation → off-thread parse → sheet tabs → virtualized grid.
// Phase 2 tools follow this same shape.
import { createDropzone } from '../ui/dropzone';
import { createDataGrid } from '../ui/datagrid';
import { toast } from '../ui/toast';
import { attachHelp } from '../ui/help';
import { parseFile } from '../core/parser';
import { formatBytes } from '../core/validation';
import type { Workbook } from '../core/types';

// Cap preview rows so opening a huge file stays instant. Full-file tools in
// later phases will stream; the viewer only needs a representative preview.
const PREVIEW_ROWS = 5000;

export function mountViewer(root: HTMLElement): void {
  root.innerHTML = `
    <div class="tool-head">
      <h2>Viewer</h2>
      <p class="tool-blurb">Open and browse any spreadsheet — locally, no upload.</p>
    </div>
    <div class="tool-body" id="viewer-body"></div>`;

  const body = root.querySelector<HTMLElement>('#viewer-body')!;
  showDropzone(body);
  attachHelp(root, 'viewer');
}

function showDropzone(body: HTMLElement): void {
  body.innerHTML = '';
  const dz = createDropzone({
    onError: (m) => toast(m, 'error'),
    onWarning: (m) => toast(m, 'warning', 7000),
    onFiles: async (files) => {
      const file = files[0];
      body.innerHTML = `<div class="loading">Parsing <strong>${file.name}</strong>…</div>`;
      try {
        const wb = await parseFile(file, PREVIEW_ROWS);
        renderWorkbook(body, wb);
      } catch (e) {
        toast(`Could not parse "${file.name}": ${e instanceof Error ? e.message : e}`, 'error', 8000);
        showDropzone(body);
      }
    },
  });
  body.appendChild(dz);
}

function renderWorkbook(body: HTMLElement, wb: Workbook): void {
  body.innerHTML = '';

  const bar = document.createElement('div');
  bar.className = 'workbook-bar';
  bar.innerHTML =
    `<span class="wb-name">${wb.fileName}</span>` +
    `<span class="wb-meta">${formatBytes(wb.fileSize)} · ${wb.sheets.length} sheet${wb.sheets.length === 1 ? '' : 's'}</span>`;
  const reset = document.createElement('button');
  reset.className = 'btn-ghost';
  reset.textContent = 'Open another';
  reset.addEventListener('click', () => showDropzone(body));
  bar.appendChild(reset);
  body.appendChild(bar);

  // Sheet tabs
  const tabs = document.createElement('div');
  tabs.className = 'sheet-tabs';
  const gridHost = document.createElement('div');
  gridHost.className = 'grid-host';

  const select = (idx: number) => {
    tabs.querySelectorAll('.sheet-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
    const sheet = wb.sheets[idx];
    gridHost.innerHTML = '';
    if (!sheet.rows.length) {
      gridHost.innerHTML = `<div class="empty">Sheet "${sheet.name}" has no data rows.</div>`;
      return;
    }
    const meta = document.createElement('div');
    meta.className = 'sheet-meta';
    const shown = Math.min(sheet.rows.length, sheet.totalRows);
    meta.textContent =
      `${sheet.headers.length} columns · ${sheet.totalRows.toLocaleString()} rows` +
      (sheet.totalRows > shown ? ` (previewing first ${shown.toLocaleString()})` : '');
    gridHost.appendChild(meta);
    gridHost.appendChild(createDataGrid(sheet));
  };

  wb.sheets.forEach((sheet, i) => {
    const tab = document.createElement('button');
    tab.className = 'sheet-tab';
    tab.textContent = sheet.name;
    tab.addEventListener('click', () => select(i));
    tabs.appendChild(tab);
  });

  body.appendChild(tabs);
  body.appendChild(gridHost);
  select(0);
  toast(`Opened "${wb.fileName}"`, 'success', 3000);
}
