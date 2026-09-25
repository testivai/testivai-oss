import * as fs from 'fs';
import * as path from 'path';

/**
 * `witness` is the canonical Playwright capture call; `testivai.witness` is a
 * kept alias for existing callers (see src/index.ts). User-facing Playwright
 * examples should teach the canonical form, and every name they import must
 * be a real export of the BUILT package.
 *
 * Scope is Playwright only. A Playwright call is recognised by its signature
 * (`page` first), so the WebdriverIO (`browser`) and Selenium (`driver`)
 * examples, where `testivai.witness` is also a kept alias, are untouched.
 *
 * Requires `dist/` to be built first (CI builds before test).
 */
const REPO_ROOT = path.join(__dirname, '../../../..');
const DIST_INDEX = path.join(__dirname, '../../dist/index.js');

function listFiles(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listFiles(full, ext);
    return ext.test(entry.name) ? [full] : [];
  });
}

const DOC_FILES = [
  path.join(REPO_ROOT, 'README.md'),
  path.join(REPO_ROOT, 'SKILLS.md'),
  path.join(REPO_ROOT, 'packages/playwright/README.md'),
  ...listFiles(path.join(REPO_ROOT, 'docs'), /\.md$/),
  ...listFiles(path.join(REPO_ROOT, 'examples/playwright-local/tests'), /\.[cm]?[jt]s$/),
];

const rel = (file: string) => path.relative(REPO_ROOT, file);

describe('Playwright examples use the canonical witness() call', () => {
  it('scans the user-facing docs and examples (sanity)', () => {
    for (const file of DOC_FILES) expect(fs.existsSync(file)).toBe(true);
    expect(DOC_FILES.length).toBeGreaterThan(5);
  });

  it('no Playwright example calls the testivai.witness(page, ...) alias', () => {
    const offenders: string[] = [];
    for (const file of DOC_FILES) {
      fs.readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (/testivai\.witness\(\s*page\b/.test(line)) offenders.push(`${rel(file)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('no example imports the testivai namespace from @testivai/witness-playwright', () => {
    const importRe = /import\s+\{([^}]+)\}\s+from\s+['"]@testivai\/witness-playwright['"]/g;
    const offenders: string[] = [];
    for (const file of DOC_FILES) {
      for (const match of fs.readFileSync(file, 'utf-8').matchAll(importRe)) {
        const names = match[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
        if (names.includes('testivai')) offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every name imported from @testivai/witness-playwright exists on the built package', () => {
    if (!fs.existsSync(DIST_INDEX)) {
      throw new Error(`${DIST_INDEX} not found — run \`pnpm build\` before this contract test.`);
    }
    const pkg = require(DIST_INDEX);
    const importRe = /import\s+\{([^}]+)\}\s+from\s+['"]@testivai\/witness-playwright['"]/g;
    const missing: string[] = [];
    for (const file of DOC_FILES) {
      for (const match of fs.readFileSync(file, 'utf-8').matchAll(importRe)) {
        for (const raw of match[1].split(',')) {
          const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          if (name && !raw.trim().startsWith('type ') && !(name in pkg)) missing.push(`${rel(file)}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
