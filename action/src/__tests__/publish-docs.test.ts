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

/** The doc's workflows that use the publish action: the basic one, then one with pages of your own. */
const workflows = (markdown: string): Workflow[] =>
  [...markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((b) => b.includes('testivai/testivai-oss/publish@'))
    .map((b) => parse(b) as Workflow);
const ALL = workflows(DOC);
const last = <T>(items: T[]): T => items[items.length - 1];

const publishJobs = (w: Workflow) => Object.values(w.jobs).filter((j) => j.steps?.some((s) => s.uses?.startsWith('testivai/testivai-oss/publish@')));

describe('GitHub Pages setup docs', () => {
  it('shows the basic workflow and one with pages of your own', () => {
    expect(ALL).toHaveLength(2);
    expect(last(publishJobs(ALL[1])[0].steps!).with).toMatchObject({ 'include-dir': expect.any(String), 'include-name': expect.any(String) });
  });

  it.each([0, 1])('workflow %i runs after the visual workflow, when a pull request closes, and by hand', (i) => {
    const w = ALL[i];
    expect(Object.keys(w.on).sort()).toEqual(['pull_request_target', 'workflow_dispatch', 'workflow_run']);
    expect(w.on.workflow_run?.types).toEqual(['completed']);
    expect(w.on.workflow_run?.workflows?.length).toBeGreaterThan(0);
    expect(w.on.pull_request_target?.types).toEqual(['closed']);
  });

  it.each([0, 1])('workflow %i runs one publish at a time, a newer one replacing a running one', (i) => {
    expect(ALL[i].concurrency?.group).toBeTruthy();
    expect(ALL[i].concurrency?.['cancel-in-progress']).toBe(true);
  });

  it.each([0, 1])('workflow %i gives the job exactly what it needs, and deploys through the github-pages environment', (i) => {
    for (const job of publishJobs(ALL[i])) {
      expect(job.permissions).toEqual({ contents: 'read', actions: 'read', pages: 'write', 'id-token': 'write', 'pull-requests': 'write' });
      expect(typeof job.environment === 'object' && job.environment.name).toBe('github-pages');
      expect(typeof job.environment === 'object' && job.environment.url).toBe('${{ steps.publish.outputs.page-url }}');
    }
  });

  it('the basic workflow never checks out or runs code: the publish step is the only step', () => {
    for (const job of publishJobs(ALL[0])) {
      expect(job.steps).toHaveLength(1);
      expect(job.steps?.[0].run).toBeUndefined();
      expect(job.steps?.[0].id).toBe('publish');
    }
  });

  it('the workflow with pages of your own checks out only the default branch, never the pull request', () => {
    const blocks = [...DOC.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('testivai/testivai-oss/publish@'));
    expect(blocks[1]).not.toMatch(/github\.event\.(pull_request|workflow_run)\.head|head_sha|head_ref|github\.head_ref/);
    for (const job of publishJobs(ALL[1])) {
      const checkouts = job.steps!.filter((s) => s.uses?.startsWith('actions/checkout@'));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0].with?.ref).toBeUndefined();
      expect(checkouts[0].with?.repository).toBeUndefined();
      expect(last(job.steps!).id).toBe('publish');
    }
  });

  it.each([0, 1])('workflow %i passes only inputs the action has, and the consent from the variable', (i) => {
    for (const job of publishJobs(ALL[i])) {
      const step = last(job.steps!);
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
