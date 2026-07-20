import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { xlsxBase64, dropXlsx, gridRows } from './helpers';

const JAN = xlsxBase64([['ID', 'Name', 'Amount'], [1, 'Alice', 100], [2, 'Bob', 200]]);
const FEB = xlsxBase64([['ID', 'Name', 'Amount'], [3, 'Carol', 300], [4, 'Dave', 400]]);
const STAFF = xlsxBase64([['ID', 'Dept', 'Amt'], ...Array.from({ length: 30 }, (_, i) => [i + 1, ['Fin', 'Ops', 'IT'][(i + 1) % 3], (i + 1) * 10] as (string | number)[])]);
const CMP_A = xlsxBase64([['ID', 'Name', 'Salary'], [1, 'Alice', 100], [2, 'Bob', 200], [3, 'Carol', 300]]);
const CMP_B = xlsxBase64([['ID', 'Name', 'Salary'], [1, 'Alice', 100], [2, 'Bob', 250], [4, 'Dave', 400]]);
const DUPES = xlsxBase64([['Invoice', 'Vendor'], ['INV-1', 'Acme'], ['INV-2', 'Beta'], ['INV-1', 'acme '], ['INV-1', 'ACME']]);
const MESSY = xlsxBase64([['Name', 'Amount'], [' Alice ', '1,000'], ['bob', '2000']]);

async function readDownload(dl: import('@playwright/test').Download): Promise<Buffer> {
  const path = await dl.path();
  return readFile(path);
}

test('Convert: xlsx → JSON', async ({ page }) => {
  await page.goto('/#/tool/convert');
  await dropXlsx(page, '.dropzone', 'jan.xlsx', JAN);
  await page.waitForSelector('.config-bar');
  await page.selectOption('.config-bar select >> nth=1', 'json');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Convert & download")')]);
  const json = JSON.parse((await readDownload(dl)).toString('utf8'));
  expect(json).toHaveLength(2);
  expect(json[0]).toMatchObject({ ID: 1, Name: 'Alice', Amount: 100 });
});

test('Merge: stack rows with Source column', async ({ page }) => {
  await page.goto('/#/tool/merge');
  await dropXlsx(page, '.dropzone', 'jan.xlsx', JAN);
  await dropXlsx(page, '.dropzone', 'feb.xlsx', FEB);
  await page.waitForSelector('.file-row');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Merge & download")')]);
  const wb = XLSX.read(await readDownload(dl));
  const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  expect(rows[0]).toEqual(['Source', 'ID', 'Name', 'Amount']);
  expect(rows).toHaveLength(5); // header + 4 data rows
});

test('Split: by column value → zip of parts', async ({ page }) => {
  await page.goto('/#/tool/split');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  await page.waitForSelector('.config-bar');
  await page.selectOption('.mode-host select', '1'); // Dept
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Split & download")')]);
  const files = Object.keys(unzipSync(new Uint8Array(await readDownload(dl))));
  expect(files.sort()).toEqual(['Fin.xlsx', 'IT.xlsx', 'Ops.xlsx']);
});

test('Compare: classifies add/remove/change/unchanged', async ({ page }) => {
  await page.goto('/#/tool/compare');
  await dropXlsx(page, '#dzA .dropzone', 'a.xlsx', CMP_A);
  await dropXlsx(page, '#dzB .dropzone', 'b.xlsx', CMP_B);
  await page.click('button:has-text("Compare")');
  await page.waitForSelector('.diff-summary');
  const chips = (await page.locator('.diff-chip .chip-n').allTextContents()).map((s) => s.trim());
  expect(chips).toEqual(['1', '1', '1', '1']); // onlyA, onlyB, changed, same
});

test('Dedupe: key-based, folding case and whitespace', async ({ page }) => {
  await page.goto('/#/tool/dedupe');
  await dropXlsx(page, '.dropzone', 'dupes.xlsx', DUPES);
  await page.waitForSelector('.checkbox-list');
  await page.locator('.checkbox-list input').first().check(); // Invoice
  await page.click('button:has-text("Remove duplicates")');
  await page.waitForSelector('.diff-summary');
  const kept = (await page.locator('.diff-chip .chip-n').first().textContent())!.trim();
  expect(kept).toBe('2');
});

test('Clean: numbers-from-text and trim', async ({ page }) => {
  await page.goto('/#/tool/clean');
  await dropXlsx(page, '.dropzone', 'messy.xlsx', MESSY);
  await page.waitForSelector('.clean-toggles');
  await page.locator('.clean-toggle input').nth(2).check(); // numbersFromText
  await page.click('button:has-text("Clean & preview")');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download cleaned")')]);
  const wb = XLSX.read(await readDownload(dl));
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  expect(rows[1][0]).toBe('Alice'); // trimmed
  expect(rows[1][1]).toBe(1000); // real number
});

test('Query: SQL GROUP BY on DuckDB', async ({ page }) => {
  await page.goto('/#/tool/query');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  // Sheets stage first: confirm the row, then register.
  await page.waitForSelector('.sheet-stage-row input.col-name', { timeout: 60_000 });
  await page.click('button:has-text("Register")');
  await page.waitForSelector('.sql-editor', { timeout: 60_000 });
  await page.fill('.sql-editor', 'SELECT Dept, SUM(Amt) AS total FROM staff GROUP BY Dept ORDER BY Dept');
  await page.click('button:has-text("Run query")');
  await page.waitForSelector('#result .grid-row');
  const rows = await gridRows(page);
  expect(rows).toEqual([
    ['1', 'Fin', '1650'],
    ['2', 'IT', '1550'],
    ['3', 'Ops', '1450'],
  ]);
});

test('Query: rename a staged sheet and read the schema panel', async ({ page }) => {
  await page.goto('/#/tool/query');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  await page.waitForSelector('.sheet-stage-row input.col-name', { timeout: 60_000 });
  await page.fill('.sheet-stage-row input.col-name', 'payroll');
  await page.click('button:has-text("Register")');
  await page.waitForSelector('.schema-block', { timeout: 60_000 });
  // Renamed table appears in the schema reference with real DuckDB types.
  await page.locator('.schema-block summary:has-text("payroll")').click();
  const types = await page.locator('.schema-col-type').allTextContents();
  expect(types.length).toBeGreaterThan(0);
  expect(types.join(' ')).toMatch(/BIGINT|DOUBLE|VARCHAR/);
  // Copy-schema affordance exists for handing the schema to an AI assistant.
  await page.waitForSelector('button:has-text("Copy schema for AI")');
  // And SQL works against the renamed table.
  await page.fill('.sql-editor', 'SELECT COUNT(*) AS n FROM payroll');
  await page.click('button:has-text("Run query")');
  await page.waitForSelector('#result .grid-row');
  const rows = await gridRows(page);
  expect(rows[0][1]).toBe('30');
});

test('Pivot: group-by aggregate on DuckDB', async ({ page }) => {
  await page.goto('/#/tool/pivot');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  await page.waitForSelector('.checkbox-list', { timeout: 60_000 });
  await page.locator('.checkbox-list input').nth(1).check(); // Dept
  await page.selectOption('#config .config-bar select >> nth=0', 'Amt');
  await page.click('button:has-text("Build pivot")');
  await page.waitForSelector('#result .grid-row');
  const rows = await gridRows(page);
  expect(rows).toEqual([
    ['1', 'Fin', '1650'],
    ['2', 'IT', '1550'],
    ['3', 'Ops', '1450'],
  ]);
});
