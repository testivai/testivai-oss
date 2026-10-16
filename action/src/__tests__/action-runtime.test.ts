/**
 * Every action this repo ships must run on a supported Node runtime. Node 20
 * reached end-of-life on 2026-04-30, and GitHub logs a deprecation warning in
 * every consumer run of a node20 action while forcing it onto Node 24.
 *
 * The reporter (action.yml) declares its own runtime, and the esbuild bundles
 * must target the same Node version. The approve and review actions are
 * composite: they run on whatever each action they use declares, so each of
 * those must be at a major that ships on node24.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const RUNTIME = 'node24';

const COMPOSITE_ACTIONS = ['approve/action.yml', 'review/action.yml'];

// The first major of each action the composite actions use that runs on
// node24, from that action's release notes. An action added to their steps
// needs an entry here. claude-code-action is itself composite; at v1 the only
// action it uses is oven-sh/setup-bun v2.2.0, which runs on node24.
const FIRST_NODE24_MAJOR: Record<string, number> = {
  'actions/checkout': 5,
  'actions/github-script': 8,
  'anthropics/claude-code-action': 1,
};

// The arguments actions/github-script@v9 passes to a script (its src/main.ts).
// v9 added getOctokit; a script that redeclares one of these with const or let
// is a SyntaxError and the step fails before it runs.
const GITHUB_SCRIPT_V9_ARGS = [
  'require',
  '__original_require__',
  'github',
  'octokit',
  'getOctokit',
  'context',
  'core',
  'exec',
  'glob',
  'io',
];

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
}

const stepsOf = (file: string) => (parse(read(file)) as { runs: { steps: Step[] } }).runs.steps;

describe('reporter action runtime', () => {
  it(`action.yml runs on ${RUNTIME}`, () => {
    const action = parse(read('action.yml')) as { runs: { using: string } };
    expect(action.runs.using).toBe(RUNTIME);
  });

  it(`every dist bundle targets ${RUNTIME}`, () => {
    const pkg = JSON.parse(read('action/package.json')) as { scripts: { build: string } };
    const targets = [...pkg.scripts.build.matchAll(/--target=(\S+)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets).toEqual(targets.map(() => RUNTIME));
  });
});

describe.each(COMPOSITE_ACTIONS)('%s runtime', (file) => {
  const steps = stepsOf(file);
  const uses = steps.filter((s) => s.uses).map((s) => [s.name ?? '(unnamed)', s.uses!] as const);
  const scripts = steps
    .filter((s) => s.uses?.startsWith('actions/github-script@'))
    .map((s) => [s.name ?? '(unnamed)', s.with!.script] as const);

  it('uses at least one action', () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  it.each(uses)(`%s: %s runs on ${RUNTIME}`, (_name, ref) => {
    const [action, version] = ref.split('@');
    expect(Object.keys(FIRST_NODE24_MAJOR)).toContain(action);
    const major = Number(/^v(\d+)/.exec(version ?? '')?.[1]);
    expect(major).toBeGreaterThanOrEqual(FIRST_NODE24_MAJOR[action]);
  });

  it.each(scripts)('%s compiles with the arguments github-script@v9 passes', (_name, script) => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    expect(() => new AsyncFunction(...GITHUB_SCRIPT_V9_ARGS, script)).not.toThrow();
  });
});
