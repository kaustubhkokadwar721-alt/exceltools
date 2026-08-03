// Reconstructing tables from positioned text.
//
// These build the text layer by hand rather than parsing a PDF, because the
// thing under test is the geometry, not pdf.js. Every layout below is one that
// turns up in the documents this exists for: a bank statement, an ERP print, a
// portal download.
import { describe, it, expect } from 'vitest';
import { extractTables, scannedPages, tableLabel, type PdfPage, type TextRun } from '../../src/core/pdftable';

const H = 10; // 10pt type, so a character is about 5pt wide
const width = (s: string) => s.length * 5;

/** Lay out lines of `[text, x]` at a fixed line spacing. */
function page(lines: [string, number][][], opts: { page?: number; y0?: number; step?: number } = {}): PdfPage {
  const runs: TextRun[] = [];
  let y = opts.y0 ?? 100;
  for (const line of lines) {
    for (const [text, x] of line) runs.push({ text, x, y, w: width(text), h: H });
    y += opts.step ?? 14;
  }
  return { page: opts.page ?? 1, runs };
}

const STATEMENT: [string, number][][] = [
  [['Date', 50], ['Particulars', 150], ['Amount', 300]],
  [['01/04/2025', 50], ['Opening Balance', 150], ['1,000.00', 300]],
  [['02/04/2025', 50], ['Cheque 4471', 150], ['2,500.00', 300]],
];

describe('extractTables', () => {
  it('reads an aligned table as its rows and columns', () => {
    const [t] = extractTables([page(STATEMENT)]);
    expect(t.headers).toEqual(['Date', 'Particulars', 'Amount']);
    expect(t.rows).toEqual([
      ['01/04/2025', 'Opening Balance', 1000],
      ['02/04/2025', 'Cheque 4471', 2500],
    ]);
    expect(t.totalRows).toBe(2);
    expect(t.page).toBe(1);
  });

  it('keeps a cell whole when the generator emits it as separate words', () => {
    // Most PDF writers split a cell into one text run per word. A word space is
    // a fraction of an em; a column gutter is several. Only the second is a
    // column boundary.
    const t = extractTables([page([
      [['Voucher', 50], ['Narration', 150], ['Debit', 300]],
      [['V-001', 50], ['Payment', 150], ['to', 190], ['Acme', 205], ['5,000.00', 300]],
    ])])[0];
    expect(t.headers).toHaveLength(3);
    expect(t.rows[0][1]).toBe('Payment to Acme');
  });

  it('puts right-aligned figures in their own column', () => {
    // Amounts align on their right edge, so each starts at a different x. The
    // column is still one column.
    const right = (s: string, edge: number): [string, number] => [s, edge - width(s)];
    const t = extractTables([page([
      [['Account', 50], right('Balance', 340)],
      [['Cash', 50], right('1,000.00', 340)],
      [['Bank', 50], right('12,34,567.00', 340)],
    ])])[0];
    expect(t.headers).toEqual(['Account', 'Balance']);
    expect(t.rows).toEqual([['Cash', 1000], ['Bank', 1234567]]);
  });

  it('ignores a title line instead of letting it collapse the columns', () => {
    // A full-width heading covers every gutter. Treated as a table row it would
    // merge all three columns into one.
    const t = extractTables([page([
      [['Statement of Account for April 2025', 50]],
      ...STATEMENT,
    ])])[0];
    expect(t.headers).toEqual(['Date', 'Particulars', 'Amount']);
    expect(t.rows).toHaveLength(2);
  });

  it('separates two tables printed one above the other', () => {
    const first = page(STATEMENT);
    const second = page(
      [
        [['Code', 50], ['Description', 150], ['Total', 300]],
        [['A1', 50], ['Repairs', 150], ['400.00', 300]],
      ],
      { y0: 260 }, // a wide gap below the first block
    );
    const tables = extractTables([{ page: 1, runs: [...first.runs, ...second.runs] }]);
    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.index)).toEqual([1, 2]);
    expect(tables[0].headers[0]).toBe('Date');
    expect(tables[1].headers[0]).toBe('Code');
  });

  it('finds nothing in a page of prose', () => {
    expect(extractTables([page([
      [['This page is intentionally left blank.', 50]],
      [['Continued overleaf.', 50]],
    ])])).toEqual([]);
  });

  it('numbers the tables per page, not across the document', () => {
    const tables = extractTables([page(STATEMENT, { page: 3 }), page(STATEMENT, { page: 4 })]);
    expect(tables.map((t) => [t.page, t.index])).toEqual([[3, 1], [4, 1]]);
  });
});

describe('wrapped rows', () => {
  const WRAPPED: [string, number][][] = [
    [['Date', 50], ['Particulars', 150], ['Amount', 300]],
    [['01/04/2025', 50], ['NEFT transfer to', 150], ['1,000.00', 300]],
    [['ACME INDUSTRIES', 150]],
    [['02/04/2025', 50], ['Cash deposit', 150], ['500.00', 300]],
  ];

  it('folds a continuation line into the row above it', () => {
    // A wrapped narration arrives as a line whose leading columns are empty.
    // Left alone it becomes an orphan row with no date and no amount.
    const t = extractTables([page(WRAPPED)])[0];
    expect(t.rows).toEqual([
      ['01/04/2025', 'NEFT transfer to ACME INDUSTRIES', 1000],
      ['02/04/2025', 'Cash deposit', 500],
    ]);
  });

  it('leaves the continuation as its own row when the option is off', () => {
    const t = extractTables([page(WRAPPED)], { joinWrappedRows: false })[0];
    expect(t.rows).toHaveLength(3);
    expect(t.rows[1]).toEqual([null, 'ACME INDUSTRIES', null]);
  });
});

describe('cell values', () => {
  const MONEY: [string, number][][] = [
    [['Head', 50], ['Amount', 300]],
    [['Grouped', 50], ['12,34,567', 300]],
    [['Bracketed', 50], ['(500)', 300]],
    [['Trailing minus', 50], ['1000-', 300]],
    [['A date', 50], ['01/04/2025', 300]],
  ];

  it('reads the accounting forms as numbers', () => {
    const t = extractTables([page(MONEY)])[0];
    expect(t.rows.map((r) => r[1])).toEqual([1234567, -500, -1000, '01/04/2025']);
  });

  it('leaves everything as text when conversion is off', () => {
    const t = extractTables([page(MONEY)], { convertNumbers: false })[0];
    expect(t.rows.map((r) => r[1])).toEqual(['12,34,567', '(500)', '1000-', '01/04/2025']);
  });

  it('writes an empty cell as null rather than an empty string', () => {
    const t = extractTables([page([
      [['A', 50], ['B', 150], ['C', 300]],
      [['x', 50], ['z', 300]],
    ])], { joinWrappedRows: false })[0];
    expect(t.rows[0]).toEqual(['x', null, 'z']);
  });
});

describe('column names', () => {
  it('numbers a column whose header cell is blank', () => {
    const t = extractTables([page([
      [['Date', 50], ['Amount', 300]],
      [['01/04/2025', 50], ['note', 150], ['1,000.00', 300]],
    ])], { joinWrappedRows: false })[0];
    // The middle column exists in the body but has no header of its own.
    expect(t.headers).toEqual(['Date', 'Column 2', 'Amount']);
  });

  it('disambiguates two columns that print the same header', () => {
    const t = extractTables([page([
      [['Amount', 50], ['Amount', 300]],
      [['1.00', 50], ['2.00', 300]],
    ])])[0];
    expect(t.headers).toEqual(['Amount', 'Amount 2']);
  });
});

describe('what the geometry will not do', () => {
  it('merges two columns rather than inventing a boundary a cell crosses', () => {
    // One row whose middle value spills across the gutter closes it. Joining
    // two columns is visible in the output; splitting a column where the
    // evidence does not support it would cut values in half unnoticed.
    const t = extractTables([page([
      [['Date', 50], ['Particulars', 150], ['Amount', 300]],
      [['01/04/2025', 50], ['A description running right across the gap', 150], ['1,000.00', 300]],
      [['02/04/2025', 50], ['Short', 150], ['500.00', 300]],
    ])])[0];
    // Both header cells land in the surviving column and are joined, which is
    // what makes the merge legible in the output.
    expect(t.headers).toEqual(['Date', 'Particulars Amount']);
  });

  it('reports a page with no text layer instead of guessing at it', () => {
    // A scan is an image. OCR would put misread digits into an audit total.
    const pages: PdfPage[] = [page(STATEMENT), { page: 2, runs: [] }];
    expect(scannedPages(pages)).toEqual([2]);
    expect(extractTables(pages).every((t) => t.page === 1)).toBe(true);
  });
});

describe('tableLabel', () => {
  it('names by page alone, adding the index only when a page holds several', () => {
    const t = { page: 7, index: 1, headers: [], rows: [], totalRows: 0 };
    expect(tableLabel(t, 1)).toBe('p7');
    expect(tableLabel(t, 2)).toBe('p7-1');
  });
});
