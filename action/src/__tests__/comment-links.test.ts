/**
 * Links from the PR comment into the published HTML report.
 *
 * When the report for a run is published (GitHub Pages), the comment links
 * to it: one "open the report" link, and one link per changed or new
 * snapshot that lands on that snapshot's card. The ZIP download stays as the
 * fallback. A hidden run marker records which CI run the comment describes,
 * so a later update (the publish step) can check the comment is still about
 * that run before changing it.
 */

import { snapshotAnchorId } from '../../../packages/witness/src/report/anchor';
import { buildComment, buildEmptyComment, readRunKey, runKeyFromEnv, UPSERT_MARKER } from '../comment';
import type { ResultsData, SnapshotResult } from '../types';

const REPORT = 'https://testivai.github.io/testivai-example/pr/14/39150236166-1/';
const ZIP = 'https://github.com/testivai/testivai-example/actions/runs/39150236166/artifacts/12144941550';

function snap(name: string, status: SnapshotResult['status'], diffPercent = 0): SnapshotResult {
  return { name, status, diffPercent } as SnapshotResult;
}

function results(snapshots: SnapshotResult[]): ResultsData {
  return {
    summary: {
      total: snapshots.length,
      passed: snapshots.filter((s) => s.status === 'passed').length,
      changed: snapshots.filter((s) => s.status === 'changed').length,
      newSnapshots: snapshots.filter((s) => s.status === 'new').length,
    },
    snapshots,
  } as ResultsData;
}

const MIXED = results([
  snap('home', 'changed', 2.1),
  snap('pricing page', 'changed', 0.4),
  snap('signup', 'new'),
  snap('footer', 'passed'),
]);

describe('report link', () => {
  it('links the published report above the snapshot list, and keeps the ZIP download', () => {
    const comment = buildComment(MIXED, ZIP, UPSERT_MARKER, { reportUrl: REPORT });

    const open = comment.indexOf(`[Open the visual report](${REPORT})`);
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(comment.indexOf('Changed Snapshots'));
    expect(comment).toContain(`(${ZIP})`);
  });

  it('links each changed snapshot to its card in the report', () => {
    const comment = buildComment(MIXED, ZIP, UPSERT_MARKER, { reportUrl: REPORT });

    for (const name of ['home', 'pricing page']) {
      expect(comment).toContain(`href="${REPORT}#${snapshotAnchorId(name)}"`);
    }
    // The link sits on the snapshot's own row, visible without expanding it.
    const homeRow = comment.split('\n').find((l) => l.includes('<summary><code>home</code>'));
    expect(homeRow).toContain(`href="${REPORT}#snap-home"`);
  });

  it('links each new snapshot to its card in the report', () => {
    const comment = buildComment(MIXED, ZIP, UPSERT_MARKER, { reportUrl: REPORT });

    expect(comment).toContain(`[open](${REPORT}#${snapshotAnchorId('signup')})`);
  });

  it('does not link passed snapshots (there is nothing to review)', () => {
    const comment = buildComment(MIXED, ZIP, UPSERT_MARKER, { reportUrl: REPORT });

    expect(comment).not.toContain(`#${snapshotAnchorId('footer')}`);
  });

  it('links the report from the comment for a run with no snapshots', () => {
    const comment = buildEmptyComment(ZIP, UPSERT_MARKER, { reportUrl: REPORT });

    expect(comment).toContain(`[Open the visual report](${REPORT})`);
  });

  it('leaves the comment as it was when no report is published', () => {
    const before = buildComment(MIXED, ZIP, UPSERT_MARKER);

    expect(before).not.toContain('Open the visual report');
    expect(before).toContain(`> [Download visual report ZIP](${ZIP}) — contains baseline, current, and diff images`);
    expect(before).not.toContain('href=');
  });

  it.each([
    ['plain http', 'http://testivai.github.io/r/'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['not a URL', 'report/index.html'],
    ['a quote that would end the link', 'https://example.com/r/"onmouseover="x'],
    ['a space', 'https://example.com/a b/'],
  ])('ignores a report URL that is %s', (_label, url) => {
    const comment = buildComment(MIXED, ZIP, UPSERT_MARKER, { reportUrl: url });

    expect(comment).not.toContain('Open the visual report');
    expect(comment).not.toContain('href=');
  });

  it("replaces the report URL's own #fragment with the snapshot's, and escapes & in links", () => {
    const comment = buildComment(MIXED, ZIP, UPSERT_MARKER, { reportUrl: 'https://example.com/r/?run=1&pr=2#top' });

    expect(comment).toContain('href="https://example.com/r/?run=1&amp;pr=2#snap-home"');
    expect(comment).not.toContain('#top');
  });
});

describe('run marker', () => {
  it('records which run the comment describes, and reads it back', () => {
    const comment = buildComment(MIXED, ZIP, UPSERT_MARKER, { runKey: '39150236166-1' });

    expect(readRunKey(comment)).toBe('39150236166-1');
  });

  it('records the run on the comment for a run with no snapshots too', () => {
    expect(readRunKey(buildEmptyComment(ZIP, UPSERT_MARKER, { runKey: '7-2' }))).toBe('7-2');
  });

  it('reads no run from a comment written before the marker existed', () => {
    expect(readRunKey(buildComment(MIXED, ZIP))).toBeUndefined();
  });

  it('keeps the marker a valid HTML comment whatever the run key holds', () => {
    const comment = buildComment(MIXED, ZIP, UPSERT_MARKER, { runKey: '1--> <b>x</b>' });

    const marker = comment.split('\n').find((l) => l.startsWith('<!-- testivai-run:'));
    expect(marker).toMatch(/^<!-- testivai-run:[A-Za-z0-9_-]+ -->$/);
  });

  it('does not disturb finding the comment by its upsert marker', () => {
    const comment = buildComment(MIXED, ZIP, UPSERT_MARKER, { runKey: '5-1' });

    expect(comment.startsWith(UPSERT_MARKER)).toBe(true);
  });
});

describe('runKeyFromEnv', () => {
  it('is the run id and attempt GitHub Actions sets', () => {
    expect(runKeyFromEnv({ GITHUB_RUN_ID: '39150236166', GITHUB_RUN_ATTEMPT: '2' })).toBe('39150236166-2');
  });

  it('assumes the first attempt when the attempt is not set', () => {
    expect(runKeyFromEnv({ GITHUB_RUN_ID: '39150236166' })).toBe('39150236166-1');
  });

  it('is undefined outside a workflow run', () => {
    expect(runKeyFromEnv({})).toBeUndefined();
  });
});
