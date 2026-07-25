// What the notebook knows about the tables you registered: column kinds, and
// the plain-text schema an AI assistant needs to write code against them.
// Lifted out of the tool UI so both are testable and reusable.
import type { SheetData, ColumnKind } from './types';

const SAMPLE_ROWS = 200;

/** Infer a column's kind from a sample of its non-blank values. */
export function inferColumnKind(sheet: SheetData, index: number): ColumnKind {
  const vals = sheet.rows.slice(0, SAMPLE_ROWS).map((r) => r[index]).filter((v) => v !== null && v !== undefined && v !== '');
  if (!vals.length) return 'text';
  if (vals.every((v) => typeof v === 'number')) return 'number';
  if (vals.every((v) => typeof v === 'boolean')) return 'boolean';
  return 'text';
}

export interface SchemaTable {
  name: string;
  sheet: SheetData;
}

/**
 * The preamble users copy into an AI assistant. It states the exact variable
 * names, the columns and their kinds, and the notebook's display rules — so the
 * code that comes back runs here without editing.
 */
export function schemaTextForAI(tables: SchemaTable[], engine: { pandas: boolean; charts: boolean }): string {
  const lines = [
    engine.pandas
      ? 'I am working in an offline Python notebook in my browser (Pyodide) with pandas' +
        (engine.charts ? ' and matplotlib' : '') +
        '. Each table below is already loaded as a pandas DataFrame named df_<table> — do not read any files, and do not install anything. The last expression in a cell is displayed as a table' +
        (engine.charts ? ', and matplotlib figures are shown automatically' : '') +
        '. Please write notebook Python for my request using exactly these names.'
      : 'I am working in an offline Python notebook in my browser. There is no pandas — each table below is a list of dicts at tables["<name>"]. Please write plain Python (standard library only) for my request; the last expression in a cell is displayed.',
    '',
  ];
  for (const t of tables) {
    lines.push(`Table "${t.name}"${engine.pandas ? ` (DataFrame df_${t.name})` : ''} — ${t.sheet.totalRows.toLocaleString()} rows:`);
    t.sheet.headers.forEach((h, i) => lines.push(`  - "${h}" ${inferColumnKind(t.sheet, i)}`));
    lines.push('');
  }
  lines.push('My request: ');
  return lines.join('\n');
}
