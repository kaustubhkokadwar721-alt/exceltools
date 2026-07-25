// Notebook model + nbformat-4 (.ipynb) serialize/deserialize. Pure, testable.
// Saved files open in real Jupyter, and — unlike a source-only save — carry
// their outputs: tables go out as text/html (what Jupyter renders) plus a
// lossless ExcelTools JSON mime we read back, charts as image/png. Loading
// accepts any nbformat-4 notebook and keeps whatever outputs it can read, so a
// notebook written by real Jupyter still shows its charts and results here.
import type { CellValue } from './types';

export type NotebookCellKind = 'code' | 'markdown';

/** One rendered result under a code cell. Mirrors the engine's CellOut. */
export type NotebookOutput =
  | { type: 'table'; headers: string[]; rows: CellValue[][] }
  | { type: 'image'; png: string }
  | { type: 'text'; text: string };

export interface NotebookCell {
  kind: NotebookCellKind;
  source: string;
  /** Captured print()/stderr text from the last run. */
  stdout?: string;
  /** Rendered results from the last run, in display order. */
  outputs?: NotebookOutput[];
  /** The `[n]` shown in the gutter; preserved across save/load. */
  execCount?: number;
  /** Friendly + raw error text from the last run, when it failed. */
  error?: string;
  /** Code folded away. Round-trips as Jupyter's `jupyter.source_hidden`. */
  sourceHidden?: boolean;
  /** Results folded away. Round-trips as nbformat's `collapsed`. */
  outputsHidden?: boolean;
  /** Wall-clock time of the last run, in ms. Ours; Jupyter ignores it. */
  elapsedMs?: number;
}

/** Our lossless table payload. Jupyter ignores unknown mimes; we read it back. */
const TABLE_MIME = 'application/vnd.exceltools.grid+json';
/** Rows persisted per table output — keeps saved notebooks a sane size. */
export const MAX_SAVED_ROWS = 5000;
/** Rows written into the human-readable text/html preview. */
const HTML_PREVIEW_ROWS = 50;

interface IpynbOutput {
  output_type: string;
  name?: string;
  text?: string[] | string;
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
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

const asText = (src: unknown): string =>
  src === undefined || src === null ? '' : Array.isArray(src) ? src.join('') : String(src);

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const cellText = (v: CellValue): string => (v === null || v === undefined ? '' : String(v));

/** Render a table output as the HTML Jupyter will show (truncated, like pandas). */
function tableHtml(headers: string[], rows: CellValue[][]): string {
  const shown = rows.slice(0, HTML_PREVIEW_ROWS);
  const head = `<tr>${headers.map((h) => `<th>${esc(String(h))}</th>`).join('')}</tr>`;
  const body = shown.map((r) => `<tr>${r.map((c) => `<td>${esc(cellText(c))}</td>`).join('')}</tr>`).join('');
  const more =
    rows.length > shown.length
      ? `<p>${(rows.length - shown.length).toLocaleString()} more row(s) — open in ExcelTools to see them all.</p>`
      : '';
  return `<table border="1" class="dataframe">\n<thead>\n${head}\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>\n${more}`;
}

/** Plain-text fallback so a notebook stays readable without an HTML renderer. */
function tableText(headers: string[], rows: CellValue[][]): string {
  const shown = rows.slice(0, HTML_PREVIEW_ROWS);
  const lines = [headers.join('\t'), ...shown.map((r) => r.map(cellText).join('\t'))];
  if (rows.length > shown.length) lines.push(`… ${(rows.length - shown.length).toLocaleString()} more row(s)`);
  return lines.join('\n');
}

function outputToIpynb(o: NotebookOutput): IpynbOutput {
  if (o.type === 'image') {
    return { output_type: 'display_data', data: { 'image/png': o.png }, metadata: {} };
  }
  if (o.type === 'table') {
    const rows = o.rows.slice(0, MAX_SAVED_ROWS);
    return {
      output_type: 'execute_result',
      execution_count: null,
      metadata: {},
      data: {
        'text/html': asLines(tableHtml(o.headers, rows)),
        'text/plain': asLines(tableText(o.headers, rows)),
        [TABLE_MIME]: JSON.stringify({ headers: o.headers, rows, totalRows: o.rows.length }),
      },
    };
  }
  return { output_type: 'execute_result', execution_count: null, metadata: {}, data: { 'text/plain': asLines(o.text) } };
}

function outputFromIpynb(o: IpynbOutput): NotebookOutput | null {
  const data = o.data ?? {};
  const custom = data[TABLE_MIME];
  if (typeof custom === 'string' || Array.isArray(custom)) {
    try {
      const parsed = JSON.parse(asText(custom)) as { headers?: string[]; rows?: CellValue[][] };
      if (Array.isArray(parsed.headers) && Array.isArray(parsed.rows)) {
        return { type: 'table', headers: parsed.headers, rows: parsed.rows };
      }
    } catch {
      /* fall through to the standard mimes */
    }
  }
  if (data['image/png'] !== undefined) return { type: 'image', png: asText(data['image/png']).replace(/\s+/g, '') };
  if (data['text/plain'] !== undefined) return { type: 'text', text: asText(data['text/plain']) };
  return null;
}

/** Serialize cells — sources, outputs and errors — to an nbformat-4 string. */
export function toIpynb(cells: NotebookCell[], title?: string): string {
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python (Pyodide)', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.14' },
      // What this piece of work is called, so a filed notebook is identifiable
      // by more than its filename. Jupyter carries unknown metadata untouched.
      ...(title?.trim() ? { exceltools: { title: title.trim() } } : {}),
    },
    cells: cells.map((c): IpynbCell => {
      // Folded state travels in the fields Jupyter itself uses, so a notebook
      // folded here opens folded there, and vice versa.
      const metadata: Record<string, unknown> = {};
      if (c.sourceHidden) metadata.jupyter = { source_hidden: true };
      if (c.outputsHidden) metadata.collapsed = true;
      if (c.elapsedMs !== undefined) metadata.exceltools = { elapsedMs: Math.round(c.elapsedMs) };
      if (c.kind === 'markdown') return { cell_type: 'markdown', metadata, source: asLines(c.source) };
      const outputs: IpynbOutput[] = [];
      if (c.stdout) outputs.push({ output_type: 'stream', name: 'stdout', text: asLines(c.stdout) });
      for (const o of c.outputs ?? []) outputs.push(outputToIpynb(o));
      if (c.error) {
        outputs.push({
          output_type: 'error',
          ename: 'Error',
          evalue: c.error.split('\n').pop() ?? 'Error',
          traceback: asLines(c.error),
        });
      }
      return {
        cell_type: 'code',
        metadata,
        execution_count: c.execCount ?? null,
        source: asLines(c.source),
        outputs,
      };
    }),
  };
  return JSON.stringify(nb, null, 1);
}

/** The name this notebook was saved under, if it carries one. */
export function titleFromIpynb(json: string): string {
  try {
    const nb = JSON.parse(json) as { metadata?: { exceltools?: { title?: unknown } } };
    const title = nb.metadata?.exceltools?.title;
    return typeof title === 'string' ? title : '';
  } catch {
    return '';
  }
}

/** Parse an .ipynb file into cells, keeping any outputs it can render. */
export function fromIpynb(json: string): NotebookCell[] {
  const nb = JSON.parse(json) as { nbformat?: number; cells?: IpynbCell[] };
  if (nb.nbformat !== 4 || !Array.isArray(nb.cells)) throw new Error('Not an nbformat-4 notebook');
  return nb.cells
    .filter((c) => c.cell_type === 'code' || c.cell_type === 'markdown')
    .map((c) => {
      const cell: NotebookCell = { kind: c.cell_type as NotebookCellKind, source: asText(c.source) };
      const meta = (c.metadata ?? {}) as {
        collapsed?: boolean;
        jupyter?: { source_hidden?: boolean };
        exceltools?: { elapsedMs?: number };
      };
      if (meta.jupyter?.source_hidden) cell.sourceHidden = true;
      if (meta.collapsed) cell.outputsHidden = true;
      if (typeof meta.exceltools?.elapsedMs === 'number') cell.elapsedMs = meta.exceltools.elapsedMs;
      if (cell.kind === 'markdown') return cell;
      if (typeof c.execution_count === 'number') cell.execCount = c.execution_count;
      const stdout: string[] = [];
      const outputs: NotebookOutput[] = [];
      for (const o of c.outputs ?? []) {
        if (o.output_type === 'stream') stdout.push(asText(o.text));
        else if (o.output_type === 'error') cell.error = (o.traceback ?? []).map((t) => stripAnsi(t)).join('') || `${o.ename}: ${o.evalue}`;
        else {
          const out = outputFromIpynb(o);
          if (out) outputs.push(out);
        }
      }
      if (stdout.length) cell.stdout = stdout.join('');
      if (outputs.length) cell.outputs = outputs;
      return cell;
    });
}

/** Real Jupyter writes colour codes into tracebacks; strip them for display. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

/** Tiny markdown renderer for markdown cells: headings, bold, italic, inline
 *  code, bullet lists, paragraphs. Input is HTML-escaped first. */
export function renderMarkdown(md: string): string {
  const escaped = esc(md);
  const blocks = escaped.split(/\n{2,}/);
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
