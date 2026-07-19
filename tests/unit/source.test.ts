import { describe, it, expect } from 'vitest';
import { buildDefaultSpec, resolveSource } from '../../src/core/source';
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
  it('includes every column with auto type', () => {
    const s = buildDefaultSpec(def);
    expect(s.name).toBe('Sales');
    expect(s.skipTypeDetection).toBe(false);
    expect(s.columns.map((c) => c.source)).toEqual(['Order', 'Amount', 'City']);
    expect(s.columns.every((c) => c.include && c.type === 'auto')).toBe(true);
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
