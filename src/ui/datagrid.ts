// Virtualized table for previewing sheet data. Only renders the rows currently
// in view, so a 100k-row preview stays smooth. Columns auto-fit their header +
// sampled content, have a visible drag handle for manual resizing (min 40px,
// no upper cap), double-click a handle to autofit the full loaded column, and
// user widths persist for the session per column-set so re-renders keep them.
// Shared by every tool that shows tabular results.
import type { SheetData, CellValue } from '../core/types';

const ROW_HEIGHT = 28; // px, must match CSS .grid-row height
const OVERSCAN = 6; // rows rendered beyond the viewport on each side
const MIN_W = 40;
const MAX_AUTO_W = 340; // initial auto-fit cap; drag/dblclick can exceed
const MAX_FIT_W = 600; // dblclick full-content autofit cap
const CHAR_PX = 7.8; // approx px per character at 14.5px body font
const SAMPLE = 50; // rows sampled for the initial auto-fit

// Session-scoped width memory: same column set → same widths across re-renders
// (e.g. re-running a query or notebook cell). Nothing is persisted to storage.
const savedWidths = new Map<string, number[]>();

export function createDataGrid(sheet: SheetData): HTMLElement {
  const container = document.createElement('div');
  container.className = 'grid';

  const sig = sheet.headers.join('');
  const fitWidth = (ci: number, rowLimit: number, cap: number): number => {
    // Headers render uppercase with letter-spacing → ~35% wider than body text.
    let chars = Math.ceil(String(sheet.headers[ci]).length * 1.35) + 2;
    const n = Math.min(sheet.rows.length, rowLimit);
    for (let r = 0; r < n; r++) {
      const v = sheet.rows[r][ci];
      if (v !== null && v !== undefined) chars = Math.max(chars, String(v).length);
    }
    return Math.min(cap, Math.max(MIN_W, Math.round(chars * CHAR_PX) + 26));
  };

  const remembered = savedWidths.get(sig);
  const widths =
    remembered && remembered.length === sheet.headers.length
      ? [...remembered]
      : sheet.headers.map((_, ci) => fitWidth(ci, SAMPLE, MAX_AUTO_W));

  const remember = () => savedWidths.set(sig, [...widths]);
  const template = () => `48px ${widths.map((w) => `${w}px`).join(' ')}`;

  // Header (sticky, outside the scroll virtualization) with resize handles.
  const header = document.createElement('div');
  header.className = 'grid-header';
  header.innerHTML =
    `<div class="grid-cell grid-rownum">#</div>` +
    sheet.headers
      .map(
        (h, i) =>
          `<div class="grid-cell" title="${escapeHtml(h)}">${escapeHtml(h)}<span class="grid-resize" data-col="${i}" title="Drag to resize · double-click to fit"><span class="grid-resize-bar"></span></span></div>`,
      )
      .join('');
  container.appendChild(header);

  // Scroll viewport
  const viewport = document.createElement('div');
  viewport.className = 'grid-viewport';
  const spacer = document.createElement('div');
  spacer.className = 'grid-spacer';
  spacer.style.height = `${sheet.rows.length * ROW_HEIGHT}px`;
  const pool = document.createElement('div');
  pool.className = 'grid-pool';
  spacer.appendChild(pool);
  viewport.appendChild(spacer);
  container.appendChild(viewport);

  const applyTemplate = () => {
    const t = template();
    const total = 48 + widths.reduce((a, b) => a + b, 0);
    header.style.gridTemplateColumns = t;
    header.style.minWidth = `${total}px`;
    spacer.style.minWidth = `${total}px`;
    pool.querySelectorAll<HTMLElement>('.grid-row').forEach((r) => (r.style.gridTemplateColumns = t));
  };

  const render = () => {
    const scrollTop = viewport.scrollTop;
    const viewH = viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(sheet.rows.length, Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + OVERSCAN);
    const t = template();

    let html = '';
    for (let i = first; i < last; i++) {
      html +=
        `<div class="grid-row" style="top:${i * ROW_HEIGHT}px;grid-template-columns:${t}">` +
        `<div class="grid-cell grid-rownum">${i + 1}</div>` +
        sheet.rows[i].map((c) => `<div class="grid-cell">${fmt(c)}</div>`).join('') +
        `</div>`;
    }
    pool.innerHTML = html;
  };

  // Keep the header horizontally in sync with the body scroll.
  viewport.addEventListener(
    'scroll',
    () => {
      header.style.transform = `translateX(${-viewport.scrollLeft}px)`;
      render();
    },
    { passive: true },
  );

  // Drag-to-resize + double-click autofit on header handles.
  header.addEventListener('pointerdown', (e) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.grid-resize');
    if (!handle) return;
    e.preventDefault();
    const col = Number(handle.dataset.col);
    const startX = e.clientX;
    const startW = widths[col];
    handle.classList.add('dragging');
    const onMove = (ev: PointerEvent) => {
      widths[col] = Math.max(MIN_W, startW + (ev.clientX - startX));
      applyTemplate();
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      remember();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  header.addEventListener('dblclick', (e) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.grid-resize');
    if (!handle) return;
    const col = Number(handle.dataset.col);
    widths[col] = fitWidth(col, sheet.rows.length, MAX_FIT_W);
    remember();
    applyTemplate();
  });

  requestAnimationFrame(() => {
    applyTemplate();
    render();
  });
  new ResizeObserver(render).observe(viewport);

  return container;
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
