// Column type detection.
//
// The asymmetry these tests pin down: a name may demote a column out of
// arithmetic, never into it. Reading an invoice number as text costs nothing;
// reading it as a number destroys leading zeros and invites a meaningless total.
import { describe, it, expect } from 'vitest';
import { detectColumnType, hintFromName, sanitizeColumnName, sanitizeColumnNames } from '../../src/core/coltype';

const col = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i) as never);

describe('hintFromName', () => {
  it('reads identifiers, however the name is punctuated', () => {
    for (const n of ['Invoice No', 'invoice_no', 'invoice-no', 'InvoiceNo', 'Vch No.', 'GSTIN', 'HSN Code'])
      expect(hintFromName(n)).toBe('identifier');
  });

  it('reads labels and times', () => {
    expect(hintFromName('EntityName')).toBe('label');
    expect(hintFromName('Vendor')).toBe('label');
    expect(hintFromName('PeriodDate')).toBe('date');
    expect(hintFromName('Month')).toBe('date');
  });

  it('lets money win over the identifier word inside it', () => {
    // "Invoice Amount" and "Bill Value" carry both signals and are money.
    expect(hintFromName('Invoice Amount')).toBe('amount');
    expect(hintFromName('Bill Value')).toBe('amount');
    expect(hintFromName('TaxAmount')).toBe('amount');
  });

  it('says nothing about a name it does not recognise', () => {
    expect(hintFromName('Foo')).toBe('none');
  });
});

describe('detectColumnType', () => {
  it('keeps a reference column as text even though it is all digits', () => {
    expect(detectColumnType('Invoice No', col(20, (i) => 2000 + i))).toBe('text');
    expect(detectColumnType('Cost Code', col(20, (i) => 100 + i))).toBe('text');
    expect(detectColumnType('GSTIN', col(5, () => 27123456789))).toBe('text');
  });

  it('keeps money numeric even when the name also reads as a reference', () => {
    expect(detectColumnType('Invoice Amount', col(20, (i) => 1000 + i))).toBe('number');
    expect(detectColumnType('TaxAmount', col(20, (i) => i * 18))).toBe('number');
  });

  it('treats a numeric Month or Year as a label, not a quantity', () => {
    // Summing a month number is meaningless; the type must make that impossible.
    expect(detectColumnType('Month', col(12, (i) => i + 1))).toBe('text');
    expect(detectColumnType('Year', col(5, (i) => 2020 + i))).toBe('text');
    expect(detectColumnType('Quarter', col(4, (i) => i + 1))).toBe('text');
  });

  it('recognises unambiguous dates', () => {
    expect(detectColumnType('PeriodDate', col(10, () => '2025-04-15'))).toBe('date');
    expect(detectColumnType('Posted', col(10, () => '2025-04-15T10:30'))).toBe('date');
    expect(detectColumnType('Dt', col(10, () => '15/04/2025'))).toBe('date');
    expect(detectColumnType('Date', col(10, () => 'Apr-2025'))).toBe('date');
  });

  it('refuses an ambiguous date rather than picking a reading', () => {
    // 03/04/2025 is 3 April or 4 March depending on where the file came from.
    // Choosing moves transactions between periods with nothing to notice.
    expect(detectColumnType('Date', col(10, () => '03/04/2025'))).toBe('text');
  });

  it('treats a leading zero as proof of an identifier, whatever the name', () => {
    expect(detectColumnType('Foo', col(10, (i) => `00${i}`))).toBe('text');
  });

  it('still finds ordinary numbers and booleans', () => {
    expect(detectColumnType('Amount', col(20, (i) => i * 1.5))).toBe('number');
    expect(detectColumnType('Foo', col(20, (i) => i * 3))).toBe('number');
    expect(detectColumnType('Active', col(10, (i) => (i % 2 === 0 ? 'Yes' : 'No')))).toBe('boolean');
    expect(detectColumnType('Flag', col(10, (i) => i % 2 === 0))).toBe('boolean');
  });

  it('reads grouped numbers as numbers', () => {
    expect(detectColumnType('Amount', col(10, () => '1,234.50'))).toBe('number');
  });

  it('calls an empty column text rather than guessing', () => {
    expect(detectColumnType('Anything', col(10, () => null))).toBe('text');
    expect(detectColumnType('Anything', [])).toBe('text');
  });

  it('falls back to text when the values disagree', () => {
    expect(detectColumnType('Mixed', ['1', 'two', '3'])).toBe('text');
  });
});

describe('sanitizeColumnName', () => {
  it('removes the line breaks Excel leaves in wrapped headers', () => {
    expect(sanitizeColumnName('Invoice\nNumber')).toBe('Invoice Number');
    expect(sanitizeColumnName('Tax\tAmount')).toBe('Tax Amount');
  });

  it('drops characters that break identifiers but keeps the name readable', () => {
    expect(sanitizeColumnName('Amount (INR)')).toBe('Amount INR');
    expect(sanitizeColumnName('Debit/Credit')).toBe('Debit Credit');
    expect(sanitizeColumnName("Party's Name")).toBe('Partys Name');
  });

  it('keeps the currency mark rather than mangling the word around it', () => {
    expect(sanitizeColumnName('Amount ₹')).toBe('Amount ₹');
  });

  it('falls back when nothing readable survives', () => {
    expect(sanitizeColumnName('()')).toBe('Column');
    expect(sanitizeColumnName('   ')).toBe('Column');
    expect(sanitizeColumnName('', 'Column 3')).toBe('Column 3');
  });
});

describe('sanitizeColumnNames', () => {
  it('disambiguates names that collide only after cleaning', () => {
    // "Amount (₹)" and "Amount [₹]" are different in the file and identical
    // after cleaning; silently keeping one would lose a column.
    expect(sanitizeColumnNames(['Amount (x)', 'Amount [x]'])).toEqual(['Amount x', 'Amount x 2']);
  });

  it('numbers a column that has no usable name at all', () => {
    expect(sanitizeColumnNames(['A', '', '  '])).toEqual(['A', 'Column 2', 'Column 3']);
  });
});

describe('hintFromName — the head noun decides', () => {
  it('takes the last recognised word, as English compounds do', () => {
    // "Cost Code" carries a money word and a reference word; the reference is
    // the head noun, so it is a cost-centre code and not an amount. Any rule
    // that ranks the categories globally gets one of this pair wrong.
    expect(hintFromName('Cost Code')).toBe('identifier');
    expect(hintFromName('Invoice Amount')).toBe('amount');
    expect(hintFromName('Account Balance')).toBe('amount');
    expect(hintFromName('Balance Account')).toBe('identifier');
    expect(hintFromName('Date of Invoice')).toBe('identifier');
    expect(hintFromName('Invoice Date')).toBe('date');
  });
});
