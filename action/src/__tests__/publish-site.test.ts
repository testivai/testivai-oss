/**
 * Building the published site from the reports' data.
 *
 * Each run's page is rebuilt from its results.json (checked by
 * parseReportData) and its PNGs (checked by checkPng); nothing else from the
 * artifact is published, its own index.html included. Images are renamed to
 * numbered paths, so no snapshot name ends up in a URL. A run whose report
 * cannot be shown gets a page that says why, with the links to the run and
 * its ZIP. The index pages list main and every open pull request's runs; a
 * 404 page explains a link to a report that is no longer published.
 */

import type { ReportArchive } from '../publish/archive';
import type { PlannedRun, PlanPr, SitePlan } from '../publish/plan';
import { buildIndexPages, buildRunReport, type RunOutcome, type SiteFile, type SiteInfo } from '../publish/site';

const SITE: SiteInfo = {
  url: 'https://testivai.github.io/testivai-example/',
  repo: 'testivai/testivai-example',
  serverUrl: 'https://github.com',
  defaultBranch: 'main',
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 2, 0xd0, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const HTML_AS_PNG = new TextEncoder().encode('<script>alert(1)</script>');

function plannedRun(over: Partial<PlannedRun> = {}): PlannedRun {
  return {
    runId: 39150236166,
    attempt: 1,
    artifactId: 4402,
    sizeBytes: 1024,
    dir: 'pr/14/39150236166-1',
    headSha: '70d8c8e5a1b2c3d4e5f60718293a4b5c6d7e8f90',
    createdAt: '2026-10-18T10:05:31Z',
    fork: false,
    ...over,
  };
}

function prOf(over: Partial<PlanPr> = {}): PlanPr {
  return { number: 14, headRepo: 'testivai/testivai-example', headRef: 'feature', headSha: 'x', author: 'dev', fork: false, title: 'Restyle the hero', ...over };
}

function results(snapshots: object[], over: object = {}) {
  return {
    version: '2.5.0',
    timestamp: '2026-10-18T10:04:00.000Z',
    summary: { total: snapshots.length, passed: 0, changed: snapshots.length, newSnapshots: 0, missing: 0 },
    snapshots,
    ...over,
  };
}

const changed = (name: string, over: object = {}) => ({
  name,
  status: 'changed',
  diffPercent: 1.5,
  diffCount: 150,
  totalPixels: 10_000,
  baselinePath: `images/${name}/baseline.png`,
  currentPath: `images/${name}/current.png`,
  diffPath: `images/${name}/diff.png`,
  ...over,
});

function archiveOf(json: unknown, images: Record<string, Uint8Array> = {}, runStamp?: unknown): ReportArchive {
  const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
  return {
    ...(json === undefined ? {} : { results: enc(json) }),
    ...(runStamp === undefined ? {} : { runStamp: enc(runStamp) }),
    images: new Map(Object.entries(images)),
  };
}

const ARTIFACT_URL = 'https://github.com/testivai/testivai-example/actions/runs/39150236166/artifacts/4402';

function build(archive: ReportArchive | { refused: string }, over: { run?: Partial<PlannedRun>; pr?: PlanPr | null } = {}) {
  return buildRunReport({
    site: SITE,
    run: plannedRun(over.run),
    ...(over.pr === null ? {} : { pr: over.pr ?? prOf() }),
    artifactUrl: ARTIFACT_URL,
    archive,
  });
}

const fileAt = (files: SiteFile[], path: string) => files.find((f) => f.path === path);
const htmlAt = (files: SiteFile[], path: string) => {
  const file = fileAt(files, path);
  if (!file) throw new Error(`no ${path} in ${files.map((f) => f.path).join(', ')}`);
  return String(file.data);
};

describe('buildRunReport', () => {
  it("rebuilds the run's page from its results, in the run's folder", () => {
    const { files, outcome } = build(archiveOf(results([changed('home')]), { 'images/home/current.png': PNG }));

    const html = htmlAt(files, 'pr/14/39150236166-1/index.html');
    expect(html).toContain('TestivAI Visual Report');
    expect(html).toContain('home');
    expect(outcome).toMatchObject({ ok: true, runId: 39150236166, dir: 'pr/14/39150236166-1', url: 'https://testivai.github.io/testivai-example/pr/14/39150236166-1/' });
    expect(outcome.ok && outcome.summary.changed).toBe(1);
  });

  it('publishes the images under numbered paths, never under the snapshot name', () => {
    const { files } = build(
      archiveOf(results([changed('home'), changed('checkout/step 2')]), {
        'images/home/baseline.png': PNG,
        'images/home/current.png': PNG,
        'images/home/diff.png': PNG,
        'images/checkout/step 2/current.png': PNG,
      }),
    );

    expect(files.map((f) => f.path).sort()).toEqual([
      'pr/14/39150236166-1/images/0/baseline.png',
      'pr/14/39150236166-1/images/0/current.png',
      'pr/14/39150236166-1/images/0/diff.png',
      'pr/14/39150236166-1/images/1/current.png',
      'pr/14/39150236166-1/index.html',
    ]);
    const html = htmlAt(files, 'pr/14/39150236166-1/index.html');
    expect(html).toContain('src="images/0/baseline.png"');
    expect(html).toContain('src="images/1/current.png"');
    expect(html).not.toContain('images/home/');
    expect(fileAt(files, 'pr/14/39150236166-1/images/0/diff.png')?.data).toBe(PNG);
  });

  it('finds each image by the path results.json gives, whatever folder name the report used', () => {
    const { files } = build(archiveOf(results([changed('Home Page', { currentPath: 'images/home-page/current.png' })]), { 'images/home-page/current.png': PNG }));

    expect(fileAt(files, 'pr/14/39150236166-1/images/0/current.png')).toBeDefined();
  });

  it('leaves out an image that is not a PNG, and says so', () => {
    const { files, outcome } = build(
      archiveOf(results([changed('home')]), { 'images/home/current.png': HTML_AS_PNG, 'images/home/baseline.png': PNG }),
    );

    expect(fileAt(files, 'pr/14/39150236166-1/images/0/current.png')).toBeUndefined();
    expect(fileAt(files, 'pr/14/39150236166-1/images/0/baseline.png')).toBeDefined();
    const html = htmlAt(files, 'pr/14/39150236166-1/index.html');
    expect(html).not.toContain('src="images/0/current.png"');
    expect(html).toMatch(/report-notice warning">1 image was left out[^<]*images\/home\/current\.png \(not a PNG\)/);
    expect(outcome.ok && outcome.omittedImages).toEqual(['images/home/current.png (not a PNG)']);
  });

  it('shows no image for a path the archive does not have, or one that names another kind of image', () => {
    const { files } = build(
      archiveOf(results([changed('home', { baselinePath: 'images/home/current.png', diffPath: 'images/other/diff.png' })]), {
        'images/home/current.png': PNG,
      }),
    );

    expect(files.map((f) => f.path).sort()).toEqual(['pr/14/39150236166-1/images/0/current.png', 'pr/14/39150236166-1/index.html']);
  });

  it('shows the names and text from results.json as text, never markup', () => {
    const { files } = build(archiveOf(results([changed('<img src=x onerror=alert(1)>')])));

    const html = htmlAt(files, 'pr/14/39150236166-1/index.html');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('marks the page as not for search engines, under a strict content security policy', () => {
    const html = htmlAt(build(archiveOf(results([changed('home')]))).files, 'pr/14/39150236166-1/index.html');

    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  it('says which pull request, commit and run the report is from, with links to them, the other runs and the ZIP', () => {
    const html = htmlAt(build(archiveOf(results([changed('home')]))).files, 'pr/14/39150236166-1/index.html');

    expect(html).toContain('Pull request #14 · commit 70d8c8e · CI run 39150236166, attempt 1 · 2026-10-18 10:05 UTC');
    expect(html).toContain('href="https://github.com/testivai/testivai-example/pull/14"');
    expect(html).toContain('href="https://github.com/testivai/testivai-example/actions/runs/39150236166"');
    expect(html).toContain('href="https://testivai.github.io/testivai-example/pr/14/"');
    expect(html).toContain(`href="${ARTIFACT_URL}"`);
  });

  it("warns that a fork's report is the fork's own", () => {
    const html = htmlAt(
      build(archiveOf(results([changed('home')])), { run: { fork: true }, pr: prOf({ fork: true, author: 'someone' }) }).files,
      'pr/14/39150236166-1/index.html',
    );

    expect(html).toMatch(/report-notice warning">From a fork \(someone\)/);
    expect(html).toContain('cannot vouch for what they show');
  });

  it("does not warn about a branch's report", () => {
    expect(htmlAt(build(archiveOf(results([changed('home')]))).files, 'pr/14/39150236166-1/index.html')).not.toContain('From a fork');
  });

  it('describes the run on the default branch as main', () => {
    const { files, outcome } = build(archiveOf(results([changed('home')])), { run: { dir: 'main' }, pr: null });

    const html = htmlAt(files, 'main/index.html');
    expect(html).toContain('main · commit 70d8c8e · CI run 39150236166, attempt 1 · 2026-10-18 10:05 UTC');
    expect(html).toContain('href="https://testivai.github.io/testivai-example/"');
    expect(html).not.toContain('/pull/');
    expect(outcome.url).toBe('https://testivai.github.io/testivai-example/main/');
  });

  it("says when the report is from an earlier attempt than the run's latest", () => {
    const html = htmlAt(
      build(archiveOf(results([changed('home')]), {}, { runId: '39150236166', runAttempt: 1, sha: 'x' }), { run: { attempt: 2, dir: 'pr/14/39150236166-2' } }).files,
      'pr/14/39150236166-2/index.html',
    );

    expect(html).toContain('This report is from attempt 1 of the run; attempt 2 did not upload one.');
  });

  it('says nothing about attempts when the stamp agrees, or is not a number', () => {
    for (const stamp of [{ runAttempt: 1 }, { runAttempt: '<b>2</b>' }, 'not json']) {
      expect(htmlAt(build(archiveOf(results([changed('home')]), {}, stamp)).files, 'pr/14/39150236166-1/index.html')).not.toContain('from attempt');
    }
  });

  describe('a report that cannot be shown', () => {
    it.each([
      ['no results.json', archiveOf(undefined), 'The report has no results.json.'],
      ['results.json that is not JSON', archiveOf('{"version":'), 'results.json is not valid JSON.'],
      ['results.json of a newer format', archiveOf(results([], { version: '3.0.0' })), 'is newer than this TestivAI can show'],
      ['results.json with a wrong field', archiveOf(results([changed('home', { diffPercent: 'lots' })])), 'snapshots[0].diffPercent: expected a finite number'],
      ['an archive that was refused', { refused: 'images/a/current.png inflates past the 52428800-byte limit' }, 'inflates past the 52428800-byte limit'],
    ])('gets a page that says why, for %s', (_, archive, reason) => {
      const { files, outcome } = build(archive);

      expect(files.map((f) => f.path)).toEqual(['pr/14/39150236166-1/index.html']);
      const html = htmlAt(files, 'pr/14/39150236166-1/index.html');
      expect(html).toContain('This report could not be shown');
      expect(html).toContain(reason);
      expect(html).toContain(`href="${ARTIFACT_URL}"`);
      expect(html).toContain('href="https://github.com/testivai/testivai-example/actions/runs/39150236166"');
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    });

    it('shows the reason as text: it can quote names from the archive', () => {
      const { files } = build({ refused: '<script>alert(1)</script>/current.png is 99 bytes, over the 1-byte limit' });

      const html = htmlAt(files, 'pr/14/39150236166-1/index.html');
      expect(html).not.toContain('<script>alert(1)');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;/current.png');
    });
  });
});

describe('buildIndexPages', () => {
  const okOutcome = (run: PlannedRun, counts: { changed?: number; newSnapshots?: number; passed?: number } = {}): RunOutcome => ({
    ok: true,
    runId: run.runId,
    dir: run.dir,
    url: `${SITE.url}${run.dir}/`,
    summary: { total: 0, passed: counts.passed ?? 0, changed: counts.changed ?? 0, newSnapshots: counts.newSnapshots ?? 0 },
    data: results([]) as never,
    omittedImages: [],
  });

  const mainRun = plannedRun({ runId: 100, dir: 'main', headSha: 'aaaaaaa111', createdAt: '2026-10-18T09:00:00Z' });
  const pr14Runs = [
    plannedRun({ runId: 300, dir: 'pr/14/300-1', headSha: 'ccccccc333', createdAt: '2026-10-18T11:00:00Z' }),
    plannedRun({ runId: 200, dir: 'pr/14/200-2', attempt: 2, headSha: 'bbbbbbb222', createdAt: '2026-10-18T10:00:00Z' }),
  ];
  const forkPr = prOf({ number: 15, fork: true, author: 'someone', title: '<script>alert(1)</script> Fix typo' });
  const forkRun = plannedRun({ runId: 400, dir: 'pr/15/400-1', fork: true, headSha: 'ddddddd444' });
  const plan: SitePlan = {
    main: mainRun,
    prs: [
      { pr: prOf(), runs: pr14Runs },
      { pr: forkPr, runs: [forkRun] },
    ],
    dropped: [{ runId: 150, pr: 14, reason: 'its report is 200 MB, over the 150 MB limit for one run' }],
    totalBytes: 4096,
  };
  const outcomes = new Map<number, RunOutcome>([
    [100, okOutcome(mainRun, { passed: 12 })],
    [300, okOutcome(pr14Runs[0], { changed: 2, newSnapshots: 1, passed: 9 })],
    [200, { ok: false, runId: 200, dir: 'pr/14/200-2', url: `${SITE.url}pr/14/200-2/`, reason: 'The report has no results.json.' }],
    [400, okOutcome(forkRun, { changed: 1 })],
  ]);

  const pages = () => buildIndexPages({ site: SITE, plan, outcomes, runsPerPr: 3 });

  it('lists main and each open pull request on the front page, with their latest run', () => {
    const html = htmlAt(pages(), 'index.html');

    expect(html).toContain('testivai/testivai-example');
    expect(html).toContain('href="main/"');
    expect(html).toContain('12 passed');
    expect(html).toContain('#14');
    expect(html).toContain('Restyle the hero');
    expect(html).toContain('href="pr/14/300-1/"');
    expect(html).toContain('2 changed · 1 new · 9 passed');
    expect(html).toContain('href="pr/14/"');
    expect(html).toContain('#15');
    expect(html).toContain('href="pr/15/400-1/"');
  });

  it("shows a pull request's title as text, and marks a fork's", () => {
    const html = htmlAt(pages(), 'index.html');

    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Fix typo');
    expect(html).toMatch(/#15[\s\S]*fork/);
  });

  it("lists a pull request's runs newest first on its own page, with the ones not shown and not published", () => {
    const html = htmlAt(pages(), 'pr/14/index.html');

    expect(html).toContain('Pull request #14');
    expect(html).toContain('href="https://github.com/testivai/testivai-example/pull/14"');
    expect(html.indexOf('href="300-1/"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="300-1/"')).toBeLessThan(html.indexOf('href="200-2/"'));
    expect(html).toContain('commit ccccccc');
    expect(html).toContain('attempt 2');
    expect(html).toContain('could not be shown: The report has no results.json.');
    expect(html).toContain('Run 150 is not published: its report is 200 MB, over the 150 MB limit for one run');
    expect(html).toContain('last 3 runs');
  });

  it('writes a page per pull request, a front page and a 404 page, all noindex under a strict policy', () => {
    const files = pages();

    expect(files.map((f) => f.path).sort()).toEqual(['404.html', 'index.html', 'pr/14/index.html', 'pr/15/index.html']);
    for (const file of files) {
      expect(String(file.data)).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(String(file.data)).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; [^"]*">/);
      expect(String(file.data)).not.toContain('<script');
    }
  });

  it('explains a link to a report that is no longer published, with an absolute link home', () => {
    const html = htmlAt(pages(), '404.html');

    expect(html).toContain('no longer published');
    expect(html).toContain('href="https://testivai.github.io/testivai-example/"');
  });

  it('says so when nothing is published yet', () => {
    const html = htmlAt(buildIndexPages({ site: SITE, plan: { prs: [], dropped: [], totalBytes: 0 }, outcomes: new Map(), runsPerPr: 3 }), 'index.html');

    expect(html).toContain('Nothing is published yet');
  });
});
