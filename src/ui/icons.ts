// Small inline outline-icon set (Lucide-style, 24px grid, currentColor stroke).
// Inlined rather than a sprite so paths resolve under any base/subpath and stay
// offline-safe. See docs/licenses/LICENSE-Lucide.txt.

const P: Record<string, string> = {
  // Spreadsheet grid — the product mark.
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"/><path d="m9 12 2 2 4-4"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

/** Return inline SVG markup for an icon. Decorative by default (aria-hidden). */
export function icon(name: keyof typeof P, opts: { label?: string; cls?: string } = {}): string {
  const a11y = opts.label ? `role="img" aria-label="${opts.label}"` : 'aria-hidden="true"';
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  return `<svg${cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${P[name]}</svg>`;
}

export type IconName = keyof typeof P;

// Per-tool line icons (18px grid). Keyed by tool id.
const TOOL: Record<string, string[]> = {
  viewer: ['M1 9s3-5.5 8-5.5S17 9 17 9s-3 5.5-8 5.5S1 9 1 9Z', 'M9 11.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z'],
  convert: ['M3 6h11M11 2.5 14.5 6 11 9.5', 'M15 12H4M7 8.5 3.5 12 7 15.5'],
  merge: ['M3 3v4a4 4 0 0 0 4 4h8', 'M3 15v-4a4 4 0 0 1 4-4', 'M12 8l3 3-3 3'],
  split: ['M3 9h5', 'M8 9c3 0 3-4 7-4', 'M8 9c3 0 3 4 7 4', 'M13 3l2 2-2 2', 'M13 11l2 2-2 2'],
  compare: ['M9 2v14', 'M5 5H2v8h3', 'M13 5h3v8h-3'],
  clean: ['M12 2 6 8', 'M6 8l-3.5 6.5a1 1 0 0 0 1.3 1.3L10.5 12', 'M6 8l4.5 4.5', 'M14 6l1.5 1.5M12.5 9.5 14 11'],
  dedupe: ['M6 6h9v9H6z', 'M12 6V3H3v9h3', 'M8.5 10.5l1.5 1.5 3-3'],
  query: ['M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M12 12l4 4', 'M6 7.5 7.5 9 6 10.5'],
  pivot: ['M2.5 2.5h13v13h-13z', 'M2.5 6.5h13M6.5 2.5v13', 'M9 12l2-2 2 2 2-3'],
  python: ['M3.5 2.5h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z', 'M6.5 2.5v13', 'M9 6h4M9 9h4M9 12h2.5'],
};

/** Inline SVG for a tool's icon (18px, currentColor stroke). */
export function iconTool(id: string): string {
  const paths = (TOOL[id] || TOOL.viewer).map((d) => `<path d="${d}"/>`).join('');
  return `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
