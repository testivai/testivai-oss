/**
 * Integration: compareAll() with masks + region clustering — the full
 * pipeline over the on-disk contract, using synthetic PNG fixtures only.
 *
 * Also proves shared constraint: everything here runs with image-only
 * input (no dom.html); selector masks degrade to a warning when no
 * metadata was captured.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compareAll } from '../report/compare';
import { generateResults, RESULTS_SCHEMA_VERSION } from '../report/generator';
import { makePng, RED, BLUE } from './helpers/synth';

const W = 120;
const H = 90;

describe('compareAll with masks and regions', () => {
  let root: string;
  let reportDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-compare-mask-'));
    reportDir = path.join(root, 'visual-report');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeSnapshot(name: string, baseline: Buffer, candidate: Buffer, metadata?: object) {
    const bDir = path.join(root, '.testivai', 'baselines', name);
    const tDir = path.join(root, '.testivai', 'temp', name);
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(path.join(bDir, 'screenshot.png'), baseline);
    fs.writeFileSync(path.join(tDir, 'screenshot.png'), candidate);
    if (metadata) {
      fs.writeFileSync(path.join(tDir, 'metadata.json'), JSON.stringify(metadata));
    }
  }

  it('geometric config mask suppresses the diff and is recorded in the result', () => {
    writeSnapshot(
      'masked',
      makePng(W, H),
      makePng(W, H, undefined, [{ rect: { x: 10, y: 10, width: 20, height: 20 }, color: RED }]),
    );

    const [result] = compareAll({
      projectRoot: root,
      reportDir,
      mask: [{ x: 0, y: 0, width: 40, height: 40 }],
    });

    expect(result.status).toBe('passed');
    expect(result.masks).toHaveLength(1);
    expect(result.masks![0]).toMatchObject({ x: 0, y: 0, width: 40, height: 40 });
  });

  it('diff outside the mask stays changed, with clustered regions in the result', () => {
    writeSnapshot(
      'partly-masked',
      makePng(W, H),
      makePng(W, H, undefined, [
        { rect: { x: 5, y: 5, width: 10, height: 10 }, color: RED },   // masked
        { rect: { x: 60, y: 40, width: 25, height: 20 }, color: BLUE }, // real
      ]),
    );

    const [result] = compareAll({
      projectRoot: root,
      reportDir,
      mask: [{ x: 0, y: 0, width: 30, height: 30 }],
    });

    expect(result.status).toBe('changed');
    expect(result.regions).toHaveLength(1);
    expect(result.regions![0]).toMatchObject({ x: 60, y: 40, width: 25, height: 20 });
  });

  it('per-call masks and captured selector rects come from temp metadata', () => {
    writeSnapshot(
      'via-metadata',
      makePng(W, H),
      makePng(W, H, undefined, [
        { rect: { x: 0, y: 0, width: 12, height: 12 }, color: RED },   // covered by selector rect
        { rect: { x: 100, y: 70, width: 10, height: 10 }, color: RED }, // covered by per-call region
      ]),
      {
        masks: [{ x: 96, y: 66, width: 20, height: 20 }],
        maskRects: [{ selector: '#banner', x: 0, y: 0, width: 16, height: 16 }],
        maskSelectors: ['#banner'],
      },
    );

    const [result] = compareAll({ projectRoot: root, reportDir });

    expect(result.status).toBe('passed');
    expect(result.masks).toHaveLength(2);
    const selectorMask = result.masks!.find((m) => m.source.type === 'selector');
    expect(selectorMask).toBeDefined();
    expect(selectorMask!.source.spec).toBe('#banner');
  });

  it('selector mask with no captured rects warns, never throws (image-only degradation)', () => {
    writeSnapshot('warns', makePng(W, H), makePng(W, H)); // no metadata at all

    const [result] = compareAll({
      projectRoot: root,
      reportDir,
      mask: ['#banner'],
    });

    expect(result.maskWarnings).toHaveLength(1);
    expect(result.maskWarnings![0]).toMatch(/#banner/);
  });

  it('regions honor diffRegions tunables from options', () => {
    writeSnapshot(
      'tunables',
      makePng(W, H),
      makePng(W, H, undefined, [
        { rect: { x: 10, y: 10, width: 12, height: 12 }, color: RED },
        { rect: { x: 28, y: 10, width: 12, height: 12 }, color: RED }, // 6px gap
      ]),
    );

    const [merged] = compareAll({
      projectRoot: root,
      reportDir,
      diffRegions: { minSize: 10, mergeDistance: 8 },
    });
    expect(merged.regions).toHaveLength(1);

    const [split] = compareAll({
      projectRoot: root,
      reportDir,
      diffRegions: { minSize: 10, mergeDistance: 2 },
    });
    expect(split.regions).toHaveLength(2);
  });

  it('results.json carries the current schema version with regions and masks', () => {
    writeSnapshot(
      'schema',
      makePng(W, H),
      makePng(W, H, undefined, [{ rect: { x: 40, y: 40, width: 20, height: 20 }, color: RED }]),
    );

    const results = compareAll({ projectRoot: root, reportDir });
    fs.mkdirSync(reportDir, { recursive: true });
    generateResults(results, reportDir);

    const written = JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8'));
    expect(written.version).toBe(RESULTS_SCHEMA_VERSION);
    expect(written.snapshots[0].regions).toBeDefined();
  });

  it('back-compat: no mask/diffRegions options behaves exactly as before', () => {
    writeSnapshot(
      'legacy',
      makePng(W, H),
      makePng(W, H, undefined, [{ rect: { x: 40, y: 40, width: 20, height: 20 }, color: RED }]),
    );

    const [result] = compareAll({ projectRoot: root, reportDir });
    expect(result.status).toBe('changed');
    expect(result.diffCount).toBeGreaterThan(0);
    // regions now come along by default (additive), masks/warnings absent
    expect(result.masks).toBeUndefined();
    expect(result.maskWarnings).toBeUndefined();
  });
});
