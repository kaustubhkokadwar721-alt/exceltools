import type { Page } from '@playwright/test';
import * as XLSX from 'xlsx';

export type Row = (string | number | boolean | null)[];

/** Build an .xlsx workbook from an array-of-arrays and return it base64-encoded. */
export function xlsxBase64(aoa: Row[], sheetName = 'Sheet1'): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }) as string;
}

/** Drop a base64 .xlsx onto a dropzone by dispatching a real drop event. */
export async function dropXlsx(page: Page, selector: string, name: string, b64: string): Promise<void> {
  // Wait for the target to exist — the tool module lazy-loads, and on a cold
  // first navigation (notably in CI) the dropzone may not be in the DOM yet.
  await page.waitForSelector(selector);
  await page.evaluate(
    ({ selector, name, b64 }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], name));
      document.querySelector(selector)!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    },
    { selector, name, b64 },
  );
}

/** Read the first N rendered grid rows as arrays of cell text. */
export async function gridRows(page: Page, scope = '#result', limit = 10): Promise<string[][]> {
  return page.locator(`${scope} .grid-row`).evaluateAll(
    (rows, n) =>
      rows
        .slice(0, n)
        .map((r) => Array.from(r.querySelectorAll('.grid-cell')).map((c) => c.textContent || '')),
    limit,
  );
}
