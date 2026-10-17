/**
 * compareAll() when the candidate's dimensions differ from the baseline's.
 *
 * The defect (reproduced 2026-10-16): a capture TALLER than its baseline
 * passed with 0% although content was added, because the diff canvas was
 * sized to the baseline and the candidate truncated to it. A capture of a
 * different WIDTH misaligned every row and produced a nonsense diff. Now the
 * two are padded to max width × max height, every padded pixel counts as
 * changed, the result records `sizeMismatch`, and no pass criterion passes
 * a snapshot whose size or DOM changed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import { applyPassCriteria, compareAll } from '../report/compare';
import { generateResults, RESULTS_SCHEMA_VERSION } from '../report/generator';
import { renderHtml } from '../report/template';
import type { ReportData, SnapshotResult } from '../report/results';
import { BLACK, BLUE, encodePng, makePng, paintRect, RED, solidRgba, type RGBA } from './helpers/synth';

const FIXTURES = path.join(__dirname, 'fixtures', 'size-mismatch');

describe('compareAll with a size mismatch', () => {
  let root: string;
  let reportDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-compare-size-'));
    reportDir = path.join(root, 'visual-report');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeSnapshot(
    name: string,
    baseline: Buffer,
    candidate: Buffer,
    dom?: { baseline: string; candidate: string },
  ): void {
    const bDir = path.join(root, '.testivai', 'baselines', name);
    const tDir = path.join(root, '.testivai', 'temp', name);
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(path.join(bDir, 'screenshot.png'), baseline);
    fs.writeFileSync(path.join(tDir, 'screenshot.png'), candidate);
    if (dom) {
      fs.writeFileSync(path.join(bDir, 'dom.html'), dom.baseline);
      fs.writeFileSync(path.join(tDir, 'dom.html'), dom.candidate);
    }
  }

  const readDiffPng = (name: string) => PNG.sync.read(fs.readFileSync(path.join(reportDir, 'images', name, 'diff.png')));

  // A page: white, with one blue "card" per 100px row band.
  const cards = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ rect: { x: 20, y: 20 + i * 100, width: 160, height: 60 }, color: BLUE }));

  it('(a) a taller candidate with an identical overlap is changed, with every added row counted', () => {
    // Baseline: 3 cards in 300px. Candidate: a 4th card appended → 400px.
    writeSnapshot('taller', makePng(200, 300, undefined, cards(3)), makePng(200, 400, undefined, cards(4)));

    const [result] = compareAll({ projectRoot: root, reportDir });

    expect(result.status).toBe('changed');
    expect(result.autoPassed).toBeUndefined();
    expect(result.sizeMismatch).toEqual({
      baseline: { width: 200, height: 300 },
      candidate: { width: 200, height: 400 },
    });
    // The canvas is the larger size and the whole added band is a change.
    expect(result.totalPixels).toBe(200 * 400);
    expect(result.diffCount).toBe(200 * 100);
    expect(result.diffPercent).toBeCloseTo(25, 5);
    expect(result.regions).toEqual([expect.objectContaining({ x: 0, y: 300, width: 200, height: 100 })]);

    const diffPng = readDiffPng('taller');
    expect([diffPng.width, diffPng.height]).toEqual([200, 400]);
  });

  it('(b) a shorter candidate is changed, with the missing rows counted', () => {
    writeSnapshot('shorter', makePng(200, 400, undefined, cards(4)), makePng(200, 300, undefined, cards(3)));

    const [result] = compareAll({ projectRoot: root, reportDir });

    expect(result.status).toBe('changed');
    expect(result.sizeMismatch).toEqual({
      baseline: { width: 200, height: 400 },
      candidate: { width: 200, height: 300 },
    });
    expect(result.totalPixels).toBe(200 * 400);
    expect(result.diffCount).toBe(200 * 100);
    expect(result.regions).toEqual([expect.objectContaining({ x: 0, y: 300, width: 200, height: 100 })]);
  });

  it('(c) a wider candidate does not misalign rows: the only changed region is the right-hand strip', () => {
    writeSnapshot('wider', makePng(200, 300, undefined, cards(3)), makePng(260, 300, undefined, cards(3)));

    const [result] = compareAll({ projectRoot: root, reportDir });

    expect(result.status).toBe('changed');
    expect(result.sizeMismatch).toEqual({
      baseline: { width: 200, height: 300 },
      candidate: { width: 260, height: 300 },
    });
    expect(result.totalPixels).toBe(260 * 300);
    expect(result.diffCount).toBe(60 * 300);
    expect(result.regions).toHaveLength(1);
    expect(result.regions![0]).toMatchObject({ x: 200, y: 0, width: 60, height: 300 });

    // Inside the overlap the diff image is the washed background, never heat:
    // the cards sit at the same pixels on both sides.
    const diffPng = readDiffPng('wider');
    expect([diffPng.width, diffPng.height]).toEqual([260, 300]);
    const px = (x: number, y: number) => {
      const i = (y * diffPng.width + x) * 4;
      return [diffPng.data[i], diffPng.data[i + 1], diffPng.data[i + 2]];
    };
    const [r, g, b] = px(50, 50); // on a card, in the overlap
    expect(r).toBe(g);
    expect(g).toBe(b); // grayscale wash, not red/yellow heat
    const [sr, , sb] = px(230, 150); // in the strip: heat (yellow → red), not the wash
    expect(sr).toBeGreaterThanOrEqual(211);
    expect(sb).toBeLessThan(60);
  });

  it('(d) equal sizes keep their behaviour: identical bytes take the fast path, a real diff has no sizeMismatch', () => {
    const page = makePng(200, 300, undefined, cards(3));
    writeSnapshot('same', page, Buffer.from(page));
    writeSnapshot('same-changed', page, makePng(200, 300, undefined, [...cards(3), { rect: { x: 100, y: 250, width: 20, height: 20 }, color: RED }]));

    const results = compareAll({ projectRoot: root, reportDir });
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    expect(byName.same.status).toBe('passed');
    expect(byName.same.totalPixels).toBe(0); // byte-identical fast path: nothing decoded
    expect(byName.same.diffPath).toBeUndefined();
    expect(byName.same.sizeMismatch).toBeUndefined();

    expect(byName['same-changed'].status).toBe('changed');
    expect(byName['same-changed'].sizeMismatch).toBeUndefined();
    expect(byName['same-changed'].diffCount).toBe(400);
  });

  it('(e) a zero-count diff whose DOM changed stays changed; with an identical DOM it still passes', () => {
    // Same pixels, different bytes (another deflate level) → decode equal,
    // diffCount 0. The DOM decides.
    const data = solidRgba(200, 300);
    for (const { rect, color } of cards(3)) paintRect(data, 200, 300, rect, color);
    const baseline = encodePng(data, 200, 300);
    const png = new PNG({ width: 200, height: 300 });
    png.data = Buffer.from(data.buffer, data.byteOffset, data.length);
    const candidate = PNG.sync.write(png, { deflateLevel: 0 });
    expect(candidate.equals(baseline)).toBe(false);

    const nine = fs.readFileSync(path.join(FIXTURES, 'nine-cards.dom.html'), 'utf-8');
    const ten = fs.readFileSync(path.join(FIXTURES, 'ten-cards.dom.html'), 'utf-8');
    writeSnapshot('dom-changed', baseline, candidate, { baseline: nine, candidate: ten });
    writeSnapshot('dom-same', baseline, candidate, { baseline: nine, candidate: nine });

    const results = compareAll({ projectRoot: root, reportDir });
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    expect(byName['dom-changed'].diffCount).toBe(0);
    expect(byName['dom-changed'].dom?.changed).toBe(true);
    expect(byName['dom-changed'].status).toBe('changed');
    expect(byName['dom-changed'].autoPassed).toBeUndefined();

    expect(byName['dom-same'].diffCount).toBe(0);
    expect(byName['dom-same'].dom?.changed).toBe(false);
    expect(byName['dom-same'].status).toBe('passed');
  });

  describe('the reproduced scenario: nine cards at 1280×2348, a tenth appended → 1280×2538', () => {
    const W = 1280;
    const BASE_H = 2348;
    const CUR_H = 2538;
    // One card per 190px band, stacked up from the bottom of the nine-card
    // page, so the appended tenth card lies entirely in the added 190px and
    // the overlap of the two captures is pixel-identical — the case that
    // passed at 0% when the candidate was truncated to the baseline.
    const CARD_H = 190;
    const FIRST_CARD_Y = BASE_H - 9 * CARD_H; // 638
    const page = (count: number, height: number): Buffer => {
      const data = solidRgba(W, height);
      paintRect(data, W, height, { x: 0, y: 0, width: W, height: 120 }, BLACK); // header
      for (let i = 0; i < count; i++) {
        paintRect(data, W, height, { x: 40, y: FIRST_CARD_Y + i * CARD_H + 20, width: 1200, height: 150 }, BLUE);
        paintRect(data, W, height, { x: 60, y: FIRST_CARD_Y + i * CARD_H + 40, width: 400, height: 40 }, [220, 220, 220, 255] as RGBA);
      }
      return encodePng(data, W, height);
    };

    let results: SnapshotResult[];
    let data: ReportData;
    let html: string;

    beforeEach(() => {
      writeSnapshot('products', page(9, BASE_H), page(10, CUR_H), {
        baseline: fs.readFileSync(path.join(FIXTURES, 'nine-cards.dom.html'), 'utf-8'),
        candidate: fs.readFileSync(path.join(FIXTURES, 'ten-cards.dom.html'), 'utf-8'),
      });
      results = compareAll({ projectRoot: root, reportDir, passCriteria: { noiseAutoPass: true, noiseMaxDiffPercent: 2 } });
      fs.mkdirSync(reportDir, { recursive: true });
      generateResults(results, reportDir);
      data = JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8'));
      html = renderHtml(data);
    });

    it('is reported as changed with the size change and the DOM additions, never passed', () => {
      const [products] = results;
      expect(products.status).toBe('changed');
      expect(products.autoPassed).toBeUndefined();
      expect(products.sizeMismatch).toEqual({
        baseline: { width: W, height: BASE_H },
        candidate: { width: W, height: CUR_H },
      });
      // The overlap is identical: the diff is exactly the added band.
      expect(products.diffCount).toBe(W * (CUR_H - BASE_H));
      expect(products.totalPixels).toBe(W * CUR_H);
      expect(products.regions).toEqual([expect.objectContaining({ x: 0, y: BASE_H, width: W, height: CUR_H - BASE_H })]);
      expect(products.dom).toMatchObject({
        changed: true,
        summary: { added: 4, removed: 0, attributeChanges: 0, textChanges: 2 },
      });
      expect(data.summary).toMatchObject({ total: 1, passed: 0, changed: 1 });
    });

    it('writes results.json at schema 2.4.0 with the sizeMismatch field', () => {
      expect(RESULTS_SCHEMA_VERSION).toBe('2.4.0');
      expect(data.version).toBe('2.4.0');
      expect(data.snapshots[0].sizeMismatch).toEqual({
        baseline: { width: 1280, height: 2348 },
        candidate: { width: 1280, height: 2538 },
      });
    });

    it('the report row shows the dimensions and the verdict says the page grew', () => {
      expect(html).toContain('baseline 1280×2348 → current 1280×2538 (+190 px)');
      expect(html).toMatch(/page grew 190 px/);
      expect(html).toMatch(/4 added/);
      expect(html).not.toMatch(/Likely render noise/);
    });
  });

  it('the report verdict for a width change names the viewport or device scale, not the page', () => {
    writeSnapshot('wide', makePng(200, 300, undefined, cards(3)), makePng(260, 300, undefined, cards(3)));
    const results = compareAll({ projectRoot: root, reportDir });
    fs.mkdirSync(reportDir, { recursive: true });
    generateResults(results, reportDir);
    const html = renderHtml(JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8')));

    expect(html).toContain('baseline 200×300 → current 260×300 (+60 px wide)');
    expect(html).toContain('width changed 200 → 260: viewport or device scale differs');
    expect(html).not.toMatch(/page grew|page shrank/);
  });
});

describe('applyPassCriteria never passes a size or DOM change', () => {
  const base = (): SnapshotResult => ({
    name: 's',
    status: 'changed',
    diffPercent: 0,
    diffCount: 0,
    totalPixels: 100000,
  });

  it('a zero-count diff with sizeMismatch stays changed', () => {
    const r = { ...base(), sizeMismatch: { baseline: { width: 10, height: 10 }, candidate: { width: 10, height: 12 } } };
    applyPassCriteria(r, {});
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it('sizeMismatch is not passed by maxDiffPercent, maxDiffPixels, noiseAutoPass or shiftTolerance', () => {
    const r: SnapshotResult = {
      ...base(),
      diffPercent: 0.5,
      diffCount: 500,
      sizeMismatch: { baseline: { width: 10, height: 10 }, candidate: { width: 10, height: 12 } },
      dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
      regions: [{ x: 0, y: 0, width: 10, height: 2, diffPixels: 20, diffPercent: 100, classification: 'shift', shift: { dx: 0, dy: 1 } }],
    };
    applyPassCriteria(r, { maxDiffPercent: 100, maxDiffPixels: 1000000, noiseAutoPass: true, noiseMaxDiffPercent: 100, shiftTolerance: 10 });
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it('a zero-count diff whose DOM changed stays changed', () => {
    const r: SnapshotResult = {
      ...base(),
      dom: { changed: true, noiseHint: false, summary: { added: 4, removed: 0, attributeChanges: 0, textChanges: 2 } },
    };
    applyPassCriteria(r, {});
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it('a DOM change is not passed by maxDiffPercent either', () => {
    const r: SnapshotResult = {
      ...base(),
      diffPercent: 0.2,
      diffCount: 200,
      dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } },
    };
    applyPassCriteria(r, { maxDiffPercent: 1 });
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it('a zero-count diff with no size or DOM change still passes (the fast path is kept)', () => {
    const r = base();
    applyPassCriteria(r, {});
    expect(r.status).toBe('passed');
  });
});
