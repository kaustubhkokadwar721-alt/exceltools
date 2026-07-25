import { describe, it, expect } from 'vitest';
import { highlightPython } from '../../src/core/pyhighlight';

describe('highlightPython', () => {
  it('colours keywords, builtins, tables, numbers, strings and comments', () => {
    const html = highlightPython('for x in range(10):  # loop\n    print("hi", df_sales)');
    expect(html).toContain('<span class="tk-kw">for</span>');
    expect(html).toContain('<span class="tk-fn">range</span>');
    expect(html).toContain('<span class="tk-num">10</span>');
    expect(html).toContain('<span class="tk-com"># loop</span>');
    expect(html).toContain('<span class="tk-str">"hi"</span>');
    expect(html).toContain('<span class="tk-tbl">df_sales</span>');
  });

  it('escapes the source — a cell can never inject HTML', () => {
    const html = highlightPython('x = "<img src=x onerror=alert(1)>"');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes inside comments and plain code too', () => {
    expect(highlightPython('# <b>note</b>')).toContain('&lt;b&gt;');
    expect(highlightPython('a < b & c')).toContain('&lt; b &amp; c');
  });

  it('keeps an unterminated string on its own line while typing', () => {
    const html = highlightPython('x = "half\ny = 1');
    expect(html).toContain('<span class="tk-str">"half</span>');
    expect(html).toContain('<span class="tk-num">1</span>');
  });

  it('leaves the text itself unchanged once tags are stripped', () => {
    const code = 'df = df_x[df_x["Amt"] > 1_000.5]  # keep big ones\n';
    const plain = highlightPython(code)
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(plain).toBe(code + '\n'); // one trailing newline keeps the last line visible
  });
});
