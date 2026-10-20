/**
 * parseReportData: read a results.json you did not produce.
 *
 * A published report is rebuilt from results.json, and that file can come
 * from a CI run the reader does not control (a fork's pull request). Strings
 * are escaped when the report is rendered; numbers, enums and the shape of
 * the data are not, so this checks every field's type and size, drops every
 * field it does not know, and never takes image paths from the file (the
 * caller adds them for the images it actually has).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaselineStore } from '../baselines/store';
import { generateReport, RESULTS_SCHEMA_VERSION } from '../report/generator';
import type { ReportData } from '../report/results';
import { renderHtml } from '../report/template';
import { parseReportData, SUPPORTED_SCHEMA_MAJOR } from '../report/validate';

const ENV_BASE = {
  os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' },
  browser: { name: 'chromium', version: '130.0.6723.58', headless: true },
  framework: { name: 'playwright', version: '1.63.0', language: null },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.9', captureMethod: 'full-page:cdp' },
  render: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: 'light' },
  ci: { provider: 'github-actions', runnerImage: 'ubuntu24/20261012' },
  container: false,
  label: 'ci',
};
const ENV_CURRENT = { ...ENV_BASE, browser: { name: 'chromium', version: '141.0.7390.37', headless: true } };

function valid(): Record<string, any> {
  return {
    version: '2.5.0',
    environment: { os: { platform: 'linux', arch: 'x64' }, browser: { name: 'chromium' }, container: false },
    timestamp: '2026-10-18T00:00:00.000Z',
    summary: { total: 2, passed: 1, changed: 1, newSnapshots: 0, missing: 1 },
    missingBaselines: ['old-page'],
    snapshots: [
      {
        name: 'home',
        status: 'changed',
        diffPercent: 2.5,
        diffCount: 200,
        totalPixels: 8000,
        baselinePath: 'images/home/baseline.png',
        currentPath: 'images/home/current.png',
        diffPath: 'images/home/diff.png',
        thumbPath: 'images/home/thumb.png',
        baselineApprovedAt: '2026-10-01T00:00:00.000Z',
        dom: {
          changed: true,
          noiseHint: false,
          summary: { added: 2, removed: 0, attributeChanges: 1, textChanges: 1 },
          styleCheck: 'mismatch',
          styleChanges: { count: 1, elements: ['main > h1'] },
        },
        regions: [
          {
            x: 1, y: 2, width: 30, height: 40, diffPixels: 120, diffPercent: 10,
            classification: 'shift', shift: { dx: 0, dy: 4 },
            elements: [{ selector: 'main > h1', role: 'shifted' }],
          },
        ],
        masks: [{ x: 0, y: 0, width: 10, height: 10, source: { type: 'selector', spec: '.ad', origin: 'config' } }],
        maskWarnings: ['no geometry for .gone'],
        pageShift: { dy: 4, belowY: 120, count: 3 },
        sizeMismatch: { baseline: { width: 1280, height: 2000 }, candidate: { width: 1280, height: 2004 } },
        environment: {
          delta: ['browser.version', 'ci.runnerImage'],
          renderingDelta: ['browser.version'],
          baseline: ENV_BASE,
          candidate: ENV_CURRENT,
          policy: 'strict',
        },
      },
      {
        name: 'footer',
        status: 'passed',
        diffPercent: 0.1,
        diffCount: 8,
        totalPixels: 8000,
        autoPassed: 'threshold',
        masks: [{ x: 0, y: 0, width: 5, height: 5, source: { type: 'region', spec: { x: 0, y: 0, width: '10%', height: 5 }, origin: 'call' } }],
      },
    ],
  };
}

/** Set a value at a dotted path ("snapshots.0.regions.0.width"). */
function withValue(path: string, value: unknown): Record<string, any> {
  const data = valid();
  const keys = path.split('.');
  let node: any = data;
  for (const key of keys.slice(0, -1)) node = node[key];
  node[keys[keys.length - 1]] = value;
  return data;
}

describe('parseReportData', () => {
  it('accepts a results.json TestivAI writes, unchanged apart from the image paths', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-validate-'));
    try {
      const store = new BaselineStore(tmp);
      store.write('home', Buffer.from('baseline-bytes'));
      store.writeTemp('home', Buffer.from('current-bytes-differ'));
      store.writeTemp('signup', Buffer.from('new-bytes'));
      const reportDir = path.join(tmp, 'visual-report');
      generateReport({ projectRoot: tmp, reportDir, autoOpen: false });
      const written = JSON.parse(fs.readFileSync(path.join(reportDir, 'results.json'), 'utf-8'));

      const parsed = parseReportData(written);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const withoutPaths = JSON.parse(JSON.stringify(written));
      for (const s of withoutPaths.snapshots) {
        delete s.baselinePath;
        delete s.currentPath;
        delete s.diffPath;
        delete s.thumbPath;
      }
      expect(parsed.data).toEqual(withoutPaths);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads the major version the report generator writes', () => {
    expect(SUPPORTED_SCHEMA_MAJOR).toBe(Number(RESULTS_SCHEMA_VERSION.split('.')[0]));
  });

  it('accepts every field it knows, with the right types', () => {
    expect(parseReportData(valid()).ok).toBe(true);
  });

  it('keeps the capture environments (schema 2.5.0) exactly', () => {
    const data = valid();
    const parsed = parseReportData(data);
    if (!parsed.ok) throw new Error(parsed.reason);

    expect(parsed.data.environment).toEqual(data.environment);
    expect(parsed.data.snapshots[0].environment).toEqual(data.snapshots[0].environment);
  });

  it('keeps environment fields it does not know yet, when they are plain values', () => {
    const data = valid();
    data.snapshots[0].environment.candidate = { ...ENV_CURRENT, gpu: 'swiftshader', browser: { ...ENV_CURRENT.browser, flags: '--disable-gpu' } };
    const parsed = parseReportData(data);
    if (!parsed.ok) throw new Error(parsed.reason);

    expect(parsed.data.snapshots[0].environment?.candidate).toMatchObject({ gpu: 'swiftshader', browser: { flags: '--disable-gpu' } });
  });

  it('never takes image paths from the file', () => {
    const parsed = parseReportData(valid());
    if (!parsed.ok) throw new Error(parsed.reason);
    for (const s of parsed.data.snapshots) {
      expect(s.baselinePath).toBeUndefined();
      expect(s.currentPath).toBeUndefined();
      expect(s.diffPath).toBeUndefined();
      expect(s.thumbPath).toBeUndefined();
    }
  });

  it('accepts a thumbnail path as text (schema 2.6.0), and still never takes it from the file', () => {
    const parsed = parseReportData(withValue('snapshots.0.thumbPath', 'images/home/thumb.png'));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.snapshots[0].thumbPath).toBeUndefined();
  });

  it('drops fields it does not know, at every level', () => {
    const data = valid();
    data.extra = '<script>';
    data.summary.extra = 1;
    data.snapshots[0].extra = 'x';
    data.snapshots[0].dom.extra = true;
    data.snapshots[0].regions[0].extra = 'x';
    data.snapshots[0].regions[0].elements[0].extra = 'x';
    data.snapshots[0].masks[0].source.extra = 'x';

    const parsed = parseReportData(data);

    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('extra');
  });

  it('accepts results from an older 2.x schema without the newer fields', () => {
    const old = {
      version: '2.0.0',
      timestamp: '2026-01-01T00:00:00.000Z',
      summary: { total: 1, passed: 0, changed: 1, newSnapshots: 0 },
      snapshots: [{ name: 'home', status: 'changed', diffPercent: 1, diffCount: 10, totalPixels: 1000, dom: { changed: false, noiseHint: true, summary: null } }],
    };

    expect(parseReportData(old).ok).toBe(true);
  });

  it.each([
    ['a newer major schema', withValue('version', '3.0.0'), /3\.0\.0/],
    ['a version that is not a schema version', withValue('version', '<b>'), /version/],
    ['no snapshots list', withValue('snapshots', undefined), /snapshots/],
    ['a count as text', withValue('summary.total', '1'), /summary\.total/],
    ['a negative count', withValue('summary.changed', -1), /summary\.changed/],
    ['an unknown status', withValue('snapshots.0.status', 'pwned'), /snapshots\[0\]\.status/],
    ['a name that is not text', withValue('snapshots.0.name', 42), /snapshots\[0\]\.name/],
    ['an empty name', withValue('snapshots.0.name', ''), /snapshots\[0\]\.name/],
    ['a very long name', withValue('snapshots.0.name', 'x'.repeat(301)), /snapshots\[0\]\.name/],
    ['a diff percent as markup', withValue('snapshots.0.diffPercent', '<img src=x>'), /snapshots\[0\]\.diffPercent/],
    ['a diff percent that is not finite', withValue('snapshots.0.diffPercent', null), /snapshots\[0\]\.diffPercent/],
    ['a region size as markup', withValue('snapshots.0.regions.0.width', '"><img src=x>'), /regions\[0\]\.width/],
    ['an unknown region classification', withValue('snapshots.0.regions.0.classification', 'x'), /classification/],
    ['a shift as text', withValue('snapshots.0.regions.0.shift', { dx: '1', dy: 0 }), /shift/],
    ['an element role it does not know', withValue('snapshots.0.regions.0.elements.0.role', 'x'), /role/],
    ['a selector that is not text', withValue('snapshots.0.regions.0.elements.0.selector', {}), /selector/],
    ['a DOM flag as text', withValue('snapshots.0.dom.changed', 'yes'), /dom\.changed/],
    ['a DOM summary count as text', withValue('snapshots.0.dom.summary.added', '2'), /dom\.summary\.added/],
    ['an unknown style check', withValue('snapshots.0.dom.styleCheck', 'maybe'), /styleCheck/],
    ['a restyled element that is not text', withValue('snapshots.0.dom.styleChanges.elements', [1]), /styleChanges/],
    ['an unknown auto-pass criterion', withValue('snapshots.1.autoPassed', '<b>'), /autoPassed/],
    ['an unknown mask origin', withValue('snapshots.0.masks.0.source.origin', '<b>'), /origin/],
    ['an unknown mask type', withValue('snapshots.0.masks.0.source.type', 'x'), /source\.type/],
    ['a mask spec that is neither text nor a flat object', withValue('snapshots.1.masks.0.source.spec', { x: { y: 1 } }), /spec/],
    ['a mask warning that is not text', withValue('snapshots.0.maskWarnings', [{}]), /maskWarnings/],
    ['a page shift as text', withValue('snapshots.0.pageShift', { dy: '4', belowY: 1, count: 1 }), /pageShift/],
    ['a size that is not positive', withValue('snapshots.0.sizeMismatch', { baseline: { width: 0, height: 1 }, candidate: { width: 1, height: 1 } }), /sizeMismatch/],
    ['an approval date that is not text', withValue('snapshots.0.baselineApprovedAt', 5), /baselineApprovedAt/],
    ['a thumbnail path that is not text', withValue('snapshots.0.thumbPath', 42), /snapshots\[0\]\.thumbPath/],
    ['a thumbnail path that is an object', withValue('snapshots.0.thumbPath', { src: 'x' }), /snapshots\[0\]\.thumbPath/],
    ['a thumbnail path that is null', withValue('snapshots.0.thumbPath', null), /snapshots\[0\]\.thumbPath/],
    ['a missing baseline that is not text', withValue('missingBaselines', [null]), /missingBaselines/],
    ['an environment delta that is not a list', withValue('snapshots.0.environment.delta', 'browser.version'), /environment\.delta/],
    ['an environment field name that is not text', withValue('snapshots.0.environment.renderingDelta', [1]), /renderingDelta/],
    ['an unknown environment policy', withValue('snapshots.0.environment.policy', 'loose'), /policy/],
    ['a baseline environment without its capture method', withValue('snapshots.0.environment.baseline', { ...ENV_BASE, adapter: { name: 'x', version: '1' } }), /baseline\.adapter\.captureMethod/],
    ['a candidate environment without a browser name', withValue('snapshots.0.environment.candidate', { ...ENV_CURRENT, browser: { version: '1' } }), /candidate\.browser\.name/],
    ['an environment value nested too deep', withValue('snapshots.0.environment.candidate', { ...ENV_CURRENT, browser: { name: 'chromium', build: { a: 1 } } }), /candidate\.browser\.build/],
    ['an environment value that is a list', withValue('environment', { os: { platform: 'linux' }, tags: ['a'] }), /environment\.tags/],
    ['a viewport size as text', withValue('snapshots.0.environment.baseline', { ...ENV_BASE, render: { viewport: { width: '1280', height: 720 } } }), /viewport\.width/],
    ['a very long environment value', withValue('environment', { label: 'x'.repeat(201) }), /environment\.label/],
    ['too many environment sections', withValue('environment', Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']))), /environment/],
    ['too many snapshots', withValue('snapshots', Array.from({ length: 5001 }, (_, i) => ({ name: `s${i}`, status: 'passed', diffPercent: 0, diffCount: 0, totalPixels: 1 }))), /snapshots/],
    ['too many regions', withValue('snapshots.0.regions', Array.from({ length: 1001 }, () => ({ x: 0, y: 0, width: 1, height: 1, diffPixels: 1, diffPercent: 1 }))), /regions/],
  ])('rejects %s, naming the field', (_label, data, field) => {
    const parsed = parseReportData(data);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(field);
  });

  it.each([null, 'text', 42, [], undefined])('rejects %p as a whole', (data) => {
    expect(parseReportData(data).ok).toBe(false);
  });

  it('says a newer major schema needs the ZIP or a newer TestivAI', () => {
    const parsed = parseReportData(withValue('version', '3.1.0'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/newer/i);
  });

  it('gives the template only typed data: hostile text in every string field renders as text', () => {
    const PAYLOAD = '"><img src=x onerror=alert(1)>';
    const data = valid();
    data.timestamp = '2026-10-18T00:00:00.000Z';
    data.missingBaselines = [PAYLOAD];
    const s = data.snapshots[0];
    s.name = PAYLOAD;
    s.baselineApprovedAt = PAYLOAD;
    s.dom.styleChanges.elements = [PAYLOAD];
    s.regions[0].elements[0].selector = PAYLOAD;
    s.masks[0].source.spec = PAYLOAD;
    s.maskWarnings = [PAYLOAD];
    s.environment.candidate = { ...ENV_CURRENT, label: PAYLOAD, browser: { name: PAYLOAD, version: PAYLOAD } };
    s.environment.baseline = { ...ENV_BASE, adapter: { name: 'a', version: '1', captureMethod: PAYLOAD } };
    s.environment.renderingDelta = ['browser.version', 'label', 'adapter.captureMethod'];
    s.environment.delta = s.environment.renderingDelta;
    s.sizeMismatch = { baseline: { width: 1280, height: 2000 }, candidate: { width: 1280, height: 2400 } };

    const parsed = parseReportData(data);
    if (!parsed.ok) throw new Error(parsed.reason);
    const html = renderHtml(parsed.data as ReportData);

    expect(html).not.toContain('<img src=x');
  });
});
