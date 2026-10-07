/**
 * Headless Chrome launcher for standalone witness mode.
 *
 * `testivai witness <url>` must work with zero setup, so when no debuggable
 * Chrome is already running we launch our own headless instance and clean it
 * up afterwards. Resolution order for the executable:
 *
 *   1. TESTIVAI_CHROME_PATH env var (also how CI points at a Playwright/
 *      puppeteer-downloaded Chromium)
 *   2. Well-known platform install paths
 *   3. Names on PATH (google-chrome, chromium, ...)
 */

import { spawn, type ChildProcess, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { logger } from '../utils/logger';

const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];
const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
const WIN_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findChrome(): string | null {
  const fromEnv = process.env.TESTIVAI_CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates =
    process.platform === 'darwin' ? MAC_PATHS : process.platform === 'win32' ? WIN_PATHS : [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (process.platform !== 'win32') {
    for (const name of LINUX_NAMES) {
      try {
        const found = execFileSync('which', [name], { encoding: 'utf-8' }).trim();
        if (found) return found;
      } catch {
        // not on PATH — try the next name
      }
    }
  }
  return null;
}

export interface LaunchedChrome {
  port: number;
  kill: () => void;
}

/** Wait until the DevTools endpoint answers, up to timeoutMs, or until stop() says to give up. */
async function waitForDevtools(port: number, timeoutMs: number, stop: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stop()) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * Chrome refuses to start as root unless its sandbox is disabled, and root is
 * the default user inside Docker images and CI containers — exactly where
 * `testivai witness <url>` is most useful. Detect that case so the run works
 * instead of timing out with an error that looks like a broken binary.
 *
 * TESTIVAI_CHROME_NO_SANDBOX overrides the detection in both directions, for
 * non-root containers whose seccomp profile still blocks the sandbox.
 */
export function needsNoSandbox(): boolean {
  const forced = process.env.TESTIVAI_CHROME_NO_SANDBOX;
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;
  // getuid does not exist on Windows.
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Flags for the throwaway Chrome instance. Exported for testing. */
export function chromeLaunchArgs(port: number, userDataDir: string): string[] {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
  ];

  if (needsNoSandbox()) {
    // Docker gives /dev/shm only 64MB by default, which crashes Chrome on
    // larger pages, so the two container flags travel together.
    args.push('--no-sandbox', '--disable-dev-shm-usage');
  }

  args.push('about:blank');
  return args;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
/** How much of Chrome's stderr to keep for error messages. */
const STDERR_TAIL_CHARS = 4_000;

/**
 * How long to wait for Chrome's DevTools endpoint. A cold CI runner can take
 * longer than a laptop; a Chrome that crashes is detected on exit instead of
 * waiting this out. Override with TESTIVAI_CHROME_STARTUP_TIMEOUT_MS.
 */
export function chromeStartupTimeoutMs(): number {
  const raw = Number(process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STARTUP_TIMEOUT_MS;
}

/**
 * Launch a throwaway headless Chrome with remote debugging enabled.
 * Uses a temp profile so the user's browser state is never touched.
 */
export async function launchChrome(executable: string, port: number): Promise<LaunchedChrome> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-chrome-'));

  const args = chromeLaunchArgs(port, userDataDir);

  logger.debug(`Launching Chrome: ${executable}`);
  const child: ChildProcess = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  // Keep the tail of stderr for error messages, and keep draining it for the
  // life of the process so a chatty Chrome never blocks on a full pipe.
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });

  // A Chrome that exits (or never spawns) will not open the endpoint: stop
  // waiting and say why, instead of reporting a timeout.
  let ended: string | null = null;
  child.once('exit', (code, signal) => {
    ended ??= code !== null ? `code ${code}` : `signal ${signal}`;
  });
  child.once('error', (err) => {
    ended ??= err.message;
  });

  const kill = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  };

  const timeoutMs = chromeStartupTimeoutMs();
  const ready = await waitForDevtools(port, timeoutMs, () => ended !== null);
  if (!ready) {
    kill();
    const sandboxHint = needsNoSandbox()
      ? ''
      : ' If this is a container, Chrome may be refusing to start because its ' +
        'sandbox is unavailable — set TESTIVAI_CHROME_NO_SANDBOX=1.';
    const pathHint = ' Set TESTIVAI_CHROME_PATH to a working Chrome/Chromium binary if the auto-detected one is broken.';
    const stderrTail = stderr.trim() ? `\nChrome stderr (last ${STDERR_TAIL_CHARS} characters at most):\n${stderr.trim()}` : '';
    const what =
      ended !== null
        ? `Chrome exited before opening its debugging endpoint (${ended}).`
        : `Chrome did not open its debugging endpoint on port ${port} within ${timeoutMs / 1000}s. ` +
          'Set TESTIVAI_CHROME_STARTUP_TIMEOUT_MS to wait longer.';
    throw new Error(what + pathHint + sandboxHint + stderrTail);
  }

  return { port, kill };
}
