import { describe, it, expect } from 'vitest';
import { toIpynb, fromIpynb, renderMarkdown } from '../../src/core/notebook';

describe('ipynb round-trip', () => {
  it('serializes code + markdown cells and reads them back', () => {
    const cells = [
      { kind: 'markdown' as const, source: '# Notes\nSome context' },
      { kind: 'code' as const, source: 'x = 1\nx + 1', stdout: 'hi', textResult: '2' },
    ];
    const json = toIpynb(cells);
    const nb = JSON.parse(json);
    expect(nb.nbformat).toBe(4);
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[1].outputs.map((o: { output_type: string }) => o.output_type)).toEqual(['stream', 'execute_result']);

    const back = fromIpynb(json);
    expect(back).toEqual([
      { kind: 'markdown', source: '# Notes\nSome context' },
      { kind: 'code', source: 'x = 1\nx + 1' },
    ]);
  });

  it('accepts foreign nbformat-4 notebooks and ignores their outputs', () => {
    const foreign = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: 'code', source: ['print(1)\n', 'print(2)'], outputs: [{ output_type: 'display_data', data: { 'image/png': 'xxxx' } }], execution_count: 3 },
        { cell_type: 'raw', source: ['ignored'] },
      ],
    });
    const cells = fromIpynb(foreign);
    expect(cells).toEqual([{ kind: 'code', source: 'print(1)\nprint(2)' }]);
  });

  it('rejects non-notebook JSON', () => {
    expect(() => fromIpynb('{"foo": 1}')).toThrow();
  });
});

describe('renderMarkdown', () => {
  it('renders headings, emphasis, code and lists — escaped', () => {
    const html = renderMarkdown('# Title\n\n**bold** and *em* and `code`\n\n- a\n- b<script>');
    expect(html).toContain('<h4>Title</h4>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>a</li>');
    expect(html).not.toContain('<script>');
  });
});
