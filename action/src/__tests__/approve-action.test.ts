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
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

const ACTION = parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'approve', 'action.yml'), 'utf8'),
) as { runs: { steps: Step[] } };
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

describe('every github-script step compiles with the arguments github-script@v9 passes', () => {
  it.each(
    steps.filter((s) => s.uses?.startsWith('actions/github-script@')).map((s) => [s.name ?? '(unnamed)', s] as const),
  )('%s', (_name, s) => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    expect(() => new AsyncFunction(...GITHUB_SCRIPT_V9_ARGS, s.with!.script)).not.toThrow();
  });
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

describe('Post confirmation comment', () => {
  const confirm = step('Post confirmation comment');

  async function runConfirm(outputs: { approved: string; skipped: string; count: string; actor: string }) {
    const values = {
      'steps.apply.outputs.approved': outputs.approved,
      'steps.apply.outputs.skipped': outputs.skipped,
      'steps.apply.outputs.count': outputs.count,
      'fromJson(steps.auth.outputs.result).actor': outputs.actor,
      'inputs.github-token': 'token',
    };
    const script = expand(confirm.with!.script, values);
    const env = expandEnv(confirm.env, values);
    const bodies: string[] = [];
    const github = { rest: { issues: { createComment: async ({ body }: { body: string }) => void bodies.push(body) } } };
    const context = { repo: { owner: 'o', repo: 'r' }, issue: { number: 1 } };

    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction('github', 'context', 'core', script)(github, context, {});
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
});
