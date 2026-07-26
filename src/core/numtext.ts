// Numbers that arrived as text, and how to recognise them.
//
// A figure typed or exported as text is excluded from every SUM downstream with
// no error and no warning, so the cost of failing to recognise one is a total
// that is quietly wrong. That makes breadth here worth more than strictness.
//
// The formats below are the ones that actually turn up in Indian audit work:
//
//   1,000        Western thousands grouping
//   12,34,567    Indian lakh/crore grouping — the first group is 1-3 digits,
//                the rest are pairs, and the last is a triple
//   (1,000)      accounting negative; parentheses mean minus, not decoration
//   1000-        trailing-minus, as SAP and several Indian ERPs print it
//   ₹1,000       currency-prefixed, from Tally and portal downloads
//   1 000        space-grouped, from some European and PDF-extracted exports
//
// Deliberately NOT recognised: anything with two or more interpretations. A
// bare "1.000" is one thousand in Europe and one in India, so it stays text and
// gets reported as unconverted rather than silently guessed at.

/** Currency marks stripped before parsing. */
const CURRENCY = /^(?:₹|rs\.?|inr|\$|€|£)\s*/i;

/** Western grouping: 1,000 / 1,000,000 */
const WESTERN = /^\d{1,3}(?:,\d{3})+$/;
/** Indian grouping: 1,00,000 / 12,34,567 */
const INDIAN = /^\d{1,3}(?:,\d{2})+,\d{3}$/;
/** Space grouping: 1 000 000 */
const SPACED = /^\d{1,3}(?: \d{3})+$/;
/** No grouping at all. */
const PLAIN = /^\d+$/;

export interface NumberFromText {
  value: number;
  /** How it was written, for the change log. */
  note: string;
}

/**
 * Parse a text cell that represents a number, or return null to leave it alone.
 * Returning null is a real answer — the caller reports those rather than
 * dropping them, so a column that failed to convert is visible.
 */
export function numberFromText(raw: string): NumberFromText | null {
  let s = raw.trim();
  if (s === '') return null;

  const notes: string[] = [];

  // Accounting parentheses mean negative. Checked before the sign so "(1,000)"
  // and "-1,000" reach the same place.
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    notes.push('parentheses read as negative');
    s = s.slice(1, -1).trim();
  }

  if (CURRENCY.test(s)) {
    notes.push('currency symbol removed');
    s = s.replace(CURRENCY, '').trim();
  }

  // Trailing minus, as printed by SAP and several Indian ERPs.
  let signs = 0;
  if (/-$/.test(s)) {
    signs++;
    notes.push('trailing minus read as negative');
    s = s.slice(0, -1).trim();
  }
  if (/^-/.test(s)) {
    signs++;
    s = s.slice(1).trim();
  } else if (/^\+/.test(s)) {
    if (negative) return null; // "(+100)" states the sign twice, and disagrees
    s = s.slice(1).trim();
  }
  // A value that states its sign more than once — "(-100)", "-100-" — has no
  // single reading. Refusing it is the same rule as "1.000": the caller reports
  // it as unconverted, which someone can look at, rather than picking for them.
  if (signs > 1 || (negative && signs > 0)) return null;
  if (signs === 1) negative = true;

  // Split the decimal part off before validating the grouping of the integer
  // part — grouping rules only apply to the left of the point.
  const dot = s.indexOf('.');
  let intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? '' : s.slice(dot + 1);
  if (dot !== -1 && !/^\d+$/.test(fracPart)) return null;

  if (INDIAN.test(intPart)) {
    notes.push('Indian grouping');
    intPart = intPart.replace(/,/g, '');
  } else if (WESTERN.test(intPart)) {
    intPart = intPart.replace(/,/g, '');
  } else if (SPACED.test(intPart)) {
    notes.push('space grouping');
    intPart = intPart.replace(/ /g, '');
  } else if (!PLAIN.test(intPart)) {
    return null;
  }

  const n = Number(`${intPart}${fracPart ? '.' + fracPart : ''}`);
  if (!Number.isFinite(n)) return null;

  return { value: negative ? -n : n, note: notes.join(', ') };
}

/**
 * True when a cell looks like it was meant to be a number but could not be
 * parsed — the set worth reporting back. A cell of pure letters is not a failed
 * number, it is text, and flagging it would bury the ones that matter.
 */
export function looksNumericButUnparsed(raw: string): boolean {
  const s = raw.trim();
  if (s === '' || numberFromText(s) !== null) return false;
  // Contains a digit, and nothing that reads as a word.
  return /\d/.test(s) && !/[A-Za-z]{2,}/.test(s);
}
