import { describe, it, expect } from 'vitest';
import { neutralizeFormula, neutralizeSheet } from '../../src/core/csvsafe';

describe('neutralizeFormula', () => {
  it('defuses the payloads Excel would execute on open', () => {
    expect(neutralizeFormula(`=cmd|'/c calc'!A1`)).toBe(`'=cmd|'/c calc'!A1`);
    expect(neutralizeFormula('=1+1')).toBe("'=1+1");
    expect(neutralizeFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeFormula('+HYPERLINK("http://evil","click")')).toBe(`'+HYPERLINK("http://evil","click")`);
    expect(neutralizeFormula('-2+3+cmd|')).toBe("'-2+3+cmd|");
    expect(neutralizeFormula('\tcmd')).toBe("'\tcmd");
    expect(neutralizeFormula('\r=1+1')).toBe("'\r=1+1");
  });

  it('leaves finance data that merely starts with a risky character alone', () => {
    // Numbers stored as text are ordinary; quoting them would corrupt the data.
    expect(neutralizeFormula('-5')).toBe('-5');
    expect(neutralizeFormula('-1643552.25')).toBe('-1643552.25');
    expect(neutralizeFormula('+919876543210')).toBe('+919876543210');
    expect(neutralizeFormula('-1e6')).toBe('-1e6');
  });

  it('leaves everything else exactly as it was', () => {
    for (const v of ['Invoice #123', 'GSTR-3B', 'Acme Traders', '1,643,552', '', ' leading space', 'a=b']) {
      expect(neutralizeFormula(v)).toBe(v);
    }
  });
});

describe('neutralizeSheet', () => {
  it('covers headings as well as cells — a crafted heading carries a payload too', () => {
    const safe = neutralizeSheet({
      name: 'Sheet1',
      headers: ['Dept', '=IMPORTXML("http://evil","//x")'],
      rows: [['Fin', '=1+1']],
      totalRows: 1,
    });
    expect(safe.headers).toEqual(['Dept', `'=IMPORTXML("http://evil","//x")`]);
    expect(safe.rows).toEqual([['Fin', "'=1+1"]]);
  });

  it('does not touch non-text values, and does not mutate the original', () => {
    const original = { name: 'S', headers: ['A', 'B', 'C'], rows: [[1643552, true, null]], totalRows: 1 };
    const safe = neutralizeSheet(original);
    expect(safe.rows).toEqual([[1643552, true, null]]);
    expect(original.rows[0]).toEqual([1643552, true, null]);
    expect(safe.rows).not.toBe(original.rows);
  });
});
