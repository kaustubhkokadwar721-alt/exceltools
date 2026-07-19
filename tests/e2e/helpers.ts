import type { Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { unzipSync, zipSync, strToU8 } from 'fflate';

export type Row = (string | number | boolean | null)[];

/** Build an .xlsx workbook from an array-of-arrays and return it base64-encoded. */
export function xlsxBase64(aoa: Row[], sheetName = 'Sheet1'): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }) as string;
}

/**
 * Build an .xlsx that contains a real Excel Table (ListObject) over `aoa`.
 * SheetJS cannot write tables, so we inject the table part + rels into the zip.
 */
export function xlsxWithTable(aoa: Row[], tableName: string): string {
  const b64 = xlsxBase64(aoa, 'Data');
  const files = unzipSync(Buffer.from(b64, 'base64'));
  const nRows = aoa.length;
  const nCols = aoa[0].length;
  const ref = `A1:${XLSX.utils.encode_col(nCols - 1)}${nRows}`;
  const cols = aoa[0]
    .map((c, i) => `<tableColumn id="${i + 1}" name="${String(c)}"/>`)
    .join('');

  files['xl/tables/table1.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="${tableName}" displayName="${tableName}" ref="${ref}" totalsRowShown="0">` +
      `<autoFilter ref="${ref}"/><tableColumns count="${nCols}">${cols}</tableColumns>` +
      `<tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/></table>`,
  );
  files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>`,
  );
  // Add <tableParts> to the worksheet.
  const sheetXml = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']);
  files['xl/worksheets/sheet1.xml'] = strToU8(
    sheetXml.replace('</worksheet>', `<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`),
  );
  return Buffer.from(zipSync(files)).toString('base64');
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
