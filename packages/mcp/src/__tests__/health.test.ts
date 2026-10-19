/**
 * @testivai/mcp with capture health (results.json 2.6.0 `captureHealth`).
 * The agent-facing verdicts, explain_snapshot and the triage rubric must say
 * "unhealthy capture" for a capture whose web fonts or stylesheets failed to
 * load, before any other reading, never "likely render noise"; an unhealthy
 * baseline is called out; such a snapshot is never grouped with others.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type CaptureHealth, snapshotCaptureHealth } from '@testivai/witness/report';
import { explainSnapshot, groupChanges, type SnapshotResult, verdictFor } from '../lib';
import { REVIEW_PROMPT, TOOL_META, TRIAGE_PROMPT } from '../tool-meta';

const HEALTHY: CaptureHealth = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};
const FONT_FAILED: CaptureHealth = { ...HEALTHY, fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: 'normal', style: 'normal' }] } };
const CSS_FAILED: CaptureHealth = {
  ...HEALTHY,
  stylesheets: { failed: 1, urls: ['example.com/css/site.css'] },
  resources: { status: 'checked', failed: { css: { count: 1, entries: [{ url: 'example.com/css/site.css', status: 404 }] } } },
};
const IMAGE_BROKEN: CaptureHealth = { ...HEALTHY, images: { broken: 1, urls: ['example.com/img/hero.png'] } };

const ENV_130 = {
  os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
  browser: { name: 'chromium', version: '130.0.6723.58' },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.5', captureMethod: 'full-page:cdp' },
};
const ENV_141 = { ...ENV_130, browser: { name: 'chromium', version: '141.0.7390.37' } };

const noHint = { changed: false, noiseHint: false, summary: null, styleCheck: 'match' as const };
const sameDom = { ...noHint, noiseHint: true };

const changed = (name: string, extra: Partial<SnapshotResult> = {}): SnapshotResult => ({
  name,
  status: 'changed',
  diffPercent: 0.07,
  totalPixels: 921600,
  ...extra,
});

const NEXT =
  'an unhealthy capture is a glitch of the capture or a broken asset, not render noise: fix the page, the server or the test and re-run; never approve it as a baseline';

describe('verdictFor with capture health', () => {
  it('an unhealthy capture with an identical DOM: unhealthy capture, the font named, never render noise', () => {
    const v = verdictFor(changed('home', { dom: noHint, captureHealth: snapshotCaptureHealth(HEALTHY, FONT_FAILED) }));
    expect(v).toBe(`changed (0.07% pixels differ) — unhealthy capture: web font 'Fancy' failed to load, so the page rendered with a fallback font; ${NEXT}`);
  });

  it('an unhealthy baseline: called out, re-baseline from a healthy run', () => {
    const v = verdictFor(changed('home', { dom: noHint, captureHealth: snapshotCaptureHealth(CSS_FAILED, HEALTHY) }));
    expect(v).toBe(
      'changed (0.07% pixels differ) — unhealthy capture: the baseline was captured with a failed stylesheet (stylesheet example.com/css/site.css returned 404); re-baseline from a healthy run',
    );
  });

  it('unhealthy and rendering drift: both, unhealthy first', () => {
    const v = verdictFor(
      changed('home', {
        dom: noHint,
        captureHealth: snapshotCaptureHealth(HEALTHY, FONT_FAILED),
        environment: { delta: ['browser.version'], renderingDelta: ['browser.version'], baseline: ENV_130, candidate: ENV_141 },
      }),
    );
    expect(v).toMatch(/^changed \(0\.07% pixels differ\) — unhealthy capture: web font 'Fancy'/);
    expect(v).toContain('; rendering drift too: chromium 130.0.6723.58 → 141.0.7390.37 since the baseline');
  });

  it('a passed snapshot with an unhealthy capture says so', () => {
    const v = verdictFor({ name: 'home', status: 'passed', diffPercent: 0, captureHealth: snapshotCaptureHealth(FONT_FAILED, FONT_FAILED) });
    expect(v).toMatch(/^passed — no visual change, but neither image shows the page as built \(unhealthy capture: web font 'Fancy'/);
  });

  it('a first capture that is unhealthy: do not approve it', () => {
    const v = verdictFor({ name: 'fresh', status: 'new', captureHealth: snapshotCaptureHealth(null, CSS_FAILED) });
    expect(v).toBe(`new snapshot — unhealthy capture: stylesheet example.com/css/site.css returned 404; ${NEXT}`);
  });

  it('a broken image alone, or healthy sides: the verdict is what it was', () => {
    const plain = changed('home', { dom: sameDom });
    expect(verdictFor({ ...plain, captureHealth: snapshotCaptureHealth(HEALTHY, IMAGE_BROKEN) })).toBe(verdictFor(plain));
    expect(verdictFor({ ...plain, captureHealth: snapshotCaptureHealth(HEALTHY, HEALTHY) })).toBe(verdictFor(plain));
  });
});

describe('explain_snapshot with capture health', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-mcp-health-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const writeResults = (snapshots: SnapshotResult[]) => {
    fs.mkdirSync(path.join(root, 'visual-report'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'visual-report', 'results.json'),
      JSON.stringify({ version: '2.6.0', timestamp: 't', summary: { total: snapshots.length, passed: 0, changed: snapshots.length, newSnapshots: 0 }, snapshots }),
    );
  };

  it('the health layer, and the unhealthy guidance first, never the noise guidance', () => {
    const captureHealth = snapshotCaptureHealth(HEALTHY, FONT_FAILED);
    writeResults([changed('home', { dom: noHint, captureHealth })]);
    const e = explainSnapshot(root, 'home');
    if (!e || !('layers' in e)) throw new Error('no explanation');
    expect(e.layers.health).toEqual(captureHealth);
    expect(e.guidance[0]).toBe(
      "Unhealthy capture: web font 'Fancy' failed to load, so the page rendered with a fallback font. " +
        'The capture does not show the page as built, so this diff is not render noise and says nothing reliable about the page: ' +
        `${NEXT}. If the change under test touched the asset that failed (moved, renamed or removed a font or stylesheet, or changed its path), it is a bug in that change.`,
    );
    expect(e.guidance.join('\n')).not.toMatch(/likely render noise/i);
  });

  it('warnings as guidance; no health layer without health', () => {
    writeResults([changed('home', { dom: sameDom, captureHealth: snapshotCaptureHealth(HEALTHY, IMAGE_BROKEN) }), changed('plain', { dom: sameDom })]);
    const e = explainSnapshot(root, 'home');
    if (!e || !('layers' in e)) throw new Error('no explanation');
    expect(e.guidance).toContain(
      'Capture warnings (they make no capture unhealthy on their own): image example.com/img/hero.png did not load. A broken image shows as a changed region where it sits: check whether it is where the diff is.',
    );
    const plain = explainSnapshot(root, 'plain');
    if (!plain || !('layers' in plain)) throw new Error('no explanation');
    expect(plain.layers.health).toBeNull();
  });
});

describe('groupChanges with capture health', () => {
  it('never groups an unhealthy capture', () => {
    const unhealthy = { dom: noHint, captureHealth: snapshotCaptureHealth(HEALTHY, FONT_FAILED) };
    expect(groupChanges([changed('a', unhealthy), changed('b', unhealthy)])).toEqual([]);
  });
});

describe('the prompts and tool descriptions name unhealthy captures', () => {
  it('the triage rubric: a glitch of the capture or a broken asset; never approve it as a baseline', () => {
    const rubric = TRIAGE_PROMPT.rubric();
    expect(rubric).toContain('captureHealth.unhealthy');
    expect(rubric).toContain(
      'an unhealthy capture is a glitch of the capture or a broken asset; fix the page, the server or the test; never approve it as a baseline',
    );
  });

  it('get_visual_results and the review prompt say an unhealthy capture is never noise', () => {
    expect(TOOL_META.get_visual_results.description).toMatch(/unhealthy capture/);
    expect(REVIEW_PROMPT.text).toMatch(/unhealthy capture/);
  });
});
