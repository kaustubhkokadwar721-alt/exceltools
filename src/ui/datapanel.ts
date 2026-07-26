// What is in the file you just opened, rendered for the shell's data panel.
//
// Every tool used to answer "what have I got?" differently — a filename bar
// here, a schema rail there, nothing at all in most. This is the one answer:
// the file, its sheets, and each column with its kind, blanks and distinct
// values, so the question can be settled without running anything.
import { el } from './controls';
import { profileColumn, describeColumn } from '../core/schema';
import type { SheetData } from '../core/types';

export interface SheetPanelOptions {
  fileName: string;
  sheets: SheetData[];
  /** Index of the sheet currently being worked on. */
  activeIndex: number;
  /** Called when another sheet is chosen. Omit to render the list read-only. */
  onPick?: (index: number) => void;
}

/** Render a workbook's sheets and columns into `host` (which it clears). */
export function renderSheetPanel(host: HTMLElement, opts: SheetPanelOptions): void {
  host.innerHTML = '';
  const wrap = el('div', { class: 'schema-detail' });

  opts.sheets.forEach((sheet, i) => {
    const active = i === opts.activeIndex;
    const summary = el('summary', {}, [
      el('span', { class: 'schema-name' }, [sheet.name]),
      el('span', { class: 'schema-meta' }, [` — ${sheet.totalRows.toLocaleString()} rows`]),
    ]);
    if (opts.onPick && !active) {
      summary.addEventListener('click', (e) => {
        // Picking the sheet is the point of the row; expanding it is not.
        e.preventDefault();
        opts.onPick!(i);
      });
    }
    const cols = el(
      'div',
      { class: 'schema-cols-list' },
      sheet.headers.map((h, ci) => {
        const p = profileColumn(sheet, ci);
        return el('div', { class: 'schema-col', 'data-name': h.toLowerCase() }, [
          el('span', { class: 'schema-col-name' }, [h]),
          el('span', { class: `schema-col-type${p.blanks > 0 ? ' has-blanks' : ''}` }, [describeColumn(p)]),
        ]);
      }),
    );
    const block = el('details', { class: `schema-block${active ? ' is-active' : ''}` }, [summary, cols]);
    if (active) (block as HTMLDetailsElement).open = true;
    wrap.append(block);
  });

  host.append(el('div', { class: 'panel-file' }, [opts.fileName]), wrap);
}
