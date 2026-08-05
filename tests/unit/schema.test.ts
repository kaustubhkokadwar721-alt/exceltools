import { describe, it, expect } from 'vitest';
import { profileColumn, describeColumn, sampleRowsText, schemaTextForAI } from '../../src/core/schema';
import type { SheetData } from '../../src/core/types';

function sheet(headers: string[], rows: (string | number | boolean | null)[][]): SheetData {
  return { name: 'S', headers, rows, totalRows: rows.length } as SheetData;
}

describe('profileColumn', () => {
  it('counts blanks across the whole column, not a sample', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i < 300 ? null : 'x']);
    const p = profileColumn(sheet(['A'], rows), 0);
    expect(p.blanks).toBe(300);
    expect(p.rows).toBe(500);
  });

  it('treats null, undefined and empty string alike as blank', () => {
    const p = profileColumn(sheet(['A'], [[null], [undefined as never], [''], ['x']]), 0);
    expect(p.blanks).toBe(3);
    expect(p.distinct).toBe(1);
  });

  it('counts distinct non-blank values', () => {
    const p = profileColumn(sheet(['Status'], [['Filed'], ['Late'], ['Filed'], [null]]), 0);
    expect(p.distinct).toBe(2);
    expect(p.kind).toBe('text');
  });

  it('gives up on distinct once the count stops summarising anything', () => {
    const rows = Array.from({ length: 200 }, (_, i) => [`INV-${i}`]);
    expect(profileColumn(sheet(['Ref'], rows), 0).distinct).toBeNull();
  });

  it('does not conflate the number 1 with the string "1"', () => {
    // They print the same, so a naive String() key would count one value where
    // a mixed column actually has two.
    const p = profileColumn(sheet(['A'], [[1], ['1']]), 0);
    expect(p.distinct).toBe(2);
  });

  it('reports a numeric column as number even when some rows are blank', () => {
    const p = profileColumn(sheet(['Amt'], [[100], [null], [250]]), 0);
    expect(p.kind).toBe('number');
    expect(p.blanks).toBe(1);
  });
});

describe('describeColumn', () => {
  it('leads with blanks, because that is what breaks a total', () => {
    expect(describeColumn({ kind: 'number', blanks: 4, distinct: 20, rows: 24 })).toBe('number · 4 blank');
  });

  it('falls back to the count of different values when nothing is missing', () => {
    expect(describeColumn({ kind: 'text', blanks: 0, distinct: 3, rows: 24 })).toBe('text · 3 unique');
  });

  it('says nothing extra about a column that is all distinct or uncounted', () => {
    expect(describeColumn({ kind: 'text', blanks: 0, distinct: null, rows: 200 })).toBe('text');
    expect(describeColumn({ kind: 'text', blanks: 0, distinct: 24, rows: 24 })).toBe('text');
  });

  it('groups digits so a large blank count stays readable', () => {
    const out = describeColumn({ kind: 'number', blanks: 12000, distinct: null, rows: 50000 });
    expect(out).toBe(`number · ${(12000).toLocaleString()} blank`);
  });
});

describe('sampleRowsText', () => {
  const s = sheet(
    ['Ref', 'Date', 'Amount'],
    [
      ['INV-1', '31-03-2025', 1200.5],
      ['INV-2', '01-04-2025', null],
      ['INV-3', '02-04-2025', 90],
    ],
  );

  it('shows the header row and the values as they are actually written', () => {
    const out = sampleRowsText(s, 2);
    expect(out[0]).toBe('  First 2 rows:');
    expect(out[1]).toBe('    Ref | Date | Amount');
    // The date format is the whole point: a type alone would say "text".
    expect(out[2]).toBe('    INV-1 | 31-03-2025 | 1200.5');
    expect(out).toHaveLength(4);
  });

  it('leaves a blank cell blank rather than inventing a value for it', () => {
    expect(sampleRowsText(s, 2)[3]).toBe('    INV-2 | 01-04-2025 | ');
  });

  it('asks for more rows than exist without padding the table out', () => {
    expect(sampleRowsText(s, 50)).toHaveLength(5); // label + header + 3
    expect(sampleRowsText(sheet(['A'], []), 5)).toEqual([]);
  });

  it('cuts a long free-text cell instead of pasting an essay', () => {
    const long = sheet(['Note'], [['x'.repeat(400)]]);
    const line = sampleRowsText(long, 1)[2];
    expect(line.length).toBeLessThan(70);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('schemaTextForAI', () => {
  const tables = [{ name: 'sales', sheet: sheet(['City', 'Amt'], [['Pune', 100], ['Delhi', 250]]) }];
  const engine = { pandas: true, charts: true };

  it('carries no cell values at all by default', () => {
    const out = schemaTextForAI(tables, engine);
    expect(out).toContain('Table "sales" (DataFrame df_sales)');
    expect(out).toContain('"Amt" number');
    expect(out).not.toContain('Pune');
    expect(out).not.toContain('First');
  });

  it('adds the sample rows, and says they are a preview of a larger table', () => {
    const out = schemaTextForAI(tables, engine, 5);
    expect(out).toContain('First 2 rows:');
    expect(out).toContain('    Pune | 100');
    expect(out).toContain('write code against the whole table, not these rows');
  });

  it('names the plain-Python variables when pandas is absent', () => {
    const out = schemaTextForAI(tables, { pandas: false, charts: false }, 5);
    expect(out).toContain('Table "sales" —');
    expect(out).not.toContain('DataFrame');
    expect(out).toContain('    Pune | 100');
  });
});
