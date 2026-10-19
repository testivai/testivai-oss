/**
 * The reporter's job summary (index.ts), with the actions toolkit stubbed:
 * written once per run, for every event, with summaryFromComment of the
 * comment's markdown; after the PR comment and before the check run and the
 * commit status; and a failed write only warns.
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
import type { ResultsData } from '../types';

interface MockState {
  inputs: Record<string, string>;
  context: { eventName: string; payload: Record<string, any>; repo: { owner: string; repo: string }; sha: string };
  comments: Array<{ id: number; body: string }>;
  failSummaryWrite: boolean;
}

/** Everything the stubs were asked to do, in order. */
const mockEvents: Array<{ kind: string; value?: string }> = [];
const mockState: MockState = {
  inputs: {},
  context: { eventName: 'push', payload: {}, repo: { owner: 'testivai', repo: 'testivai-example' }, sha: 'a'.repeat(40) },
  comments: [],
  failSummaryWrite: false,
};

// @actions/core and @actions/artifact ship as ES modules only (no `require`
// export), which jest's CommonJS resolver cannot load: they are mocked as
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
      if (mockState.failSummaryWrite) {
        throw new Error('Unable to find environment variable for $GITHUB_STEP_SUMMARY. Check if your runtime environment supports job summaries.');
      }
      return summary;
    },
  };
  return {
    getInput: (name: string) => mockState.inputs[name] ?? '',
    getBooleanInput: (name: string) => (mockState.inputs[name] ?? 'false') === 'true',
    info: record('info'),
    notice: record('notice'),
    warning: record('warning'),
    setFailed: record('setFailed'),
    setOutput: () => {},
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
        listComments: async () => ({ data: mockState.comments }),
        createComment: async ({ body }: { body: string }) => {
          mockEvents.push({ kind: 'comment.create', value: body });
          return { data: {} };
        },
        updateComment: async ({ body }: { body: string }) => {
          mockEvents.push({ kind: 'comment.update', value: body });
          return { data: {} };
        },
      },
      checks: {
        create: async () => {
          mockEvents.push({ kind: 'check' });
          return { data: {} };
        },
      },
      repos: {
        createCommitStatus: async () => {
          mockEvents.push({ kind: 'status' });
          return { data: {} };
        },
      },
    },
  }),
}));

jest.mock('@actions/artifact', () => ({ DefaultArtifactClient: class {} }), { virtual: true });

jest.mock('../report-artifact', () => ({
  writeRunStamp: () => {},
  uploadReport: async () => ({ id: 4402 }),
}));

const RUN_ID = '39150236166';
const ZIP = `https://github.com/testivai/testivai-example/actions/runs/${RUN_ID}/artifacts/4402`;
const RESULTS: ResultsData = {
  timestamp: 0,
  summary: { total: 2, passed: 0, changed: 1, newSnapshots: 1 },
  snapshots: [
    { name: 'home', status: 'changed', diffPercent: 2.1, dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } } },
    { name: 'signup', status: 'new' },
  ],
};

let reportDir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  mockEvents.length = 0;
  reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-summary-'));
  process.env.GITHUB_RUN_ID = RUN_ID;
  process.env.GITHUB_RUN_ATTEMPT = '1';
  mockState.inputs = {
    'github-token': 'unused',
    'report-dir': reportDir,
    'fail-on-diff': 'false',
    'upload-artifact': 'true',
    'artifact-retention-days': '30',
  };
  mockState.comments = [];
  mockState.failSummaryWrite = false;
});

afterEach(() => {
  fs.rmSync(reportDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function writeResults(results: ResultsData) {
  fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify(results));
}

/** Load index.ts (which runs the action) and wait until the run has posted its commit status or failed. */
async function runReporter(): Promise<void> {
  jest.isolateModules(() => {
    require('../index');
  });
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (mockEvents.some((e) => e.kind === 'status' || e.kind === 'setFailed')) break;
  }
  // Whatever the run logs after the status.
  await new Promise((resolve) => setImmediate(resolve));
}

const kinds = (...wanted: string[]) => mockEvents.filter((e) => wanted.includes(e.kind)).map((e) => e.kind);
const summaries = () => mockEvents.filter((e) => e.kind === 'summary.addRaw').map((e) => e.value);

describe('the reporter writes a job summary', () => {
  it('on a pull request: once, the posted comment without markers or approve commands, after the comment and before the status', async () => {
    writeResults(RESULTS);
    mockState.context = {
      eventName: 'pull_request',
      payload: { pull_request: { number: 14, head: { sha: 'b'.repeat(40) } } },
      repo: { owner: 'testivai', repo: 'testivai-example' },
      sha: 'a'.repeat(40),
    };

    await runReporter();

    const posted = mockEvents.find((e) => e.kind === 'comment.create')?.value as string;
    expect(posted).toBe(buildComment(RESULTS, ZIP, UPSERT_MARKER, { runKey: `${RUN_ID}-1` }));
    expect(summaries()).toEqual([summaryFromComment(posted)]);
    expect(kinds('comment.create', 'summary.addRaw', 'summary.write', 'check', 'status')).toEqual(['comment.create', 'summary.addRaw', 'summary.write', 'check', 'status']);
    expect(kinds('setFailed')).toEqual([]);
  });

  it('when it updates its comment instead, the same', async () => {
    writeResults(RESULTS);
    mockState.context = {
      eventName: 'pull_request',
      payload: { pull_request: { number: 14, head: { sha: 'b'.repeat(40) } } },
      repo: { owner: 'testivai', repo: 'testivai-example' },
      sha: 'a'.repeat(40),
    };
    mockState.comments = [{ id: 7, body: `${UPSERT_MARKER}\nolder run` }];

    await runReporter();

    const posted = mockEvents.find((e) => e.kind === 'comment.update')?.value as string;
    expect(summaries()).toEqual([summaryFromComment(posted)]);
    expect(kinds('comment.update', 'summary.write', 'check', 'status')).toEqual(['comment.update', 'summary.write', 'check', 'status']);
  });

  it('on a push, which gets no comment: once, the comment it would have posted, ZIP link included, before the status', async () => {
    writeResults(RESULTS);
    mockState.context = { eventName: 'push', payload: {}, repo: { owner: 'testivai', repo: 'testivai-example' }, sha: 'a'.repeat(40) };

    await runReporter();

    expect(kinds('comment.create', 'comment.update')).toEqual([]);
    const expected = summaryFromComment(buildComment(RESULTS, ZIP, UPSERT_MARKER, { runKey: `${RUN_ID}-1` }));
    expect(summaries()).toEqual([expected]);
    expect(expected).toContain(`(${ZIP})`);
    expect(expected).toContain('#### Changed Snapshots');
    expect(kinds('summary.write', 'check', 'status')).toEqual(['summary.write', 'check', 'status']);
  });

  it('for a run with no snapshots: the empty-run comment', async () => {
    writeResults({ timestamp: 0, summary: { total: 0, passed: 0, changed: 0, newSnapshots: 0 }, snapshots: [] });
    mockState.context = { eventName: 'push', payload: {}, repo: { owner: 'testivai', repo: 'testivai-example' }, sha: 'a'.repeat(40) };

    await runReporter();

    expect(summaries()).toEqual([summaryFromComment(buildEmptyComment(ZIP, UPSERT_MARKER, { runKey: `${RUN_ID}-1` }))]);
  });

  it('only warns when the summary cannot be written: the check run and the status still go out, and the job does not fail', async () => {
    writeResults(RESULTS);
    mockState.context = { eventName: 'push', payload: {}, repo: { owner: 'testivai', repo: 'testivai-example' }, sha: 'a'.repeat(40) };
    mockState.failSummaryWrite = true;

    await runReporter();

    const warnings = mockEvents.filter((e) => e.kind === 'warning').map((e) => e.value);
    expect(warnings).toContainEqual(expect.stringMatching(/job summary.*GITHUB_STEP_SUMMARY/));
    expect(kinds('summary.write', 'check', 'status')).toEqual(['summary.write', 'check', 'status']);
    expect(kinds('setFailed')).toEqual([]);
  });
});
