/**
 * Wiring tests for the composite publish action (publish/action.yml).
 *
 * The logic lives in src/publish/ (publish-*.test.ts); this file checks the
 * YAML around it: the inputs and their defaults, that the upload, deploy and
 * links run only when the build says so, that it never checks out or runs
 * code (a fork's pull request controls its own), that no input is spliced
 * into a script, and, by running each github-script body against the bundled
 * dist/publish.cjs with a fake GitHub, that the action loads the code that
 * ships.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { strToU8, zipSync } from 'fflate';
import { parse } from 'yaml';
import { FORK_MARKER } from '../publish/comments';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

const PUBLISH_DIR = path.resolve(__dirname, '..', '..', '..', 'publish');
const ACTION = parse(fs.readFileSync(path.join(PUBLISH_DIR, 'action.yml'), 'utf8')) as {
  name: string;
  inputs: Record<string, { required?: boolean; default?: string; description: string }>;
  outputs: Record<string, { value: string; description: string }>;
  runs: { using: string; steps: Step[] };
};
const steps = ACTION.runs.steps;
const byId = (id: string): Step => {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`publish/action.yml has no step with id "${id}"`);
  return found;
};

describe('inputs and outputs', () => {
  it('has a default for every input', () => {
    for (const [name, input] of Object.entries(ACTION.inputs)) {
      expect({ name, required: input.required ?? false }).toEqual({ name, required: false });
      expect(input.default).toBeDefined();
      expect(input.description.length).toBeGreaterThan(20);
    }
  });

  it('defaults to the reporter artifact, 3 runs per pull request, comments on, and no consent', () => {
    expect(ACTION.inputs['github-token'].default).toBe('${{ github.token }}');
    expect(ACTION.inputs['artifact-name'].default).toBe('testivai-visual-report');
    expect(ACTION.inputs['runs-per-pr'].default).toBe('3');
    expect(ACTION.inputs.comment.default).toBe('true');
    expect(ACTION.inputs['public-reports'].default).toBe('');
    expect(ACTION.inputs['status-context'].default).toBe('');
    expect(ACTION.inputs['include-dir'].default).toBe('');
    expect(ACTION.inputs['include-name'].default).toBe('');
  });

  it('has no ${{ }} expression in any description: the runner parses them and refuses the action', () => {
    // A description with `${{ vars.X }}` made GitHub's runner fail to load the
    // action ("Unrecognized named-value: 'vars'"), before any step ran.
    const descriptions = [
      ...Object.values(ACTION.inputs).map((i) => i.description),
      ...Object.values(ACTION.outputs).map((o) => o.description),
    ];
    for (const text of descriptions) expect(text).not.toContain('${{');
  });

  it('says where the consent comes from, and that it is not an access control', () => {
    const text = ACTION.inputs['public-reports'].description;
    expect(text).toContain('vars.TESTIVAI_PUBLIC_REPORTS');
    expect(text).toContain('github-pages');
    expect(text).toMatch(/write access/);
  });

  it('outputs whether it published and where', () => {
    expect(ACTION.outputs.published.value).toBe('${{ steps.build.outputs.published }}');
    expect(ACTION.outputs['page-url'].value).toContain('steps.deploy.outputs.page_url');
  });
});

describe('steps', () => {
  it('builds, uploads, deploys, then adds the links: the last three only when the build published', () => {
    expect(ACTION.runs.using).toBe('composite');
    expect(steps.map((s) => s.uses)).toEqual(['actions/github-script@v9', 'actions/upload-pages-artifact@v5', 'actions/deploy-pages@v5', 'actions/github-script@v9']);
    expect(steps[0].id).toBe('build');
    expect(steps[0].if).toBeUndefined();
    for (const s of steps.slice(1)) expect(s.if).toBe("steps.build.outputs.published == 'true'");
    expect(byId('deploy')).toBe(steps[2]);
    expect(steps[1].with?.path).toBe('${{ steps.build.outputs.site-dir }}');
  });

  it('never checks out or runs code: every step is a pinned action, none a shell command', () => {
    for (const s of steps) {
      expect(s.run).toBeUndefined();
      expect(s.uses).toMatch(/^actions\/(github-script|upload-pages-artifact|deploy-pages)@v\d+$/);
    }
  });

  it('passes inputs to the scripts through the environment, never spliced into the script', () => {
    for (const s of steps.filter((x) => x.uses?.startsWith('actions/github-script'))) {
      expect(s.with?.script).not.toContain('${{');
      expect(s.with?.['github-token']).toBe('${{ inputs.github-token }}');
    }
  });

  it('deploys with the job token (OIDC), never the token input', () => {
    expect(byId('deploy').with?.token).toBeUndefined();
  });
});

// ── the scripts, run against the bundled module ─────────────────────────────

function expand(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr: string) => {
    if (!(expr in values)) throw new Error(`test has no value for \${{ ${expr} }}`);
    return values[expr];
  });
}

async function runScript(step: Step, values: Record<string, string>, globals: { github: unknown; context: unknown; core: unknown }) {
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, expand(String(v), values)]));
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction('require', 'github', 'context', 'core', step.with?.script)(require, globals.github, globals.context, globals.core);
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const RESULTS = {
  version: '2.5.0',
  timestamp: '2026-10-18T10:00:00.000Z',
  summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
  snapshots: [{ name: 'home', status: 'changed', diffPercent: 1, diffCount: 1, totalPixels: 100, currentPath: 'images/home/current.png' }],
};

/** A repository with Pages on, and one fork pull request with one run. */
function fakeGithub(pages: 'on' | 'off') {
  const posted: Array<{ route: string; params: Record<string, any> }> = [];
  const routes: Record<string, (p: Record<string, any>) => unknown> = {
    'GET /repos/{owner}/{repo}': () => ({ id: 1, full_name: 'testivai/testivai-example', visibility: 'public', default_branch: 'main' }),
    'GET /repos/{owner}/{repo}/pages': () => {
      if (pages === 'off') throw Object.assign(new Error('Not Found'), { status: 404 });
      return { build_type: 'workflow', public: true, html_url: 'https://testivai.github.io/testivai-example/' };
    },
    'GET /repos/{owner}/{repo}/pulls': () => [
      { number: 15, title: 'Typo', user: { login: 'someone' }, head: { ref: 'patch-1', sha: 'd'.repeat(40), repo: { id: 9, full_name: 'someone/testivai-example' } } },
    ],
    'GET /repos/{owner}/{repo}/actions/artifacts': () => ({
      artifacts: [
        { id: 40, name: 'testivai-visual-report', size_in_bytes: 1000, expired: false, created_at: '2026-10-18T10:00:00Z', workflow_run: { id: 4, head_repository_id: 9, head_branch: 'patch-1' } },
      ],
    }),
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}': () => ({
      id: 4,
      run_attempt: 1,
      head_repository: { full_name: 'someone/testivai-example' },
      head_branch: 'patch-1',
      head_sha: 'd'.repeat(40),
      event: 'pull_request',
      status: 'completed',
      created_at: '2026-10-18T10:00:00Z',
    }),
    'GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}': () =>
      Buffer.from(zipSync({ 'results.json': strToU8(JSON.stringify(RESULTS)), 'images/home/current.png': PNG })),
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': () => [],
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': () => ({}),
  };
  const github = {
    request: async (route: string, params: Record<string, any> = {}) => {
      if (route.startsWith('POST') || route.startsWith('PATCH')) posted.push({ route, params });
      const handler = routes[route];
      if (!handler) throw Object.assign(new Error(`unexpected ${route}`), { status: 500 });
      return { data: handler(params) };
    },
  };
  return { github, posted };
}

function fakeCore() {
  const outputs: Record<string, string> = {};
  const notices: string[] = [];
  return {
    outputs,
    notices,
    core: {
      setOutput: (k: string, v: string) => {
        outputs[k] = v;
      },
      info: () => {},
      notice: (m: string) => notices.push(m),
      warning: () => {},
      setFailed: (m: string) => {
        throw new Error(`setFailed: ${m}`);
      },
    },
  };
}

describe('the scripts load dist/publish.cjs and run', () => {
  let temp: string;
  const savedTemp = process.env.RUNNER_TEMP;
  const savedFetch = globalThis.fetch;
  const fetched: string[] = [];
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-action-'));
    process.env.RUNNER_TEMP = temp;
    fetched.length = 0;
    // The finish step checks the deployed site answers; no network here.
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url));
      return { status: 200 };
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    fs.rmSync(temp, { recursive: true, force: true });
    if (savedTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedTemp;
  });

  const context = { repo: { owner: 'testivai', repo: 'testivai-example' }, serverUrl: 'https://github.com' };
  const values = (over: Record<string, string> = {}) => ({
    'github.action_path': PUBLISH_DIR,
    'inputs.artifact-name': 'testivai-visual-report',
    'inputs.runs-per-pr': '3',
    'inputs.public-reports': '',
    'inputs.comment': 'true',
    'inputs.status-context': '',
    'inputs.github-token': 'unused',
    'inputs.include-dir': '',
    'inputs.include-name': '',
    ...over,
  });

  it('build: publishes nothing, with a notice, where Pages is off', async () => {
    const { github } = fakeGithub('off');
    const { core, outputs, notices } = fakeCore();

    await runScript(byId('build'), values(), { github, context, core });

    expect(outputs.published).toBe('false');
    expect(notices[0]).toMatch(/not enabled/);
  });

  it("build then finish: writes the site, then posts the fork's link", async () => {
    const { github, posted } = fakeGithub('on');
    const { core, outputs } = fakeCore();

    await runScript(byId('build'), values(), { github, context, core });

    expect(outputs.published).toBe('true');
    expect(outputs['page-url']).toBe('https://testivai.github.io/testivai-example/');
    expect(fs.existsSync(path.join(outputs['site-dir'], 'pr/15/4-1/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(outputs['site-dir'], 'index.html'))).toBe(true);
    expect(path.relative(temp, outputs['state-file']).startsWith('..')).toBe(false);
    expect(path.relative(outputs['site-dir'], outputs['state-file']).startsWith('..')).toBe(true);

    const finish = steps[3];
    await runScript(
      finish,
      values({
        'steps.build.outputs.state-file': outputs['state-file'],
        'steps.deploy.outputs.page_url': 'https://testivai.github.io/testivai-example/',
      }),
      { github, context, core: { ...core, info: () => {} } },
    );

    expect(fetched).toEqual(['https://testivai.github.io/testivai-example/']);
    expect(posted).toHaveLength(1);
    expect(posted[0].params.issue_number).toBe(15);
    expect(posted[0].params.body).toContain('(https://testivai.github.io/testivai-example/pr/15/4-1/)');
    expect(posted[0].params.body).toContain(FORK_MARKER);
  });

  it('build: publishes a folder of your own pages, relative to the workspace, under its name', async () => {
    const workspace = path.join(temp, 'workspace');
    fs.mkdirSync(path.join(workspace, 'demo-report'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'demo-report', 'index.html'), '<h1>Demo</h1>');
    const saved = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = workspace;
    try {
      const { github } = fakeGithub('on');
      const { core, outputs } = fakeCore();

      await runScript(byId('build'), values({ 'inputs.include-dir': 'demo-report', 'inputs.include-name': 'demo' }), { github, context, core });

      expect(fs.readFileSync(path.join(outputs['site-dir'], 'demo', 'index.html'), 'utf8')).toBe('<h1>Demo</h1>');
    } finally {
      if (saved === undefined) delete process.env.GITHUB_WORKSPACE;
      else process.env.GITHUB_WORKSPACE = saved;
    }
  });

  it('build: needs include-name with include-dir', async () => {
    const { github } = fakeGithub('on');

    await expect(runScript(byId('build'), values({ 'inputs.include-dir': 'demo-report' }), { github, context, core: fakeCore().core })).rejects.toThrow(/include-name/);
  });

  it('build: refuses a runs-per-pr that is not a whole number from 1 to 10', async () => {
    for (const bad of ['0', '11', '2.5', 'three', '']) {
      const { github } = fakeGithub('on');
      await expect(runScript(byId('build'), values({ 'inputs.runs-per-pr': bad }), { github, context, core: fakeCore().core })).rejects.toThrow(/runs-per-pr/);
    }
  });

  it('finish: refuses a comment input other than true or false', async () => {
    const { github } = fakeGithub('on');
    const { core, outputs } = fakeCore();
    await runScript(byId('build'), values(), { github, context, core });

    await expect(
      runScript(steps[3], values({ 'inputs.comment': 'yes', 'steps.build.outputs.state-file': outputs['state-file'], 'steps.deploy.outputs.page_url': '' }), {
        github,
        context,
        core,
      }),
    ).rejects.toThrow(/comment/);
  });
});
