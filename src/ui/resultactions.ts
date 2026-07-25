// Getting a result back out.
//
// The people using this tool live in Excel. A result they can see but can't
// take anywhere is a dead end — they will retype it, and retyping is where
// errors come from. Every table result therefore offers: Copy (tab-separated,
// which pastes straight into a spreadsheet as cells), CSV, and XLSX. Charts
// offer the PNG. All local: the same worker that parses files serializes them.
import { el, button } from './controls';
import { toast } from './toast';
import { downloadBlob } from '../core/fileio';
import { serializeSheet } from '../core/parser';
import { neutralizeFormula } from '../core/csvsafe';
import type { SheetData, CellValue } from '../core/types';

const cellText = (v: CellValue): string => (v === null || v === undefined ? '' : String(v));

/**
 * Tab-separated text — what a spreadsheet expects from the clipboard. Values
 * are formula-neutralised first: the clipboard lands in Excel cells, and Excel
 * evaluates anything that starts like a formula. See core/csvsafe.ts.
 */
export function toTsv(sheet: SheetData): string {
  const clean = (s: string): string => neutralizeFormula(s).replace(/[\t\r\n]+/g, ' ');
  return [sheet.headers.map(clean).join('\t'), ...sheet.rows.map((r) => r.map((c) => clean(cellText(c))).join('\t'))].join('\n');
}

/** Action row for a table result: clipboard + file exports. */
export function tableActions(sheet: SheetData, baseName: string): HTMLElement {
  const download = async (format: 'csv' | 'xlsx'): Promise<void> => {
    try {
      const { blob, ext } = await serializeSheet(sheet, format);
      downloadBlob(blob, `${baseName}.${ext}`);
    } catch (e) {
      toast(`Could not build the file: ${e instanceof Error ? e.message : String(e)}`, 'error', 7000);
    }
  };

  const copy = button('Copy', async () => {
    try {
      await navigator.clipboard.writeText(toTsv(sheet));
      toast('Copied. Paste straight into Excel — it lands in cells, not one blob of text.', 'success', 5000);
    } catch {
      toast('The browser blocked clipboard access. Use CSV or Excel instead.', 'warning', 6000);
    }
  }, 'btn-ghost out-act');
  copy.title = 'Copy as tab-separated text, ready to paste into a spreadsheet';

  const csv = button('CSV', () => void download('csv'), 'btn-ghost out-act');
  const xlsx = button('Excel', () => void download('xlsx'), 'btn-ghost out-act');
  xlsx.title = 'Download this result as an .xlsx file';

  return el('div', { class: 'out-actions' }, [copy, csv, xlsx]);
}

/** Action row for a chart: save the image. */
export function imageActions(pngBase64: string, baseName: string): HTMLElement {
  const save = button('Save image', () => {
    const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    downloadBlob(new Blob([bytes], { type: 'image/png' }), `${baseName}.png`);
  }, 'btn-ghost out-act');
  save.title = 'Download the chart as a .png';
  return el('div', { class: 'out-actions' }, [save]);
}
