// Working out what a column *is*, before anyone has to say so.
//
// Power Query's insight is that a column's name carries as much information as
// its values, and that the two disagree in predictable ways. An invoice number,
// a GST identifier, a cost centre and a voucher reference are all written as
// digits and all mean nothing arithmetically: totalling them is meaningless and
// storing them as numbers destroys the leading zeros that make them match. A
// column called "Month" holding 1–12 is a period, not a quantity.
//
// So the rule is: the name decides the *kind* of thing, the values decide
// whether that reading is possible. Name evidence can only ever demote a column
// away from arithmetic, never promote it into arithmetic — the failure of
// guessing wrong in that direction is a wrong total, which is the one outcome an
// audit tool must not produce quietly.
import type { CellValue, ColType } from './types';

/** Words that mean "a label that happens to be written in digits". */
const IDENTIFIER_WORDS = new Set(
  ('id ids code codes no nos num number ref reference gstin pan tan cin uin hsn sac account acct ' +
    'voucher vch invoice inv bill challan receipt cheque check serial sr sl pin zip phone mobile ' +
    'contact tel fax key barcode sku part batch lot folio token irn ack').split(' '),
);

/** Words that read as a person, party or place — never arithmetic. */
const LABEL_WORDS = new Set(
  ('name names party vendor supplier customer client entity company firm branch address city state ' +
    'country district region description desc narration particulars remark remarks note notes status ' +
    'type category group class department dept designation title').split(' '),
);

/** Words that read as a point in time. */
const DATE_WORDS = new Set(
  ('date dated dt day month mon year yr period quarter qtr fy due posted created modified updated ' +
    'timestamp time').split(' '),
);

/** Words that say "this is a measurement" — money, quantity, rate. */
const AMOUNT_WORDS = new Set(
  ('amount amt value val total sum net gross price rate cost qty quantity balance debit credit dr cr ' +
    'tax cgst sgst igst cess tds discount charge fee salary wages units count percent pct share weight').split(' '),
);

export type NameHint = 'identifier' | 'label' | 'date' | 'amount' | 'none';

/**
 * What the column's *name* suggests, independent of its values.
 *
 * Read right to left and take the first word we recognise, because English puts
 * the head noun last: "Invoice Amount" is money, "Cost Code" is a reference, and
 * a rule that ranks the categories against each other gets one of those wrong
 * whichever order it picks.
 */
export function hintFromName(name: string): NameHint {
  const words = String(name ?? '')
    // The separators spreadsheets use, plus camelCase, so "Invoice_No",
    // "invoice-no" and "InvoiceNo" all present "no" as its own word.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (AMOUNT_WORDS.has(w)) return 'amount';
    if (DATE_WORDS.has(w)) return 'date';
    if (IDENTIFIER_WORDS.has(w)) return 'identifier';
    if (LABEL_WORDS.has(w)) return 'label';
  }
  return 'none';
}

const BOOL_TRUE = new Set(['true', 'yes', 'y']);
const BOOL_FALSE = new Set(['false', 'no', 'n']);

/** ISO, and the day-first forms Indian exports use. Deliberately not month-first
 *  — "03/04/2025" is ambiguous, and guessing it wrong moves a transaction by a
 *  month without anyone seeing. Ambiguous forms stay text. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const DAY_FIRST = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const MONTH_NAME = /^(?:\d{1,2}[ -])?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[ -]?\d{0,4}$/i;

function isDateLike(v: CellValue): boolean {
  if ((v as unknown) instanceof Date) return true;
  const s = String(v).trim();
  if (ISO_DATE.test(s) || MONTH_NAME.test(s)) return true;
  const m = DAY_FIRST.exec(s);
  // Day-first only when the first field cannot be a month — otherwise ambiguous.
  return !!m && Number(m[1]) > 12 && Number(m[2]) <= 12;
}

const NUMERIC = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/;

function isNumericValue(v: CellValue): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && NUMERIC.test(v.trim());
}

function isBoolValue(v: CellValue): boolean {
  if (typeof v === 'boolean') return true;
  const s = String(v).trim().toLowerCase();
  return BOOL_TRUE.has(s) || BOOL_FALSE.has(s);
}

/** A value written with a leading zero is an identifier by construction —
 *  "007" is not seven, and storing it as seven loses the match. */
function hasLeadingZero(v: CellValue): boolean {
  return typeof v === 'string' && /^0\d/.test(v.trim());
}

const SAMPLE = 200;

/**
 * The type to use for a column, from its name and a sample of its values.
 * `detectColumnType` is what "Auto" resolves to — the UI shows the answer, so
 * nobody registers a table and then wonders what Auto decided.
 */
export function detectColumnType(name: string, values: CellValue[]): ColType {
  const sample = values.slice(0, SAMPLE).filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (!sample.length) return 'text';

  const hint = hintFromName(name);

  // Booleans first: they are unambiguous and no name hint should override them.
  if (sample.every(isBoolValue)) return 'boolean';

  if (sample.every(isDateLike)) return 'date';

  const allNumeric = sample.every(isNumericValue);

  // Named as a time but not written as one: a "Month" column of 1-12, or dates
  // in the ambiguous 03/04/2025 form. Either way it is a label — totalling a
  // month number is meaningless, and picking a reading for an ambiguous date
  // moves transactions between periods without anyone seeing it happen.
  if (hint === 'date') return 'text';

  // Digits that are really a reference. Leading zeros settle it on their own,
  // whatever the column is called.
  if (allNumeric && (hint === 'identifier' || hint === 'label' || sample.some(hasLeadingZero))) return 'text';

  if (allNumeric) return 'number';
  return 'text';
}

/**
 * Column names as a spreadsheet gives them and as a Python identifier can take
 * them. Newlines, tabs and stray control characters come through Excel headers
 * routinely and break every later display; the aim is a name that still reads
 * like the original, not a slug.
 */
export function sanitizeColumnName(raw: string, fallback = 'Column'): string {
  const cleaned = String(raw ?? '')
    // Control characters and the line breaks Excel leaves in wrapped headers,
    // written as escapes so they stay visible to whoever reads this next.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    // Characters that break identifiers or CSV round-trips, kept as spaces so
    // "Amount (₹)" reads as "Amount" rather than "Amount₹".
    .replace(/["'`]+/g, '')
    .replace(/[\\/|<>{}[\]()*?:;,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

/** Make every name in a table unique after sanitising, keeping the first. */
export function sanitizeColumnNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n, i) => {
    const base = sanitizeColumnName(n, `Column ${i + 1}`);
    let name = base;
    let k = 2;
    while (used.has(name.toLowerCase())) name = `${base} ${k++}`;
    used.add(name.toLowerCase());
    return name;
  });
}
