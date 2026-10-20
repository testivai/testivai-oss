/**
 * compareAll() with capture provenance: the environment recorded in the
 * baseline's and the current capture's metadata.json, read side by side.
 *
 * environmentPolicy decides what a change of environment does:
 *   warn (default) — never changes a status; it is reported
 *   strict         — a rendering change makes the snapshot changed, whatever
 *                    its pixels say (exit 1 with --fail-on-diff)
 *   separate       — snapshots are keyed by environment by the adapters; the
 *                    compare only stops calling other environments' baselines
 *                    missing
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CaptureEnvironment } from '../capture/environment';
import { reportExitCode } from '../commands/exit-codes';
import { compareAll } from '../report/compare';
import { generateReport } from '../report/generator';
import { encodePng, paintRect, solidRgba, BLUE } from './helpers/synth';

const W = 200;
const H = 100;

const ENV_130: CaptureEnvironment = {
  os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' },
  browser: { name: 'chromium', version: '130.0.6723.58', headless: true },
  framework: { name: 'playwright', version: '1.48.2', language: 'typescript', runner: '@playwright/test' },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.5', captureMethod: 'full-page:cdp' },
  render: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
};
const ENV_141: CaptureEnvironment = { ...ENV_130, browser: { ...ENV_130.browser, version: '141.0.7390.37' } };
const ENV_130_NEW_FRAMEWORK: CaptureEnvironment = { ...ENV_130, framework: { ...ENV_130.framework!, version: '1.48.3' } };

/** A page: a blue card on white. */
const page = (): Uint8ClampedArray => {
  const data = solidRgba(W, H);
  paintRect(data, W, H, { x: 20, y: 20, width: 120, height: 40 }, BLUE);
  return data;
};

/** The same page with 30 isolated glyph-edge pixels nudged: scattered, below the region floor. */
const pageWithEdgeNoise = (): Uint8ClampedArray => {
  const data = page();
  for (let i = 0; i < 30; i++) {
    const x = 150 + (i % 6) * 7;
    const y = 5 + Math.floor(i / 6) * 17;
    const at = (y * W + x) * 4;
    data[at] = 215;
    data[at + 1] = 215;
    data[at + 2] = 215;
  }
  return data;
};

const HTML = '<html><body><main><div class="card">Card</div></main></body></html>';
const ELEMENTS = JSON.stringify([{ path: 'body > main > div.card', x: 20, y: 20, width: 120, height: 40, styleHash: 'aaaa1111' }]);

describe('compareAll with capture provenance', () => {
  let root: string;
  let reportDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-compare-env-'));
    reportDir = path.join(root, 'visual-report');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(config: object) {
    fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
    fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify(config));
  }

  /** Baseline + capture with the given environments (undefined = not recorded). */
  function writeSnapshot(
    name: string,
    opts: { baselineEnv?: CaptureEnvironment; candidateEnv?: CaptureEnvironment; candidate?: Uint8ClampedArray; baselinesDir?: string },
  ) {
    const bDir = path.join(root, opts.baselinesDir ?? '.testivai/baselines', name);
    const tDir = path.join(root, '.testivai', 'temp', name);
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(path.join(bDir, 'screenshot.png'), encodePng(page(), W, H));
    fs.writeFileSync(path.join(tDir, 'screenshot.png'), encodePng(opts.candidate ?? page(), W, H));
    for (const dir of [bDir, tDir]) {
      fs.writeFileSync(path.join(dir, 'dom.html'), HTML);
      fs.writeFileSync(path.join(dir, 'elements.json'), ELEMENTS);
    }
    const now = '2026-10-01T00:00:00.000Z';
    fs.writeFileSync(
      path.join(bDir, 'metadata.json'),
      JSON.stringify({ name, createdAt: now, updatedAt: now, ...(opts.baselineEnv ? { environment: opts.baselineEnv } : {}) }),
    );
    if (opts.candidateEnv) fs.writeFileSync(path.join(tDir, 'metadata.json'), JSON.stringify({ name, environment: opts.candidateEnv }));
  }

  it('same environment on both sides: an empty delta, and no copies of the blocks', () => {
    writeSnapshot('home', { baselineEnv: ENV_130, candidateEnv: ENV_130, candidate: pageWithEdgeNoise() });
    const [r] = compareAll({ projectRoot: root, reportDir });
    expect(r.environment).toEqual({ delta: [], renderingDelta: [] });
  });

  it('a browser bump with edge noise: changed, with the delta and both environments', () => {
    writeSnapshot('home', { baselineEnv: ENV_130, candidateEnv: ENV_141, candidate: pageWithEdgeNoise() });
    const [r] = compareAll({ projectRoot: root, reportDir });
    expect(r.status).toBe('changed');
    expect(r.dom).toMatchObject({ changed: false, noiseHint: true, styleCheck: 'match' });
    expect(r.environment).toEqual({
      delta: ['browser.version'],
      renderingDelta: ['browser.version'],
      baseline: ENV_130,
      candidate: ENV_141,
    });
  });

  it('nothing recorded on one side: no environment field (unknown, not a change)', () => {
    writeSnapshot('old-baseline', { candidateEnv: ENV_141 });
    writeSnapshot('old-adapter', { baselineEnv: ENV_130 });
    const results = compareAll({ projectRoot: root, reportDir });
    for (const r of results) expect(r.environment).toBeUndefined();
  });

  describe('warn (the default) never changes a status', () => {
    it('byte-identical with a browser bump: passed, and the delta is recorded', () => {
      writeSnapshot('home', { baselineEnv: ENV_130, candidateEnv: ENV_141 });
      const [r] = compareAll({ projectRoot: root, reportDir });
      expect(r.status).toBe('passed');
      expect(r.environment?.renderingDelta).toEqual(['browser.version']);
      expect(r.environment?.policy).toBeUndefined();
    });

    it('noiseAutoPass still auto-passes drift within its tolerance', () => {
      writeSnapshot('home', { baselineEnv: ENV_130, candidateEnv: ENV_141, candidate: pageWithEdgeNoise() });
      const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: { noiseAutoPass: true } });
      expect(r.status).toBe('passed');
      expect(r.autoPassed).toBe('noise');
    });
  });

  describe('strict', () => {
    it('byte-identical with a browser bump: changed, marked as the policy, and exit 1 with the gate', () => {
      writeConfig({ environmentPolicy: 'strict' });
      writeSnapshot('home', { baselineEnv: ENV_130, candidateEnv: ENV_141 });
      const data = generateReport({ projectRoot: root, autoOpen: false });
      const [r] = data.snapshots;
      expect(r.status).toBe('changed');
      expect(r.diffPercent).toBe(0);
      expect(r.environment).toMatchObject({ renderingDelta: ['browser.version'], policy: 'strict' });
      expect(data.summary).toMatchObject({ changed: 1, passed: 0 });
      expect(reportExitCode(data.summary, { gate: true })).toBe(1);
    });

    it('never auto-passed by a tolerance, noiseAutoPass included', () => {
      writeSnapshot('home', { baselineEnv: ENV_130, candidateEnv: ENV_141, candidate: pageWithEdgeNoise() });
      const [r] = compareAll({
        projectRoot: root,
        reportDir,
        environmentPolicy: 'strict',
        passCriteria: { noiseAutoPass: true, maxDiffPercent: 50 },
      });
      expect(r.status).toBe('changed');
      expect(r.autoPassed).toBeUndefined();
    });

    it('a context-only change (a framework patch) does not trip it', () => {
      writeSnapshot('home', { baselineEnv: ENV_130, candidateEnv: ENV_130_NEW_FRAMEWORK });
      const [r] = compareAll({ projectRoot: root, reportDir, environmentPolicy: 'strict' });
      expect(r.status).toBe('passed');
      expect(r.environment).toMatchObject({ delta: ['framework.version'], renderingDelta: [] });
      expect(r.environment?.policy).toBeUndefined();
    });

    it('a baseline without a recorded environment is not a change', () => {
      writeSnapshot('home', { candidateEnv: ENV_141 });
      const [r] = compareAll({ projectRoot: root, reportDir, environmentPolicy: 'strict' });
      expect(r.status).toBe('passed');
    });
  });

  it('results.json carries the run-level environment: what every capture agrees on, new ones included', () => {
    writeSnapshot('home', { baselineEnv: ENV_130, candidateEnv: ENV_141 });
    const tNew = path.join(root, '.testivai', 'temp', 'pricing');
    fs.mkdirSync(tNew, { recursive: true });
    fs.writeFileSync(path.join(tNew, 'screenshot.png'), encodePng(page(), W, H));
    const firefox: CaptureEnvironment = { ...ENV_141, browser: { name: 'firefox', version: '143.0' } };
    fs.writeFileSync(path.join(tNew, 'metadata.json'), JSON.stringify({ environment: firefox }));

    generateReport({ projectRoot: root, autoOpen: false });
    const written = JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8'));
    expect(written.version).toBe('2.8.0');
    // The two browsers share no field (the Firefox capture records no
    // headless flag), so there is no browser section.
    expect(written.environment).toEqual({
      os: ENV_141.os,
      framework: ENV_141.framework,
      adapter: ENV_141.adapter,
      render: ENV_141.render,
    });
  });

  it('no capture recorded an environment: no run-level block', () => {
    writeSnapshot('home', {});
    generateReport({ projectRoot: root, autoOpen: false });
    const written = JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8'));
    expect(written.environment).toBeUndefined();
  });

  describe('separate: other environments are not missing', () => {
    function baselineOnly(name: string) {
      const bDir = path.join(root, '.testivai', 'baselines', name);
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(path.join(bDir, 'screenshot.png'), encodePng(page(), W, H));
    }

    it('only baselines of an environment this run captured can be missing', () => {
      writeConfig({ environmentPolicy: 'separate' });
      writeSnapshot('home__chromium__linux', { baselineEnv: ENV_130, candidateEnv: ENV_130 });
      baselineOnly('home__chromium__darwin'); // another platform: not this run's
      baselineOnly('home__firefox__linux'); // another browser: not this run's
      baselineOnly('pricing__chromium__linux'); // this run's environment, not captured: missing
      baselineOnly('legacy'); // keyed before separate was turned on: never captured again, missing

      const data = generateReport({ projectRoot: root, autoOpen: false });
      expect(data.missingBaselines?.sort()).toEqual(['legacy', 'pricing__chromium__linux']);
    });

    it('under warn every uncaptured baseline is missing, as before', () => {
      writeSnapshot('home__chromium__linux', {});
      baselineOnly('home__chromium__darwin');
      const data = generateReport({ projectRoot: root, autoOpen: false });
      expect(data.missingBaselines).toEqual(['home__chromium__darwin']);
    });
  });
});
