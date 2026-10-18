/**
 * The report artifact after a re-run.
 *
 * A re-run uploads the report again under the same name, and artifact IDs are
 * not in upload order: on testivai/testivai-site#20 the second attempt's
 * artifact got a lower ID (12138666565) than the first's (12138730649).
 * actions/download-artifact picks the highest ID among same-named artifacts,
 * so the review job of the re-run triaged the first attempt's report. The
 * reporter now deletes the earlier attempts' report before uploading, and
 * stamps the run attempt next to results.json so a reader can tell.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseRunStamp, readRunStamp, RUN_STAMP_FILE, staleReport, uploadReport, writeRunStamp } from '../report-artifact';

class NotFound extends Error {
  constructor() {
    super('Artifact not found for name: testivai-visual-report');
    this.name = 'ArtifactNotFoundError';
  }
}

/** An artifact client holding earlier attempts' artifacts of one name. */
function fakeClient({ earlier = [] as number[], deleteError = null as Error | null } = {}) {
  const left = [...earlier];
  const calls: string[] = [];
  return {
    calls,
    left,
    async deleteArtifact(name: string) {
      calls.push(`delete ${name}`);
      if (deleteError) throw deleteError;
      const id = left.shift();
      if (id === undefined) throw new NotFound();
      return { id };
    },
    async uploadArtifact(name: string, files: string[], root: string, opts: { retentionDays?: number }) {
      calls.push(`upload ${name} ${files.length} ${root} ${opts.retentionDays}`);
      return { id: 999, size: 1 };
    },
  };
}

const log = () => {
  const lines: string[] = [];
  return { lines, info: (m: string) => lines.push(`info: ${m}`), warning: (m: string) => lines.push(`warning: ${m}`) };
};

describe('uploadReport', () => {
  const args = { name: 'testivai-visual-report', files: ['a', 'b'], rootDir: '/r', retentionDays: 30 };

  it('on a re-run, deletes every earlier attempt of the same name, then uploads', async () => {
    const client = fakeClient({ earlier: [12138730649, 12138000000] });
    const l = log();
    const result = await uploadReport({ client, ...args, runAttempt: 3, log: l });
    expect(client.calls).toEqual([
      'delete testivai-visual-report',
      'delete testivai-visual-report',
      'delete testivai-visual-report',
      'upload testivai-visual-report 2 /r 30',
    ]);
    expect(client.left).toEqual([]);
    expect(result.id).toBe(999);
    expect(l.lines.filter((x) => x.includes('12138730649'))).toHaveLength(1);
    expect(l.lines.some((x) => x.startsWith('warning'))).toBe(false);
  });

  it('on the first attempt, deletes nothing: there is no earlier report, and another job may own the name', async () => {
    const client = fakeClient({ earlier: [1] });
    await uploadReport({ client, ...args, runAttempt: 1, log: log() });
    expect(client.calls).toEqual(['upload testivai-visual-report 2 /r 30']);
  });

  it('a failed delete warns and still uploads', async () => {
    const client = fakeClient({ deleteError: new Error('403 Forbidden') });
    const l = log();
    await uploadReport({ client, ...args, runAttempt: 2, log: l });
    expect(client.calls).toEqual(['delete testivai-visual-report', 'upload testivai-visual-report 2 /r 30']);
    expect(l.lines.find((x) => x.startsWith('warning'))).toMatch(/403 Forbidden.*earlier attempt/);
  });

  it('stops deleting after a bounded number of artifacts', async () => {
    const client = fakeClient({ earlier: Array.from({ length: 50 }, (_, i) => i + 1) });
    await uploadReport({ client, ...args, runAttempt: 2, log: log() });
    expect(client.calls.filter((c) => c.startsWith('delete')).length).toBeLessThanOrEqual(20);
    expect(client.calls[client.calls.length - 1]).toBe('upload testivai-visual-report 2 /r 30');
  });
});

describe('run stamp', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-stamp-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the run, attempt and commit next to results.json, and reads them back', () => {
    const file = writeRunStamp(dir, { GITHUB_RUN_ID: '39132055535', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'abc123' });
    expect(file).toBe(path.join(dir, RUN_STAMP_FILE));
    expect(readRunStamp(dir)).toEqual({ runId: '39132055535', runAttempt: 2, sha: 'abc123' });
  });

  it('writes nothing outside GitHub Actions', () => {
    expect(writeRunStamp(dir, {})).toBeNull();
    expect(fs.existsSync(path.join(dir, RUN_STAMP_FILE))).toBe(false);
    expect(readRunStamp(dir)).toBeNull();
  });

  it('reads an unreadable stamp as no stamp', () => {
    fs.writeFileSync(path.join(dir, RUN_STAMP_FILE), '{not json');
    expect(readRunStamp(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, RUN_STAMP_FILE), JSON.stringify({ runId: 7 }));
    expect(readRunStamp(dir)).toBeNull();
  });

  it('parses a stamp from text, as the publish step reads it out of a report ZIP', () => {
    expect(parseRunStamp('{"runId":"7","runAttempt":2,"sha":"abc"}')).toEqual({ runId: '7', runAttempt: 2, sha: 'abc' });
    expect(parseRunStamp('{"runId":"7","runAttempt":2,"extra":"<b>"}')).toEqual({ runId: '7', runAttempt: 2 });
  });

  it('reads a stamp with an attempt that is not a positive whole number as no stamp', () => {
    for (const runAttempt of [0, -1, 1.5, '2', null]) {
      expect(parseRunStamp(JSON.stringify({ runId: '7', runAttempt }))).toBeNull();
    }
    expect(parseRunStamp('[]')).toBeNull();
    expect(parseRunStamp('null')).toBeNull();
  });

  it('a report from an earlier attempt of this run is stale; this attempt, another run or no stamp is not', () => {
    const stamp = { runId: '7', runAttempt: 1 };
    expect(staleReport(stamp, { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2' })).toEqual({ reportAttempt: 1, thisAttempt: 2 });
    expect(staleReport(stamp, { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1' })).toBeNull();
    // Downloaded from another run on purpose (download-artifact's run-id): not ours to judge.
    expect(staleReport(stamp, { GITHUB_RUN_ID: '8', GITHUB_RUN_ATTEMPT: '2' })).toBeNull();
    expect(staleReport(null, { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2' })).toBeNull();
    expect(staleReport(stamp, {})).toBeNull();
  });
});
