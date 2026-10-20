/**
 * The reply to `/testivai approve`: which run's captures were approved, and,
 * when that run's report is published (publish@v1), links into it.
 *
 * The report link is never built from a guess. publish@v1 adds it to the
 * TestivAI comment only after the deploy, and only when the comment's run
 * marker names the published run, so the reply reuses that link: from a
 * github-actions[bot] comment whose marker names the approved run, pointing
 * at that run's page (`pr/<number>/<run id>-<attempt>/`). The approved run
 * is the one the artifact's run stamp names, and only when it is the run the
 * artifact was downloaded from.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { approvedRun, buildApproveReply, findReportUrl, readPendingNames, reply } from '../approve';
import { buildComment, UPSERT_MARKER } from '../comment';
import { commentFor, type PublishedPr } from '../publish/comments';
import { snapshotAnchorId } from '../../../packages/witness/src/report/anchor';

const SITE = 'https://testivai.github.io/testivai-example/';
const REPORT = `${SITE}pr/17/123-2/`;
const BOT = 'github-actions[bot]';
const HOSTILE = "x'+(globalThis.__pwned=1)+'";

const RESULTS = {
  version: '2.5.0',
  timestamp: '2026-10-18T10:00:00.000Z',
  summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
  snapshots: [{ name: 'home', status: 'changed', diffPercent: 1, diffCount: 1, totalPixels: 100 }],
};
const ARTIFACT_URL = 'https://github.com/testivai/testivai-example/actions/runs/123/artifacts/9';

/** The reporter's comment, as publish@v1 leaves it once the run's report is live. */
const reporterComment = (runKey: string, reportUrl?: string) => ({
  author: BOT,
  body: buildComment(RESULTS as never, ARTIFACT_URL, UPSERT_MARKER, { runKey, ...(reportUrl ? { reportUrl } : {}) }),
});

describe('findReportUrl', () => {
  it("takes the report link from the TestivAI comment whose run marker names the approved run", () => {
    const comments = [{ author: 'octocat', body: 'looks good' }, reporterComment('123-2', REPORT)];

    expect(findReportUrl(comments, { pr: 17, runKey: '123-2' })).toBe(REPORT);
  });

  it("takes it from publish@v1's own comment on a fork's pull request", () => {
    const published: PublishedPr = {
      pr: 17,
      fork: true,
      runId: 123,
      attempt: 2,
      headSha: 'd'.repeat(40),
      url: REPORT,
      artifactUrl: ARTIFACT_URL,
      outcome: { ok: true, summary: RESULTS.summary, data: RESULTS as never },
    };
    const action = commentFor(published, [], UPSERT_MARKER);
    if (action.kind !== 'create') throw new Error('expected a new fork comment');

    expect(findReportUrl([{ author: BOT, body: action.body }], { pr: 17, runKey: '123-2' })).toBe(REPORT);
  });

  it('finds nothing while the comment has no report link yet (publish has not run, or is off)', () => {
    expect(findReportUrl([reporterComment('123-2')], { pr: 17, runKey: '123-2' })).toBeUndefined();
  });

  it("ignores a comment about another run or another attempt", () => {
    for (const runKey of ['123-1', '124-2']) {
      const other = reporterComment(runKey, `${SITE}pr/17/${runKey}/`);
      expect(findReportUrl([other], { pr: 17, runKey: '123-2' })).toBeUndefined();
    }
  });

  it("ignores a link to the run's page in a comment whose marker names another run", () => {
    const stale = { author: BOT, body: `${UPSERT_MARKER}\n<!-- testivai-run:124-1 -->\n> **[Open the visual report](${REPORT})**` };

    expect(findReportUrl([stale], { pr: 17, runKey: '123-2' })).toBeUndefined();
  });

  it('ignores a comment by anyone but github-actions[bot], whatever it contains', () => {
    const pasted = { ...reporterComment('123-2', REPORT), author: 'someone' };

    expect(findReportUrl([pasted], { pr: 17, runKey: '123-2' })).toBeUndefined();
  });

  it("uses only a link to that run's page on this pull request, over https", () => {
    const body = (url: string) => `${UPSERT_MARKER}\n<!-- testivai-run:123-2 -->\n> **[Open the visual report](${url})**`;
    for (const url of [`${SITE}pr/18/123-2/`, `${SITE}pr/17/123-1/`, `http://testivai.github.io/testivai-example/pr/17/123-2/`, `${SITE}pr/17/123-2/evil/`, `${SITE}pr/17/123-2/?next=x`]) {
      expect(findReportUrl([{ author: BOT, body: body(url) }], { pr: 17, runKey: '123-2' })).toBeUndefined();
    }
  });

  it("takes the page from a snapshot's link when that is the only one, without its #fragment", () => {
    const body = `<!-- testivai-run:123-2 -->\n| home | changed | [open](${REPORT}#snap-home) |`;

    expect(findReportUrl([{ author: BOT, body }], { pr: 17, runKey: '123-2' })).toBe(REPORT);
  });
});

describe('approvedRun', () => {
  it("is the stamp's run and attempt when the artifact came from that run", () => {
    expect(approvedRun({ runId: '123', runAttempt: 2 }, '123')).toEqual({ id: '123', attempt: 2 });
  });

  it('is only the downloaded run, with no attempt, when the stamp names another run or there is none', () => {
    expect(approvedRun({ runId: '999', runAttempt: 1 }, '123')).toEqual({ id: '123' });
    expect(approvedRun(null, '123')).toEqual({ id: '123' });
  });

  it('is unknown without a downloaded run, or with a run id that is not a number', () => {
    expect(approvedRun({ runId: '123', runAttempt: 2 }, undefined)).toBeUndefined();
    expect(approvedRun(null, '')).toBeUndefined();
    expect(approvedRun({ runId: '12/../3', runAttempt: 2 }, '12/../3')).toBeUndefined();
  });
});

describe('buildApproveReply', () => {
  const base = { approved: ['home', 'buttons'], skipped: [] as string[], count: 2, actor: 'octocat' };
  const run = { id: '123', attempt: 2 };
  const SERVER = 'https://github.com';
  const REPO = 'testivai/testivai-example';

  it('names the approved run, links its report, and each approved snapshot in it', () => {
    const body = buildApproveReply({ ...base, run, reportUrl: REPORT, serverUrl: SERVER, repo: REPO });

    expect(body).toContain('**2 baselines approved** by @octocat from [CI run 123, attempt 2](https://github.com/testivai/testivai-example/actions/runs/123/attempts/2)');
    expect(body).toContain(`**[Open the visual report](${REPORT})**`);
    expect(body).toContain(`- \`home\` · [open in report](${REPORT}#${snapshotAnchorId('home')})`);
    expect(body).toContain(`- \`buttons\` · [open in report](${REPORT}#${snapshotAnchorId('buttons')})`);
  });

  it('names the run without a report link when the report is not published', () => {
    const body = buildApproveReply({ ...base, run, serverUrl: SERVER, repo: REPO });

    expect(body).toContain('from [CI run 123, attempt 2](');
    expect(body).not.toContain('Open the visual report');
    expect(body).toContain('- `home`\n- `buttons`');
  });

  it('links the run without an attempt when the attempt is not known', () => {
    const body = buildApproveReply({ ...base, run: { id: '123' }, serverUrl: SERVER, repo: REPO });

    expect(body).toContain('from [CI run 123](https://github.com/testivai/testivai-example/actions/runs/123)');
  });

  it('reads as before with no run: the count, the names, and how CI runs again', () => {
    const body = buildApproveReply({ ...base, skipped: ['nope'], serverUrl: SERVER, repo: REPO });

    expect(body.split('\n')[0]).toBe('**2 baselines approved** by @octocat');
    expect(body).toContain('- `home`\n- `buttons`');
    expect(body).toContain('Not found in pending baselines: `nope`');
    expect(body).toContain('With the default `GITHUB_TOKEN`, GitHub starts no run for this push');
  });

  it("links a hostile name's card by its anchor id only, never the name itself", () => {
    const body = buildApproveReply({ ...base, approved: [HOSTILE], count: 1, run, reportUrl: REPORT, serverUrl: SERVER, repo: REPO });

    expect(body).toContain(`- \`${HOSTILE}\` · [open in report](${REPORT}#${snapshotAnchorId(HOSTILE)})`);
    expect(snapshotAnchorId(HOSTILE)).toMatch(/^snap-[A-Za-z0-9_-]+$/);
  });

  it('links nothing from a report address that is not a safe https one', () => {
    for (const reportUrl of ['javascript:alert(1)//', 'http://testivai.github.io/r/', `${REPORT}") onmouseover="x`]) {
      const body = buildApproveReply({ ...base, run, reportUrl, serverUrl: SERVER, repo: REPO });
      expect(body).not.toContain('Open the visual report');
      expect(body).not.toContain('open in report');
    }
  });

  it('still explains why when nothing was approved, with no links', () => {
    const body = buildApproveReply({ ...base, approved: [], count: 0, run, reportUrl: REPORT, serverUrl: SERVER, repo: REPO });

    expect(body).toContain('No baselines were updated.');
    expect(body).not.toContain(REPORT);
  });
});

describe('reply (the github-script step)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-reply-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function fakeGithub(pages: Array<Array<{ user: { login: string } | null; body?: string }>> | Error) {
    const posted: string[] = [];
    const listed: number[] = [];
    const github = {
      rest: {
        issues: {
          listComments: async ({ page }: { page: number }) => {
            listed.push(page);
            if (pages instanceof Error) throw pages;
            return { data: pages[page - 1] ?? [] };
          },
          createComment: async ({ body }: { body: string }) => void posted.push(body),
        },
      },
    };
    return { github, posted, listed };
  }
  const context = { repo: { owner: 'testivai', repo: 'testivai-example' }, issue: { number: 17 }, serverUrl: 'https://github.com' };
  const log = () => ({ info: jest.fn(), warning: jest.fn() });
  const stamp = (runId: string, runAttempt: number) => fs.writeFileSync(path.join(dir, 'testivai-run.json'), JSON.stringify({ runId, runAttempt }));
  const env = (over: Record<string, string> = {}) => ({ APPROVED: 'home', SKIPPED: '', COUNT: '1', ACTOR: 'octocat', RUN_ID: '123', ARTIFACT_DIR: dir, ...over });
  const botComment = (runKey: string, url?: string) => ({ user: { login: BOT }, body: reporterComment(runKey, url).body });

  it('posts the reply with the report link of the run the artifact came from', async () => {
    stamp('123', 2);
    const { github, posted } = fakeGithub([[botComment('123-2', REPORT)]]);

    await reply({ github, context, core: log(), env: env() });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`**[Open the visual report](${REPORT})**`);
    expect(posted[0]).toContain('from [CI run 123, attempt 2](https://github.com/testivai/testivai-example/actions/runs/123/attempts/2)');
  });

  it('reads past the first page of comments', async () => {
    stamp('123', 2);
    const filler = Array.from({ length: 100 }, () => ({ user: { login: 'octocat' }, body: 'lgtm' }));
    const { github, posted, listed } = fakeGithub([filler, [botComment('123-2', REPORT)]]);

    await reply({ github, context, core: log(), env: env() });

    expect(listed).toEqual([1, 2]);
    expect(posted[0]).toContain(REPORT);
  });

  it('still replies, without the link, when the comments cannot be read', async () => {
    stamp('123', 2);
    const { github, posted } = fakeGithub(Object.assign(new Error('Resource not accessible by integration'), { status: 403 }));
    const core = log();

    await reply({ github, context, core, env: env() });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('**1 baseline approved** by @octocat');
    expect(posted[0]).not.toContain('Open the visual report');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Resource not accessible'));
  });

  it('links no report when the stamp names another run than the one downloaded', async () => {
    stamp('999', 1);
    const { github, posted, listed } = fakeGithub([[botComment('999-1', `${SITE}pr/17/999-1/`)]]);

    await reply({ github, context, core: log(), env: env() });

    expect(listed).toEqual([]);
    expect(posted[0]).toContain('from [CI run 123](https://github.com/testivai/testivai-example/actions/runs/123)');
    expect(posted[0]).not.toContain('Open the visual report');
  });

  it('looks nothing up when nothing was approved', async () => {
    stamp('123', 2);
    const { github, posted, listed } = fakeGithub([[botComment('123-2', REPORT)]]);

    await reply({ github, context, core: log(), env: env({ APPROVED: '', SKIPPED: 'nope', COUNT: '0' }) });

    expect(listed).toEqual([]);
    expect(posted[0]).toContain('No baselines were updated.');
  });
});

/**
 * When nothing matched (testivai/testivai-site#26: `-all` was looked up as a
 * snapshot), the reply names what did not match and lists what could be
 * approved from the run, instead of only generic reasons.
 */
describe('buildApproveReply when the named snapshots match nothing pending', () => {
  const SERVER = 'https://github.com';
  const REPO = 'testivai/testivai-example';
  const none = { approved: [] as string[], count: 0, actor: 'octocat', serverUrl: SERVER, repo: REPO };

  it('names the unmatched snapshot and lists the pending ones from the run', () => {
    const body = buildApproveReply({ ...none, skipped: ['-all'], pending: ['home', 'home-mobile'], run: { id: '123', attempt: 2 } });

    expect(body.split('\n')[0]).toBe('No baselines were updated: no pending snapshot is named `-all`.');
    expect(body).toContain('Pending snapshots in [CI run 123, attempt 2](https://github.com/testivai/testivai-example/actions/runs/123/attempts/2): `home`, `home-mobile`');
    expect(body).toContain('`/testivai approve <name> [<name> …]`');
    expect(body).toContain('`/testivai approve --all`');
    expect(body).not.toContain('Possible reasons');
  });

  it('names every unmatched snapshot when there are several', () => {
    const body = buildApproveReply({ ...none, skipped: ['homepage', 'checkout'], pending: ['home'] });

    expect(body.split('\n')[0]).toBe('No baselines were updated: no pending snapshot is named `homepage` or `checkout`.');
    expect(body).toContain('Pending snapshots in the run: `home`');
  });

  it('says when the run has no pending snapshot at all', () => {
    const body = buildApproveReply({ ...none, skipped: ['home'], pending: [] });

    expect(body).toContain('no pending snapshot is named `home`');
    expect(body).toContain('The run has no pending snapshots');
    expect(body).not.toContain('/testivai approve --all');
  });

  it('says when --all found nothing to approve', () => {
    const body = buildApproveReply({ ...none, skipped: [], pending: [], run: { id: '123' } });

    expect(body.split('\n')[0]).toBe('No baselines were updated: [CI run 123](https://github.com/testivai/testivai-example/actions/runs/123) has no pending snapshots.');
  });

  it('cuts a long pending list and says how many more there are', () => {
    const pending = Array.from({ length: 60 }, (_, i) => `snap-${i}`);
    const body = buildApproveReply({ ...none, skipped: ['nope'], pending });

    expect(body).toContain('`snap-49`');
    expect(body).not.toContain('`snap-50`');
    expect(body).toContain('and 10 more');
  });

  it('prints names as code that a backtick or a line break cannot break out of', () => {
    const body = buildApproveReply({ ...none, skipped: ['a`b'], pending: ['x\n\n# heading', HOSTILE] });

    expect(body).toContain('no pending snapshot is named ``a`b``');
    expect(body).not.toMatch(/^# heading/m);
    expect(body).toContain(`\`${HOSTILE}\``);
  });

  it('keeps the generic reasons when the pending snapshots could not be read', () => {
    const body = buildApproveReply({ ...none, skipped: ['nope'] });

    expect(body).toContain('No baselines were updated.');
    expect(body).toContain('Possible reasons');
    expect(body).toContain('Not found in pending baselines: `nope`');
  });
});

describe('readPendingNames', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-pending-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lists the report's pending snapshot directories, sorted, and nothing else", () => {
    const pending = path.join(dir, 'pending-baselines');
    for (const name of ['home-mobile', 'home']) fs.mkdirSync(path.join(pending, name), { recursive: true });
    fs.writeFileSync(path.join(pending, 'stray.txt'), '');
    fs.mkdirSync(path.join(dir, 'secret'));
    fs.symlinkSync(path.join(dir, 'secret'), path.join(pending, 'link'));

    expect(readPendingNames(dir)).toEqual(['home', 'home-mobile']);
  });

  it('is unknown when the artifact has no pending-baselines', () => {
    expect(readPendingNames(dir)).toBeUndefined();
    expect(readPendingNames(path.join(dir, 'missing'))).toBeUndefined();
  });
});

describe('reply when nothing matched', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-nomatch-'));
    for (const name of ['home', 'home-mobile']) fs.mkdirSync(path.join(dir, 'pending-baselines', name), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists the pending snapshots of the downloaded report', async () => {
    const posted: string[] = [];
    const github = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async ({ body }: { body: string }) => void posted.push(body),
        },
      },
    };
    const context = { repo: { owner: 'testivai', repo: 'testivai-example' }, issue: { number: 17 }, serverUrl: 'https://github.com' };

    await reply({ github, context, core: { info: jest.fn(), warning: jest.fn() }, env: { APPROVED: '', SKIPPED: 'nope', COUNT: '0', ACTOR: 'octocat', RUN_ID: '123', ARTIFACT_DIR: dir } });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('no pending snapshot is named `nope`');
    expect(posted[0]).toContain('Pending snapshots in [CI run 123](https://github.com/testivai/testivai-example/actions/runs/123): `home`, `home-mobile`');
  });
});
