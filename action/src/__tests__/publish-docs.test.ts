/**
 * Contract between the publish action (publish/action.yml) and the docs that
 * tell people how to set it up: the documented workflow passes only inputs
 * the action has, gives the job exactly the permissions it needs, deploys
 * through the github-pages environment, never checks out code, and the limits
 * the docs state are the ones in the code.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { PUBLISH_LIMITS } from '../publish/build';
import { DEFAULT_ARCHIVE_LIMITS } from '../publish/archive';
import { CONSENT_VARIABLE } from '../publish/pages';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const ACTION = parse(read('publish/action.yml')) as { inputs: Record<string, { default?: string }> };
const INPUTS = Object.keys(ACTION.inputs);

interface Step {
  uses?: string;
  run?: string;
  id?: string;
  with?: Record<string, string>;
}
interface Job {
  permissions?: Record<string, string>;
  environment?: { name?: string; url?: string } | string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  steps?: Step[];
}
interface Workflow {
  on: Record<string, { types?: string[]; workflows?: string[] } | null>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, Job>;
}

const DOC = read('docs/github-action.md');
const MB = 1024 * 1024;

/** The doc's workflows that use the publish action. */
const workflows = (markdown: string): Workflow[] =>
  [...markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((b) => b.includes('testivai/testivai-oss/publish@'))
    .map((b) => parse(b) as Workflow);

const publishJobs = (w: Workflow) => Object.values(w.jobs).filter((j) => j.steps?.some((s) => s.uses?.startsWith('testivai/testivai-oss/publish@')));

describe('GitHub Pages setup docs', () => {
  it('shows a publish workflow', () => {
    expect(workflows(DOC)).toHaveLength(1);
  });

  it('runs after the visual workflow, when a pull request closes, and by hand; never on pull request code', () => {
    const [w] = workflows(DOC);
    expect(Object.keys(w.on).sort()).toEqual(['pull_request_target', 'workflow_dispatch', 'workflow_run']);
    expect(w.on.workflow_run?.types).toEqual(['completed']);
    expect(w.on.workflow_run?.workflows?.length).toBeGreaterThan(0);
    expect(w.on.pull_request_target?.types).toEqual(['closed']);
  });

  it('runs one publish at a time, a newer one replacing a running one', () => {
    const [w] = workflows(DOC);
    expect(w.concurrency?.group).toBeTruthy();
    expect(w.concurrency?.['cancel-in-progress']).toBe(true);
  });

  it('gives the job exactly what it needs, and deploys through the github-pages environment', () => {
    for (const job of publishJobs(workflows(DOC)[0])) {
      expect(job.permissions).toEqual({ contents: 'read', actions: 'read', pages: 'write', 'id-token': 'write', 'pull-requests': 'write' });
      expect(typeof job.environment === 'object' && job.environment.name).toBe('github-pages');
      expect(typeof job.environment === 'object' && job.environment.url).toBe('${{ steps.publish.outputs.page-url }}');
    }
  });

  it('never checks out or runs code: the publish step is the only step', () => {
    for (const job of publishJobs(workflows(DOC)[0])) {
      expect(job.steps).toHaveLength(1);
      expect(job.steps?.[0].run).toBeUndefined();
      expect(job.steps?.[0].id).toBe('publish');
    }
  });

  it('passes only inputs the action has, and the consent from the variable', () => {
    for (const job of publishJobs(workflows(DOC)[0])) {
      const step = job.steps![0];
      for (const key of Object.keys(step.with ?? {})) expect(INPUTS).toContain(key);
      expect(step.with?.['public-reports']).toBe(`\${{ vars.${CONSENT_VARIABLE} }}`);
    }
  });

  it('states the limits the code has', () => {
    expect(DOC).toContain(`last ${ACTION.inputs['runs-per-pr'].default} runs`);
    expect(DOC).toContain(`${PUBLISH_LIMITS.maxPrBytes / MB} MB`);
    expect(DOC).toContain(`${PUBLISH_LIMITS.maxSiteBytes / MB} MB`);
    expect(DOC).toContain(`${PUBLISH_LIMITS.maxArtifactPages * 100} newest`);
    expect(DOC).toContain(`${DEFAULT_ARCHIVE_LIMITS.maxImageBytes / MB} MB`);
  });

  it('warns that it replaces the whole Pages site, and says what the consent variable is and is not', () => {
    expect(DOC).toMatch(/replaces\s+the\s+repository's\s+whole\s+GitHub\s+Pages\s+site/);
    expect(DOC).toContain(CONSENT_VARIABLE);
    expect(DOC).toMatch(/write\s+access\s+can\s+create/);
    expect(DOC).toMatch(/not\s+an\s+access\s+control/);
  });

  it('is linked from the README', () => {
    expect(read('README.md')).toContain('docs/github-action.md#reports-on-github-pages');
  });
});
