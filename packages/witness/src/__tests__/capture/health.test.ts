/**
 * Capture health, collection side (capture/health.ts): the in-page probe that
 * records what failed to load, read after the capture, and the validator every
 * reader of a recorded block goes through. The probe is a self-contained
 * expression, so it runs here against a fake page in a fresh VM context, the
 * way a browser evaluates it; e2e/src/health-probe.test.ts runs it in Chrome.
 */
import * as vm from 'vm';
import {
  HEALTH_LIMITS,
  HEALTH_PROBE_EXPRESSION,
  hostPath,
  mergeResourceFailures,
  parseHealth,
  resourceTypeFromCdp,
  type CaptureHealth,
} from '../../capture/health';

interface FakeFace {
  family: string;
  weight?: string;
  style?: string;
  status: 'unloaded' | 'loading' | 'loaded' | 'error';
}
interface FakeLink {
  rel: string;
  href: string;
  sheet: object | null;
  disabled?: boolean;
}
interface FakeImage {
  src: string;
  complete: boolean;
  naturalWidth: number;
}
interface FakeEntry {
  name: string;
  initiatorType: string;
  responseStatus?: number;
}
interface FakePage {
  /** null: no Font Loading API. */
  fonts?: { status: string; faces: FakeFace[] } | null;
  links?: FakeLink[];
  images?: FakeImage[];
  /** null: no Performance API. */
  resources?: FakeEntry[] | null;
  /** Whether PerformanceResourceTiming has responseStatus (Chromium 109+). Default true. */
  responseStatus?: boolean;
}

const BASE = 'https://example.com/shop/index.html';

/** Evaluate the probe against a fake page, and take its result through JSON as a browser driver does. */
function probe(page: FakePage = {}): unknown {
  const fonts =
    page.fonts === null
      ? undefined
      : {
          status: page.fonts?.status ?? 'loaded',
          forEach(cb: (face: unknown) => void) {
            for (const f of page.fonts?.faces ?? []) cb({ weight: 'normal', style: 'normal', ...f });
          },
        };
  const links = (page.links ?? []).map((l) => ({
    ...l,
    getAttribute: (name: string) => (name === 'rel' ? l.rel : name === 'href' ? l.href : null),
  }));
  const document = {
    baseURI: BASE,
    fonts,
    images: page.images ?? [],
    querySelectorAll: (selector: string) => (selector === 'link[rel]' ? links : []),
  };
  const context: Record<string, unknown> = { document, window: {}, URL };
  if (page.resources !== null) {
    context.performance = { getEntriesByType: (type: string) => (type === 'resource' ? (page.resources ?? []) : []) };
  }
  if (page.responseStatus !== false) context.PerformanceResourceTiming = { prototype: { responseStatus: 0 } };
  return JSON.parse(JSON.stringify(vm.runInNewContext(HEALTH_PROBE_EXPRESSION, context)));
}

const HEALTHY: CaptureHealth = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};

describe('HEALTH_PROBE_EXPRESSION', () => {
  it('is one self-contained expression: no imports, no free names beyond the page globals', () => {
    expect(HEALTH_PROBE_EXPRESSION.trim().startsWith('(function')).toBe(true);
    expect(HEALTH_PROBE_EXPRESSION).not.toMatch(/\brequire\(|\bimport\b|=>/);
  });

  it('a healthy page: fonts loaded, every stylesheet and image loaded, no failed request', () => {
    const raw = probe({
      fonts: { status: 'loaded', faces: [{ family: 'Inter', status: 'loaded' }, { family: 'Unused', status: 'unloaded' }] },
      links: [{ rel: 'stylesheet', href: 'https://example.com/css/site.css', sheet: {} }],
      images: [{ src: 'https://example.com/logo.png', complete: true, naturalWidth: 120 }],
      resources: [
        { name: 'https://example.com/css/site.css', initiatorType: 'link', responseStatus: 200 },
        { name: 'https://example.com/logo.png', initiatorType: 'img', responseStatus: 304 },
      ],
    });
    expect(raw).toEqual(HEALTHY);
    expect(parseHealth(raw)).toEqual(HEALTHY);
  });

  it('a web font whose file 404s: the face that errored (quotes off its family) and the font request', () => {
    const raw = probe({
      fonts: { status: 'loaded', faces: [{ family: '"Fancy"', weight: '700', style: 'italic', status: 'error' }] },
      resources: [{ name: 'https://example.com/fonts/fancy.woff2?v=3', initiatorType: 'css', responseStatus: 404 }],
    });
    expect(parseHealth(raw)).toEqual({
      ...HEALTHY,
      fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: '700', style: 'italic' }] },
      resources: { status: 'checked', failed: { font: { count: 1, entries: [{ url: 'example.com/fonts/fancy.woff2', status: 404 }] } } },
    });
  });

  it('fonts still loading after the capture', () => {
    expect(parseHealth(probe({ fonts: { status: 'loading', faces: [] } }))?.fonts).toEqual({ status: 'loading', failed: [] });
  });

  it("no Font Loading API: 'unavailable', not loaded", () => {
    expect(parseHealth(probe({ fonts: null }))?.fonts).toEqual({ status: 'unavailable', failed: [] });
  });

  it('a stylesheet that did not load (sheet null): host and path only, never the query string', () => {
    const raw = probe({
      links: [
        { rel: 'stylesheet', href: 'https://cdn.example.net/css/site.css?token=s3cret', sheet: null },
        { rel: 'Preload Stylesheet', href: '/css/print.css', sheet: null },
        { rel: 'alternate stylesheet', href: '/css/dark.css', sheet: null },
        { rel: 'stylesheet', href: '/css/off.css', sheet: null, disabled: true },
        { rel: 'icon', href: '/favicon.ico', sheet: null },
        { rel: 'stylesheet', href: '/css/ok.css', sheet: {} },
      ],
      resources: [{ name: 'https://cdn.example.net/css/site.css?token=s3cret', initiatorType: 'link', responseStatus: 404 }],
    });
    const health = parseHealth(raw);
    expect(health?.stylesheets).toEqual({ failed: 2, urls: ['cdn.example.net/css/site.css', 'example.com/css/print.css'] });
    expect(health?.resources).toEqual({ status: 'checked', failed: { css: { count: 1, entries: [{ url: 'cdn.example.net/css/site.css', status: 404 }] } } });
    expect(JSON.stringify(raw)).not.toContain('s3cret');
  });

  it('a stylesheet whose request answered 404 failed, although Chromium gives it an (empty) sheet', () => {
    const raw = probe({
      links: [{ rel: 'stylesheet', href: 'https://example.com/css/missing.css', sheet: {} }],
      resources: [{ name: 'https://example.com/css/missing.css', initiatorType: 'link', responseStatus: 404 }],
    });
    expect(parseHealth(raw)?.stylesheets).toEqual({ failed: 1, urls: ['example.com/css/missing.css'] });
  });

  it('a broken image: complete with no pixels; an image still loading or without a source is not broken', () => {
    const raw = probe({
      images: [
        { src: 'https://example.com/img/hero.png?sig=abc', complete: true, naturalWidth: 0 },
        { src: 'https://example.com/img/lazy.png', complete: false, naturalWidth: 0 },
        { src: '', complete: true, naturalWidth: 0 },
        { src: 'https://example.com/img/ok.png', complete: true, naturalWidth: 64 },
      ],
      resources: [{ name: 'https://example.com/img/hero.png?sig=abc', initiatorType: 'img', responseStatus: 404 }],
    });
    expect(parseHealth(raw)).toEqual({
      ...HEALTHY,
      images: { broken: 1, urls: ['example.com/img/hero.png'] },
      resources: { status: 'checked', failed: { img: { count: 1, entries: [{ url: 'example.com/img/hero.png', status: 404 }] } } },
    });
  });

  it('groups failed requests by type: by extension first, then by what started the request', () => {
    const raw = probe({
      // An extensionless stylesheet is css because a <link rel=stylesheet> names it.
      links: [{ rel: 'stylesheet', href: 'https://example.com/styles', sheet: {} }],
      resources: [
        { name: 'https://example.com/a.css', initiatorType: 'link', responseStatus: 404 },
        { name: 'https://example.com/styles', initiatorType: 'link', responseStatus: 500 },
        { name: 'https://example.com/f.ttf', initiatorType: 'css', responseStatus: 404 },
        { name: 'https://example.com/bg.webp', initiatorType: 'css', responseStatus: 403 },
        { name: 'https://example.com/app.mjs', initiatorType: 'script', responseStatus: 502 },
        { name: 'https://example.com/api/items', initiatorType: 'fetch', responseStatus: 503 },
        { name: 'https://example.com/manifest.json', initiatorType: 'link', responseStatus: 404 },
        { name: 'https://example.com/a.css', initiatorType: 'link', responseStatus: 404 },
        { name: 'https://example.com/fine.js', initiatorType: 'script', responseStatus: 200 },
        { name: 'https://other.example/x.js', initiatorType: 'script', responseStatus: 0 },
        // The favicon the browser asks for by itself: not the page's.
        { name: 'https://example.com/favicon.ico', initiatorType: 'other', responseStatus: 404 },
      ],
    });
    expect(parseHealth(raw)?.resources).toEqual({
      status: 'checked',
      failed: {
        css: { count: 2, entries: [{ url: 'example.com/a.css', status: 404 }, { url: 'example.com/styles', status: 500 }] },
        font: { count: 1, entries: [{ url: 'example.com/f.ttf', status: 404 }] },
        img: { count: 1, entries: [{ url: 'example.com/bg.webp', status: 403 }] },
        script: { count: 1, entries: [{ url: 'example.com/app.mjs', status: 502 }] },
        other: {
          count: 2,
          entries: [
            { url: 'example.com/api/items', status: 503 },
            { url: 'example.com/manifest.json', status: 404 },
          ],
        },
      },
    });
  });

  it('a <link> request is css only when a <link rel=stylesheet> names it or it ends in .css: a 404 preload of an extensionless image is not a stylesheet', () => {
    const raw = probe({
      links: [
        { rel: 'preload', href: '/_next/image?url=%2Fhero.png&w=1080', sheet: null },
        { rel: 'modulepreload', href: '/_next/static/chunk', sheet: null },
        { rel: 'stylesheet', href: '/theme?v=2', sheet: {} },
      ],
      resources: [
        { name: 'https://example.com/_next/image?url=%2Fhero.png&w=1080', initiatorType: 'link', responseStatus: 404 },
        { name: 'https://example.com/_next/static/chunk', initiatorType: 'link', responseStatus: 404 },
        { name: 'https://example.com/theme?v=2', initiatorType: 'link', responseStatus: 404 },
        { name: 'https://example.com/print.css', initiatorType: 'link', responseStatus: 404 },
      ],
    });
    expect(parseHealth(raw)?.resources).toEqual({
      status: 'checked',
      failed: {
        other: {
          count: 2,
          entries: [
            { url: 'example.com/_next/image', status: 404 },
            { url: 'example.com/_next/static/chunk', status: 404 },
          ],
        },
        css: {
          count: 2,
          entries: [
            { url: 'example.com/theme', status: 404 },
            { url: 'example.com/print.css', status: 404 },
          ],
        },
      },
    });
  });

  it('a fetch() or XHR request is never a stylesheet, whatever its extension: the page did not apply it', () => {
    const raw = probe({
      resources: [
        { name: 'https://example.com/theme.css', initiatorType: 'fetch', responseStatus: 404 },
        { name: 'https://example.com/legacy.css', initiatorType: 'xmlhttprequest', responseStatus: 404 },
      ],
    });
    expect(parseHealth(raw)?.resources).toEqual({
      status: 'checked',
      failed: {
        other: {
          count: 2,
          entries: [
            { url: 'example.com/theme.css', status: 404 },
            { url: 'example.com/legacy.css', status: 404 },
          ],
        },
      },
    });
  });

  it("no responseStatus (before Chromium 109, or another engine): resources 'unavailable'", () => {
    expect(parseHealth(probe({ responseStatus: false, resources: [{ name: 'https://example.com/a.css', initiatorType: 'link' }] }))?.resources).toEqual({
      status: 'unavailable',
      failed: {},
    });
    expect(parseHealth(probe({ resources: null }))?.resources).toEqual({ status: 'unavailable', failed: {} });
  });

  it(`caps every list at ${HEALTH_LIMITS.list} entries and keeps the full count`, () => {
    const many = Array.from({ length: 14 }, (_, i) => i);
    const health = parseHealth(
      probe({
        fonts: { status: 'loaded', faces: many.map((i) => ({ family: `F${i}`, status: 'error' as const })) },
        links: many.map((i) => ({ rel: 'stylesheet', href: `/s${i}.css`, sheet: null })),
        images: many.map((i) => ({ src: `/i${i}.png`, complete: true, naturalWidth: 0 })),
        resources: many.map((i) => ({ name: `https://example.com/s${i}.css`, initiatorType: 'link', responseStatus: 404 })),
      }),
    );
    expect(health?.fonts.failed).toHaveLength(HEALTH_LIMITS.list);
    expect(health?.stylesheets).toMatchObject({ failed: 14 });
    expect(health?.stylesheets.urls).toHaveLength(HEALTH_LIMITS.list);
    expect(health?.images).toMatchObject({ broken: 14 });
    expect(health?.images.urls).toHaveLength(HEALTH_LIMITS.list);
    expect(health?.resources.failed.css?.count).toBe(14);
    expect(health?.resources.failed.css?.entries).toHaveLength(HEALTH_LIMITS.list);
  });

  it('a page API that throws never fails the probe', () => {
    const context = {
      document: {
        get fonts() {
          throw new Error('denied');
        },
        baseURI: BASE,
        images: [],
        querySelectorAll: () => [],
      },
      window: {},
      URL,
    };
    const raw = JSON.parse(JSON.stringify(vm.runInNewContext(HEALTH_PROBE_EXPRESSION, context)));
    expect(parseHealth(raw)).toEqual({ ...HEALTHY, fonts: { status: 'unavailable', failed: [] }, resources: { status: 'unavailable', failed: {} } });
  });
});

describe('hostPath', () => {
  it('keeps the host and the path, drops the scheme, the query and the fragment', () => {
    expect(hostPath('https://cdn.example.com:8443/css/site.css?v=1&token=abc#x')).toBe('cdn.example.com:8443/css/site.css');
    expect(hostPath('http://127.0.0.1:4000/fonts/fancy.ttf')).toBe('127.0.0.1:4000/fonts/fancy.ttf');
  });

  it('names a data: or blob: URL by its scheme only, and gives up on what is not a URL', () => {
    expect(hostPath('data:font/woff2;base64,AAAA')).toBe('data:');
    expect(hostPath('blob:https://example.com/123')).toBe('blob:');
    expect(hostPath('not a url')).toBe('');
  });

  it(`is at most ${HEALTH_LIMITS.url} characters`, () => {
    expect(hostPath(`https://example.com/${'a'.repeat(500)}`)).toHaveLength(HEALTH_LIMITS.url);
  });
});

describe('parseHealth', () => {
  it('returns a normalized copy: unknown fields dropped', () => {
    expect(parseHealth({ ...HEALTHY, extra: 1, fonts: { ...HEALTHY.fonts, more: true } })).toEqual(HEALTHY);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a list', []],
    ['text', 'healthy'],
    ['no fonts', { ...HEALTHY, fonts: undefined }],
    ['an unknown font status', { ...HEALTHY, fonts: { status: 'ok', failed: [] } }],
    ['a face without a family', { ...HEALTHY, fonts: { status: 'loaded', failed: [{ weight: '400', style: 'normal' }] } }],
    ['a negative count', { ...HEALTHY, stylesheets: { failed: -1, urls: [] } }],
    ['a fractional count', { ...HEALTHY, images: { broken: 1.5, urls: [] } }],
    ['a url that is not text', { ...HEALTHY, images: { broken: 1, urls: [42] } }],
    ['an over-long url', { ...HEALTHY, images: { broken: 1, urls: ['x'.repeat(HEALTH_LIMITS.url + 1)] } }],
    ['an unknown resource status', { ...HEALTHY, resources: { status: 'maybe', failed: {} } }],
    ['an unknown resource type', { ...HEALTHY, resources: { status: 'checked', failed: { video: { count: 1, entries: [] } } } }],
    ['a resource entry without a status', { ...HEALTHY, resources: { status: 'checked', failed: { css: { count: 1, entries: [{ url: 'a.css' }] } } } }],
  ])('rejects %s: null (not checked), never a throw', (_label, raw) => {
    expect(parseHealth(raw)).toBeNull();
  });

  it(`caps lists longer than ${HEALTH_LIMITS.list} instead of rejecting them`, () => {
    const urls = Array.from({ length: 25 }, (_, i) => `example.com/${i}.png`);
    expect(parseHealth({ ...HEALTHY, images: { broken: 25, urls } })?.images.urls).toEqual(urls.slice(0, HEALTH_LIMITS.list));
  });
});

describe('mergeResourceFailures (network-side evidence, same shape)', () => {
  it('adds requests the page could not see a status for, and marks the resources checked', () => {
    const fromProbe: CaptureHealth = { ...HEALTHY, resources: { status: 'unavailable', failed: {} } };
    const merged = mergeResourceFailures(fromProbe, [
      { url: 'https://fonts.cdn.example/f.woff2?k=1', type: 'font', status: 404 },
      { url: 'https://example.com/a.css', type: 'css', status: 0, error: 'net::ERR_CONNECTION_REFUSED' },
    ]);
    expect(merged.resources).toEqual({
      status: 'checked',
      failed: {
        font: { count: 1, entries: [{ url: 'fonts.cdn.example/f.woff2', status: 404 }] },
        css: { count: 1, entries: [{ url: 'example.com/a.css', status: 0, error: 'net::ERR_CONNECTION_REFUSED' }] },
      },
    });
    expect(fromProbe.resources.status).toBe('unavailable'); // not mutated
  });

  it('never counts a request twice, and a status replaces a failure without one', () => {
    const fromProbe: CaptureHealth = {
      ...HEALTHY,
      resources: { status: 'checked', failed: { css: { count: 1, entries: [{ url: 'example.com/a.css', status: 0, error: 'net::ERR_FAILED' }] } } },
    };
    const merged = mergeResourceFailures(fromProbe, [
      { url: 'https://example.com/a.css', type: 'css', status: 404 },
      { url: 'https://example.com/a.css', type: 'css', status: 404 },
    ]);
    expect(merged.resources.failed).toEqual({ css: { count: 1, entries: [{ url: 'example.com/a.css', status: 404 }] } });
  });

  it("a request the page grouped by another type moves to the network's (the request's destination): counted once", () => {
    const fromProbe: CaptureHealth = {
      ...HEALTHY,
      resources: {
        status: 'checked',
        failed: {
          // An extensionless <link rel=preload as=image> the page cannot tell from other requests.
          other: {
            count: 2,
            entries: [
              { url: 'example.com/_next/image', status: 404 },
              { url: 'example.com/api/items', status: 503 },
            ],
          },
          css: { count: 1, entries: [{ url: 'example.com/x', status: 404 }] },
        },
      },
    };
    const merged = mergeResourceFailures(fromProbe, [
      { url: 'https://example.com/_next/image?url=%2Fhero.png', type: 'img', status: 404 },
      // No status on the network side: the page's status is kept.
      { url: 'https://example.com/x', type: 'other', status: 0, error: 'net::ERR_ABORTED' },
    ]);
    expect(merged.resources.failed).toEqual({
      other: {
        count: 2,
        entries: [
          { url: 'example.com/api/items', status: 503 },
          { url: 'example.com/x', status: 404 },
        ],
      },
      img: { count: 1, entries: [{ url: 'example.com/_next/image', status: 404 }] },
    });
    expect(fromProbe.resources.failed.other?.count).toBe(2); // not mutated
  });

  it('an empty list still says the requests were checked', () => {
    expect(mergeResourceFailures({ ...HEALTHY, resources: { status: 'unavailable', failed: {} } }, []).resources).toEqual({ status: 'checked', failed: {} });
  });
});

describe('resourceTypeFromCdp', () => {
  it('maps CDP resource types onto the probe groups', () => {
    expect(resourceTypeFromCdp('Stylesheet')).toBe('css');
    expect(resourceTypeFromCdp('Font')).toBe('font');
    expect(resourceTypeFromCdp('Image')).toBe('img');
    expect(resourceTypeFromCdp('Script')).toBe('script');
    expect(resourceTypeFromCdp('Fetch')).toBe('other');
    expect(resourceTypeFromCdp(undefined)).toBe('other');
  });
});
