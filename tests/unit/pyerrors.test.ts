import { describe, it, expect } from 'vitest';
import { explainPythonError, closest } from '../../src/core/pyerrors';

const tb = (last: string, line = 2): string =>
  `Traceback (most recent call last):\n  File "<cell>", line ${line}, in <module>\n${last}`;

describe('explainPythonError', () => {
  it('names the missing column and suggests the real one', () => {
    const ex = explainPythonError(tb("KeyError: 'Amout'"), { columns: ['Dept', 'Amount', 'Date'] });
    expect(ex.title).toContain('no column called "Amout"');
    expect(ex.hint).toContain('Did you mean "Amount"?');
    expect(ex.line).toBe(2);
    expect(ex.raw).toContain('KeyError');
  });

  it('calls out a trailing space in a heading, which is invisible on screen', () => {
    const ex = explainPythonError(tb("KeyError: 'Amount '"), { columns: ['Amount '] });
    expect(ex.hint).toContain('extra space');
  });

  it('explains an undefined name as a cell that has not been run', () => {
    const ex = explainPythonError(tb("NameError: name 'df_sales' is not defined"), { names: ['df_sale'] });
    expect(ex.title).toContain('"df_sales" hasn\'t been created yet');
    expect(ex.hint).toContain('Run all');
  });

  it('says why an import cannot work offline', () => {
    const ex = explainPythonError(tb("ModuleNotFoundError: No module named 'requests'"));
    expect(ex.title).toContain('"requests" library isn\'t available');
    expect(ex.hint).toContain('offline');
  });

  it('translates text-vs-number arithmetic into the usual cause', () => {
    const ex = explainPythonError(tb("TypeError: unsupported operand type(s) for +: 'int' and 'str'"));
    expect(ex.title).toContain('mixed text with numbers');
    expect(ex.hint).toContain('to_numeric');
  });

  it('quotes the offending value when a column will not convert', () => {
    const ex = explainPythonError(tb('ValueError: could not convert string to float: \'N/A\''));
    expect(ex.title).toContain('N/A');
  });

  it('redirects DataFrame attribute typos to bracket syntax', () => {
    const ex = explainPythonError(tb("AttributeError: 'DataFrame' object has no attribute 'Amount'"), { columns: ['Amount'] });
    expect(ex.hint).toContain('df_x["Amount"]');
  });

  it('explains that the notebook cannot read the disk', () => {
    const ex = explainPythonError(tb("FileNotFoundError: [Errno 44] No such file or directory: 'data.csv'"));
    expect(ex.title).toContain('cannot read files');
    expect(ex.hint).toContain('drop area');
  });

  it('handles a mismatched join key', () => {
    const ex = explainPythonError(tb('ValueError: You are trying to merge on object and int64 columns'));
    expect(ex.title).toContain('text in one table and a number in the other');
  });

  it('falls back readably on an error it has never seen', () => {
    const ex = explainPythonError(tb('SomeLibraryError: the flux capacitor is jammed'));
    expect(ex.title).toBe('Python stopped with a SomeLibraryError.');
    expect(ex.hint).toBe('the flux capacitor is jammed');
  });

  it('never throws, even on empty or garbled input', () => {
    expect(() => explainPythonError('')).not.toThrow();
    expect(explainPythonError('').title).toBeTruthy();
  });

  it('reports the last cell line when the traceback has several frames', () => {
    const raw = 'Traceback:\n  File "<cell>", line 1, in <module>\n  File "<cell>", line 9, in helper\nZeroDivisionError: division by zero';
    expect(explainPythonError(raw).line).toBe(9);
  });
});

describe('closest', () => {
  it('matches across case and spacing', () => {
    expect(closest('amount', ['Dept', 'Amount'])).toBe('Amount');
    expect(closest('Inv No', ['Inv  No'])).toBe('Inv  No');
  });

  it('connects the full word to the abbreviated heading, and back', () => {
    expect(closest('Amount', ['ID', 'Dept', 'Amt'])).toBe('Amt');
    expect(closest('Dept', ['Department', 'Region'])).toBe('Department');
    expect(closest('Quantity', ['Qty', 'Rate'])).toBe('Qty');
  });

  it('stays quiet when nothing is close', () => {
    expect(closest('qqqqqqq', ['Dept', 'Amount'])).toBeUndefined();
    expect(closest('Amount', [])).toBeUndefined();
    // Two-letter overlaps are noise, not abbreviations.
    expect(closest('Invoice Date', ['ID'])).toBeUndefined();
  });
});
