import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { resolvePaths, readResults, verdictFor, resolveImage, listBaselines, downscalePng, describeMissingResults, type ResultsFile } from '../lib';

/** Real runs with an identical DOM and matching styles; see the README next to it. */
const NOISE_SHAPES_FIXTURE = path.join(
  __dirname, '..', '..', '..', 'witness', 'src', '__tests__', 'fixtures', 'render-noise-shapes.results.json',
);

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
    // Words that tell an agent to wave a diff through as noise. They belong
    // only to the case where the DOM AND the computed styles were compared.
    const NOISE_ADVICE = /likely render noise|don't block|do not block|mention it/i;

    // noiseHint fires when the DOM is identical and no style mismatch was
    // found. With styleCheck 'match' that means the DOM and the computed
    // styles were both compared and both matched — the verdict says so, and
    // with a small, scattered diff (no regions here) it is likely noise.
    it('says the DOM and computed styles both matched when the noise hint has a style match', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'changed',
        diffPercent: 0.4,
        dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
      });
      expect(verdict).toBe(
        "changed (0.40% pixels differ) but the DOM and computed styles both match and the diff is small and scattered — likely render noise (font hinting, anti-aliasing); mention it, don't block",
      );
    });

    // witness also sets noiseHint when no style digests were comparable
    // (styleCheck 'unavailable'): styles were never compared, so a
    // stylesheet-only change is not ruled out. That is unknown, not noise:
    // the verdict must not call it noise or tell the agent not to block.
    it('does not call an identical-DOM diff noise when the style check was unavailable', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'changed',
        diffPercent: 0.4,
        dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'unavailable' },
      });
      expect(verdict).toBe(
        'changed (0.40% pixels differ) but the DOM is structurally identical and styles were not compared (style check unavailable) — could be render noise or a stylesheet-only change; look at the diff before approving',
      );
      expect(verdict).not.toMatch(/styles (both )?match/i);
      expect(verdict).not.toMatch(NOISE_ADVICE);
    });

    // Results written before the style check existed carry noiseHint with no
    // styleCheck at all. That is the same unknown case, and the verdict must
    // not claim a style check ran and came back unavailable.
    it('does not call an identical-DOM diff noise when the results have no style check', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'changed',
        diffPercent: 0.4,
        dom: { changed: false, noiseHint: true, summary: null },
      });
      expect(verdict).toBe(
        'changed (0.40% pixels differ) but the DOM is structurally identical and styles were not compared (no style check in these results) — could be render noise or a stylesheet-only change; look at the diff before approving',
      );
      expect(verdict).not.toMatch(NOISE_ADVICE);
    });

    // Auto-pass turns a pixel diff into status 'passed'; the diff is still
    // there, inside a configured tolerance. "No visual change" would hide it.
    it('says an auto-passed snapshot had a pixel diff within tolerance, not no change', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'passed',
        diffPercent: 0.3,
        autoPassed: 'noise',
        dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
      });
      expect(verdict).toBe(
        "passed — auto-passed by the configured 'noise' criterion: 0.30% pixels differ, within its tolerance",
      );
      expect(verdict).not.toContain('no visual change');
      expect(verdictFor({ name: 'x', status: 'passed', diffPercent: 0.02, autoPassed: 'threshold' })).toBe(
        "passed — auto-passed by the configured 'threshold' criterion: 0.02% pixels differ, within its tolerance",
      );
      expect(verdictFor({ name: 'x', status: 'passed', diffPercent: 0 })).toBe('passed — no visual change');
    });

    // Results from a noiseAutoPass that did not yet require a style match can
    // carry autoPassed 'noise' with styles never compared: say so.
    it('flags a noise auto-pass whose styles were not compared', () => {
      const verdict = verdictFor({
        name: 'x',
        status: 'passed',
        diffPercent: 0.3,
        autoPassed: 'noise',
        dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'unavailable' },
      });
      expect(verdict).toBe(
        "passed — auto-passed by the configured 'noise' criterion: 0.30% pixels differ, within its tolerance; styles were not compared (style check unavailable), so a stylesheet-only change is not ruled out — look at the diff",
      );
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

  // Identical DOM and matching styles is likely noise only when the diff is
  // small and scattered. Real runs from packages/witness (fixtures/README.md
  // there): the eval's clipped card, a bad capture and a bad baseline were
  // all called "likely render noise" before.
  describe('verdictFor on real runs with an identical DOM and matching styles', () => {
    const NOISE_ADVICE = /likely render noise|don't block|do not block|mention it/i;
    const fixture: ResultsFile = JSON.parse(fs.readFileSync(NOISE_SHAPES_FIXTURE, 'utf8'));
    const real = (name: string) => fixture.snapshots.find((s) => s.name === name)!;

    it('a diff concentrated in one area: names the area, the two explanations and get_diff', () => {
      expect(verdictFor(real('card-clipped'))).toBe(
        'changed (0.03% pixels differ) — the DOM and computed styles both match, but the diff is concentrated in one area ' +
          '(3 regions within 155×52 px, 0.8% of the page): a bad capture, or a change the style check does not cover ' +
          '(size, overflow, position, transform, text decoration, filters, pseudo-elements, or images and other assets); ' +
          'compare the images (get_diff) before approving',
      );
    });

    it.each([['card-clipped'], ['card-text-not-painted'], ['baseline-band-shifted'], ['titles-underlined']])(
      '%s is not called noise',
      (name) => {
        const verdict = verdictFor(real(name));
        expect(verdict).toMatch(/concentrated in one area/);
        expect(verdict).toMatch(/get_diff/);
        expect(verdict).not.toMatch(NOISE_ADVICE);
      },
    );

    it('a large diff spread across the page: more than render noise usually changes', () => {
      expect(verdictFor(real('font-subpixel-noise-over-1pct'))).toBe(
        'changed (1.19% pixels differ) — the DOM and computed styles both match, but the diff is large (over 1% of pixels, ' +
          'spread across the page), more than render noise usually changes: often fonts or rendering that differ between ' +
          'machines, a bad capture, or a change the style check does not cover; compare the images (get_diff) before approving',
      );
      expect(verdictFor(real('fonts-differ-between-machines'))).not.toMatch(NOISE_ADVICE);
    });

    it.each([['glyph-edge-noise'], ['font-subpixel-noise']])('%s (render noise, small and scattered) stays likely noise', (name) => {
      expect(verdictFor(real(name))).toMatch(
        /but the DOM and computed styles both match and the diff is small and scattered — likely render noise \(font hinting, anti-aliasing\); mention it, don't block$/,
      );
    });

    it("flags a legacy 'noise' auto-pass of a diff concentrated in one area", () => {
      expect(verdictFor({ ...real('card-clipped'), status: 'passed', autoPassed: 'noise' })).toBe(
        "passed — auto-passed by the configured 'noise' criterion: 0.03% pixels differ, within its tolerance; " +
          'but the diff is concentrated in one area (3 regions within 155×52 px, 0.8% of the page), which render noise is not — look at the diff',
      );
    });

    it('a noise auto-pass of a scattered diff keeps the plain auto-pass verdict', () => {
      expect(verdictFor({ ...real('font-subpixel-noise'), status: 'passed', autoPassed: 'noise' })).toBe(
        "passed — auto-passed by the configured 'noise' criterion: 0.85% pixels differ, within its tolerance",
      );
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

  // get_visual_results ends with these so a person can open the images from
  // the conversation (the client may not render images to them itself).
  describe('reportLinks', () => {
    const { reportLinks } = require('../lib');
    const touch = (rel: string) => {
      const file = path.join(root, 'visual-report', rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
      return file;
    };
    const results = (snapshots: unknown[]) => ({
      version: '2.3.0', timestamp: 't', summary: { total: snapshots.length, passed: 0, changed: 0, newSnapshots: 0 }, snapshots,
    });

    it('lists the HTML report, each changed diff image and each new capture as absolute paths', () => {
      const report = touch('index.html');
      const diff = touch('images/home/diff.png');
      const current = touch('images/pricing/current.png');
      const lines = reportLinks(resolvePaths(root), results([
        { name: 'home', status: 'changed', diffPath: 'images/home/diff.png' },
        { name: 'pricing', status: 'new', currentPath: 'images/pricing/current.png' },
        { name: 'about', status: 'passed', diffPath: 'images/about/diff.png' },
      ]));
      expect(lines).toEqual([
        'Open on this machine:',
        `- report: ${report}`,
        `- home (diff): ${diff}`,
        `- pricing (new capture): ${current}`,
      ]);
      expect(lines.slice(1).every((l: string) => path.isAbsolute(l.split(': ').pop()!))).toBe(true);
    });

    it('skips images that are missing or outside the report dir', () => {
      fs.writeFileSync(path.join(root, 'secret.png'), 'x');
      const lines = reportLinks(resolvePaths(root), results([
        { name: 'gone', status: 'changed', diffPath: 'images/gone/diff.png' },
        { name: 'escape', status: 'changed', diffPath: '../secret.png' },
      ]));
      expect(lines).toEqual([]);
    });

    it('returns nothing when there is nothing to open', () => {
      expect(reportLinks(resolvePaths(root), results([{ name: 'a', status: 'passed' }]))).toEqual([]);
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

// The approve tools force a per-call permission prompt unless the user turns
// it off: the server flag wins, then .testivai/config.json, then the default.
describe('resolveApprovalPrompt', () => {
  const { resolveApprovalPrompt } = require('../lib');

  it('defaults to prompting', () => {
    expect(resolveApprovalPrompt([], undefined)).toBe(true);
  });

  it('follows mcpApprovalPrompt from config.json when no flag is given', () => {
    expect(resolveApprovalPrompt([], false)).toBe(false);
    expect(resolveApprovalPrompt([], true)).toBe(true);
  });

  it('--no-approval-prompt turns it off, even over a config of true', () => {
    expect(resolveApprovalPrompt(['--no-approval-prompt'], undefined)).toBe(false);
    expect(resolveApprovalPrompt(['--root', '/p', '--no-approval-prompt'], true)).toBe(false);
  });

  it('--approval-prompt turns it on, even over a config of false', () => {
    expect(resolveApprovalPrompt(['--approval-prompt'], false)).toBe(true);
  });

  it('the last flag wins when both are given', () => {
    expect(resolveApprovalPrompt(['--approval-prompt', '--no-approval-prompt'], undefined)).toBe(false);
    expect(resolveApprovalPrompt(['--no-approval-prompt', '--approval-prompt'], undefined)).toBe(true);
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
    expect(e.guidance).toContain(
      'Pixels differ but the DOM is structurally identical, style digests match, and the diff is small and scattered — likely render noise (anti-aliasing, font hinting). Mention it; do not block on it.',
    );
    expect(e.guidance.join(' ')).toMatch(/human decision/i);
  });

  // Real runs from packages/witness (fixtures/README.md there).
  describe('identical DOM and matching styles, but not the shape of render noise', () => {
    const NOISE_ADVICE = /likely render noise|don't block|do not block|mention it/i;
    const fixture: ResultsFile = JSON.parse(fs.readFileSync(NOISE_SHAPES_FIXTURE, 'utf8'));
    const real = (name: string) => fixture.snapshots.find((s) => s.name === name)!;

    it('concentrated in one area: guidance names the area, the element it maps to, both explanations and get_diff', () => {
      const { explainSnapshot } = require('../lib');
      writeResults([real('card-clipped')]);
      const e = explainSnapshot(root, 'card-clipped');
      expect(e.guidance).toContain(
        'Diff concentrated in one area, which render noise does not do: pixels differ and the DOM is structurally ' +
          'identical with matching style digests, but 3 regions within 155×52 px, 0.8% of the page, changed (box at ' +
          'x=525, y=387), and every region maps to `body > main > section > div.cards > div.card:nth-of-type(2) > ' +
          'div.body:nth-of-type(2)`. Render noise is small and scattered (anti-aliasing and font hinting at glyph edges), ' +
          'so this is a bad capture (a torn or partly blank render, a shifted band, a bad baseline) or a change the style ' +
          'check does not cover (size, overflow, position, transform, text decoration, filters, pseudo-elements, or images ' +
          'and other assets). Do not treat it as noise: compare the images (get_diff) before approving.',
      );
      expect(e.guidance.join(' ')).not.toMatch(NOISE_ADVICE);
      expect(e.verdict).not.toMatch(NOISE_ADVICE);
    });

    it('one region: says the region maps to its element', () => {
      const { explainSnapshot } = require('../lib');
      writeResults([real('card-text-not-painted')]);
      const guidance = explainSnapshot(root, 'card-text-not-painted').guidance.join(' ');
      expect(guidance).toContain(
        'but 1 region within 211×53 px, 1.1% of the page, changed (box at x=525, y=352), and the region maps to ' +
          '`body > main > section > div.cards > div.card:nth-of-type(2) > div.body:nth-of-type(2) > p`.',
      );
    });

    it('regions with no element in common: no element is named', () => {
      const { explainSnapshot } = require('../lib');
      writeResults([real('titles-underlined')]);
      const guidance = explainSnapshot(root, 'titles-underlined').guidance.join(' ');
      expect(guidance).toContain('but 6 regions within');
      expect(guidance).not.toMatch(/maps to/);
    });

    it('large and spread out: guidance says it is more than render noise usually changes, and what it often is', () => {
      const { explainSnapshot } = require('../lib');
      writeResults([real('font-subpixel-noise-over-1pct')]);
      const e = explainSnapshot(root, 'font-subpixel-noise-over-1pct');
      expect(e.guidance).toContain(
        'Large diff, more than render noise usually changes: pixels differ and the DOM is structurally identical with ' +
          'matching style digests, but 1.19% of pixels differ (over 1%), spread across the page. That is often fonts or ' +
          'rendering that differ between the machines that captured the baseline and the current image; it can also be a ' +
          'bad capture or a change the style check does not cover (size, overflow, position, transform, text decoration, ' +
          'filters, pseudo-elements, or images and other assets). Do not treat it as noise: compare the images (get_diff) ' +
          'before approving.',
      );
      expect(e.guidance.join(' ')).not.toMatch(NOISE_ADVICE);
    });

    it('the pixel layer carries the shape, so an agent can read it as data', () => {
      const { explainSnapshot } = require('../lib');
      writeResults([real('card-clipped'), real('glyph-edge-noise'), { name: 'fresh', status: 'new' }]);
      expect(explainSnapshot(root, 'card-clipped').layers.pixel.shape).toEqual({
        kind: 'concentrated',
        regionCount: 3,
        box: { x: 525, y: 387, width: 155, height: 52 },
        pagePercent: (155 * 52 * 100) / 1018880,
      });
      expect(explainSnapshot(root, 'glyph-edge-noise').layers.pixel.shape).toEqual({
        kind: 'scattered',
        regionCount: 0,
        box: null,
        pagePercent: null,
      });
      expect(explainSnapshot(root, 'fresh').layers.pixel.shape).toBeNull();
    });

    it("a legacy 'noise' auto-pass of a concentrated diff: guidance does not say no action is needed", () => {
      const { explainSnapshot } = require('../lib');
      writeResults([{ ...real('card-clipped'), status: 'passed', autoPassed: 'noise' }]);
      const guidance = explainSnapshot(root, 'card-clipped').guidance;
      expect(guidance).toContain(
        "This diff auto-passed via the 'noise' criterion although it is concentrated in one area (3 regions within " +
          '155×52 px, 0.8% of the page), which render noise is not — compare the images (get_diff) before relying on it.',
      );
      expect(guidance.join(' ')).not.toMatch(/no action needed/i);
      expect(guidance.join(' ')).not.toMatch(NOISE_ADVICE);
    });
  });

  // The verdict and the guidance ship in the same explanation, so they must
  // agree: with no comparable style digests, neither may claim styles matched
  // or call the diff noise. A stylesheet-only change is not ruled out, so the
  // agent is told to look at the images instead.
  const NOISE_ADVICE = /likely render noise|don't block|do not block|mention it/i;

  it.each([
    ['unavailable', 'no comparable style digests on both sides'],
    [undefined, 'these results have no style check'],
  ])('styles not compared (styleCheck %s): guidance says look at the images, not noise', (styleCheck, why) => {
    const { explainSnapshot } = require('../lib');
    writeResults([{
      name: 'home', status: 'changed', diffPercent: 0.4,
      dom: { changed: false, noiseHint: true, summary: null, ...(styleCheck ? { styleCheck } : {}) },
    }]);
    const e = explainSnapshot(root, 'home');
    expect(e.guidance).toContain(
      'Styles not compared — could be render noise or a stylesheet-only change: pixels differ and the DOM is ' +
        `structurally identical, but computed styles were not compared (${why}), so a stylesheet-only change is ` +
        'not ruled out. Do not treat it as noise: compare the images (get_diff) before approving.',
    );
    const guidance = e.guidance.join(' ');
    expect(guidance).not.toMatch(/digests match/i);
    expect(guidance).not.toMatch(NOISE_ADVICE);
    // The verdict in the same bundle agrees.
    expect(e.verdict).not.toMatch(NOISE_ADVICE);
  });

  // An auto-pass is a configured tolerance, not proof; when the noise
  // auto-pass was applied without a style comparison, "no action needed"
  // would hide an unverified diff.
  it('noise auto-pass without a style comparison: guidance does not say no action is needed', () => {
    const { explainSnapshot } = require('../lib');
    writeResults([{
      name: 'home', status: 'passed', diffPercent: 0.4, autoPassed: 'noise',
      dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'unavailable' },
    }]);
    const guidance = explainSnapshot(root, 'home').guidance;
    expect(guidance).toContain(
      "This diff auto-passed via the 'noise' criterion although its styles were not compared, so a " +
        'stylesheet-only change was not ruled out — compare the images (get_diff) before relying on it.',
    );
    expect(guidance.join(' ')).not.toMatch(/no action needed/i);
    expect(guidance.join(' ')).not.toMatch(NOISE_ADVICE);
  });

  // witness computes the DOM signal before the pass criteria, so a passed
  // snapshot can still carry noiseHint. A capture with no pixel above the
  // per-pixel threshold passes with diffPercent 0 and no autoPassed: nothing
  // differs and nothing is pending approval, so the guidance must not say
  // pixels differ, ask for a review before approving, or call it noise.
  it('passed with no pixel diff: no noise or review guidance even when the DOM signal is set', () => {
    const { explainSnapshot } = require('../lib');
    writeResults([{
      name: 'zero', status: 'passed', diffPercent: 0,
      dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'unavailable' },
    }]);
    const e = explainSnapshot(root, 'zero');
    expect(e.verdict).toBe('passed — no visual change');
    const guidance = e.guidance.join(' ');
    expect(guidance).not.toMatch(/pixels differ|before approving|render noise|styles not compared/i);
    expect(guidance).not.toMatch(NOISE_ADVICE);
  });

  // A threshold or shift auto-pass whose styles were not compared is a
  // configured tolerance: the transparency line applies, and the guidance
  // must not also ask for a review ("before approving") or call it noise.
  it.each(['threshold', 'shift'])(
    "'%s' auto-pass without a style comparison: transparency line only, no review request",
    (criterion) => {
      const { explainSnapshot } = require('../lib');
      writeResults([{
        name: 'home', status: 'passed', diffPercent: 0.2, autoPassed: criterion,
        dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'unavailable' },
      }]);
      const e = explainSnapshot(root, 'home');
      expect(e.guidance).toContain(
        `This diff auto-passed via the '${criterion}' criterion — reported for transparency, no action needed.`,
      );
      const guidance = e.guidance.join(' ');
      expect(guidance).not.toMatch(/before approving/i);
      expect(guidance).not.toMatch(NOISE_ADVICE);
    },
  );

  it('auto-pass with compared styles: reported for transparency', () => {
    const { explainSnapshot } = require('../lib');
    writeResults([{
      name: 'home', status: 'passed', diffPercent: 0.4, autoPassed: 'noise',
      dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
    }]);
    expect(explainSnapshot(root, 'home').guidance).toContain(
      "This diff auto-passed via the 'noise' criterion — reported for transparency, no action needed.",
    );
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

  it('DOM changed and styles changed: never says the DOM stayed identical', () => {
    const { explainSnapshot, verdictFor } = require('../lib');
    const snapshot = {
      name: 'cta', status: 'changed', diffPercent: 2.1,
      dom: {
        changed: true, noiseHint: false,
        summary: { added: 0, removed: 0, attributeChanges: 1, textChanges: 0 },
        styleCheck: 'mismatch', styleChanges: { count: 2, elements: ['button.cta', 'a.more'] },
      },
    };
    writeResults([snapshot]);
    const g = explainSnapshot(root, 'cta').guidance.join(' ');
    expect(g).not.toMatch(/stayed identical|identical DOM|stylesheet-only/i);
    expect(g).toContain('Computed styles also changed on 2 element(s) (button.cta, a.more)');
    const v = verdictFor(snapshot);
    expect(v).toMatch(/real structural change/);
    expect(v).not.toMatch(/identical DOM|style-only/i);
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
describe('withPromptArguments', () => {
  const { withPromptArguments } = require('../lib') as typeof import('../lib');

  it('gives a prompts/get request with no arguments an empty arguments object (MCP makes it optional)', () => {
    expect(withPromptArguments({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'triage-visual-diff' } })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/get',
      params: { name: 'triage-visual-diff', arguments: {} },
    });
  });

  it('leaves everything else exactly as it was', () => {
    const withArgs = { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'x', arguments: { snapshot: 'home' } } };
    expect(withPromptArguments(withArgs)).toBe(withArgs);
    const other = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_report' } };
    expect(withPromptArguments(other)).toBe(other);
    const response = { jsonrpc: '2.0', id: 4, result: {} };
    expect(withPromptArguments(response)).toBe(response);
    expect(withPromptArguments(null)).toBeNull();
  });
});

/**
 * Missing baselines: committed baselines that got no capture this run
 * (results.json 2.3.0+ `missingBaselines`). There is no current image and
 * nothing to approve, so they get their own verdict, explanation and diff.
 * Names come from results.json, so a name never reaches a path outside the
 * baselines directory.
 */
describe('@testivai/mcp missing baselines', () => {
  const lib = require('../lib') as typeof import('../lib');
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-mcp-missing-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const png = (w: number, h: number): Buffer => PNG.sync.write(new PNG({ width: w, height: h }));

  /** A committed baseline: screenshot.png, dom.html and metadata.json under `dir` (relative to root). */
  const commitBaseline = (dir: string, name: string, screenshot: Buffer = png(4, 3)) => {
    const d = path.join(root, dir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'screenshot.png'), screenshot);
    fs.writeFileSync(path.join(d, 'dom.html'), '<html></html>');
    fs.writeFileSync(path.join(d, 'metadata.json'), '{}');
  };

  const results = (over: Partial<ResultsFile> = {}): ResultsFile => ({
    version: '2.3.0',
    timestamp: 't',
    summary: { total: 2, passed: 1, changed: 0, newSnapshots: 1, missing: 1 },
    snapshots: [
      { name: 'home', status: 'passed' },
      { name: 'catalog', status: 'new' },
    ],
    missingBaselines: ['products'],
    ...over,
  });

  const writeResults = (r: ResultsFile) => {
    fs.mkdirSync(path.join(root, 'visual-report'), { recursive: true });
    fs.writeFileSync(path.join(root, 'visual-report', 'results.json'), JSON.stringify(r));
  };

  describe('missingBaselineNames', () => {
    it('lists each name in missingBaselines once, in order', () => {
      expect(lib.missingBaselineNames(results({ missingBaselines: ['products', 'faq', 'products'] }))).toEqual(['products', 'faq']);
    });

    it('skips a name that is also a snapshot: the snapshot line covers it', () => {
      expect(lib.missingBaselineNames(results({ missingBaselines: ['home', 'products'] }))).toEqual(['products']);
    });

    it('older results without missingBaselines have none, and junk entries are dropped', () => {
      const { missingBaselines: _, ...older } = results();
      expect(lib.missingBaselineNames(older as ResultsFile)).toEqual([]);
      expect(lib.missingBaselineNames(results({ missingBaselines: 'products' as unknown as string[] }))).toEqual([]);
      expect(lib.missingBaselineNames(results({ missingBaselines: [3, '', null, 'faq'] as unknown as string[] }))).toEqual(['faq']);
    });
  });

  describe('missingVerdict', () => {
    it('says there is no capture, why it cannot say why, that there is nothing to approve, and how to accept a removal', () => {
      expect(lib.missingVerdict('.testivai/baselines/products')).toBe(
        "missing baseline — committed, but no capture this run: its test was removed, renamed or skipped, or failed before it captured (the report cannot say which; the test run's log can); " +
          'nothing to approve (approving only promotes a new capture) — to accept an intended removal, delete its baseline directory (.testivai/baselines/products) in the same change',
      );
    });

    it('without a directory it still says how', () => {
      expect(lib.missingVerdict(null)).toMatch(/delete its baseline directory in the same change$/);
    });
  });

  describe('summaryLine', () => {
    it('counts missing baselines when the results carry the count', () => {
      expect(lib.summaryLine(results())).toBe('Run: t — 2 snapshots: 1 passed, 0 changed, 1 new; 1 missing baseline (no capture this run).');
      expect(lib.summaryLine(results({ summary: { total: 2, passed: 1, changed: 0, newSnapshots: 1, missing: 2 } }))).toMatch(
        /; 2 missing baselines \(no capture this run\)\.$/,
      );
    });

    it('falls back to the list when the summary has no count', () => {
      expect(lib.summaryLine(results({ summary: { total: 2, passed: 1, changed: 0, newSnapshots: 1 } }))).toMatch(/; 1 missing baseline/);
    });

    it('older results without either: the header as it always was', () => {
      const { missingBaselines: _, ...older } = results({ summary: { total: 2, passed: 1, changed: 0, newSnapshots: 1 } });
      expect(lib.summaryLine(older as ResultsFile)).toBe('Run: t — 2 snapshots: 1 passed, 0 changed, 1 new.');
    });
  });

  describe('missingBaselineDir (the only way a name becomes a path)', () => {
    it('resolves a listed name inside the baselines directory', () => {
      commitBaseline('.testivai/baselines', 'products');
      expect(lib.missingBaselineDir(root, results(), 'products')).toBe(path.join(root, '.testivai', 'baselines', 'products'));
    });

    it('honours baselinesDir in .testivai/config.json, including {platform}', () => {
      fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
      fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ baselinesDir: 'shots/{platform}' }));
      commitBaseline(`shots/${process.platform}`, 'products');
      expect(lib.missingBaselineDir(root, results(), 'products')).toBe(path.join(root, 'shots', process.platform, 'products'));
    });

    it('never looks up a name results.json does not list as missing', () => {
      commitBaseline('.testivai/baselines', 'secret');
      expect(lib.missingBaselineDir(root, results(), 'secret')).toBeNull();
      expect(lib.missingBaselineDir(root, results(), 'home')).toBeNull();
    });

    it.each(['../outside', '..', '.', 'a/../outside', 'nested/products', 'products/', `${'x'}\0y`])(
      'refuses a listed name that is not one directory inside the baselines directory: %p',
      (name) => {
        fs.mkdirSync(path.join(root, 'outside'), { recursive: true });
        expect(lib.missingBaselineDir(root, results({ missingBaselines: [name] }), name)).toBeNull();
      },
    );

    it('refuses a baseline directory that is a symlink out of the baselines directory', () => {
      commitBaseline('.', 'outside');
      fs.mkdirSync(path.join(root, '.testivai', 'baselines'), { recursive: true });
      fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.testivai', 'baselines', 'evil'));
      expect(lib.missingBaselineDir(root, results({ missingBaselines: ['evil'] }), 'evil')).toBeNull();
    });
  });

  describe('explainSnapshot for a missing baseline', () => {
    it('returns status missing, the verdict, the committed files and the guidance', () => {
      commitBaseline('.testivai/baselines', 'products');
      writeResults(results());
      expect(lib.explainSnapshot(root, 'products')).toEqual({
        name: 'products',
        status: 'missing',
        verdict: lib.missingVerdict('.testivai/baselines/products'),
        baseline: {
          directory: '.testivai/baselines/products',
          files: ['.testivai/baselines/products/screenshot.png', '.testivai/baselines/products/dom.html', '.testivai/baselines/products/metadata.json'],
        },
        guidance: [
          'No capture this run: the baseline is committed (.testivai/baselines/products), but the test run captured nothing under this name, so there is no current image and nothing to diff. ' +
            'The report cannot say why: the test may have been removed or renamed, skipped, or failed before it captured. ' +
            "Check what the change under test did to that test or snapshot, and the test run's log for a failed or skipped test.",
          'New snapshots this run (no baseline yet): catalog. If one of them is this test under another name, it is a rename: judge the two together.',
          'Approving does nothing here: approve_snapshot and `testivai approve` only promote a new capture from .testivai/temp, and there is none. ' +
            'To accept an intended removal, delete the baseline directory in the same change (git rm -r .testivai/baselines/products); otherwise restore the test, or what it needs to reach its capture.',
          'There is no capture to call bad, so this is not a glitch: an intended change if the change under test meant to remove or rename it, a bug if it did so by mistake or broke the test before its capture, otherwise a possible bug.',
        ],
      });
    });

    it('a custom baselinesDir: the paths are where the baseline really is', () => {
      fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
      fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ baselinesDir: 'tests/__baselines__' }));
      commitBaseline('tests/__baselines__', 'products');
      writeResults(results());
      const e = lib.explainSnapshot(root, 'products') as import('../lib').MissingBaselineExplanation;
      expect(e.baseline.directory).toBe('tests/__baselines__/products');
      expect(e.baseline.files[0]).toBe('tests/__baselines__/products/screenshot.png');
      expect(e.verdict).toContain('(tests/__baselines__/products)');
    });

    it('lists elements.json too when the baseline has one, and says when its directory is not there', () => {
      commitBaseline('.testivai/baselines', 'products');
      fs.writeFileSync(path.join(root, '.testivai', 'baselines', 'products', 'elements.json'), '{}');
      writeResults(results({ missingBaselines: ['products', 'gone'] }));
      expect((lib.explainSnapshot(root, 'products') as import('../lib').MissingBaselineExplanation).baseline.files).toContain(
        '.testivai/baselines/products/elements.json',
      );
      const gone = lib.explainSnapshot(root, 'gone') as import('../lib').MissingBaselineExplanation;
      expect(gone.baseline).toEqual({ directory: '.testivai/baselines/gone', files: [] });
      expect(gone.guidance[0]).toMatch(/^No baseline directory at \.testivai\/baselines\/gone on this machine/);
    });

    it('a traversal name in missingBaselines reads nothing outside the baselines directory', () => {
      commitBaseline('.', 'outside');
      writeResults(results({ missingBaselines: ['../../outside'] }));
      const e = lib.explainSnapshot(root, '../../outside') as import('../lib').MissingBaselineExplanation;
      expect(e.status).toBe('missing');
      expect(e.baseline).toEqual({ directory: null, files: [] });
      expect(JSON.stringify(e)).not.toMatch(/outside\/screenshot\.png/);
      expect(e.guidance[0]).toBe(
        'The name "../../outside" does not resolve to a directory inside the baselines directory (.testivai/baselines), so no baseline files were read.',
      );
    });

    it('a file inside the baseline that links out of the baselines directory is not listed', () => {
      commitBaseline('.', 'outside');
      commitBaseline('.testivai/baselines', 'products');
      const shot = path.join(root, '.testivai', 'baselines', 'products', 'screenshot.png');
      fs.rmSync(shot);
      fs.symlinkSync(path.join(root, 'outside', 'screenshot.png'), shot);
      writeResults(results());
      expect((lib.explainSnapshot(root, 'products') as import('../lib').MissingBaselineExplanation).baseline.files).toEqual([
        '.testivai/baselines/products/dom.html',
        '.testivai/baselines/products/metadata.json',
      ]);
    });

    it('a name that is a snapshot too keeps the snapshot explanation; an unlisted name is unknown', () => {
      commitBaseline('.testivai/baselines', 'home');
      writeResults(results({ missingBaselines: ['home', 'products'] }));
      expect(lib.explainSnapshot(root, 'home')).toMatchObject({ name: 'home', status: 'passed', layers: expect.any(Object) });
      expect(lib.explainSnapshot(root, 'other')).toBeNull();
    });
  });

  describe('missingBaselineDiff (get_diff for a missing baseline)', () => {
    type Content = { type: string; text?: string; data?: string; mimeType?: string };
    const texts = (c: Content[]) => c.filter((x) => x.type === 'text').map((x) => x.text);

    it('the verdict, that there is no current capture, then the committed screenshot only', () => {
      commitBaseline('.testivai/baselines', 'products');
      const content = lib.missingBaselineDiff(root, results(), 'products') as Content[];
      expect(texts(content)).toEqual([
        `products: ${lib.missingVerdict('.testivai/baselines/products')}`,
        'No current capture: nothing was captured under this name this run, so there is no current or diff image, only the committed baseline.',
        'baseline:',
      ]);
      const images = content.filter((x) => x.type === 'image');
      expect(images).toHaveLength(1);
      expect(images[0].mimeType).toBe('image/png');
      expect(Buffer.from(images[0].data!, 'base64')).toEqual(fs.readFileSync(path.join(root, '.testivai', 'baselines', 'products', 'screenshot.png')));
    });

    it('downscales a large baseline like the other images', () => {
      commitBaseline('.testivai/baselines', 'products', png(3000, 10));
      const content = lib.missingBaselineDiff(root, results(), 'products') as Content[];
      expect(texts(content)).toContain('baseline (downscaled from 3000x10):');
      const shown = PNG.sync.read(Buffer.from(content.find((x) => x.type === 'image')!.data!, 'base64'));
      expect(shown.width).toBeLessThanOrEqual(1024);
    });

    it('says a missing or unreadable screenshot instead of throwing', () => {
      writeResults(results());
      const none = lib.missingBaselineDiff(root, results(), 'products') as Content[];
      expect(texts(none)[2]).toBe('baseline: no committed screenshot at .testivai/baselines/products/screenshot.png.');
      expect(none.some((x) => x.type === 'image')).toBe(false);

      commitBaseline('.testivai/baselines', 'products', Buffer.from('not a png'));
      const bad = lib.missingBaselineDiff(root, results(), 'products') as Content[];
      expect(texts(bad)[2]).toMatch(/^baseline: \.testivai\/baselines\/products\/screenshot\.png could not be read as a PNG \(.+\)\.$/);
      expect(bad.some((x) => x.type === 'image')).toBe(false);
    });

    it('a traversal name shows no image, and an unlisted name is not a missing baseline', () => {
      commitBaseline('.', 'outside');
      const content = lib.missingBaselineDiff(root, results({ missingBaselines: ['../outside'] }), '../outside') as Content[];
      expect(content.some((x) => x.type === 'image')).toBe(false);
      expect(texts(content)[2]).toBe('baseline: "../outside" does not resolve to a directory inside the baselines directory, so no file was read.');
      expect(lib.missingBaselineDiff(root, results(), 'home')).toBeNull();
    });
  });

  describe('missingBaselineLines (get_visual_results)', () => {
    it('one missing baseline: one `- <name>: <verdict>` line', () => {
      commitBaseline('.testivai/baselines', 'products');
      expect(lib.missingBaselineLines(root, results())).toEqual([`- products: ${lib.missingVerdict('.testivai/baselines/products')}`]);
      const { missingBaselines: _, ...older } = results();
      expect(lib.missingBaselineLines(root, older as ResultsFile)).toEqual([]);
    });

    // A --grep run or a matrix lane leaves most of the suite missing: the long
    // verdict once, not once per baseline.
    // Each group gets its own verdict once: a baseline that is not on this
    // machine is never under the "committed, delete it" one.
    it('several: one verdict per kind (committed here, not on this machine, name outside), then a short line per name', () => {
      commitBaseline('.testivai/baselines', 'products');
      commitBaseline('.testivai/baselines', 'faq');
      const lines = lib.missingBaselineLines(root, results({ missingBaselines: ['products', 'faq', '../x', 'gone'] }));
      expect(lines).toEqual([
        `Missing baselines (2): ${lib.missingVerdict('.testivai/baselines/<name>')}`,
        '- products',
        '- faq',
        `Missing baselines not on this machine (1): missing baseline — ${lib.notHere('.testivai/baselines/<name>')}`,
        '- gone',
        'Missing baselines whose name does not resolve to a directory inside the baselines directory (1): no baseline files were read for them',
        '- ../x',
      ]);
    });

    it.each([
      ['committed here', true],
      ['not on this machine (stale results, another platform)', false],
    ])('stays small with hundreds of missing baselines: %s', (_, committed) => {
      const names = Array.from({ length: 200 }, (_, i) => `page-${i}`);
      if (committed) for (const n of names) commitBaseline('.testivai/baselines', n);
      const lines = lib.missingBaselineLines(root, results({ missingBaselines: names }));
      expect(lines.join('\n').length).toBeLessThan(200 * 15);
      expect(lines.filter((l) => !l.startsWith('- '))).toHaveLength(1);
      // No claim that it is committed, and no instruction to delete it.
      if (!committed) expect(lines[0]).not.toMatch(/committed|delete its baseline|git rm/);
    });
  });

  // Stale results (the human already deleted the baseline) or results from a
  // machine whose {platform} resolved elsewhere: no "is committed", no git rm.
  describe('a missing baseline whose directory is not there', () => {
    it('explain_snapshot says the results may be stale or from another platform, and gives no git rm', () => {
      writeResults(results({ missingBaselines: ['gone'] }));
      const e = lib.explainSnapshot(root, 'gone') as import('../lib').MissingBaselineExplanation;
      expect(e.baseline).toEqual({ directory: '.testivai/baselines/gone', files: [] });
      expect(e.verdict).toBe(`missing baseline — ${lib.notHere('.testivai/baselines/gone')}`);
      expect(e.guidance[0]).toBe(lib.notHere('.testivai/baselines/gone').replace(/^./, (c) => c.toUpperCase()) + '.');
      const all = e.guidance.join('\n');
      expect(all).not.toMatch(/is committed/);
      expect(all).not.toMatch(/git rm/);
      expect(all).toMatch(/There is no capture to call bad, so this is not a glitch/);
    });

    it('names this machine\'s platform, which {platform} resolves to', () => {
      expect(lib.notHere('x/gone')).toBe(
        'no baseline directory at x/gone on this machine: the results may be stale (the baseline was already deleted, or the tests have not run since), ' +
          `or come from a machine whose baselinesDir resolved to another directory ({platform} resolves to ${process.platform} here); re-run the tests before judging it`,
      );
    });

    it('a directory that is there but empty keeps the committed wording', () => {
      fs.mkdirSync(path.join(root, '.testivai', 'baselines', 'empty'), { recursive: true });
      writeResults(results({ missingBaselines: ['empty'] }));
      const e = lib.explainSnapshot(root, 'empty') as import('../lib').MissingBaselineExplanation;
      expect(e.guidance).toContain('No committed baseline files were found in .testivai/baselines/empty.');
      expect(e.verdict).toBe(lib.missingVerdict('.testivai/baselines/empty'));
    });
  });

  describe('guards a reviewer found untested', () => {
    it('get_diff serves no screenshot that links out of the baselines directory', () => {
      commitBaseline('.', 'outside');
      commitBaseline('.testivai/baselines', 'products');
      const shot = path.join(root, '.testivai', 'baselines', 'products', 'screenshot.png');
      fs.rmSync(shot);
      fs.symlinkSync(path.join(root, 'outside', 'screenshot.png'), shot);
      const content = lib.missingBaselineDiff(root, results(), 'products')!;
      expect(content.some((x) => x.type === 'image')).toBe(false);
    });

    it('a baseline that links to a sibling directory sharing its prefix is outside', () => {
      commitBaseline('.testivai/baselines-other', 'sib');
      fs.mkdirSync(path.join(root, '.testivai', 'baselines'), { recursive: true });
      fs.symlinkSync(path.join(root, '.testivai', 'baselines-other'), path.join(root, '.testivai', 'baselines', 'sib'));
      expect(lib.missingBaselineDir(root, results({ missingBaselines: ['sib'] }), 'sib')).toBeNull();
    });

    it('quotes a name the shell would split in the git rm command', () => {
      commitBaseline('.testivai/baselines', 'my page');
      writeResults(results({ missingBaselines: ['my page'] }));
      const e = lib.explainSnapshot(root, 'my page') as import('../lib').MissingBaselineExplanation;
      expect(e.guidance.join('\n')).toContain("(git rm -r '.testivai/baselines/my page')");
    });
  });

  // The other half of a rename: a new snapshot read on its own must not look
  // like something to approve when a baseline went missing in the same run.
  it('explain_snapshot for a new snapshot names the missing baselines it may replace', () => {
    commitBaseline('.testivai/baselines', 'products');
    writeResults(results());
    const e = lib.explainSnapshot(root, 'catalog') as import('../lib').SnapshotExplanation;
    expect(e.guidance).toContain(
      'Missing baselines this run (no capture): products. If this new snapshot is one of them under another name, it is a rename: judge the two together before approving it.',
    );
    writeResults(results({ missingBaselines: [] }));
    expect((lib.explainSnapshot(root, 'catalog') as import('../lib').SnapshotExplanation).guidance.join('\n')).not.toMatch(/Missing baselines this run/);
  });
});
