/**
 * The publish action's job summary: what the publish did, on its run's page.
 *
 * publishSummary is pure: from what buildSite recorded (the same data as the
 * site's front page) it lists the site, the default branch's latest run, each
 * open pull request's latest run and the runs left out; when nothing was
 * published, the reason. A fork's pull request decides its title and what its
 * artifact holds, so for a fork the summary has numbers and our own links
 * only (the rule of the bot's fork comment, comments.ts); every other text
 * value is escaped.
 *
 * The writes: publish.ts `build` writes it when nothing is published, and
 * `finish` after the deploy and the comments; a failed write only warns.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { strToU8, zipSync } from 'fflate';
import { build, finish } from '../publish';
import type { ApiArtifact, OctokitLike, OpenPr, PublishApi, RepoInfo } from '../publish/api';
import { buildSite, type PublishState } from '../publish/build';
import type { ExistingComment } from '../publish/comments';
import { decidePublish, type PagesInfo } from '../publish/pages';
import type { PlanRun } from '../publish/plan';
import { escapeMarkdown, publishSummary } from '../publish/summary';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const MB = 1024 * 1024;
const SITE = 'https://testivai.github.io/testivai-example/';

/** Text as it reads once rendered: the backslash escapes taken out. */
const rendered = (markdown: string) => markdown.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** A '<', '[', '(' or '*' that is not backslash-escaped. */
const UNESCAPED = /(^|[^\\])[<[(*]/;

// ── the publish-build fixtures (publish-build.test.ts) ──────────────────────

const results = (changed: number) => ({
  version: '2.5.0',
  timestamp: '2026-10-18T10:00:00.000Z',
  summary: { total: 1, passed: changed ? 0 : 1, changed, newSnapshots: 0 },
  snapshots: [{ name: 'home', status: changed ? 'changed' : 'passed', diffPercent: changed, diffCount: changed, totalPixels: 100, currentPath: 'images/home/current.png' }],
});
const reportZip = (changed = 1) => zipSync({ 'results.json': strToU8(JSON.stringify(results(changed))), 'images/home/current.png': PNG });

const REPO: RepoInfo = { id: 1, fullName: 'testivai/testivai-example', visibility: 'public', defaultBranch: 'main' };
const PAGES: PagesInfo = { found: true, buildType: 'workflow', public: true, htmlUrl: SITE };

interface World {
  repo: RepoInfo;
  pages: PagesInfo;
  prs: OpenPr[];
  runs: PlanRun[];
  artifacts: ApiArtifact[];
  zips: Map<number, Uint8Array>;
}

function fakeApi(w: World): PublishApi {
  return {
    repo: async () => w.repo,
    pages: async () => w.pages,
    openPrs: async () => w.prs,
    artifacts: async () => ({ artifacts: w.artifacts, truncated: false }),
    run: async (id) => w.runs.find((r) => r.id === id),
    download: async (id) => {
      const zip = w.zips.get(id);
      if (!zip) throw Object.assign(new Error('Gone'), { status: 410 });
      return zip;
    },
    comments: async () => [] as ExistingComment[],
    createComment: async () => {},
    updateComment: async () => {},
  };
}

const pr = (number: number, over: Partial<OpenPr> = {}): OpenPr => ({
  number,
  headRepo: 'testivai/testivai-example',
  headRepoId: 1,
  headRef: `feature-${number}`,
  headSha: `${number}`.padEnd(40, 'a'),
  author: 'dev',
  fork: false,
  title: `PR ${number}`,
  ...over,
});

const run = (id: number, over: Partial<PlanRun> = {}): PlanRun => ({
  id,
  attempt: 1,
  headRepo: 'testivai/testivai-example',
  headBranch: 'feature-14',
  headSha: 'c'.repeat(40),
  event: 'pull_request',
  status: 'completed',
  createdAt: `2026-10-18T10:${String(id % 60).padStart(2, '0')}:00Z`,
  ...over,
});

const artifactOf = (r: PlanRun): ApiArtifact => ({
  id: r.id * 10,
  runId: r.id,
  name: 'testivai-visual-report',
  sizeBytes: 2048,
  expired: false,
  createdAt: r.createdAt,
  headRepoId: r.headRepo === 'testivai/testivai-example' ? 1 : 9,
  headBranch: r.headBranch,
});

/** main, PR #14 with two runs, and a fork's PR #15. */
function world(over: Partial<World> = {}): World {
  const runs = [run(1, { headBranch: 'main', event: 'push' }), run(2), run(3), run(4, { headRepo: 'someone/testivai-example', headBranch: 'patch-1' })];
  return {
    repo: REPO,
    pages: PAGES,
    prs: [pr(14), pr(15, { headRepo: 'someone/testivai-example', headRepoId: 9, headRef: 'patch-1', fork: true, author: 'someone', title: 'Typo' })],
    runs,
    artifacts: runs.map(artifactOf),
    zips: new Map(runs.map((r) => [r.id * 10, reportZip(r.id === 1 ? 0 : 1)])),
    ...over,
  };
}

let dir: string;
const log = { info: jest.fn(), notice: jest.fn(), warning: jest.fn() };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-summary-'));
  jest.clearAllMocks();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function stateOf(w: World, over: object = {}): Promise<PublishState> {
  const result = await buildSite(fakeApi(w), { artifactName: 'testivai-visual-report', runsPerPr: 3, siteDir: path.join(dir, 'site'), serverUrl: 'https://github.com', log, ...over });
  if (!result.published) throw new Error(`not published: ${result.reason}`);
  return result.state;
}

// ── publishSummary ──────────────────────────────────────────────────────────

describe('publishSummary', () => {
  it("lists the site, main's latest run and each pull request's, as the front page does", async () => {
    const state = await stateOf(world());

    const summary = publishSummary({ published: true, siteUrl: state.siteUrl, site: state.site });

    expect(summary).toMatchSnapshot();
    expect(summary).toContain(`**[Open the reports site](${SITE})**`);
    expect(summary).toContain(`[Latest run on main](${SITE}main/) · 1 passed`);
    expect(summary).toContain('[CI run 1](https://github.com/testivai/testivai-example/actions/runs/1), attempt 1');
    expect(summary).toContain(`[#14](https://github.com/testivai/testivai-example/pull/14) PR 14 · [latest run](${SITE}pr/14/3-1/) · 1 changed · 0 passed · [all 2 runs](${SITE}pr/14/)`);
    expect(summary).toContain(`[#15](https://github.com/testivai/testivai-example/pull/15) · from a fork · [latest run](${SITE}pr/15/4-1/) · 1 changed · 0 passed · [all 1 run](${SITE}pr/15/)`);
    expect(summary).not.toContain('Not published');
  });

  it('lists the runs left out and why', async () => {
    const w = world();
    const big = new Uint8Array(1 * MB);
    big.set(PNG);
    for (const r of w.runs) w.zips.set(r.id * 10, zipSync({ 'results.json': strToU8(JSON.stringify(results(1))), 'images/home/current.png': big }));
    const state = await stateOf(w, { limits: { maxSiteBytes: 3.5 * MB } });

    const summary = publishSummary({ published: true, siteUrl: state.siteUrl, site: state.site });

    expect(summary).toMatchSnapshot();
    expect(rendered(summary)).toContain(
      '#### Not published\n\n- [Run 2](https://github.com/testivai/testivai-example/actions/runs/2) of [#14](https://github.com/testivai/testivai-example/pull/14): the site would be over its 4 MB budget',
    );
    expect(summary).toContain('[all 1 run]');
  });

  it('links the address the deploy reported, when it differs from the one the build had', async () => {
    const state = await stateOf(world());

    const summary = publishSummary({ published: true, siteUrl: 'https://reports.example.com/', site: state.site });

    expect(summary).toContain('(https://reports.example.com/pr/14/3-1/)');
    expect(summary).not.toContain(SITE);
  });

  it('says when nothing is on the site yet', async () => {
    const state = await stateOf(world({ prs: [], runs: [], artifacts: [], zips: new Map() }));

    const summary = publishSummary({ published: true, siteUrl: state.siteUrl, site: state.site });

    expect(summary).toContain('Nothing is published yet: no open pull request or run on the default branch has a report.');
  });

  it('links pages of your own, as the front page does', async () => {
    const own = path.join(dir, 'demo-report');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, 'index.html'), '<h1>Demo</h1>');
    const state = await stateOf(world(), { include: { dir: own, name: 'demo' } });

    expect(publishSummary({ published: true, siteUrl: state.siteUrl, site: state.site })).toContain(`[demo/](${SITE}demo/)`);
  });

  it('without what the site holds (a state file from before), still links the site', () => {
    expect(publishSummary({ published: true, siteUrl: SITE })).toBe(`### TestivAI reports published\n\n**[Open the reports site](${SITE})**\n`);
  });

  describe('a site of your own deployed without its reports (site-dir)', () => {
    const ROOT = 'https://www.budisugianto.com/';

    it('says the site was deployed, links it, and says why the reports were not', () => {
      const { reason } = decidePublish({ pages: { ...PAGES, htmlUrl: ROOT }, repoVisibility: 'private' });

      const summary = publishSummary({ published: true, siteUrl: ROOT, reportsSkipped: reason });

      expect(summary.startsWith(`### Site deployed; TestivAI reports not published\n\n**[Open the site](${ROOT})**\n\n`)).toBe(true);
      expect(rendered(summary)).toContain(reason);
      expect(summary).not.toContain('Open the reports site');
    });

    it('escapes the reason', () => {
      const summary = publishSummary({ published: true, siteUrl: ROOT, reportsSkipped: 'site at http://x.example/<b>[x](y)</b>' });

      expect(summary.split('\n\n').slice(2).join('\n\n')).not.toMatch(UNESCAPED);
    });

    it('links the reports under reports-path when they are published', async () => {
      const own = path.join(dir, '_site');
      fs.mkdirSync(own);
      fs.writeFileSync(path.join(own, 'index.html'), '<h1>Portfolio</h1>');
      const state = await stateOf(world({ pages: { ...PAGES, htmlUrl: ROOT } }), { site: { dir: own, reportsPath: 'visual-reports' } });

      const summary = publishSummary({ published: true, siteUrl: `${ROOT}visual-reports/`, site: state.site });

      expect(summary).toContain(`[Open the reports site](${ROOT}visual-reports/)`);
      expect(summary).toContain(`[latest run](${ROOT}visual-reports/pr/14/3-1/)`);
      expect(summary).toContain(`[all 2 runs](${ROOT}visual-reports/pr/14/)`);
    });
  });

  describe('when nothing was published', () => {
    it.each([
      ['Pages is off', { pages: { found: false }, repoVisibility: 'public' as const }],
      ['Pages builds from a branch', { pages: { found: true, buildType: 'legacy' }, repoVisibility: 'public' as const }],
      ['a private repository with a public site', { pages: PAGES, repoVisibility: 'private' as const }],
    ])('%s: the reason, with the admin instruction, on the run page', (_, input) => {
      const { reason } = decidePublish(input);

      const summary = publishSummary({ published: false, reason });

      expect(summary).toMatchSnapshot();
      expect(summary.startsWith('### TestivAI reports not published\n\n')).toBe(true);
      expect(rendered(summary)).toContain(reason);
      expect(reason).toMatch(/An admin can/);
    });

    it('escapes the reason, which can carry the address GitHub reported', () => {
      const { reason } = decidePublish({ pages: { found: true, buildType: 'workflow', htmlUrl: 'http://reports.example.com/<b>[x](y)</b>' }, repoVisibility: 'public' });

      const summary = publishSummary({ published: false, reason });

      expect(summary).not.toMatch(UNESCAPED);
      expect(rendered(summary)).toContain(reason);
    });
  });

  describe("text a pull request's author controls", () => {
    const HOSTILE = '<img src=x onerror=alert(1)> [click](https://evil.example) **bold** ![i](https://evil.example/i.png) | cell `code` $x$';

    it("leaves out a fork's title: numbers and our own links only", async () => {
      const w = world();
      w.prs[1] = { ...w.prs[1], title: HOSTILE };
      const state = await stateOf(w);

      const summary = publishSummary({ published: true, siteUrl: state.siteUrl, site: state.site });

      for (const bit of ['img', 'onerror', 'evil.example', 'click', 'bold', 'cell', 'code']) expect(summary).not.toContain(bit);
      expect(summary).toContain('[#15](https://github.com/testivai/testivai-example/pull/15) · from a fork ·');
    });

    it("escapes a branch pull request's title, so it reads as text", async () => {
      const w = world();
      w.prs[0] = { ...w.prs[0], title: HOSTILE };
      const state = await stateOf(w);

      const summary = publishSummary({ published: true, siteUrl: state.siteUrl, site: state.site });
      const line = summary.split('\n').find((l) => l.includes('[#14]')) as string;

      const title = line.slice(line.indexOf(') ') + 2, line.indexOf(' · [latest run]'));
      expect(title).not.toMatch(UNESCAPED);
      expect(rendered(title)).toBe(HOSTILE);
    });

    it('cuts a long title, and turns line breaks and direction overrides into spaces', () => {
      const site = {
        repo: 'testivai/testivai-example',
        serverUrl: 'https://github.com',
        defaultBranch: 'main',
        runsPerPr: 3,
        prs: [{ number: 14, fork: false, title: `a\nb\u202Ec${'x'.repeat(300)}`, runs: 1, latest: { runId: 3, attempt: 1, dir: 'pr/14/3-1', outcome: { ok: true as const, summary: { total: 1, passed: 1, changed: 0, newSnapshots: 0 } } } }],
        dropped: [],
      };

      const line = publishSummary({ published: true, siteUrl: SITE, site }).split('\n').find((l) => l.includes('[#14]')) as string;

      const title = line.slice(line.indexOf(') ') + 2, line.indexOf(' · [latest run]'));
      expect(title.startsWith('a b c')).toBe(true);
      expect(title).not.toMatch(/\u202E/);
      expect(title.endsWith('x…')).toBe(true);
      expect(title).toHaveLength(200);
    });

    it("leaves out why a fork's report could not be shown (its artifact decides that text), and escapes a branch's", async () => {
      const w = world();
      w.zips.set(30, zipSync({ 'results.json': strToU8('{"version": "<b>nope</b>"}') }));
      w.zips.set(40, zipSync({ 'results.json': strToU8('{"version": "<b>nope</b>"}') }));
      const state = await stateOf(w);
      const branchOutcome = state.prs.find((p) => p.pr === 14)?.outcome;
      if (!branchOutcome || branchOutcome.ok) throw new Error('expected #14 not to be shown');
      const branchReason = branchOutcome.reason;

      const summary = publishSummary({ published: true, siteUrl: state.siteUrl, site: state.site });
      const fork = summary.split('\n').find((l) => l.includes('[#15]')) as string;
      const branch = summary.split('\n').find((l) => l.includes('[#14]')) as string;

      expect(fork).toContain('could not be shown (its page says why)');
      expect(fork).not.toContain('results');
      expect(rendered(branch)).toContain(`could not be shown: ${branchReason}`);
      expect(branch.slice(branch.indexOf('could not be shown'), branch.indexOf(' · [all'))).not.toMatch(UNESCAPED);
    });
  });
});

describe('escapeMarkdown', () => {
  it('backslash-escapes every ASCII punctuation character, and only those', () => {
    const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    expect(escapeMarkdown(punctuation)).toBe([...punctuation].map((c) => `\\${c}`).join(''));
    expect(escapeMarkdown('Run 12 é ü 中 →')).toBe('Run 12 é ü 中 →');
  });
});

// ── the writes ──────────────────────────────────────────────────────────────

/** A repository with Pages on and one fork pull request with one run (publish-action.test.ts). */
function fakeGithub(pages: 'on' | 'off', over: { visibility?: string; htmlUrl?: string } = {}): { github: OctokitLike; posted: string[] } {
  const posted: string[] = [];
  const routes: Record<string, () => unknown> = {
    'GET /repos/{owner}/{repo}': () => ({ id: 1, full_name: 'testivai/testivai-example', visibility: over.visibility ?? 'public', default_branch: 'main' }),
    'GET /repos/{owner}/{repo}/pages': () => {
      if (pages === 'off') throw Object.assign(new Error('Not Found'), { status: 404 });
      return { build_type: 'workflow', public: true, html_url: over.htmlUrl ?? SITE };
    },
    'GET /repos/{owner}/{repo}/pulls': () => [
      { number: 15, title: '<b>Typo</b>', user: { login: 'someone' }, head: { ref: 'patch-1', sha: 'd'.repeat(40), repo: { id: 9, full_name: 'someone/testivai-example' } } },
    ],
    'GET /repos/{owner}/{repo}/actions/artifacts': () => ({
      artifacts: [{ id: 40, name: 'testivai-visual-report', size_in_bytes: 1000, expired: false, created_at: '2026-10-18T10:00:00Z', workflow_run: { id: 4, head_repository_id: 9, head_branch: 'patch-1' } }],
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
    'GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}': () => Buffer.from(reportZip(1)),
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': () => [],
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': () => ({}),
  };
  return {
    posted,
    github: {
      request: async (route: string) => {
        if (route.startsWith('POST') || route.startsWith('PATCH')) posted.push(route);
        const handler = routes[route];
        if (!handler) throw Object.assign(new Error(`unexpected ${route}`), { status: 500 });
        return { data: handler() };
      },
    },
  };
}

/** @actions/core as github-script passes it, recording the summary writes in order with everything else. */
function stubCore(options: { failWrite?: boolean; events?: string[] } = {}) {
  const events = options.events ?? [];
  const outputs: Record<string, string> = {};
  const written: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  interface SummaryStub {
    addRaw(text: string): SummaryStub;
    write(): Promise<SummaryStub>;
  }
  const summary: SummaryStub = {
    addRaw(text: string) {
      events.push('summary.addRaw');
      written.push(text);
      return summary;
    },
    async write() {
      events.push('summary.write');
      if (options.failWrite) throw new Error('Unable to find environment variable for $GITHUB_STEP_SUMMARY. Check if your runtime environment supports job summaries.');
      return summary;
    },
  };
  const core = {
    summary,
    setOutput: (k: string, v: string) => {
      outputs[k] = v;
    },
    info: () => {},
    notice: (m: string) => {
      events.push('notice');
      notices.push(m);
    },
    warning: (m: string) => warnings.push(m),
  };
  return { core, outputs, written, warnings, notices, events };
}

describe('the publish steps write the summary', () => {
  const context = { repo: { owner: 'testivai', repo: 'testivai-example' }, serverUrl: 'https://github.com' };
  const savedFetch = globalThis.fetch;
  let env: Record<string, string>;
  beforeEach(() => {
    env = { RUNNER_TEMP: dir, ARTIFACT_NAME: 'testivai-visual-report', RUNS_PER_PR: '3', PUBLIC_REPORTS: '', INCLUDE_DIR: '', INCLUDE_NAME: '' };
    // finish checks the deployed site answers; no network here.
    globalThis.fetch = (async () => ({ status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it('build, when nothing is published: once, the reason, next to the notice', async () => {
    const { github } = fakeGithub('off');
    const { core, written, notices, outputs } = stubCore();

    await build({ github, context, core, env });

    expect(outputs.published).toBe('false');
    expect(written).toEqual([publishSummary({ published: false, reason: notices[0] })]);
    expect(notices[0]).toMatch(/not enabled/);
  });

  it('build, when it publishes: nothing yet (finish writes it once the site is live)', async () => {
    const { github } = fakeGithub('on');
    const { core, written, outputs } = stubCore();

    await build({ github, context, core, env });

    expect(outputs.published).toBe('true');
    expect(written).toEqual([]);
  });

  it('finish: once, what was published at the address it linked, after the comments', async () => {
    const { github, posted } = fakeGithub('on');
    const built = stubCore();
    await build({ github, context, core: built.core, env });
    const state = JSON.parse(fs.readFileSync(built.outputs['state-file'], 'utf8')) as PublishState;
    const events: string[] = [];
    const recordingGithub: OctokitLike = {
      request: async (route, params) => {
        if (route.startsWith('POST')) events.push('comment');
        return github.request(route, params);
      },
    };
    const { core, written, outputs } = stubCore({ events });

    await finish({ github: recordingGithub, context, core, env: { STATE_FILE: built.outputs['state-file'], PAGE_URL: 'http://testivai.github.io/testivai-example/', COMMENT: 'true', STATUS_CONTEXT: '' } });

    expect(posted).toHaveLength(1);
    expect(outputs['page-url']).toBe(SITE);
    expect(written).toEqual([publishSummary({ published: true, siteUrl: SITE, site: state.site })]);
    expect(events).toEqual(['comment', 'summary.addRaw', 'summary.write']);
    // The fork's title never reaches it.
    expect(written[0]).not.toContain('Typo');
    expect(written[0]).toContain(`[latest run](${SITE}pr/15/4-1/)`);
  });

  it('finish, with a site of your own deployed without its reports: the site, and why the reports are not on it', async () => {
    const ROOT = 'https://www.budisugianto.com/';
    const own = path.join(dir, '_site');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, 'index.html'), '<h1>Portfolio</h1>');
    const { github, posted } = fakeGithub('on', { visibility: 'private', htmlUrl: ROOT });
    const built = stubCore();
    await build({ github, context, core: built.core, env: { ...env, SITE_DIR: own, REPORTS_PATH: 'visual-reports' } });
    expect(built.written).toEqual([]);
    const { core, written, outputs } = stubCore();

    await finish({ github, context, core, env: { STATE_FILE: built.outputs['state-file'], PAGE_URL: ROOT, COMMENT: 'true', STATUS_CONTEXT: '' } });

    const { reason } = decidePublish({ pages: { ...PAGES, htmlUrl: ROOT }, repoVisibility: 'private' });
    expect(written).toEqual([publishSummary({ published: true, siteUrl: ROOT, reportsSkipped: reason })]);
    expect(outputs['page-url']).toBe(ROOT);
    expect(posted).toEqual([]);
  });

  it('a summary that cannot be written only warns: the outputs are set and the step does not fail', async () => {
    const off = stubCore({ failWrite: true });
    await expect(build({ github: fakeGithub('off').github, context, core: off.core, env })).resolves.toBeUndefined();
    expect(off.outputs.published).toBe('false');
    expect(off.warnings).toEqual([expect.stringMatching(/job summary/)]);

    const { github } = fakeGithub('on');
    const built = stubCore();
    await build({ github, context, core: built.core, env });
    const done = stubCore({ failWrite: true });
    await expect(
      finish({ github, context, core: done.core, env: { STATE_FILE: built.outputs['state-file'], PAGE_URL: SITE, COMMENT: 'false', STATUS_CONTEXT: '' } }),
    ).resolves.toBeUndefined();
    expect(done.outputs['page-url']).toBe(SITE);
    expect(done.warnings).toEqual([expect.stringMatching(/job summary/)]);
  });

  it('the bundled dist/publish.cjs the action loads writes it too', async () => {
    const dist = require(path.resolve(__dirname, '..', '..', 'dist', 'publish.cjs')) as { build: typeof build };
    const { core, written, notices } = stubCore();

    await dist.build({ github: fakeGithub('off').github, context, core, env });

    expect(written).toEqual([publishSummary({ published: false, reason: notices[0] })]);
  });
});
