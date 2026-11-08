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

/** One Chrome process and what it said, while it starts. */
interface Attempt {
  child: ChildProcess;
  userDataDir: string;
  stderr: () => string;
  /** Why the process ended (exit code, signal or spawn error), or null while it runs. */
  ended: () => string | null;
  kill: () => void;
}

function spawnChrome(executable: string, port: number): Attempt {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-chrome-'));
  logger.debug(`Launching Chrome: ${executable}`);
  const child: ChildProcess = spawn(executable, chromeLaunchArgs(port, userDataDir), { stdio: ['ignore', 'ignore', 'pipe'] });

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
  return { child, userDataDir, stderr: () => stderr, ended: () => ended, kill };
}

/**
 * The port Chrome chose for --remote-debugging-port=0: the first line of the
 * DevToolsActivePort file it writes into its profile once the endpoint is open.
 */
function readActivePort(userDataDir: string): number | null {
  try {
    const port = Number(fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** The endpoint's port once it answers, or null when the time runs out or Chrome exits. */
async function waitForEndpoint(attempt: Attempt, port: number, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const stop = () => attempt.ended() !== null;
  let actual = port;
  while (actual === 0 && Date.now() < deadline && !stop()) {
    actual = readActivePort(attempt.userDataDir) ?? 0;
    if (actual === 0) await new Promise((r) => setTimeout(r, 100));
  }
  if (actual === 0) return null;
  const ready = await waitForDevtools(actual, Math.max(deadline - Date.now(), 1), stop);
  return ready ? actual : null;
}

function launchHints(): string {
  const sandboxHint = needsNoSandbox()
    ? ''
    : ' If this is a container, Chrome may be refusing to start because its ' +
      'sandbox is unavailable — set TESTIVAI_CHROME_NO_SANDBOX=1.';
  return ' Set TESTIVAI_CHROME_PATH to a working Chrome/Chromium binary if the auto-detected one is broken.' + sandboxHint;
}

function stderrSection(label: string, stderr: string): string {
  return stderr.trim() ? `\n${label} (last ${STDERR_TAIL_CHARS} characters at most):\n${stderr.trim()}` : '';
}

/**
 * Launch a throwaway headless Chrome with remote debugging enabled.
 *
 * Without `port` (or with 0), Chrome picks a free port itself and the launcher
 * reads it from DevToolsActivePort, so a port another process holds cannot
 * make the launch fail. A Chrome that exits fails at once. A Chrome that is
 * still running but has not opened its endpoint by half the startup timeout
 * (TESTIVAI_CHROME_STARTUP_TIMEOUT_MS) is killed and launched once more: on
 * CI runners Chrome now and then stalls early in startup, and a second launch
 * starts normally.
 */
export async function launchChrome(executable: string, port = 0): Promise<LaunchedChrome> {
  const timeoutMs = chromeStartupTimeoutMs();
  const started = Date.now();

  const first = spawnChrome(executable, port);
  const firstPort = await waitForEndpoint(first, port, timeoutMs / 2);
  if (firstPort !== null) return { port: firstPort, kill: first.kill };
  first.kill();
  const firstEnded = first.ended();
  if (firstEnded !== null) {
    throw new Error(
      `Chrome exited before opening its debugging endpoint (${firstEnded}).` + launchHints() + stderrSection('Chrome stderr', first.stderr()),
    );
  }

  logger.warn(
    `Chrome did not open its debugging endpoint within ${timeoutMs / 2000}s; launching it once more.` +
      stderrSection('Chrome stderr', first.stderr()),
  );
  const second = spawnChrome(executable, port);
  const secondPort = await waitForEndpoint(second, port, Math.max(timeoutMs - (Date.now() - started), 1));
  if (secondPort !== null) return { port: secondPort, kill: second.kill };
  second.kill();
  const what =
    second.ended() !== null
      ? `Chrome stalled, then exited before opening its debugging endpoint (${second.ended()}).`
      : `Chrome did not open its debugging endpoint within ${timeoutMs / 1000}s (launched twice). ` +
        'Set TESTIVAI_CHROME_STARTUP_TIMEOUT_MS to wait longer.';
  throw new Error(
    what +
      launchHints() +
      stderrSection('First launch, Chrome stderr', first.stderr()) +
      stderrSection('Second launch, Chrome stderr', second.stderr()),
  );
}
