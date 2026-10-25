/**
 * docs/ is also the documentation site (testiv.ai/docs, built by
 * testivai/testivai-site from this folder alone), which fails its build on a
 * broken link. A relative link that leaves docs/ works on GitHub but resolves
 * to nothing on the site, so code elsewhere in the repo is linked with its
 * GitHub URL.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOCS = path.join(ROOT, 'docs');

function markdownUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(abs);
    return /\.mdx?$/.test(entry.name) ? [abs] : [];
  });
}

/** Relative link targets in a Markdown file, code blocks and inline code left out. */
function relativeLinks(markdown: string): string[] {
  const prose = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/`[^`\n]*`/g, '');
  const targets = [...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]);
  return targets.filter((t) => !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(t));
}

describe('relativeLinks', () => {
  it('finds relative targets and skips URLs, anchors, site paths and code', () => {
    const md = [
      'See [a](./a.md), [b](../guides/b.md#x) and [img](img/p.png "title").',
      '[web](https://example.com) [mail](mailto:x@y.z) [top](#top) [site](/docs/intro)',
      'Inline `[no](../../not-a-link)` here.',
      '```md',
      '[also no](../../plugins/x)',
      '```',
    ].join('\n');
    expect(relativeLinks(md)).toEqual(['./a.md', '../guides/b.md#x', 'img/p.png']);
  });
});

const FILES = markdownUnder(DOCS).map((abs) => path.relative(ROOT, abs));

describe('relative links in docs/', () => {
  it.each(FILES)('%s: every relative link stays inside docs/ and points to a file that exists', (file) => {
    const problems: string[] = [];
    for (const target of relativeLinks(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      const resolved = path.resolve(path.dirname(path.join(ROOT, file)), decodeURI(target.split('#')[0]));
      if (path.relative(DOCS, resolved).startsWith('..')) {
        problems.push(`${target}: leaves docs/; link it as https://github.com/testivai/testivai-oss/tree/main/${path.relative(ROOT, resolved)}`);
      } else if (!fs.existsSync(resolved)) {
        problems.push(`${target}: no such file`);
      }
    }
    expect(problems).toEqual([]);
  });
});
