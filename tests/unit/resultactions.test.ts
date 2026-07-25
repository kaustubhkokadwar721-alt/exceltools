import { describe, it, expect } from 'vitest';
import { toTsv } from '../../src/ui/resultactions';

describe('toTsv', () => {
  it('produces the tab-separated shape a spreadsheet pastes into cells', () => {
    const tsv = toTsv({
      name: 'Result',
      headers: ['Dept', 'Amount'],
      rows: [
        ['Fin', 1650],
        ['Ops', 1450],
      ],
      totalRows: 2,
    });
    expect(tsv).toBe('Dept\tAmount\nFin\t1650\nOps\t1450');
  });

  it('writes blanks for empty cells rather than the word null', () => {
    const tsv = toTsv({ name: 'r', headers: ['A', 'B'], rows: [[null, 0]], totalRows: 1 });
    expect(tsv).toBe('A\tB\n\t0');
  });

  it('flattens tabs and newlines inside values so columns stay aligned', () => {
    const tsv = toTsv({ name: 'r', headers: ['Note'], rows: [['line one\nline two\tthird']], totalRows: 1 });
    expect(tsv).toBe('Note\nline one line two third');
    expect(tsv.split('\n')).toHaveLength(2);
  });
});
