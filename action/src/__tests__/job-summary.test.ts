/**
 * The reporter's job summary is its PR comment on the run's page:
 * summaryFromComment takes the comment's markdown and leaves out only what a
 * run page cannot use, the hidden markers and the `/testivai approve` code
 * blocks (nobody can comment from a run page). Built from the same
 * buildComment / buildEmptyComment output, so the two never drift.
 *
 * The fixtures are the comment fixtures of comment.test.ts and
 * comment-links.test.ts, each built with a ZIP link, a run key and a lane's
 * marker, as the reporter builds them.
 */

import { buildComment, buildEmptyComment, resolveUpsertMarker, UPSERT_MARKER } from '../comment';
import { summaryFromComment, writeJobSummary } from '../job-summary';
import type { ResultsData } from '../types';

const ZIP = 'https://github.com/testivai/testivai-example/actions/runs/39150236166/artifacts/12144941550';
const REPORT = 'https://testivai.github.io/testivai-example/pr/14/39150236166-1/';
const RUN_KEY = '39150236166-1';
const RUN_MARKER = `<!-- testivai-run:${RUN_KEY} -->`;
const LANE = resolveUpsertMarker('TestivAI / visual (pytest)');

const FIXTURES: Record<string, ResultsData> = {
  // comment.test.ts T6.5
  'all passed': {
    timestamp: 0,
    summary: { total: 3, passed: 3, changed: 0, newSnapshots: 0 },
    snapshots: [
      { id: '1', name: 'page1', status: 'passed', currentPath: 'test.png' },
      { id: '2', name: 'page2', status: 'passed', currentPath: 'test.png' },
      { id: '3', name: 'page3', status: 'passed', currentPath: 'test.png' },
    ],
  },
  // comment.test.ts T6.4
  'a changed snapshot': {
    timestamp: 0,
    summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
    snapshots: [{ id: '1', name: 'homepage', status: 'changed', diffPercentage: 12.5, currentPath: 'test.png' }],
  },
  // comment.test.ts "renders new-snapshots section when present"
  'a new snapshot': {
    timestamp: 0,
    summary: { total: 1, passed: 0, changed: 0, newSnapshots: 1 },
    snapshots: [{ id: '1', name: 'fresh-baseline', status: 'new', currentPath: 'fresh.png' }],
  },
  // comment.test.ts DOM noise hint, both readings
  'DOM hints': {
    timestamp: 0,
    summary: { total: 2, passed: 0, changed: 2, newSnapshots: 0 },
    snapshots: [
      { id: '1', name: 'noisy', status: 'changed', diffPercent: 0.5, currentPath: 'noisy.png', dom: { changed: false, summary: null, noiseHint: true } },
      {
        id: '2',
        name: 'real-change',
        status: 'changed',
        diffPercent: 12,
        currentPath: 'rc.png',
        dom: { changed: true, summary: { added: 2, removed: 0, attributeChanges: 1 }, noiseHint: false },
      },
    ],
  },
  // comment.test.ts "pageShift renders the look-above guidance"
  'a page shift': {
    timestamp: 0,
    summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
    snapshots: [
      {
        name: 'home',
        status: 'changed',
        diffPercent: 12,
        pageShift: { dy: 24, belowY: 80, count: 17 },
        dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } },
      },
    ],
  },
  // comment.test.ts "missing baselines are surfaced as a coverage warning"
  'missing baselines': {
    timestamp: 0,
    summary: { total: 1, passed: 1, changed: 0, newSnapshots: 0, missing: 2 },
    snapshots: [{ name: 'ok', status: 'passed', diffPercent: 0 }],
    missingBaselines: ['pricing', 'checkout'],
  },
  // comment-links.test.ts MIXED
  'changed, new and passed': {
    timestamp: 0,
    summary: { total: 4, passed: 1, changed: 2, newSnapshots: 1 },
    snapshots: [
      { name: 'home', status: 'changed', diffPercent: 2.1 },
      { name: 'pricing page', status: 'changed', diffPercent: 0.4 },
      { name: 'signup', status: 'new' },
      { name: 'footer', status: 'passed' },
    ],
  },
};

/**
 * The comment's lines the summary does not have, in order: the summary's
 * lines must be the comment's with some taken out, nothing added or changed.
 */
function removedLines(comment: string, summary: string): string[] {
  const kept = summary.split('\n');
  const removed: string[] = [];
  let next = 0;
  for (const line of comment.split('\n')) {
    if (next < kept.length && line === kept[next]) next++;
    else removed.push(line);
  }
  expect(next).toBe(kept.length);
  return removed;
}

/** The approve code block of each changed snapshot, as the comment has it. */
const approveBlocks = (results: ResultsData) => results.snapshots.filter((s) => s.status === 'changed').flatMap((s) => ['```', `/testivai approve ${s.name}`, '```']);

describe('summaryFromComment', () => {
  describe.each(Object.entries(FIXTURES))('%s', (_, results) => {
    it('is the comment without its markers and approve commands (default lane)', () => {
      const comment = buildComment(results, ZIP, UPSERT_MARKER, { runKey: RUN_KEY });

      const summary = summaryFromComment(comment);

      expect(summary).toMatchSnapshot();
      expect(removedLines(comment, summary).filter((l) => l !== '')).toEqual([UPSERT_MARKER, RUN_MARKER, ...approveBlocks(results)]);
      expect(summary.startsWith('### TestivAI Visual Report\n')).toBe(true);
    });

    it("drops a custom lane's marker the same way, and keeps the published report's links", () => {
      const comment = buildComment(results, ZIP, LANE, { runKey: RUN_KEY, reportUrl: REPORT });

      const summary = summaryFromComment(comment);

      expect(summary).toMatchSnapshot();
      expect(removedLines(comment, summary).filter((l) => l !== '')).toEqual([LANE, RUN_MARKER, ...approveBlocks(results)]);
      expect(summary).toContain(`[Open the visual report](${REPORT})`);
      expect(summary).toContain(`(${ZIP})`);
    });
  });

  it('keeps no hidden marker and no approve code block', () => {
    for (const results of Object.values(FIXTURES)) {
      const summary = summaryFromComment(buildComment(results, ZIP, LANE, { runKey: RUN_KEY }));
      expect(summary).not.toContain('<!--');
      expect(summary).not.toMatch(/^\/testivai approve /m);
      expect(summary).not.toContain('```');
    }
  });

  it('is the empty-run comment without its markers', () => {
    const comment = buildEmptyComment(ZIP, UPSERT_MARKER, { runKey: RUN_KEY });

    const summary = summaryFromComment(comment);

    expect(summary).toMatchSnapshot();
    expect(removedLines(comment, summary).filter((l) => l !== '')).toEqual([UPSERT_MARKER, RUN_MARKER]);
    expect(summary).toContain('No visual snapshots were captured');
    expect(summary).toContain(`(${ZIP})`);
  });

  it('works on a comment without a run marker or ZIP link (no GITHUB_RUN_ID, no upload)', () => {
    const comment = buildComment(FIXTURES['a changed snapshot']);

    const summary = summaryFromComment(comment);

    expect(removedLines(comment, summary).filter((l) => l !== '')).toEqual([UPSERT_MARKER, ...approveBlocks(FIXTURES['a changed snapshot'])]);
  });

  it('changes nothing in a body that has neither', () => {
    const body = '### TestivAI Visual Report\n\n**1 passed** | **0 changed** | **0 new** — **1 total**\n';

    expect(summaryFromComment(body)).toBe(body);
  });
});

describe('writeJobSummary', () => {
  function stubCore(write: () => Promise<unknown> = async () => undefined) {
    const calls: string[] = [];
    const written: Array<[string, boolean | undefined]> = [];
    const core = {
      summary: {
        addRaw(text: string, addEOL?: boolean) {
          calls.push('addRaw');
          written.push([text, addEOL]);
          return {
            write: () => {
              calls.push('write');
              return write();
            },
          };
        },
      },
      warning: jest.fn(),
    };
    return { core, calls, written };
  }

  it('writes the markdown once, as it is', async () => {
    const { core, calls, written } = stubCore();

    await expect(writeJobSummary(core, '### Hello\n')).resolves.toBe(true);

    expect(calls).toEqual(['addRaw', 'write']);
    expect(written).toEqual([['### Hello\n', true]]);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('only warns when the write fails (no GITHUB_STEP_SUMMARY, say)', async () => {
    const { core } = stubCore(async () => {
      throw new Error('Unable to find environment variable for $GITHUB_STEP_SUMMARY. Check if your runtime environment supports job summaries.');
    });

    await expect(writeJobSummary(core, '### Hello\n')).resolves.toBe(false);

    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/job summary.*GITHUB_STEP_SUMMARY/));
  });

  it('only warns when there is no summary to write to at all', async () => {
    const core = { warning: jest.fn() } as unknown as Parameters<typeof writeJobSummary>[0];

    await expect(writeJobSummary(core, '### Hello\n')).resolves.toBe(false);

    expect(core.warning).toHaveBeenCalledTimes(1);
  });
});
