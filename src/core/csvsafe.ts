// Spreadsheet formula injection — neutralising it on the way out.
//
// A cell whose *text* begins with `=`, `+`, `-` or `@` is treated by Excel as a
// formula when it is read back from CSV or pasted from the clipboard. A client
// file containing `=cmd|'/c calc'!A1` therefore turns this tool into the
// delivery mechanism: the auditor converts the file, opens the result, and
// Excel offers to run a command. Prefixing with an apostrophe — Excel's own
// "this is text" marker — stops that.
//
// This is also a *fidelity* fix, not only a security one. The parser hands us
// computed values, never formula source (see docs/FIDELITY.md), so a value that
// starts with `=` is text that happens to look like a formula. Writing it so
// that Excel evaluates it would misrepresent the source data.
//
// Numbers stored as text are deliberately left alone: "-5" and "+919876543210"
// are ordinary finance data, not payloads.
import type { SheetData, CellValue } from './types';

/** Leading characters Excel treats as the start of a formula. */
const RISKY_PREFIX = /^[=+\-@\t\r]/;

/** Prefix a risky text value with an apostrophe so Excel reads it as text. */
export function neutralizeFormula(value: string): string {
  if (!RISKY_PREFIX.test(value)) return value;
  // A plain number written as text is not a formula — keep it verbatim.
  if (value.trim() !== '' && Number.isFinite(Number(value))) return value;
  return `'${value}`;
}

const neutralizeCell = (v: CellValue): CellValue => (typeof v === 'string' ? neutralizeFormula(v) : v);

/**
 * A copy of the sheet safe to write to CSV/TSV or the clipboard. Only string
 * cells are touched; numbers, booleans and blanks pass through untouched, as do
 * the headers' own values (which are escaped the same way — a crafted heading is
 * just as capable of carrying a payload).
 */
export function neutralizeSheet(sheet: SheetData): SheetData {
  return {
    ...sheet,
    headers: sheet.headers.map((h) => (typeof h === 'string' ? neutralizeFormula(h) : h)),
    rows: sheet.rows.map((row) => row.map(neutralizeCell)),
  };
}
