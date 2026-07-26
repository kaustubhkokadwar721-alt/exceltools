// Numbers that arrived as text.
//
// A figure left as text is dropped from every later SUM with no error, so these
// cases are about totals coming out right rather than about parsing pedantry.
import { describe, it, expect } from 'vitest';
import { numberFromText, looksNumericButUnparsed } from '../../src/core/numtext';

const val = (s: string) => numberFromText(s)?.value ?? null;

describe('numberFromText', () => {
  it('reads plain and Western-grouped figures', () => {
    expect(val('42')).toBe(42);
    expect(val('1,000')).toBe(1000);
    expect(val('1,234,567')).toBe(1234567);
    expect(val('1,000.50')).toBe(1000.5);
  });

  it('reads Indian lakh/crore grouping', () => {
    // The format Tally and the GST portal print, and the one a Western-only
    // grouping regex silently refuses.
    expect(val('1,00,000')).toBe(100000);
    expect(val('12,34,567')).toBe(1234567);
    expect(val('1,23,45,678')).toBe(12345678);
    expect(val('12,34,567.89')).toBe(1234567.89);
  });

  it('reads accounting parentheses as negative', () => {
    expect(val('(1,000)')).toBe(-1000);
    expect(val('(1,00,000)')).toBe(-100000);
    expect(val('(42.50)')).toBe(-42.5);
  });

  it('reads trailing minus, as SAP and several Indian ERPs print it', () => {
    expect(val('1000-')).toBe(-1000);
    expect(val('1,234.56-')).toBe(-1234.56);
  });

  it('strips currency marks', () => {
    expect(val('₹1,000')).toBe(1000);
    expect(val('Rs. 1,00,000')).toBe(100000);
    expect(val('Rs 500')).toBe(500);
    expect(val('$1,234.50')).toBe(1234.5);
  });

  it('reads space grouping', () => {
    expect(val('1 000')).toBe(1000);
    expect(val('1 234 567')).toBe(1234567);
  });

  it('handles leading signs', () => {
    expect(val('-1,000')).toBe(-1000);
    expect(val('+500')).toBe(500);
  });

  it('refuses a value that states its sign twice', () => {
    // "(-100)" and "-100-" have no single reading, and quietly resolving them to
    // +100 would be the worst outcome — a sign flip nobody sees.
    expect(val('(-100)')).toBeNull();
    expect(val('(+100)')).toBeNull();
    expect(val('-100-')).toBeNull();
  });

  it('refuses anything with two readings rather than guessing', () => {
    // "1.000" is a thousand in Europe and one in India. Silence beats a wrong
    // guess: the caller reports it as unconverted instead.
    expect(val('1.000,50')).toBeNull();
    expect(val('12,3456')).toBeNull();
    expect(val('1,00')).toBeNull();
  });

  it('leaves genuine text alone', () => {
    expect(val('')).toBeNull();
    expect(val('Acme Traders')).toBeNull();
    expect(val('N/A')).toBeNull();
    expect(val('INV-2024')).toBeNull();
    expect(val('-')).toBeNull();
  });

  it('says how it read an unusual format', () => {
    expect(numberFromText('(1,00,000)')?.note).toContain('parentheses');
    expect(numberFromText('1000-')?.note).toContain('trailing minus');
    expect(numberFromText('₹500')?.note).toContain('currency');
    expect(numberFromText('12,34,567')?.note).toContain('Indian');
  });
});

describe('looksNumericButUnparsed', () => {
  it('flags a figure-shaped cell that could not be read', () => {
    expect(looksNumericButUnparsed('1.000,50')).toBe(true);
    expect(looksNumericButUnparsed('12,3456')).toBe(true);
  });

  it('does not flag what parsed fine, or what is plainly text', () => {
    expect(looksNumericButUnparsed('1,00,000')).toBe(false);
    expect(looksNumericButUnparsed('Acme Traders')).toBe(false);
    expect(looksNumericButUnparsed('')).toBe(false);
    // A reference is not a failed number; flagging it would bury the real ones.
    expect(looksNumericButUnparsed('INV-2024')).toBe(false);
  });
});
