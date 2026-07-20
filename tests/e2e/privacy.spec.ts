import { test, expect } from '@playwright/test';
import { xlsxBase64, dropXlsx } from './helpers';

// The core privacy guarantee, guarded against regression: exercising the tools —
// including the DuckDB engine — must not cause any request to leave the origin.
// If a future change adds a CDN font, analytics, or remote call, this fails.
test('no external network requests during real tool use', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const external: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith(origin)) return;
    external.push(u);
  });

  const STAFF = xlsxBase64([
    ['ID', 'Dept', 'Amt'],
    [1, 'Fin', 10],
    [2, 'Ops', 20],
    [3, 'Fin', 30],
  ]);

  // Light tier: load + convert.
  await page.goto('/#/tool/convert');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  await page.waitForSelector('.config-bar');

  // Intermediate tier: load the DuckDB engine and run a query.
  await page.goto('/#/tool/query');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  await page.waitForSelector('.sheet-stage-row input.col-name', { timeout: 60_000 });
  await page.click('button:has-text("Register")');
  await page.waitForSelector('.sql-editor', { timeout: 60_000 });
  await page.fill('.sql-editor', 'SELECT Dept, SUM(Amt) AS t FROM staff GROUP BY Dept');
  await page.click('button:has-text("Run query")');
  await page.waitForSelector('#result .grid-row');

  expect(external, `unexpected external requests: ${external.join(', ')}`).toEqual([]);
});
