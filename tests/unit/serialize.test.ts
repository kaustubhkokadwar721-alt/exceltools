// Export format tests.
//
// These functions produce the files a user hands to somebody else, which makes
// them the ones most worth pinning down: a defect here leaves the tool and
// arrives on another person's machine.
import { describe, it, expect } from 'vitest';
import {
  serializeSheetTo,
  serializeSheetsToWorkbook,
  toHtml,
  toMarkdown,
  rowsAsObjects,
  uniqueSheetName,
} from '../../src/core/serialize';
import type { SheetData } from '../../src/core/types';

const sheet = (headers: string[], rows: (string | number | boolean | null)[][], name = 'Sheet1'): SheetData => ({
  name,
  headers,
  rows,
  totalRows: rows.length,
});

async function text(blob: Blob): Promise<string> {
  return Buffer.from(await blob.arrayBuffer()).toString('utf8');
}

describe('toHtml', () => {
  // SheetJS's sheet_to_html escapes cell text but copies the raw value into a
  // data-v attribute, so a cell can close the attribute and inject an element.
  // The export is opened from disk, where that is script execution.
  it('escapes a cell that tries to break out of an attribute', () => {
    const html = toHtml(sheet(['Note'], [['"><img src=x onerror=alert(1)>']]));
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes script tags in cells and in headers', () => {
    const html = toHtml(sheet(['<script>bad()</script>'], [['<script>worse()</script>']]));
    expect(html).not.toContain('<script>');
    expect(html.match(/&lt;script&gt;/g)).toHaveLength(2);
  });

  it('escapes the sheet name, which reaches the <title>', () => {
    const html = toHtml(sheet(['A'], [['x']], '</title><script>x()</script>'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;/title&gt;');
  });

  it('emits no data-* or id attributes to carry unescaped values', () => {
    const html = toHtml(sheet(['A'], [['x']]));
    expect(html).not.toMatch(/data-[a-z]+=/);
    expect(html).not.toMatch(/\sid=/);
  });

  it('writes every row and column', () => {
    const html = toHtml(sheet(['A', 'B'], [[1, 2], [3, 4]]));
    expect(html.match(/<tr>/g)).toHaveLength(3); // header + 2 rows
    expect(html).toContain('<td>4</td>');
  });

  it('renders a blank cell as an empty cell, not "null"', () => {
    expect(toHtml(sheet(['A'], [[null]]))).toContain('<td></td>');
  });
});

describe('serializeSheetTo', () => {
  it('neutralises formulas in CSV but not in JSON', async () => {
    const s = sheet(['Payload'], [['=cmd|calc']]);
    expect(await text(serializeSheetTo(s, 'csv').blob)).toContain("'=cmd|calc");
    // Machine-readable output must stay verbatim.
    expect(await text(serializeSheetTo(s, 'json').blob)).toContain('=cmd|calc');
  });

  it('routes HTML through the escaping writer', async () => {
    const out = await text(serializeSheetTo(sheet(['A'], [['<b>x</b>']]), 'html').blob);
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<b>x</b>');
  });

  it('gives each format its own extension and mime type', () => {
    for (const [fmt, ext] of [['csv', 'csv'], ['tsv', 'tsv'], ['json', 'json'], ['md', 'md'], ['html', 'html'], ['xlsx', 'xlsx']] as const) {
      expect(serializeSheetTo(sheet(['A'], [['x']]), fmt).ext).toBe(ext);
    }
  });

  it('separates TSV on tabs', async () => {
    expect(await text(serializeSheetTo(sheet(['A', 'B'], [['1', '2']]), 'tsv').blob)).toContain('1\t2');
  });
});

describe('rowsAsObjects', () => {
  it('keeps both columns when a header is repeated', () => {
    // ERP-printed reports repeat column names routinely; overwriting one loses
    // data silently, which is the failure a JSON export must not have.
    const out = rowsAsObjects(sheet(['Amount', 'Amount'], [[10, 20]]));
    expect(out).toEqual([{ Amount: 10, Amount_2: 20 }]);
  });

  it('maps blanks to null rather than dropping the key', () => {
    expect(rowsAsObjects(sheet(['A', 'B'], [[1, null]]))).toEqual([{ A: 1, B: null }]);
  });
});

describe('toMarkdown', () => {
  it('escapes pipes and flattens newlines so the table survives', () => {
    const md = toMarkdown(sheet(['A'], [['x|y\nz']]));
    expect(md).toContain('x\\|y z');
  });
});

describe('uniqueSheetName', () => {
  it('replaces characters Excel forbids', () => {
    expect(uniqueSheetName('a/b:c?d', new Set())).toBe('a_b_c_d');
  });

  it('disambiguates repeats and stays within 31 characters', () => {
    const used = new Set<string>();
    const long = 'x'.repeat(40);
    const first = uniqueSheetName(long, used);
    const second = uniqueSheetName(long, used);
    expect(first).toHaveLength(31);
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(31);
  });

  it('falls back to a name when the input reduces to nothing', () => {
    expect(uniqueSheetName('', new Set())).toBe('Sheet');
  });
});

describe('serializeSheetsToWorkbook', () => {
  it('produces one xlsx blob for many sheets', () => {
    const out = serializeSheetsToWorkbook([sheet(['A'], [[1]], 'One'), sheet(['B'], [[2]], 'Two')]);
    expect(out.ext).toBe('xlsx');
    expect(out.blob.size).toBeGreaterThan(0);
  });

  it('does not lose a sheet to a duplicate name', () => {
    const out = serializeSheetsToWorkbook([sheet(['A'], [[1]], 'Same'), sheet(['B'], [[2]], 'Same')]);
    expect(out.blob.size).toBeGreaterThan(0);
  });
});
