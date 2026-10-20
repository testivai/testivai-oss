/**
 * `testivai approve` warns when the capture it promotes is unhealthy: a
 * baseline captured with a failed font or stylesheet makes every later
 * compare against it read as unhealthy. It still approves (the human
 * decides), and --json keeps stdout machine-readable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BaselineStore } from '../../baselines/store';
import type { CaptureHealth } from '../../capture/health';
import { approveCommand } from '../../commands/approve';

const HEALTHY: CaptureHealth = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};
const FONT_FAILED: CaptureHealth = { ...HEALTHY, fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: 'normal', style: 'normal' }] } };

describe('testivai approve and capture health', () => {
  let root: string;
  let output: string[];
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-approve-health-cli-'));
    jest.spyOn(process, 'cwd').mockReturnValue(root);
    output = [];
    stdout = [];
    stderr = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function capture(name: string, health?: CaptureHealth) {
    const store = new BaselineStore(root);
    store.writeTemp(name, Buffer.from(`png-${name}`));
    if (health) store.writeTempMetadata(name, { name, health });
  }

  const run = (...args: string[]) => approveCommand.parseAsync(args, { from: 'user' });

  it('approving an unhealthy capture: approved, with a warning naming what failed', async () => {
    capture('home', FONT_FAILED);
    await run('home');
    const text = output.join('\n');
    expect(text).toContain('Approved: home');
    expect(text).toMatch(/home: approving an unhealthy capture as the baseline — web font 'Fancy' failed to load, so the page rendered with a fallback font/);
    expect(text).toContain('re-run and approve a healthy capture');
    expect(new BaselineStore(root).readMetadata('home')?.health).toEqual(FONT_FAILED);
  });

  it('--all warns once per unhealthy capture, and not for a healthy one or one without health', async () => {
    capture('home', FONT_FAILED);
    capture('pricing', HEALTHY);
    capture('legacy');
    await run('--all');
    const warnings = output.filter((l) => l.includes('approving an unhealthy capture'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('home:');
  });

  it('--json: stdout stays the JSON result, the warning goes to stderr', async () => {
    capture('home', FONT_FAILED);
    await run('home', '--json');
    expect(JSON.parse(stdout.join(''))).toEqual({ approved: ['home'], failed: [] });
    expect(stderr.join('')).toMatch(/home: approving an unhealthy capture as the baseline/);
  });
});
