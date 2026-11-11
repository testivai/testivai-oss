/**
 * docs/adapter-parity.md says, per adapter, which capture features it has
 * (DOM snapshot, element map, capture health…), with the file that proves
 * each answer. A table like that rots in two ways: an adapter it lists is
 * moved or removed, or a new adapter lands and nobody adds it. Both fail here,
 * and so does a proof link to a file that no longer exists.
 *
 * Adapters are found the way they are laid out: a JS adapter is a package
 * under packages/ named @testivai/witness-*; another language's adapters live
 * in a top-level folder with that language's build manifest (python/,
 * ruby/, java/).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOC = 'docs/adapter-parity.md';
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
/** The doc, or '' while it does not exist (so a missing doc fails a test, not the whole suite). */
const readDoc = () => (fs.existsSync(path.join(ROOT, DOC)) ? read(DOC) : '');

const FEATURES = [
  'DOM snapshot',
  'Element map',
  'Style digest',
  'Capture until stable',
  'Masks',
  'Capture health',
  'Capture provenance',
  'Per-browser baselines',
];
const STATUSES = ['yes', 'no', 'partial'];
const REPO_LINK = /\]\(https:\/\/github\.com\/testivai\/testivai-oss\/(?:blob|tree)\/main\/([^)#\s]+)/g;
/** A top-level folder holding another language's adapters has one of these. */
const MANIFEST = /^(pyproject\.toml|setup\.py|pom\.xml|build\.gradle(\.kts)?|go\.mod|Cargo\.toml|composer\.json|.+\.gemspec|.+\.csproj)$/;

/** Repo paths linked from a piece of Markdown (links to this repo on GitHub). */
function repoPaths(markdown: string): string[] {
  return [...markdown.matchAll(REPO_LINK)].map((m) => decodeURI(m[1]));
}

/** The rows of the first Markdown table after `heading`, header row first, cells trimmed. */
function tableAfter(markdown: string, heading: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return [];
  const first = lines.findIndex((l, i) => i > start && l.trim().startsWith('|'));
  if (first === -1) return [];
  const rows: string[][] = [];
  for (let i = first; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    if (/^\|[\s|:-]+\|$/.test(lines[i].trim())) continue; // the |---| separator
    rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
  }
  return rows;
}

/** The plain text of a cell: link labels kept, Markdown and code marks dropped. */
const cellText = (cell: string) => cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').trim();

interface Adapter {
  name: string;
  code: string;
  statuses: string[];
}

function summary(): { header: string[]; adapters: Adapter[] } {
  const [header = [], ...rows] = tableAfter(readDoc(), '## Summary');
  const adapters = rows.map((cells) => ({
    name: cellText(cells[0]),
    code: repoPaths(cells[1] ?? '')[0] ?? '',
    statuses: cells.slice(2).map(cellText),
  }));
  return { header: header.map(cellText), adapters };
}

const isJsAdapterPackage = (dir: string) => {
  const manifest = path.join(ROOT, 'packages', dir, 'package.json');
  return fs.existsSync(manifest) && /^@testivai\/witness-/.test(JSON.parse(fs.readFileSync(manifest, 'utf8')).name);
};

const hasLanguageManifest = (dir: string) => fs.readdirSync(path.join(ROOT, dir)).some((f) => MANIFEST.test(f));

/** Every folder in the repo that holds adapters. */
function adapterFolders(): string[] {
  const js = fs.readdirSync(path.join(ROOT, 'packages')).filter(isJsAdapterPackage).map((p) => `packages/${p}`);
  const others = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => d.name)
    .filter(hasLanguageManifest);
  return [...js, ...others].sort();
}

describe('docs/adapter-parity.md', () => {
  const { header, adapters } = summary();

  it('exists', () => {
    expect(fs.existsSync(path.join(ROOT, DOC))).toBe(true);
  });

  it('has a summary table: each adapter, its code, and yes / no / partial for each feature', () => {
    expect(header).toEqual(['Adapter', 'Code', ...FEATURES]);
    expect(adapters.length).toBeGreaterThan(0);
    for (const a of adapters) {
      expect({ adapter: a.name, statuses: a.statuses.length }).toEqual({ adapter: a.name, statuses: FEATURES.length });
    }
    const unknown = adapters.flatMap((a) => a.statuses.filter((s) => !STATUSES.includes(s)).map((s) => `${a.name}: ${s}`));
    expect(unknown).toEqual([]);
  });

  it('finds the adapter folders it checks against', () => {
    // A guard on the discovery itself: if this list goes empty, the next test proves nothing.
    expect(adapterFolders()).toEqual(expect.arrayContaining(['packages/playwright', 'python', 'ruby', 'java']));
  });

  it.each(summary().adapters.map((a) => [a.name, a.code] as const))('%s: its code exists in the repo (%s)', (_name, code) => {
    expect(code).not.toBe('');
    expect(fs.existsSync(path.join(ROOT, code))).toBe(true);
  });

  it.each(adapterFolders())('%s: has a row in the table', (folder) => {
    const rows = adapters.filter((a) => a.code === folder || a.code.startsWith(`${folder}/`));
    expect({ folder, rows: rows.length }).not.toEqual({ folder, rows: 0 });
  });

  it.each(summary().adapters.map((a) => [a.name, a] as const))('%s: its evidence section agrees with the summary, and every file it cites exists', (name, adapter) => {
    const evidence = tableAfter(readDoc(), `### ${name}`);
    expect(evidence[0]?.map(cellText)).toEqual(['Feature', 'Status', 'Where', 'Note']);
    const rows = evidence.slice(1);
    expect(rows.map((r) => cellText(r[0]))).toEqual(FEATURES);
    expect(rows.map((r) => cellText(r[1]))).toEqual(adapter.statuses);
    // Every repo link in the row, the note's included.
    const cited = rows.flatMap((r) => repoPaths(r.slice(2).join(' | ')));
    expect(cited.length).toBeGreaterThanOrEqual(FEATURES.length);
    const missing = cited.filter((p) => !fs.existsSync(path.join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  const LINKS_HERE = /\]\((?:\.\.\/|\.\/)?adapter-parity\.md(#[^)]*)?\)/;
  const FRAMEWORK_PAGES = fs.readdirSync(path.join(ROOT, 'docs', 'frameworks')).filter((f) => f.endsWith('.md'));

  it.each(['docs/README.md', ...FRAMEWORK_PAGES.map((f) => `docs/frameworks/${f}`)])('%s links to it', (page) => {
    expect(read(page)).toMatch(LINKS_HERE);
  });
});
