/**
 * Tests for the TestivAI HTML Report Generator
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaselineStore } from '../baselines/store';
import { compareAll } from '../report/compare';
import { generateReport } from '../report/generator';
import { renderHtml } from '../report/template';
import type { ReportData } from '../report/results';

describe('Report Generator', () => {
  let tmpDir: string;
  let store: BaselineStore;
  let reportDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-report-'));
    store = new BaselineStore(tmpDir);
    reportDir = path.join(tmpDir, 'visual-report');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const FAKE_PNG_A = Buffer.from('aaaa-fake-png-baseline');
  const FAKE_PNG_B = Buffer.from('bbbb-fake-png-different');

  describe('T3.1 - compareAll() with no baselines', () => {
    it('should return all status "new" when no baselines exist', () => {
      store.writeTemp('homepage', FAKE_PNG_A);
      store.writeTemp('dashboard', FAKE_PNG_B);

      const results = compareAll({ projectRoot: tmpDir, reportDir, threshold: 0.1 });

      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.status).toBe('new');
        expect(r.currentPath).toBeTruthy();
      }
    });
  });

  describe('T3.2 - compareAll() with matching baselines', () => {
    it('should return all status "passed" when baselines match', () => {
      // Write identical baseline and temp
      store.write('homepage', FAKE_PNG_A);
      store.writeTemp('homepage', FAKE_PNG_A);

      const results = compareAll({ projectRoot: tmpDir, reportDir, threshold: 0.1 });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('passed');
      expect(results[0].diffPercent).toBe(0);
    });
  });

  describe('T3.3 - compareAll() with different baselines', () => {
    it('should return status "changed" with diff info', () => {
      store.write('homepage', FAKE_PNG_A);
      store.writeTemp('homepage', FAKE_PNG_B);

      const results = compareAll({ projectRoot: tmpDir, reportDir, threshold: 0.1 });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('changed');
      expect(results[0].baselinePath).toBeTruthy();
      expect(results[0].currentPath).toBeTruthy();
    });
  });

  describe('T3.4 - generateReport() creates files', () => {
    it('should create index.html and results.json', () => {
      store.writeTemp('homepage', FAKE_PNG_A);

      const data = generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
        version: '2.0.0',
      });

      const htmlPath = path.join(tmpDir, 'visual-report', 'index.html');
      const jsonPath = path.join(tmpDir, 'visual-report', 'results.json');

      expect(fs.existsSync(htmlPath)).toBe(true);
      expect(fs.existsSync(jsonPath)).toBe(true);
      expect(data.snapshots).toHaveLength(1);
    });
  });

  describe('T3.5 - results.json schema', () => {
    it('should have correct schema with version, summary, snapshots[]', () => {
      store.write('homepage', FAKE_PNG_A);
      store.writeTemp('homepage', FAKE_PNG_A);
      store.writeTemp('new-page', FAKE_PNG_B);

      generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
        version: '2.0.0',
      });

      const jsonPath = path.join(tmpDir, 'visual-report', 'results.json');
      const data: ReportData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

      expect(data.version).toBe('2.0.0');
      expect(data.timestamp).toBeTruthy();
      expect(data.summary).toBeDefined();
      expect(data.summary.total).toBe(2);
      expect(data.summary.passed).toBe(1);
      expect(data.summary.newSnapshots).toBe(1);
      expect(Array.isArray(data.snapshots)).toBe(true);
      expect(data.snapshots).toHaveLength(2);
    });
  });

  describe('T3.6 - HTML contains expected sections', () => {
    it('should contain Changed, New, Passed section headers', () => {
      store.write('homepage', FAKE_PNG_A);
      store.writeTemp('homepage', FAKE_PNG_B); // changed
      store.writeTemp('new-page', FAKE_PNG_A); // new

      // Add a passed one
      store.write('settings', FAKE_PNG_A);
      store.writeTemp('settings', FAKE_PNG_A); // passed

      generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
      });

      const html = fs.readFileSync(
        path.join(tmpDir, 'visual-report', 'index.html'),
        'utf-8',
      );

      expect(html).toContain('Changed');
      expect(html).toContain('New');
      expect(html).toContain('Passed');
      expect(html).toContain('TestivAI');
    });
  });

  describe('T3.7 - HTML includes approve command', () => {
    it('should include approve command with correct snapshot name', () => {
      store.writeTemp('login-page', FAKE_PNG_A);

      generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
      });

      const html = fs.readFileSync(
        path.join(tmpDir, 'visual-report', 'index.html'),
        'utf-8',
      );

      expect(html).toContain('npx testivai approve login-page');
      expect(html).toContain('copy-btn');
    });
  });

  describe('T3.8 - Empty temp directory', () => {
    it('should produce report with 0 snapshots without crash', () => {
      const data = generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
      });

      expect(data.snapshots).toHaveLength(0);
      expect(data.summary.total).toBe(0);

      const htmlPath = path.join(tmpDir, 'visual-report', 'index.html');
      expect(fs.existsSync(htmlPath)).toBe(true);

      const html = fs.readFileSync(htmlPath, 'utf-8');
      expect(html).toContain('No snapshots found');
    });
  });

  describe('T3.9 - OSS noise warning in HTML report', () => {
    it('should include the pixel-exact notice in the sidebar', () => {
      generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
      });

      const html = fs.readFileSync(
        path.join(tmpDir, 'visual-report', 'index.html'),
        'utf-8',
      );

      expect(html).toContain('oss-notice');
      expect(html).toContain('Pixel-exact');
      expect(html).toContain('collapse'); // variable-height noise tip
    });

    it('should mention threshold config option in the notice', () => {
      generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
      });

      const html = fs.readFileSync(
        path.join(tmpDir, 'visual-report', 'index.html'),
        'utf-8',
      );

      expect(html).toContain('threshold');
      expect(html).toContain('.testivai/config.json');
    });

    it('should mention ignoreSelectors config option in the notice', () => {
      generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
      });

      const html = fs.readFileSync(
        path.join(tmpDir, 'visual-report', 'index.html'),
        'utf-8',
      );

      expect(html).toContain('ignoreSelectors');
    });

    it('points agents at the MCP server instead of a hosted-service upsell', () => {
      generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
      });

      const html = fs.readFileSync(
        path.join(tmpDir, 'visual-report', 'index.html'),
        'utf-8',
      );

      expect(html).toContain('@testivai/mcp');
      expect(html).toContain('explain_snapshot');
      // The cloud upsell is gone from the report entirely.
      expect(html).not.toContain('TestivAI Cloud');
      expect(html).not.toContain('AI-powered');
    });

    it('should render the renderHtml template with OSS notice directly', () => {
      const data: ReportData = {
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        summary: { total: 0, passed: 0, changed: 0, newSnapshots: 0 },
        snapshots: [],
      };

      const html = renderHtml(data);

      expect(html).toContain('oss-notice');
      expect(html).toContain('Pixel-exact');
      expect(html).toContain('ignoreSelectors');
      expect(html).toContain('threshold');
      expect(html).toContain('@testivai/mcp');
    });
  });

  describe('pass criteria', () => {
    const { PNG } = require('pngjs');

    /** Build a WxH solid PNG, then let paint() recolor individual pixels. */
    const makePng = (
      w: number,
      h: number,
      base: [number, number, number],
      paint?: (data: Buffer) => void,
    ): Buffer => {
      const png = new PNG({ width: w, height: h });
      for (let i = 0; i < w * h; i++) {
        png.data[i * 4] = base[0];
        png.data[i * 4 + 1] = base[1];
        png.data[i * 4 + 2] = base[2];
        png.data[i * 4 + 3] = 255;
      }
      if (paint) paint(png.data);
      return PNG.sync.write(png);
    };

    const GRAY: [number, number, number] = [120, 120, 120];
    // 10x10 = 100 pixels; repainting one pixel = 1% diff
    const baselinePng = () => makePng(10, 10, GRAY);
    // 9 red pixels out of 100 = 9% diff (enough to clear the engine's
    // cumulatedThreshold, which absorbs near-zero total luminance change)
    const blockOff = () =>
      makePng(10, 10, GRAY, (d) => {
        for (let i = 0; i < 9; i++) {
          d[i * 4] = 255; d[i * 4 + 1] = 0; d[i * 4 + 2] = 0;
        }
      });

    it('keeps strict behavior by default: any flagged pixel = changed', () => {
      store.write('page', baselinePng());
      store.writeTemp('page', blockOff());

      const results = compareAll({ projectRoot: tmpDir, reportDir, threshold: 0.1 });

      expect(results[0].status).toBe('changed');
      expect(results[0].autoPassed).toBeUndefined();
    });

    it('passes within maxDiffPercent and labels it', () => {
      store.write('page', baselinePng());
      store.writeTemp('page', blockOff());

      const results = compareAll({
        projectRoot: tmpDir,
        reportDir,
        threshold: 0.1,
        passCriteria: { maxDiffPercent: 10 },
      });

      expect(results[0].status).toBe('passed');
      expect(results[0].autoPassed).toBe('threshold');
      expect(results[0].diffPercent).toBeGreaterThan(0);
    });

    it('passes within maxDiffPixels', () => {
      store.write('page', baselinePng());
      store.writeTemp('page', blockOff());

      const results = compareAll({
        projectRoot: tmpDir,
        reportDir,
        threshold: 0.1,
        passCriteria: { maxDiffPixels: 9 },
      });

      expect(results[0].status).toBe('passed');
      expect(results[0].autoPassed).toBe('threshold');
    });

    it('stays changed above maxDiffPercent', () => {
      store.write('page', baselinePng());
      store.writeTemp('page', blockOff());

      const results = compareAll({
        projectRoot: tmpDir,
        reportDir,
        threshold: 0.1,
        passCriteria: { maxDiffPercent: 0.5 },
      });

      expect(results[0].status).toBe('changed');
    });

    it('treats byte-different but visually identical images as passed', () => {
      // Color delta far below the per-pixel threshold: bytes differ, no pixel flagged
      store.write('page', baselinePng());
      store.writeTemp('page', makePng(10, 10, [121, 120, 120]));

      const results = compareAll({ projectRoot: tmpDir, reportDir, threshold: 0.1 });

      expect(results[0].status).toBe('passed');
      expect(results[0].diffPercent).toBe(0);
      expect(results[0].autoPassed).toBeUndefined();
    });

    describe('noiseAutoPass', () => {
      const DOM = '<html><body><p>stable</p></body></html>';

      /** Element maps with identical style digests on both sides (styleCheck 'match'). */
      const writeMatchingElementMaps = (name: string) => {
        const map = JSON.stringify([{ path: 'body > p', x: 0, y: 0, width: 10, height: 10, styleHash: 'aaaa' }]);
        fs.writeFileSync(path.join(tmpDir, '.testivai', 'baselines', name, 'elements.json'), map);
        fs.writeFileSync(path.join(tmpDir, '.testivai', 'temp', name, 'elements.json'), map);
      };

      it('auto-passes small diffs with identical DOM and computed styles when enabled', () => {
        store.write('page', baselinePng(), undefined, DOM);
        store.writeTemp('page', blockOff(), DOM);
        writeMatchingElementMaps('page');

        const results = compareAll({
          projectRoot: tmpDir,
          reportDir,
          threshold: 0.1,
          passCriteria: { noiseAutoPass: true, noiseMaxDiffPercent: 10 },
        });

        expect(results[0].status).toBe('passed');
        expect(results[0].autoPassed).toBe('noise');
        expect(results[0].dom?.noiseHint).toBe(true);
        expect(results[0].dom?.styleCheck).toBe('match');
      });

      it('does not auto-pass a DOM-identical diff whose styles were not compared (no element maps)', () => {
        store.write('page', baselinePng(), undefined, DOM);
        store.writeTemp('page', blockOff(), DOM);

        const results = compareAll({
          projectRoot: tmpDir,
          reportDir,
          threshold: 0.1,
          passCriteria: { noiseAutoPass: true, noiseMaxDiffPercent: 10 },
        });

        expect(results[0].dom?.noiseHint).toBe(true);
        expect(results[0].dom?.styleCheck).toBe('unavailable');
        expect(results[0].status).toBe('changed');
        expect(results[0].autoPassed).toBeUndefined();
      });

      it('does not auto-pass when the DOM changed', () => {
        store.write('page', baselinePng(), undefined, DOM);
        store.writeTemp('page', blockOff(), '<html><body><p>edited</p><span>new</span></body></html>');
        writeMatchingElementMaps('page');

        const results = compareAll({
          projectRoot: tmpDir,
          reportDir,
          threshold: 0.1,
          passCriteria: { noiseAutoPass: true, noiseMaxDiffPercent: 10 },
        });

        expect(results[0].status).toBe('changed');
      });

      it('does not auto-pass above noiseMaxDiffPercent', () => {
        store.write('page', baselinePng(), undefined, DOM);
        store.writeTemp('page', blockOff(), DOM);
        writeMatchingElementMaps('page');

        const results = compareAll({
          projectRoot: tmpDir,
          reportDir,
          threshold: 0.1,
          passCriteria: { noiseAutoPass: true, noiseMaxDiffPercent: 0.5 },
        });

        expect(results[0].status).toBe('changed');
      });
    });

    it('generateReport reads pass criteria from .testivai/config.json', () => {
      fs.mkdirSync(path.join(tmpDir, '.testivai'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.testivai', 'config.json'),
        JSON.stringify({ mode: 'local', threshold: 0.1, maxDiffPercent: 10 }),
      );
      store.write('page', baselinePng());
      store.writeTemp('page', blockOff());

      const report = generateReport({
        projectRoot: tmpDir,
        reportDir: 'visual-report',
        autoOpen: false,
      });

      expect(report.summary.passed).toBe(1);
      expect(report.summary.changed).toBe(0);
      expect(report.snapshots[0].autoPassed).toBe('threshold');
    });
  });
});

describe('Missing-baselines coverage signal (schema 2.3.0)', () => {
  let tmpDir2: string;
  let store2: BaselineStore;
  const PNG_A = Buffer.from('aaaa-fake-png-baseline');
  const PNG_B = Buffer.from('bbbb-fake-png-different');

  beforeEach(() => {
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-missing-'));
    store2 = new BaselineStore(tmpDir2);
  });

  afterEach(() => {
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('reports baselines that received no capture', () => {
    store2.write('guarded-page', PNG_A);   // baseline, no temp capture
    store2.writeTemp('other-page', PNG_B); // captured

    const data = generateReport({ projectRoot: tmpDir2, reportDir: 'visual-report', autoOpen: false });

    expect(data.summary.missing).toBe(1);
    expect(data.missingBaselines).toEqual(['guarded-page']);

    const html = fs.readFileSync(path.join(tmpDir2, 'visual-report', 'index.html'), 'utf-8');
    expect(html).toContain('missing-notice');
    expect(html).toContain('guarded-page');
  });

  it('reports zero missing when every baseline is captured', () => {
    store2.write('home', PNG_A);
    store2.writeTemp('home', PNG_A);
    const data = generateReport({ projectRoot: tmpDir2, reportDir: 'visual-report', autoOpen: false });
    expect(data.summary.missing).toBe(0);
    expect(data.missingBaselines).toEqual([]);
  });
});

describe('generateShareFile — single-file share bundle', () => {
  const { generateShareFile } = require('../report/generator');
  let tmpDir3: string;
  let store3: BaselineStore;

  beforeEach(() => {
    tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-share-'));
    store3 = new BaselineStore(tmpDir3);
  });

  afterEach(() => {
    fs.rmSync(tmpDir3, { recursive: true, force: true });
  });

  it('inlines report images as data URIs', () => {
    store3.write('home', Buffer.from('aaaa-fake-png-baseline'));
    store3.writeTemp('home', Buffer.from('bbbb-fake-png-different')); // changed -> images written
    generateReport({ projectRoot: tmpDir3, reportDir: 'visual-report', autoOpen: false });

    const sharePath = generateShareFile(path.join(tmpDir3, 'visual-report'));
    const share = fs.readFileSync(sharePath, 'utf-8');

    expect(sharePath.endsWith('share.html')).toBe(true);
    expect(share).toContain('data:image/png;base64,');
    expect(share).not.toMatch(/src="images\//);
    expect(share).not.toMatch(/data-diff="images\//);
  });
});

describe('baseline provenance (baselineApprovedAt)', () => {
  let tmp4: string;
  let store4: BaselineStore;

  beforeEach(() => {
    tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-prov-'));
    store4 = new BaselineStore(tmp4);
  });

  afterEach(() => {
    fs.rmSync(tmp4, { recursive: true, force: true });
  });

  it('results carry the baseline approval timestamp and the report shows it', () => {
    store4.write('home', Buffer.from('aaaa'));
    store4.writeTemp('home', Buffer.from('bbbb'));
    const data = generateReport({ projectRoot: tmp4, reportDir: 'visual-report', autoOpen: false });

    const snap = data.snapshots[0];
    expect(snap.baselineApprovedAt).toBeTruthy();
    expect(new Date(snap.baselineApprovedAt!).getTime()).not.toBeNaN();

    const html = fs.readFileSync(path.join(tmp4, 'visual-report', 'index.html'), 'utf-8');
    expect(html).toContain('baseline approved');
  });

  it('approve() refreshes the approval timestamp', () => {
    store4.write('home', Buffer.from('aaaa'));
    const before = store4.readMetadata('home')!.updatedAt;
    store4.writeTemp('home', Buffer.from('bbbb'));
    store4.approve('home');
    const after = store4.readMetadata('home')!.updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });
});

describe('uploadShareFile — storage-agnostic upload hook', () => {
  const { uploadShareFile } = require('../report/generator');

  it('runs the command with {file} substituted and returns the last stdout line', () => {
    const url = uploadShareFile('echo uploading {file} && echo https://example.test/share/abc', '/tmp/share file.html');
    expect(url).toBe('https://example.test/share/abc');
  });

  it('throws on a failing command', () => {
    expect(() => uploadShareFile('exit 7', '/tmp/x.html')).toThrow();
  });
});
