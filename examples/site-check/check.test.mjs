import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, renderSummary } from './check.mjs';

const ok = (env) => {
  const { config, error } = parseConfig(env);
  assert.equal(error, undefined, error);
  return config;
};

test('URLS splits on spaces, commas and newlines', () => {
  const config = ok({ URLS: 'https://a.example/,https://b.example/x  https://c.example/\nhttp://d.example/' });
  assert.deepEqual(config.urls, ['https://a.example/', 'https://b.example/x', 'https://c.example/', 'http://d.example/']);
});

test('missing or empty URLS is bad input', () => {
  for (const URLS of [undefined, '', '  ', ' , ,']) {
    const { error } = parseConfig({ URLS });
    assert.match(error, /URLS/);
  }
});

test('a URL that is not http(s) is bad input', () => {
  assert.match(parseConfig({ URLS: 'example.com' }).error, /^"example\.com" is not a URL\./);
  assert.match(parseConfig({ URLS: 'ftp://example.com/' }).error, /^"ftp:\/\/example\.com\/" uses ftp:/);
});

test('defaults', () => {
  const config = ok({ URLS: 'https://a.example/' });
  assert.equal(config.expectText, '');
  assert.equal(config.minTextChars, 20);
  assert.equal(config.timeoutMs, 30000);
  assert.equal(config.outDir, 'out');
  assert.equal(config.failOnConsoleError, false);
  assert.equal(config.failOnImages, false);
  assert.equal(config.ignoreTls, false);
});

test('numbers and switches are read from env', () => {
  const config = ok({
    URLS: 'https://a.example/',
    EXPECT_TEXT: 'Add to cart',
    MIN_TEXT_CHARS: '0',
    TIMEOUT_MS: '5000',
    OUT_DIR: 'artifacts',
    FAIL_ON_CONSOLE_ERROR: '1',
    FAIL_ON_IMAGES: '1',
    IGNORE_TLS: '1',
  });
  assert.equal(config.expectText, 'Add to cart');
  assert.equal(config.minTextChars, 0);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.outDir, 'artifacts');
  assert.equal(config.failOnConsoleError, true);
  assert.equal(config.failOnImages, true);
  assert.equal(config.ignoreTls, true);
});

test('switches are off unless set to 1', () => {
  const config = ok({ URLS: 'https://a.example/', FAIL_ON_IMAGES: '0', FAIL_ON_CONSOLE_ERROR: '', IGNORE_TLS: 'no' });
  assert.equal(config.failOnImages, false);
  assert.equal(config.failOnConsoleError, false);
  assert.equal(config.ignoreTls, false);
});

test('invalid numbers are bad input', () => {
  assert.match(parseConfig({ URLS: 'https://a.example/', MIN_TEXT_CHARS: 'lots' }).error, /MIN_TEXT_CHARS/);
  assert.match(parseConfig({ URLS: 'https://a.example/', MIN_TEXT_CHARS: '-1' }).error, /MIN_TEXT_CHARS/);
  assert.match(parseConfig({ URLS: 'https://a.example/', TIMEOUT_MS: '0' }).error, /TIMEOUT_MS/);
  assert.match(parseConfig({ URLS: 'https://a.example/', TIMEOUT_MS: '1.5s' }).error, /TIMEOUT_MS/);
});

test("with neither CHROME_CHANNEL nor CHROME_PATH, Playwright's own Chromium is used", () => {
  const { launch } = ok({ URLS: 'https://a.example/' });
  assert.equal('channel' in launch, false);
  assert.equal('executablePath' in launch, false);
  assert.equal(launch.headless, true);
});

test('CHROME_CHANNEL selects a channel', () => {
  const { launch } = ok({ URLS: 'https://a.example/', CHROME_CHANNEL: 'chrome' });
  assert.equal(launch.channel, 'chrome');
  assert.equal('executablePath' in launch, false);
});

test('CHROME_PATH wins over CHROME_CHANNEL', () => {
  const { launch } = ok({ URLS: 'https://a.example/', CHROME_CHANNEL: 'chrome', CHROME_PATH: '/opt/chrome' });
  assert.equal(launch.executablePath, '/opt/chrome');
  assert.equal('channel' in launch, false);
});

test('PROXY_SERVER sets the browser proxy', () => {
  assert.deepEqual(ok({ URLS: 'https://a.example/', PROXY_SERVER: 'http://proxy:3128' }).launch.proxy, {
    server: 'http://proxy:3128',
  });
  assert.equal('proxy' in ok({ URLS: 'https://a.example/' }).launch, false);
});

test('summary table cells escape backslashes as well as pipes', () => {
  // A backslash before a pipe in a URL must not end its table cell early.
  const md = renderSummary({
    ok: true,
    checkedAt: '2026-10-12T00:00:00.000Z',
    pages: [{ url: 'https://a.example/x\\|y', ok: true, status: 200, textChars: 30, failures: [], warnings: [] }],
  });
  const row = md.split('\n').find((line) => line.startsWith('| https://'));
  assert.equal(row, '| https://a.example/x\\\\\\|y | OK | 200 | 30 |');
});
