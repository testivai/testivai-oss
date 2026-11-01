/**
 * Every run says something about itself on the pull request, whatever the
 * tests did (index.ts, missing-report.ts).
 *
 * - results.json present: unchanged. The comment, the check run, the commit
 *   status and the step come from it, as before; the tests' own pass or fail
 *   is the test step's to report, not this action's.
 * - results.json missing, captures in .testivai/temp/: the compare step did
 *   not run (a CI step runs only on success by default, so one failing test
 *   skipped it). The action compares the captures itself, with the project's
 *   .testivai/config.json and committed baselines, and posts the full report,
 *   saying it compared them.
 * - results.json missing and nothing to compare (no captures, one shard's
 *   slice, or a comparison that fails): the comment, the job summary, the
 *   check run and the commit status say there is no visual report for this
 *   run, why that may be and what to do, replacing an earlier run's result,
 *   and the step fails.
 *
 * Seen on an Expo app's CI: one Chromium capture error in a non-visual test
 * skipped the compare step on `main`, so the run published no report.
 *
 * index.ts runs its action when it is loaded, so each test loads it afresh
 * (jest.isolateModules) and lets its promise chain settle. The GitHub API
 * and the artifact upload are stubbed; the comparison is the real witness
 * code, on real PNG files in a project on disk.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildComment, UPSERT_MARKER } from '../comment';
import { summaryFromComment } from '../job-summary';
import { comparedByActionNotice } from '../missing-report';
import { determineStatus } from '../status';
import type { ResultsData } from '../types';

interface MockState {
  inputs: Record<string, string>;
  context: { eventName: string; payload: Record<string, any>; repo: { owner: string; repo: string }; sha: string };
  comments: Array<{ id: number; body: string }>;
  /** Reject checks.create, as a token without `checks: write` does. */
  failCheck: boolean;
}

const mockEvents: Array<{ kind: string; value?: string; args?: any }> = [];
const mockState: MockState = {
  inputs: {},
  context: { eventName: 'push', payload: {}, repo: { owner: 'acme', repo: 'storefront' }, sha: 'a'.repeat(40) },
  comments: [],
  failCheck: false,
};

jest.mock('@actions/core', () => {
  const record = (kind: string) => (value?: unknown) => {
    mockEvents.push({ kind, value: value === undefined ? undefined : String(value) });
  };
  interface SummaryStub {
    addRaw(text: string): SummaryStub;
    write(): Promise<SummaryStub>;
  }
  const summary: SummaryStub = {
    addRaw(text: string) {
      mockEvents.push({ kind: 'summary.addRaw', value: text });
      return summary;
    },
    async write() {
      mockEvents.push({ kind: 'summary.write' });
      return summary;
    },
  };
  return {
    getInput: (name: string) => mockState.inputs[name] ?? '',
    getBooleanInput: (name: string) => (mockState.inputs[name] ?? 'false') === 'true',
    info: record('info'),
    notice: record('notice'),
    warning: record('warning'),
    error: record('error'),
    setFailed: record('setFailed'),
    setOutput: (name: string, value: string) => mockEvents.push({ kind: 'output', value: `${name}=${value}` }),
    summary,
  };
}, { virtual: true });

jest.mock('@actions/github', () => ({
  get context() {
    return mockState.context;
  },
  getOctokit: () => ({
    rest: {
      issues: {
        listComments: async () => {
          mockEvents.push({ kind: 'comment.list' });
          return { data: mockState.comments };
        },
        createComment: async ({ body }: { body: string }) => {
          mockEvents.push({ kind: 'comment.create', value: body });
          return { data: {} };
        },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
          mockEvents.push({ kind: 'comment.update', value: body, args: { comment_id } });
          return { data: {} };
        },
      },
      checks: {
        create: async (args: any) => {
          mockEvents.push({ kind: 'check', args });
          if (mockState.failCheck) throw new Error('Resource not accessible by integration');
          return { data: {} };
        },
      },
      repos: {
        createCommitStatus: async (args: any) => {
          mockEvents.push({ kind: 'status', args });
          return { data: {} };
        },
      },
    },
  }),
}));

jest.mock('@actions/artifact', () => ({ DefaultArtifactClient: class {} }), { virtual: true });

jest.mock('../report-artifact', () => ({
  writeRunStamp: () => {},
  uploadReport: async ({ files, rootDir }: { files: string[]; rootDir: string }) => {
    mockEvents.push({ kind: 'upload', args: { files: files.map((f) => path.relative(rootDir, f)).sort() } });
    return { id: 4402 };
  },
}));

/** 4×4 PNGs: all white, and all black (every pixel differs from white). */
const WHITE =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGUlEQVR4AWP8DwQMSICJAQ0wMaABJgY0AAAGXQQEOHaWpAAAAABJRU5ErkJggg==';
const BLACK =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGklEQVR4AWNkYGD4z4AEmBjQABMDGmBiQAMAQRQBB4xFJUEAAAAASUVORK5CYII=';

const RUN_ID = '41264760111';
const HEAD = 'b'.repeat(40);
const PR = {
  eventName: 'pull_request',
  payload: { pull_request: { number: 12, head: { sha: HEAD } } },
  repo: { owner: 'acme', repo: 'storefront' },
  sha: 'a'.repeat(40),
};
const PUSH = { eventName: 'push', payload: {}, repo: { owner: 'acme', repo: 'storefront' }, sha: 'a'.repeat(40) };
/** The earlier run's comment, still standing on the pull request. */
const EARLIER = `${UPSERT_MARKER}\n<!-- testivai-run:40000000000-1 -->\n\n### TestivAI Visual Report\n\n**22 passed** | **0 changed** | **0 new** — **22 total**\n`;

let project: string;
let reportDir: string;
const savedCwd = process.cwd();
const savedEnv = { ...process.env };

beforeEach(() => {
  mockEvents.length = 0;
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-missing-results-'));
  // The action reads .testivai/ from the working directory, as on a runner.
  process.chdir(project);
  reportDir = path.join(project, 'visual-report');
  process.env.GITHUB_RUN_ID = RUN_ID;
  process.env.GITHUB_RUN_ATTEMPT = '1';
  mockState.inputs = {
    'github-token': 'unused',
    'report-dir': reportDir,
    'fail-on-diff': 'false',
    'upload-artifact': 'true',
    'artifact-retention-days': '30',
  };
  mockState.context = PR;
  mockState.comments = [];
  mockState.failCheck = false;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  process.chdir(savedCwd);
  fs.rmSync(project, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function writeSnapshot(dir: string, png: string, dom = '<html><body><p>page</p></body></html>'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'screenshot.png'), Buffer.from(png, 'base64'));
  fs.writeFileSync(path.join(dir, 'dom.html'), dom);
}
const baseline = (name: string, png = WHITE) => writeSnapshot(path.join(project, '.testivai', 'baselines', name), png);
const capture = (name: string, png = WHITE) => writeSnapshot(path.join(project, '.testivai', 'temp', name), png);
function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(project, '.testivai'), { recursive: true });
  fs.writeFileSync(path.join(project, '.testivai', 'config.json'), JSON.stringify(config));
}
function writeResults(results: ResultsData): void {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify(results));
}
const readResults = (): ResultsData => JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8'));

async function runReporter(): Promise<void> {
  jest.isolateModules(() => {
    require('../index');
  });
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

const kinds = (...wanted: string[]) => mockEvents.filter((e) => wanted.includes(e.kind)).map((e) => e.kind);
const values = (kind: string) => mockEvents.filter((e) => e.kind === kind).map((e) => e.value as string);
const postedComment = () => mockEvents.find((e) => e.kind === 'comment.create' || e.kind === 'comment.update')?.value as string;
const check = () => mockEvents.find((e) => e.kind === 'check')?.args;
const status = () => mockEvents.find((e) => e.kind === 'status')?.args;
const ZIP = `https://github.com/acme/storefront/actions/runs/${RUN_ID}/artifacts/4402`;

describe('results.json present: nothing changes', () => {
  const ALL_PASSED: ResultsData = {
    timestamp: 0,
    summary: { total: 2, passed: 2, changed: 0, newSnapshots: 0, missing: 0 },
    snapshots: [
      { name: 'home', status: 'passed', diffPercent: 0 },
      { name: 'pricing', status: 'passed', diffPercent: 0 },
    ],
  };

  it('tests failed but the visuals passed: success check and status, the step passes (the test step fails the job)', async () => {
    writeResults(ALL_PASSED);

    await runReporter();

    expect(postedComment()).toBe(buildComment(ALL_PASSED, ZIP, UPSERT_MARKER, { runKey: `${RUN_ID}-1` }));
    expect(check()).toMatchObject({ head_sha: HEAD, conclusion: 'success', output: { title: 'All 2 snapshots passed' } });
    expect(status()).toMatchObject({ sha: HEAD, state: 'success', description: 'All 2 snapshots passed' });
    expect(kinds('setFailed')).toEqual([]);
  });

  it('never compares again, even with captures in .testivai/temp/ that would read differently', async () => {
    writeResults(ALL_PASSED);
    baseline('home');
    capture('home', BLACK);
    const before = fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8');

    await runReporter();

    expect(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(reportDir, 'index.html'))).toBe(false);
    expect(postedComment()).toBe(buildComment(ALL_PASSED, ZIP, UPSERT_MARKER, { runKey: `${RUN_ID}-1` }));
    expect(postedComment()).not.toContain('Compared by the TestivAI action');
    // The captures are still bundled for /testivai approve, as before.
    expect(fs.existsSync(path.join(reportDir, 'pending-baselines', 'home', 'screenshot.png'))).toBe(true);
  });

  it('a changed result keeps its neutral check, success status and passing step', async () => {
    const changed: ResultsData = {
      timestamp: 0,
      summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
      snapshots: [{ name: 'home', status: 'changed', diffPercent: 3 }],
    };
    writeResults(changed);

    await runReporter();

    const expected = determineStatus(changed, { failOnDiff: false });
    expect(check()).toMatchObject({ conclusion: 'neutral', output: { title: expected.title } });
    expect(status()).toMatchObject({ state: 'success', description: expected.description });
    expect(kinds('setFailed')).toEqual([]);
  });
});

describe('results.json missing, captures in .testivai/temp/: the action compares them', () => {
  it('posts the full report from the captures and the committed baselines, saying the action compared them', async () => {
    baseline('home');
    baseline('pricing');
    capture('home');
    capture('pricing');

    await runReporter();

    const results = readResults();
    expect(results.summary).toMatchObject({ total: 2, passed: 2, changed: 0, newSnapshots: 0, missing: 0 });
    expect(fs.existsSync(path.join(reportDir, 'index.html'))).toBe(true);

    const body = postedComment();
    expect(body).toContain(UPSERT_MARKER);
    expect(body).toContain(`<!-- testivai-run:${RUN_ID}-1 -->`);
    expect(body).toContain('**2 passed** | **0 changed** | **0 new** — **2 total**');
    expect(body).toContain('Compared by the TestivAI action');
    expect(body).toMatch(/no `results\.json`/);
    expect(body).toContain('2 captures in `.testivai/temp/`');
    expect(body).toContain('if: ${{ !cancelled() }}');
    expect(body).toContain(ZIP);

    expect(check()).toMatchObject({ head_sha: HEAD, conclusion: 'success', output: { title: 'All 2 snapshots passed' } });
    expect(status()).toMatchObject({ sha: HEAD, state: 'success', description: 'All 2 snapshots passed' });
    expect(kinds('setFailed')).toEqual([]);
  });

  it('the comment is buildComment of the comparison with the notice added; the job summary is the comment', async () => {
    baseline('home');
    capture('home');

    await runReporter();

    const body = postedComment();
    const plain = buildComment(readResults(), ZIP, UPSERT_MARKER, { runKey: `${RUN_ID}-1` });
    const summaryLine = '**1 passed** | **0 changed** | **0 new** — **1 total**\n\n';
    expect(plain).toContain(summaryLine);
    expect(body).toBe(plain.replace(summaryLine, `${summaryLine}${comparedByActionNotice(1)}`));
    expect(values('summary.addRaw')).toEqual([summaryFromComment(body)]);
  });

  it('uploads the report it wrote, with the captures bundled for /testivai approve', async () => {
    baseline('home');
    capture('home', BLACK);

    await runReporter();

    const files: string[] = mockEvents.find((e) => e.kind === 'upload')?.args.files;
    expect(files).toEqual(expect.arrayContaining([
      'results.json',
      'index.html',
      'images/home/diff.png',
      'pending-baselines/home/screenshot.png',
    ]));
    expect(values('output')).toEqual(['artifact-id=4402']);
  });

  it('a changed capture: the snapshot shows as changed, the check is neutral and the step passes', async () => {
    baseline('home');
    capture('home', BLACK);

    await runReporter();

    expect(readResults().snapshots[0]).toMatchObject({ name: 'home', status: 'changed' });
    expect(postedComment()).toContain('**0 passed** | **1 changed** | **0 new** — **1 total**');
    expect(postedComment()).toContain('/testivai approve home');
    expect(check()).toMatchObject({ conclusion: 'neutral' });
    expect(status()).toMatchObject({ state: 'success' });
    expect(kinds('setFailed')).toEqual([]);
  });

  it('a changed capture with fail-on-diff: failure check and status, and the step fails', async () => {
    baseline('home');
    capture('home', BLACK);
    mockState.inputs['fail-on-diff'] = 'true';

    await runReporter();

    expect(check()).toMatchObject({ conclusion: 'failure' });
    expect(status()).toMatchObject({ state: 'failure', description: '1 snapshot changed' });
    expect(values('setFailed')).toEqual(['1 snapshot changed']);
  });

  it('uses the project\'s .testivai/config.json: its pass criteria and its baselines directory', async () => {
    writeConfig({ maxDiffPercent: 100, baselinesDir: 'visual-baselines' });
    writeSnapshot(path.join(project, 'visual-baselines', 'home'), WHITE);
    capture('home', BLACK);

    await runReporter();

    expect(readResults().snapshots[0]).toMatchObject({ name: 'home', status: 'passed', autoPassed: 'threshold' });
    expect(check()).toMatchObject({ conclusion: 'success' });
  });

  it('a test that failed before its capture: its baseline is listed as receiving no capture', async () => {
    baseline('home');
    baseline('checkout');
    capture('home');

    await runReporter();

    expect(readResults()).toMatchObject({ missingBaselines: ['checkout'], summary: { missing: 1 } });
    expect(postedComment()).toContain('**1 baseline received no capture this run** — `checkout`');
    expect(check()).toMatchObject({ conclusion: 'neutral' });
    expect(kinds('setFailed')).toEqual([]);
  });

  it('a corrupt capture is compared as witness compares it (changed), not hidden', async () => {
    baseline('home');
    fs.mkdirSync(path.join(project, '.testivai', 'temp', 'home'), { recursive: true });
    fs.writeFileSync(path.join(project, '.testivai', 'temp', 'home', 'screenshot.png'), 'not a png');

    await runReporter();

    expect(readResults().snapshots[0]).toMatchObject({ name: 'home', status: 'changed' });
    expect(check()).toMatchObject({ conclusion: 'neutral' });
  });

  it('a capture without a baseline is new', async () => {
    capture('signup');

    await runReporter();

    expect(readResults().snapshots[0]).toMatchObject({ name: 'signup', status: 'new' });
    expect(postedComment()).toContain('#### New Snapshots');
  });

  it('replaces the earlier run\'s comment', async () => {
    baseline('home');
    capture('home', BLACK);
    mockState.comments = [{ id: 7, body: EARLIER }];

    await runReporter();

    expect(kinds('comment.create')).toEqual([]);
    const update = mockEvents.find((e) => e.kind === 'comment.update');
    expect(update?.args).toEqual({ comment_id: 7 });
    expect(update?.value).not.toContain('22 passed');
  });

  it('a report-dir that does not exist yet is created', async () => {
    mockState.inputs['report-dir'] = path.join(project, 'out', 'visual');
    reportDir = path.join(project, 'out', 'visual');
    baseline('home');
    capture('home');

    await runReporter();

    expect(readResults().summary.total).toBe(1);
    expect(kinds('setFailed')).toEqual([]);
  });
});

describe('results.json missing and nothing to compare: the run says there is no visual report', () => {
  function expectNoReport(body: string) {
    expect(body).toContain(UPSERT_MARKER);
    expect(body).toContain(`<!-- testivai-run:${RUN_ID}-1 -->`);
    expect(body).toContain('### TestivAI Visual Report');
    expect(body).toContain('No visual report for this run');
    expect(body).toContain(`\`${path.join(reportDir, 'results.json')}\``);
    expect(body).toContain('if: ${{ !cancelled() }}');
    // Never an earlier run's numbers, and never a number of its own.
    expect(body).not.toMatch(/\*\*\d+ passed\*\*/);
    expect(body).not.toContain('/artifacts/');
  }

  it('no captures: the comment says what is missing, the likely causes and what to do', async () => {
    await runReporter();

    const body = postedComment();
    expectNoReport(body);
    expect(body).toContain('no captures in `.testivai/temp/`');
    expect(body).toMatch(/tests failed or crashed before/i);
    expect(body).toMatch(/compare step/i);
    expect(body).toContain(HEAD.slice(0, 7));
  });

  it('no captures: the check run fails, the commit status is error, and the step fails once', async () => {
    await runReporter();

    expect(kinds('summary.write', 'comment.create', 'check', 'status', 'setFailed')).toEqual([
      'summary.write', 'comment.create', 'check', 'status', 'setFailed',
    ]);
    expect(check()).toMatchObject({
      head_sha: HEAD,
      name: 'TestivAI / visual',
      status: 'completed',
      conclusion: 'failure',
      output: { title: 'No visual report for this run' },
    });
    expect(check().output.summary).toContain('results.json');
    expect(status()).toMatchObject({ sha: HEAD, context: 'TestivAI / visual', state: 'error' });
    expect(status().description.length).toBeLessThanOrEqual(140);
    expect(status().description).toMatch(/no visual report/i);
    const failures = values('setFailed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('results.json');
    // Nothing to upload, and the action wrote no report.
    expect(kinds('upload', 'output')).toEqual([]);
    expect(fs.existsSync(path.join(reportDir, 'results.json'))).toBe(false);
  });

  it('replaces the earlier run\'s "22 passed" comment instead of leaving it standing', async () => {
    mockState.comments = [{ id: 7, body: EARLIER }];

    await runReporter();

    expect(kinds('comment.create')).toEqual([]);
    const update = mockEvents.find((e) => e.kind === 'comment.update');
    expect(update?.args).toEqual({ comment_id: 7 });
    expectNoReport(update?.value as string);
    expect(update?.value).not.toContain('22 passed');
  });

  it('the job summary is the comment', async () => {
    await runReporter();

    expect(values('summary.addRaw')).toEqual([summaryFromComment(postedComment())]);
    expect(values('summary.addRaw')[0]).toContain('No visual report for this run');
    expect(values('summary.addRaw')[0]).not.toContain('<!-- testivai');
  });

  it('on a push: the job summary, the check run and the commit status, no comment; the step fails', async () => {
    mockState.context = PUSH;

    await runReporter();

    expect(kinds('comment.list', 'comment.create', 'comment.update')).toEqual([]);
    expect(kinds('summary.write', 'check', 'status', 'setFailed')).toEqual(['summary.write', 'check', 'status', 'setFailed']);
    expect(check()).toMatchObject({ head_sha: 'a'.repeat(40), conclusion: 'failure' });
    expect(status()).toMatchObject({ sha: 'a'.repeat(40), state: 'error' });
  });

  it('a custom status-context names the check and the status, and namespaces the comment', async () => {
    mockState.inputs['status-context'] = 'Visual / mobile';

    await runReporter();

    expect(check()).toMatchObject({ name: 'Visual / mobile' });
    expect(status()).toMatchObject({ context: 'Visual / mobile' });
    expect(postedComment()).toContain('<!-- testivai-visual-report:Visual / mobile -->');
  });

  it('a token without `checks: write`: the commit status still says it, and the step fails once', async () => {
    mockState.failCheck = true;

    await runReporter();

    expect(status()).toMatchObject({ state: 'error' });
    expect(values('warning').some((w) => w.includes('checks: write'))).toBe(true);
    expect(values('setFailed')).toHaveLength(1);
  });

  it('an empty .testivai/temp/, or one with folders but no screenshot.png, has no captures', async () => {
    fs.mkdirSync(path.join(project, '.testivai', 'temp', 'half-written'), { recursive: true });
    fs.writeFileSync(path.join(project, '.testivai', 'temp', 'half-written', 'dom.html'), '<p>');
    baseline('home');

    await runReporter();

    expectNoReport(postedComment());
    expect(postedComment()).toContain('no captures in `.testivai/temp/`');
    expect(fs.existsSync(path.join(reportDir, 'results.json'))).toBe(false);
  });

  it('one shard\'s captures are not compared alone: every other shard\'s baseline would read as missing', async () => {
    baseline('home');
    baseline('checkout');
    capture('home');
    fs.writeFileSync(
      path.join(project, '.testivai', 'temp', 'testivai-shard.json'),
      JSON.stringify({ shard: { current: 2, total: 3 }, captures: ['home'], complete: true, status: 'failed' }),
    );

    await runReporter();

    const body = postedComment();
    expectNoReport(body);
    expect(body).toContain('shard 2 of 3');
    expect(body).toContain('merge-captures');
    expect(body).toMatch(/needs/);
    expect(fs.existsSync(path.join(reportDir, 'results.json'))).toBe(false);
    expect(check()).toMatchObject({ conclusion: 'failure' });
    expect(status()).toMatchObject({ state: 'error' });
    expect(values('setFailed')).toHaveLength(1);
  });

  it('a merge that lacks a shard is not compared: merge-captures failed it, and it is part of the suite', async () => {
    baseline('home');
    baseline('checkout');
    capture('home');
    fs.writeFileSync(
      path.join(project, '.testivai', 'temp', 'testivai-merge.json'),
      JSON.stringify({ shardTotal: 8, shardsSeen: [1, 2, 3, 5, 6, 8], shardsMissing: [4, 7], merged: 1 }),
    );

    await runReporter();

    const body = postedComment();
    expectNoReport(body);
    expect(body).toContain('6 of 8 shards');
    expect(body).toContain('missing: 4, 7');
    expect(body).toContain('if: ${{ !cancelled() }}');
    expect(fs.existsSync(path.join(reportDir, 'results.json'))).toBe(false);
    expect(check()).toMatchObject({ conclusion: 'failure' });
    expect(status()).toMatchObject({ state: 'error' });
    expect(status().description.length).toBeLessThanOrEqual(140);
    expect(values('setFailed')).toHaveLength(1);
    expect(values('setFailed')[0]).toContain('4, 7');
  });

  it('a complete merge is compared', async () => {
    baseline('home');
    capture('home');
    fs.writeFileSync(
      path.join(project, '.testivai', 'temp', 'testivai-merge.json'),
      JSON.stringify({ shardTotal: 2, shardsSeen: [1, 2], shardsMissing: [], merged: 1 }),
    );

    await runReporter();

    expect(readResults().summary.total).toBe(1);
    expect(postedComment()).toContain('Compared by the TestivAI action');
    expect(kinds('setFailed')).toEqual([]);
  });

  it('a single shard of one is the whole suite, so it is compared', async () => {
    baseline('home');
    capture('home');
    fs.writeFileSync(
      path.join(project, '.testivai', 'temp', 'testivai-shard.json'),
      JSON.stringify({ shard: { current: 1, total: 1 }, captures: ['home'], complete: true }),
    );

    await runReporter();

    expect(readResults().summary.total).toBe(1);
    expect(postedComment()).toContain('Compared by the TestivAI action');
    expect(kinds('setFailed')).toEqual([]);
  });

  it('captures the action cannot compare: says so with the error, and the step fails', async () => {
    baseline('home');
    // A screenshot.png that cannot be read (here a folder: EISDIR). A corrupt
    // PNG is not this case: witness compares its bytes and reports it changed.
    fs.mkdirSync(path.join(project, '.testivai', 'temp', 'home', 'screenshot.png'), { recursive: true });

    await runReporter();

    const body = postedComment();
    expectNoReport(body);
    expect(body).toContain('1 capture in `.testivai/temp/`');
    expect(body).toMatch(/could not compare/i);
    expect(check()).toMatchObject({ conclusion: 'failure' });
    expect(status()).toMatchObject({ state: 'error' });
    const failures = values('setFailed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/could not compare/i);
  });

  it('an error message with markdown or HTML cannot break out of the comment', async () => {
    const { buildNoReportComment } = require('../missing-report') as typeof import('../missing-report');
    const body = buildNoReportComment(
      { kind: 'compare-failed', captures: 1, error: 'bad `tick`\n<img src=x onerror=alert(1)>\n\n#### Heading' },
      { resultsPath: 'visual-report/results.json', sha: HEAD, marker: UPSERT_MARKER },
    );
    expect(body).not.toMatch(/^#### Heading/m);
    const line = body.split('\n').find((l) => l.includes('<img')) as string;
    const code = /`([^`]*<img[^`]*)`/.exec(line)?.[1] ?? '';
    expect(code).toContain('#### Heading');
  });
});
