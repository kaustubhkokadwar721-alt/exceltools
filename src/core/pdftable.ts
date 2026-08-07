// Reconstructing tables from a PDF's text layer.
//
// A PDF has no tables. It has glyphs at coordinates, and a "table" is a visual
// coincidence of alignment that a human reads as a grid. Everything here is the
// work of turning that coincidence back into rows and columns.
//
// The method is gutter detection, which is the standard approach and the right
// one for the documents this tool exists for — bank statements, ERP prints,
// portal downloads. Those are machine-generated with rigid column alignment, so
// the vertical white channels between columns are real and consistent, and
// finding them is more reliable than any inference about what the content means.
//
// Deliberately not attempted: guessing at a layout the geometry does not
// support. Where the evidence runs out this returns fewer tables rather than
// speculative ones, because a table that silently absorbs a neighbouring column
// produces a total that is wrong with nothing to notice.
import { numberFromText } from './numtext';
import { sanitizeColumnNames } from './coltype';
import type { CellValue, SheetData } from './types';

/** One positioned piece of text, as the PDF text layer reports it. */
export interface TextRun {
  text: string;
  /** Left edge, in PDF user units (points). */
  x: number;
  /** Baseline, measured DOWN from the top of the page. */
  y: number;
  /** Advance width of the run. */
  w: number;
  /** Glyph height — effectively the font size. */
  h: number;
}

export interface PdfPage {
  /** 1-based, as printed. */
  page: number;
  runs: TextRun[];
}

/** A reconstructed table, with enough provenance to trace it back to the page. */
export interface PdfTable {
  page: number;
  /** 1-based position among the tables found on that page, top to bottom. */
  index: number;
  headers: string[];
  rows: CellValue[][];
  totalRows: number;
}

export interface ExtractOptions {
  /**
   * Join a row that continues the one above it. A wrapped narration in a bank
   * statement arrives as a second line with the leading columns empty; without
   * this the description is orphaned in a row of its own.
   */
  joinWrappedRows?: boolean;
  /**
   * Turn figures written as text into real numbers, using the same parser the
   * Clean tool uses — Indian grouping, accounting parentheses, trailing minus.
   * Anything with more than one reading is left as text rather than guessed at.
   */
  convertNumbers?: boolean;
}

// ---- Tuning constants ------------------------------------------------------
//
// All expressed as multiples of the median glyph height on the page, so they
// hold whether the document is set in 7pt or 12pt.

/** Two runs are on the same line if their baselines differ by less than this. */
const LINE_TOL = 0.55;
/** Runs closer together than this horizontally belong to the same cell. A word
 *  space is roughly 0.3em; a column gutter in a machine-generated table is
 *  comfortably wider than one em, so this separates the two cases. */
const CELL_GAP = 1.0;
/** A vertical white channel this wide, unbroken across every line of a block,
 *  is a column boundary rather than a wide word space. */
const MIN_GUTTER = 0.5;
/** A vertical jump larger than this multiple of the block's usual line spacing
 *  ends the block — it is the space between two stacked tables, not a row gap. */
const BLOCK_BREAK = 2.2;
/** Fewer lines than this is not a table, it is two stray words that happen to
 *  sit side by side. */
const MIN_LINES = 2;
/** A lone cell covering more than this share of the block's width is a heading
 *  spanning the columns, not the tail of a wrapped row sitting inside one. */
const WIDE_LINE = 0.6;

interface Cell {
  text: string;
  x0: number;
  x1: number;
}

interface Line {
  y: number;
  cells: Cell[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Group runs into visual lines by baseline, then into cells by horizontal gap.
 *
 * Runs arrive in content-stream order, which is the order the generator emitted
 * them and bears no reliable relation to reading order, so everything is sorted
 * by geometry first.
 */
function toLines(runs: TextRun[], unit: number): Line[] {
  const usable = runs.filter((r) => r.text.trim() !== '');
  if (!usable.length) return [];

  const sorted = [...usable].sort((a, b) => a.y - b.y || a.x - b.x);
  const tol = unit * LINE_TOL;

  const groups: TextRun[][] = [];
  let current: TextRun[] = [sorted[0]];
  let anchor = sorted[0].y;
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.y - anchor > tol) {
      groups.push(current);
      current = [];
      anchor = r.y;
    }
    current.push(r);
  }
  groups.push(current);

  return groups.map((g) => {
    const byX = [...g].sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    for (const r of byX) {
      const last = cells[cells.length - 1];
      const gap = last ? r.x - last.x1 : Infinity;
      if (last && gap <= unit * CELL_GAP) {
        // Same cell: restore the space the gap represents, unless the runs are
        // butted together (a single word split across two text items).
        last.text += (gap > unit * 0.12 ? ' ' : '') + r.text;
        last.x1 = Math.max(last.x1, r.x + r.w);
      } else {
        cells.push({ text: r.text, x0: r.x, x1: r.x + r.w });
      }
    }
    for (const c of cells) c.text = c.text.trim();
    return { y: g[0].y, cells: cells.filter((c) => c.text !== '') };
  }).filter((l) => l.cells.length > 0);
}

/** The block's horizontal extent, over every cell it currently holds. */
function blockSpan(block: Line[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const l of block) for (const c of l.cells) {
    if (c.x0 < min) min = c.x0;
    if (c.x1 > max) max = c.x1;
  }
  return { min, max };
}

/**
 * Split lines into candidate table blocks.
 *
 * Two things end a block. One is an unusually large vertical jump, which is
 * what separates two tables printed one above the other, or a table from the
 * page furniture below it.
 *
 * The other is a heading. A line holding a single cell is ambiguous: it is
 * either prose — a title, a section heading — which would destroy the gutters
 * if kept, because one full-width run covers every column channel; or it is the
 * tail of a row that wrapped, which must be kept or the wrapped text is lost
 * along with the rest of its row. Width tells them apart: a heading spans the
 * columns, a wrapped fragment sits inside one.
 */
function toBlocks(lines: Line[]): Line[][] {
  const blocks: Line[][] = [];
  let current: Line[] = [];

  const flush = () => {
    if (current.length >= MIN_LINES) blocks.push(current);
    current = [];
  };

  for (const line of lines) {
    if (current.length >= 2) {
      // Compare this line's gap against the spacing established by the block.
      const gaps: number[] = [];
      for (let i = 1; i < current.length; i++) gaps.push(current[i].y - current[i - 1].y);
      const usual = median(gaps);
      if (usual > 0 && line.y - current[current.length - 1].y > usual * BLOCK_BREAK) flush();
    }

    if (line.cells.length >= 2) {
      current.push(line);
      continue;
    }

    const { min, max } = blockSpan(current);
    const cell = line.cells[0];
    const narrow = current.length > 0 && max > min && cell.x1 - cell.x0 <= (max - min) * WIDE_LINE;
    if (narrow) current.push(line);
    else flush();
  }
  flush();
  return blocks;
}

/**
 * Column boundaries for a block, as the midpoints of its vertical white
 * channels.
 *
 * A bin is occupied if *any* cell in the block covers it, so a channel that
 * survives is one no row crossed — which is exactly the definition of a column
 * boundary in an aligned table. A single cell spilling across a channel closes
 * it and merges the two columns, which is the correct conservative outcome:
 * two columns joined is visible in the output, whereas a boundary invented
 * where the evidence does not support one silently cuts values in half.
 */
function columnEdges(block: Line[], unit: number): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const l of block) for (const c of l.cells) {
    if (c.x0 < min) min = c.x0;
    if (c.x1 > max) max = c.x1;
  }
  if (!Number.isFinite(min) || max <= min) return [];

  // 1-point bins: finer than any real gutter, coarse enough to stay cheap.
  const width = Math.ceil(max - min) + 1;
  const occupied = new Uint8Array(width);
  for (const l of block) {
    for (const c of l.cells) {
      const from = Math.max(0, Math.floor(c.x0 - min));
      const to = Math.min(width, Math.ceil(c.x1 - min));
      occupied.fill(1, from, to);
    }
  }

  const minGutter = Math.max(2, unit * MIN_GUTTER);
  const edges: number[] = [min];
  let runStart = -1;
  for (let i = 0; i <= width; i++) {
    const free = i < width && occupied[i] === 0;
    if (free && runStart === -1) runStart = i;
    if (!free && runStart !== -1) {
      if (i - runStart >= minGutter) edges.push(min + (runStart + i) / 2);
      runStart = -1;
    }
  }
  edges.push(max);
  return edges;
}

/** Place a cell in the column it overlaps most. Gutters make this unambiguous
 *  in the normal case; the overlap rule decides the rest without dropping text,
 *  and handles right-aligned figures as naturally as left-aligned labels. */
function columnOf(cell: Cell, edges: number[]): number {
  let best = 0;
  let bestOverlap = -1;
  for (let i = 0; i < edges.length - 1; i++) {
    const overlap = Math.min(cell.x1, edges[i + 1]) - Math.max(cell.x0, edges[i]);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = i;
    }
  }
  return best;
}

function gridOf(block: Line[], edges: number[]): string[][] {
  const cols = edges.length - 1;
  return block.map((line) => {
    const row = new Array<string>(cols).fill('');
    for (const cell of line.cells) {
      const i = columnOf(cell, edges);
      row[i] = row[i] ? `${row[i]} ${cell.text}` : cell.text;
    }
    return row;
  });
}

/**
 * Fold a continuation line into the row above it.
 *
 * The signature of a wrapped row is that the first column is empty: a real row
 * of a statement or ledger opens with a date, a voucher number or a code, and a
 * line that begins blank is the tail of the description above. Requiring the
 * first column to be empty keeps this from swallowing a genuinely sparse row.
 */
function joinWrapped(rows: string[][]): string[][] {
  const out: string[][] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    const isContinuation = prev && row[0] === '' && row.some((c) => c !== '');
    if (isContinuation) {
      row.forEach((c, i) => {
        if (c !== '') prev[i] = prev[i] ? `${prev[i]} ${c}` : c;
      });
    } else {
      out.push([...row]);
    }
  }
  return out;
}

function valueOf(text: string, convert: boolean): CellValue {
  if (text === '') return null;
  if (!convert) return text;
  const n = numberFromText(text);
  return n ? n.value : text;
}

/**
 * Every table the geometry supports, in reading order.
 *
 * Pages with no text runs at all yield nothing — that is a scanned image, and
 * it is reported by `scannedPages` rather than guessed at, because OCR would
 * put misread digits into an audit total.
 */
export function extractTables(pages: PdfPage[], opts: ExtractOptions = {}): PdfTable[] {
  const join = opts.joinWrappedRows !== false;
  const convert = opts.convertNumbers !== false;
  const out: PdfTable[] = [];

  for (const page of pages) {
    const heights = page.runs.map((r) => r.h).filter((h) => h > 0);
    // A sane default for a page whose runs carry no height information; every
    // threshold is relative to it, so it only has to be the right order.
    const unit = median(heights) || 10;

    const blocks = toBlocks(toLines(page.runs, unit));
    let index = 0;
    for (const block of blocks) {
      const edges = columnEdges(block, unit);
      if (edges.length < 3) continue; // fewer than two columns is not a table

      let grid = gridOf(block, edges);
      if (join) grid = joinWrapped(grid);
      if (grid.length < MIN_LINES) continue;

      const [header, ...body] = grid;
      if (!body.length) continue;

      index += 1;
      out.push({
        page: page.page,
        index,
        headers: sanitizeColumnNames(header.map((h, i) => h || `Column ${i + 1}`)),
        rows: body.map((r) => r.map((c) => valueOf(c, convert))),
        totalRows: body.length,
      });
    }
  }
  return out;
}

/** Pages carrying no text layer at all — scans, or images of tables. */
export function scannedPages(pages: PdfPage[]): number[] {
  return pages.filter((p) => !p.runs.some((r) => r.text.trim() !== '')).map((p) => p.page);
}

/** A short label identifying where a table came from, used for sheet names,
 *  the Source column, and the file list. */
export function tableLabel(t: PdfTable, tablesOnPage: number): string {
  return tablesOnPage > 1 ? `p${t.page}-${t.index}` : `p${t.page}`;
}

/** Turn a reconstructed table into the SheetData the rest of the app speaks. */
export function toSheet(t: PdfTable, name: string): SheetData {
  return { name, headers: t.headers, rows: t.rows, totalRows: t.totalRows };
}
