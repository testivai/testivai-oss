/**
 * Behaviour tests for the composite approve action (approve/action.yml).
 *
 * Snapshot names reach the action from two places nobody vets: the
 * `/testivai approve <names>` comment, and the directory names inside the
 * report artifact, which the PR's own CI run produced (a fork PR controls
 * them). Neither may run code or touch files outside the baselines.
 *
 * Each test takes a step's script from action.yml and runs it the way GitHub
 * does: `${{ }}` expressions are expanded first (from EXPRESSIONS below), then
 * a `run:` body goes to bash and a github-script body runs as an async
 * function with a stubbed `github` client.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

const APPROVE_DIR = path.resolve(__dirname, '..', '..', '..', 'approve');
const ACTION = parse(fs.readFileSync(path.join(APPROVE_DIR, 'action.yml'), 'utf8')) as { runs: { steps: Step[] } };
const steps = ACTION.runs.steps;
const step = (name: string): Step => {
  const found = steps.find((s) => s.name === name);
  if (!found) throw new Error(`approve/action.yml has no step "${name}"`);
  return found;
};

/** Expand `${{ expr }}` like GitHub does: a plain text substitution. */
function expand(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr: string) => {
    if (!(expr in values)) throw new Error(`test has no value for \${{ ${expr} }}`);
    return values[expr];
  });
}

const expandEnv = (env: Record<string, string> = {}, values: Record<string, string>) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expand(String(v), values)]));

// A directory name a fork PR could put in its artifact. It is a legal file
// name; if it is ever spliced into JavaScript source it sets a global.
const HOSTILE = "x'+(globalThis.__pwned=1)+'";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-action-'));
  delete (globalThis as Record<string, unknown>).__pwned;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('no step splices an expression into script source', () => {
  it.each(steps.filter((s) => s.run || s.with?.script).map((s) => [s.name ?? '(unnamed)', s] as const))(
    '%s',
    (_name, s) => {
      // Values go through env: and are read as $VAR / process.env.VAR.
      expect(s.run ?? '').not.toMatch(/\$\{\{/);
      expect(s.with?.script ?? '').not.toMatch(/\$\{\{/);
    },
  );
});

describe('Apply baseline approvals', () => {
  const apply = step('Apply baseline approvals');

  /** Lays out an artifact and a repo under tmp, runs the step, returns its outputs. */
  function runApply(target: string, pending: string[], setup?: (dirs: { pendingDir: string; repo: string }) => void) {
    const runnerTemp = path.join(tmp, 'runner-temp');
    const pendingDir = path.join(runnerTemp, 'testivai-artifact', 'pending-baselines');
    for (const name of pending) {
      fs.mkdirSync(path.join(pendingDir, name), { recursive: true });
      fs.writeFileSync(path.join(pendingDir, name, 'screenshot.png'), name);
    }
    // A directory beside pending-baselines that `../secret` would reach.
    fs.mkdirSync(path.join(runnerTemp, 'testivai-artifact', 'secret'), { recursive: true });
    fs.writeFileSync(path.join(runnerTemp, 'testivai-artifact', 'secret', 'token'), 'nope');

    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    setup?.({ pendingDir, repo });
    const outputFile = path.join(tmp, 'github-output');
    fs.writeFileSync(outputFile, '');

    const env = expandEnv(apply.env, {
      'fromJson(steps.auth.outputs.result).target': target,
      'inputs.baselines-dir': '.testivai/baselines',
      'runner.temp': runnerTemp,
    });
    let stderr = '';
    try {
      execFileSync('bash', ['-e', '-c', apply.run!], {
        cwd: repo,
        env: { PATH: process.env.PATH, ...env, GITHUB_OUTPUT: outputFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? err);
      throw new Error(`apply step failed: ${stderr}`);
    }
    const outputs = Object.fromEntries(
      fs
        .readFileSync(outputFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const baselines = path.join(repo, '.testivai', 'baselines');
    const approvedOnDisk = fs.existsSync(baselines) ? fs.readdirSync(baselines).sort() : [];
    return { outputs, repo, approvedOnDisk };
  }

  it('--all approves every pending snapshot, including oddly named ones', () => {
    const { outputs, approvedOnDisk } = runApply('--all', ['home', 'home-mobile', HOSTILE]);
    expect(approvedOnDisk).toEqual(['home', 'home-mobile', HOSTILE].sort());
    expect(outputs.count).toBe('3');
    expect(outputs.approved.split(' ').sort()).toEqual(['home', 'home-mobile', HOSTILE].sort());
  });

  it('a named snapshot is approved and an unknown one is skipped', () => {
    const { outputs, approvedOnDisk } = runApply('home nope', ['home', 'about']);
    expect(approvedOnDisk).toEqual(['home']);
    expect(outputs.approved).toBe('home');
    expect(outputs.skipped).toBe('nope');
    expect(outputs.count).toBe('1');
  });

  it('a name that climbs out of pending-baselines is skipped and copies nothing', () => {
    const { outputs, repo, approvedOnDisk } = runApply('../secret home', ['home']);
    expect(approvedOnDisk).toEqual(['home']);
    expect(outputs.skipped).toBe('../secret');
    // baselines/../secret would be .testivai/secret
    expect(fs.existsSync(path.join(repo, '.testivai', 'secret'))).toBe(false);
  });

  it('"." and ".." are not snapshot names', () => {
    const { outputs, repo, approvedOnDisk } = runApply('. ..', ['home']);
    expect(approvedOnDisk).toEqual([]);
    expect(outputs.count).toBe('0');
    // "." would have copied every pending snapshot into the baselines root
    expect(fs.existsSync(path.join(repo, '.testivai', 'baselines', 'screenshot.png'))).toBe(false);
  });

  it('a glob in the comment is not expanded against the checkout', () => {
    // Unquoted, `*` would expand to the checkout's `home` and approve it.
    const { outputs, approvedOnDisk } = runApply('*', ['home'], ({ repo }) =>
      fs.writeFileSync(path.join(repo, 'home'), ''),
    );
    expect(approvedOnDisk).toEqual([]);
    expect(outputs.skipped).toBe('*');
  });

  it('--all: a directory name with a newline cannot split into ".."', () => {
    // "a\n.." word-splits into "a" and "..", and pending-baselines/.. is the artifact root.
    const { outputs, repo, approvedOnDisk } = runApply('--all', ['home', 'a\n..']);
    expect(approvedOnDisk).toEqual(['home']);
    expect(outputs.approved).toBe('home');
    expect(fs.existsSync(path.join(repo, '.testivai', 'secret'))).toBe(false);
  });

  it('a symlink in pending-baselines is not followed', () => {
    const { outputs, approvedOnDisk } = runApply('link home', ['home'], ({ pendingDir }) =>
      fs.symlinkSync(path.join(pendingDir, '..', 'secret'), path.join(pendingDir, 'link')),
    );
    expect(approvedOnDisk).toEqual(['home']);
    expect(outputs.skipped).toBe('link');
  });
});

/**
 * A re-run uploads the report again under the same name, and artifact IDs are
 * not in upload order (testivai/testivai-site#20: the second attempt's
 * artifact had the lower ID). Downloading by name can then return an earlier
 * attempt's report and approve its captures, so the step picks the newest
 * artifact by creation time and downloads that one by ID.
 */
describe('Download visual-report artifact', () => {
  const download = step('Download visual-report artifact');

  /** A fake `gh`: run list from runs.txt, the run's artifacts from artifacts.json (through real jq), zips by ID. */
  const FAKE_GH = [
    '#!/usr/bin/env bash',
    'echo "gh $*" >> "$FAKE_GH_LOG"',
    'case "$1" in',
    '  run)',
    '    case "$2" in',
    '      list) cat "$FAKE_GH_DIR/runs.txt" ;;',
    '      *) echo "unexpected: gh $*" >&2; exit 1 ;;',
    '    esac ;;',
    '  api)',
    '    url="$2"; shift 2; expr=""',
    '    while [ $# -gt 0 ]; do case "$1" in --jq) expr="$2"; shift 2 ;; *) shift ;; esac; done',
    '    case "$url" in',
    '      */actions/runs/*/artifacts*) if [ -n "$expr" ]; then jq -r "$expr" "$FAKE_GH_DIR/artifacts.json"; else cat "$FAKE_GH_DIR/artifacts.json"; fi ;;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion in the fake gh script
    '      */actions/artifacts/*/zip) id="${url%/zip}"; id="${id##*/}"; cat "$FAKE_GH_DIR/$id.zip" ;;',
    '      *) echo "unexpected: gh api $url" >&2; exit 1 ;;',
    '    esac ;;',
    '  *) echo "unexpected: gh $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n');

  const NAME = 'testivai-visual-report';
  const ARTIFACTS = {
    total_count: 4,
    artifacts: [
      { id: 200, name: NAME, created_at: '2026-10-18T13:35:12Z', expired: false }, // attempt 1: higher ID, older
      { id: 100, name: NAME, created_at: '2026-10-18T13:40:20Z', expired: false }, // attempt 2: the newest
      { id: 300, name: NAME, created_at: '2026-10-18T13:50:00Z', expired: true },
      { id: 400, name: 'other-report', created_at: '2026-10-18T14:00:00Z', expired: false },
    ],
  };

  function runDownload(workflow: string) {
    const ghDir = path.join(tmp, 'gh');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    fs.writeFileSync(path.join(ghDir, 'runs.txt'), '111\n');
    fs.writeFileSync(path.join(ghDir, 'artifacts.json'), JSON.stringify(ARTIFACTS));
    for (const [id, content] of [['200', 'attempt 1'], ['100', 'attempt 2'], ['300', 'expired'], ['400', 'other']]) {
      const src = path.join(tmp, `zip-${id}`, 'pending-baselines', 'home');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'screenshot.png'), content);
      execFileSync('zip', ['-qr', path.join(ghDir, `${id}.zip`), '.'], { cwd: path.join(tmp, `zip-${id}`) });
    }
    const runnerTemp = path.join(tmp, 'runner-temp');
    fs.mkdirSync(runnerTemp, { recursive: true });
    const log = path.join(tmp, 'gh.log');
    const outputFile = path.join(tmp, 'github-output');
    fs.writeFileSync(outputFile, '');
    const env = expandEnv(download.env, {
      'inputs.github-token': 'token',
      'inputs.artifact-name': NAME,
      'inputs.workflow': workflow,
      'fromJson(steps.auth.outputs.result).branch': 'feature',
      'runner.temp': runnerTemp,
    });
    try {
      execFileSync('bash', ['-e', '-c', download.run!], {
        cwd: tmp,
        env: { PATH: `${bin}:${process.env.PATH}`, ...env, GITHUB_REPOSITORY: 'acme/shop', FAKE_GH_DIR: ghDir, FAKE_GH_LOG: log, GITHUB_OUTPUT: outputFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(`download step failed: ${String((err as { stderr?: Buffer }).stderr ?? err)}`);
    }
    const shot = path.join(runnerTemp, 'testivai-artifact', 'pending-baselines', 'home', 'screenshot.png');
    return { content: fs.readFileSync(shot, 'utf8'), calls: fs.readFileSync(log, 'utf8'), outputs: fs.readFileSync(outputFile, 'utf8') };
  }

  it.each([
    ['a named workflow', 'visual.yml'],
    ['an auto-detected run', ''],
  ])("%s: downloads the newest unexpired artifact of that name by ID, even when an older one has a higher ID", (_label, workflow) => {
    const { content, calls } = runDownload(workflow);
    expect(content).toBe('attempt 2');
    expect(calls).toContain('gh api repos/acme/shop/actions/artifacts/100/zip');
    expect(calls).not.toMatch(/artifacts\/(200|300|400)\/zip/);
    expect(calls).not.toContain('gh run download');
  });

  it.each([
    ['a named workflow', 'visual.yml'],
    ['an auto-detected run', ''],
  ])('%s: outputs the run it downloaded from, for the reply', (_label, workflow) => {
    expect(runDownload(workflow).outputs).toBe('run-id=111\n');
    expect(download.id).toBe('download');
  });
});

describe('Post confirmation comment', () => {
  const confirm = step('Post confirmation comment');

  async function runConfirm(
    outputs: { approved: string; skipped: string; count: string; actor: string; runId?: string },
    { comments = [], stamp }: { comments?: Array<{ user: { login: string }; body: string }>; stamp?: object } = {},
  ) {
    const runnerTemp = path.join(tmp, 'runner-temp');
    fs.mkdirSync(path.join(runnerTemp, 'testivai-artifact'), { recursive: true });
    if (stamp) fs.writeFileSync(path.join(runnerTemp, 'testivai-artifact', 'testivai-run.json'), JSON.stringify(stamp));
    const values = {
      'steps.apply.outputs.approved': outputs.approved,
      'steps.apply.outputs.skipped': outputs.skipped,
      'steps.apply.outputs.count': outputs.count,
      'steps.download.outputs.run-id': outputs.runId ?? '',
      'fromJson(steps.auth.outputs.result).actor': outputs.actor,
      'inputs.github-token': 'token',
      'github.action_path': APPROVE_DIR,
      'runner.temp': runnerTemp,
    };
    const script = expand(confirm.with!.script, values);
    const env = expandEnv(confirm.env, values);
    const bodies: string[] = [];
    const github = {
      rest: {
        issues: {
          listComments: async ({ page }: { page: number }) => ({ data: page === 1 ? comments : [] }),
          createComment: async ({ body }: { body: string }) => void bodies.push(body),
        },
      },
    };
    const context = { repo: { owner: 'o', repo: 'r' }, issue: { number: 1 }, serverUrl: 'https://github.com' };
    const core = { info: () => {}, warning: () => {} };

    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction('require', 'github', 'context', 'core', script)(require, github, context, core);
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    return bodies;
  }

  it('a hostile snapshot name is printed, never run', async () => {
    const bodies = await runConfirm({ approved: `home ${HOSTILE}`, skipped: '', count: '2', actor: 'octocat' });
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('**2 baselines approved** by @octocat');
    expect(bodies[0]).toContain(`- \`${HOSTILE}\``);
  });

  it('a hostile skipped name from the comment is printed, never run', async () => {
    const bodies = await runConfirm({ approved: 'home', skipped: HOSTILE, count: '1', actor: 'octocat' });
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    expect(bodies[0]).toContain(`Not found in pending baselines: \`${HOSTILE}\``);
  });

  it('nothing approved still explains why', async () => {
    const bodies = await runConfirm({ approved: '', skipped: 'nope', count: '0', actor: 'octocat' });
    expect(bodies[0]).toContain('No baselines were updated.');
  });

  it("loads dist/approve.cjs and links the approved run's published report", async () => {
    const report = 'https://o.github.io/r/pr/1/111-2/';
    const comment = { user: { login: 'github-actions[bot]' }, body: `<!-- testivai-visual-report -->\n<!-- testivai-run:111-2 -->\n> **[Open the visual report](${report})**` };

    const bodies = await runConfirm({ approved: 'home', skipped: '', count: '1', actor: 'octocat', runId: '111' }, { comments: [comment], stamp: { runId: '111', runAttempt: 2 } });

    expect(confirm.with?.script).toContain('require(process.env.TESTIVAI_APPROVE_LIB)');
    expect(bodies[0]).toContain('from [CI run 111, attempt 2](https://github.com/o/r/actions/runs/111/attempts/2)');
    expect(bodies[0]).toContain(`**[Open the visual report](${report})**`);
    expect(bodies[0]).toMatch(/- `home` · \[open in report\]\(https:\/\/o\.github\.io\/r\/pr\/1\/111-2\/#snap-home\)/);
  });
});
