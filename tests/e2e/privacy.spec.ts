import { test, expect } from '@playwright/test';
import { xlsxBase64, dropXlsx, dropFile, pdfBase64 } from './helpers';

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

  // PDF tier: pdf.js will fetch cmaps, standard font data and its own worker
  // from a CDN unless it is configured not to. This is the guard on that.
  await page.goto('/#/tool/pdf');
  await dropFile(page, '.dropzone', 'statement.pdf', pdfBase64([[
    ['Date', 50, 100], ['Particulars', 150, 100], ['Amount', 320, 100],
    ['01/04/2025', 50, 118], ['Opening Balance', 150, 118], ['1,000.00', 320, 118],
    ['02/04/2025', 50, 136], ['Cash deposit', 150, 136], ['500.00', 320, 136],
  ]]));
  await page.waitForSelector('#preview .grid-row', { timeout: 60_000 });

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

// Security regression: a crafted link must not inject markup into the page.
// CSP already blocks inline script, but that is the last line of defence, not
// the first — the app should not put attacker-controlled text into HTML at all.
test('a hostile URL fragment is shown as text, not rendered as markup', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/#/tool/<img src=x onerror="window.__pwned=1">');
  await page.waitForSelector('#content .empty');

  // Rendered as visible text, with no element created from it.
  await expect(page.locator('#content .empty')).toContainText('No tool called');
  expect(await page.locator('#content img').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});
