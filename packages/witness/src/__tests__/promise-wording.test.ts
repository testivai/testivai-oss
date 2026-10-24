/**
 * What stays free is promised in one place: the "What stays free" section of
 * docs/philosophy.md. Older wording mixed promises about the software (MIT,
 * no account, no telemetry) with forever-promises about money ("no paid tier",
 * "no pricing page waiting to appear"). This test keeps the second kind from
 * coming back anywhere a reader or a coding agent looks. CHANGELOGs are
 * history and are never scanned.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf-8');

const FILES = [
  'README.md',
  'ROADMAP.md',
  'CLAUDE.md',
  'AGENTS.md',
  'REVIEW.md',
  'CONTRIBUTING.md',
  'SKILLS.md',
  'action/README.md',
  'approve/README.md',
  'review/README.md',
  'publish/README.md',
  'python/README.md',
  'ruby/README.md',
  'java/README.md',
];

/** Never allowed, in any case or line wrapping. */
const FORBIDDEN = [
  'no paid tier',
  'no account, ever',
  'the whole product',
  'no pricing page',
  'hosted service to upsell',
  'oss-only',
];

/** Allowed only as a present-tense fact: "today" in the same sentence. */
const PRESENT_TENSE_ONLY = 'no hosted service';

function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownUnder(rel));
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

function scannedFiles(): string[] {
  const packageReadmes = fs
    .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/README.md`);
  return [...new Set([...FILES, ...markdownUnder('docs'), ...packageReadmes])]
    .filter((file) => path.basename(file).toLowerCase() !== 'changelog.md')
    .filter((file) => fs.existsSync(path.join(ROOT, file)))
    .sort();
}

/** Matches the phrase case-insensitively, across line breaks. */
function phraseRegex(phrase: string): RegExp {
  const words = phrase.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('\\s+'), 'gi');
}

const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length;

/** The sentence around a match: back to the previous sentence end, blank line or list item, forward to the next. */
function sentenceAround(source: string, index: number, length: number): string {
  const boundary = /[.!?](?=\s)|\n\s*\n|\n[ \t]*(?:[-*+]|\d+\.|#{1,6}|\|)[ \t]/g;
  let start = 0;
  let end = source.length;
  for (const m of source.matchAll(boundary)) {
    const at = m.index ?? 0;
    if (at + m[0].length <= index) start = at + m[0].length;
    else if (at >= index + length) {
      end = at;
      break;
    }
  }
  return source.slice(start, end);
}

/** Every forbidden phrase in the source, as `line: phrase`. */
function violations(source: string): string[] {
  const found: { line: number; message: string }[] = [];
  for (const phrase of FORBIDDEN) {
    for (const m of source.matchAll(phraseRegex(phrase))) {
      found.push({ line: lineOf(source, m.index ?? 0), message: `"${phrase}"` });
    }
  }
  for (const m of source.matchAll(phraseRegex(PRESENT_TENSE_ONLY))) {
    const at = m.index ?? 0;
    if (!/\btoday\b/i.test(sentenceAround(source, at, m[0].length))) {
      found.push({
        line: lineOf(source, at),
        message: `"${PRESENT_TENSE_ONLY}" without "today" in the same sentence`,
      });
    }
  }
  return found.sort((a, b) => a.line - b.line).map((f) => `${f.line}: ${f.message}`);
}

describe('the wording check itself', () => {
  it('finds a forbidden phrase in any case, even wrapped across lines', () => {
    expect(violations('There is no paid\ntier here.')).toEqual(['1: "no paid tier"']);
    expect(violations('- **Local-first, OSS-Only.**')).toEqual(['1: "oss-only"']);
    expect(violations('a\nb\nThat is the whole product.')).toEqual(['3: "the whole product"']);
  });

  it('allows "no hosted service" only with "today" in the same sentence', () => {
    expect(violations('Today there is no paid product and no hosted service.')).toEqual([]);
    expect(violations('Today there is no paid product\nand no hosted service.')).toEqual([]);
    expect(violations('There is no hosted service.')).toEqual([
      '1: "no hosted service" without "today" in the same sentence',
    ]);
    // "today" in a neighbouring sentence, paragraph or list item does not count
    expect(violations('Released today. There is no hosted service.')).toHaveLength(1);
    expect(violations('Released today\n\nThere is no hosted service.')).toHaveLength(1);
    expect(violations('- Released today\n- There is no hosted service')).toHaveLength(1);
  });
});

describe('promise wording', () => {
  const files = scannedFiles();

  it('scans the docs and the agent rules, never a CHANGELOG', () => {
    for (const file of ['README.md', 'CLAUDE.md', 'AGENTS.md', 'REVIEW.md', 'ROADMAP.md',
      'docs/philosophy.md', 'docs/maintenance.md', 'packages/witness/README.md']) {
      expect(files).toContain(file);
    }
    expect(files.filter((file) => /changelog\.md$/i.test(file))).toEqual([]);
  });

  it('no forever-statement about money comes back', () => {
    const found = files.flatMap((file) => violations(read(file)).map((v) => `${file}:${v}`));
    expect(found).toEqual([]);
  });

  it('docs/philosophy.md carries the "What stays free" promise', () => {
    const philosophy = read('docs/philosophy.md');
    expect(philosophy).toMatch(/^## What stays free$/m);
    expect(philosophy).toContain('**Nothing moves out of the free packages.**');
    expect(philosophy).toContain(
      '**Nothing in your CI will ever depend on an account, a key or a license.**',
    );
    expect(philosophy).toContain('**No telemetry.**');
    expect(philosophy).toMatch(/(?:^|[.!?]\s+)Today there is no paid product/m);
  });
});
