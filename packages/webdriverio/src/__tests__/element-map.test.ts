import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { toViewportElementMap, type PageElementMap } from '../element-map';
import { witness } from '../witness';
import type { WitnessBrowser } from '../types';

/**
 * The element map (each element's box + a digest of its computed styles) is
 * what powers the style check, region attribution and page-shift detection
 * on the compare side. WebDriver's Take Screenshot captures the viewport, so
 * the map must describe that viewport: only elements inside it, in
 * screenshot coordinates. Otherwise a restyled element below the fold would
 * "explain" a visible diff it cannot have caused.
 */
const el = (pathName: string, y: number, height = 100, styleHash = 'h') => ({
  path: pathName,
  x: 0,
  y,
  width: 1000,
  height,
  styleHash,
});

describe('toViewportElementMap', () => {
  const page = (overrides: Partial<PageElementMap>): PageElementMap => ({
    elements: [],
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 1280,
    viewportHeight: 800,
    dpr: 1,
    ...overrides,
  });

  it('keeps an unscrolled page as it is', () => {
    const elements = [el('body > header', 0), el('body > main', 300)];
    expect(toViewportElementMap(page({ elements }))).toEqual(elements);
  });

  it('keeps only elements inside the scrolled viewport, moved into screenshot coordinates (DPR 2)', () => {
    // Document coordinates in device pixels, as the collector reports them.
    const elements = [
      el('body > header', 0, 200), // above the viewport: dropped
      el('body > main', 1500, 300), // straddles the top edge: kept at y=-100
      el('body > section', 2000, 400), // fully inside: kept at y=400
      el('body > footer', 3200, 200), // starts exactly at the bottom edge: dropped
    ];
    // scrolled 800 CSS px with DPR 2 => the viewport spans y 1600..3200 in device px
    const out = toViewportElementMap(page({ elements, scrollY: 800, viewportHeight: 800, dpr: 2 }));
    expect(out).toEqual([
      { ...el('body > main', 1500, 300), y: -100 },
      { ...el('body > section', 2000, 400), y: 400 },
    ]);
  });

  it('applies horizontal scroll too', () => {
    const elements = [{ ...el('body > wide', 0), x: 1500, width: 200 }];
    expect(toViewportElementMap(page({ elements, scrollX: 1000 }))).toEqual([
      { ...el('body > wide', 0), x: 500, width: 200 },
    ]);
  });
});

describe('witness() element map', () => {
  const ONE_PX_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-wdio-elements-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const pageMap: PageElementMap = {
    elements: [el('body > header', 0, 200), el('body > footer', 5000, 200)],
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 1280,
    viewportHeight: 800,
    dpr: 1,
  };

  /** execute() answers the element-map script with `map`, anything else with a DOM string. */
  const browserWith = (map: unknown | Error): WitnessBrowser => ({
    takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64),
    execute: jest.fn().mockImplementation(async (script: unknown) => {
      if (typeof script === 'string' && script.includes('viewportWidth')) {
        if (map instanceof Error) throw map;
        return map;
      }
      return '<html><body><h1>Hi</h1></body></html>';
    }),
  });
  const elementsFile = (name: string) => path.join(projectRoot, '.testivai', 'temp', name, 'elements.json');
  const mapScripts = (browser: WitnessBrowser) =>
    (browser.execute as jest.Mock).mock.calls
      .map((c) => c[0])
      .filter((s): s is string => typeof s === 'string' && s.includes('viewportWidth'));

  it('writes elements.json with the elements in the captured viewport', async () => {
    await witness(browserWith(pageMap), 'home');
    expect(JSON.parse(fs.readFileSync(elementsFile('home'), 'utf8'))).toEqual([el('body > header', 0, 200)]);
  });

  it('collects with the shared witness collector, honouring ignoreSelectors and maxElements', async () => {
    const browser = browserWith(pageMap);
    await witness(browser, 'home', { ignoreSelectors: ['#clock'], maxElements: 50 });
    const [script] = mapScripts(browser);
    expect(script).toContain('getBoundingClientRect');
    expect(script).toContain('["#clock"]');
    expect(script).toMatch(/,\s*50\s*,/);
  });

  it('skips the element map when skipElementMap: true', async () => {
    const browser = browserWith(pageMap);
    await witness(browser, 'home', { skipElementMap: true });
    expect(mapScripts(browser)).toHaveLength(0);
    expect(fs.existsSync(elementsFile('home'))).toBe(false);
  });

  it('never fails the capture when the element map cannot be collected', async () => {
    await witness(browserWith(new Error('script timeout')), 'home');
    expect(fs.existsSync(path.join(projectRoot, '.testivai', 'temp', 'home', 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(elementsFile('home'))).toBe(false);
  });

  it('writes no elements.json when nothing is in the viewport or the result is malformed', async () => {
    await witness(browserWith({ ...pageMap, elements: [el('body > footer', 5000)] }), 'empty');
    await witness(browserWith('not a map'), 'malformed');
    expect(fs.existsSync(elementsFile('empty'))).toBe(false);
    expect(fs.existsSync(elementsFile('malformed'))).toBe(false);
  });
});
