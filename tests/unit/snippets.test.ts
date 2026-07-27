import { describe, it, expect } from 'vitest';
import {
  snippetsFor,
  defaultValues,
  renderTemplate,
  columnChoices,
  type SnippetContext,
  type Snippet,
} from '../../src/core/snippets';

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

/** What the panel shows and inserts when nobody touches a dropdown. */
const asDefault = (s: Snippet, c: SnippetContext) => ({
  title: renderTemplate(s.template, defaultValues(s)),
  code: s.build(defaultValues(s), c),
});

const find = (c: SnippetContext, id: string): Snippet => {
  const s = snippetsFor(c).find((x) => x.id === id);
  if (!s) throw new Error(`no recipe "${id}"`);
  return s;
};

describe('snippetsFor', () => {
  it("writes the recipes against the user's own table and column names", () => {
    const { title, code } = asDefault(find(ctx(), 'total-by'), ctx());
    expect(title).toBe('Total Amount by Dept');
    expect(code).toContain('df_payroll');
    expect(code).toContain('.groupby("Dept", as_index=False)["Amount"]');
  });

  it('quotes headings safely, including ones with spaces and quotes', () => {
    const c = ctx({ tables: [{ name: 't', columns: [{ name: 'Cost "net"', kind: 'text' }, { name: 'Amt', kind: 'number' }] }] });
    expect(asDefault(find(c, 'count-by'), c).code).toContain('["Cost \\"net\\""]');
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
      tables: [...ctx().tables, { name: 'ledger', columns: [{ name: 'Dept', kind: 'text' }, { name: 'Amount', kind: 'number' }] }],
    });
    expect(asDefault(find(two, 'missing-from'), two).code).toContain('df_payroll.merge(df_ledger, on="Dept"');
  });

  it('falls back to plain Python when pandas is unavailable', () => {
    const c = ctx({ pandas: false });
    const list = snippetsFor(c);
    expect(list.every((s) => !s.build(defaultValues(s), c).includes('df_'))).toBe(true);
    expect(asDefault(find(c, 'total-plain'), c).code).toContain('tables["payroll"]');
  });

  it('totals the money column, not the invoice number next to it', () => {
    const c = ctx({
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
    expect(asDefault(find(c, 'total-by'), c).title).toBe('Total Amount by Dept');
  });

  it('never offers to total a date, which Excel hands over as a number', () => {
    const c = ctx({
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
    expect(asDefault(find(c, 'total-by'), c).title).toBe('Total PrimaryAmount by ReturnType');
  });

  it('skips numeric recipes when no column holds numbers', () => {
    const c = ctx({ tables: [{ name: 't', columns: [{ name: 'Dept', kind: 'text' }, { name: 'Ref', kind: 'text' }] }] });
    const ids = snippetsFor(c).map((s) => s.id);
    expect(ids).not.toContain('total-by');
    expect(ids).toContain('count-by');
  });
});

describe('recipe parameters', () => {
  it('rebuilds the code around whichever columns the user picks', () => {
    const c = ctx({
      tables: [
        {
          name: 'gst',
          columns: [
            { name: 'Status', kind: 'text' },
            { name: 'EntityName', kind: 'text' },
            { name: 'PrimaryAmount', kind: 'number' },
            { name: 'TaxAmount', kind: 'number' },
          ],
        },
      ],
    });
    const totals = find(c, 'total-by');
    expect(renderTemplate(totals.template, defaultValues(totals))).toBe('Total PrimaryAmount by Status');

    // The user changes both dropdowns — no Python edited.
    const chosen = { ...defaultValues(totals), value: 'TaxAmount', group: 'EntityName' };
    expect(renderTemplate(totals.template, chosen)).toBe('Total TaxAmount by EntityName');
    expect(totals.build(chosen, c)).toContain('.groupby("EntityName", as_index=False)["TaxAmount"]');
  });

  it('lets the user switch which table a step runs on', () => {
    const c = ctx({
      tables: [
        ...ctx().tables,
        { name: 'ledger', columns: [{ name: 'Branch', kind: 'text' }, { name: 'Value', kind: 'number' }] },
      ],
    });
    const peek = find(c, 'peek');
    expect(peek.build(defaultValues(peek), c)).toBe('df_payroll.head(20)');
    expect(peek.build({ table: 'ledger' }, c)).toBe('df_ledger.head(20)');
  });

  it('offers only the columns of the chosen table, restricted by kind', () => {
    const c = ctx({
      tables: [
        ...ctx().tables,
        { name: 'ledger', columns: [{ name: 'Branch', kind: 'text' }, { name: 'Value', kind: 'number' }] },
      ],
    });
    expect(columnChoices(c, 'ledger').map((x) => x.name)).toEqual(['Branch', 'Value']);
    expect(columnChoices(c, 'ledger', ['number']).map((x) => x.name)).toEqual(['Value']);
    // Never an empty dropdown — a loose match beats no choice.
    expect(columnChoices(c, 'ledger', ['boolean']).map((x) => x.name)).toEqual(['Branch', 'Value']);
    expect(columnChoices(c, 'nope').length).toBeGreaterThan(0); // unknown table → first
  });

  it('every recipe declares a default for each parameter, and every placeholder resolves', () => {
    const c = ctx({
      tables: [...ctx().tables, { name: 'ledger', columns: [{ name: 'Dept', kind: 'text' }, { name: 'Value', kind: 'number' }] }],
    });
    for (const s of snippetsFor(c)) {
      const values = defaultValues(s);
      for (const p of s.params) expect(values[p.id], `${s.id}.${p.id}`).toBeTruthy();
      expect(renderTemplate(s.template, values), s.id).not.toMatch(/[{}]/);
      expect(s.build(values, c), s.id).toBeTruthy();
    }
  });
});

describe('grouping column default', () => {
  const t = (columns: { name: string; kind: 'text' | 'number' | 'boolean'; distinct?: number | null }[]) => ({
    tables: [{ name: 'returns', columns }],
    pandas: true,
    charts: false,
  });

  it('does not group by a reference column, however few text columns there are', () => {
    // Type detection reads "Invoice No" as text, so "first text column" started
    // choosing it — and grouping by it returns one row per invoice, which is the
    // table you already had.
    const s = snippetsFor(
      t([
        { name: 'Invoice No', kind: 'text', distinct: null },
        { name: 'Entity Name', kind: 'text', distinct: 3 },
        { name: 'Amount', kind: 'number' },
      ]),
    ).find((x) => x.id === 'total-by');
    expect(s).toBeDefined();
    expect(defaultValues(s!).group).toBe('Entity Name');
  });

  it('prefers a party or place over a yes/no flag with fewer values', () => {
    // "Total by Active" splits the data in two; "Total by Entity Name" is the
    // step somebody actually wanted, even though it has more distinct values.
    const s = snippetsFor(
      t([
        { name: 'Active', kind: 'boolean', distinct: 2 },
        { name: 'Entity Name', kind: 'text', distinct: 3 },
        { name: 'Amount', kind: 'number' },
      ]),
    ).find((x) => x.id === 'total-by');
    expect(defaultValues(s!).group).toBe('Entity Name');
  });

  it('prefers the column with the fewest distinct values', () => {
    const s = snippetsFor(
      t([
        { name: 'City', kind: 'text', distinct: 40 },
        { name: 'Status', kind: 'text', distinct: 3 },
        { name: 'Amount', kind: 'number' },
      ]),
    ).find((x) => x.id === 'total-by');
    expect(defaultValues(s!).group).toBe('Status');
  });

  it('still offers something when nothing has a distinct count', () => {
    const s = snippetsFor(
      t([{ name: 'Region', kind: 'text' }, { name: 'Amount', kind: 'number' }]),
    ).find((x) => x.id === 'total-by');
    expect(defaultValues(s!).group).toBe('Region');
  });
});
