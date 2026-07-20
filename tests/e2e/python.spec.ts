import { test, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { xlsxBase64, dropXlsx, gridRows } from './helpers';

const STAFF = xlsxBase64([
  ['ID', 'Dept', 'Amt'],
  ...Array.from({ length: 30 }, (_, i) => [i + 1, ['Fin', 'Ops', 'IT'][(i + 1) % 3], (i + 1) * 10] as (string | number)[]),
]);

const pyDir = join(process.cwd(), 'public', 'pyodide');
const staged = (prefix: string) => existsSync(pyDir) && readdirSync(pyDir).some((f) => f.startsWith(prefix));
const pandasStaged = staged('pandas-');
const mplStaged = staged('matplotlib-');

async function bootNotebook(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/#/tool/python');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  await page.waitForSelector('.sheet-stage-row input.col-name', { timeout: 60_000 });
  await page.fill('.sheet-stage-row input.col-name', 'payroll');
  await page.click('button:has-text("Register")');
  await page.waitForSelector('.nb-cell', { timeout: 150_000 });
}

async function setCell(page: import('@playwright/test').Page, idx: number, code: string): Promise<void> {
  const ta = page.locator('.nb-src').nth(idx);
  await ta.fill(code);
}

test('notebook: cells share state, stdout + repr + table outputs render', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);

  // Cell 1: define state + print (stdout) — pure Python so it runs everywhere.
  await setCell(page, 0, 'total = sum(r["Amt"] for r in tables["payroll"])\nprint("computed")\ntotal');
  await page.locator('.nb-cell').nth(0).locator('button:has-text("Run")').click();
  await page.waitForSelector('.nb-stdout');
  await expect(page.locator('.nb-stdout').first()).toContainText('computed');
  await expect(page.locator('.nb-repr').first()).toContainText('4650'); // sum 10..300
  await expect(page.locator('.nb-count').first()).toContainText('[1]');

  // Cell 2 (new): uses cell 1's variable — the notebook property.
  await page.locator('button:has-text("+ Code")').click();
  await setCell(page, 1, 'result = [{"k": "total", "v": total * 2}]\nresult');
  await page.locator('.nb-cell').nth(1).locator('button:has-text("Run")').click();
  await page.waitForSelector('.nb-cell:nth-child(2) .nb-repr, .nb-out .grid', { timeout: 30_000 });
  await expect(page.locator('.nb-cell').nth(1).locator('.nb-out')).toContainText('9300');
});

test('notebook: error shows traceback and Run all stops there', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'raise ValueError("boom")');
  await page.locator('button:has-text("+ Code")').click();
  await setCell(page, 1, 'print("never")');
  await page.locator('button:has-text("Run all")').click();
  await page.waitForSelector('.nb-tb', { timeout: 30_000 });
  await expect(page.locator('.nb-tb')).toContainText('ValueError: boom');
  await expect(page.locator('.nb-stdout')).toHaveCount(0); // second cell never ran
});

test('notebook: save .ipynb and load it back', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'x = 41\nx + 1');
  await page.locator('button:has-text("+ Markdown")').click();
  await page.locator('.nb-src').nth(1).fill('# My notes');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Save .ipynb")')]);
  const path = await dl.path();
  const nb = JSON.parse((await readFile(path)).toString('utf8'));
  expect(nb.nbformat).toBe(4);
  expect(nb.cells.map((c: { cell_type: string }) => c.cell_type)).toEqual(['code', 'markdown']);

  // Load it back through the picker.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("Open .ipynb")')]);
  await chooser.setFiles(path);
  await expect(page.locator('.nb-src').first()).toHaveValue('x = 41\nx + 1');
  await expect(page.locator('.nb-md')).toContainText('My notes');
});

test('notebook: pandas DataFrame renders as a grid', async ({ page }) => {
  test.skip(!pandasStaged, 'pandas wheels not staged in this build');
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'df_payroll.groupby("Dept", as_index=False)["Amt"].sum().sort_values("Dept")');
  await page.locator('.nb-cell').nth(0).locator('button:has-text("Run")').click();
  await page.waitForSelector('.nb-out .grid-row', { timeout: 60_000 });
  const rows = await gridRows(page, '.nb-out');
  expect(rows.map((r) => [r[1], r[2]])).toEqual([
    ['Fin', '1650'],
    ['IT', '1550'],
    ['Ops', '1450'],
  ]);
});

test('notebook: matplotlib chart renders as an image', async ({ page }) => {
  test.skip(!mplStaged, 'matplotlib wheels not staged in this build');
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'import matplotlib.pyplot as plt\ndf_payroll.groupby("Dept")["Amt"].sum().plot(kind="bar")\nplt.tight_layout()');
  await page.locator('.nb-cell').nth(0).locator('button:has-text("Run")').click();
  await page.waitForSelector('.nb-img', { timeout: 90_000 });
  const src = await page.locator('.nb-img').first().getAttribute('src');
  expect(src!.length).toBeGreaterThan(5000); // a real PNG, not a stub
});

test('grid: drag-resize and double-click autofit', async ({ page }) => {
  // Use the Viewer (light tier — fast) to exercise the shared grid.
  const WIDE = xlsxBase64([
    ['A Very Long Column Header Name Indeed', 'B'],
    ['short', 'this cell has some quite long content to fit against'],
  ]);
  await page.goto('/#/tool/viewer');
  await dropXlsx(page, '.dropzone', 'wide.xlsx', WIDE);
  await page.waitForSelector('.grid-resize');

  const cell = page.locator('.grid-header .grid-cell').nth(1);
  const before = (await cell.boundingBox())!.width;

  // Drag the first handle 120px right.
  const handle = page.locator('.grid-resize').first();
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 120, hb.y + hb.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = (await cell.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 100);

  // Double-click the second column's handle → autofits to its long content.
  const cell2 = page.locator('.grid-header .grid-cell').nth(2);
  const b2 = (await cell2.boundingBox())!.width;
  await page.locator('.grid-resize').nth(1).dblclick();
  const a2 = (await cell2.boundingBox())!.width;
  expect(Math.abs(a2 - b2)).toBeGreaterThan(10);
});
