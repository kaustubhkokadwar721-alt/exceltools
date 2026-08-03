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

/** One piece of text on a generated PDF page: the string, its left edge, and
 *  its baseline measured DOWN from the top of the page. */
export type PdfItem = [text: string, x: number, y: number];

/**
 * Build a real PDF with text at given positions, so the extractor is exercised
 * through pdf.js rather than against hand-made coordinates.
 *
 * Written by hand because the alternative is a dependency that would only ever
 * be used here. Helvetica is one of the base-14 fonts, so nothing is embedded
 * and the text layer still reads back with proper widths.
 */
export function pdfBase64(pages: PdfItem[][], opts: { size?: number } = {}): string {
  const W = 595;
  const H = 842;
  const size = opts.size ?? 10;
  const nPages = pages.length;
  const FONT = 3;
  const firstPage = 4;
  const firstContent = firstPage + nPages;
  const esc = (s: string) => s.replace(/([\\()])/g, '\\$1');

  const objects: string[] = [];
  objects[0] = '<</Type/Catalog/Pages 2 0 R>>';
  objects[1] = `<</Type/Pages/Kids[${pages.map((_, i) => `${firstPage + i} 0 R`).join(' ')}]/Count ${nPages}>>`;
  objects[2] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>';

  pages.forEach((items, i) => {
    objects[firstPage - 1 + i] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${W} ${H}]` +
      `/Resources<</Font<</F1 ${FONT} 0 R>>>>/Contents ${firstContent + i} 0 R>>`;
    // Tm places each run absolutely, so the text layer reports exactly the
    // coordinates the test asked for.
    const stream = items
      .map(([text, x, y]) => `BT /F1 ${size} Tf 1 0 0 1 ${x} ${H - y} Tm (${esc(text)}) Tj ET`)
      .join('\n');
    objects[firstContent - 1 + i] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets[i] = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = pdf.length;
  const n = objects.length + 1;
  // Every xref entry is exactly 20 bytes, including the trailing space.
  pdf += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${n}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1').toString('base64');
}

/** Drop a base64-encoded file onto a dropzone by dispatching a real drop event. */
export async function dropFile(page: Page, selector: string, name: string, b64: string): Promise<void> {
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

/** Drop a base64 .xlsx onto a dropzone. */
export const dropXlsx = dropFile;

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
