import { test, expect, type Page } from '@playwright/test';
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

async function bootNotebook(page: Page): Promise<void> {
  await page.goto('/#/tool/python');
  await dropXlsx(page, '.dropzone', 'staff.xlsx', STAFF);
  await page.waitForSelector('.sheet-stage-row input.col-name', { timeout: 60_000 });
  await page.fill('.sheet-stage-row input.col-name', 'payroll');
  await page.click('button:has-text("Register")');
  // The rail only fills once the engine is up and the table is registered.
  await page.waitForSelector('.schema-block', { timeout: 150_000 });
}

async function setCell(page: Page, idx: number, code: string): Promise<void> {
  await page.locator('.ce-input').nth(idx).fill(code);
}

/**
 * Switch tools the way a user does — through the hash router, in the same
 * document. `page.goto` on a hash URL can be serviced as a full document load,
 * which races the SPA: a click can land on a page that is about to be replaced.
 * Waiting for the destination's own UI makes the remount the assertion.
 */
async function gotoTool(page: Page, id: 'python' | 'convert'): Promise<void> {
  await page.evaluate((tool) => {
    location.hash = `#/tool/${tool}`;
  }, id);
  await page.waitForSelector(id === 'python' ? '.nb-toolbar' : '.dropzone', { state: 'visible' });
}

const runCell = (page: Page, idx: number) => page.locator('.nb-cell').nth(idx).locator('.nb-run').click();

test('notebook: cells share state, stdout + repr + table outputs render', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);

  // Cell 1: define state + print (stdout) — pure Python so it runs everywhere.
  await setCell(page, 0, 'total = sum(r["Amt"] for r in tables["payroll"])\nprint("computed")\ntotal');
  await runCell(page, 0);
  await page.waitForSelector('.nb-stdout');
  await expect(page.locator('.nb-stdout').first()).toContainText('computed');
  await expect(page.locator('.nb-repr').first()).toContainText('4650'); // sum 10..300
  await expect(page.locator('.nb-count').first()).toContainText('[1]');

  // Cell 2 (new): uses cell 1's variable — the notebook property.
  await page.locator('.nb-toolbar button:has-text("Code")').click();
  await setCell(page, 1, 'result = [{"k": "total", "v": total * 2}]\nresult');
  await runCell(page, 1);
  // A list of dicts renders as a grid, with the figure grouped for reading.
  await expect(page.locator('.nb-cell').nth(1).locator('.nb-out-host')).toContainText(
    new Intl.NumberFormat(undefined).format(9300),
    { timeout: 30_000 },
  );
});

test('notebook: a failed cell is explained in plain English, and Run all stops there', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'raise ValueError("boom")');
  await page.locator('.nb-toolbar button:has-text("Code")').click();
  await setCell(page, 1, 'print("never")');
  await page.locator('.nb-toolbar button:has-text("Run all")').click();

  await page.waitForSelector('.nb-err-title', { timeout: 30_000 });
  await expect(page.locator('.nb-err-title')).toBeVisible();
  await expect(page.locator('.nb-stdout')).toHaveCount(0); // the second cell never ran

  // The real traceback is still one click away.
  await page.locator('.nb-err-raw > summary').click();
  await expect(page.locator('.nb-tb')).toContainText('ValueError: boom');
});

test('notebook: a missing column names the column and suggests the right one', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  // Pure Python raises the same KeyError pandas would, so this holds either way.
  await setCell(page, 0, 'tables["payroll"][0]["Amount"]');
  await runCell(page, 0);
  await page.waitForSelector('.nb-err-title', { timeout: 90_000 });
  await expect(page.locator('.nb-err-title')).toContainText('no column called "Amount"');
  await expect(page.locator('.nb-err-hint')).toContainText('Did you mean "Amt"?');
});

test('notebook: recipes insert runnable code using the real column names', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);

  // An empty notebook offers the recipe list up front — nothing to type.
  await page.waitForSelector('.nb-start .nb-recipe');

  if (pandasStaged) {
    // "Amt" is pre-picked over the numeric "ID" — you total money, not row numbers.
    const card = page.locator('.nb-recipe', { hasText: 'Total' }).first();
    await expect(card.locator('.recipe-pick').first()).toHaveValue('Amt');
    await card.locator('button:has-text("Insert")').click();
    await expect(page.locator('.ce-input').first()).toHaveValue(/groupby\("Dept", as_index=False\)\["Amt"\]/);
    await page.waitForSelector('.nb-out-host .grid-row', { timeout: 90_000 });
    const rows = await gridRows(page, '.nb-out-host');
    expect(rows.map((r) => [r[1], r[2]])).toEqual([
      ['Fin', '1,650'],
      ['IT', '1,550'],
      ['Ops', '1,450'],
    ]);
  } else {
    const card = page.locator('.nb-recipe', { hasText: 'See the first few rows' });
    await card.locator('button:has-text("Insert")').click();
    await expect(page.locator('.ce-input').first()).toHaveValue(/tables\["payroll"\]/);
    await expect(page.locator('.nb-stdout').first()).toContainText('30 rows', { timeout: 90_000 });
  }
});

test('notebook: a recipe can be re-pointed at other columns without editing Python', async ({ page }) => {
  test.skip(!pandasStaged, 'pandas wheels not staged in this build');
  test.setTimeout(240_000);
  await bootNotebook(page);
  await page.waitForSelector('.nb-start .nb-recipe');

  // "Total {Amt} by {Dept}" — change what is totalled and what it groups by.
  const card = page.locator('.nb-recipe', { hasText: 'Total' }).first();
  await card.locator('.recipe-pick').nth(0).selectOption('ID');
  await card.locator('.recipe-pick').nth(1).selectOption('Dept');
  await card.locator('button:has-text("Insert")').click();

  await expect(page.locator('.ce-input').first()).toHaveValue(/groupby\("Dept", as_index=False\)\["ID"\]/);
  await page.waitForSelector('.nb-out-host .grid-row', { timeout: 90_000 });
});

test('notebook: every table result in the notebook exports as one workbook', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, '[{"Dept": "Fin", "Total": 1650}, {"Dept": "Ops", "Total": 1450}]');
  await runCell(page, 0);
  await page.waitForSelector('.out-table .grid-row', { timeout: 90_000 });

  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.nb-toolbar button:has-text("Export")').click(),
  ]);
  expect(await dl.suggestedFilename()).toMatch(/^payroll-\d{4}-\d{2}-\d{2}-results\.xlsx$/);
});

test('notebook: a plain list of dicts is shown as a table, with figures aligned', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, '[{"Dept": "Fin", "Total": 1643552}, {"Dept": "Ops", "Total": 900}]');
  await runCell(page, 0);
  await page.waitForSelector('.out-table .grid-row', { timeout: 90_000 });

  // Grouped for reading; the export still carries the raw number.
  await expect(page.locator('.out-table .grid-num').first()).toHaveText(
    new Intl.NumberFormat(undefined).format(1643552),
  );
  await expect(page.locator('.out-table .out-label-meta')).toContainText('2 rows × 2 columns');
});

test('notebook: a deleted cell can be brought back', async ({ page }) => {
  await page.goto('/#/tool/python');
  await setCell(page, 0, 'careful = "hours of work"');
  await page.locator('.nb-toolbar button:has-text("Code")').click();
  await setCell(page, 1, 'second = 2');

  await page.locator('.nb-cell').nth(0).locator('.nb-del').click();
  await expect(page.locator('.nb-undo')).toContainText('Deleted a code cell');
  await expect(page.locator('.ce-input')).toHaveCount(1);

  await page.locator('.nb-undo button:has-text("Undo")').click();
  await expect(page.locator('.nb-undo')).toHaveCount(0);
  await expect(page.locator('.ce-input').nth(0)).toHaveValue('careful = "hours of work"');
  await expect(page.locator('.ce-input').nth(1)).toHaveValue('second = 2');
});

test('notebook: a step can be added or duplicated in the middle, not only at the end', async ({ page }) => {
  await page.goto('/#/tool/python');
  await setCell(page, 0, 'first = 1');
  await page.locator('.nb-toolbar button:has-text("Code")').click();
  await setCell(page, 1, 'last = 9');

  // The strip belongs to the first cell, so its insert lands at position 2.
  await page.locator('.nb-cell').nth(0).locator('.nb-insert button:has-text("＋ Code")').click();
  await setCell(page, 1, 'middle = 5');
  await expect(page.locator('.ce-input')).toHaveCount(3);
  await expect(page.locator('.ce-input').nth(2)).toHaveValue('last = 9');

  await page.locator('.nb-cell').nth(1).locator('.nb-insert button:has-text("Duplicate")').click();
  await expect(page.locator('.ce-input').nth(2)).toHaveValue('middle = 5');
});

test('notebook: save and reopen keeps the results, not just the code', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  // Pure Python so this holds with or without the pandas wheels staged.
  await setCell(page, 0, 'print("ran once")\nsum(r["Amt"] for r in tables["payroll"])');
  await runCell(page, 0);
  await expect(page.locator('.nb-repr').first()).toContainText('4650', { timeout: 90_000 });

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.nb-toolbar button:has-text("Save")')]);
  const path = await dl.path();
  const nb = JSON.parse((await readFile(path!)).toString('utf8'));
  expect(nb.nbformat).toBe(4);
  expect(nb.cells[0].outputs.map((o: { output_type: string }) => o.output_type)).toEqual(['stream', 'execute_result']);

  // Reload the tool so nothing is left in memory, then open the file back up.
  await gotoTool(page, 'convert');
  await gotoTool(page, 'python');
  const restore = page.locator('.nb-restore button:has-text("Discard")');
  if (await restore.count()) await restore.click();

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.nb-toolbar button:has-text("Open")'),
  ]);
  await chooser.setFiles(path!);

  // Results are back on screen without the engine having run anything.
  await expect(page.locator('.nb-repr').first()).toContainText('4650');
  await expect(page.locator('.nb-stdout').first()).toContainText('ran once');
  await expect(page.locator('.nb-count').first()).toContainText('[1]');
});

test('notebook: a saved table result reopens as a grid, and as HTML in Jupyter', async ({ page }) => {
  test.skip(!pandasStaged, 'pandas wheels not staged in this build');
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'df_payroll.groupby("Dept", as_index=False)["Amt"].sum().sort_values("Dept")');
  await runCell(page, 0);
  await page.waitForSelector('.nb-out-host .grid-row', { timeout: 90_000 });

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.nb-toolbar button:has-text("Save")')]);
  const path = await dl.path();
  const nb = JSON.parse((await readFile(path!)).toString('utf8'));
  // The saved file carries a real HTML table, so it is readable in Jupyter too.
  expect(JSON.stringify(nb.cells[0].outputs)).toContain('text/html');

  await gotoTool(page, 'convert');
  await gotoTool(page, 'python');
  const restore = page.locator('.nb-restore button:has-text("Discard")');
  if (await restore.count()) await restore.click();

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.nb-toolbar button:has-text("Open")'),
  ]);
  await chooser.setFiles(path!);

  await page.waitForSelector('.nb-out-host .grid-row');
  const rows = await gridRows(page, '.nb-out-host');
  expect(rows.map((r) => [r[1], r[2]])).toEqual([
    ['Fin', '1650'],
    ['IT', '1550'],
    ['Ops', '1450'],
  ]);
});

test('notebook: notes render as markdown and .ipynb round-trips both cell kinds', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'x = 41\nx + 1');
  await page.locator('.nb-toolbar button:has-text("Note")').click();
  await page.locator('.ce-input').nth(1).fill('# My notes');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.nb-toolbar button:has-text("Save")')]);
  const path = await dl.path();
  const nb = JSON.parse((await readFile(path!)).toString('utf8'));
  expect(nb.cells.map((c: { cell_type: string }) => c.cell_type)).toEqual(['code', 'markdown']);

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.nb-toolbar button:has-text("Open")'),
  ]);
  await chooser.setFiles(path!);
  await expect(page.locator('.ce-input').first()).toHaveValue('x = 41\nx + 1');
  await expect(page.locator('.nb-md')).toContainText('My notes');
});

// The notebook UI is usable before any file is added, so the tests below never
// start the Python engine — they cover the editor and the draft, not execution.
test('notebook: code is syntax-highlighted as you type', async ({ page }) => {
  await page.goto('/#/tool/python');
  await setCell(page, 0, 'for i in range(3):  # count\n    print("hi")');
  await expect(page.locator('.ce-hl .tk-kw').first()).toHaveText('for');
  await expect(page.locator('.ce-hl .tk-com').first()).toHaveText('# count');
  await expect(page.locator('.ce-hl .tk-str').first()).toHaveText('"hi"');
});

test('notebook: unsaved work is offered back after the tab is closed', async ({ page }) => {
  await page.goto('/#/tool/python');
  await setCell(page, 0, 'kept = "recover me"');
  // Autosave is debounced — wait for the write itself, not for a wall clock.
  await page.waitForFunction(() => !!localStorage.getItem('exceltools.notebook.draft.v1'));
  await gotoTool(page, 'convert');
  await gotoTool(page, 'python');

  await expect(page.locator('.nb-restore')).toContainText('unsaved work');
  await page.locator('.nb-restore button:has-text("Restore it")').click();
  await expect(page.locator('.ce-input').first()).toHaveValue('kept = "recover me"');
});

test('notebook: drafts can be switched off, which deletes the stored one', async ({ page }) => {
  await page.goto('/#/tool/python');
  await setCell(page, 0, 'secret = "client data"');
  await page.waitForFunction(() => !!localStorage.getItem('exceltools.notebook.draft.v1'));

  await page.locator('.nb-draft input').uncheck();
  expect(await page.evaluate(() => localStorage.getItem('exceltools.notebook.draft.v1'))).toBeNull();

  // Still off after a revisit, and nothing new is written.
  await setCell(page, 0, 'more = "typing"');
  await gotoTool(page, 'convert');
  await gotoTool(page, 'python');
  await expect(page.locator('.nb-restore')).toHaveCount(0);
  await expect(page.locator('.nb-draft input')).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('exceltools.notebook.draft.v1'))).toBeNull();
});

test('notebook: onboarding chrome collapses once tables are registered', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/#/tool/python');
  // Before: full drop area, full heading.
  await expect(page.locator('.dropzone')).toBeVisible();
  await expect(page.locator('.tool-head .tool-blurb')).toBeVisible();

  await bootNotebook(page);

  // After: a one-line summary of what is loaded, and a compact heading.
  await expect(page.locator('.dropzone')).toHaveCount(0);
  await expect(page.locator('.src-bar')).toContainText('1 table ready');
  await expect(page.locator('.src-chip')).toContainText('payroll');
  await expect(page.locator('.src-chip')).toContainText('30 rows');
  await expect(page.locator('.tool-head')).toHaveClass(/is-compact/);
  await expect(page.locator('.tool-head .tool-blurb')).toBeHidden();

  // And it is reversible — the drop area comes back on demand.
  await page.locator('.src-bar-add').click();
  await expect(page.locator('.dropzone')).toBeVisible();
});

test('notebook: code and results fold away, errors never do', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'print("kept")\n1 + 1');
  await runCell(page, 0);
  await expect(page.locator('.nb-repr').first()).toContainText('2', { timeout: 90_000 });

  // Fold the code — the first line stays as a label.
  await page.locator('.nb-cell').first().locator('.nb-gutter .nb-fold').click();
  await expect(page.locator('.ce-input')).toHaveCount(0);
  await expect(page.locator('.nb-folded code')).toContainText('print("kept")');
  await expect(page.locator('.nb-folded-meta')).toContainText('2 lines hidden');

  // Fold the results.
  await page.locator('.out-fold').click();
  await expect(page.locator('.nb-repr')).toHaveCount(0);
  await expect(page.locator('.out-head-meta')).toContainText('results hidden');

  // Unfold both by clicking the preview and the results chevron.
  await page.locator('.nb-folded').click();
  await expect(page.locator('.ce-input').first()).toHaveValue('print("kept")\n1 + 1');
  await page.locator('.out-fold').click();
  await expect(page.locator('.nb-repr').first()).toContainText('2');

  // An error is not part of the fold — it is always on screen.
  await setCell(page, 0, 'raise ValueError("boom")');
  await runCell(page, 0);
  await expect(page.locator('.nb-err-title')).toBeVisible({ timeout: 30_000 });
  await page.locator('.nb-cell').first().locator('.nb-gutter .nb-fold').click();
  await expect(page.locator('.nb-err-title')).toBeVisible();
});

test('notebook: a table result is labelled and can be taken back to Excel', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'tables["payroll"][:3]');
  await runCell(page, 0);
  // Pure-Python lists render as a value; use pandas for the table when staged.
  if (pandasStaged) {
    await setCell(page, 0, 'df_payroll.head(3)');
    await runCell(page, 0);
  } else {
    test.skip(true, 'a table result needs pandas, which is not staged in this build');
  }

  await expect(page.locator('.out-table .out-label-kind')).toHaveText('Table');
  await expect(page.locator('.out-table .out-label-meta')).toContainText('3 rows × 3 columns');

  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.out-table button:has-text("CSV")').click(),
  ]);
  expect(await dl.suggestedFilename()).toMatch(/^notebook-step-\d+.*\.csv$/);
});

test('notebook: Clear results empties every result and keeps the code', async ({ page }) => {
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'print("here")');
  await runCell(page, 0);
  await expect(page.locator('.nb-stdout')).toContainText('here', { timeout: 90_000 });
  await expect(page.locator('.nb-count').first()).toContainText('[1]');

  await page.locator('.nb-toolbar button:has-text("Clear")').click();
  await expect(page.locator('.nb-stdout')).toHaveCount(0);
  await expect(page.locator('.nb-count').first()).toContainText('[ ]');
  await expect(page.locator('.ce-input').first()).toHaveValue('print("here")');
});

test('notebook: the column list can be filtered when a table is wide', async ({ page }) => {
  test.setTimeout(240_000);
  const WIDE = xlsxBase64([
    Array.from({ length: 15 }, (_, i) => (i === 7 ? 'Closing Balance' : `Col ${i}`)),
    Array.from({ length: 15 }, (_, i) => i),
  ]);
  await page.goto('/#/tool/python');
  await dropXlsx(page, '.dropzone', 'wide.xlsx', WIDE);
  await page.waitForSelector('.sheet-stage-row input.col-name', { timeout: 60_000 });
  await page.click('button:has-text("Register")');
  await page.waitForSelector('.schema-block', { timeout: 150_000 });

  await expect(page.locator('.schema-col')).toHaveCount(15);
  await page.locator('.rail-filter').fill('balance');
  await expect(page.locator('.schema-col:visible')).toHaveCount(1);
  await expect(page.locator('.schema-col:visible')).toContainText('Closing Balance');
});

test('notebook: matplotlib chart renders as an image', async ({ page }) => {
  test.skip(!mplStaged, 'matplotlib wheels not staged in this build');
  test.setTimeout(240_000);
  await bootNotebook(page);
  await setCell(page, 0, 'import matplotlib.pyplot as plt\ndf_payroll.groupby("Dept")["Amt"].sum().plot(kind="bar")\nplt.tight_layout()');
  await runCell(page, 0);
  await page.waitForSelector('.nb-img', { timeout: 90_000 });
  const src = await page.locator('.nb-img').first().getAttribute('src');
  expect(src!.length).toBeGreaterThan(5000); // a real PNG, not a stub
});

test('grid: drag-resize and double-click autofit', async ({ page }) => {
  // Use Convert's preview (light tier — fast) to exercise the shared grid.
  const WIDE = xlsxBase64([
    ['A Very Long Column Header Name Indeed', 'B'],
    ['short', 'this cell has some quite long content to fit against'],
  ]);
  await page.goto('/#/tool/convert');
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
