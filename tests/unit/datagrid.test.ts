import { describe, it, expect } from 'vitest';
import { compareValues, groupDigits } from '../../src/ui/datagrid';

describe('groupDigits', () => {
  it('groups the integer part in the viewer\'s own locale', () => {
    // Node's default locale here is en-US; an en-IN browser gets 16,43,552.
    expect(groupDigits(1643552)).toBe(new Intl.NumberFormat(undefined).format(1643552));
    expect(groupDigits(1643552)).toMatch(/\d[,  .]\d/);
  });

  it('keeps a short decimal exactly as written', () => {
    expect(groupDigits(1234.5)).toContain('.5');
    expect(groupDigits(12.75)).toContain('.75');
    expect(groupDigits(1.234)).toContain('.234');
  });

  it('trims a float to three places, because the tail is arithmetic noise', () => {
    // These come out of a division or a rate; the digits past the third are an
    // artefact of binary floating point, not information anyone is reading.
    expect(groupDigits(0.30000000000000004)).toBe('0.3');
    expect(groupDigits(33.33333333333333)).toBe('33.333');
    expect(groupDigits(2 / 3)).toBe('0.667');
  });

  it('leaves whole numbers whole — a count of 24 is not 24.000', () => {
    expect(groupDigits(24)).toBe('24');
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(1643552)).not.toContain('.');
  });

  it('carries a rounding that reaches the integer part', () => {
    expect(groupDigits(1.9999)).toBe('2');
    expect(groupDigits(-2.66666)).toBe('-2.667');
    expect(groupDigits(999.9999)).toBe('1,000');
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
