// PDF tables, end to end through pdf.js in a real browser.
//
// The fixtures are real PDFs built by hand, so these exercise the whole path —
// text layer, coordinate transform, gutter detection, output — rather than the
// geometry alone, which tests/unit/pdftable.test.ts covers against synthetic
// runs.
import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { readFile } from 'node:fs/promises';
import { pdfBase64, dropFile, gridRows, type PdfItem } from './helpers';

const COLS = { date: 50, desc: 150, amt: 320 };

/** A page of a bank statement: a heading, a header row, then transactions. */
function statementPage(heading: string, rows: [string, string, string][]): PdfItem[] {
  const items: PdfItem[] = [[heading, COLS.date, 60]];
  let y = 100;
  items.push(['Date', COLS.date, y], ['Particulars', COLS.desc, y], ['Amount', COLS.amt, y]);
  for (const [d, p, a] of rows) {
    y += 16;
    items.push([d, COLS.date, y], [p, COLS.desc, y], [a, COLS.amt, y]);
  }
  return items;
}

const STATEMENT = pdfBase64([
  statementPage('Statement of Account for the period 01-04-2025 to 30-04-2025', [
    ['01/04/2025', 'Opening Balance', '1,000.00'],
    ['02/04/2025', 'NEFT ACME INDUSTRIES', '2,500.00'],
  ]),
  statementPage('Statement of Account - continued, page 2 of 2', [
    ['03/04/2025', 'Cheque 447120', '(750.00)'],
    ['04/04/2025', 'Cash deposit', '5,000.00'],
  ]),
]);

async function open(page: import('@playwright/test').Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/#/tool/pdf');
  await page.waitForSelector('.dropzone');
  (page as unknown as { _errors: string[] })._errors = errors;
}

test('reads the tables out of a multi-page PDF and stacks them into one sheet', async ({ page }) => {
  await open(page);
  await dropFile(page, '.dropzone', 'statement.pdf', STATEMENT);

  // One table per page, each listed with where it came from.
  await expect(page.locator('#found .file-list-head')).toContainText('2 table(s) found in 1 PDF(s)');
  await expect(page.locator('#found .file-row').first()).toContainText('Page 1');
  await expect(page.locator('#found .file-row').nth(1)).toContainText('Page 2');

  // Merged: both pages' rows in one grid, with the source of each row kept.
  await expect(page.locator('#preview .sheet-meta')).toContainText('4 rows');
  // The grid's first cell is its row number, so the data starts at index 1.
  const rows = await gridRows(page, '#preview', 5);
  expect(rows[0]).toEqual(['1', 'statement p1', '01/04/2025', 'Opening Balance', '1000']);
  expect(rows[1]).toEqual(['2', 'statement p1', '02/04/2025', 'NEFT ACME INDUSTRIES', '2500']);
  expect(rows[2][1]).toBe('statement p2');
  // Accounting parentheses survive the round trip as a real negative number.
  expect(Number(rows[2][4])).toBe(-750);

  expect((page as unknown as { _errors: string[] })._errors).toEqual([]);
});

test('writes one sheet per table in Separate mode', async ({ page }) => {
  await open(page);
  await dropFile(page, '.dropzone', 'statement.pdf', STATEMENT);
  await page.locator('#found .file-row').first().waitFor();

  await page.check('input[name="pdf-mode"][value="sheets"]');
  await expect(page.locator('#preview .sheet-meta')).toContainText('2 table(s)');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('button:has-text("Extract & download")'),
  ]);
  const wb = XLSX.read(await readFile((await download.path())!), { type: 'buffer' });
  expect(wb.SheetNames).toEqual(['statement p1', 'statement p2']);

  const first = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['statement p1']);
  expect(first).toEqual([
    { Date: '01/04/2025', Particulars: 'Opening Balance', Amount: 1000 },
    { Date: '02/04/2025', Particulars: 'NEFT ACME INDUSTRIES', Amount: 2500 },
  ]);
});

test('a table can be excluded before anything is written', async ({ page }) => {
  await open(page);
  await dropFile(page, '.dropzone', 'statement.pdf', STATEMENT);
  await expect(page.locator('#preview .sheet-meta')).toContainText('4 rows');

  // A page header or totals block often reads as a table; unticking it must
  // take its rows out of the output, not just grey the row out.
  await page.locator('#found .file-row input[type="checkbox"]').first().uncheck();
  await expect(page.locator('#found .file-list-head')).toContainText('1 selected');
  await expect(page.locator('#preview .sheet-meta')).toContainText('2 rows');
  expect((await gridRows(page, '#preview', 3))[0][1]).toBe('statement p2');
});

test('a page with no text layer is reported, not guessed at', async ({ page }) => {
  // An empty page stands in for a scan: pdf.js reads it, and it has no text.
  const SCANNED = pdfBase64([
    statementPage('Statement of Account for the period 01-04-2025 to 30-04-2025', [
      ['01/04/2025', 'Opening Balance', '1,000.00'],
      ['02/04/2025', 'Cash deposit', '500.00'],
    ]),
    [],
  ]);
  await open(page);
  await dropFile(page, '.dropzone', 'scan.pdf', SCANNED);

  await expect(page.locator('#found')).toContainText('Page 2 has no text layer');
  await expect(page.locator('#found .file-list-head')).toContainText('1 table(s) found');
});

test('the reading options change the result and are visible before download', async ({ page }) => {
  // A narration that wrapped onto its own line, as every statement has.
  const WRAPPED = pdfBase64([[
    ['Date', COLS.date, 100], ['Particulars', COLS.desc, 100], ['Amount', COLS.amt, 100],
    ['01/04/2025', COLS.date, 116], ['NEFT transfer to', COLS.desc, 116], ['1,000.00', COLS.amt, 116],
    ['ACME INDUSTRIES LTD', COLS.desc, 132],
    ['02/04/2025', COLS.date, 148], ['Cash deposit', COLS.desc, 148], ['500.00', COLS.amt, 148],
  ]]);
  await open(page);
  await dropFile(page, '.dropzone', 'wrapped.pdf', WRAPPED);

  // Toggling an option re-renders the preview, so these assert on the cell
  // itself and retry rather than reading the grid at one instant.
  const cell = (i: number) => page.locator('#preview .grid-row').first().locator('.grid-cell').nth(i);

  await expect(page.locator('#preview .sheet-meta')).toContainText('2 rows');
  await expect(cell(3)).toHaveText('NEFT transfer to ACME INDUSTRIES LTD');

  // Turning the join off leaves the continuation as a row of its own — the
  // point being that you can see which reading you are getting.
  await page.getByText('Join wrapped rows').click();
  await expect(page.locator('#preview .sheet-meta')).toContainText('3 rows');
  await expect(cell(3)).toHaveText('NEFT transfer to');

  // And numbers can be left exactly as the document printed them.
  await page.getByText('Convert numbers').click();
  await expect(cell(4)).toHaveText('1,000.00');
});

test('a PDF is refused by the tools that cannot read one', async ({ page }) => {
  await page.goto('/#/tool/merge');
  await page.waitForSelector('.dropzone');
  await dropFile(page, '.dropzone', 'statement.pdf', STATEMENT);
  await expect(page.locator('.toast')).toContainText('Unsupported file type ".pdf"');
});

// ---- Browser floor ---------------------------------------------------------
//
// This suite is aimed at locked-down work PCs, where the browser is whatever the
// fleet is pinned to — often years behind. pdfjs-dist 6.x reached for
// Promise.try (Chrome 134+) and Math.sumPrecise (Chrome 137+), which meant it
// read nothing at all below that, and said nothing either: those calls sit
// inside pdf.js's worker plumbing, where the TypeError escapes as an unhandled
// rejection instead of rejecting the promise the tool is awaiting.
//
// Deleting builtins is a blunter instrument than running an old browser, but it
// tests the thing that actually broke, on whatever browser CI happens to pin —
// which is the point, since the last break was invisible precisely because the
// local browser was newer than CI's.

/** Make a current browser behave like one that predates the given builtins. */
async function withoutBuiltins(page: import('@playwright/test').Page, paths: string[]): Promise<void> {
  await page.addInitScript((list: string[]) => {
    for (const path of list) {
      const [holder, prop] = path.split('.');
      delete (globalThis as unknown as Record<string, Record<string, unknown>>)[holder][prop];
    }
  }, paths);
}

test('a PDF still reads on a browser at the supported floor', async ({ page }) => {
  await withoutBuiltins(page, ['Promise.try', 'Math.sumPrecise']);
  await open(page);
  await dropFile(page, '.dropzone', 'statement.pdf', STATEMENT);

  // The same expectations as the first test in this file: nothing about the
  // result may depend on a browser newer than the floor.
  await expect(page.locator('#found .file-list-head')).toContainText('2 table(s) found in 1 PDF(s)');
  await expect(page.locator('#preview .sheet-meta')).toContainText('4 rows');
  const rows = await gridRows(page, '#preview', 5);
  expect(rows[0]).toEqual(['1', 'statement p1', '01/04/2025', 'Opening Balance', '1000']);
  expect(rows[2][1]).toBe('statement p2');

  expect((page as unknown as { _errors: string[] })._errors).toEqual([]);
});

test('a browser below the floor is told so, not left waiting', async ({ page }) => {
  // Promise.withResolvers is the oldest thing the pinned pdf.js needs and does
  // not polyfill, so removing it stands in for anything below the floor.
  await withoutBuiltins(page, ['Promise.withResolvers']);
  await open(page);
  await dropFile(page, '.dropzone', 'statement.pdf', STATEMENT);

  // Named as a limit of the browser, and specific about what would work —
  // not a stack trace, and not phrased as though the file were at fault.
  const notice = page.locator('#found .tool-notice');
  await expect(notice).toContainText('too old to read PDFs');
  await expect(notice).toContainText('Chrome or Edge 119+');

  // The old failure left the progress line up and the tool permanently busy.
  await expect(page.locator('#content #status')).toHaveText('');
  // Reported through the tool rather than thrown past it.
  expect((page as unknown as { _errors: string[] })._errors).toEqual([]);
});
