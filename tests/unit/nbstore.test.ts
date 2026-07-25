import { describe, it, expect, beforeEach } from 'vitest';
import { saveDraft, loadDraft, clearDraft, describeAge } from '../../src/core/nbstore';
import type { NotebookCell } from '../../src/core/notebook';

/** Minimal localStorage stand-in; `limit` forces the quota path. */
function fakeStorage(limit = Infinity) {
  const map = new Map<string, string>();
  return {
    store: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > limit) throw new Error('QuotaExceededError');
        map.set(k, v);
      },
      removeItem: (k: string) => void map.delete(k),
    },
    size: () => (map.get('exceltools.notebook.draft.v1') ?? '').length,
  };
}

beforeEach(() => {
  const fake = fakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: fake.store, configurable: true });
});

const cells: NotebookCell[] = [
  { kind: 'markdown', source: '# Month end' },
  {
    kind: 'code',
    source: 'df_gl.head()',
    stdout: 'ok',
    execCount: 3,
    outputs: [
      { type: 'table', headers: ['A'], rows: Array.from({ length: 400 }, (_, i) => [i]) },
      { type: 'image', png: 'x'.repeat(50_000) },
    ],
  },
];

describe('notebook draft storage', () => {
  it('saves and restores the work, keeping sources exactly', () => {
    saveDraft(cells, ['gl']);
    const draft = loadDraft()!;
    expect(draft.cells.map((c) => c.source)).toEqual(['# Month end', 'df_gl.head()']);
    expect(draft.tables).toEqual(['gl']);
    expect(draft.cells[1].execCount).toBe(3);
  });

  it('drops charts and trims long tables so a draft stays small', () => {
    saveDraft(cells, []);
    const out = loadDraft()!.cells[1].outputs!;
    expect(out.some((o) => o.type === 'image')).toBe(false);
    const table = out.find((o) => o.type === 'table');
    expect(table && table.type === 'table' && table.rows.length).toBe(50);
  });

  it('drops results rather than losing the notebook to a full quota', () => {
    const fake = fakeStorage(300);
    Object.defineProperty(globalThis, 'localStorage', { value: fake.store, configurable: true });
    saveDraft(cells, ['gl']);
    const draft = loadDraft();
    expect(draft).not.toBeNull();
    expect(draft!.cells.map((c) => c.source)).toEqual(['# Month end', 'df_gl.head()']);
    expect(draft!.cells[1].outputs).toBeUndefined();
    expect(draft!.cells[1].stdout).toBe('ok'); // sources and context still survive
  });

  it('keeps the sources when even a trimmed draft will not fit', () => {
    const fake = fakeStorage(200);
    Object.defineProperty(globalThis, 'localStorage', { value: fake.store, configurable: true });
    saveDraft(cells, ['gl']);
    expect(loadDraft()!.cells.map((c) => c.source)).toEqual(['# Month end', 'df_gl.head()']);
  });

  it('treats an all-empty notebook as nothing to restore', () => {
    saveDraft([{ kind: 'code', source: '   ' }], []);
    expect(loadDraft()).toBeNull();
  });

  it('never lets an empty notebook delete a stored draft', () => {
    // A freshly mounted tool is empty. If that overwrote or cleared the draft,
    // switching tabs before selecting Restore would destroy the work.
    saveDraft(cells, ['gl']);
    saveDraft([{ kind: 'code', source: '' }], []);
    expect(loadDraft()!.cells.map((c) => c.source)).toEqual(['# Month end', 'df_gl.head()']);
  });

  it('clears on request and survives unreadable storage', () => {
    saveDraft(cells, []);
    clearDraft();
    expect(loadDraft()).toBeNull();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => 'not json',
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      },
      configurable: true,
    });
    expect(loadDraft()).toBeNull();
    expect(() => saveDraft(cells, [])).not.toThrow();
    expect(() => clearDraft()).not.toThrow();
  });
});

describe('describeAge', () => {
  it('reads like a person wrote it', () => {
    const now = Date.parse('2026-07-25T12:00:00Z');
    expect(describeAge(now - 20_000, now)).toBe('just now');
    expect(describeAge(now - 60_000, now)).toBe('1 minute ago');
    expect(describeAge(now - 25 * 60_000, now)).toBe('25 minutes ago');
    expect(describeAge(now - 2 * 3600_000, now)).toBe('2 hours ago');
    expect(describeAge(now - 3 * 86400_000, now)).toBe('3 days ago');
  });
});
