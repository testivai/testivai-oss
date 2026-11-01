/**
 * The report does not depend on whether the tests passed.
 *
 * Default mode: onEnd compares and writes visual-report/results.json for a
 * failed, timed-out or interrupted run exactly as for a passed one, so the
 * GitHub Action (run with `if: ${{ !cancelled() }}`) always has a report to
 * post. Capture-only mode: onEnd only captures, and its hint says to run the
 * compare step after a test failure too, or a failing test leaves the pull
 * request without a report even though every capture was taken.
 *
 * Runs the real reporter against a real project on disk: a baseline and a
 * capture of the same 4×4 PNG, the capture written after onBegin (which
 * empties .testivai/temp, as at the start of a test run).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TestivAIPlaywrightReporter } from '../../reporter';
import type { FullConfig, FullResult, Suite } from '../../reporter-types';

/** A 4×4 white PNG (this package does not depend on pngjs). */
const WHITE_4X4 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGUlEQVR4AWP8DwQMSICJAQ0wMaABJgY0AAAGXQQEOHaWpAAAAABJRU5ErkJggg==';

function png(): Buffer {
  return Buffer.from(WHITE_4X4, 'base64');
}

function writeCapture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'screenshot.png'), png());
  fs.writeFileSync(path.join(dir, 'dom.html'), '<html><body><p>home</p></body></html>');
}

const savedCwd = process.cwd();
const savedEnv = { ...process.env };
let project: string;
let logs: string[];

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-report-on-failure-'));
  process.chdir(project);
  fs.mkdirSync(path.join(project, '.testivai'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.testivai', 'config.json'),
    JSON.stringify({ threshold: 0.1, reportDir: 'visual-report', autoOpen: false }),
  );
  writeCapture(path.join(project, '.testivai', 'baselines', 'home'));
  delete process.env.TESTIVAI_CAPTURE_ONLY;
  delete process.env.TESTIVAI_SHARD;
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  process.chdir(savedCwd);
  process.env = { ...savedEnv };
  fs.rmSync(project, { recursive: true, force: true });
});

async function runReporter(
  status: FullResult['status'],
  options: ConstructorParameters<typeof TestivAIPlaywrightReporter>[0] = {},
  shard: FullConfig['shard'] = null,
): Promise<void> {
  const reporter = new TestivAIPlaywrightReporter(options);
  await reporter.onBegin({ shard } as unknown as FullConfig, {} as Suite);
  writeCapture(path.join(project, '.testivai', 'temp', 'home'));
  await reporter.onEnd({ status } as FullResult);
}

const resultsPath = () => path.join(project, 'visual-report', 'results.json');

describe('default mode writes the report whatever the test status', () => {
  for (const status of ['passed', 'failed', 'timedout', 'interrupted'] as const) {
    it(`a ${status} run writes results.json and index.html with the comparison`, async () => {
      await runReporter(status);

      expect(fs.existsSync(resultsPath())).toBe(true);
      expect(fs.existsSync(path.join(project, 'visual-report', 'index.html'))).toBe(true);
      const results = JSON.parse(fs.readFileSync(resultsPath(), 'utf-8'));
      expect(results.summary).toMatchObject({ total: 1, passed: 1, changed: 0, newSnapshots: 0, missing: 0 });
      expect(results.snapshots[0]).toMatchObject({ name: 'home', status: 'passed' });
    });
  }
});

describe('capture-only mode', () => {
  it('writes no report, keeps the captures, and its hint says to compare after a test failure too', async () => {
    await runReporter('failed', { captureOnly: true });

    expect(fs.existsSync(resultsPath())).toBe(false);
    expect(fs.existsSync(path.join(project, '.testivai', 'temp', 'home', 'screenshot.png'))).toBe(true);
    const hint = logs.join('\n');
    expect(hint).toContain('npx testivai merge-captures <dirs...> && npx testivai report --fail-on-diff');
    expect(hint).toContain('if: ${{ !cancelled() }}');
    expect(hint).toMatch(/even when a test fail/);
  });

  it('a failing shard still writes its manifest, with the failed status, for merge-captures', async () => {
    await runReporter('failed', {}, { current: 2, total: 3 });

    expect(fs.existsSync(resultsPath())).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.testivai', 'temp', 'testivai-shard.json'), 'utf-8'));
    expect(manifest).toMatchObject({ shard: { current: 2, total: 3 }, complete: true, status: 'failed', captures: ['home'] });
    expect(logs.join('\n')).toContain('if: ${{ !cancelled() }}');
  });
});
