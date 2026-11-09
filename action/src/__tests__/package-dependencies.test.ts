/**
 * A runtime dependency of a published package is installed for every user of
 * it. One that no source file imports costs install time and, through its
 * engines field, can raise the Node version the package seems to need:
 * @testivai/witness listed ora (never imported since the package was split
 * out) and ws (chrome-remote-interface brings its own), and Dependabot kept
 * opening major bumps for them (#260).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(file);
    return /\.(ts|js|cjs|mjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [file] : [];
  });
}

/** True when the source loads `name` or one of its subpaths. */
function imports(source: string, name: string): boolean {
  const quoted = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?:from|require\\(|import\\()\\s*['"]${quoted}(?:/[^'"]*)?['"]`).test(source);
}

const PUBLISHED = fs
  .readdirSync(path.join(ROOT, 'packages'))
  .map((dir) => path.join(ROOT, 'packages', dir))
  .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
  .map((dir) => ({ dir, pkg: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) }))
  .filter(({ pkg }) => !pkg.private);

describe('runtime dependencies of the published packages', () => {
  test('finds the packages and their sources', () => {
    expect(PUBLISHED.map(({ pkg }) => pkg.name)).toContain('@testivai/witness');
    for (const { dir } of PUBLISHED) expect(sourceFiles(path.join(dir, 'src')).length).toBeGreaterThan(0);
  });

  test.each(PUBLISHED.map(({ dir, pkg }) => [pkg.name, dir, pkg]))('%s imports every dependency it lists', (_name, dir, pkg) => {
    const source = sourceFiles(path.join(dir, 'src'))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    const unused = Object.keys(pkg.dependencies ?? {}).filter((dep) => !imports(source, dep));
    expect(unused).toEqual([]);
  });

  test('the import check sees each way a module is loaded', () => {
    expect(imports("import chalk from 'chalk';", 'chalk')).toBe(true);
    expect(imports("const { PNG } = require('pngjs');", 'pngjs')).toBe(true);
    expect(imports("await import('@testivai/witness/report');", '@testivai/witness')).toBe(true);
    expect(imports("import { x } from 'chalky';", 'chalk')).toBe(false);
    expect(imports('// uses ora for spinners', 'ora')).toBe(false);
  });
});
