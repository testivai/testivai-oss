/**
 * Standalone capture determinism (real Chrome)
 *
 * `testivai witness <url>` must produce byte-identical screenshots of an
 * unchanged page, or every run reports false "changed" diffs. Chrome could
 * hand Page.captureScreenshot a stale frame, painted with styles resolved
 * against an earlier viewport (a collapsed 100vh hero, narrow-viewport
 * media rules), so identical pages flipped between two renders run to run.
 *
 * This serves one fixture page under four URLs, runs the published CLI
 * three times (a fresh Chrome each run), and asserts all twelve captures
 * are identical. Before the fix this failed on nearly every attempt.
 *
 * Needs a Chrome/Chromium: set TESTIVAI_CHROME_PATH, or have one installed
 * where the CLI looks. Without one the test is skipped, loudly, except in CI
 * (CI set), where it fails.
 */

import * as assert from 'assert';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

const RUNS = 3;
const PAGES = ['/p1.html', '/p2.html', '/p3.html', '/p4.html'];
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'viewport-page.html');
// The package's main entry is dist/index.js; the bin sits next to it.
const CLI = path.join(path.dirname(require.resolve('@testivai/witness')), 'bin', 'testivai.js');

function serveFixture(): Promise<http.Server> {
  const html = fs.readFileSync(FIXTURE);
  const server = http.createServer((req, res) => {
    if (PAGES.includes(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Runs the CLI asynchronously: the fixture server lives in this process, so a
 * blocking spawnSync would stop it answering Chrome and the capture would hang.
 */
function runCli(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, timeout: 120_000 }, (_err, stdout, stderr) =>
      resolve(`${stdout}\n${stderr}`),
    );
  });
}

function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

async function main(): Promise<void> {
  assert.ok(fs.existsSync(CLI), `CLI not built: ${CLI} (run pnpm build first)`);
  const server = await serveFixture();
  const { port } = server.address() as AddressInfo;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-determinism-'));

  try {
    const captures: Record<string, string[]> = {};
    for (let run = 1; run <= RUNS; run++) {
      const output = await runCli(['witness', `http://127.0.0.1:${port}`, '--pages', PAGES.join(',')], projectRoot);
      if (/No Chrome\/Chromium found/.test(output)) {
        // CI runners ship Chrome, so a missing one there is a broken setup, not a skip.
        assert.ok(!process.env.CI, 'CI has no Chrome/Chromium; set TESTIVAI_CHROME_PATH');
        console.log('[e2e] ⚠ SKIPPED standalone determinism: no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
        return;
      }
      for (const page of PAGES) {
        const name = page.slice(1).replace('.', '_');
        const file = path.join(projectRoot, '.testivai', 'temp', name, 'screenshot.png');
        assert.ok(fs.existsSync(file), `run ${run}: no capture for ${page}\n${output}`);
        const hash = sha(file);
        if (!captures[hash]) captures[hash] = [];
        captures[hash].push(`run${run}${page}`);
      }
    }

    const distinct = Object.keys(captures).length;
    const detail = Object.entries(captures)
      .map(([hash, where]) => `  ${hash}: ${where.length}× (${where.join(', ')})`)
      .join('\n');
    assert.strictEqual(
      distinct,
      1,
      `expected ${RUNS * PAGES.length} identical captures of the same page, got ${distinct} distinct renders:\n${detail}`,
    );
    console.log(`[e2e] ✓ Standalone captures are deterministic (${RUNS * PAGES.length} identical).`);
  } finally {
    server.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ Standalone determinism failed');
  console.error(err);
  process.exit(1);
});
