/**
 * Every workflow the docs show runs the visual comparison and the report
 * after a failing test too. A CI step runs only on success by default, so
 * without that one failing test (even a non-visual one) skips the compare
 * step and the pull request gets no report, although every capture was taken.
 *
 * GitHub Actions: a step that compares or reports (`testivai report`,
 * `testivai merge-captures`, the reporter action) has `if: ${{ !cancelled() }}`;
 * so does a shard's upload of its captures (a shard with a failing test must
 * still hand them over), and a job that `needs` other jobs and then compares
 * (a failing shard would otherwise skip the whole job). GitLab CI, CircleCI
 * and Jenkins: the same, in their own terms.
 *
 * And the docs say what the action does when a run has no results.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Markdown and workflow files that show CI setups, outside node_modules and changelogs. */
function docFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(rel);
      } else if (/\.(md|ya?ml)$/.test(entry.name) && !/CHANGELOG/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  for (const dir of ['docs', 'examples']) walk(dir);
  for (const file of ['README.md', 'action/README.md', 'python/README.md', 'ruby/README.md', 'java/README.md']) {
    if (fs.existsSync(path.join(ROOT, file))) out.push(file);
  }
  for (const pkg of fs.readdirSync(path.join(ROOT, 'packages'))) {
    const file = path.join('packages', pkg, 'README.md');
    if (fs.existsSync(path.join(ROOT, file))) out.push(file);
  }
  return out.sort();
}

interface Step {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
}

/** The YAML in a file: the file itself, or each ```yaml block of a Markdown file. */
function yamlBlocks(file: string): string[] {
  const text = read(file);
  if (/\.ya?ml$/.test(file)) return [text];
  return [...text.matchAll(/```ya?ml[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

const COMPARES = /\btestivai (report|merge-captures)\b/;
const REPORTER = /^testivai\/testivai-oss@/;

/** A step that compares the captures or reports the result. */
const comparesOrReports = (step: Step) => (typeof step.run === 'string' && COMPARES.test(step.run)) || (typeof step.uses === 'string' && REPORTER.test(step.uses));

/** A step that uploads a shard's captures. */
const uploadsCaptures = (step: Step) =>
  typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@') && String(step.with?.path ?? '').includes('.testivai/temp');

const runsAfterFailure = (condition: unknown) => typeof condition === 'string' && condition.includes('!cancelled()');

/** Every list of steps in a parsed YAML value: a workflow's jobs, or a fragment that is a list of steps. */
function stepLists(value: unknown): Array<{ steps: Step[]; job?: Job }> {
  const found: Array<{ steps: Step[]; job?: Job }> = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      if (v.some((s) => s && typeof s === 'object' && ('run' in s || 'uses' in s))) found.push({ steps: v as Step[] });
      else v.forEach(visit);
      return;
    }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (obj.jobs && typeof obj.jobs === 'object') {
        for (const job of Object.values(obj.jobs as Record<string, Job>)) {
          if (Array.isArray(job?.steps)) found.push({ steps: job.steps, job });
        }
        return;
      }
      if (Array.isArray(obj.steps)) {
        found.push({ steps: obj.steps as Step[], job: obj as Job });
        return;
      }
      Object.values(obj).forEach(visit);
    }
  };
  visit(value);
  return found;
}

/** The GitHub Actions setups in the docs that compare or report, with where they are. */
function githubSetups() {
  const setups: Array<{ where: string; steps: Step[]; job?: Job }> = [];
  for (const file of docFiles()) {
    yamlBlocks(file).forEach((block, i) => {
      if (!COMPARES.test(block) && !/testivai\/testivai-oss@/.test(block)) return;
      let parsed: unknown;
      try {
        parsed = parse(block);
      } catch (err) {
        throw new Error(`${file} block ${i + 1} does not parse: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const { steps, job } of stepLists(parsed)) setups.push({ where: `${file} block ${i + 1}`, steps, job });
    });
  }
  return setups;
}

describe('GitHub Actions setups in the docs run the comparison and the report after a failing test', () => {
  const setups = githubSetups();

  it('finds the setups (the README, the action docs, the CI guide and the package READMEs)', () => {
    const files = new Set(setups.map((s) => s.where.replace(/ block \d+$/, '')));
    for (const file of ['README.md', 'docs/github-action.md', 'docs/guides/ci-cd.md', 'action/README.md', 'packages/playwright/README.md', 'packages/witness/README.md']) {
      expect(files).toContain(file);
    }
  });

  it('every step that compares or reports has `if: ${{ !cancelled() }}`', () => {
    const offenders = setups.flatMap(({ where, steps }) =>
      steps.filter(comparesOrReports).filter((s) => !runsAfterFailure(s.if)).map((s) => `${where}: ${s.name ?? s.run ?? s.uses} (if: ${s.if ?? 'none'})`),
    );
    expect(offenders).toEqual([]);
  });

  it('a shard uploads its captures after a failing test too', () => {
    const uploads = setups.flatMap(({ where, steps }) => steps.filter(uploadsCaptures).map((s) => ({ where, s })));
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.filter(({ s }) => !runsAfterFailure(s.if)).map(({ where }) => where)).toEqual([]);
  });

  it('a job that needs other jobs and then compares or reports runs after their failure too', () => {
    const jobs = setups.filter(({ job, steps }) => job?.needs && steps.some(comparesOrReports));
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.filter(({ job }) => !runsAfterFailure(job?.if)).map(({ where }) => where)).toEqual([]);
  });

  it('the sharded recipe: each shard uploads after a failure, the merge job needs the shards and runs anyway', () => {
    const sharded = setups.filter(({ where }) => where.startsWith('docs/guides/ci-cd.md'));
    const merge = sharded.find(({ steps }) => steps.some((s) => typeof s.run === 'string' && s.run.includes('merge-captures')));
    expect(merge?.job?.needs).toBe('shard');
    expect(merge?.job?.if).toBe('${{ !cancelled() }}');
  });
});

describe('other CI providers in the CI guide', () => {
  const guide = read('docs/guides/ci-cd.md');
  const section = (heading: string) => {
    const start = guide.indexOf(`### ${heading}`);
    expect(start).toBeGreaterThan(-1);
    const end = guide.indexOf('\n### ', start + 1);
    return guide.slice(start, end === -1 ? undefined : end);
  };

  it('GitLab CI: the gate runs after a failing test, and the job still fails for it', () => {
    const gitlab = section('GitLab CI');
    expect(gitlab).toMatch(/npx playwright test \|\| TESTS_FAILED=1/);
    expect(gitlab).toContain('npx testivai report --fail-on-diff');
    expect(gitlab).toMatch(/test -z "\$TESTS_FAILED"/);
    expect(gitlab.indexOf('npx testivai report')).toBeLessThan(gitlab.indexOf('test -z "$TESTS_FAILED"'));
    expect(gitlab).toMatch(/when: always/);
  });

  it('CircleCI: the gate step runs `when: always`', () => {
    const circle = section('CircleCI');
    expect(circle).toMatch(/name: Visual diff gate\n\s+command: npx testivai report --fail-on-diff\n\s+when: always/);
    expect(circle).toMatch(/store_artifacts:\n\s+path: visual-report\n\s+when: always/);
  });

  it('Jenkins: the gate runs in `post { always }`', () => {
    const jenkins = section('Jenkins');
    expect(jenkins).toMatch(/post \{(\s*\/\/[^\n]*)?\s*always \{\s*sh 'npx testivai report --fail-on-diff'/);
    expect(jenkins.slice(0, jenkins.indexOf('post {'))).not.toContain('testivai report');
  });

  it('Jenkins in the witness README: the gate runs in `post { always }` too', () => {
    const readme = read('packages/witness/README.md');
    const jenkins = readme.slice(readme.indexOf('### Jenkins'), readme.indexOf('## Troubleshooting'));
    expect(jenkins).toMatch(/post \{(\s*\/\/[^\n]*)?\s*always \{\s*sh 'npx testivai report --fail-on-diff'/);
    expect(jenkins.slice(0, jenkins.indexOf('post {'))).not.toContain('testivai report');
  });
});

describe('the docs say what the action does without results.json', () => {
  const doc = read('docs/github-action.md');

  it('it compares the captures itself, or says there is no visual report, and how each case is reported', () => {
    expect(doc).toContain('## When a run has no `results.json`');
    expect(doc).toContain('Compared by the TestivAI action');
    expect(doc).toContain('No visual report for this run');
    for (const word of ['`neutral`', '`failure`', '`error`', 'exits 1']) expect(doc).toContain(word);
  });

  it('the troubleshooting guide points at it', () => {
    const troubleshooting = read('docs/guides/troubleshooting.md');
    expect(troubleshooting).toContain('No visual report for this run');
    expect(troubleshooting).toContain('../github-action.md#when-a-run-has-no-resultsjson');
  });
});
