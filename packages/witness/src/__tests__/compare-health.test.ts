/**
 * compareAll() with capture health: what failed to load in the baseline's and
 * the current capture's metadata.json (`health`), read side by side.
 *
 * An unhealthy side is never render noise: with an identical DOM and matching
 * styles, a font that fell back or a stylesheet that 404'd leaves a small,
 * scattered diff that used to auto-pass under noiseAutoPass. Health recorded
 * on neither side changes nothing: results.json stays byte-identical.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BaselineStore } from '../baselines/store';
import type { CaptureHealth } from '../capture/health';
import { applyPassCriteria, compareAll } from '../report/compare';
import { generateReport, RESULTS_SCHEMA_VERSION } from '../report/generator';
import type { SnapshotResult } from '../report/results';
import { BLUE, encodePng, paintRect, solidRgba } from './helpers/synth';
import { writeNoHealthProject } from './helpers/no-health-project';

const W = 200;
const H = 100;

const HEALTHY: CaptureHealth = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};
const FONT_FAILED: CaptureHealth = {
  ...HEALTHY,
  fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: 'normal', style: 'normal' }] },
  resources: { status: 'checked', failed: { font: { count: 1, entries: [{ url: 'example.com/fonts/fancy.woff2', status: 404 }] } } },
};
const CSS_FAILED: CaptureHealth = {
  ...HEALTHY,
  stylesheets: { failed: 1, urls: ['example.com/css/site.css'] },
  resources: { status: 'checked', failed: { css: { count: 1, entries: [{ url: 'example.com/css/site.css', status: 404 }] } } },
};
const IMAGE_BROKEN: CaptureHealth = { ...HEALTHY, images: { broken: 1, urls: ['example.com/img/hero.png'] } };

const ENV = {
  os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' },
  browser: { name: 'chromium', version: '130.0.6723.58', headless: true },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.5', captureMethod: 'full-page:cdp' },
};
const ENV_141 = { ...ENV, browser: { ...ENV.browser, version: '141.0.7390.37' } };

const page = (): Uint8ClampedArray => {
  const data = solidRgba(W, H);
  paintRect(data, W, H, { x: 20, y: 20, width: 120, height: 40 }, BLUE);
  return data;
};

/** Glyph edges redrawn by a fallback font: 30 isolated pixels, small and scattered. */
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

/** One pixel nudged far below the diff threshold: byte-different, no pixel flagged. */
const pageNudged = (): Uint8ClampedArray => {
  const data = page();
  data[0] = 254;
  return data;
};

const HTML = '<html><body><main><div class="card">Card</div></main></body></html>';
const ELEMENTS = JSON.stringify([{ path: 'body > main > div.card', x: 20, y: 20, width: 120, height: 40, styleHash: 'aaaa1111' }]);

describe('compareAll with capture health', () => {
  let root: string;
  let reportDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-compare-health-'));
    reportDir = path.join(root, 'visual-report');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Baseline + capture, identical DOM and element maps; health and environment per side (undefined = not recorded). */
  function writeSnapshot(
    name: string,
    opts: { baselineHealth?: CaptureHealth; candidateHealth?: CaptureHealth; candidate?: Uint8ClampedArray; baselineEnv?: object; candidateEnv?: object },
  ) {
    const bDir = path.join(root, '.testivai', 'baselines', name);
    const tDir = path.join(root, '.testivai', 'temp', name);
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(path.join(bDir, 'screenshot.png'), encodePng(page(), W, H));
    fs.writeFileSync(path.join(tDir, 'screenshot.png'), encodePng(opts.candidate ?? pageWithEdgeNoise(), W, H));
    for (const dir of [bDir, tDir]) {
      fs.writeFileSync(path.join(dir, 'dom.html'), HTML);
      fs.writeFileSync(path.join(dir, 'elements.json'), ELEMENTS);
    }
    const now = '2026-10-01T00:00:00.000Z';
    fs.writeFileSync(
      path.join(bDir, 'metadata.json'),
      JSON.stringify({
        name,
        createdAt: now,
        updatedAt: now,
        ...(opts.baselineEnv ? { environment: opts.baselineEnv } : {}),
        ...(opts.baselineHealth ? { health: opts.baselineHealth } : {}),
      }),
    );
    fs.writeFileSync(
      path.join(tDir, 'metadata.json'),
      JSON.stringify({ name, ...(opts.candidateEnv ? { environment: opts.candidateEnv } : {}), ...(opts.candidateHealth ? { health: opts.candidateHealth } : {}) }),
    );
  }

  const noise = { noiseAutoPass: true };

  it("an unhealthy current capture with an identical DOM: 'candidate', no noise hint, changed even with noiseAutoPass", () => {
    writeSnapshot('home', { baselineHealth: HEALTHY, candidateHealth: FONT_FAILED });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
    expect(r.dom).toEqual({ changed: false, summary: null, noiseHint: false, styleCheck: 'match' });
    expect(r.captureHealth).toEqual({
      candidate: FONT_FAILED,
      baseline: HEALTHY,
      unhealthy: 'candidate',
      reasons: [
        "web font 'Fancy' failed to load, so the page rendered with a fallback font",
        'font file example.com/fonts/fancy.woff2 returned 404',
      ],
      warnings: [],
    });
  });

  it('no pass criterion passes an unhealthy capture whose pixels differ: not the tolerances, not shiftTolerance', () => {
    writeSnapshot('home', { baselineHealth: HEALTHY, candidateHealth: CSS_FAILED });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: { ...noise, maxDiffPercent: 5, maxDiffPixels: 1000, shiftTolerance: 5 } });
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it("an unhealthy baseline: 'baseline', its reasons marked as the baseline's, changed", () => {
    writeSnapshot('home', { baselineHealth: CSS_FAILED, candidateHealth: HEALTHY });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.status).toBe('changed');
    expect(r.dom?.noiseHint).toBe(false);
    expect(r.captureHealth).toMatchObject({ unhealthy: 'baseline', reasons: ['baseline: stylesheet example.com/css/site.css returned 404'] });
  });

  it("both unhealthy: 'both'", () => {
    writeSnapshot('home', { baselineHealth: CSS_FAILED, candidateHealth: FONT_FAILED });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.captureHealth?.unhealthy).toBe('both');
    expect(r.status).toBe('changed');
  });

  it('unhealthy with identical bytes: passed by the existing rules, the health still recorded', () => {
    writeSnapshot('home', { baselineHealth: FONT_FAILED, candidateHealth: FONT_FAILED, candidate: page() });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.status).toBe('passed');
    expect(r.captureHealth?.unhealthy).toBe('both');
  });

  it('unhealthy with no pixel above the threshold: passed, the health still recorded', () => {
    writeSnapshot('home', { baselineHealth: HEALTHY, candidateHealth: FONT_FAILED, candidate: pageNudged() });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.diffCount).toBe(0);
    expect(r.status).toBe('passed');
    expect(r.autoPassed).toBeUndefined();
    expect(r.captureHealth?.unhealthy).toBe('candidate');
  });

  it('unhealthy and rendering drift together: both recorded, still not passed', () => {
    writeSnapshot('home', { baselineHealth: HEALTHY, candidateHealth: FONT_FAILED, baselineEnv: ENV, candidateEnv: ENV_141 });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.status).toBe('changed');
    expect(r.environment?.renderingDelta).toEqual(['browser.version']);
    expect(r.captureHealth?.unhealthy).toBe('candidate');
  });

  it('healthy on both sides: recorded, and the noise auto-pass is what it was', () => {
    writeSnapshot('home', { baselineHealth: HEALTHY, candidateHealth: HEALTHY });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.status).toBe('passed');
    expect(r.autoPassed).toBe('noise');
    expect(r.dom?.noiseHint).toBe(true);
    expect(r.captureHealth).toEqual({ candidate: HEALTHY, baseline: HEALTHY, unhealthy: null, reasons: [], warnings: [] });
  });

  it('a broken image alone is a warning: the noise auto-pass is what it was', () => {
    writeSnapshot('home', { baselineHealth: HEALTHY, candidateHealth: IMAGE_BROKEN });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.autoPassed).toBe('noise');
    expect(r.captureHealth).toMatchObject({ unhealthy: null, warnings: ['image example.com/img/hero.png did not load'] });
  });

  it('health recorded on one side only: that side is judged', () => {
    writeSnapshot('home', { candidateHealth: FONT_FAILED });
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.captureHealth).toEqual({ candidate: FONT_FAILED, unhealthy: 'candidate', reasons: expect.any(Array), warnings: [] });
    expect(r.status).toBe('changed');
  });

  it('malformed health is not checked: no field, nothing changes', () => {
    writeSnapshot('home', { baselineHealth: HEALTHY });
    fs.writeFileSync(path.join(root, '.testivai', 'temp', 'home', 'metadata.json'), JSON.stringify({ name: 'home', health: { fonts: 'broken' } }));
    const [r] = compareAll({ projectRoot: root, reportDir, passCriteria: noise });
    expect(r.captureHealth).toEqual({ baseline: HEALTHY, unhealthy: null, reasons: [], warnings: [] });
    expect(r.autoPassed).toBe('noise');
  });

  it('a first capture records its own health: an unhealthy one is said before anyone approves it', () => {
    const tDir = path.join(root, '.testivai', 'temp', 'fresh');
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(path.join(tDir, 'screenshot.png'), encodePng(page(), W, H));
    fs.writeFileSync(path.join(tDir, 'metadata.json'), JSON.stringify({ name: 'fresh', health: FONT_FAILED }));
    const [r] = compareAll({ projectRoot: root, reportDir });
    expect(r.status).toBe('new');
    expect(r.captureHealth).toMatchObject({ candidate: FONT_FAILED, unhealthy: 'candidate' });
  });

  it('no health on either side: results.json byte-identical to the one written before capture health', () => {
    writeNoHealthProject(root);
    const data = generateReport({ projectRoot: root, autoOpen: false });
    const { timestamp: _timestamp, ...rest } = data;
    const golden = fs
      .readFileSync(path.join(__dirname, 'fixtures', 'no-health.results.json'), 'utf-8')
      // The schema version is the one field that moves with the release.
      .replace('"version": "2.5.0"', `"version": "${RESULTS_SCHEMA_VERSION}"`);
    expect(`${JSON.stringify(rest, null, 2)}\n`).toBe(golden);
  });
});

describe('BaselineStore.approve freezes capture health', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-approve-health-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("copies the capture's health into the baseline's metadata.json", () => {
    const store = new BaselineStore(root);
    store.writeTemp('home', encodePng(page(), W, H));
    store.writeTempMetadata('home', { name: 'home', health: CSS_FAILED });
    store.approve('home');
    expect(store.readMetadata('home')?.health).toEqual(CSS_FAILED);
  });

  it('a capture without health leaves the baseline without one (not the previous baseline’s)', () => {
    const store = new BaselineStore(root);
    store.writeTemp('home', encodePng(page(), W, H));
    store.writeTempMetadata('home', { name: 'home', health: CSS_FAILED });
    store.approve('home');
    store.clearTemp();
    store.writeTemp('home', encodePng(page(), W, H));
    store.approve('home');
    expect(store.readMetadata('home')?.health).toBeUndefined();
  });
});

describe('applyPassCriteria with capture health', () => {
  const base = (): SnapshotResult => ({
    name: 'home',
    status: 'changed',
    diffPercent: 0.15,
    diffCount: 30,
    totalPixels: 20000,
    dom: { changed: false, summary: null, noiseHint: true, styleCheck: 'match' },
  });

  it('refuses every criterion for an unhealthy capture whose pixels differ, even with a stale noise hint', () => {
    const r = { ...base(), captureHealth: { unhealthy: 'candidate' as const, reasons: [], warnings: [] } };
    applyPassCriteria(r, { noiseAutoPass: true, maxDiffPercent: 1 });
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it('passes the same diff when no side is unhealthy', () => {
    const r = { ...base(), captureHealth: { unhealthy: null, reasons: [], warnings: [] } };
    applyPassCriteria(r, { noiseAutoPass: true });
    expect(r.autoPassed).toBe('noise');
  });
});
