// Python syntax highlighting for code cells: escape the source, then wrap
// tokens in spans. Deliberately small — colouring a notebook cell doesn't need
// a parser, and keeping it here (pure, no DOM) means it can be unit-tested and
// audited in one sitting. The editor widget in ui/codeeditor.ts paints it.

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

const BUILTINS = new Set([
  'abs', 'all', 'any', 'bool', 'dict', 'enumerate', 'filter', 'float', 'format', 'int', 'len', 'list', 'map',
  'max', 'min', 'open', 'print', 'range', 'round', 'set', 'sorted', 'str', 'sum', 'tuple', 'type', 'zip',
  'pd', 'np', 'plt', 'tables',
]);

// Comment · string · number · identifier. Anything unmatched stays plain text.
// Unterminated strings still match to the end of the line so colours don't
// smear across the rest of the cell while someone is mid-type.
const TOKEN =
  /(#[^\n]*)|('''[\s\S]*?(?:'''|$)|"""[\s\S]*?(?:"""|$)|'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?)|(\b\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Class for an identifier, or '' when it should render as plain text. */
function identClass(ident: string): string {
  if (KEYWORDS.has(ident)) return 'tk-kw';
  if (BUILTINS.has(ident)) return 'tk-fn';
  // Registered tables are the names users care most about spotting.
  if (ident.startsWith('df_')) return 'tk-tbl';
  return '';
}

/** Escaped HTML with tokens wrapped in spans. Input is never treated as HTML. */
export function highlightPython(code: string): string {
  let html = '';
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(code); m; m = TOKEN.exec(code)) {
    html += esc(code.slice(last, m.index));
    const [text, comment, string, number, ident] = m;
    if (comment) html += `<span class="tk-com">${esc(text)}</span>`;
    else if (string) html += `<span class="tk-str">${esc(text)}</span>`;
    else if (number) html += `<span class="tk-num">${esc(text)}</span>`;
    else if (ident) {
      const cls = identClass(ident);
      html += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text);
    }
    last = m.index + text.length;
  }
  html += esc(code.slice(last));
  // A trailing newline needs a character after it or the last line collapses.
  return html + '\n';
}
