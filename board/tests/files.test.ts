import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';

describe('file links in Markdown', () => {
  it('turns a link to a file on the Mac into a chip with Open and Show in Finder', () => {
    const html = renderMarkdown('[report.csv](file:///Users/me/Downloads/report.csv)');
    expect(html).toContain('<span class="fchip" data-file="file:///Users/me/Downloads/report.csv"');
    expect(html).toContain('<span class="fname">report.csv</span>');
    expect(html).toContain('data-act="open"');
    expect(html).toContain('data-act="reveal"');
    expect(html).not.toContain('<a ');
  });

  it('does the same for absolute and ~ paths, and a path alone in inline code', () => {
    expect(renderMarkdown('[notes](~/notes.md)')).toContain('data-file="~/notes.md"');
    expect(renderMarkdown('[x](/Users/me/x.pdf)')).toContain('data-file="/Users/me/x.pdf"');
    expect(renderMarkdown('saved at `/Users/me/Downloads/a.csv`')).toContain('title="/Users/me/Downloads/a.csv"><span class="fname"><code>/Users/me/Downloads/a.csv</code>');
  });

  it('keeps code in a link label', () => {
    expect(renderMarkdown('[`report.csv`](file:///Users/me/report.csv)')).toContain('<span class="fname"><code>report.csv</code></span>');
    expect(renderMarkdown('[`x`](https://example.com)')).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer"><code>x</code></a>');
  });

  it('reads an encoded path whole', () => {
    expect(renderMarkdown('[r](file:///Users/me/report%20%281%29.csv)')).toContain('data-file="file:///Users/me/report%20%281%29.csv"');
  });

  it('leaves other inline code and web links alone', () => {
    expect(renderMarkdown('run `/api/jobs/` or `ls -la`')).not.toContain('fchip');
    expect(renderMarkdown('[jobs](/api/jobs/)')).not.toContain('fchip');
    const web = renderMarkdown('[report](https://claude.ai/artifact/abc)');
    expect(web).toContain('<a href="https://claude.ai/artifact/abc" target="_blank"');
    expect(web).not.toContain('fchip');
  });

  it('escapes what it puts in attributes', () => {
    const html = renderMarkdown('[a"b](/Users/me/a"onclick="x.csv)');
    expect(html).not.toContain('"onclick=');
  });
});

describe('lists in Markdown', () => {
  it('reads a • line as a bullet', () => {
    expect(renderMarkdown('Differences:\n• the env vars;\n• the probes')).toBe('<p>Differences:</p><ul><li>the env vars;</li><li>the probes</li></ul>');
  });
});
