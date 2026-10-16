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
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  steps?: { uses?: string; with?: Record<string, string>; 'continue-on-error'?: boolean }[];
}

/** The doc's YAML blocks that use the review action. */
const reviewBlocks = (markdown: string): string[] =>
  [...markdown.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('testivai/testivai-oss/review@'));

/** Jobs in the doc's YAML blocks that use the review action. */
function reviewJobs(markdown: string): Job[] {
  return reviewBlocks(markdown)
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

  it.each(DOCS_WITH_WORKFLOWS)('%s: a missing report artifact (the visual job failed early) skips, never fails the job', (file) => {
    for (const job of reviewJobs(read(file))) {
      const download = job.steps!.find((s) => s.uses?.startsWith('actions/download-artifact@'));
      expect(download?.['continue-on-error']).toBe(true);
    }
  });

  it.each(DOCS_WITH_WORKFLOWS)('%s: a newer push cancels the triage of an older one (and its tokens)', (file) => {
    for (const job of reviewJobs(read(file))) {
      expect(job.concurrency?.group).toMatch(/github\.event\.pull_request\.number/);
      expect(job.concurrency?.['cancel-in-progress']).toBe(true);
    }
  });

  it.each(DOCS_WITH_WORKFLOWS)('%s: shows both credential inputs, so a subscription token is wired in, not just named', (file) => {
    for (const block of reviewBlocks(read(file))) {
      expect(block).toMatch(/anthropic-api-key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
      expect(block).toMatch(/claude-code-oauth-token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
    }
  });

  it('docs/github-action.md says where the report must be: the reportDir in .testivai/config.json', () => {
    expect(read('docs/github-action.md')).toMatch(/reportDir[^.]*\.testivai\/config\.json[^.]*visual-report/);
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

/**
 * Missing baselines (committed, but no capture this run) are triaged too, and
 * a missing one alone starts a run. The docs used to say the opposite.
 */
describe('AI triage docs: missing baselines', () => {
  /** Line wraps do not matter to a reader. */
  const flat = (file: string) => read(file).replace(/\s+/g, ' ');
  const doc = flat('docs/github-action.md');

  it('docs/github-action.md no longer says missing baselines are left out', () => {
    expect(doc).not.toMatch(/missing baselines alone never start a run/i);
    expect(doc).not.toMatch(/are not triaged/i);
  });

  it('docs/github-action.md: a missing baseline is triaged, and alone starts a run', () => {
    expect(doc).toMatch(/on every pull request run that has a changed or new snapshot or a missing baseline/);
    expect(doc).toMatch(/3\. At least one snapshot is changed or new, or a baseline is missing \(`missingBaselines` in `results\.json`/);
  });

  it('docs/github-action.md: how a missing baseline is judged, marked and accepted', () => {
    expect(doc).toMatch(/\| `products` \(missing\) \|/);
    expect(doc).toMatch(/the report cannot say why/i);
    expect(doc).toMatch(/test run's log/);
    expect(doc).toMatch(/never a glitch/i);
    expect(doc).toMatch(/approving does nothing for a missing baseline/i);
    expect(doc).toMatch(/git rm -r \.testivai\/baselines\/<name>/);
    // An older @testivai/mcp (CI runs the latest published one) is covered by the prompt.
    expect(doc).toMatch(/older `@testivai\/mcp`/);
  });

  // A --grep run, a matrix lane or a path-filtered job leaves baselines missing
  // on purpose: each would start a paid run on every pull request.
  it('docs/github-action.md: partial runs leave baselines missing on purpose; failOnMissing: false keeps them out', () => {
    expect(doc).toMatch(/`--grep`[^.]*matrix[^.]*`--allow-missing`/);
    expect(doc).toMatch(/`failOnMissing: false` in `\.testivai\/config\.json` says missing baselines are expected and leaves missing baselines out of the triage/);
    expect(doc).toMatch(/its cost grows with the number of changed, new and missing snapshots/);
  });

  it('README.md: the ai-triage job runs for a missing baseline too', () => {
    expect(flat('README.md')).toMatch(/The `ai-triage` job runs on every pull request with a changed or new snapshot or a missing baseline/);
  });

  it('review/action.yml: the description and the enabled input say missing baselines too', () => {
    const action = parse(read('review/action.yml')) as { description: string; inputs: { enabled: { description: string } } };
    expect(action.description.replace(/\s+/g, ' ')).toMatch(/triages each changed or new snapshot and each missing baseline/);
    expect(action.inputs.enabled.description.replace(/\s+/g, ' ')).toMatch(/a changed or new snapshot or a missing baseline/);
  });
});
