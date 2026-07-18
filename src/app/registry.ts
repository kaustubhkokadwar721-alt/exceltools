// Tool registry: the single list of tools the shell knows about. Phase 1 ships
// the plumbing plus one reference tool (Viewer) that exercises the whole stack:
// dropzone → validation → worker parse → data grid. Phase 2/3 tools register
// here the same way.

export type Tier = 'light' | 'intermediate';

export interface ToolDef {
  id: string; // URL slug, e.g. "viewer"
  title: string;
  blurb: string;
  icon: string; // emoji / glyph
  tier: Tier;
  status: 'ready' | 'planned';
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
    mount: async (root) => (await import('../tools/viewer')).mountViewer(root),
  },
  {
    id: 'convert',
    title: 'Convert',
    blurb: 'Excel ↔ CSV / TSV / JSON / Markdown / HTML.',
    icon: '⇄',
    tier: 'light',
    status: 'ready',
    mount: async (root) => (await import('../tools/converter')).mountConverter(root),
  },
  {
    id: 'merge',
    title: 'Merge',
    blurb: 'Combine multiple files — stack rows or keep separate sheets.',
    icon: '⧉',
    tier: 'light',
    status: 'ready',
    mount: async (root) => (await import('../tools/merge')).mountMerge(root),
  },
  {
    id: 'split',
    title: 'Split',
    blurb: 'Split one sheet into many by rows or a column value.',
    icon: '✂',
    tier: 'light',
    status: 'ready',
    mount: async (root) => (await import('../tools/split')).mountSplit(root),
  },
  {
    id: 'compare',
    title: 'Compare',
    blurb: 'Diff two spreadsheets on a key column.',
    icon: '⇌',
    tier: 'light',
    status: 'ready',
    mount: async (root) => (await import('../tools/compare')).mountCompare(root),
  },
  {
    id: 'clean',
    title: 'Clean',
    blurb: 'Trim, fix case, drop blanks, numbers-from-text.',
    icon: '🧹',
    tier: 'light',
    status: 'ready',
    mount: async (root) => (await import('../tools/clean')).mountClean(root),
  },
  {
    id: 'dedupe',
    title: 'Dedupe',
    blurb: 'Remove duplicate rows by chosen key columns.',
    icon: '🔁',
    tier: 'light',
    status: 'ready',
    mount: async (root) => (await import('../tools/dedupe')).mountDedupe(root),
  },
  {
    id: 'query',
    title: 'Query (SQL)',
    blurb: 'Run SQL over your data. Joins, filters, aggregation.',
    icon: '🔎',
    tier: 'intermediate',
    status: 'ready',
    mount: async (root) => (await import('../tools/query')).mountQuery(root),
  },
  {
    id: 'pivot',
    title: 'Pivot',
    blurb: 'Group-by summaries, like a pivot table.',
    icon: '📊',
    tier: 'intermediate',
    status: 'ready',
    mount: async (root) => (await import('../tools/pivot')).mountPivot(root),
  },
];

export function findTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}
