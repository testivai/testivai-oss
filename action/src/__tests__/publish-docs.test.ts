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
import { buildComment, UPSERT_MARKER } from '../comment';
import type { ResultsData } from '../types';

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

/** The doc's workflows that use the publish action: the basic one, one with pages of your own, one with a website at the root (site-dir). */
const workflows = (markdown: string): Workflow[] =>
  [...markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((b) => b.includes('testivai/testivai-oss/publish@'))
    .map((b) => parse(b) as Workflow);
const ALL = workflows(DOC);
const last = <T>(items: T[]): T => items[items.length - 1];

const publishJobs = (w: Workflow) => Object.values(w.jobs).filter((j) => j.steps?.some((s) => s.uses?.startsWith('testivai/testivai-oss/publish@')));

describe('GitHub Pages setup docs', () => {
  it('shows the basic workflow, one with pages of your own and one with a website at the root', () => {
    expect(ALL).toHaveLength(3);
    expect(last(publishJobs(ALL[2])[0].steps!).with).toMatchObject({ 'site-dir': expect.any(String), 'reports-path': expect.any(String) });
    expect(last(publishJobs(ALL[1])[0].steps!).with).toMatchObject({ 'include-dir': expect.any(String), 'include-name': expect.any(String) });
  });

  it.each([0, 1, 2])('workflow %i runs after the visual workflow, when a pull request closes, and by hand', (i) => {
    const w = ALL[i];
    expect(Object.keys(w.on).filter((e) => e !== 'push').sort()).toEqual(['pull_request_target', 'workflow_dispatch', 'workflow_run']);
    expect(w.on.workflow_run?.types).toEqual(['completed']);
    expect(w.on.workflow_run?.workflows?.length).toBeGreaterThan(0);
    expect(w.on.pull_request_target?.types).toEqual(['closed']);
  });

  it.each([0, 1, 2])('workflow %i runs one publish at a time, a newer one replacing a running one', (i) => {
    expect(ALL[i].concurrency?.group).toBeTruthy();
    expect(ALL[i].concurrency?.['cancel-in-progress']).toBe(true);
  });

  it.each([0, 1, 2])('workflow %i gives the job exactly what it needs, and deploys through the github-pages environment', (i) => {
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

  it.each([0, 1, 2])('workflow %i passes only inputs the action has, and the consent from the variable', (i) => {
    for (const job of publishJobs(ALL[i])) {
      const step = last(job.steps!);
      for (const key of Object.keys(step.with ?? {})) expect(INPUTS).toContain(key);
      expect(step.with?.['public-reports']).toBe(`\${{ vars.${CONSENT_VARIABLE} }}`);
    }
  });

  describe('the workflow with a website at the root (site-dir)', () => {
    const w = () => ALL[2];
    const block = () => [...DOC.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('testivai/testivai-oss/publish@'))[2];
    const buildJobs = () => Object.values(w().jobs).filter((j) => !publishJobs(w()).includes(j));

    it('also deploys when the default branch changes, since the site is on it', () => {
      expect(Object.keys(w().on).sort()).toEqual(['pull_request_target', 'push', 'workflow_dispatch', 'workflow_run']);
      expect((w().on.push as { branches?: string[] }).branches).toEqual(['main']);
    });

    it('builds the site in a job of its own that can only read, from the default branch, never the pull request', () => {
      expect(block()).not.toMatch(/github\.event\.(pull_request|workflow_run)\.head|head_sha|head_ref|github\.head_ref/);
      const jobs = buildJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].permissions).toEqual({ contents: 'read' });
      const checkouts = jobs[0].steps!.filter((s) => s.uses?.startsWith('actions/checkout@'));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0].with?.ref).toBe('${{ github.event.repository.default_branch }}');
      expect(checkouts[0].with?.repository).toBeUndefined();
      expect(jobs[0].steps!.some((s) => s.uses?.startsWith('actions/upload-artifact@'))).toBe(true);
    });

    it('deploys from a job that checks out and runs nothing: it downloads the built site and publishes it', () => {
      const [job] = publishJobs(w());
      expect((job as Job & { needs?: string | string[] }).needs).toBeDefined();
      expect(job.steps!.map((s) => s.uses?.replace(/@.*/, ''))).toEqual(['actions/download-artifact', 'testivai/testivai-oss/publish']);
      for (const step of job.steps!) expect(step.run).toBeUndefined();
      const download = job.steps![0];
      expect(last(job.steps!).with?.['site-dir']).toBe(download.with?.path);
    });

    it('says what happens to the website: never a file overwritten, the site deployed without reports when they are refused, nothing from a branch source', () => {
      const start = DOC.indexOf('### A website at the root, reports under a path');
      expect(start).toBeGreaterThan(DOC.indexOf('### Pages of your own on the same site'));
      const section = DOC.slice(start, DOC.indexOf('\n### ', start + 1)).replace(/\s+/g, ' ');
      expect(section).toMatch(/already has/);
      expect(section).toMatch(/deploys the site without the reports/);
      expect(section).toMatch(/builds from a branch/);
      expect(section).toMatch(/noindex/);
      expect(section).toMatch(/404/);
      expect(section).toMatch(/symbolic links/i);
      expect(section).toMatch(/hidden files/);
      expect(section).toMatch(/reports-published/);
      expect(section).toMatch(/never from a pull request/);
      expect(section).toContain(CONSENT_VARIABLE);
    });
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

  it('says a run that GITHUB_TOKEN started, such as the re-run after an approve, gets no publish, and what avoids it', () => {
    // GitHub starts no workflow_run for a run that GITHUB_TOKEN started, so the
    // publish does not follow the visual re-run on an approve commit pushed with it.
    const limits = DOC.slice(DOC.indexOf('### Limits'), DOC.indexOf('\n## ', DOC.indexOf('### Limits')));
    expect(limits).toMatch(/GITHUB_TOKEN/);
    expect(limits).toMatch(/\/testivai approve/);
    expect(limits).toMatch(/no\s+publish|not\s+published|publishes\s+nothing/i);
    expect(limits).toContain('#approve-with-a-token-that-re-runs-ci');
  });

  it('documents the report cache, unreleased: what it saves, what it checks, its trust boundary and how to turn it on', () => {
    const start = DOC.indexOf('#### Unreleased: reports reused between publishes');
    expect(start).toBeGreaterThan(DOC.indexOf('### Limits'));
    const section = DOC.slice(start, DOC.indexOf('\n## ', start));
    expect(section).toMatch(/downloads only the runs it has not built before; the rest come\s+from the Actions cache/);
    expect(section).toMatch(/SHA-256/);
    expect(section).toMatch(/byte\s+for\s+byte/);
    expect(section).toContain('`cache: true`');
    expect(section).toMatch(/off by default/);
    expect(section).toMatch(/unpacks/);
    expect(section).toMatch(/`pages: write`/);
    expect(section).toMatch(/\| `cache` \| `false` \|/);
    expect(ACTION.inputs.cache.default).toBe('false');
  });

  it('documents what the report cache costs: a new full copy per changed publish, until GitHub evicts it', () => {
    const start = DOC.indexOf('#### Unreleased: reports reused between publishes');
    const section = DOC.slice(start, DOC.indexOf('\n## ', start)).replace(/\s+/g, ' ');
    expect(section).toMatch(/new full copy/);
    expect(section).toMatch(/900 MB/);
    expect(section).toMatch(/7 days/);
    expect(section).toMatch(/evict/);
    expect(section).toMatch(/other caches/);
  });

  it("shows a thumbnail row exactly as the comment has it, approve command fence included", () => {
    const fence = /(`{3,})html\n([\s\S]*?thumb\.png[\s\S]*?)\n\1\n/.exec(DOC);
    expect(fence).not.toBeNull();
    const example = (fence as RegExpExecArray)[2];
    const reportUrl = 'https://example.github.io/my-app/pr/14/39150236166-1/';
    const results = {
      summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
      snapshots: [
        {
          name: 'checkout-page',
          status: 'changed',
          diffPercent: 0.5,
          dom: { changed: true, noiseHint: false, summary: { added: 2, removed: 0, attributeChanges: 1, textChanges: 0 } },
        },
      ],
    } as unknown as ResultsData;

    const comment = buildComment(results, undefined, UPSERT_MARKER, {
      reportUrl,
      thumbnails: [{ name: 'checkout-page', url: `${reportUrl}images/0/thumb.png` }],
    });

    expect(comment).toContain(example);
  });

  it('says when the link appears: after the whole visual workflow, so a triage job in it holds the link, and which jobs can move out', () => {
    // workflow_run fires when every job of the visual workflow has finished,
    // not when the reporter has commented; measured on testivai-example.
    const pages = DOC.indexOf('## Reports on GitHub Pages');
    const setup = DOC.slice(DOC.indexOf('### Setup', pages), DOC.indexOf('### Inputs', pages));
    expect(setup).toMatch(/whole\s+visual\s+workflow/);
    expect(setup).toMatch(/about\s+a\s+minute\s+and\s+a\s+half\s+after\s+the\s+comment/);
    expect(setup).toContain('#ai-triage-of-every-diff');
    expect(setup).toMatch(/delays\s+it\s+until\s+the\s+review\s+finishes/);
    expect(setup).toMatch(/separate\s+workflow/);
    expect(setup).not.toMatch(/a\s+minute\s+or\s+two\s+after\s+the\s+reporter's\s+comment/);
  });

  it('is linked from the README', () => {
    expect(read('README.md')).toContain('docs/github-action.md#reports-on-github-pages');
  });
});
