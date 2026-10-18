/**
 * The publish step end to end, against a fake GitHub API: deciding, listing,
 * planning, downloading one report at a time, writing the site, and after
 * the deploy, checking the site answers and adding the links to the pull
 * requests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { strToU8, zipSync } from 'fflate';
import { buildComment, UPSERT_MARKER } from '../comment';
import type { ApiArtifact, OpenPr, PublishApi, RepoInfo } from '../publish/api';
import { buildSite, finishPublish, safeSitePath, type PublishState } from '../publish/build';
import type { ExistingComment } from '../publish/comments';
import type { PagesInfo } from '../publish/pages';
import type { PlanRun } from '../publish/plan';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const MB = 1024 * 1024;

const results = (changed: number) => ({
  version: '2.5.0',
  timestamp: '2026-10-18T10:00:00.000Z',
  summary: { total: 1, passed: changed ? 0 : 1, changed, newSnapshots: 0 },
  snapshots: [{ name: 'home', status: changed ? 'changed' : 'passed', diffPercent: changed, diffCount: changed, totalPixels: 100, currentPath: 'images/home/current.png' }],
});

function reportZip(changed = 1, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({ 'results.json': strToU8(JSON.stringify(results(changed))), 'images/home/current.png': PNG, ...extra });
}

const REPO: RepoInfo = { id: 1, fullName: 'testivai/testivai-example', visibility: 'public', defaultBranch: 'main' };
const PAGES: PagesInfo = { found: true, buildType: 'workflow', public: true, htmlUrl: 'https://testivai.github.io/testivai-example/' };

interface World {
  repo: RepoInfo;
  pages: PagesInfo;
  prs: OpenPr[];
  runs: PlanRun[];
  artifacts: ApiArtifact[];
  zips: Map<number, Uint8Array | Error>;
  comments: Map<number, ExistingComment[]>;
  truncated?: boolean;
}

function fakeApi(world: World) {
  const calls = { run: [] as number[], download: [] as number[], create: [] as Array<[number, string]>, update: [] as Array<[number, string]> };
  const api: PublishApi = {
    repo: async () => world.repo,
    pages: async () => world.pages,
    openPrs: async () => world.prs,
    artifacts: async () => ({ artifacts: world.artifacts, truncated: world.truncated ?? false }),
    run: async (id) => {
      calls.run.push(id);
      return world.runs.find((r) => r.id === id);
    },
    download: async (id) => {
      calls.download.push(id);
      const zip = world.zips.get(id);
      if (!zip) throw Object.assign(new Error('Gone'), { status: 410 });
      if (zip instanceof Error) throw zip;
      return zip;
    },
    comments: async (pr) => world.comments.get(pr) ?? [],
    createComment: async (pr, body) => {
      calls.create.push([pr, body]);
    },
    updateComment: async (id, body) => {
      calls.update.push([id, body]);
    },
  };
  return { api, calls };
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

const artifactOf = (r: PlanRun, over: Partial<ApiArtifact> = {}): ApiArtifact => ({
  id: r.id * 10,
  runId: r.id,
  name: 'testivai-visual-report',
  sizeBytes: 2048,
  expired: false,
  createdAt: r.createdAt,
  headRepoId: r.headRepo === 'testivai/testivai-example' ? 1 : 9,
  headBranch: r.headBranch,
  ...over,
});

/** main, PR #14 with two runs, and a fork's PR #15. */
function world(over: Partial<World> = {}): World {
  const runs = [
    run(1, { headBranch: 'main', event: 'push' }),
    run(2),
    run(3),
    run(4, { headRepo: 'someone/testivai-example', headBranch: 'patch-1' }),
  ];
  return {
    repo: REPO,
    pages: PAGES,
    prs: [pr(14), pr(15, { headRepo: 'someone/testivai-example', headRepoId: 9, headRef: 'patch-1', fork: true, author: 'someone' })],
    runs,
    artifacts: runs.map((r) => artifactOf(r)),
    zips: new Map(runs.map((r) => [r.id * 10, reportZip(r.id === 1 ? 0 : 1)])),
    comments: new Map(),
    ...over,
  };
}

let dir: string;
const log = { info: jest.fn(), notice: jest.fn(), warning: jest.fn() };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-build-'));
  jest.clearAllMocks();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const siteDir = () => path.join(dir, 'site');
const options = (over: object = {}) => ({ artifactName: 'testivai-visual-report', runsPerPr: 3, siteDir: siteDir(), serverUrl: 'https://github.com', log, ...over });

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  walk(root, '');
  return out.sort();
}

describe('buildSite', () => {
  it("publishes nothing when the repository's settings say not to, and says why", async () => {
    const { api, calls } = fakeApi(world({ pages: { found: false } }));

    const result = await buildSite(api, options());

    expect(result).toEqual({ published: false, reason: expect.stringMatching(/not enabled/) });
    expect(fs.existsSync(siteDir())).toBe(false);
    expect(calls.download).toEqual([]);
  });

  it('builds the site from main and every open pull request, forks included', async () => {
    const { api } = fakeApi(world());

    const result = await buildSite(api, options());

    expect(result.published).toBe(true);
    expect(tree(siteDir())).toEqual([
      '404.html',
      'index.html',
      'main/images/0/current.png',
      'main/index.html',
      'pr/14/2-1/images/0/current.png',
      'pr/14/2-1/index.html',
      'pr/14/3-1/images/0/current.png',
      'pr/14/3-1/index.html',
      'pr/14/index.html',
      'pr/15/4-1/images/0/current.png',
      'pr/15/4-1/index.html',
      'pr/15/index.html',
    ]);
    expect(fs.readFileSync(path.join(siteDir(), 'pr/15/4-1/index.html'), 'utf8')).toContain('From a fork (someone)');
  });

  it("records each pull request's latest published run for the comments", async () => {
    const { api } = fakeApi(world());

    const result = await buildSite(api, options());

    expect(result.published && result.state).toMatchObject({
      siteUrl: 'https://testivai.github.io/testivai-example/',
      visibility: 'public',
      prs: [
        { pr: 14, fork: false, runId: 3, attempt: 1, url: 'https://testivai.github.io/testivai-example/pr/14/3-1/', artifactUrl: 'https://github.com/testivai/testivai-example/actions/runs/3/artifacts/30', outcome: { ok: true } },
        { pr: 15, fork: true, runId: 4, url: 'https://testivai.github.io/testivai-example/pr/15/4-1/' },
      ],
    });
  });

  it('only looks up and downloads runs of open pull requests and the default branch', async () => {
    const w = world();
    const closed = run(9, { headBranch: 'old-branch' });
    w.runs.push(closed);
    w.artifacts.push(artifactOf(closed));
    const { api, calls } = fakeApi(w);

    await buildSite(api, options());

    expect(calls.run).not.toContain(9);
    expect(calls.download.sort()).toEqual([10, 20, 30, 40]);
  });

  it("looks up no more than a pull request's runs-per-pr, plus one in case the newest is still running", async () => {
    const w = world();
    const many = [10, 11, 12, 13, 14, 15].map((id) => run(id));
    w.runs.push(...many);
    w.artifacts.push(...many.map((r) => artifactOf(r)));
    const { api, calls } = fakeApi(w);

    await buildSite(api, options({ runsPerPr: 2 }));

    const pr14Lookups = calls.run.filter((id) => [2, 3, ...many.map((r) => r.id)].includes(id));
    expect(pr14Lookups.sort((a, b) => a - b)).toEqual([13, 14, 15]);
  });

  it("does not let expired reports use up a pull request's lookups", async () => {
    const w = world();
    const expired = [20, 21].map((id) => run(id));
    w.runs.push(...expired);
    w.artifacts.push(...expired.map((r) => artifactOf(r, { expired: true })));
    const { api } = fakeApi(w);

    const result = await buildSite(api, options({ runsPerPr: 1 }));

    expect(result.published && result.state.prs.find((p) => p.pr === 14)?.runId).toBe(3);
  });

  it('gives a run whose report cannot be downloaded or read a page that says why, and publishes the rest', async () => {
    const w = world();
    w.zips.set(20, Object.assign(new Error('Server Error'), { status: 500 }));
    w.zips.set(30, strToU8('not a zip at all'));
    const { api } = fakeApi(w);

    const result = await buildSite(api, options());

    expect(fs.readFileSync(path.join(siteDir(), 'pr/14/2-1/index.html'), 'utf8')).toMatch(/could not be shown[\s\S]*could not be downloaded \(Server Error\)/);
    expect(fs.readFileSync(path.join(siteDir(), 'pr/14/3-1/index.html'), 'utf8')).toMatch(/could not be shown[\s\S]*not a readable ZIP|could not be shown[\s\S]*no results\.json/);
    expect(fs.existsSync(path.join(siteDir(), 'main/index.html'))).toBe(true);
    expect(result.published && result.state.prs[0].outcome.ok).toBe(false);
  });

  it('refuses a zip bomb without inflating it', async () => {
    const w = world();
    w.zips.set(30, zipSync({ 'results.json': strToU8(JSON.stringify(results(1))), 'images/home/current.png': new Uint8Array(80 * MB) }));
    const { api } = fakeApi(w);

    await buildSite(api, options());

    expect(fs.readFileSync(path.join(siteDir(), 'pr/14/3-1/index.html'), 'utf8')).toMatch(/inflates past|bytes, over the/);
  });

  it('starts from an empty site every time, so a closed pull request is gone', async () => {
    fs.mkdirSync(path.join(siteDir(), 'pr/7/1-1'), { recursive: true });
    fs.writeFileSync(path.join(siteDir(), 'pr/7/1-1/index.html'), 'old');
    const { api } = fakeApi(world());

    await buildSite(api, options());

    expect(fs.existsSync(path.join(siteDir(), 'pr/7'))).toBe(false);
  });

  it("leaves out a run whose files would take the site over its size, and says so on its pull request's page", async () => {
    const w = world();
    // Each report is ~1 MB of PNG once written; the budget fits three.
    const big = new Uint8Array(1 * MB);
    big.set(PNG);
    for (const r of w.runs) w.zips.set(r.id * 10, zipSync({ 'results.json': strToU8(JSON.stringify(results(1))), 'images/home/current.png': big }));
    const { api } = fakeApi(w);

    const result = await buildSite(api, options({ limits: { maxSiteBytes: 3.5 * MB } }));

    // main, then each pull request's latest, then older runs: the older run of #14 is the one left out.
    expect(fs.existsSync(path.join(siteDir(), 'main/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(siteDir(), 'pr/14/3-1/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(siteDir(), 'pr/15/4-1/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(siteDir(), 'pr/14/2-1'))).toBe(false);
    expect(fs.readFileSync(path.join(siteDir(), 'pr/14/index.html'), 'utf8')).toMatch(/Run 2 is not published: the site would be over its \d+ MB budget/);
    expect(result.published && result.bytes).toBeLessThanOrEqual(3.5 * MB);
  });

  it('warns when the artifact list was cut short', async () => {
    const { api } = fakeApi(world({ truncated: true }));

    await buildSite(api, options());

    expect(log.warning).toHaveBeenCalledWith(expect.stringMatching(/artifacts/));
  });

  it('turns down a private repository with a public site unless an admin allowed it', async () => {
    const privateRepo = { ...REPO, visibility: 'private' as const };

    expect((await buildSite(fakeApi(world({ repo: privateRepo })).api, options())).published).toBe(false);
    expect((await buildSite(fakeApi(world({ repo: privateRepo })).api, options({ consent: 'true' }))).published).toBe(true);
  });
});

describe('safeSitePath', () => {
  it('keeps a plain relative path inside the site', () => {
    expect(safeSitePath('/site', 'pr/14/3-1/images/0/current.png')).toBe(path.join('/site', 'pr/14/3-1/images/0/current.png'));
  });

  it.each(['../evil.html', 'pr/../../evil.html', '/etc/passwd', 'pr//x.html', 'pr/x y.html', 'pr\\x.html', 'pr/x.js', ''])('refuses %s', (p) => {
    expect(() => safeSitePath('/site', p)).toThrow(/not a site path/);
  });
});

describe('finishPublish', () => {
  const STATE: PublishState = {
    siteUrl: 'https://testivai.github.io/testivai-example/',
    visibility: 'public',
    prs: [
      {
        pr: 14,
        fork: false,
        runId: 3,
        attempt: 1,
        headSha: 'c'.repeat(40),
        url: 'https://testivai.github.io/testivai-example/pr/14/3-1/',
        artifactUrl: 'https://github.com/testivai/testivai-example/actions/runs/3/artifacts/30',
        outcome: { ok: true, summary: results(1).summary, data: results(1) as never },
      },
      {
        pr: 15,
        fork: true,
        runId: 4,
        attempt: 1,
        headSha: 'd'.repeat(40),
        url: 'https://testivai.github.io/testivai-example/pr/15/4-1/',
        artifactUrl: 'https://github.com/testivai/testivai-example/actions/runs/4/artifacts/40',
        outcome: { ok: true, summary: results(1).summary, data: results(1) as never },
      },
    ],
  };
  const reporterComment = (runKey: string): ExistingComment => ({
    id: 77,
    author: 'github-actions[bot]',
    body: buildComment(results(1) as never, STATE.prs[0].artifactUrl, UPSERT_MARKER, { runKey }),
  });
  const ok = async () => ({ status: 200 }) as Response;

  it("checks the public site answers, then updates the branch pull request's comment and posts the fork's", async () => {
    const { api, calls } = fakeApi(world({ comments: new Map([[14, [reporterComment('3-1')]]]) }));
    const fetched: string[] = [];

    const result = await finishPublish(api, {
      state: STATE,
      comment: true,
      marker: UPSERT_MARKER,
      fetch: async (url) => {
        fetched.push(String(url));
        return ok();
      },
      delayMs: 0,
      log,
    });

    expect(fetched[0]).toBe('https://testivai.github.io/testivai-example/');
    expect(result.verified).toBe(true);
    expect(calls.update.map(([id]) => id)).toEqual([77]);
    expect(calls.update[0][1]).toContain('[Open the visual report](https://testivai.github.io/testivai-example/pr/14/3-1/)');
    expect(calls.create.map(([n]) => n)).toEqual([15]);
  });

  it('retries while the site is not answering yet', async () => {
    const { api } = fakeApi(world());
    let n = 0;

    const result = await finishPublish(api, { state: STATE, comment: false, marker: UPSERT_MARKER, fetch: async () => ({ status: ++n < 3 ? 404 : 200 }) as Response, delayMs: 0, log });

    expect(n).toBe(3);
    expect(result.verified).toBe(true);
  });

  it('warns, and still adds the links, when the site never answers (the deploy itself succeeded)', async () => {
    const { api, calls } = fakeApi(world({ comments: new Map([[14, [reporterComment('3-1')]]]) }));

    const result = await finishPublish(api, { state: STATE, comment: true, marker: UPSERT_MARKER, fetch: async () => ({ status: 404 }) as Response, delayMs: 0, retries: 2, log });

    expect(result.verified).toBe(false);
    expect(log.warning).toHaveBeenCalledWith(expect.stringMatching(/did not answer/));
    expect(calls.update).toHaveLength(1);
  });

  it('does not try to open a private site (it needs a sign-in)', async () => {
    const { api } = fakeApi(world());
    const fetch = jest.fn();

    const result = await finishPublish(api, { state: { ...STATE, visibility: 'private' }, comment: false, marker: UPSERT_MARKER, fetch, delayMs: 0, log });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.verified).toBe('skipped');
  });

  it('links the address the deploy reports when it differs from the one GitHub gave before', async () => {
    const { api, calls } = fakeApi(world({ comments: new Map([[14, [reporterComment('3-1')]]]) }));

    await finishPublish(api, { state: STATE, pageUrl: 'https://reports.example.com/', comment: true, marker: UPSERT_MARKER, fetch: ok, delayMs: 0, log });

    expect(calls.update[0][1]).toContain('(https://reports.example.com/pr/14/3-1/)');
    expect(log.warning).toHaveBeenCalledWith(expect.stringMatching(/reports\.example\.com/));
  });

  it('ignores a deploy address that is not https', async () => {
    const { api, calls } = fakeApi(world({ comments: new Map([[14, [reporterComment('3-1')]]]) }));

    for (const pageUrl of ['javascript:alert(1)//', 'http://reports.example.com/']) {
      await finishPublish(api, { state: STATE, pageUrl, comment: true, marker: UPSERT_MARKER, fetch: ok, delayMs: 0, log });
    }

    expect(calls.update.map(([, body]) => body.includes('(https://testivai.github.io/testivai-example/pr/14/3-1/)'))).toEqual([true, true]);
  });

  it('adds no links when comments are turned off', async () => {
    const { api, calls } = fakeApi(world({ comments: new Map([[14, [reporterComment('3-1')]]]) }));

    await finishPublish(api, { state: STATE, comment: false, marker: UPSERT_MARKER, fetch: ok, delayMs: 0, log });

    expect([...calls.update, ...calls.create]).toEqual([]);
  });

  it('warns about a comment it could not write and carries on with the others', async () => {
    const { api, calls } = fakeApi(world({ comments: new Map([[14, [reporterComment('3-1')]]]) }));
    api.updateComment = async () => {
      throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    };

    await finishPublish(api, { state: STATE, comment: true, marker: UPSERT_MARKER, fetch: ok, delayMs: 0, log });

    expect(log.warning).toHaveBeenCalledWith(expect.stringMatching(/#14.*pull-requests: write/));
    expect(calls.create.map(([n]) => n)).toEqual([15]);
  });
});
