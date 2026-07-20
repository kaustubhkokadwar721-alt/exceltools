// Tool registry: the single list of tools the shell knows about. Phase 1 ships
// the plumbing plus one reference tool (Viewer) that exercises the whole stack:
// dropzone → validation → worker parse → data grid. Phase 2/3 tools register
// here the same way. `help` powers the in-app "How this works" panel.

export type Tier = 'light' | 'intermediate';

export interface ToolDef {
  id: string; // URL slug, e.g. "viewer"
  title: string;
  blurb: string;
  icon: string; // emoji / glyph
  tier: Tier;
  status: 'ready' | 'planned';
  /** Short numbered steps shown in the tool's "How this works" panel. */
  help?: string[];
  /** Optional single clarifying note under the steps. */
  helpNote?: string;
  /** Mounts the tool UI into `root`. Lazy so Tier-2 engines load on demand. */
  mount?: (root: HTMLElement) => void | Promise<void>;
}

export const TOOLS: ToolDef[] = [
  {
    id: 'viewer',
    title: 'Viewer',
    blurb: 'Open and browse any spreadsheet without Excel.',
    icon: '👁',
    tier: 'light',
    status: 'ready',
    help: [
      'Add a spreadsheet — drag it in or choose from this device.',
      'Switch between sheets using the tabs.',
      'Scroll the grid; only visible rows are rendered, so large files stay smooth.',
    ],
    mount: async (root) => (await import('../tools/viewer')).mountViewer(root),
  },
  {
    id: 'convert',
    title: 'Convert',
    blurb: 'Excel ↔ CSV / TSV / JSON / Markdown / HTML.',
    icon: '⇄',
    tier: 'light',
    status: 'ready',
    help: [
      'Add a spreadsheet and pick the sheet to convert.',
      'Choose an output format: CSV, TSV, JSON, Markdown, HTML or Excel.',
      'Select Convert & download — the file is saved to this device.',
    ],
    helpNote: 'Text formats keep values only — formulas, cell formatting and extra sheets are not preserved.',
    mount: async (root) => (await import('../tools/converter')).mountConverter(root),
  },
  {
    id: 'merge',
    title: 'Merge',
    blurb: 'Combine multiple files — stack rows or keep separate sheets.',
    icon: '⧉',
    tier: 'light',
    status: 'ready',
    help: [
      'Add two or more files; every sheet is listed below.',
      'Stack rows to append them into one sheet, or keep each as a separate sheet.',
      'Select Merge & download.',
    ],
    helpNote: 'Row stacking aligns columns by header name, so files with the same headers combine cleanly.',
    mount: async (root) => (await import('../tools/merge')).mountMerge(root),
  },
  {
    id: 'split',
    title: 'Split',
    blurb: 'Split one sheet into many by rows or a column value.',
    icon: '✂',
    tier: 'light',
    status: 'ready',
    help: [
      'Add a file and pick the sheet.',
      "Split by a column's values (one file per value) or into fixed-size row chunks.",
      'Select Split & download — you get a single .zip of the pieces.',
    ],
    mount: async (root) => (await import('../tools/split')).mountSplit(root),
  },
  {
    id: 'compare',
    title: 'Compare',
    blurb: 'Diff two spreadsheets on a key column.',
    icon: '⇌',
    tier: 'light',
    status: 'ready',
    help: [
      'Add File A (baseline) and File B (compared).',
      'Pick a key column in each — rows are matched on this value.',
      'Select Compare to see only-in-A, only-in-B, changed and unchanged rows, then download the diff.',
    ],
    helpNote: 'If values have stray spaces or case differences, clean both files first so keys match.',
    mount: async (root) => (await import('../tools/compare')).mountCompare(root),
  },
  {
    id: 'clean',
    title: 'Clean',
    blurb: 'Trim, fix case, drop blanks, numbers-from-text.',
    icon: '🧹',
    tier: 'light',
    status: 'ready',
    help: [
      'Add a file and choose which fixes to apply.',
      'Trim and case options normalise text; numbers-from-text turns "1,000" into a real number.',
      'Select Clean & preview, then download.',
    ],
    helpNote: 'Cleaning makes lookups, merges and comparisons reliable.',
    mount: async (root) => (await import('../tools/clean')).mountClean(root),
  },
  {
    id: 'dedupe',
    title: 'Dedupe',
    blurb: 'Remove duplicate rows by chosen key columns.',
    icon: '🔁',
    tier: 'light',
    status: 'ready',
    help: [
      'Add a file and tick the columns that define a duplicate (leave all unticked for exact whole-row matches).',
      'Choose whether to keep the first or last occurrence.',
      'Select Remove duplicates, then download.',
    ],
    helpNote: 'Key matching ignores surrounding spaces and case, so "Acme" and "acme " count as the same.',
    mount: async (root) => (await import('../tools/dedupe')).mountDedupe(root),
  },
  {
    id: 'query',
    title: 'Query (SQL)',
    blurb: 'Run SQL over your data. Joins, filters, aggregation.',
    icon: '🔎',
    tier: 'intermediate',
    status: 'ready',
    help: [
      'Add one or more files — each sheet becomes a table (names are shown above the editor).',
      'Write SQL and run it with the button or Ctrl/⌘+Enter.',
      'Download the result as CSV, Excel or JSON.',
    ],
    helpNote: 'Runs on DuckDB in your browser. Joins, filters and aggregation are supported.',
    mount: async (root) => (await import('../tools/query')).mountQuery(root),
  },
  {
    id: 'python',
    title: 'Python',
    blurb: 'Analyse with Python/pandas — cleaning, custom rules, stats.',
    icon: '🐍',
    tier: 'intermediate',
    status: 'ready',
    help: [
      'Add files, untick/rename what you want, then Register (first use downloads the Python engine once).',
      'Write Python that assigns your answer to a variable called result — with pandas, each table is a DataFrame named df_<table>.',
      'Stuck? Copy schema for AI, paste it into your AI assistant with what you want in plain English, and paste the code back.',
    ],
    helpNote: 'Runs entirely in this browser. Nothing is uploaded.',
    mount: async (root) => (await import('../tools/python')).mountPython(root),
  },
  {
    id: 'pivot',
    title: 'Pivot',
    blurb: 'Group-by summaries, like a pivot table.',
    icon: '📊',
    tier: 'intermediate',
    status: 'ready',
    help: [
      'Add a file, then tick one or more Group by columns.',
      'Choose a value column and an aggregation (Sum, Average, Count, …).',
      'Select Build pivot, then download.',
    ],
    helpNote: 'Sum and Average need a numeric value column.',
    mount: async (root) => (await import('../tools/pivot')).mountPivot(root),
  },
];

export function findTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}
