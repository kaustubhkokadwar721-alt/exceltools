import { describe, it, expect } from 'vitest';
import {
  mergeStack,
  splitByColumn,
  splitByRows,
  splitBySheet,
  splitByDerived,
  splitByGroups,
  distinctValues,
  diffSheets,
  dedupeByKeys,
  cleanSheet,
  type NamedSheet,
} from '../../src/core/transform';
import type { SheetData, CellValue } from '../../src/core/types';

const sheet = (headers: string[], rows: CellValue[][], name = 'S'): SheetData => ({
  name,
  headers,
  rows,
  totalRows: rows.length,
});

describe('mergeStack', () => {
  it('aligns columns by header name and fills gaps with null', () => {
    const a: NamedSheet = { source: 'a.xlsx', sheet: sheet(['ID', 'Name'], [[1, 'Alice']]) };
    const b: NamedSheet = { source: 'b.xlsx', sheet: sheet(['Name', 'Age'], [['Bob', 30]]) };
    const out = mergeStack([a, b], false);
    expect(out.headers).toEqual(['ID', 'Name', 'Age']);
    expect(out.rows).toEqual([
      [1, 'Alice', null],
      [null, 'Bob', 30],
    ]);
    expect(out.totalRows).toBe(2);
  });

  it('prepends a Source column when requested', () => {
    const a: NamedSheet = { source: 'jan', sheet: sheet(['X'], [[1]]) };
    const b: NamedSheet = { source: 'feb', sheet: sheet(['X'], [[2]]) };
    const out = mergeStack([a, b], true);
    expect(out.headers).toEqual(['Source', 'X']);
    expect(out.rows).toEqual([
      ['jan', 1],
      ['feb', 2],
    ]);
  });
});

describe('splitByColumn', () => {
  it('groups rows by the distinct values of a column', () => {
    const s = sheet(['Dept', 'Amt'], [['Fin', 1], ['Ops', 2], ['Fin', 3]]);
    const parts = splitByColumn(s, 0);
    expect(parts.map((p) => p.key).sort()).toEqual(['Fin', 'Ops']);
    const fin = parts.find((p) => p.key === 'Fin')!;
    expect(fin.sheet.rows).toEqual([['Fin', 1], ['Fin', 3]]);
  });

  it('labels empty keys as (blank)', () => {
    const s = sheet(['K', 'V'], [[null, 1], ['', 2]]);
    const parts = splitByColumn(s, 0);
    expect(parts).toHaveLength(1);
    expect(parts[0].key).toBe('(blank)');
    expect(parts[0].sheet.rows).toHaveLength(2);
  });
});

describe('splitByRows', () => {
  it('chunks rows into fixed sizes with descriptive keys', () => {
    const s = sheet(['N'], [[1], [2], [3], [4], [5]]);
    const parts = splitByRows(s, 2);
    expect(parts.map((p) => p.key)).toEqual(['rows_1-2', 'rows_3-4', 'rows_5-5']);
    expect(parts[2].sheet.rows).toEqual([[5]]);
  });

  it('treats sizes below 1 as 1', () => {
    const s = sheet(['N'], [[1], [2]]);
    expect(splitByRows(s, 0)).toHaveLength(2);
  });
});

describe('splitBySheet', () => {
  it('makes one part per sheet, keyed on the tab name', () => {
    const parts = splitBySheet([sheet(['N'], [[1]], 'Jan'), sheet(['N'], [[2], [3]], 'Feb')]);
    expect(parts.map((p) => p.key)).toEqual(['Jan', 'Feb']);
    expect(parts[1].sheet.rows).toEqual([[2], [3]]);
  });
});

describe('splitByDerived', () => {
  const s = sheet(
    ['Ref', 'Amt'],
    [['INV-MH-0012', 1], ['INV-MH-0087', 2], ['INV-GJ-0041', 3], ['NOSEP', 4], [null, 5]],
  );

  it('keys on a piece of the value after a separator', () => {
    const parts = splitByDerived(s, 0, { kind: 'separator', sep: '-', piece: 2 });
    expect(parts.map((p) => p.key)).toEqual(['MH', 'GJ', '(unmatched)', '(blank)']);
    expect(parts[0].sheet.rows).toHaveLength(2);
  });

  it('keys on a fixed-length prefix', () => {
    const parts = splitByDerived(s, 0, { kind: 'prefix', length: 3 });
    expect(parts.map((p) => p.key)).toEqual(['INV', 'NOS', '(blank)']);
  });

  it('keys on a pattern capture group, else the whole match', () => {
    expect(splitByDerived(s, 0, { kind: 'pattern', source: '^([A-Z]+)' }).map((p) => p.key)).toEqual([
      'INV',
      'NOSEP',
      '(blank)',
    ]);
    expect(splitByDerived(s, 0, { kind: 'pattern', source: '-[A-Z]{2}-' }).map((p) => p.key)).toEqual([
      '-MH-',
      '-GJ-',
      '(unmatched)',
      '(blank)',
    ]);
  });

  it('throws on an invalid pattern rather than keying every row wrong', () => {
    expect(() => splitByDerived(s, 0, { kind: 'pattern', source: '^(' })).toThrow();
  });

  it('sanitises characters Excel rejects in a sheet name', () => {
    const withSlash = sheet(['K'], [['A/B']]);
    expect(splitByColumn(withSlash, 0)[0].sheet.name).toBe('A_B');
  });
});

describe('splitByGroups', () => {
  const s = sheet(['State', 'Amt'], [['MH', 1], ['GJ', 2], ['KA', 3], ['WB', 4]]);
  const assign = new Map([['MH', 'West'], ['GJ', 'West'], ['KA', 'South']]);

  it('collapses assigned values into shared files', () => {
    const parts = splitByGroups(s, 0, assign, 'own');
    expect(parts.map((p) => p.key)).toEqual(['West', 'South', 'WB']);
    expect(parts[0].sheet.rows).toEqual([['MH', 1], ['GJ', 2]]);
  });

  it('collects unassigned values into (other) when asked', () => {
    const parts = splitByGroups(s, 0, assign, 'other');
    expect(parts.map((p) => p.key)).toEqual(['West', 'South', '(other)']);
  });
});

describe('distinctValues', () => {
  it('counts values, commonest first, labelling blanks', () => {
    const s = sheet(['D'], [['Fin'], ['Ops'], ['Fin'], [null]]);
    expect(distinctValues(s, 0)).toEqual([
      { value: 'Fin', count: 2 },
      { value: '(blank)', count: 1 },
      { value: 'Ops', count: 1 },
    ]);
  });
});

describe('diffSheets', () => {
  const a = sheet(['ID', 'Name', 'Salary'], [[1, 'Alice', 100], [2, 'Bob', 200], [3, 'Carol', 300]]);
  const b = sheet(['ID', 'Name', 'Salary'], [[1, 'Alice', 100], [2, 'Bob', 250], [4, 'Dave', 400]]);

  it('classifies rows into only-A, only-B, changed and same', () => {
    const { summary } = diffSheets(a, b, 0, 0);
    expect(summary).toMatchObject({ onlyA: 1, onlyB: 1, changed: 1, same: 1 });
  });

  it('records the changed field with old and new values', () => {
    const { sheet: out } = diffSheets(a, b, 0, 0);
    const changed = out.rows.find((r) => r[0] === 'Changed')!;
    expect(String(changed[1])).toContain('Salary');
    expect(String(changed[1])).toContain('200');
    expect(String(changed[1])).toContain('250');
  });

  it('counts duplicate keys within a side', () => {
    const dupA = sheet(['ID', 'V'], [[1, 'x'], [1, 'y']]);
    const { summary } = diffSheets(dupA, sheet(['ID', 'V'], [[1, 'y']]), 0, 0);
    expect(summary.dupKeysA).toBe(1);
  });
});

describe('dedupeByKeys', () => {
  const s = sheet(
    ['Invoice', 'Vendor'],
    [['INV-1', 'Acme'], ['INV-2', 'Beta'], ['INV-1', 'acme '], ['INV-1', 'ACME']],
  );

  it('dedupes on the key column, folding case and whitespace', () => {
    const r = dedupeByKeys(s, [0], 'first');
    expect(r.kept).toBe(2);
    expect(r.removed).toBe(2);
    expect(r.duplicateGroups).toBe(1);
    expect(r.sheet.rows[0]).toEqual(['INV-1', 'Acme']); // first occurrence kept
  });

  it('keeps the last occurrence when asked', () => {
    const r = dedupeByKeys(s, [0], 'last');
    expect(r.sheet.rows.find((row) => row[0] === 'INV-1')).toEqual(['INV-1', 'ACME']);
  });

  it('falls back to whole-row match when no keys are given', () => {
    const w = sheet(['A', 'B'], [[1, 2], [1, 2], [1, 3]]);
    expect(dedupeByKeys(w, [], 'first').kept).toBe(2);
  });
});

describe('cleanSheet', () => {
  const base = () =>
    sheet(['Name', 'City', 'Amount'], [[' Alice ', 'new  york', '1,000'], ['', ' ', ''], ['carol', 'boston', '3500']]);

  const opts = (over: Partial<Parameters<typeof cleanSheet>[1]> = {}) => ({
    trim: false,
    collapseSpaces: false,
    caseMode: 'none' as const,
    numbersFromText: false,
    removeBlankRows: false,
    removeBlankCols: false,
    ...over,
  });

  it('trims and collapses whitespace', () => {
    const r = cleanSheet(base(), opts({ trim: true, collapseSpaces: true }));
    expect(r.sheet.rows[0][0]).toBe('Alice');
    expect(r.sheet.rows[0][1]).toBe('new york');
  });

  it('converts numeric text to real numbers', () => {
    const r = cleanSheet(base(), opts({ numbersFromText: true }));
    expect(r.sheet.rows[0][2]).toBe(1000);
    expect(r.sheet.rows[2][2]).toBe(3500);
    expect(r.numbersConverted).toBe(2);
  });

  it('removes fully blank rows', () => {
    const r = cleanSheet(base(), opts({ removeBlankRows: true }));
    expect(r.rowsRemoved).toBe(1);
    expect(r.sheet.totalRows).toBe(2);
  });

  it('applies title case', () => {
    const r = cleanSheet(base(), opts({ caseMode: 'title' }));
    expect(r.sheet.rows[2][0]).toBe('Carol');
  });
});

describe('dedupeByKeys — composite keys', () => {
  // Joining key parts on '' would flatten ("INV-1","2ACME") and ("INV-12","ACME")
  // to the same signature, so one genuine invoice would vanish as a "duplicate".
  it('does not collide across column boundaries', () => {
    const s: SheetData = {
      name: 'S',
      headers: ['InvoiceNo', 'Vendor'],
      rows: [
        ['INV-1', '2ACME'],
        ['INV-12', 'ACME'],
      ],
      totalRows: 2,
    };
    const r = dedupeByKeys(s, [0, 1], 'first');
    expect(r.kept).toBe(2);
    expect(r.removed).toBe(0);
    expect(r.duplicateGroups).toBe(0);
  });

  it('still folds case and whitespace within each key part', () => {
    const s: SheetData = {
      name: 'S',
      headers: ['A', 'B'],
      rows: [
        ['Acme', 'X'],
        [' acme ', 'x'],
      ],
      totalRows: 2,
    };
    expect(dedupeByKeys(s, [0, 1], 'first').kept).toBe(1);
  });
});

describe('cleanSheet — figures that stayed as text', () => {
  const withValues = (values: string[]): SheetData => ({
    name: 'S',
    headers: ['Amount'],
    rows: values.map((v) => [v]),
    totalRows: values.length,
  });
  const opts = {
    trim: true,
    collapseSpaces: false,
    caseMode: 'none' as const,
    numbersFromText: true,
    removeBlankRows: false,
    removeBlankCols: false,
  };

  it('converts the accounting formats Excel exports actually use', () => {
    const r = cleanSheet(withValues(['1,00,000', '(1,000)', '1000-', '₹500']), opts);
    expect(r.sheet.rows.map((row) => row[0])).toEqual([100000, -1000, -1000, 500]);
    expect(r.numbersConverted).toBe(4);
    expect(r.numbersUnconverted).toBe(0);
  });

  it('reports figures it could not read instead of passing them over', () => {
    const r = cleanSheet(withValues(['1,000', '1.000,50', '12,3456']), opts);
    expect(r.numbersConverted).toBe(1);
    expect(r.numbersUnconverted).toBe(2);
    expect(r.unconvertedSamples).toEqual(['1.000,50', '12,3456']);
  });

  it('does not count ordinary text as a failed number', () => {
    const r = cleanSheet(withValues(['Acme Traders', 'N/A']), opts);
    expect(r.numbersUnconverted).toBe(0);
  });
});
