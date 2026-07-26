// Virtualized table for previewing sheet data. Only renders the rows currently
// in view, so a 100k-row preview stays smooth. Columns auto-fit their header +
// sampled content, have a visible drag handle for manual resizing (min 40px,
// no upper cap), double-click a handle to autofit the full loaded column, and
// user widths persist for the session per column-set so re-renders keep them.
// Shared by every tool that shows tabular results.
import { escapeHtml } from './controls';
import type { SheetData, CellValue } from '../core/types';

const ROW_HEIGHT = 28; // px, must match CSS .grid-row height
const OVERSCAN = 6; // rows rendered beyond the viewport on each side
const MIN_W = 40;
const MAX_AUTO_W = 340; // initial auto-fit cap; drag/dblclick can exceed
const MAX_FIT_W = 600; // dblclick full-content autofit cap
const CHAR_PX = 7.8; // approx px per character at 14.5px body font
const NUM_CHAR_PX = 9.1; // tabular figures are wider than the proportional average
const SAMPLE = 50; // rows sampled for the initial auto-fit

// Session-scoped width memory: same column set → same widths across re-renders
// (e.g. re-running a query or notebook cell). Nothing is persisted to storage.
const savedWidths = new Map<string, number[]>();

export interface DataGridOptions {
  /**
   * Group digits and right-align numeric columns. Finance data is read as
   * columns of figures — `1643552` left-aligned is not readable, and
   * misaligned digits hide an order-of-magnitude error. Off by default so the
   * conversion previews keep showing values exactly as stored; the notebook's
   * result grids turn it on. Display only — exports use the raw values.
   */
  formatNumbers?: boolean;
  /**
   * Click a column header to sort, click again to reverse, a third time to go
   * back to the original order. Everyone who has used a spreadsheet expects
   * this of a table of results. Display only, and off by default so a
   * conversion preview keeps showing the file in its own order.
   */
  sortable?: boolean;
}

const isBlank = (v: CellValue): boolean => v === null || v === undefined || v === '';

/** Spreadsheet-ish ordering: numbers numerically, text naturally, blanks last. */
export function compareValues(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  // `numeric` keeps "Item 2" before "Item 10", which is what people expect.
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function createDataGrid(sheet: SheetData, opts: DataGridOptions = {}): HTMLElement {
  const container = document.createElement('div');
  container.className = 'grid';

  // A column counts as numeric only if every value in it is a number, so a
  // reference column with the odd "N/A" is left alone.
  const numericCols = sheet.headers.map((_, ci) => {
    let seen = false;
    for (let r = 0; r < Math.min(sheet.rows.length, SAMPLE); r++) {
      const v = sheet.rows[r][ci];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v !== 'number') return false;
      seen = true;
    }
    return seen;
  });
  const isNumeric = (ci: number): boolean => !!opts.formatNumbers && numericCols[ci];

  // An escape, not a raw control byte, so the separator stays visible in review.
  const sig = sheet.headers.join('\u0001');
  const fitWidth = (ci: number, rowLimit: number, cap: number): number => {
    // Headers render uppercase with letter-spacing → ~35% wider than body text.
    let chars = Math.ceil(String(sheet.headers[ci]).length * 1.35) + 2;
    const n = Math.min(sheet.rows.length, rowLimit);
    for (let r = 0; r < n; r++) {
      const v = sheet.rows[r][ci];
      // Measure what is actually drawn: a grouped figure is wider than its raw
      // value, and sizing to the raw value truncates it to "16,435,…".
      if (v !== null && v !== undefined) {
        chars = Math.max(chars, (isNumeric(ci) && typeof v === 'number' ? groupDigits(v) : String(v)).length);
      }
    }
    // Formatted figures render with tabular-nums, whose digits are wider than
    // the proportional average CHAR_PX assumes — measure them at their own rate
    // or the column clips the very numbers the grouping exists to make legible.
    return Math.min(cap, Math.max(MIN_W, Math.round(chars * (isNumeric(ci) ? NUM_CHAR_PX : CHAR_PX)) + 26));
  };

  const remembered = savedWidths.get(sig);
  const widths =
    remembered && remembered.length === sheet.headers.length
      ? [...remembered]
      : sheet.headers.map((_, ci) => fitWidth(ci, SAMPLE, MAX_AUTO_W));

  const remember = () => savedWidths.set(sig, [...widths]);
  const template = () => `48px ${widths.map((w) => `${w}px`).join(' ')}`;

  // Sort order as a list of indices into sheet.rows; null means "as loaded".
  let order: number[] | null = null;
  let sortCol = -1;
  let sortDir: 1 | -1 = 1;
  const rowAt = (i: number): CellValue[] => sheet.rows[order ? order[i] : i];

  // Header (sticky, outside the scroll virtualization) with resize handles.
  const header = document.createElement('div');
  header.className = 'grid-header';
  const paintHeader = () => {
    header.innerHTML =
      `<div class="grid-cell grid-rownum">#</div>` +
      sheet.headers
        .map((h, i) => {
          const active = opts.sortable && sortCol === i;
          const arrow = active ? `<span class="grid-sort" aria-hidden="true">${sortDir === 1 ? '▲' : '▼'}</span>` : '';
          const hint = opts.sortable ? ' · click to sort' : '';
          const aria = active ? ` aria-sort="${sortDir === 1 ? 'ascending' : 'descending'}"` : '';
          return (
            `<div class="grid-cell${opts.sortable ? ' is-sortable' : ''}${active ? ' is-sorted' : ''}" data-col="${i}"` +
            ` title="${escapeHtml(h)}${hint}"${aria}>${escapeHtml(h)}${arrow}` +
            `<span class="grid-resize" data-col="${i}" title="Drag to resize · double-click to fit"><span class="grid-resize-bar"></span></span></div>`
          );
        })
        .join('');
  };
  paintHeader();
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
        rowAt(i)
          .map((c, ci) => `<div class="grid-cell${isNumeric(ci) ? ' grid-num' : ''}">${fmt(c, isNumeric(ci))}</div>`)
          .join('') +
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

  // Click a header to sort: ascending → descending → back to the original
  // order. Clicks on the resize handle are the other gesture and never sort.
  if (opts.sortable) {
    header.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.grid-resize')) return;
      const cell = target.closest<HTMLElement>('.grid-cell[data-col]');
      if (!cell) return;
      const col = Number(cell.dataset.col);

      if (sortCol !== col) {
        sortCol = col;
        sortDir = 1;
      } else if (sortDir === 1) {
        sortDir = -1;
      } else {
        sortCol = -1;
      }

      if (sortCol === -1) {
        order = null;
      } else {
        order = sheet.rows.map((_, i) => i).sort((ia, ib) => {
          const a = sheet.rows[ia][col];
          const b = sheet.rows[ib][col];
          const aBlank = isBlank(a);
          const bBlank = isBlank(b);
          // Blanks sink to the bottom whichever way the column is sorted —
          // they are missing data, not the smallest value.
          if (aBlank || bBlank) return aBlank && bBlank ? ia - ib : aBlank ? 1 : -1;
          const c = compareValues(a, b);
          return c !== 0 ? c * sortDir : ia - ib; // stable: ties keep file order
        });
      }
      paintHeader();
      applyTemplate();
      viewport.scrollTop = 0;
      render();
    });
  }

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

/**
 * Digit grouping in the viewer's own locale — an Indian browser gets
 * 16,43,552 and a US one 1,643,552. Built from the number's own string form so
 * no precision is invented or lost; only the integer part is grouped.
 */
export function groupDigits(n: number): string {
  const s = String(n);
  const m = s.match(/^(-?)(\d+)(\.\d+)?$/);
  if (!m) return s; // exponent form, Infinity, NaN — leave exactly as-is
  const grouped = new Intl.NumberFormat(undefined, { useGrouping: true }).format(Number(m[2]));
  return m[1] + grouped + (m[3] ?? '');
}

function fmt(c: CellValue, numeric = false): string {
  if (c === null || c === undefined) return '';
  if (numeric && typeof c === 'number' && Number.isFinite(c)) return escapeHtml(groupDigits(c));
  return escapeHtml(String(c));
}

