// Proof harness: starts the demo site, runs check.mjs as a child process per
// scenario, and checks the exit code and the exact failure/warning reasons.
// Exits non-zero if any scenario misbehaves.
//
//   CHROME_PATH=/path/to/chrome node demo/prove-it.mjs
//   CHROME_CHANNEL=chrome node demo/prove-it.mjs
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './site-server.mjs';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), '..', 'check.mjs');
// High closed port: Chrome refuses "unsafe" ports such as 1.
const UNREACHABLE = 'http://127.0.0.1:59999/';

// Variables the checker reads; never inherit them from the caller's shell.
const CHECK_VARS = [
  'URLS',
  'EXPECT_TEXT',
  'MIN_TEXT_CHARS',
  'FAIL_ON_CONSOLE_ERROR',
  'FAIL_ON_IMAGES',
  'TIMEOUT_MS',
  'OUT_DIR',
  'GITHUB_STEP_SUMMARY',
];

const site = await startServer();
const u = site.url;

const healthy = { failures: [], warnings: [] };

// Each page expectation lists regexes that must match the reasons one-to-one:
// same count, each reason matched by exactly one pattern. Anything extra fails.
const scenarios = [
  {
    name: 'ok passes with no failures and no warnings',
    env: { URLS: u('ok') },
    exit: 0,
    pages: [healthy],
  },
  {
    name: 'late-render (data arrives after load) passes with no failures and no warnings',
    env: { URLS: u('late-render') },
    exit: 0,
    pages: [healthy],
  },
  {
    name: 'css-cross-origin (rules unreadable: SecurityError) passes with no failures and no warnings',
    env: { URLS: u('css-cross-origin') },
    exit: 0,
    pages: [healthy],
  },
  {
    name: 'analytics-ping (image request answered with 200 text/html) passes with no warnings',
    env: { URLS: u('analytics-ping') },
    exit: 0,
    pages: [healthy],
  },
  {
    name: 'analytics-ping fails nothing even with FAIL_ON_IMAGES=1',
    env: { URLS: u('analytics-ping'), FAIL_ON_IMAGES: '1' },
    exit: 0,
    pages: [healthy],
  },
  {
    name: 'missing-css fails on the 404 stylesheet',
    env: { URLS: u('missing-css') },
    exit: 1,
    pages: [{ failures: [/^stylesheet \S+\/missing-css\/style\.css returned HTTP 404$/], warnings: [] }],
  },
  {
    name: 'css-html fails on a stylesheet that is an HTML error page',
    env: { URLS: u('css-html') },
    exit: 1,
    pages: [
      {
        failures: [/^stylesheet \S+\/css-html\/style\.css returned HTTP 200 with text\/html \(an error page, not the asset\)$/],
        warnings: [],
      },
    ],
  },
  {
    name: 'css-empty fails on a 200 text/css stylesheet with no rules',
    env: { URLS: u('css-empty') },
    exit: 1,
    pages: [{ failures: [/^stylesheet \S+\/css-empty\/style\.css loaded but has no CSS rules$/], warnings: [] }],
  },
  {
    name: 'js-error fails on the uncaught TypeError',
    env: { URLS: u('js-error') },
    exit: 1,
    pages: [{ failures: [/^JavaScript error: TypeError: .*null/], warnings: [] }],
  },
  {
    name: 'blank fails on a page that rendered nothing',
    env: { URLS: u('blank') },
    exit: 1,
    pages: [{ failures: [/^page rendered 0 characters of text \(minimum 20\)$/], warnings: [] }],
  },
  {
    name: 'font-404 fails on the missing web font',
    env: { URLS: u('font-404') },
    exit: 1,
    pages: [{ failures: [/^font \S+\/font-404\/font\.ttf returned HTTP 404$/], warnings: [] }],
  },
  {
    name: 'down reports only the 503, no asset or render checks',
    env: { URLS: u('down') },
    exit: 1,
    pages: [{ failures: [/^page returned HTTP 503$/], warnings: [] }],
  },
  {
    name: 'img-404 is a warning by default',
    env: { URLS: u('img-404') },
    exit: 0,
    pages: [{ failures: [], warnings: [/^image \S+\/img-404\/logo\.svg returned HTTP 404$/] }],
  },
  {
    name: 'img-404 fails with FAIL_ON_IMAGES=1',
    env: { URLS: u('img-404'), FAIL_ON_IMAGES: '1' },
    exit: 1,
    pages: [{ failures: [/^image \S+\/img-404\/logo\.svg returned HTTP 404$/], warnings: [] }],
  },
  {
    name: 'console-error is a warning by default',
    env: { URLS: u('console-error') },
    exit: 0,
    pages: [{ failures: [], warnings: [/^console\.error: Analytics: failed to initialise tracker$/] }],
  },
  {
    name: 'console-error fails with FAIL_ON_CONSOLE_ERROR=1',
    env: { URLS: u('console-error'), FAIL_ON_CONSOLE_ERROR: '1' },
    exit: 1,
    pages: [{ failures: [/^console\.error: Analytics: failed to initialise tracker$/], warnings: [] }],
  },
  {
    name: 'EXPECT_TEXT present passes',
    env: { URLS: u('ok'), EXPECT_TEXT: 'Demo shop' },
    exit: 0,
    pages: [healthy],
  },
  {
    name: 'EXPECT_TEXT missing fails',
    env: { URLS: u('ok'), EXPECT_TEXT: 'Checkout now' },
    exit: 1,
    pages: [{ failures: [/^expected text "Checkout now" not found on the page$/], warnings: [] }],
  },
  {
    name: 'two URLs, one broken: exit 1, one ok result, one screenshot, step summary appended',
    env: { URLS: `${u('ok')}, ${u('js-error')}`, GITHUB_STEP_SUMMARY: 'step-summary.md' },
    preexisting: { 'step-summary.md': 'EARLIER STEP OUTPUT\n' },
    exit: 1,
    pages: [healthy, { failures: [/^JavaScript error: TypeError: /], warnings: [] }],
    extra(out) {
      const summary = readFileSync(join(out, 'step-summary.md'), 'utf8');
      if (!summary.startsWith('EARLIER STEP OUTPUT\n')) return 'GITHUB_STEP_SUMMARY was overwritten, not appended';
      if (!summary.includes(readFileSync(join(out, 'summary.md'), 'utf8'))) {
        return 'GITHUB_STEP_SUMMARY does not contain summary.md';
      }
    },
  },
  {
    name: 'unreachable host fails with "load failed"',
    env: { URLS: UNREACHABLE },
    exit: 1,
    // Connection refused: Chrome's error page is not the site, so no screenshot.
    pages: [{ failures: [/^page load failed: .*ERR_CONNECTION_REFUSED/], warnings: [], screenshot: false }],
  },
  {
    name: 'no URLS gives exit 2',
    env: {},
    exit: 2,
    pages: null,
  },
  {
    name: 'URLS with only separators gives exit 2',
    env: { URLS: ' , ,  ' },
    exit: 2,
    pages: null,
  },
  {
    name: 'a URL without http(s):// gives exit 2',
    env: { URLS: 'example.com' },
    exit: 2,
    pages: null,
  },
  {
    name: 'a non-numeric MIN_TEXT_CHARS gives exit 2',
    env: { URLS: u('ok'), MIN_TEXT_CHARS: 'lots' },
    exit: 2,
    pages: null,
  },
];

function runCheck(env) {
  return new Promise((resolve) => {
    // Async on purpose: the demo server runs in this process and must keep serving.
    execFile(process.execPath, [CHECK], { env, timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : `${error.code ?? error.signal}`) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

// Returns a list of problems; empty means the reasons match one-to-one.
function matchReasons(kind, actual, patterns) {
  const problems = [];
  if (!Array.isArray(actual)) return [`${kind} is not an array`];
  const left = [...actual];
  for (const pattern of patterns) {
    const i = left.findIndex((reason) => pattern.test(reason));
    if (i === -1) problems.push(`no ${kind.slice(0, -1)} matches ${pattern}`);
    else left.splice(i, 1);
  }
  for (const reason of left) problems.push(`unexpected ${kind.slice(0, -1)}: "${reason}"`);
  return problems;
}

async function runScenario(scenario) {
  const out = mkdtempSync(join(tmpdir(), 'site-check-prove-'));
  try {
    const env = { ...process.env };
    for (const name of CHECK_VARS) delete env[name];
    Object.assign(env, scenario.env, { OUT_DIR: out });
    if (env.GITHUB_STEP_SUMMARY) env.GITHUB_STEP_SUMMARY = join(out, env.GITHUB_STEP_SUMMARY);
    for (const [file, content] of Object.entries(scenario.preexisting ?? {})) {
      writeFileSync(join(out, file), content);
    }

    const run = await runCheck(env);
    const problems = [];
    if (run.code !== scenario.exit) problems.push(`exit code ${run.code}, expected ${scenario.exit}`);

    if (scenario.pages) {
      const resultsPath = join(out, 'results.json');
      if (!existsSync(resultsPath)) {
        problems.push('results.json was not written');
      } else {
        const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
        const pages = results.pages ?? [];
        const urls = scenario.env.URLS.split(/[\s,]+/).filter(Boolean);
        if (pages.length !== scenario.pages.length) {
          problems.push(`${pages.length} page results, expected ${scenario.pages.length}`);
        }
        const wantOk = scenario.pages.every((p) => p.failures.length === 0);
        if (results.ok !== wantOk) problems.push(`results.ok is ${results.ok}, expected ${wantOk}`);

        scenario.pages.forEach((want, i) => {
          const page = pages[i];
          if (!page) return;
          const label = `page ${i + 1}`;
          if (page.url !== urls[i]) problems.push(`${label} url is ${page.url}, expected ${urls[i]}`);
          const shouldPass = want.failures.length === 0;
          if (page.ok !== shouldPass) problems.push(`${label} ok is ${page.ok}, expected ${shouldPass}`);
          for (const p of matchReasons('failures', page.failures, want.failures)) problems.push(`${label}: ${p}`);
          for (const p of matchReasons('warnings', page.warnings, want.warnings)) problems.push(`${label}: ${p}`);
          const wantScreenshot = want.screenshot ?? !shouldPass;
          if (!wantScreenshot && page.screenshot) problems.push(`${label} has an unexpected screenshot`);
          if (wantScreenshot && !(page.screenshot && existsSync(join(out, page.screenshot)))) {
            problems.push(`${label} failed but its screenshot is missing`);
          }
        });

        const pngs = readdirSync(out).filter((f) => f.endsWith('.png'));
        const shots = scenario.pages.filter((p) => p.screenshot ?? p.failures.length > 0).length;
        if (pngs.length !== shots) problems.push(`${pngs.length} screenshots in OUT_DIR, expected ${shots}`);

        const summaryPath = join(out, 'summary.md');
        if (!existsSync(summaryPath)) {
          problems.push('summary.md was not written');
        } else {
          const summary = readFileSync(summaryPath, 'utf8');
          for (const url of urls) if (!summary.includes(url)) problems.push(`summary.md does not mention ${url}`);
          if (!run.stdout.includes(summary.trim())) problems.push('summary was not printed to stdout');
        }
      }
    }

    if (!scenario.pages) {
      // Bad input still leaves a summary saying what is wrong, for the issue body.
      const summaryPath = join(out, 'summary.md');
      if (!existsSync(summaryPath)) problems.push('summary.md was not written');
      else if (!/bad input/i.test(readFileSync(summaryPath, 'utf8'))) problems.push('summary.md does not say "bad input"');
    }

    if (scenario.extra && problems.length === 0) {
      const problem = scenario.extra(out);
      if (problem) problems.push(problem);
    }
    if (problems.length && run.stderr.trim()) problems.push(`stderr: ${run.stderr.trim().split('\n').slice(0, 5).join(' | ')}`);
    return problems;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

let failedScenarios = 0;
try {
  for (const scenario of scenarios) {
    const started = Date.now();
    const problems = await runScenario(scenario);
    const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    if (problems.length === 0) {
      console.log(`OK    ${scenario.name} (${took})`);
    } else {
      failedScenarios++;
      console.log(`FAIL  ${scenario.name} (${took})`);
      for (const problem of problems) console.log(`        - ${problem}`);
    }
  }
} finally {
  await site.close();
}

console.log(
  failedScenarios === 0
    ? `\nAll ${scenarios.length} scenarios behaved as expected.`
    : `\n${failedScenarios} of ${scenarios.length} scenarios misbehaved.`,
);
process.exit(failedScenarios === 0 ? 0 : 1);
