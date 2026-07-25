import { describe, it, expect } from 'vitest';
import { toIpynb, fromIpynb, titleFromIpynb, renderMarkdown, type NotebookCell } from '../../src/core/notebook';

describe('ipynb round-trip', () => {
  it('serializes code + markdown cells and reads them back', () => {
    const cells: NotebookCell[] = [
      { kind: 'markdown', source: '# Notes\nSome context' },
      { kind: 'code', source: 'x = 1\nx + 1', stdout: 'hi', outputs: [{ type: 'text', text: '2' }], execCount: 1 },
    ];
    const json = toIpynb(cells);
    const nb = JSON.parse(json);
    expect(nb.nbformat).toBe(4);
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[1].outputs.map((o: { output_type: string }) => o.output_type)).toEqual(['stream', 'execute_result']);
    expect(nb.cells[1].execution_count).toBe(1);

    expect(fromIpynb(json)).toEqual(cells);
  });

  it('keeps table results whole — headers, every row, and cell types', () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`row ${i}`, i, i % 2 === 0, null] as const);
    const cells: NotebookCell[] = [
      {
        kind: 'code',
        source: 'df_sales.head()',
        outputs: [{ type: 'table', headers: ['Name', 'Amt', 'Flag', 'Blank'], rows: rows.map((r) => [...r]) }],
      },
    ];
    const back = fromIpynb(toIpynb(cells));
    expect(back[0].outputs).toHaveLength(1);
    const out = back[0].outputs![0];
    expect(out.type).toBe('table');
    if (out.type !== 'table') throw new Error('expected a table');
    expect(out.headers).toEqual(['Name', 'Amt', 'Flag', 'Blank']);
    expect(out.rows).toHaveLength(120);
    expect(out.rows[7]).toEqual(['row 7', 7, false, null]);
  });

  it('writes an HTML table Jupyter can render, with the values escaped', () => {
    const json = toIpynb([
      { kind: 'code', source: 'x', outputs: [{ type: 'table', headers: ['A'], rows: [['<script>bad</script>']] }] },
    ]);
    const html = JSON.parse(json).cells[0].outputs[0].data['text/html'].join('');
    expect(html).toContain('<table');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('round-trips charts as image/png', () => {
    const cells: NotebookCell[] = [{ kind: 'code', source: 'plot()', outputs: [{ type: 'image', png: 'iVBORw0KGgo=' }] }];
    const nb = JSON.parse(toIpynb(cells));
    expect(nb.cells[0].outputs[0]).toMatchObject({ output_type: 'display_data' });
    expect(fromIpynb(toIpynb(cells))[0].outputs).toEqual([{ type: 'image', png: 'iVBORw0KGgo=' }]);
  });

  it('keeps the error text so a failed cell still explains itself after reload', () => {
    const cells: NotebookCell[] = [{ kind: 'code', source: 'boom', error: 'Traceback…\nKeyError: \'Amt\'' }];
    const back = fromIpynb(toIpynb(cells));
    expect(back[0].error).toContain("KeyError: 'Amt'");
  });

  it('reads outputs written by real Jupyter, including charts', () => {
    const foreign = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          cell_type: 'code',
          source: ['print(1)\n', 'print(2)'],
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['1\n', '2\n'] },
            { output_type: 'display_data', data: { 'image/png': 'AAAA' } },
            { output_type: 'execute_result', data: { 'text/plain': ['42'] } },
          ],
          execution_count: 3,
        },
        { cell_type: 'raw', source: ['ignored'] },
      ],
    });
    const cells = fromIpynb(foreign);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'code', source: 'print(1)\nprint(2)', stdout: '1\n2\n', execCount: 3 });
    expect(cells[0].outputs).toEqual([
      { type: 'image', png: 'AAAA' },
      { type: 'text', text: '42' },
    ]);
  });

  it('strips the colour codes Jupyter writes into tracebacks', () => {
    const foreign = JSON.stringify({
      nbformat: 4,
      cells: [{ cell_type: 'code', source: ['x'], outputs: [{ output_type: 'error', ename: 'NameError', evalue: 'x', traceback: ['[0;31mNameError[0m: x'] }] }],
    });
    expect(fromIpynb(foreign)[0].error).toBe('[0;31mNameError[0m: x'.replace(/\[[0-9;]*m/g, ''));
  });

  it('round-trips folded code and folded results in the fields Jupyter uses', () => {
    const cells: NotebookCell[] = [
      { kind: 'code', source: 'x = 1', sourceHidden: true, outputsHidden: true, elapsedMs: 412.7 },
      { kind: 'markdown', source: '# note', sourceHidden: true },
    ];
    const nb = JSON.parse(toIpynb(cells));
    expect(nb.cells[0].metadata).toMatchObject({ jupyter: { source_hidden: true }, collapsed: true });
    expect(nb.cells[1].metadata.jupyter.source_hidden).toBe(true);

    const back = fromIpynb(toIpynb(cells));
    expect(back[0]).toMatchObject({ sourceHidden: true, outputsHidden: true, elapsedMs: 413 });
    expect(back[1].sourceHidden).toBe(true);
  });

  it('leaves metadata clean when nothing is folded', () => {
    const nb = JSON.parse(toIpynb([{ kind: 'code', source: 'x' }]));
    expect(nb.cells[0].metadata).toEqual({});
    expect(fromIpynb(toIpynb([{ kind: 'code', source: 'x' }]))[0].sourceHidden).toBeUndefined();
  });

  it('honours folded state set by real Jupyter', () => {
    const foreign = JSON.stringify({
      nbformat: 4,
      cells: [{ cell_type: 'code', source: ['x'], metadata: { collapsed: true, jupyter: { source_hidden: true } } }],
    });
    expect(fromIpynb(foreign)[0]).toMatchObject({ sourceHidden: true, outputsHidden: true });
  });

  it('carries the notebook\'s name, and survives a file that has none', () => {
    const json = toIpynb([{ kind: 'code', source: 'x' }], '  Q1 GST reconciliation  ');
    expect(JSON.parse(json).metadata.exceltools.title).toBe('Q1 GST reconciliation');
    expect(titleFromIpynb(json)).toBe('Q1 GST reconciliation');

    // No name given, and a foreign notebook that never had one.
    expect(JSON.parse(toIpynb([{ kind: 'code', source: 'x' }])).metadata.exceltools).toBeUndefined();
    expect(titleFromIpynb(toIpynb([{ kind: 'code', source: 'x' }], '   '))).toBe('');
    expect(titleFromIpynb('{"nbformat":4,"cells":[]}')).toBe('');
    expect(titleFromIpynb('not json')).toBe('');
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
