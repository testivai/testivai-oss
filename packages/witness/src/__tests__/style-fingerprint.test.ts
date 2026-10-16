/**
 * Computed-style fingerprint — closes the documented false negative:
 * a stylesheet-only change (identical DOM, different pixels) used to earn
 * a "likely render noise" hint. With element maps on both sides, the
 * noise hint now requires the style digests to match too; a mismatch
 * becomes an explicit, attributed "styles changed" signal.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compareStyleHashes } from '../diff/attribution';
import { compareAll } from '../report/compare';
import { renderHtml } from '../report/template';
import { makePng, RED, BLUE } from './helpers/synth';

const el = (path_: string, styleHash: string) => ({
  path: path_, x: 0, y: 0, width: 100, height: 40, styleHash,
});

describe('compareStyleHashes (unit)', () => {
  it('match when all common paths share digests', () => {
    const r = compareStyleHashes(
      [el('body > a', '1111'), el('body > b', '2222')],
      [el('body > a', '1111'), el('body > b', '2222')],
    );
    expect(r.status).toBe('match');
    expect(r.changed).toEqual([]);
  });

  it('mismatch lists the changed element paths', () => {
    const r = compareStyleHashes(
      [el('body > a', '1111'), el('body > b', '2222')],
      [el('body > a', '9999'), el('body > b', '2222')],
    );
    expect(r.status).toBe('mismatch');
    expect(r.changed).toEqual(['body > a']);
  });

  it('unavailable when either side has no map', () => {
    expect(compareStyleHashes([], [el('body > a', '1')]).status).toBe('unavailable');
    expect(compareStyleHashes([el('body > a', '1')], []).status).toBe('unavailable');
  });

  it('paths present on only one side are ignored (structure is the DOM diff\'s job)', () => {
    const r = compareStyleHashes(
      [el('body > a', '1111')],
      [el('body > a', '1111'), el('body > b', '2222')],
    );
    expect(r.status).toBe('match');
  });
});

describe('compareAll with style fingerprints (integration)', () => {
  let root: string;
  let reportDir: string;
  const W = 200;
  const H = 150;
  const DOM = '<html><head></head><body><button class="cta">Buy</button></body></html>';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-stylefp-'));
    reportDir = path.join(root, 'visual-report');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeSnapshot(
    name: string,
    opts: {
      baselineHash?: string;
      candidateHash?: string;
      withMaps?: boolean;
      /** Isolated single pixels spread over the page (the render-noise shape) instead of one solid block. */
      specks?: boolean;
    } = {},
  ) {
    const { baselineHash = 'aaaa', candidateHash = 'aaaa', withMaps = true, specks = false } = opts;
    const bDir = path.join(root, '.testivai', 'baselines', name);
    const tDir = path.join(root, '.testivai', 'temp', name);
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(tDir, { recursive: true });
    // Same DOM both sides; different pixels (the stylesheet-change shape, or scattered specks)
    const rects = specks
      ? Array.from({ length: 24 }, (_, i) => ({ x: 8 + (i % 6) * 36, y: 8 + Math.floor(i / 6) * 36, width: 1, height: 1 }))
      : [{ x: 20, y: 20, width: 100, height: 40 }];
    fs.writeFileSync(path.join(bDir, 'screenshot.png'),
      makePng(W, H, undefined, rects.map((rect) => ({ rect, color: BLUE }))));
    fs.writeFileSync(path.join(tDir, 'screenshot.png'),
      makePng(W, H, undefined, rects.map((rect) => ({ rect, color: RED }))));
    fs.writeFileSync(path.join(bDir, 'dom.html'), DOM);
    fs.writeFileSync(path.join(tDir, 'dom.html'), DOM);
    if (withMaps) {
      const map = (h: string) => [
        { path: 'body', x: 0, y: 0, width: W, height: H, styleHash: 'ffff' },
        { path: 'body > button.cta', x: 20, y: 20, width: 100, height: 40, styleHash: h },
      ];
      fs.writeFileSync(path.join(bDir, 'elements.json'), JSON.stringify(map(baselineHash)));
      fs.writeFileSync(path.join(tDir, 'elements.json'), JSON.stringify(map(candidateHash)));
    }
  }

  it('THE benchmark case: stylesheet-only change is no longer called noise', () => {
    writeSnapshot('color-swap', { baselineHash: 'aaaa', candidateHash: 'bbbb' });

    const [result] = compareAll({ projectRoot: root, reportDir });
    expect(result.status).toBe('changed');
    expect(result.dom!.noiseHint).toBe(false); // the false negative, closed
    expect(result.dom!.styleCheck).toBe('mismatch');
    expect(result.dom!.styleChanges).toEqual({
      count: 1,
      elements: ['body > button.cta'],
    });
  });

  it('noiseAutoPass never auto-passes a style mismatch', () => {
    writeSnapshot('no-autopass', { baselineHash: 'aaaa', candidateHash: 'bbbb' });

    const [result] = compareAll({
      projectRoot: root,
      reportDir,
      passCriteria: { noiseAutoPass: true, noiseMaxDiffPercent: 100 },
    });
    expect(result.status).toBe('changed'); // stays changed
    expect(result.autoPassed).toBeUndefined();
  });

  // Render noise is scattered pixels. A solid block that changed colour with
  // matching digests is concentrated in one area, not noise: it stays changed
  // (style-check-semantics.test.ts).
  it('true render noise (digests match, scattered pixels) keeps the hint and auto-pass path', () => {
    writeSnapshot('true-noise', { baselineHash: 'aaaa', candidateHash: 'aaaa', specks: true });

    const [result] = compareAll({
      projectRoot: root,
      reportDir,
      passCriteria: { noiseAutoPass: true, noiseMaxDiffPercent: 100 },
    });
    expect(result.dom!.styleCheck).toBe('match');
    expect(result.autoPassed).toBe('noise');
  });

  it('without element maps the hint fires with styleCheck unavailable (legacy behavior, labeled)', () => {
    writeSnapshot('legacy', { withMaps: false });

    const [result] = compareAll({ projectRoot: root, reportDir });
    expect(result.dom!.noiseHint).toBe(true);
    expect(result.dom!.styleCheck).toBe('unavailable');
  });

  it('the report names the restyled element', () => {
    writeSnapshot('report-words', { baselineHash: 'aaaa', candidateHash: 'bbbb' });
    const [result] = compareAll({ projectRoot: root, reportDir });
    const html = renderHtml({
      version: '2.2.0',
      timestamp: new Date().toISOString(),
      summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
      snapshots: [result],
    });
    expect(html).toContain('Styles changed');
    expect(html).toContain('button.cta');
  });
});
