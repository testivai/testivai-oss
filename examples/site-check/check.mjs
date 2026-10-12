// Site check: fails when a page is up (HTTP 200) but broken. A stylesheet,
// script or font did not load, JavaScript threw, or the page rendered almost
// nothing. Broken images and console.error are warnings unless switched on.
//
// Exit codes: 0 all healthy, 1 at least one page failed, 2 bad input.
// See README.md for the environment variables.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const NETWORK_IDLE_MS = 5000;
// Resource types whose failure breaks the page.
const ASSET_KINDS = { stylesheet: 'stylesheet', script: 'script', font: 'font' };

export function parseConfig(env) {
  const urls = (env.URLS ?? '').split(/[\s,]+/).filter(Boolean);
  if (urls.length === 0) return { error: 'No URLS given. Set URLS to one or more page URLs, space or comma separated.' };
  for (const url of urls) {
    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return { error: `"${url}" is not a URL. Use the full address, e.g. https://${url}` };
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { error: `"${url}" uses ${protocol}; only http: and https: pages can be checked.` };
    }
  }

  const number = (name, fallback, min) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw.trim()) || Number(raw) < min) return NaN;
    return Number(raw);
  };
  const minTextChars = number('MIN_TEXT_CHARS', 20, 0);
  if (Number.isNaN(minTextChars)) return { error: `MIN_TEXT_CHARS must be a whole number >= 0, got "${env.MIN_TEXT_CHARS}".` };
  const timeoutMs = number('TIMEOUT_MS', 30000, 1);
  if (Number.isNaN(timeoutMs)) return { error: `TIMEOUT_MS must be a whole number of milliseconds > 0, got "${env.TIMEOUT_MS}".` };

  const launch = { headless: true };
  if (env.CHROME_PATH) launch.executablePath = env.CHROME_PATH;
  else if (env.CHROME_CHANNEL) launch.channel = env.CHROME_CHANNEL;
  if (env.PROXY_SERVER) launch.proxy = { server: env.PROXY_SERVER };

  return {
    config: {
      urls,
      expectText: collapse(env.EXPECT_TEXT ?? ''),
      minTextChars,
      timeoutMs,
      outDir: env.OUT_DIR || 'out',
      failOnConsoleError: env.FAIL_ON_CONSOLE_ERROR === '1',
      failOnImages: env.FAIL_ON_IMAGES === '1',
      ignoreTls: env.IGNORE_TLS === '1',
      launch,
    },
  };
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// One entry per asset URL. Chrome reports a 404'd stylesheet or font both as
// a response (404) and as requestfailed (net::ERR_ABORTED): the status wins.
function trackRequests(page) {
  const entries = new Map();
  const kindOf = (request) => {
    const type = request.resourceType();
    if (type === 'image') return 'image';
    return ASSET_KINDS[type];
  };
  const tracked = (request) => kindOf(request) && /^https?:/.test(request.url());

  page.on('response', (response) => {
    const request = response.request();
    if (!tracked(request)) return;
    entries.set(request.url(), {
      kind: kindOf(request),
      url: request.url(),
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
    });
  });
  page.on('requestfailed', (request) => {
    if (!tracked(request)) return;
    if (entries.get(request.url())?.status !== undefined) return;
    entries.set(request.url(), { kind: kindOf(request), url: request.url(), error: request.failure()?.errorText ?? 'failed' });
  });
  return entries;
}

function assetProblem({ kind, url, status, contentType, error }) {
  if (status === undefined) return `${kind} ${url} failed: ${error}`;
  if (status >= 400) return `${kind} ${url} returned HTTP ${status}`;
  // A CDN or host error page served in place of the asset. Not for images:
  // analytics pings are image requests answered with 200 text/html.
  if (kind !== 'image' && status >= 200 && status < 300 && /text\/html/i.test(contentType)) {
    return `${kind} ${url} returned HTTP ${status} with text/html (an error page, not the asset)`;
  }
  return null;
}

function firstLine(message) {
  return String(message).replace(/^page\.goto: /, '').split('\n')[0].trim();
}

function screenshotName(index, url) {
  const slug = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `${index + 1}-${slug || 'page'}.png`;
}

async function checkPage(browser, url, index, config) {
  const result = { url, ok: false, status: null, textChars: null, failures: [], warnings: [], screenshot: null };
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: config.ignoreTls,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    const requests = trackRequests(page);
    const pageErrors = new Set();
    const consoleErrors = new Set();
    page.on('pageerror', (error) => pageErrors.add(`${error.name}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // Duplicates the asset findings, which say more.
      if (text.startsWith('Failed to load resource')) return;
      consoleErrors.add(text);
    });

    let response = null;
    let loadError = null;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: config.timeoutMs });
    } catch (error) {
      loadError = firstLine(error.message);
    }

    if (loadError || !response) {
      result.failures.push(`page load failed: ${loadError ?? 'no response'}`);
    } else if (response.status() >= 400) {
      result.status = response.status();
      result.failures.push(`page returned HTTP ${response.status()}`);
    } else {
      // The page is up: now check it is not broken.
      result.status = response.status();
      await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {});

      const dom = await page.evaluate(() => {
        const sheets = [...document.querySelectorAll('link[rel~="stylesheet" i]')].map((link) => {
          // link.sheet is not null for a failed stylesheet in Chrome: count rules.
          let empty;
          try {
            empty = !link.sheet || link.sheet.cssRules.length === 0;
          } catch (error) {
            // SecurityError: a cross-origin sheet without CORS; its rules are private, it is fine.
            if (error.name !== 'SecurityError') throw error;
            empty = false;
          }
          return { href: link.href, empty };
        });
        const brokenImages = [...document.images]
          .filter((img) => img.complete && img.currentSrc && img.naturalWidth === 0)
          .map((img) => img.currentSrc);
        return { sheets, brokenImages, text: document.body ? document.body.innerText : '' };
      });

      const assetFailures = [];
      const imageProblems = [];
      for (const entry of requests.values()) {
        const problem = assetProblem(entry);
        if (!problem) continue;
        (entry.kind === 'image' ? imageProblems : assetFailures).push(problem);
      }
      // One reason per asset: only report an empty sheet the network looked fine for.
      for (const sheet of dom.sheets) {
        const entry = requests.get(sheet.href);
        if (sheet.empty && !(entry && assetProblem(entry))) {
          assetFailures.push(`stylesheet ${sheet.href} loaded but has no CSS rules`);
        }
      }
      for (const src of dom.brokenImages) {
        const entry = requests.get(src);
        if (!(entry && assetProblem(entry))) imageProblems.push(`image ${src} did not render (broken image)`);
      }

      result.failures.push(...assetFailures);
      for (const error of pageErrors) result.failures.push(`JavaScript error: ${error}`);

      const text = collapse(dom.text);
      result.textChars = text.length;
      if (text.length < config.minTextChars) {
        result.failures.push(`page rendered ${text.length} characters of text (minimum ${config.minTextChars})`);
      }
      if (config.expectText && !text.includes(config.expectText)) {
        result.failures.push(`expected text "${config.expectText}" not found on the page`);
      }

      (config.failOnImages ? result.failures : result.warnings).push(...imageProblems);
      const consoleProblems = [...consoleErrors].map((text) => `console.error: ${text}`);
      (config.failOnConsoleError ? result.failures : result.warnings).push(...consoleProblems);
    }

    result.ok = result.failures.length === 0;
    // When the connection itself failed, Chrome shows its own error page, not the site.
    const unreachable = Boolean(loadError) && /net::ERR_/.test(loadError);
    if (!result.ok && !unreachable) {
      const name = screenshotName(index, url);
      try {
        await page.screenshot({ path: join(config.outDir, name), timeout: config.timeoutMs });
        result.screenshot = name;
      } catch (error) {
        result.warnings.push(`screenshot failed: ${firstLine(error.message)}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|');
}

export function renderSummary({ ok, checkedAt, pages, error, stage }) {
  if (error) return `## Site check: ${stage === 'browser' ? 'could not run' : 'bad input'}\n\n${error}\n`;
  const failed = pages.filter((p) => !p.ok).length;
  const lines = [
    ok ? `## Site check: all ${pages.length} page(s) healthy` : `## Site check: FAILED (${failed} of ${pages.length} page(s) broken)`,
    '',
    `Checked at ${checkedAt}.`,
    '',
    '| Page | Result | HTTP | Text chars |',
    '| --- | --- | --- | --- |',
  ];
  for (const page of pages) {
    const verdict = page.ok ? (page.warnings.length ? 'OK (warnings)' : 'OK') : 'FAILED';
    lines.push(`| ${cell(page.url)} | ${verdict} | ${page.status ?? '-'} | ${page.textChars ?? '-'} |`);
  }
  for (const page of pages) {
    if (page.ok && page.warnings.length === 0) continue;
    lines.push('', `### ${page.ok ? 'Warnings' : 'Failed'}: ${page.url}`, '');
    for (const reason of page.failures) lines.push(`- FAIL: ${reason}`);
    for (const reason of page.warnings) lines.push(`- WARN: ${reason}`);
    if (page.screenshot) lines.push(`- Screenshot: \`${page.screenshot}\``);
  }
  return `${lines.join('\n')}\n`;
}

function writeOutputs(outDir, results, env) {
  mkdirSync(outDir, { recursive: true });
  const summary = renderSummary(results);
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(outDir, 'summary.md'), summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}

export async function main(env = process.env) {
  const checkedAt = new Date().toISOString();
  const { config, error } = parseConfig(env);
  if (error) {
    writeOutputs(env.OUT_DIR || 'out', { ok: false, checkedAt, stage: 'input', error, pages: [] }, env);
    console.error(error);
    return 2;
  }
  mkdirSync(config.outDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch(config.launch);
  } catch (launchError) {
    const message = `Could not start the browser: ${firstLine(launchError.message)}`;
    writeOutputs(config.outDir, { ok: false, checkedAt, stage: 'browser', error: message, pages: [] }, env);
    console.error(message);
    return 1;
  }

  const pages = [];
  try {
    for (const [index, url] of config.urls.entries()) pages.push(await checkPage(browser, url, index, config));
  } finally {
    await browser.close();
  }
  const ok = pages.every((p) => p.ok);
  writeOutputs(config.outDir, { ok, checkedAt, pages }, env);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
