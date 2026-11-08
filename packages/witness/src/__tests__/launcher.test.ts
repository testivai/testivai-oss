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

  /**
   * A fake Chrome that behaves like the real one with --remote-debugging-port=0:
   * it listens on a port the OS picks and writes DevToolsActivePort ("<port>\n
   * <browser path>") into --user-data-dir. With STALL_FIRST set, the first
   * launch prints like a starting Chrome and then never opens the endpoint,
   * which is what CI saw. Every launch appends its pid to launches.log.
   */
  const realisticChrome = (opts: { stallFirst?: boolean; stallAlways?: boolean } = {}): string =>
    fakeChrome(
      'chrome.js',
      `#!${process.execPath}\n` +
        "const fs = require('fs'), path = require('path');\n" +
        `const log = ${JSON.stringify(path.join(dir, 'launches.log'))};\n` +
        "fs.appendFileSync(log, process.pid + '\\n');\n" +
        "const launches = fs.readFileSync(log, 'utf8').trim().split('\\n').length;\n" +
        "process.stderr.write('fake chrome: dbus noise\\n');\n" +
        `if (${opts.stallAlways ? 'true' : 'false'} || (${opts.stallFirst ? 'true' : 'false'} && launches === 1)) { setInterval(() => {}, 1000); return; }\n` +
        "const arg = (name) => process.argv.find((a) => a.startsWith(name + '=')).split('=')[1];\n" +
        "const server = require('http').createServer((req, res) => res.end('{}'));\n" +
        "server.listen(Number(arg('--remote-debugging-port')), '127.0.0.1', () => {\n" +
        "  fs.writeFileSync(path.join(arg('--user-data-dir'), 'DevToolsActivePort'), server.address().port + '\\n/devtools/browser/fake\\n');\n" +
        "});\n",
    );

  const launches = (): number[] =>
    fs.existsSync(path.join(dir, 'launches.log'))
      ? fs.readFileSync(path.join(dir, 'launches.log'), 'utf8').trim().split('\n').map(Number)
      : [];

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** True once none of `pids` is running, polling for up to 1s (SIGKILL is asynchronous). */
  const allGone = async (pids: number[]): Promise<boolean> => {
    for (let i = 0; i < 20; i++) {
      if (!pids.some(alive)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  it('without a port, Chrome picks a free one and the launcher reads it from DevToolsActivePort', async () => {
    const launched = await launchChrome(realisticChrome());
    expect(launched.port).toBeGreaterThan(0);
    expect(await portAnswers(launched.port)).toBe(true);
    launched.kill();
  }, 20_000);

  it('a port something else already listens on can no longer make the launch fail', async () => {
    // The old run.ts picked a random port without checking it was free: Chrome
    // then logs "Cannot start http server for devtools" and the launch timed out.
    const busy = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => busy.once('listening', r));
    const taken = (busy.address() as net.AddressInfo).port;
    try {
      const launched = await launchChrome(realisticChrome());
      expect(launched.port).not.toBe(taken);
      expect(await portAnswers(launched.port)).toBe(true);
      launched.kill();
    } finally {
      busy.close();
    }
  }, 20_000);

  it('relaunches once when the first Chrome stalls before opening its endpoint, and kills the stalled one', async () => {
    process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS = '4000';
    const launched = await launchChrome(realisticChrome({ stallFirst: true }));
    expect(await portAnswers(launched.port)).toBe(true);
    const [first, second] = launches();
    expect(second).toBeDefined();
    expect(await allGone([first])).toBe(true);
    launched.kill();
  }, 20_000);

  it('when both launches stall, fails within the timeout and says it tried twice, with the stderr', async () => {
    process.env.TESTIVAI_CHROME_STARTUP_TIMEOUT_MS = '1000';
    const started = Date.now();
    const error = await launchChrome(realisticChrome({ stallAlways: true })).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/did not open its debugging endpoint within 1s \(launched twice\)/);
    expect(error?.message).toContain('fake chrome: dbus noise');
    expect(launches()).toHaveLength(2);
    expect(await allGone(launches())).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('does not relaunch a Chrome that exits: that is a broken binary, not a stall', async () => {
    const chrome = fakeChrome(
      'crash-once.sh',
      `#!/bin/sh\necho $$ >> ${JSON.stringify(path.join(dir, 'launches.log'))}\necho "fake chrome: bad flag" >&2\nexit 1\n`,
    );
    const error = await launchChrome(chrome).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/exited before opening its debugging endpoint \(code 1\)/);
    expect(launches()).toHaveLength(1);
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
