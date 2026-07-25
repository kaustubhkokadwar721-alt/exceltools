import { describe, it, expect } from 'vitest';
import { compareValues, groupDigits } from '../../src/ui/datagrid';

describe('groupDigits', () => {
  it('groups the integer part in the viewer\'s own locale', () => {
    // Node's default locale here is en-US; an en-IN browser gets 16,43,552.
    expect(groupDigits(1643552)).toBe(new Intl.NumberFormat(undefined).format(1643552));
    expect(groupDigits(1643552)).toMatch(/\d[,  .]\d/);
  });

  it('keeps every decimal exactly as the number prints', () => {
    expect(groupDigits(1234.5)).toContain('.5');
    expect(groupDigits(0.30000000000000004)).toContain('.30000000000000004');
    expect(groupDigits(12.75)).toContain('.75');
  });

  it('keeps the sign and small numbers unchanged in shape', () => {
    expect(groupDigits(-4200).startsWith('-')).toBe(true);
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(999)).toBe('999');
  });

  it('leaves values it cannot safely regroup exactly as they were', () => {
    expect(groupDigits(1e21)).toBe(String(1e21)); // exponent form
    expect(groupDigits(NaN)).toBe('NaN');
    expect(groupDigits(Infinity)).toBe('Infinity');
  });
});

describe('compareValues', () => {
  const sorted = <T>(xs: T[]) => [...xs].sort((a, b) => compareValues(a as never, b as never));

  it('orders numbers by value, not as text', () => {
    expect(sorted([1000, 9, 250])).toEqual([9, 250, 1000]);
    expect(sorted([-5, 0, 3.5])).toEqual([-5, 0, 3.5]);
  });

  it('orders text the way a person reads it, including embedded numbers', () => {
    expect(sorted(['Item 10', 'Item 2'])).toEqual(['Item 2', 'Item 10']);
    expect(sorted(['delta', 'Alpha'])).toEqual(['Alpha', 'delta']); // case-insensitive
  });

  it('orders booleans false before true', () => {
    expect(sorted([true, false, true])).toEqual([false, true, true]);
  });

  it('compares mixed types as text rather than throwing', () => {
    expect(() => compareValues(5, 'five')).not.toThrow();
    expect(compareValues(5, 5)).toBe(0);
  });
});
