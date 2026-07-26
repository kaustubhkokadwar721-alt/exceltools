// HTML escaping, in core because both the DOM code and the parser worker need
// it and a worker must not import a module that touches `document`.
//
// One shared copy so there is exactly one function to audit. It escapes the
// attribute-significant characters too (`"` and `'`), because output is
// interpolated into attributes as well as text — an escape that only handles
// `<` and `>` is the usual way an injection survives.

/** Escape text for interpolation into an HTML string, including attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
