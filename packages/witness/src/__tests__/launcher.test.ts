import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { chromeStartupTimeoutMs, launchChrome } from '../standalone/launcher';

/**
 * launchChrome against fake "Chrome" executables, so the failure modes can be
 * reproduced without a browser. A real CI run failed with only "did not open
 * its debugging endpoint within 12s": Chrome's stderr was discarded, so a
 * crash and a slow start looked the same.
 */
const isWindows = process.platform === 'win32';
const describeUnix = isWindows ? describe.skip : describe;

describeUnix('launchChrome', () => {
  let dir: string;
  const savedTimeout = process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-fake-chrome-'));
  });

  afterEach(() => {
    if (savedTimeout === undefined) delete process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS;
    else process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS = savedTimeout;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fakeChrome = (name: string, script: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, script, { mode: 0o755 });
    return file;
  };

  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });

  const portAnswers = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });

  it("fails fast with Chrome's exit code and stderr when it exits before opening DevTools", async () => {
    const chrome = fakeChrome('crash.sh', '#!/bin/sh\necho "fake chrome: cannot open display" >&2\nexit 3\n');
    const started = Date.now();

    const error = await launchChrome(chrome, await freePort()).then(
      () => null,
      (e: Error) => e,
    );

    expect(error?.message).toMatch(/exited before opening its debugging endpoint \(code 3\)/);
    expect(error?.message).toContain('fake chrome: cannot open display');
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('times out after TESTIVAI_CHROME_STARTUP_TIMEOUT_MS and reports the stderr so far', async () => {
    process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS = '500';
    const chrome = fakeChrome('hang.sh', '#!/bin/sh\necho "fake chrome: still starting" >&2\nexec sleep 30\n');
    const started = Date.now();

    const error = await launchChrome(chrome, await freePort()).then(
      () => null,
      (e: Error) => e,
    );

    expect(error?.message).toMatch(/within 0\.5s/);
    expect(error?.message).toContain('fake chrome: still starting');
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('resolves once the DevTools endpoint answers, and kill() stops the process', async () => {
    const chrome = fakeChrome(
      'ready.js',
      `#!${process.execPath}\n` +
        "const port = Number(process.argv.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);\n" +
        "require('http').createServer((req, res) => { res.end('{}'); }).listen(port, '127.0.0.1');\n",
    );
    const port = await freePort();

    const launched = await launchChrome(chrome, port);
    expect(launched.port).toBe(port);
    expect(await portAnswers(port)).toBe(true);

    launched.kill();
    await new Promise((r) => setTimeout(r, 300));
    expect(await portAnswers(port)).toBe(false);
  }, 20_000);
});

describe('chromeStartupTimeoutMs', () => {
  const saved = process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS;
    else process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS = saved;
  });

  it('defaults to 30s', () => {
    delete process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS;
    expect(chromeStartupTimeoutMs()).toBe(30_000);
  });

  it('honours a positive number of milliseconds', () => {
    process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS = '45000';
    expect(chromeStartupTimeoutMs()).toBe(45_000);
  });

  it.each(['abc', '0', '-5', ''])('falls back to the default for %p', (value) => {
    process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS = value;
    expect(chromeStartupTimeoutMs()).toBe(30_000);
  });
});
