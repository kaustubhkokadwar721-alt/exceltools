import { describe, it, expect } from 'vitest';
import { snippetsFor, type SnippetContext } from '../../src/core/snippets';

const ctx = (over: Partial<SnippetContext> = {}): SnippetContext => ({
  pandas: true,
  charts: true,
  tables: [
    {
      name: 'payroll',
      columns: [
        { name: 'Dept', kind: 'text' },
        { name: 'Amount', kind: 'number' },
        { name: 'Posted Date', kind: 'text' },
      ],
    },
  ],
  ...over,
});

describe('snippetsFor', () => {
  it('writes the recipes against the user\'s own table and column names', () => {
    const totals = snippetsFor(ctx()).find((s) => s.id === 'total-by')!;
    expect(totals.label).toBe('Total Amount by Dept');
    expect(totals.code).toContain('df_payroll');
    expect(totals.code).toContain('.groupby("Dept", as_index=False)["Amount"]');
  });

  it('quotes headings safely, including ones with spaces and quotes', () => {
    const s = snippetsFor(
      ctx({ tables: [{ name: 't', columns: [{ name: 'Cost "net"', kind: 'text' }, { name: 'Amt', kind: 'number' }] }] }),
    ).find((x) => x.id === 'count-by')!;
    expect(s.code).toContain('["Cost \\"net\\""]');
  });

  it('offers nothing at all until a table is registered', () => {
    expect(snippetsFor(ctx({ tables: [] }))).toEqual([]);
  });

  it('leaves out chart recipes when matplotlib is missing', () => {
    const ids = snippetsFor(ctx({ charts: false })).map((s) => s.id);
    expect(ids).not.toContain('bar');
    expect(ids).toContain('total-by');
  });

  it('offers a time trend only when a column looks like a date', () => {
    expect(snippetsFor(ctx()).map((s) => s.id)).toContain('trend');
    const noDate = ctx({ tables: [{ name: 'p', columns: [{ name: 'Dept', kind: 'text' }, { name: 'Amt', kind: 'number' }] }] });
    expect(snippetsFor(noDate).map((s) => s.id)).not.toContain('trend');
  });

  it('offers table comparisons only once a second table exists', () => {
    expect(snippetsFor(ctx()).map((s) => s.id)).not.toContain('missing-from');
    const two = ctx({
      tables: [
        ...ctx().tables,
        { name: 'ledger', columns: [{ name: 'Dept', kind: 'text' }, { name: 'Amount', kind: 'number' }] },
      ],
    });
    const compare = snippetsFor(two).find((s) => s.id === 'missing-from')!;
    expect(compare.code).toContain('df_payroll.merge(df_ledger, on="Dept"');
  });

  it('falls back to plain Python when pandas is unavailable', () => {
    const list = snippetsFor(ctx({ pandas: false }));
    expect(list.every((s) => !s.code.includes('df_'))).toBe(true);
    expect(list.find((s) => s.id === 'total-plain')!.code).toContain('tables["payroll"]');
  });

  it('totals the money column, not the invoice number next to it', () => {
    const withIds = ctx({
      tables: [
        {
          name: 'ledger',
          columns: [
            { name: 'ID', kind: 'number' },
            { name: 'Voucher No', kind: 'number' },
            { name: 'Dept', kind: 'text' },
            { name: 'Amount', kind: 'number' },
          ],
        },
      ],
    });
    expect(snippetsFor(withIds).find((s) => s.id === 'total-by')!.label).toBe('Total Amount by Dept');
  });

  it('never offers to total a date, which Excel hands over as a number', () => {
    const dates = ctx({
      tables: [
        {
          name: 'returns',
          columns: [
            { name: 'PeriodDate', kind: 'number' },
            { name: 'ReturnType', kind: 'text' },
            { name: 'PrimaryAmount', kind: 'number' },
          ],
        },
      ],
    });
    expect(snippetsFor(dates).find((s) => s.id === 'total-by')!.label).toBe('Total PrimaryAmount by ReturnType');
  });

  it('falls back to an identifier column only when nothing else is numeric', () => {
    const idsOnly = ctx({
      tables: [{ name: 't', columns: [{ name: 'Dept', kind: 'text' }, { name: 'Ref No', kind: 'number' }] }],
    });
    expect(snippetsFor(idsOnly).find((s) => s.id === 'total-by')!.label).toBe('Total Ref No by Dept');
  });

  it('skips numeric recipes when no column holds numbers', () => {
    const textOnly = ctx({ tables: [{ name: 't', columns: [{ name: 'Dept', kind: 'text' }, { name: 'Ref', kind: 'text' }] }] });
    const ids = snippetsFor(textOnly).map((s) => s.id);
    expect(ids).not.toContain('total-by');
    expect(ids).toContain('count-by');
  });
});
