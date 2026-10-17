import { filterCrawledLinks, pageNameFromUrl, parseViewport, resolvePages } from '../standalone/crawl';
import { chromeLaunchArgs, findChrome, needsNoSandbox } from '../standalone/launcher';
import { standaloneEnvironment } from '../standalone/run';

describe('standalone witness helpers', () => {
  describe('pageNameFromUrl', () => {
    it('maps root to home', () => {
      expect(pageNameFromUrl('http://localhost:3000/')).toBe('home');
      expect(pageNameFromUrl('http://localhost:3000')).toBe('home');
    });

    it('joins path segments with dashes', () => {
      expect(pageNameFromUrl('http://localhost:3000/pricing/plans')).toBe('pricing-plans');
    });

    it('sanitizes unsafe characters and lowercases', () => {
      expect(pageNameFromUrl('http://x.dev/Blog/Hello%20World!')).toBe('blog-hello_20world_');
    });
  });

  describe('resolvePages', () => {
    it('resolves paths against the base URL and dedupes', () => {
      expect(resolvePages('http://localhost:3000/', ['/', '/about', '/about', ' /pricing '])).toEqual([
        'http://localhost:3000/',
        'http://localhost:3000/about',
        'http://localhost:3000/pricing',
      ]);
    });
  });

  describe('filterCrawledLinks', () => {
    const START = 'http://localhost:3000/';

    it('always includes the start URL first', () => {
      expect(filterCrawledLinks(START, [], 10)).toEqual([START]);
    });

    it('keeps same-origin pages, drops external/downloads/dupes/hashes', () => {
      const result = filterCrawledLinks(
        START,
        [
          'http://localhost:3000/about',
          'http://localhost:3000/about#team',            // dupe via hash
          'https://twitter.com/testivai',                // external
          'http://localhost:3000/logo.png',              // asset
          'mailto:hi@testiv.ai',                         // non-http
          'http://localhost:3000/pricing/',
        ],
        10,
      );
      expect(result).toEqual([
        START,
        'http://localhost:3000/about',
        'http://localhost:3000/pricing/',
      ]);
    });

    it('caps at maxPages', () => {
      const hrefs = Array.from({ length: 30 }, (_, i) => `http://localhost:3000/p${i}`);
      expect(filterCrawledLinks(START, hrefs, 5)).toHaveLength(5);
    });
  });

  describe('parseViewport', () => {
    it('parses WxH', () => {
      expect(parseViewport('1280x800')).toEqual({ width: 1280, height: 800 });
    });

    it('rejects garbage', () => {
      expect(() => parseViewport('big')).toThrow(/expected WIDTHxHEIGHT/);
    });
  });

  describe('findChrome', () => {
    const saved = process.env.TESTIVAI_CHROME_PATH;
    afterEach(() => {
      if (saved === undefined) delete process.env.TESTIVAI_CHROME_PATH;
      else process.env.TESTIVAI_CHROME_PATH = saved;
    });

    it('prefers TESTIVAI_CHROME_PATH when it exists', () => {
      process.env.TESTIVAI_CHROME_PATH = process.execPath; // any existing file
      expect(findChrome()).toBe(process.execPath);
    });

    it('ignores TESTIVAI_CHROME_PATH when the file is missing', () => {
      process.env.TESTIVAI_CHROME_PATH = '/nonexistent/chrome-binary';
      expect(findChrome()).not.toBe('/nonexistent/chrome-binary');
    });
  });

  describe('chromeLaunchArgs', () => {
    const saved = process.env.TESTIVAI_CHROME_NO_SANDBOX;
    afterEach(() => {
      if (saved === undefined) delete process.env.TESTIVAI_CHROME_NO_SANDBOX;
      else process.env.TESTIVAI_CHROME_NO_SANDBOX = saved;
    });

    it('drops the sandbox when forced, for containers that need it', () => {
      process.env.TESTIVAI_CHROME_NO_SANDBOX = '1';
      const args = chromeLaunchArgs(9222, '/tmp/profile');
      expect(needsNoSandbox()).toBe(true);
      expect(args).toContain('--no-sandbox');
      // Docker's 64MB /dev/shm crashes Chrome on large pages.
      expect(args).toContain('--disable-dev-shm-usage');
    });

    it('keeps the sandbox when explicitly disabled, even as root', () => {
      process.env.TESTIVAI_CHROME_NO_SANDBOX = '0';
      const args = chromeLaunchArgs(9222, '/tmp/profile');
      expect(needsNoSandbox()).toBe(false);
      expect(args).not.toContain('--no-sandbox');
    });

    it('always keeps the port, profile and about:blank last', () => {
      const args = chromeLaunchArgs(9333, '/tmp/profile');
      expect(args).toContain('--remote-debugging-port=9333');
      expect(args).toContain('--user-data-dir=/tmp/profile');
      expect(args[args.length - 1]).toBe('about:blank');
    });
  });
});

/**
 * Capture provenance for `testivai witness <url>`: the crawler drives its
 * own headless Chrome over CDP and takes full-page CDP screenshots; there is
 * no test framework.
 */
describe('standaloneEnvironment', () => {
  const host = { os: { platform: 'linux', release: '6.8.0', arch: 'x64' } };
  const probe = {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36',
  };

  it('records Chrome from the CDP product, the CLI as the adapter, a full-page CDP capture and the render probe', () => {
    expect(standaloneEnvironment({ probe, product: 'HeadlessChrome/141.0.7390.54', host })).toEqual({
      os: host.os,
      browser: { name: 'chromium', version: '141.0.7390.54', headless: true },
      adapter: { name: '@testivai/witness', version: expect.stringMatching(/^\d+\.\d+\.\d+/), captureMethod: 'full-page:cdp' },
      render: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    });
  });

  it('without the CDP product, the probe\'s user agent; without either, chromium with an unknown version', () => {
    expect(standaloneEnvironment({ probe, product: undefined, host }).browser).toEqual({ name: 'chromium', version: '141.0.7390.37', headless: true });
    expect(standaloneEnvironment({ probe: null, product: undefined, host }).browser).toEqual({ name: 'chromium', version: null });
  });
});
