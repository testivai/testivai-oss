/**
 * Wiring tests for the composite AI triage action (review/action.yml).
 *
 * The logic lives in src/review.ts (review.test.ts); this file checks the
 * YAML around it: the inputs and their defaults, that Claude only runs when
 * the prepare step says so and can never fail the job, that no secret reaches
 * a script, and, by running each github-script body against the bundled
 * dist/review.cjs, that the action loads the code that ships.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  'continue-on-error'?: boolean;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

const REVIEW_DIR = path.resolve(__dirname, '..', '..', '..', 'review');
const ACTION = parse(fs.readFileSync(path.join(REVIEW_DIR, 'action.yml'), 'utf8')) as {
  inputs: Record<string, { required?: boolean; default?: string; description: string }>;
  runs: { using: string; steps: Step[] };
};
const steps = ACTION.runs.steps;
const byId = (id: string): Step => {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`review/action.yml has no step with id "${id}"`);
  return found;
};
const prep = byId('prep');
const claude = byId('claude');
const post = byId('post');

describe('inputs', () => {
  it('is on by default, and every input has a default', () => {
    expect(ACTION.inputs.enabled.default).toBe('true');
    for (const [name, input] of Object.entries(ACTION.inputs)) {
      expect({ name, required: input.required ?? false }).toEqual({ name, required: false });
      expect(input.default).toBeDefined();
      expect(input.description.length).toBeGreaterThan(20);
    }
  });

  it('takes either Claude credential, and defaults the rest', () => {
    expect(ACTION.inputs['anthropic-api-key'].default).toBe('');
    expect(ACTION.inputs['claude-code-oauth-token'].default).toBe('');
    expect(ACTION.inputs['github-token'].default).toBe('${{ github.token }}');
    expect(ACTION.inputs['report-dir'].default).toBe('visual-report');
    expect(ACTION.inputs.model.default).toBe('');
    expect(ACTION.inputs['max-turns'].default).toBe('30');
  });

  it('says in the enabled description that turning it off uses no tokens', () => {
    expect(ACTION.inputs.enabled.description).toMatch(/false.*no tokens/is);
  });
});

describe('steps', () => {
  it('is a composite action: prepare, Claude, post', () => {
    expect(ACTION.runs.using).toBe('composite');
    expect(steps.map((s) => s.id)).toEqual(['prep', 'claude', 'post']);
  });

  it('runs Claude only when the prepare step says so, and a Claude failure never fails the job', () => {
    expect(claude.uses).toBe('anthropics/claude-code-action@v1');
    expect(claude.if).toBe("steps.prep.outputs.run == 'true'");
    expect(claude['continue-on-error']).toBe(true);
    expect(claude.with).toEqual({
      anthropic_api_key: '${{ inputs.anthropic-api-key }}',
      claude_code_oauth_token: '${{ inputs.claude-code-oauth-token }}',
      github_token: '${{ inputs.github-token }}',
      prompt: '${{ steps.prep.outputs.prompt }}',
      claude_args: '${{ steps.prep.outputs.claude_args }}',
    });
  });

  it('posts after Claude whenever Claude was meant to run, so a failure replaces a stale triage', () => {
    expect(post.if).toBe("steps.prep.outputs.run == 'true'");
    expect(post.env?.OUTCOME).toBe('${{ steps.claude.outcome }}');
    expect(post.env?.TRIAGE).toBe('${{ steps.claude.outputs.structured_output }}');
  });

  it('gives the scripts whether a credential is set, never the credential itself', () => {
    expect(prep.env?.HAS_CREDENTIALS).toBe("${{ inputs.anthropic-api-key != '' || inputs.claude-code-oauth-token != '' }}");
    for (const s of [prep, post]) {
      const exposed = JSON.stringify({ env: s.env, with: s.with });
      expect(exposed.replace(prep.env?.HAS_CREDENTIALS ?? '', '')).not.toMatch(/anthropic-api-key|oauth-token/);
    }
  });

  it('pastes no expression into a script: every value arrives through env', () => {
    for (const s of [prep, post]) {
      expect(s.uses).toMatch(/^actions\/github-script@v\d+$/);
      expect(s.with?.script).not.toMatch(/\$\{\{/);
      expect(s.with?.['github-token']).toBe('${{ inputs.github-token }}');
    }
  });
});

// ── the scripts, run against the bundled module ─────────────────────────────

/** Expand `${{ expr }}` like GitHub does: a plain text substitution. */
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
    // github-script passes its own require; Node's resolves an absolute path the same way.
    await new AsyncFunction('require', 'github', 'context', 'core', step.with?.script)(require, globals.github, globals.context, globals.core);
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe('the scripts load dist/review.cjs and run', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-action-'));
    fs.mkdirSync(path.join(dir, 'visual-report'));
    fs.writeFileSync(
      path.join(dir, 'visual-report', 'results.json'),
      JSON.stringify({ timestamp: 0, summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 }, snapshots: [{ name: 'home', status: 'changed' }] }),
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const values = (over: Record<string, string> = {}) => ({
    'github.action_path': REVIEW_DIR,
    'inputs.enabled': 'true',
    "inputs.anthropic-api-key != '' || inputs.claude-code-oauth-token != ''": 'true',
    'inputs.report-dir': path.join(dir, 'visual-report'),
    'inputs.model': '',
    'inputs.max-turns': '30',
    'steps.claude.outcome': 'success',
    'steps.claude.outputs.structured_output': JSON.stringify({
      summary: 'One bug.',
      snapshots: [{ name: 'home', verdict: 'bug', confidence: 'high', evidence: 'footer gone', nextStep: 'restore it' }],
    }),
    ...over,
  });
  const context = {
    eventName: 'pull_request',
    repo: { owner: 'acme', repo: 'shop' },
    issue: { number: 42 },
    serverUrl: 'https://github.com',
    runId: 7,
    payload: { pull_request: { number: 42, title: 'Footer tweak', body: '' } },
  };
  const fakes = () => {
    const outputs: Record<string, string> = {};
    const posted: string[] = [];
    const github = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async (a: { body: string }) => posted.push(a.body),
          updateComment: async (a: { body: string }) => posted.push(a.body),
        },
        pulls: { get: async () => ({ data: 'diff --git a/site/index.html b/site/index.html\n' }) },
      },
      paginate: async (fn: () => Promise<{ data: unknown[] }>) => (await fn()).data,
    };
    const core = {
      setOutput: (k: string, v: string) => {
        outputs[k] = v;
      },
      info: () => {},
      notice: () => {},
      warning: () => {},
    };
    return { outputs, posted, github, core };
  };

  it('the action path leads to the bundled module, which exports both steps', () => {
    const lib = expand(prep.env?.TESTIVAI_REVIEW_LIB ?? '', values());
    expect(fs.existsSync(lib)).toBe(true);
    expect(post.env?.TESTIVAI_REVIEW_LIB).toBe(prep.env?.TESTIVAI_REVIEW_LIB);
    const mod = require(lib);
    expect(typeof mod.prepare).toBe('function');
    expect(typeof mod.post).toBe('function');
  });

  it('prepare: a diff on a pull request hands Claude a prompt carrying the shared rubric', async () => {
    const f = fakes();
    await runScript(prep, values(), { github: f.github, context, core: f.core });
    expect(f.outputs.run).toBe('true');
    expect(f.outputs.prompt).toMatch(/pull request #42 in acme\/shop/);
    expect(f.outputs.prompt).toMatch(/\*\*possible bug\*\*/);
    expect(f.outputs.claude_args).toMatch(/--max-turns 30/);
    expect(fs.readFileSync(path.join(dir, 'visual-report', 'triage', 'pr.diff'), 'utf8')).toContain('site/index.html');
  });

  it('prepare: enabled false keeps Claude from running', async () => {
    const f = fakes();
    await runScript(prep, values({ 'inputs.enabled': 'false' }), { github: f.github, context, core: f.core });
    expect(f.outputs.run).toBe('false');
  });

  it('post: the triage becomes the comment', async () => {
    const f = fakes();
    await runScript(post, values(), { github: f.github, context, core: f.core });
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toMatch(/\| `home` \| 🔴 bug \| high \| footer gone \| restore it \|/);
  });
});
