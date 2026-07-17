// Virtualized table for previewing sheet data. Only renders the rows currently
// in view, so a 100k-row preview stays smooth. Shared by every tool that shows
// tabular results.
import type { SheetData, CellValue } from '../core/types';

const ROW_HEIGHT = 28; // px, must match CSS .grid-row height
const OVERSCAN = 6; // rows rendered beyond the viewport on each side

export function createDataGrid(sheet: SheetData): HTMLElement {
  const container = document.createElement('div');
  container.className = 'grid';

  // Header (sticky, outside the scroll virtualization)
  const header = document.createElement('div');
  header.className = 'grid-header';
  header.style.gridTemplateColumns = colTemplate(sheet.headers.length);
  header.innerHTML =
    `<div class="grid-cell grid-rownum">#</div>` +
    sheet.headers.map((h) => `<div class="grid-cell">${escapeHtml(h)}</div>`).join('');
  container.appendChild(header);

  // Scroll viewport
  const viewport = document.createElement('div');
  viewport.className = 'grid-viewport';

  // Spacer sets the full scroll height; rows are absolutely positioned within.
  const spacer = document.createElement('div');
  spacer.className = 'grid-spacer';
  spacer.style.height = `${sheet.rows.length * ROW_HEIGHT}px`;

  const pool = document.createElement('div');
  pool.className = 'grid-pool';
  spacer.appendChild(pool);
  viewport.appendChild(spacer);
  container.appendChild(viewport);

  const template = colTemplate(sheet.headers.length);

  const render = () => {
    const scrollTop = viewport.scrollTop;
    const viewH = viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(sheet.rows.length, Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + OVERSCAN);

    let html = '';
    for (let i = first; i < last; i++) {
      html +=
        `<div class="grid-row" style="top:${i * ROW_HEIGHT}px;grid-template-columns:${template}">` +
        `<div class="grid-cell grid-rownum">${i + 1}</div>` +
        sheet.rows[i].map((c) => `<div class="grid-cell">${fmt(c)}</div>`).join('') +
        `</div>`;
    }
    pool.innerHTML = html;
  };

  viewport.addEventListener('scroll', render, { passive: true });
  // Render once mounted (clientHeight needs layout); also re-render on resize.
  requestAnimationFrame(render);
  new ResizeObserver(render).observe(viewport);

  return container;
}

function colTemplate(n: number): string {
  // Fixed row-number column + n data columns with a sane min width.
  return `48px repeat(${n}, minmax(90px, 1fr))`;
}

function fmt(c: CellValue): string {
  if (c === null || c === undefined) return '';
  return escapeHtml(String(c));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
