// Security regression tests.
//
// Most of the app builds DOM through `el()`, which sets text via textContent
// and cannot inject markup. The few places that assemble HTML strings must
// escape every non-literal value first — file names and URL fragments are
// chosen by whoever supplies the file or the link, not by us.
import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../src/ui/controls';
import { renderMarkdown } from '../../src/core/notebook';
import { highlightPython } from '../../src/core/pyhighlight';

const XSS = `<img src=x onerror="alert(1)">`;

describe('escapeHtml', () => {
  it('neutralises every character that can break out of text or an attribute', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes the ampersand first, so nothing can be double-decoded', () => {
    // A naive order turns "&lt;" into "&amp;lt;" — or worse, "&amp;" into "<".
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('defuses a payload aimed at an attribute as well as at text', () => {
    const escaped = escapeHtml(`" onmouseover="alert(1)`);
    expect(escaped).not.toContain('"');
    expect(escapeHtml(XSS)).not.toContain('<img');
  });

  it('leaves ordinary text — including finance punctuation — alone', () => {
    expect(escapeHtml('Invoice #123 (Q1) 1,643,552.00 — final')).toBe('Invoice #123 (Q1) 1,643,552.00 — final');
  });
});

describe('untrusted content rendered as HTML', () => {
  it('markdown notes from an opened .ipynb cannot inject markup', () => {
    const html = renderMarkdown(`# ${XSS}\n\n- <script>alert(1)</script>`);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });

  it('code from an opened .ipynb cannot inject markup through highlighting', () => {
    const html = highlightPython(`x = "${XSS}"  # <script>alert(1)</script>`);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
  });
});
