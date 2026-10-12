import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from './site-server.mjs';

const SERVER = fileURLToPath(new URL('./site-server.mjs', import.meta.url));

// An address of this machine that is not loopback. A server on 127.0.0.1 is
// unreachable there; one on 0.0.0.0 answers, as it must for another container.
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
const lan = lanAddress();
const needsLan = { skip: lan ? false : 'no non-loopback IPv4 address on this machine' };

// HTTP status of GET url, or the connection error code.
function get(url) {
  return new Promise((resolve) => {
    const req = request(url, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (error) => resolve(error.code));
    req.end();
  });
}

const portOf = (base) => new URL(base).port;

test('listens on 127.0.0.1 only by default', needsLan, async () => {
  const site = await startServer();
  try {
    assert.match(site.base, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await get(site.url('ok')), 200);
    assert.equal(await get(`http://${lan}:${portOf(site.base)}/ok/`), 'ECONNREFUSED');
  } finally {
    await site.close();
  }
});

test('host 0.0.0.0 answers on every interface', needsLan, async () => {
  const site = await startServer({ host: '0.0.0.0' });
  try {
    assert.equal(await get(`http://${lan}:${portOf(site.base)}/ok/`), 200);
    assert.equal(await get(`http://${lan}:${portOf(site.base)}/missing-css/style.css`), 404);
  } finally {
    await site.close();
  }
});

test('command line: DEMO_HOST=0.0.0.0 serves on every interface', needsLan, async (t) => {
  const child = spawn(process.execPath, [SERVER, '0'], {
    env: { ...process.env, DEMO_HOST: '0.0.0.0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  const base = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Demo site on (http:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.on('exit', (code) => reject(new Error(`server exited with ${code} before starting`)));
  });
  assert.equal(await get(`http://${lan}:${portOf(base)}/ok/`), 200);
});
