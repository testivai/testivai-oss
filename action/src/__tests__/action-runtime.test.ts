/**
 * Both actions must run on a supported Node runtime. Node 20 reached
 * end-of-life on 2026-04-30, and GitHub logs a deprecation warning in every
 * consumer run of a node20 action while forcing it onto Node 24.
 *
 * The reporter (action.yml) declares its own runtime, and its esbuild bundle
 * must target the same Node version. The approve action is composite: it runs
 * on whatever each action it uses declares, so each of those must be at a
 * major that ships on node24.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const RUNTIME = 'node24';

// The first major of each action used by approve/action.yml that runs on
// node24, from that action's release notes. An action added to the approve
// steps needs an entry here.
const FIRST_NODE24_MAJOR: Record<string, number> = {
  'actions/checkout': 5,
  'actions/github-script': 8,
};

describe('reporter action runtime', () => {
  it(`action.yml runs on ${RUNTIME}`, () => {
    const action = parse(read('action.yml')) as { runs: { using: string } };
    expect(action.runs.using).toBe(RUNTIME);
  });

  it('the dist bundle targets the Node version the action runs on', () => {
    const pkg = JSON.parse(read('action/package.json')) as { scripts: { build: string } };
    expect(pkg.scripts.build).toMatch(new RegExp(`--target=${RUNTIME}(\\s|$)`));
  });
});

describe('approve action runtime', () => {
  const steps = (parse(read('approve/action.yml')) as { runs: { steps: { name?: string; uses?: string }[] } }).runs
    .steps;
  const uses = steps.filter((s) => s.uses).map((s) => [s.name ?? '(unnamed)', s.uses!] as const);

  it('uses at least one action', () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  it.each(uses)(`%s: %s runs on ${RUNTIME}`, (_name, ref) => {
    const [action, version] = ref.split('@');
    expect(Object.keys(FIRST_NODE24_MAJOR)).toContain(action);
    const major = Number(/^v(\d+)/.exec(version ?? '')?.[1]);
    expect(major).toBeGreaterThanOrEqual(FIRST_NODE24_MAJOR[action]);
  });
});
