import { test, expect } from '@playwright/test';
import { xlsxWithTable, dropXlsx, gridRows } from './helpers';

// A workbook whose data is a real Excel Table named "Sales" with numeric-looking
// amounts stored as text (to exercise typing).
const FILE = xlsxWithTable(
  [
    ['Order', 'Amount', 'City'],
    ['ORD-1', '1000', 'Pune'],
    ['ORD-2', '2500', 'Delhi'],
    ['ORD-3', '500', 'Pune'],
  ],
  'Sales',
);

test('detects the Excel Table, lets you rename it, registers typed columns', async ({ page }) => {
  await page.goto('/#/tool/query');
  await dropXlsx(page, '.dropzone', 'sales.xlsx', FILE);

  // Setup card appears with the table's real name.
  await page.waitForSelector('.source-card', { timeout: 60_000 });
  const nameInput = page.locator('.source-card .field-input').first();
  await expect(nameInput).toHaveValue('Sales');

  // Rename the table, then register.
  await nameInput.fill('orders');
  await page.click('button:has-text("Register")');
  await page.waitForSelector('.schema-block summary:has-text("orders")');

  // Amount auto-detects as numeric → SUM works.
  await page.fill('.sql-editor', 'SELECT SUM(Amount) AS total FROM orders');
  await page.click('button:has-text("Run query")');
  await page.waitForSelector('#result .grid-row');
  const rows = await gridRows(page);
  expect(rows[0][1]).toBe('4000');
});

test('skip type detection imports the column as text', async ({ page }) => {
  await page.goto('/#/tool/query');
  await dropXlsx(page, '.dropzone', 'sales.xlsx', FILE);
  await page.waitForSelector('.source-card', { timeout: 60_000 });

  // Tick "Skip type detection", register.
  await page.locator('.source-card-head input[type="checkbox"]').check();
  await page.click('button:has-text("Register")');
  await page.waitForSelector('.schema-block summary:has-text("sales")');

  await page.fill('.sql-editor', "SELECT typeof(Amount) AS t FROM sales LIMIT 1");
  await page.click('button:has-text("Run query")');
  await page.waitForSelector('#result .grid-row');
  const rows = await gridRows(page);
  expect(rows[0][1]).toBe('VARCHAR');
});
