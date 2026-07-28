import { describe, it, expect } from 'vitest';
import { buildDefaultSpec, resolveSource, prepareSheet } from '../../src/core/source';
import type { TableDef, SourceSpec } from '../../src/core/types';

const def: TableDef = {
  name: 'Sales',
  sheetName: 'Data',
  ref: 'A1:C4',
  columns: ['Order', 'Amount', 'City'],
  grid: [
    ['Order', 'Amount', 'City'],
    ['ORD-1', '1,000', 'Pune'],
    ['ORD-2', '2,500', 'Delhi'],
    ['ORD-3', '', 'Pune'],
  ],
};

describe('buildDefaultSpec', () => {
  it('includes every column and decides its type up front', () => {
    // The type the user sees is the type they get. Leaving "Auto" in the card
    // meant registering a table and still not knowing what it had settled on.
    const s = buildDefaultSpec(def);
    expect(s.name).toBe('Sales');
    expect(s.skipTypeDetection).toBe(false);
    expect(s.columns.map((c) => c.source)).toEqual(['Order', 'Amount', 'City']);
    expect(s.columns.every((c) => c.include)).toBe(true);
    expect(s.columns.map((c) => c.type)).toEqual(['text', 'number', 'text']);
    expect(s.columns.every((c) => c.type !== 'auto')).toBe(true);
  });

  it('cleans column names while keeping them readable', () => {
    const messy: TableDef = {
      ...def,
      columns: ['Order\nNo', 'Amount (INR)', 'City'],
      grid: [['Order\nNo', 'Amount (INR)', 'City'], ['ORD-1', '1,000', 'Pune']],
    };
    expect(buildDefaultSpec(messy).columns.map((c) => c.name)).toEqual(['Order No', 'Amount INR', 'City']);
    // The source key still matches the header in the file, so the column is
    // still found when the spec is resolved.
    expect(buildDefaultSpec(messy).columns[0].source).toBe('Order\nNo');
  });
});

describe('resolveSource', () => {
  it('auto-infers a numeric column and coerces "1,000" → 1000', () => {
    const out = resolveSource(def, buildDefaultSpec(def));
    expect(out.headers).toEqual(['Order', 'Amount', 'City']);
    expect(out.rows[0]).toEqual(['ORD-1', 1000, 'Pune']);
    expect(out.rows[1][1]).toBe(2500);
    expect(out.rows[2][1]).toBe(null); // blank → null
  });

  it('drops excluded columns and renames included ones', () => {
    const spec: SourceSpec = {
      name: 'orders',
      skipTypeDetection: false,
      columns: [
        { source: 'Order', name: 'id', include: true, type: 'text' },
        { source: 'Amount', name: 'amt', include: true, type: 'number' },
        { source: 'City', name: 'City', include: false, type: 'auto' },
      ],
    };
    const out = resolveSource(def, spec);
    expect(out.headers).toEqual(['id', 'amt']);
    expect(out.rows[0]).toEqual(['ORD-1', 1000]);
  });

  it('skipTypeDetection keeps everything as text', () => {
    const spec = { ...buildDefaultSpec(def), skipTypeDetection: true };
    const out = resolveSource(def, spec);
    expect(out.rows[0][1]).toBe('1,000'); // not coerced to a number
    expect(typeof out.rows[1][1]).toBe('string');
  });
});

describe('prepareSheet', () => {
  const sheet = {
    name: 'Returns',
    headers: ['Invoice No', 'Amount (INR)', 'Month', 'Entity\nName'],
    rows: [
      ['2001', '1,000', '4', 'Acme'],
      ['2002', '2,500', '5', 'Bharat'],
    ],
    totalRows: 2,
  };

  it('cleans the headers a plain sheet arrives with', () => {
    expect(prepareSheet(sheet).sheet.headers).toEqual(['Invoice No', 'Amount INR', 'Month', 'Entity Name']);
  });

  it('gives a plain sheet the same types a native table would get', () => {
    // Same data, saved two ways, must not produce two different answers.
    expect(prepareSheet(sheet).types).toEqual(['text', 'number', 'text', 'text']);
  });

  it('leaves a reference and a month as text, and coerces only the money', () => {
    const out = prepareSheet(sheet).sheet;
    expect(out.rows[0]).toEqual(['2001', 1000, '4', 'Acme']);
  });
});
