/**
 * When the report artifact cannot be uploaded (index.ts): the visual result
 * still shows. The PR comment, the job summary, the check run and the commit
 * status are still posted from results.json; the comment says the upload
 * failed, with the error, has no ZIP link, and says `/testivai approve` needs
 * that artifact; and the step then fails with the upload error.
 *
 * Seen on testivai/testivai-site#33: `Failed to CreateArtifact: Artifact
 * storage quota has been hit.` failed the step before anything was posted,
 * and the pull request showed nothing from TestivAI.
 *
 * index.ts runs its action when it is loaded, so each test loads it afresh
 * (jest.isolateModules) and lets its promise chain settle; every stub answers
 * at once.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildComment, buildEmptyComment, UPSERT_MARKER } from '../comment';
import { summaryFromComment } from '../job-summary';
import { determineStatus } from '../status';
import type { ResultsData } from '../types';

interface MockState {
  inputs: Record<string, string>;
  context: { eventName: string; payload: Record<string, any>; repo: { owner: string; repo: string }; sha: string };
  comments: Array<{ id: number; body: string }>;
  /** What uploadReport rejects with; '' for an upload that succeeds. */
  uploadError: string;
  /** The comment API call that rejects. */
  failComment: '' | 'createComment';
}

/** Everything the stubs were asked to do, in order. */
const mockEvents: Array<{ kind: string; value?: string; args?: any }> = [];
const mockState: MockState = {
  inputs: {},
  context: { eventName: 'push', payload: {}, repo: { owner: 'testivai', repo: 'testivai-site' }, sha: 'a'.repeat(40) },
  comments: [],
  uploadError: '',
  failComment: '',
};

const QUOTA = 'Failed to CreateArtifact: Artifact storage quota has been hit. Unable to upload any new artifacts. Usage is recalculated every 6-12 hours.';
const FORBIDDEN = 'Resource not accessible by integration';

// @actions/core and @actions/artifact ship as ES modules only: mocked as
// virtual modules, by name, which is all index.ts asks for.
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
          if (mockState.failComment === 'createComment') throw new Error(FORBIDDEN);
          return { data: {} };
        },
        updateComment: async ({ body }: { body: string }) => {
          mockEvents.push({ kind: 'comment.update', value: body });
          return { data: {} };
        },
      },
      checks: {
        create: async (args: any) => {
          mockEvents.push({ kind: 'check', args });
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
  uploadReport: async () => {
    mockEvents.push({ kind: 'upload' });
    if (mockState.uploadError) throw new Error(mockState.uploadError);
    return { id: 4402 };
  },
}));

const RUN_ID = '40230236386';
const ZIP = `https://github.com/testivai/testivai-site/actions/runs/${RUN_ID}/artifacts/4402`;
/** The run on testivai/testivai-site#33: 5 changed, 3 passed. */
const RESULTS: ResultsData = {
  timestamp: 0,
  summary: { total: 8, passed: 3, changed: 5, newSnapshots: 0 },
  snapshots: [
    ...['home', 'pricing', 'docs', 'blog', 'about'].map((name) => ({
      name,
      status: 'changed' as const,
      diffPercent: 2.1,
      dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } },
    })),
    ...['footer', 'nav', 'contact'].map((name) => ({ name, status: 'passed' as const, diffPercent: 0 })),
  ],
};
const PR = {
  eventName: 'pull_request',
  payload: { pull_request: { number: 33, head: { sha: 'b'.repeat(40) } } },
  repo: { owner: 'testivai', repo: 'testivai-site' },
  sha: 'a'.repeat(40),
};
const PUSH = { eventName: 'push', payload: {}, repo: { owner: 'testivai', repo: 'testivai-site' }, sha: 'a'.repeat(40) };

let reportDir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  mockEvents.length = 0;
  reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-upload-'));
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
  mockState.uploadError = '';
  mockState.failComment = '';
});

afterEach(() => {
  fs.rmSync(reportDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function writeResults(results: ResultsData) {
  fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify(results));
}

/** Load index.ts (which runs the action) and wait until its promise chain has settled. */
async function runReporter(): Promise<void> {
  jest.isolateModules(() => {
    require('../index');
  });
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

const kinds = (...wanted: string[]) => mockEvents.filter((e) => wanted.includes(e.kind)).map((e) => e.kind);
const values = (kind: string) => mockEvents.filter((e) => e.kind === kind).map((e) => e.value as string);
const postedComment = () => mockEvents.find((e) => e.kind === 'comment.create' || e.kind === 'comment.update')?.value as string;

describe('when the report artifact cannot be uploaded', () => {
  it('still posts the PR comment, the check run and the commit status, then fails the step with the upload error', async () => {
    writeResults(RESULTS);
    mockState.uploadError = QUOTA;

    await runReporter();

    expect(kinds('upload', 'summary.write', 'comment.create', 'check', 'status', 'setFailed')).toEqual([
      'upload', 'summary.write', 'comment.create', 'check', 'status', 'setFailed',
    ]);
    // The step fails once, for the upload, naming the artifact and the error.
    const failures = values('setFailed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("'testivai-visual-report'");
    expect(failures[0]).toContain(QUOTA);
    // No artifact, so no artifact-id output.
    expect(kinds('output')).toEqual([]);
  });

  it('the check run and the commit status carry the visual result from results.json', async () => {
    writeResults(RESULTS);
    mockState.uploadError = QUOTA;

    await runReporter();

    const expected = determineStatus(RESULTS, { failOnDiff: false, failOnMissing: false });
    const status = mockEvents.find((e) => e.kind === 'status')?.args;
    const check = mockEvents.find((e) => e.kind === 'check')?.args;
    expect(status).toMatchObject({ sha: 'b'.repeat(40), state: expected.state, description: expected.description });
    expect(check).toMatchObject({ head_sha: 'b'.repeat(40), conclusion: expected.conclusion, output: { title: expected.title } });
  });

  it('the comment shows the results, says the upload failed with the error and that approving needs the artifact, and has no ZIP link', async () => {
    writeResults(RESULTS);
    mockState.uploadError = QUOTA;

    await runReporter();

    const body = postedComment();
    expect(body).toContain(UPSERT_MARKER);
    expect(body).toContain('**3 passed** | **5 changed** | **0 new** — **8 total**');
    for (const name of ['home', 'pricing', 'docs', 'blog', 'about']) expect(body).toContain(`<code>${name}</code>`);
    expect(body).toContain('could not be uploaded');
    expect(body).toContain(QUOTA);
    expect(body).toMatch(/`\/testivai approve`[^\n]*artifact/);
    expect(body).toMatch(/re-run/i);
    expect(body).not.toContain('Download visual report ZIP');
    expect(body).not.toContain('/artifacts/');
    expect(body).not.toContain('download it as a ZIP');
  });

  it('updates an earlier comment the same way, dropping its old ZIP link', async () => {
    writeResults(RESULTS);
    mockState.uploadError = QUOTA;
    mockState.comments = [{ id: 7, body: `${UPSERT_MARKER}\n> [Download visual report ZIP](https://github.com/testivai/testivai-site/actions/runs/1/artifacts/9)` }];

    await runReporter();

    expect(kinds('comment.create')).toEqual([]);
    const body = mockEvents.find((e) => e.kind === 'comment.update')?.value as string;
    expect(body).toContain(QUOTA);
    expect(body).not.toContain('/artifacts/');
  });

  it('the job summary is the comment, upload failure included', async () => {
    writeResults(RESULTS);
    mockState.uploadError = QUOTA;

    await runReporter();

    expect(values('summary.addRaw')).toEqual([summaryFromComment(postedComment())]);
    expect(values('summary.addRaw')[0]).toContain(QUOTA);
  });

  it('on a push (no comment): the job summary says the upload failed, the status is posted, and the step fails', async () => {
    writeResults(RESULTS);
    mockState.context = PUSH;
    mockState.uploadError = QUOTA;

    await runReporter();

    expect(kinds('comment.create', 'comment.update')).toEqual([]);
    expect(values('summary.addRaw')[0]).toContain(QUOTA);
    expect(values('summary.addRaw')[0]).not.toContain('/artifacts/');
    expect(kinds('summary.write', 'check', 'status', 'setFailed')).toEqual(['summary.write', 'check', 'status', 'setFailed']);
    expect(values('setFailed')[0]).toContain(QUOTA);
  });

  it('a run with no snapshots: the empty-run comment says the upload failed, without a ZIP link', async () => {
    writeResults({ timestamp: 0, summary: { total: 0, passed: 0, changed: 0, newSnapshots: 0 }, snapshots: [] });
    mockState.uploadError = QUOTA;

    await runReporter();

    const body = postedComment();
    expect(body).toContain('No visual snapshots were captured in this test run.');
    expect(body).toContain('could not be uploaded');
    expect(body).toContain(QUOTA);
    expect(body).not.toContain('/artifacts/');
    expect(values('setFailed')).toHaveLength(1);
    expect(values('setFailed')[0]).toContain(QUOTA);
  });

  it('a failing visual result and the upload failure both fail the step, each with its own reason', async () => {
    writeResults(RESULTS);
    mockState.inputs['fail-on-diff'] = 'true';
    mockState.uploadError = QUOTA;

    await runReporter();

    const expected = determineStatus(RESULTS, { failOnDiff: true, failOnMissing: false });
    expect(expected.conclusion).toBe('failure');
    expect(kinds('status')).toEqual(['status']);
    const failures = values('setFailed');
    expect(failures).toContain(expected.description);
    expect(failures.filter((f) => f.includes(QUOTA))).toHaveLength(1);
  });

  it('when the comment then cannot be posted either, the step fails with both errors', async () => {
    writeResults(RESULTS);
    mockState.uploadError = QUOTA;
    mockState.failComment = 'createComment';

    await runReporter();

    const failures = values('setFailed');
    expect(failures).toContain(FORBIDDEN);
    expect(failures.filter((f) => f.includes(QUOTA))).toHaveLength(1);
  });

  it('an error message with markdown, HTML or line breaks cannot break out of the comment', async () => {
    writeResults(RESULTS);
    mockState.uploadError = 'bad `tick`\n<img src=x onerror=alert(1)> [link](https://evil.example)\n\n#### Heading';

    await runReporter();

    const body = postedComment();
    const notice = body.split('\n').find((line) => line.includes('could not be uploaded')) as string;
    // On one line, inside a code span the message cannot close.
    expect(notice).toContain('<img src=x onerror=alert(1)> [link](https://evil.example) #### Heading');
    const code = /`([^`]*)`/.exec(notice.slice(notice.indexOf('could not be uploaded')))?.[1] ?? '';
    expect(code).toContain('<img src=x');
    expect(code).toContain('#### Heading');
    expect(body).not.toMatch(/^#### Heading/m);
  });
});

describe('when the upload succeeds, nothing changes', () => {
  it('the comment is the one buildComment gives with the ZIP link, and the step does not fail', async () => {
    writeResults(RESULTS);

    await runReporter();

    expect(postedComment()).toBe(buildComment(RESULTS, ZIP, UPSERT_MARKER, { runKey: `${RUN_ID}-1` }));
    expect(postedComment()).not.toContain('could not be uploaded');
    expect(values('output')).toEqual(['artifact-id=4402']);
    expect(kinds('setFailed')).toEqual([]);
  });

  it('with upload-artifact off: no upload, no link, no upload notice, and the step does not fail', async () => {
    writeResults({ timestamp: 0, summary: { total: 0, passed: 0, changed: 0, newSnapshots: 0 }, snapshots: [] });
    mockState.inputs['upload-artifact'] = 'false';

    await runReporter();

    expect(kinds('upload')).toEqual([]);
    expect(postedComment()).toBe(buildEmptyComment(undefined, UPSERT_MARKER, { runKey: `${RUN_ID}-1` }));
    expect(kinds('setFailed')).toEqual([]);
  });
});

describe('the upload-failure notice in the comment', () => {
  const passedOnly: ResultsData = {
    timestamp: 0,
    summary: { total: 1, passed: 1, changed: 0, newSnapshots: 0 },
    snapshots: [{ name: 'footer', status: 'passed', diffPercent: 0 }],
  };

  it('with nothing to approve, says the upload failed but not that approving needs it', () => {
    const body = buildComment(passedOnly, undefined, UPSERT_MARKER, {}, QUOTA);
    expect(body).toContain('could not be uploaded');
    expect(body).toContain(QUOTA);
    expect(body).not.toContain('/testivai approve');
  });

  it('a new snapshot is approvable too, so the approve line is there', () => {
    const body = buildComment(
      { timestamp: 0, summary: { total: 1, passed: 0, changed: 0, newSnapshots: 1 }, snapshots: [{ name: 'signup', status: 'new' }] },
      undefined, UPSERT_MARKER, {}, QUOTA,
    );
    expect(body).toMatch(/`\/testivai approve`[^\n]*artifact/);
  });

  it('cuts a very long error to 500 characters', () => {
    const body = buildComment(passedOnly, undefined, UPSERT_MARKER, {}, 'x'.repeat(5000));
    const quoted = /\(`(x+…)`\)/.exec(body)?.[1] ?? '';
    expect(quoted).toHaveLength(500);
  });

  it('an empty error message still reads as an error', () => {
    expect(buildComment(passedOnly, undefined, UPSERT_MARKER, {}, '')).toContain('(`unknown error`)');
  });

  it('without an upload error, the comment is unchanged', () => {
    expect(buildComment(RESULTS, ZIP, UPSERT_MARKER, {})).toBe(buildComment(RESULTS, ZIP, UPSERT_MARKER, {}, undefined));
    expect(buildComment(RESULTS, ZIP, UPSERT_MARKER, {})).not.toContain('could not be uploaded');
  });
});
