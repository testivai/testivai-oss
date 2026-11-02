/**
 * .github/workflows/release-action.yml rolls the major tag (v1) to each clean
 * semver tag. The built-in GITHUB_TOKEN cannot move a ref onto a commit whose
 * workflow files changed since the ref's old commit: GitHub refuses it
 * ("refusing to allow a GitHub App to create or update workflow ... without
 * `workflows` permission"), and that token cannot be given the permission.
 * Seen rolling v1 from v1.6.0 to v1.6.1, after #232 changed ci.yml.
 *
 * So the checkout (whose credentials the push uses) takes a token from the
 * RELEASE_TAG_TOKEN secret, falling back to the built-in token, which still
 * works when no workflow file changed; and a refused push fails with what to
 * do, not only git's message.
 *
 * The roll step's script runs here for real, against a local remote that
 * accepts the push or refuses it as GitHub does.
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release-action.yml');
const REFUSAL =
  "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
const steps = (): Step[] => (parse(fs.readFileSync(WORKFLOW, 'utf8')) as { jobs: Record<string, { steps: Step[] }> }).jobs['roll-major-tag'].steps;
const checkout = () => steps().find((s) => s.uses?.startsWith('actions/checkout@')) as Step;
const roll = () => steps().find((s) => s.run?.includes('git push')) as Step;

describe('release-action.yml credentials', () => {
  it('checks out with RELEASE_TAG_TOKEN, falling back to the built-in token, and keeps the credentials for the push', () => {
    expect(checkout().with).toMatchObject({
      token: '${{ secrets.RELEASE_TAG_TOKEN || github.token }}',
      'persist-credentials': true,
      'fetch-depth': 0,
    });
  });

  it('the roll step knows whether the secret is set, never its value', () => {
    const env = roll().env ?? {};
    expect(env.HAS_RELEASE_TAG_TOKEN).toBe("${{ secrets.RELEASE_TAG_TOKEN != '' }}");
    expect(JSON.stringify(roll())).not.toMatch(/secrets\.RELEASE_TAG_TOKEN\s*}}/);
  });
});

describe('the roll step, run against a local remote', () => {
  let dir: string;
  let remote: string;
  let work: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-action-'));
    remote = path.join(dir, 'remote.git');
    work = path.join(dir, 'work');
    git(dir, 'init', '-q', '--bare', remote);
    git(dir, 'init', '-q', work);
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git(work, 'config', k, v);
    git(work, 'remote', 'add', 'origin', remote);
    git(work, 'commit', '-q', '--allow-empty', '-m', 'v1.6.0');
    git(work, 'tag', '-a', 'v1.6.0', '-m', 'v1.6.0');
    git(work, 'tag', '-a', 'v1', '-m', 'v1', 'v1.6.0');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'v1.6.1');
    git(work, 'tag', '-a', 'v1.6.1', '-m', 'v1.6.1');
    git(work, 'push', '-q', 'origin', '--tags');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Make the remote refuse every ref update the way GitHub refuses one without `workflows` permission. */
  function refuseLikeGitHub() {
    // The message is a file the hook prints as is: nothing is put into the shell script.
    const hooks = path.join(remote, 'hooks');
    fs.writeFileSync(path.join(hooks, 'refusal.txt'), `${REFUSAL}\n`);
    const hook = path.join(hooks, 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\ncat "$(dirname "$0")/refusal.txt" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
  }

  function runRoll(hasToken: boolean) {
    const out = path.join(dir, 'step-summary.md');
    fs.writeFileSync(out, '');
    const result = spawnSync('bash', ['-e', '-c', roll().run as string], {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        SRC_TAG: 'v1.6.1',
        MAJOR_TAG: 'v1',
        HAS_RELEASE_TAG_TOKEN: hasToken ? 'true' : 'false',
        GITHUB_STEP_SUMMARY: out,
      },
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  }
  const remoteV1 = () => git(remote, 'rev-parse', 'v1^{commit}');
  const v161 = () => git(work, 'rev-parse', 'v1.6.1^{commit}');

  it('moves v1 to the release when the push is accepted', () => {
    const { code, output } = runRoll(true);

    expect(code).toBe(0);
    expect(remoteV1()).toBe(v161());
    expect(output).toContain(`Pointed v1 at v1.6.1 (${v161()})`);
  });

  it('with the built-in token, a refused push fails saying to add RELEASE_TAG_TOKEN, and how to move v1 by hand', () => {
    refuseLikeGitHub();
    const before = remoteV1();

    const { code, output } = runRoll(false);

    expect(code).toBe(1);
    expect(remoteV1()).toBe(before);
    expect(output).toContain(REFUSAL);
    expect(output).toContain('::error::');
    expect(output).toContain('RELEASE_TAG_TOKEN');
    expect(output).toMatch(/Workflows/);
    expect(output).toContain(`git tag -f -a v1 -m "Rolling major tag → v1.6.1 (${v161()})" ${v161()}`);
    expect(output).toContain('git push -f origin refs/tags/v1');
    expect(output).toContain(`node scripts/release-action.js v1.6.1 --ref ${v161()}`);
  });

  it('with RELEASE_TAG_TOKEN set, a refused push says the token lacks the permission', () => {
    refuseLikeGitHub();

    const { code, output } = runRoll(true);

    expect(code).toBe(1);
    expect(output).toContain('::error::');
    expect(output).toMatch(/RELEASE_TAG_TOKEN[^\n]*(Workflows|workflows)/);
    expect(output).toContain('git push -f origin refs/tags/v1');
  });
});
