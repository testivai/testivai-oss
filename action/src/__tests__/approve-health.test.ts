/**
 * The approve action's reply says when it approved an unhealthy capture
 * (a web font or stylesheet that failed to load): every compare against that
 * baseline will read "Unhealthy capture" until it is replaced from a healthy
 * run. The health comes from the approved capture's own metadata.json in the
 * downloaded artifact (pending-baselines/<name>/), checked like any other
 * untrusted input.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildApproveReply, readApprovedHealth, reply } from '../approve';

const HEALTHY = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};
const FONT_FAILED = { ...HEALTHY, fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: 'normal', style: 'normal' }] } };

const LINE =
  "> **`home` was approved from an unhealthy capture** — web font 'Fancy' failed to load, so the page rendered with a fallback font. " +
  'Every compare against it will say so: fix the page, the server or the test, re-run and approve a healthy capture.';

describe('buildApproveReply with unhealthy captures', () => {
  const base = { approved: ['home', 'pricing'], skipped: [], count: 2, actor: 'octocat', serverUrl: 'https://github.com', repo: 'testivai/x' };

  it('says which approved captures were unhealthy, and why', () => {
    const body = buildApproveReply({ ...base, unhealthy: [{ name: 'home', reasons: ["web font 'Fancy' failed to load, so the page rendered with a fallback font"] }] });
    expect(body).toContain(LINE);
  });

  it('reads as before when none was', () => {
    expect(buildApproveReply({ ...base, unhealthy: [] })).toBe(buildApproveReply(base));
  });
});

describe('readApprovedHealth', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-health-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const capture = (name: string, meta: unknown) => {
    fs.mkdirSync(path.join(dir, 'pending-baselines', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pending-baselines', name, 'metadata.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
  };

  it('the unhealthy ones among the approved captures, with their reasons', () => {
    capture('home', { name: 'home', health: FONT_FAILED });
    capture('pricing', { name: 'pricing', health: HEALTHY });
    capture('legacy', { name: 'legacy' });
    expect(readApprovedHealth(dir, ['home', 'pricing', 'legacy', 'gone'])).toEqual([
      { name: 'home', reasons: ["web font 'Fancy' failed to load, so the page rendered with a fallback font"] },
    ]);
  });

  it('ignores malformed metadata and names that would leave pending-baselines', () => {
    capture('home', '{not json');
    fs.mkdirSync(path.join(dir, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outside', 'metadata.json'), JSON.stringify({ health: FONT_FAILED }));
    expect(readApprovedHealth(dir, ['home', '../outside', '..', '.'])).toEqual([]);
  });

  it('reply posts the warning for an unhealthy approved capture', async () => {
    capture('home', { name: 'home', health: FONT_FAILED });
    const posted: string[] = [];
    const github = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async ({ body }: { body: string }) => void posted.push(body),
        },
      },
    };
    await reply({
      github,
      context: { repo: { owner: 'testivai', repo: 'x' }, issue: { number: 1 }, serverUrl: 'https://github.com' },
      core: { info: jest.fn(), warning: jest.fn() },
      env: { APPROVED: 'home', SKIPPED: '', COUNT: '1', ACTOR: 'octocat', RUN_ID: '123', ARTIFACT_DIR: dir },
    });
    expect(posted[0]).toContain(LINE);
  });
});
