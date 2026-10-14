/**
 * Contract between the AI triage action (review/action.yml) and the docs that
 * tell people how to set it up: every documented workflow passes only inputs
 * the action has, gives the job the permissions it needs (and no more), runs
 * it after a failed visual job, and says how to turn it off.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: { uses?: string; with?: Record<string, string> }[];
}

/** Jobs in the doc's YAML blocks that use the review action. */
function reviewJobs(markdown: string): Job[] {
  return [...markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((b) => b.includes('testivai/testivai-oss/review@'))
    .flatMap((b) => Object.values((parse(b) as { jobs: Record<string, Job> }).jobs))
    .filter((j) => j.steps?.some((s) => s.uses?.startsWith('testivai/testivai-oss/review@')));
}

const INPUTS = Object.keys((parse(read('review/action.yml')) as { inputs: Record<string, unknown> }).inputs);
const DOCS_WITH_WORKFLOWS = ['README.md', 'docs/github-action.md'];

describe('AI triage setup docs', () => {
  it.each(DOCS_WITH_WORKFLOWS)('%s shows a triage job', (file) => {
    expect(reviewJobs(read(file)).length).toBeGreaterThan(0);
  });

  it.each(DOCS_WITH_WORKFLOWS)('%s: the job runs after the visual job, even when it failed on a diff', (file) => {
    for (const job of reviewJobs(read(file))) {
      expect(job.needs).toBeDefined();
      expect(job.if).toMatch(/^\$\{\{ !cancelled\(\) && /);
      expect(job.if).toMatch(/github\.event_name == 'pull_request'/);
    }
  });

  it.each(DOCS_WITH_WORKFLOWS)('%s: read-only contents, write only to pull requests', (file) => {
    for (const job of reviewJobs(read(file))) {
      expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    }
  });

  it.each(DOCS_WITH_WORKFLOWS)('%s: passes only inputs the action has, and a credential from a secret', (file) => {
    for (const job of reviewJobs(read(file))) {
      const step = job.steps!.find((s) => s.uses?.startsWith('testivai/testivai-oss/review@'))!;
      for (const key of Object.keys(step.with ?? {})) expect(INPUTS).toContain(key);
      expect(step.with?.['anthropic-api-key'] ?? step.with?.['claude-code-oauth-token']).toMatch(/^\$\{\{ secrets\.[A-Z_]+ \}\}$/);
    }
  });

  it('docs/github-action.md says how to turn it off without spending tokens, and that it is advisory', () => {
    const doc = read('docs/github-action.md');
    expect(doc).toContain('enabled: false');
    expect(doc).toMatch(/no tokens/i);
    expect(doc).toMatch(/never (changes|touches) the visual check/i);
    for (const input of INPUTS) expect(doc).toContain(`\`${input}\``);
  });

  it.each(['CLAUDE.md', 'AGENTS.md'])('%s lists the review action in the repo layout', (file) => {
    expect(read(file)).toMatch(/^review\/\s+testivai\/testivai-oss\/review@v1/m);
  });
});
