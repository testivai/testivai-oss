/**
 * The pages people land on first (the READMEs, the docs index, the CI guide)
 * describe the GitHub Action in a sentence or two. They must not fall behind
 * what it does: since publish@v1 a run's report can open on GitHub Pages,
 * linked from the PR comment, and the example's Pages site is a list of runs
 * with the three-verdict demo report at /demo/.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function markdownUnder(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : markdownUnder(rel);
    return entry.name.endsWith('.md') ? [rel] : [];
  });
}

const PACKAGE_READMES = fs
  .readdirSync(path.join(ROOT, 'packages'))
  .map((p) => path.join('packages', p, 'README.md'))
  .filter((f) => fs.existsSync(path.join(ROOT, f)));

const ALL_MARKDOWN = ['README.md', 'SKILLS.md', 'AGENTS.md', 'CLAUDE.md', 'action/README.md', ...PACKAGE_READMES, ...markdownUnder('docs'), ...markdownUnder('examples')];

// testivai-example's GitHub Pages site: its front page lists every published
// run; the report with the three verdicts is at /demo/.
const EXAMPLE_PAGES = 'https://testivai.github.io/testivai-example/';
const EXAMPLE_DEMO = `${EXAMPLE_PAGES}demo/`;

/** Markdown links to the example's Pages site: [label](url), the label an image's alt text when it wraps one. */
function exampleLinks(markdown: string): { label: string; url: string }[] {
  const links = markdown.matchAll(/\[(!\[([^\]]*)\]\([^)]*\)|[^\]]*)\]\((https:\/\/testivai\.github\.io\/testivai-example\/[^)\s]*)\)/g);
  return [...links].map((m) => ({ label: m[2] ?? m[1], url: m[3] }));
}

describe("links to testivai-example's live report", () => {
  it('the docs link it', () => {
    expect(ALL_MARKDOWN.flatMap((f) => exampleLinks(read(f))).length).toBeGreaterThan(0);
  });

  it.each(ALL_MARKDOWN)('%s: a link that promises a report opens the demo report, not the list of runs', (file) => {
    for (const { label, url } of exampleLinks(read(file))) {
      if (/\breport\b/i.test(label)) expect({ label, url }).toEqual({ label, url: EXAMPLE_DEMO });
    }
  });
});

// Where each page describes the action, and the link to the Pages section it
// should carry (relative where the page lives in this repo's docs, absolute
// on a package README, which npm shows without the repo around it).
const PAGES_SECTION = /github-action(\.md)?#reports-on-github-pages/;
const ENTRY_POINTS: [file: string, describes: RegExp][] = [
  ['README.md', /\*\*PR-native workflow\*\*[^\n]*/],
  ['docs/README.md', /\*\*\[GitHub Action\]\([^)]*\)\*\*[^\n]*/],
  ['docs/intro.md', /\*\*\[GitHub Action\]\([^)]*\)\*\*[^\n]*/],
  ['docs/guides/ci-cd.md', /> For a richer PR workflow[^\n]*/],
  ['packages/witness/README.md', /\*\*In a PR\*\*[^\n]*/],
  ['action/README.md', /## What it posts\n[\s\S]*?\n## /],
];

describe('pages that describe the GitHub Action mention reports on GitHub Pages', () => {
  it.each(ENTRY_POINTS)('%s', (file, describes) => {
    const passage = read(file).match(describes)?.[0];
    expect(passage).toBeDefined();
    expect(passage).toMatch(/GitHub Pages/);
    expect(passage).toMatch(PAGES_SECTION);
  });
});

describe('troubleshooting: no report link in the PR comment', () => {
  const doc = read('docs/guides/troubleshooting.md');
  const start = doc.indexOf('#### No report link in the PR comment');
  const entry = start === -1 ? '' : doc.slice(start, doc.indexOf('\n#', start + 1));

  it('has an entry', () => {
    expect(entry).not.toBe('');
  });

  // Each reason publish@v1 publishes nothing, or adds no link, and where it is documented.
  it.each([
    ['Pages source not set to GitHub Actions', /GitHub Actions/, '#who-can-open-the-reports'],
    ['a private repository with a public Pages site', /TESTIVAI_PUBLIC_REPORTS/, '#who-can-open-the-reports'],
    // Not '#setup': the AI triage section's Setup heading comes first and takes that id.
    ['the publish workflow is not on the default branch yet', /default branch/, '#reports-on-github-pages'],
    ['a run GITHUB_TOKEN started (an approve push)', /GITHUB_TOKEN/, '#approve-with-a-token-that-re-runs-ci'],
  ])('names %s, and links where it is documented', (_reason, says, section) => {
    const bullet = entry.split('\n- ').find((b) => says.test(b));
    expect(bullet).toBeDefined();
    expect(bullet).toContain(`github-action.md${section})`);
  });
});

/** Heading ids as GitHub and Docusaurus make them: a repeated heading gets -1, -2… */
function headingIds(markdown: string): Set<string> {
  const ids = new Set<string>();
  const seen = new Map<string, number>();
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  for (const [, text] of prose.matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    ids.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return ids;
}

describe('links into docs/github-action.md', () => {
  const ids = headingIds(read('docs/github-action.md'));

  it('the id rule matches the headings it is used for', () => {
    expect(ids).toContain('reports-on-github-pages');
    expect(ids).toContain('approve-with-a-token-that-re-runs-ci');
    expect(ids).toContain('setup-1');
  });

  it.each(ALL_MARKDOWN)('%s: every #anchor names a heading there', (file) => {
    for (const [, id] of read(file).matchAll(/github-action(?:\.md)?#([A-Za-z0-9_-]+)/g)) {
      expect({ file, id, exists: ids.has(id) }).toEqual({ file, id, exists: true });
    }
  });
});

// The docs index and Getting started list what TestivAI plugs into. Both name
// the AI triage action and the Claude Code plugin, linking where each is set up.
const PLUGIN_SECTION = 'guides/ai-agents.md#claude-code--the-report-as-a-whole-page-in-the-app';

describe('the docs index and Getting started list the AI triage action and the Claude Code plugin', () => {
  it('the plugin section id is a heading of the AI agents guide', () => {
    expect(headingIds(read('docs/guides/ai-agents.md'))).toContain(PLUGIN_SECTION.split('#')[1]);
  });

  it.each(['docs/README.md', 'docs/intro.md'])('%s', (file) => {
    const doc = read(file);
    const action = doc.match(/\*\*\[GitHub Action\]\([^)]*\)\*\*[^\n]*/)?.[0] ?? '';
    expect(action).toMatch(/review@v1/);
    expect(action).toMatch(/github-action\.md#ai-triage-of-every-diff/);
    expect(doc).toContain(`./${PLUGIN_SECTION}`);
  });
});
