import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { resolvePaths, readResults, verdictFor, resolveImage, listBaselines, downscalePng, describeMissingResults } from '../lib';

describe('@testivai/mcp lib', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-mcp-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeResults = (reportDir: string, data: unknown) => {
    fs.mkdirSync(path.join(root, reportDir), { recursive: true });
    fs.writeFileSync(path.join(root, reportDir, 'results.json'), JSON.stringify(data));
  };

  it('defaults reportDir to visual-report', () => {
    expect(resolvePaths(root).reportDir).toBe(path.join(root, 'visual-report'));
  });

  it('honors reportDir from .testivai/config.json', () => {
    fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
    fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ reportDir: 'out' }));
    expect(resolvePaths(root).reportDir).toBe(path.join(root, 'out'));
  });

  it('returns null when results.json is missing', () => {
    expect(readResults(resolvePaths(root))).toBeNull();
  });

  it('reads results.json', () => {
    writeResults('visual-report', {
      version: '2.0.0',
      timestamp: 't',
      summary: { total: 1, passed: 1, changed: 0, newSnapshots: 0 },
      snapshots: [{ name: 'home', status: 'passed' }],
    });
    const results = readResults(resolvePaths(root));
    expect(results?.snapshots[0].name).toBe('home');
  });

  describe('verdictFor', () => {
    it('labels DOM-identical diffs as likely render noise', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'changed',
        diffPercent: 0.4,
        dom: { changed: false, noiseHint: true, summary: null },
      });
      expect(verdict).toContain('likely render noise');
      expect(verdict).toContain('0.40%');
    });

    // noiseHint fires when the DOM is identical and no style mismatch was
    // found. With styleCheck 'match' that means the DOM and the computed
    // styles were both compared and both matched — the verdict says so.
    it('says the DOM and computed styles both matched when the noise hint has a style match', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'changed',
        diffPercent: 0.4,
        dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
      });
      expect(verdict).toContain('likely render noise');
      expect(verdict).toContain('DOM and computed styles both match');
    });

    // witness also sets noiseHint when no style digests were comparable
    // (styleCheck 'unavailable'): styles were never compared, so the verdict
    // must not claim they matched, and must say they were not compared.
    it('does not claim styles matched when the style check was unavailable', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'changed',
        diffPercent: 0.4,
        dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'unavailable' },
      });
      expect(verdict).not.toMatch(/styles (both )?match/i);
      expect(verdict).toContain('styles were not compared');
    });

    it('labels DOM changes as real with the change summary', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'changed',
        diffPercent: 5,
        dom: { changed: true, noiseHint: false, summary: { added: 2, removed: 1, attributeChanges: 0 } },
      });
      expect(verdict).toContain('real structural change');
      expect(verdict).toContain('2 added, 1 removed');
    });

    // Regression: a style-only change (DOM identical, computed styles differ)
    // used to fall through to "no DOM data", which contradicted the HTML report
    // and hid the exact signal agents need most.
    it('labels a style-only change as real, not noise', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'changed',
        diffPercent: 1.13,
        dom: {
          changed: false,
          noiseHint: false,
          summary: null,
          styleCheck: 'mismatch',
          styleChanges: { count: 6, elements: ['body > header', 'button.btn'] },
        },
      });
      expect(verdict).toContain('style-only change');
      expect(verdict).toContain('6 elements restyled');
      expect(verdict).toContain('not noise');
      expect(verdict).not.toContain('no DOM data');
    });

    it('does not claim missing DOM data when the DOM was captured', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'changed',
        diffPercent: 0.2,
        dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'unavailable' },
      });
      expect(verdict).not.toContain('no DOM data');
      expect(verdict).toContain('DOM is identical');
      expect(verdict).toContain('style check could not run');
    });

    it('treats genuinely missing DOM data as needing review', () => {
      expect(verdictFor({ name: 'x', status: 'changed' })).toContain('no DOM data');
    });

    it('asks for human approval on new snapshots', () => {
      expect(verdictFor({ name: 'x', status: 'new' })).toContain('human');
    });
  });

  describe('resolveImage', () => {
    it('resolves an existing image inside the report dir', () => {
      writeResults('visual-report', {});
      const img = path.join(root, 'visual-report', 'images');
      fs.mkdirSync(img, { recursive: true });
      fs.writeFileSync(path.join(img, 'a.png'), 'png');
      expect(resolveImage(resolvePaths(root), 'images/a.png')).toBe(path.join(img, 'a.png'));
    });

    it('rejects path traversal out of the report dir', () => {
      writeResults('visual-report', {});
      fs.writeFileSync(path.join(root, 'secret.png'), 'png');
      expect(resolveImage(resolvePaths(root), '../secret.png')).toBeNull();
    });
  });

  it('lists baseline directories sorted', () => {
    for (const name of ['b-page', 'a-page']) {
      fs.mkdirSync(path.join(root, '.testivai', 'baselines', name), { recursive: true });
    }
    expect(listBaselines(root)).toEqual(['a-page', 'b-page']);
  });

  describe('downscalePng', () => {
    /**
     * Create a solid-color PNG of the given dimensions.
     */
    const solidPng = (w: number, h: number, r = 255, g = 0, b = 0): Buffer => {
      const png = new PNG({ width: w, height: h });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = 255;
      }
      return PNG.sync.write(png);
    };

    it('passes through an image that fits within maxEdge unchanged', () => {
      const buf = solidPng(100, 200);
      const result = downscalePng(buf, 1024);
      expect(result.data).toEqual(buf);
      expect(result.width).toBe(100);
      expect(result.height).toBe(200);
      expect(result.originalWidth).toBe(100);
      expect(result.originalHeight).toBe(200);
    });

    it('downscales a wide image so longest edge <= maxEdge', () => {
      const buf = solidPng(3000, 10, 0, 255, 0);
      const result = downscalePng(buf, 1024);
      expect(result.width).toBeLessThanOrEqual(1024);
      expect(result.originalWidth).toBe(3000);
      expect(result.originalHeight).toBe(10);
      // Should be roughly 3000/ceil(3000/1024) = 3000/3 = 1000
      expect(result.width).toBe(1000);
      expect(result.height).toBe(4); // ceil(10/3) = 4
    });

    it('downscales a tall image so longest edge <= maxEdge', () => {
      const buf = solidPng(10, 5000, 0, 0, 255);
      const result = downscalePng(buf, 1024);
      expect(result.height).toBeLessThanOrEqual(1024);
      expect(result.originalWidth).toBe(10);
      expect(result.originalHeight).toBe(5000);
    });

    it('reports original dimensions when unchanged', () => {
      const buf = solidPng(64, 64);
      const result = downscalePng(buf);
      expect(result.originalWidth).toBe(64);
      expect(result.originalHeight).toBe(64);
      expect(result.width).toBe(64);
      expect(result.height).toBe(64);
    });

    it('preserves pixel colour through nearest-neighbour sampling', () => {
      // Create a 100×1 gradient: R increases across the row
      const png = new PNG({ width: 100, height: 1 });
      for (let x = 0; x < 100; x++) {
        const i = x * 4;
        png.data[i] = x;        // R varies
        png.data[i + 1] = 0;
        png.data[i + 2] = 255 - x;
        png.data[i + 3] = 255;
      }
      const buf = PNG.sync.write(png);

      // Downscale with stride 2 → 50×1
      const result = downscalePng(buf, 50);
      expect(result.width).toBe(50);
      const out = PNG.sync.read(result.data);

      // Pixel at output x=10 comes from input x=20
      const srcIdx = 20 * 4;
      const dstIdx = 10 * 4;
      expect(out.data[dstIdx]).toBe(png.data[srcIdx]);       // R
      expect(out.data[dstIdx + 1]).toBe(png.data[srcIdx + 1]); // G
      expect(out.data[dstIdx + 2]).toBe(png.data[srcIdx + 2]); // B
    });
  });
});

describe('@testivai/mcp approve helpers', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-mcp-approve-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeTemp = (name: string) => {
    const dir = path.join(root, '.testivai', 'temp', name);
    fs.mkdirSync(dir, { recursive: true });
    const png = new PNG({ width: 2, height: 2 });
    fs.writeFileSync(path.join(dir, 'screenshot.png'), PNG.sync.write(png));
    fs.writeFileSync(path.join(dir, 'dom.html'), '<html></html>');
  };

  const baselineExists = (name: string) =>
    fs.existsSync(path.join(root, '.testivai', 'baselines', name, 'screenshot.png'));

  it('approveSnapshot promotes a temp capture to a baseline', () => {
    const { approveSnapshot } = require('../lib');
    writeTemp('homepage');
    const result = approveSnapshot(root, 'homepage');
    expect(result.approved).toEqual(['homepage']);
    expect(result.failed).toEqual([]);
    expect(baselineExists('homepage')).toBe(true);
  });

  it('approveSnapshot reports failure for a missing snapshot', () => {
    const { approveSnapshot } = require('../lib');
    const result = approveSnapshot(root, 'does-not-exist');
    expect(result.approved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe('does-not-exist');
  });

  it('approveAll promotes every pending capture', () => {
    const { approveAll } = require('../lib');
    writeTemp('a');
    writeTemp('b');
    const result = approveAll(root);
    expect(result.approved.sort()).toEqual(['a', 'b']);
    expect(baselineExists('a')).toBe(true);
    expect(baselineExists('b')).toBe(true);
  });

  it('approveAll returns empty when there is nothing pending', () => {
    const { approveAll } = require('../lib');
    expect(approveAll(root)).toEqual({ approved: [], failed: [] });
  });
});

describe('@testivai/mcp explainSnapshot', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-mcp-explain-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeResults = (snapshots: unknown[]) => {
    const dir = path.join(root, 'visual-report');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'results.json'),
      JSON.stringify({
        version: '2.2.0',
        timestamp: 't',
        summary: { total: snapshots.length, passed: 0, changed: snapshots.length, newSnapshots: 0 },
        snapshots,
      }),
    );
  };

  it('returns null for an unknown snapshot', () => {
    const { explainSnapshot } = require('../lib');
    writeResults([]);
    expect(explainSnapshot(root, 'nope')).toBeNull();
  });

  it('noise case: guidance says do not block', () => {
    const { explainSnapshot } = require('../lib');
    writeResults([{
      name: 'home', status: 'changed', diffPercent: 0.4,
      dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
    }]);
    const e = explainSnapshot(root, 'home');
    expect(e.layers.dom.noiseHint).toBe(true);
    expect(e.guidance.join(' ')).toMatch(/render noise/i);
    expect(e.guidance.join(' ')).toMatch(/human decision/i);
  });

  // The verdict and the guidance ship in the same explanation, so they must
  // agree: with no comparable style digests, neither may claim styles matched.
  it('noise case without a style check: guidance does not claim the style digests match', () => {
    const { explainSnapshot } = require('../lib');
    writeResults([{
      name: 'home', status: 'changed', diffPercent: 0.4,
      dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'unavailable' },
    }]);
    const guidance = explainSnapshot(root, 'home').guidance.join(' ');
    expect(guidance).toMatch(/render noise/i);
    expect(guidance).not.toMatch(/digests match/i);
    expect(guidance).toMatch(/styles were not compared/i);
  });

  it('style-mismatch case: flags a REAL stylesheet-only change with element names', () => {
    const { explainSnapshot } = require('../lib');
    writeResults([{
      name: 'cta', status: 'changed', diffPercent: 2.1,
      dom: {
        changed: false, noiseHint: false, summary: null,
        styleCheck: 'mismatch', styleChanges: { count: 1, elements: ['button.cta'] },
      },
    }]);
    const e = explainSnapshot(root, 'cta');
    const g = e.guidance.join(' ');
    expect(g).toMatch(/styles changed/i);
    expect(g).toContain('button.cta');
    expect(g).toMatch(/REAL/);
  });

  it('injected-banner case: pageShift guidance points above the shift line', () => {
    const { explainSnapshot } = require('../lib');
    writeResults([{
      name: 'page', status: 'changed', diffPercent: 12,
      pageShift: { dy: 24, belowY: 80, count: 17 },
      regions: [
        { x: 0, y: 80, width: 1280, height: 600, diffPercent: 30,
          classification: 'shift', shift: { dx: 0, dy: 24 },
          elements: [{ selector: 'div.card:nth-of-type(2)', role: 'shifted' }] },
        { x: 0, y: 0, width: 1280, height: 80, diffPercent: 90,
          classification: 'change',
          elements: [{ selector: 'header .banner', role: 'changed' }] },
      ],
      dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } },
    }]);
    const e = explainSnapshot(root, 'page');
    expect(e.layers.element.pageShift).toEqual({ dy: 24, belowY: 80, count: 17 });
    expect(e.layers.element.shiftedSelectors).toContain('div.card:nth-of-type(2)');
    expect(e.layers.element.changedSelectors).toContain('header .banner');
    expect(e.guidance.join(' ')).toMatch(/y=80.*moved down by 24px|inserted or removed above/i);
    // regions sorted largest-first
    expect(e.layers.pixel.regions[0].height).toBe(600);
  });

  it('new snapshot: guidance frames it as first capture, not regression', () => {
    const { explainSnapshot } = require('../lib');
    writeResults([{ name: 'fresh', status: 'new', diffPercent: 0 }]);
    const e = explainSnapshot(root, 'fresh');
    expect(e.guidance.join(' ')).toMatch(/first capture, not a regression/i);
  });

  describe('describeMissingResults', () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-missing-'));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const capture = (name: string) => {
      const d = path.join(root, '.testivai', 'temp', name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'screenshot.png'), 'png');
    };

    it('says to run the tests when nothing was captured', () => {
      const msg = describeMissingResults(root);
      expect(msg).toContain('Run the visual tests first');
    });

    // The message that used to be wrong: on a shard the tests DID run.
    it('explains a capture-only shard instead of blaming the test run', () => {
      capture('home');
      fs.writeFileSync(
        path.join(root, '.testivai', 'temp', 'testivai-shard.json'),
        JSON.stringify({ shard: { current: 3, total: 8 } }),
      );

      const msg = describeMissingResults(root);

      expect(msg).toContain('capture-only shard 3/8');
      expect(msg).toContain('merge-captures');
      expect(msg).not.toContain('Run the visual tests first');
    });

    it('points at report when captures exist but nothing compared them', () => {
      capture('home');
      capture('checkout');

      const msg = describeMissingResults(root);

      expect(msg).toContain('2 capture(s)');
      expect(msg).toContain('testivai report');
      expect(msg).not.toContain('Run the visual tests first');
    });

    it('ignores a malformed manifest rather than crashing', () => {
      capture('home');
      fs.writeFileSync(path.join(root, '.testivai', 'temp', 'testivai-shard.json'), 'not json');

      expect(() => describeMissingResults(root)).not.toThrow();
      expect(describeMissingResults(root)).toContain('capture(s)');
    });
  });
});