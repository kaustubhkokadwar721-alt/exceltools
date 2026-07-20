import { test, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { xlsxBase64, dropXlsx, gridRows } from './helpers';

const STAFF = xlsxBase64([
  ['ID', 'Dept', 'Amt'],
  ...Array.from({ length: 30 }, (_, i) => [i + 1, ['Fin', 'Ops', 'IT'][(i + 1) % 3], (i + 1) * 10] as (string | number)[]),
]);

// pandas wheels are staged by scripts/pyodide-assets.mjs when the network
// allows (always in CI); locally-offline builds fall back to pure Python.
const pyDir = join(process.cwd(), 'public', 'pyodide');
const wheelsStaged = existsSync(pyDir) && readdirSync(pyDir).some((f) => f.startsWith('pandas-'));

test('Python: register staged table and run code (engine under relaxed CSP)', async ({ page }) => {
  test.setTimeout(180_000); // first engine load compiles ~10 MB of wasm
  await page.goto('/#/tool/python');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  await page.waitForSelector('.sheet-stage-row input.col-name', { timeout: 60_000 });
  await page.fill('.sheet-stage-row input.col-name', 'payroll');
  await page.click('button:has-text("Register")');
  // Engine boot + registration.
  await page.waitForSelector('.sql-editor', { timeout: 120_000 });

  // Schema rail present with the chosen name.
  await expect(page.locator('.schema-block').first()).toContainText('payroll');
  await page.waitForSelector('button:has-text("Copy schema for AI")');

  // Pure-Python group-by works regardless of pandas availability.
  await page.fill(
    '.sql-editor',
    [
      'from collections import defaultdict',
      'totals = defaultdict(int)',
      'for r in tables["payroll"]:',
      '    totals[r["Dept"]] += r["Amt"]',
      'result = [{"Dept": k, "Total": v} for k, v in sorted(totals.items())]',
    ].join('\n'),
  );
  await page.click('button:has-text("Run Python")');
  await page.waitForSelector('#result .grid-row', { timeout: 60_000 });
  const rows = await gridRows(page);
  expect(rows).toEqual([
    ['1', 'Fin', '1650'],
    ['2', 'IT', '1550'],
    ['3', 'Ops', '1450'],
  ]);
});

test('Python: pandas DataFrame path', async ({ page }) => {
  test.skip(!wheelsStaged, 'pandas wheels not staged in this build (offline dev box)');
  test.setTimeout(180_000);
  await page.goto('/#/tool/python');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  await page.waitForSelector('.sheet-stage-row input.col-name', { timeout: 60_000 });
  await page.fill('.sheet-stage-row input.col-name', 'payroll');
  await page.click('button:has-text("Register")');
  await page.waitForSelector('.sql-editor', { timeout: 150_000 });
  await page.fill(
    '.sql-editor',
    'result = df_payroll.groupby("Dept", as_index=False)["Amt"].sum().sort_values("Dept")',
  );
  await page.click('button:has-text("Run Python")');
  await page.waitForSelector('#result .grid-row', { timeout: 60_000 });
  const rows = await gridRows(page);
  expect(rows.map((r) => [r[1], r[2]])).toEqual([
    ['Fin', '1650'],
    ['IT', '1550'],
    ['Ops', '1450'],
  ]);
});
