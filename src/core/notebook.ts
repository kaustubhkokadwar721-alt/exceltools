// Notebook model + nbformat-4 (.ipynb) serialize/deserialize. Pure, testable.
// Saved files open in real Jupyter; loading accepts any nbformat-4 notebook
// (sources kept, foreign outputs ignored).

export type NotebookCellKind = 'code' | 'markdown';

export interface NotebookCell {
  kind: NotebookCellKind;
  source: string;
  /** Last run's text outputs, included on save so Jupyter shows something. */
  stdout?: string;
  textResult?: string;
}

interface IpynbOutput {
  output_type: string;
  name?: string;
  text?: string[] | string;
  data?: Record<string, string[] | string>;
  execution_count?: number | null;
}

interface IpynbCell {
  cell_type: string;
  source: string[] | string;
  metadata?: Record<string, unknown>;
  outputs?: IpynbOutput[];
  execution_count?: number | null;
}

const asLines = (s: string): string[] => {
  const lines = s.split('\n');
  return lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l)).filter((l, i, a) => !(l === '' && i === a.length - 1));
};

const asText = (src: string[] | string | undefined): string =>
  src === undefined ? '' : Array.isArray(src) ? src.join('') : src;

/** Serialize cells to an nbformat-4 notebook JSON string. */
export function toIpynb(cells: NotebookCell[]): string {
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python (Pyodide)', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.14' },
    },
    cells: cells.map((c): IpynbCell => {
      if (c.kind === 'markdown') return { cell_type: 'markdown', metadata: {}, source: asLines(c.source) };
      const outputs: IpynbOutput[] = [];
      if (c.stdout) outputs.push({ output_type: 'stream', name: 'stdout', text: asLines(c.stdout) });
      if (c.textResult)
        outputs.push({
          output_type: 'execute_result',
          execution_count: null,
          data: { 'text/plain': asLines(c.textResult) },
        });
      return { cell_type: 'code', metadata: {}, execution_count: null, source: asLines(c.source), outputs };
    }),
  };
  return JSON.stringify(nb, null, 1);
}

/** Parse an .ipynb file into cells. Throws on non-nbformat-4 input. */
export function fromIpynb(json: string): NotebookCell[] {
  const nb = JSON.parse(json) as { nbformat?: number; cells?: IpynbCell[] };
  if (nb.nbformat !== 4 || !Array.isArray(nb.cells)) throw new Error('Not an nbformat-4 notebook');
  return nb.cells
    .filter((c) => c.cell_type === 'code' || c.cell_type === 'markdown')
    .map((c) => ({ kind: c.cell_type as NotebookCellKind, source: asText(c.source) }));
}

/** Tiny markdown renderer for markdown cells: headings, bold, italic, inline
 *  code, bullet lists, paragraphs. Input is HTML-escaped first. */
export function renderMarkdown(md: string): string {
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = esc.split(/\n{2,}/);
  return blocks
    .map((b) => {
      const lines = b.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      const h = b.match(/^(#{1,3})\s+(.*)$/);
      if (h) return `<h${h[1].length + 3}>${inline(h[2])}</h${h[1].length + 3}>`; // h1→h4 … keeps page hierarchy
      return `<p>${inline(b.replace(/\n/g, '<br>'))}</p>`;
    })
    .join('');

  function inline(s: string): string {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }
}
