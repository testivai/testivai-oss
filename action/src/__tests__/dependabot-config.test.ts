/**
 * .github/dependabot.yml opens update PRs that CI and the release must be able
 * to take. Five of eight open Dependabot PRs (Nov 2026) could never merge:
 *
 * - An npm entry for `/action`, a pnpm workspace member: Dependabot changed
 *   action/package.json but cannot update the workspace's one lockfile, so
 *   `pnpm install --frozen-lockfile` failed (#42, #131, #139). The root entry
 *   already updates action/package.json.
 * - changesets/action 2 runs only with Changesets CLI 3. Bumped alone, it
 *   breaks release.yml, which runs on main only, so the PR's CI stayed green.
 * - TypeScript 7 has no JavaScript compiler API, which ts-jest needs (#145).
 * - @types/node 26 on packages that support Node 18 hides APIs that are
 *   missing there (#155).
 * - React in examples/expo-web is pinned by the Expo SDK (#252 broke `npm ci`
 *   there).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '..', '..', '..');

interface Ignore {
  'dependency-name': string;
  versions?: string[];
  'update-types'?: string[];
}
interface Update {
  'package-ecosystem': string;
  directory: string;
  ignore?: Ignore[];
}

const updates = (): Update[] =>
  (parse(fs.readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8')) as { updates: Update[] }).updates;
const entry = (ecosystem: string, directory = '/'): Update => {
  const found = updates().find((u) => u['package-ecosystem'] === ecosystem && u.directory === directory);
  if (!found) throw new Error(`no ${ecosystem} entry for ${directory}`);
  return found;
};
const ignored = (u: Update, name: string): Ignore | undefined => u.ignore?.find((i) => i['dependency-name'] === name);
const major = (range: string): number => Number(/(\d+)/.exec(range)?.[1]);
const rootPackage = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('.github/dependabot.yml', () => {
  test('every npm entry covers a directory with its own lockfile', () => {
    // A workspace member's PR would change its package.json and not the
    // root lockfile, so its CI could never pass.
    for (const u of updates().filter((x) => x['package-ecosystem'] === 'npm')) {
      const dir = path.join(ROOT, u.directory);
      const lockfiles = ['pnpm-lock.yaml', 'package-lock.json'].filter((f) => fs.existsSync(path.join(dir, f)));
      expect({ directory: u.directory, lockfiles }).toEqual({ directory: u.directory, lockfiles: expect.arrayContaining([expect.any(String)]) });
    }
  });

  test('changesets/action stays on v1 while the Changesets CLI is v2', () => {
    const cli = major(rootPackage().devDependencies['@changesets/cli']);
    const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    if (cli < 3) {
      expect(release).toMatch(/uses: changesets\/action@v1\b/);
      expect(ignored(entry('github-actions'), 'changesets/action')?.versions).toEqual(['>=2']);
    }
  });

  test('TypeScript 7 waits for a ts-jest that can load it', () => {
    expect(ignored(entry('npm'), 'typescript')?.versions).toEqual(['>=7']);
  });

  test('@types/node takes no major update', () => {
    expect(ignored(entry('npm'), '@types/node')?.['update-types']).toEqual(['version-update:semver-major']);
  });

  test("React follows the Expo SDK in examples/expo-web, not Dependabot", () => {
    for (const name of ['react', 'react-dom']) {
      expect(ignored(entry('npm'), name)).toBeDefined();
    }
  });
});
