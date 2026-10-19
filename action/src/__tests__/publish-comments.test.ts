/**
 * Adding the published report's links to the pull request, after deploy.
 *
 * The reporter's comment is rebuilt with the links only when its hidden run
 * marker names the run that was published: a comment about a newer run is
 * left for that run's own publish, so a slow publish never puts an older
 * report's link on it. A fork's CI run cannot comment, so the publish posts
 * one comment of its own, built only from numbers and its own links: no
 * text from the fork's results (names, reasons) goes into it.
 */

import { buildComment, buildEmptyComment, readRunKey, UPSERT_MARKER } from '../comment';
import { commentFor, FORK_MARKER, publishedThumbnails, type ExistingComment, type PublishedPr } from '../publish/comments';
import type { ReportData } from '../../../packages/witness/src/report/results';
import { parseReportData } from '../../../packages/witness/src/report/validate';

const DATA: ReportData = {
  version: '2.5.0',
  timestamp: '2026-10-18T10:04:00.000Z',
  summary: { total: 3, passed: 1, changed: 1, newSnapshots: 1, missing: 0 },
  snapshots: [
    { name: 'home', status: 'changed', diffPercent: 1.5, diffCount: 150, totalPixels: 10_000, dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0, textChanges: 0 } } },
    { name: 'checkout', status: 'new', diffPercent: 0, diffCount: 0, totalPixels: 0 },
    { name: 'footer', status: 'passed', diffPercent: 0, diffCount: 0, totalPixels: 10_000 },
  ],
};

const URL = 'https://testivai.github.io/testivai-example/pr/14/39150236166-1/';
const ZIP = 'https://github.com/testivai/testivai-example/actions/runs/39150236166/artifacts/4402';

function published(over: Partial<PublishedPr> = {}): PublishedPr {
  return {
    pr: 14,
    fork: false,
    runId: 39150236166,
    attempt: 1,
    headSha: '70d8c8e5a1b2c3d4e5f6',
    url: URL,
    artifactUrl: ZIP,
    outcome: { ok: true, summary: DATA.summary, data: DATA },
    ...over,
  };
}

/** The comment the reporter posted for that run, before the publish. */
const reporterComment = (runKey: string, over: Partial<ExistingComment> = {}): ExistingComment => ({
  id: 77,
  author: 'github-actions[bot]',
  body: buildComment(DATA as never, ZIP, UPSERT_MARKER, { runKey }),
  ...over,
});

describe('commentFor, a branch pull request', () => {
  it("rebuilds the reporter's comment with the report links, keeping its run marker", () => {
    const action = commentFor(published(), [reporterComment('39150236166-1')], UPSERT_MARKER);

    expect(action.kind).toBe('update');
    if (action.kind !== 'update') return;
    expect(action.id).toBe(77);
    expect(action.body).toBe(buildComment(DATA as never, ZIP, UPSERT_MARKER, { reportUrl: URL, runKey: '39150236166-1' }));
    expect(action.body).toContain(`[Open the visual report](${URL})`);
    expect(readRunKey(action.body)).toBe('39150236166-1');
  });

  it('builds the same comment from the checked data as the reporter built from the raw results.json', () => {
    // Everything the comment reads, as witness writes it.
    const env = (version: string) => ({
      os: { platform: 'linux', distro: 'ubuntu 24.04' },
      browser: { name: 'chromium', version },
      adapter: { name: '@testivai/witness-playwright', version: '2.0.7', captureMethod: 'full-page:cdp' },
    });
    const raw = {
      version: '2.5.0',
      timestamp: '2026-10-18T10:04:00.000Z',
      summary: { total: 5, passed: 1, changed: 3, newSnapshots: 1, missing: 1 },
      missingBaselines: ['pricing'],
      environment: env('141.0.7390.37'),
      snapshots: [
        {
          name: 'home', status: 'changed', diffPercent: 12.34, diffCount: 1234, totalPixels: 10_000,
          baselinePath: 'images/home/baseline.png', currentPath: 'images/home/current.png', diffPath: 'images/home/diff.png',
          baselineApprovedAt: '2026-09-01T00:00:00.000Z',
          dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'mismatch', styleChanges: { count: 1, elements: ['.hero > h1'] } },
          regions: [{ x: 10, y: 20, width: 100, height: 40, diffPixels: 900, diffPercent: 22.5, classification: 'change', elements: [{ selector: '.hero > h1', role: 'changed' }] }],
          pageShift: { dy: -1, belowY: 120, count: 4 },
        },
        {
          name: 'products', status: 'changed', diffPercent: 7.49, diffCount: 749, totalPixels: 10_000,
          sizeMismatch: { baseline: { width: 1280, height: 2348 }, candidate: { width: 1280, height: 2538 } },
          dom: { changed: true, noiseHint: false, summary: { added: 4, removed: 0, attributeChanges: 0, textChanges: 2 } },
        },
        {
          name: 'pricing-table', status: 'changed', diffPercent: 0.62, diffCount: 62, totalPixels: 10_000,
          dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
          environment: { delta: ['browser.version'], renderingDelta: ['browser.version'], baseline: env('130.0.6723.58'), candidate: env('141.0.7390.37') },
        },
        { name: 'checkout', status: 'new', diffPercent: 0, diffCount: 0, totalPixels: 0, currentPath: 'images/checkout/current.png' },
        { name: 'footer', status: 'passed', diffPercent: 0.3, diffCount: 30, totalPixels: 10_000, dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' }, autoPassed: 'noise' },
      ],
    };
    const parsed = parseReportData(raw);
    if (!parsed.ok) throw new Error(parsed.reason);
    const asReporter = buildComment(raw as never, ZIP, UPSERT_MARKER, { runKey: '39150236166-1' });

    const action = commentFor(published({ outcome: { ok: true, summary: parsed.data.summary, data: parsed.data } }), [reporterComment('39150236166-1', { body: asReporter })], UPSERT_MARKER);

    expect(action.kind === 'update' && action.body).toBe(buildComment(raw as never, ZIP, UPSERT_MARKER, { reportUrl: URL, runKey: '39150236166-1' }));
  });

  it('matches the run by its id, whichever attempt the comment names', () => {
    const action = commentFor(published({ attempt: 2 }), [reporterComment('39150236166-1')], UPSERT_MARKER);

    expect(action).toMatchObject({ kind: 'update', id: 77 });
    expect(action.kind === 'update' && readRunKey(action.body)).toBe('39150236166-1');
  });

  it('leaves a comment about another run alone', () => {
    const action = commentFor(published(), [reporterComment('39150299999-1')], UPSERT_MARKER);

    expect(action).toEqual({ kind: 'none', why: expect.stringMatching(/describes run 39150299999/) });
  });

  it('does not take a run id that only starts with ours', () => {
    expect(commentFor(published({ runId: 3915 }), [reporterComment('39150236166-1')], UPSERT_MARKER).kind).toBe('none');
  });

  it('does not read a run id out of a key that is not "<run id>-<attempt>"', () => {
    const odd = reporterComment('x', { body: `${UPSERT_MARKER}\n<!-- testivai-run:pr-39150236166-1 -->` });

    expect(commentFor(published(), [odd], UPSERT_MARKER).kind).toBe('none');
  });

  it("leaves another lane's comment alone", () => {
    const other = reporterComment('39150236166-1', { body: buildComment(DATA as never, ZIP, '<!-- testivai-visual-report:Mobile -->', { runKey: '39150236166-1' }) });

    expect(commentFor(published(), [other], UPSERT_MARKER)).toEqual({ kind: 'none', why: expect.stringMatching(/no TestivAI comment/) });
  });

  it('leaves a comment without a run marker alone (posted by an older reporter)', () => {
    const old = reporterComment('', { body: buildComment(DATA as never, ZIP, UPSERT_MARKER) });

    expect(commentFor(published(), [old], UPSERT_MARKER).kind).toBe('none');
  });

  it('does nothing when the comment already links the report', () => {
    const done = reporterComment('39150236166-1', { body: buildComment(DATA as never, ZIP, UPSERT_MARKER, { reportUrl: URL, runKey: '39150236166-1' }) });

    expect(commentFor(published(), [done], UPSERT_MARKER)).toEqual({ kind: 'none', why: expect.stringMatching(/already links/) });
  });

  it('uses the empty-results comment for a run with no snapshots', () => {
    const empty: ReportData = { ...DATA, summary: { total: 0, passed: 0, changed: 0, newSnapshots: 0 }, snapshots: [] };
    const existing = reporterComment('39150236166-1', { body: buildEmptyComment(ZIP, UPSERT_MARKER, { runKey: '39150236166-1' }) });

    const action = commentFor(published({ outcome: { ok: true, summary: empty.summary, data: empty } }), [existing], UPSERT_MARKER);

    expect(action.kind === 'update' && action.body).toBe(buildEmptyComment(ZIP, UPSERT_MARKER, { reportUrl: URL, runKey: '39150236166-1' }));
  });

  it('leaves the comment alone when the report could not be shown', () => {
    const action = commentFor(published({ outcome: { ok: false, reason: 'The report has no results.json.' } }), [reporterComment('39150236166-1')], UPSERT_MARKER);

    expect(action).toEqual({ kind: 'none', why: expect.stringMatching(/could not be shown/) });
  });

  it('posts nothing of its own for a branch pull request without a reporter comment', () => {
    expect(commentFor(published(), [], UPSERT_MARKER).kind).toBe('none');
  });
});

describe('commentFor, a fork pull request', () => {
  const fork = (over: Partial<PublishedPr> = {}) => published({ fork: true, ...over });

  it('posts a comment of its own with the link, the run, the commit and the counts', () => {
    const action = commentFor(fork(), [], UPSERT_MARKER);

    expect(action.kind).toBe('create');
    if (action.kind !== 'create') return;
    expect(action.body).toContain(`**[Open the visual report](${URL})**`);
    expect(action.body).toContain('CI run 39150236166, attempt 1 · commit 70d8c8e');
    expect(action.body).toContain('1 changed · 1 new · 1 passed');
    expect(action.body).toContain('from a fork');
    expect(action.body).toContain(FORK_MARKER);
    expect(readRunKey(action.body)).toBe('39150236166-1');
  });

  it("puts no text from the fork's results in it", () => {
    const hostile: ReportData = {
      ...DATA,
      snapshots: [{ name: '[click me](https://evil.example) @everyone <img src=x>', status: 'changed', diffPercent: 1, diffCount: 1, totalPixels: 100 }],
    };
    const action = commentFor(fork({ outcome: { ok: true, summary: DATA.summary, data: hostile } }), [], UPSERT_MARKER);

    expect(action.kind === 'create' && action.body).not.toMatch(/evil|everyone|<img|click me/);
  });

  it('says so, without the reason, when the report could not be shown', () => {
    const action = commentFor(fork({ outcome: { ok: false, reason: '<img src=x> evil.png is 99 bytes' } }), [], UPSERT_MARKER);

    expect(action.kind).toBe('create');
    expect(action.kind === 'create' && action.body).toContain('could not be shown');
    expect(action.kind === 'create' && action.body).not.toMatch(/evil|<img/);
    expect(action.kind === 'create' && action.body).toContain(`(${URL})`);
  });

  it('updates its own earlier comment', () => {
    const earlier: ExistingComment = { id: 5, author: 'github-actions[bot]', body: `old\n${FORK_MARKER}\n<!-- testivai-run:39150200000-1 -->` };

    expect(commentFor(fork(), [earlier], UPSERT_MARKER)).toMatchObject({ kind: 'update', id: 5 });
  });

  it('never edits a comment someone else wrote, even with the marker in it', () => {
    const planted: ExistingComment = { id: 6, author: 'someone', body: `${FORK_MARKER}\n<!-- testivai-run:39150200000-1 -->` };

    expect(commentFor(fork(), [planted], UPSERT_MARKER)).toMatchObject({ kind: 'create' });
  });

  it('leaves its comment alone when it already describes a newer run', () => {
    const newer: ExistingComment = { id: 5, author: 'github-actions[bot]', body: `x\n${FORK_MARKER}\n<!-- testivai-run:39150299999-1 -->` };

    expect(commentFor(fork(), [newer], UPSERT_MARKER).kind).toBe('none');
  });

  it('does nothing when its comment is already up to date', () => {
    const first = commentFor(fork(), [], UPSERT_MARKER);
    const existing: ExistingComment = { id: 5, author: 'github-actions[bot]', body: first.kind === 'create' ? first.body : '' };

    expect(commentFor(fork(), [existing], UPSERT_MARKER).kind).toBe('none');
  });

  it('still posts its own when the only TestivAI comment has no run marker (an older reporter)', () => {
    const old = reporterComment('', { body: buildComment(DATA as never, ZIP, UPSERT_MARKER) });

    expect(commentFor(fork(), [old], UPSERT_MARKER).kind).toBe('create');
  });

  it("rebuilds the reporter's comment instead when the fork's run could comment (pull_request_target)", () => {
    expect(commentFor(fork(), [reporterComment('39150236166-1')], UPSERT_MARKER)).toMatchObject({ kind: 'update', id: 77 });
  });
});

describe('publishedThumbnails: the thumbs the comment shows', () => {
  /** A run's data as site.ts leaves it: thumbPath set only for a thumb it published, at its numbered path. */
  function withThumbs(snapshots: Array<{ name: string; status: 'changed' | 'new' | 'passed'; thumb?: boolean }>): PublishedPr {
    const data: ReportData = {
      ...DATA,
      snapshots: snapshots.map((s, i) => ({
        name: s.name,
        status: s.status,
        diffPercent: 1,
        diffCount: 1,
        totalPixels: 100,
        ...(s.thumb ? { thumbPath: `images/${i}/thumb.png` } : {}),
      })),
    };
    return published({ outcome: { ok: true, summary: data.summary, data } });
  }

  it('lists the first 5 changed snapshots with a published thumb, in results order, from the page URL and numbers only', () => {
    const p = withThumbs([
      { name: 'a', status: 'changed', thumb: true },
      { name: 'new-one', status: 'new', thumb: true },
      { name: 'b', status: 'changed' },
      { name: 'c', status: 'changed', thumb: true },
      { name: 'passed-one', status: 'passed', thumb: true },
      { name: 'd', status: 'changed', thumb: true },
      { name: 'e', status: 'changed', thumb: true },
      { name: 'f', status: 'changed', thumb: true },
      { name: 'g', status: 'changed', thumb: true },
    ]);

    expect(publishedThumbnails(p)).toEqual([
      { name: 'a', url: `${URL}images/0/thumb.png` },
      { name: 'c', url: `${URL}images/3/thumb.png` },
      { name: 'd', url: `${URL}images/5/thumb.png` },
      { name: 'e', url: `${URL}images/6/thumb.png` },
      { name: 'f', url: `${URL}images/7/thumb.png` },
    ]);
  });

  it('takes nothing from a thumbPath that is not the numbered path site.ts gives', () => {
    const p = withThumbs([{ name: 'a', status: 'changed', thumb: true }]);
    if (p.outcome.ok) p.outcome.data.snapshots[0].thumbPath = 'https://evil.example/x.png';

    expect(publishedThumbnails(p)).toEqual([]);
  });

  it('lists none for a report that could not be shown', () => {
    expect(publishedThumbnails(published({ outcome: { ok: false, reason: 'x' } }))).toEqual([]);
  });

  it("puts no image in the comment the publish posts on a fork's pull request", () => {
    const p = { ...withThumbs([{ name: 'a', status: 'changed', thumb: true }]), fork: true };

    const action = commentFor(p, [], UPSERT_MARKER);

    expect(action.kind).toBe('create');
    expect(action.kind === 'create' && action.body).not.toMatch(/<img|thumb\.png/);
  });
});
