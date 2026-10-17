import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';

// The MCP Registry listing (registry.modelcontextprotocol.io) is published
// from CI: release.yml calls mcp-registry.yml whenever a release publishes
// @testivai/mcp, and scripts/mcp-registry.js holds the decisions it makes.
// Publishing was a manual step before, and the listing stayed at 0.5.7, under
// the repository's old owner, while npm moved on to 0.7.0.
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const script = require(path.join(repoRoot, 'scripts', 'mcp-registry.js'));

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers/ai.testiv%2Fmcp/versions/1.2.3';
const NPM = 'https://registry.npmjs.org/@testivai%2Fmcp/1.2.3';
const REPO = 'https://github.com/testivai/testivai-oss';

type Reply = { status: number; body?: unknown } | Error;

// Replies to each URL in turn; the last reply repeats.
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const queue = routes[url];
    if (!queue) throw new Error(`unexpected fetch: ${url}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (reply instanceof Error) throw reply;
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => reply.body };
  };
  return { fetch, calls };
}

const npmVersion = (mcpName?: string) => ({ status: 200, body: { name: '@testivai/mcp', version: '1.2.3', mcpName } });
const listed = (url = REPO, isLatest = true) => ({
  status: 200,
  body: {
    server: { name: 'ai.testiv/mcp', version: '1.2.3', repository: { url, source: 'github' } },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest } },
  },
});

let tmp: string;
let sleeps: number[];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

function writeListing({ pkg = {}, server = {} }: { pkg?: object; server?: object } = {}) {
  const write = (file: string, data: unknown) =>
    fs.writeFileSync(path.join(tmp, file), JSON.stringify(data, null, 2) + '\n');
  write('package.json', { name: '@testivai/mcp', version: '1.2.3', mcpName: 'ai.testiv/mcp', ...pkg });
  write('server.json', {
    name: 'ai.testiv/mcp',
    version: '1.2.3',
    repository: { url: REPO, source: 'github', subfolder: 'packages/mcp' },
    packages: [{ registryType: 'npm', identifier: '@testivai/mcp', version: '1.2.3', transport: { type: 'stdio' } }],
    ...server,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-registry-'));
  sleeps = [];
  writeListing();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('domainFor', () => {
  it('reverses the namespace of a reverse-DNS server name into the domain to log in with', () => {
    expect(script.domainFor('ai.testiv/mcp')).toBe('testiv.ai');
    expect(script.domainFor('com.example.tools/weather')).toBe('tools.example.com');
  });

  it('refuses a GitHub namespace, which is not a domain', () => {
    expect(() => script.domainFor('io.github.testivai/mcp')).toThrow(/GitHub/);
  });
});

describe('readListing', () => {
  it('reads the name, version, npm package, login domain and repository', () => {
    expect(script.readListing(tmp)).toEqual({
      name: 'ai.testiv/mcp',
      version: '1.2.3',
      identifier: '@testivai/mcp',
      domain: 'testiv.ai',
      repositoryUrl: REPO,
    });
  });

  it('refuses a server.json on another version than package.json', () => {
    writeListing({ server: { version: '1.2.2' } });
    expect(() => script.readListing(tmp)).toThrow(/1\.2\.2.*1\.2\.3/);
  });

  it('refuses an npm entry on another version than package.json', () => {
    writeListing({
      server: { packages: [{ registryType: 'npm', identifier: '@testivai/mcp', version: '1.2.2' }] },
    });
    expect(() => script.readListing(tmp)).toThrow(/1\.2\.2.*1\.2\.3/);
  });

  it('refuses a server name the package does not claim in mcpName', () => {
    writeListing({ pkg: { mcpName: 'ai.testiv/other' } });
    expect(() => script.readListing(tmp)).toThrow(/ai\.testiv\/other/);
  });

  it('refuses a server.json without an npm entry for the package', () => {
    writeListing({ server: { packages: [{ registryType: 'npm', identifier: '@someone/else', version: '1.2.3' }] } });
    expect(() => script.readListing(tmp)).toThrow(/@testivai\/mcp/);
  });
});

describe('check', () => {
  it('publishes nothing when the registry already lists this version', async () => {
    const { fetch, calls } = fakeFetch({ [REGISTRY]: [listed()] });
    await expect(script.check({ pkgDir: tmp, fetch, sleep })).resolves.toMatchObject({
      publish: false,
      name: 'ai.testiv/mcp',
      version: '1.2.3',
    });
    expect(calls).toEqual([REGISTRY]);
  });

  it('publishes when the registry lacks the version and npm serves it with the mcpName', async () => {
    const { fetch, calls } = fakeFetch({ [REGISTRY]: [{ status: 404 }], [NPM]: [npmVersion('ai.testiv/mcp')] });
    await expect(script.check({ pkgDir: tmp, fetch, sleep })).resolves.toEqual({
      publish: true,
      name: 'ai.testiv/mcp',
      version: '1.2.3',
      domain: 'testiv.ai',
    });
    expect(calls).toEqual([REGISTRY, NPM]);
    expect(sleeps).toEqual([]);
  });

  // The registry checks the mcpName on npm, and a release that was just
  // published can take a while to show up there.
  it('waits for npm to serve a just-published version', async () => {
    const { fetch, calls } = fakeFetch({
      [REGISTRY]: [{ status: 404 }],
      [NPM]: [{ status: 404 }, { status: 503 }, npmVersion('ai.testiv/mcp')],
    });
    await expect(script.check({ pkgDir: tmp, fetch, sleep, intervalMs: 5 })).resolves.toMatchObject({ publish: true });
    expect(calls).toEqual([REGISTRY, NPM, NPM, NPM]);
    expect(sleeps).toEqual([5, 5]);
  });

  it('gives up when npm never serves the version', async () => {
    const { fetch, calls } = fakeFetch({ [REGISTRY]: [{ status: 404 }], [NPM]: [{ status: 404 }] });
    await expect(script.check({ pkgDir: tmp, fetch, sleep, attempts: 3, intervalMs: 5 })).rejects.toThrow(
      /@testivai\/mcp@1\.2\.3.*npm/,
    );
    expect(calls.filter((u) => u === NPM)).toHaveLength(3);
    expect(sleeps).toEqual([5, 5]);
  });

  it('refuses at once when the npm version names another server', async () => {
    const { fetch, calls } = fakeFetch({ [REGISTRY]: [{ status: 404 }], [NPM]: [npmVersion('ai.testiv/other')] });
    await expect(script.check({ pkgDir: tmp, fetch, sleep })).rejects.toThrow(/ai\.testiv\/other.*ai\.testiv\/mcp/);
    expect(calls).toEqual([REGISTRY, NPM]);
  });

  it('refuses at once when the npm version has no mcpName', async () => {
    const { fetch } = fakeFetch({ [REGISTRY]: [{ status: 404 }], [NPM]: [npmVersion(undefined)] });
    await expect(script.check({ pkgDir: tmp, fetch, sleep })).rejects.toThrow(/mcpName/);
  });

  // Only a 404 means "not listed": an outage must not read as a missing version.
  it('fails on any other registry answer than 200 or 404', async () => {
    const { fetch } = fakeFetch({ [REGISTRY]: [{ status: 500 }] });
    await expect(script.check({ pkgDir: tmp, fetch, sleep })).rejects.toThrow(/500/);
  });

  it('fails when the registry cannot be reached', async () => {
    const { fetch } = fakeFetch({ [REGISTRY]: [new Error('ECONNRESET')] });
    await expect(script.check({ pkgDir: tmp, fetch, sleep })).rejects.toThrow(/ECONNRESET/);
  });
});

describe('verify', () => {
  it('waits until the registry serves the published version', async () => {
    const { fetch, calls } = fakeFetch({ [REGISTRY]: [{ status: 404 }, listed()] });
    await expect(script.verify({ pkgDir: tmp, fetch, sleep, intervalMs: 5 })).resolves.toEqual({ isLatest: true });
    expect(calls).toEqual([REGISTRY, REGISTRY]);
    expect(sleeps).toEqual([5]);
  });

  it('reports a listed version that is not the latest', async () => {
    const { fetch } = fakeFetch({ [REGISTRY]: [listed(REPO, false)] });
    await expect(script.verify({ pkgDir: tmp, fetch, sleep })).resolves.toEqual({ isLatest: false });
  });

  it('fails when the listing points at another repository', async () => {
    const { fetch } = fakeFetch({ [REGISTRY]: [listed('https://github.com/mcbuddy/testivai-oss')] });
    await expect(script.verify({ pkgDir: tmp, fetch, sleep })).rejects.toThrow(/mcbuddy\/testivai-oss.*testivai\/testivai-oss/);
  });

  it('fails when the version never shows up', async () => {
    const { fetch, calls } = fakeFetch({ [REGISTRY]: [{ status: 404 }] });
    await expect(script.verify({ pkgDir: tmp, fetch, sleep, attempts: 2, intervalMs: 5 })).rejects.toThrow(
      /ai\.testiv\/mcp@1\.2\.3/,
    );
    expect(calls).toHaveLength(2);
  });
});

describe('main (the CLI the workflow runs)', () => {
  let outputFile: string;
  let lines: string[];
  const log = (line: string) => lines.push(line);
  beforeEach(() => {
    outputFile = path.join(tmp, 'github-output');
    fs.writeFileSync(outputFile, '');
    lines = [];
  });
  const outputs = () => fs.readFileSync(outputFile, 'utf8');

  it('check writes the decision and the login domain as step outputs', async () => {
    const { fetch } = fakeFetch({ [REGISTRY]: [{ status: 404 }], [NPM]: [npmVersion('ai.testiv/mcp')] });
    const code = await script.main(['check', tmp], { env: { GITHUB_OUTPUT: outputFile }, fetch, sleep, log });
    expect(code).toBe(0);
    expect(outputs()).toBe('publish=true\nname=ai.testiv/mcp\nversion=1.2.3\ndomain=testiv.ai\n');
  });

  it('check says so when there is nothing to publish', async () => {
    const { fetch } = fakeFetch({ [REGISTRY]: [listed()] });
    const code = await script.main(['check', tmp], { env: { GITHUB_OUTPUT: outputFile }, fetch, sleep, log });
    expect(code).toBe(0);
    expect(outputs()).toMatch(/^publish=false\n/);
    expect(lines.join('\n')).toMatch(/::notice::ai\.testiv\/mcp 1\.2\.3 is already in the MCP Registry/);
  });

  it('verify warns when the published version is not the latest', async () => {
    const { fetch } = fakeFetch({ [REGISTRY]: [listed(REPO, false)] });
    const code = await script.main(['verify', tmp], { env: {}, fetch, sleep, log });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/::warning::.*not the latest/);
  });

  it('reports a failure as a workflow error and exits non-zero', async () => {
    const { fetch } = fakeFetch({ [REGISTRY]: [{ status: 500 }] });
    const code = await script.main(['check', tmp], { env: { GITHUB_OUTPUT: outputFile }, fetch, sleep, log });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/^::error::.*500/m);
    expect(outputs()).toBe('');
  });

  it('rejects an unknown command', async () => {
    const { fetch, calls } = fakeFetch({});
    const code = await script.main(['publish', tmp], { env: {}, fetch, sleep, log });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/::error::.*check.*verify/);
    expect(calls).toEqual([]);
  });

  // stdout carries the key, so its errors must not go there: the workflow
  // captures stdout into a variable, which would swallow them.
  it('key-hex prints only the hex on stdout, and errors only on stderr', async () => {
    const { fetch } = fakeFetch({});
    const errors: string[] = [];
    const err = (line: string) => errors.push(line);

    const key = ed25519();
    expect(await script.main(['key-hex'], { env: { MCP_PRIVATE_KEY: key.pem }, fetch, sleep, log, err })).toBe(0);
    expect(lines).toEqual([key.hex]);
    expect(errors).toEqual([]);

    lines = [];
    expect(await script.main(['key-hex'], { env: {}, fetch, sleep, log, err })).toBe(1);
    expect(lines).toEqual([]);
    expect(errors.join('\n')).toMatch(/^::error::.*MCP_PRIVATE_KEY.*mcp-registry-publish/);
  });
});

// The key as `openssl genpkey -algorithm Ed25519` writes it, and the 32-byte
// seed mcp-publisher takes as hex: the last 32 bytes of the 48-byte PKCS#8 DER.
function ed25519() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return {
    pem,
    body: pem.split('\n')[1],
    hex: der.subarray(der.length - 32).toString('hex'),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

// MCP_PRIVATE_KEY as people paste it. mcp-publisher only takes hex, and a
// secret holding the .pem file, then its base64 line, failed the first runs.
describe('privateKeyHex', () => {
  it('takes the 64 hex characters as they are, in lower case', () => {
    const { hex } = ed25519();
    expect(script.privateKeyHex(hex)).toBe(hex);
    expect(script.privateKeyHex(` ${hex.toUpperCase()}\n`)).toBe(hex);
  });

  it('takes the hex in the layout `openssl pkey -noout -text` prints', () => {
    const { hex } = ed25519();
    const pairs = hex.match(/../g) ?? [];
    const layout = `    ${pairs.slice(0, 15).join(':')}:\n    ${pairs.slice(15, 30).join(':')}:\n    ${pairs.slice(30).join(':')}`;
    expect(script.privateKeyHex(layout)).toBe(hex);
  });

  it('takes the key.pem file', () => {
    const { pem, hex } = ed25519();
    expect(script.privateKeyHex(pem)).toBe(hex);
    expect(script.privateKeyHex(`\r\n${pem.replace(/\n/g, '\r\n')}\r\n`)).toBe(hex);
  });

  it("takes the key.pem file's base64 line alone", () => {
    const { body, hex } = ed25519();
    expect(body).toMatch(/^MC4CAQAw/);
    expect(script.privateKeyHex(body)).toBe(hex);
  });

  it('takes the key.pem file pasted on one line, with or without escaped newlines', () => {
    const { pem, hex } = ed25519();
    expect(script.privateKeyHex(pem.trim().replace(/\n/g, '\\n'))).toBe(hex);
    expect(script.privateKeyHex(pem.trim().replace(/\n/g, ' '))).toBe(hex);
  });

  it('refuses an empty value', () => {
    expect(() => script.privateKeyHex('  \n')).toThrow(/empty/);
    expect(() => script.privateKeyHex(undefined)).toThrow(/empty/);
  });

  it('refuses a private key of another type, naming the type', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => script.privateKeyHex(pem)).toThrow(/\bec\b.*Ed25519/);
  });

  // The DNS record's p= value is the public key, a common mix-up.
  it('refuses a public key and text that is no key, without repeating the value', () => {
    const { publicPem } = ed25519();
    const publicBody = publicPem.split('\n')[1];
    for (const value of [publicPem, publicBody, 'not a key', `${'ab'.repeat(31)}`]) {
      let message = '';
      try {
        script.privateKeyHex(value);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/not an Ed25519 private key.*\.pem.*hex/);
      expect(message).not.toContain(value.trim().slice(0, 12));
    }
  });
});

// The command as the workflow runs it: a real process, real stdout and stderr.
describe('node scripts/mcp-registry.js key-hex', () => {
  const run = (key?: string) =>
    childProcess.spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'mcp-registry.js'), 'key-hex'], {
      env: { ...process.env, MCP_PRIVATE_KEY: key ?? '' },
      encoding: 'utf8',
    });

  it('prints the hex for a key.pem file', () => {
    const { pem, hex } = ed25519();
    const res = run(pem);
    expect({ status: res.status, stdout: res.stdout, stderr: res.stderr }).toEqual({
      status: 0,
      stdout: `${hex}\n`,
      stderr: '',
    });
  });

  it('prints nothing on stdout, and the error on stderr, for a bad value', () => {
    const res = run('not a key');
    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^::error::MCP_PRIVATE_KEY is not an Ed25519 private key/);
  });
});

// The workflows themselves only run on GitHub, so their wiring is pinned here.
interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  environment?: string;
  permissions?: Record<string, string>;
  needs?: string | string[];
  if?: string;
  uses?: string;
  steps?: Step[];
}
const readWorkflow = (file: string) =>
  parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', file), 'utf8')) as {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    jobs: Record<string, Job>;
  };

describe('.github/workflows/mcp-registry.yml', () => {
  const wf = readWorkflow('mcp-registry.yml');
  const jobs = Object.values(wf.jobs);
  const job = jobs[0];
  const steps = job.steps ?? [];
  const step = (id: string) => {
    const found = steps.find((s) => s.id === id);
    if (!found) throw new Error(`no step with id ${id}`);
    return found;
  };

  it('runs when release.yml calls it or a maintainer dispatches it, and on nothing else', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
  });

  it('reads the repository and nothing more', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(jobs).toHaveLength(1);
    expect(job.permissions).toBeUndefined();
  });

  // The signing key can publish any server under ai.testiv/*: it lives on a
  // protected environment, as the registry's own guide recommends.
  it('takes the signing key from the mcp-registry-publish environment, only in the login step', () => {
    expect(job.environment).toBe('mcp-registry-publish');
    expect(step('login').env).toMatchObject({ MCP_PRIVATE_KEY: '${{ secrets.MCP_PRIVATE_KEY }}' });
    const withSecrets = steps.filter((s) => JSON.stringify(s).includes('secrets.'));
    expect(withSecrets.map((s) => s.id)).toEqual(['login']);
  });

  it('never expands an expression inside a script', () => {
    for (const s of steps.filter((s) => s.run)) {
      expect({ id: s.id, run: s.run }).toEqual({ id: s.id, run: expect.not.stringContaining('${{') });
    }
  });

  it('checks, installs, validates, logs in, publishes and verifies, in that order', () => {
    expect(steps.filter((s) => s.id).map((s) => s.id)).toEqual([
      'check',
      'install',
      'validate',
      'login',
      'publish',
      'verify',
    ]);
    expect(step('check').run).toMatch(/^node scripts\/mcp-registry\.js check\s*$/);
    expect(step('publish').run).toMatch(/mcp-publisher" publish packages\/mcp\/server\.json\s*$/);
    expect(step('verify').run).toMatch(/^node scripts\/mcp-registry\.js verify\s*$/);
  });

  it('does nothing past the check when the registry already has the version', () => {
    const after = steps.slice(steps.indexOf(step('check')) + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) expect({ id: s.id, if: s.if }).toEqual({ id: s.id, if: "steps.check.outputs.publish == 'true'" });
  });

  it('installs a pinned mcp-publisher and checks its sha256 before running it', () => {
    expect(wf.env).toMatchObject({
      MCP_PUBLISHER_VERSION: '1.8.1',
      MCP_PUBLISHER_SHA256: 'a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc',
    });
    const run = step('install').run ?? '';
    expect(run).toContain(
      'https://github.com/modelcontextprotocol/registry/releases/download/v${MCP_PUBLISHER_VERSION}/mcp-publisher_linux_amd64.tar.gz',
    );
    expect(run.indexOf('sha256sum -c')).toBeGreaterThan(-1);
    expect(run.indexOf('sha256sum -c')).toBeLessThan(run.indexOf('tar '));
  });

  it('gives the login step the key and the domain', () => {
    expect(step('login').env).toEqual({
      MCP_PRIVATE_KEY: '${{ secrets.MCP_PRIVATE_KEY }}',
      DOMAIN: '${{ steps.check.outputs.domain }}',
    });
  });

  // The login step's own script, run by bash against a stand-in mcp-publisher
  // that records its arguments.
  describe('the login step, run', () => {
    let runner: string;
    beforeEach(() => {
      runner = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-registry-runner-'));
      const fake = path.join(runner, 'mcp-publisher');
      fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RUNNER_TEMP/args"\necho "mcp-publisher ran"\n');
      fs.chmodSync(fake, 0o755);
    });
    afterEach(() => {
      fs.rmSync(runner, { recursive: true, force: true });
    });
    const runLogin = (key: string) =>
      childProcess.spawnSync('bash', ['-e', '-c', step('login').run ?? ''], {
        cwd: repoRoot,
        env: { ...process.env, RUNNER_TEMP: runner, MCP_PRIVATE_KEY: key, DOMAIN: 'testiv.ai' },
        encoding: 'utf8',
      });
    const args = () => fs.readFileSync(path.join(runner, 'args'), 'utf8');

    // testiv.ai publishes its key as a DNS TXT record; it serves no
    // /.well-known/mcp-registry-auth file for HTTP login.
    it('logs in by DNS with the hex of a key.pem secret', () => {
      const { pem, hex } = ed25519();
      const res = runLogin(pem);
      expect(res.status).toBe(0);
      expect(args()).toBe(`login\ndns\n--domain\ntestiv.ai\n--private-key\n${hex}\n`);
    });

    // GitHub masks the secret's own text in logs, not the hex made from it.
    it('masks the hex before mcp-publisher runs', () => {
      const { body, hex } = ed25519();
      const res = runLogin(body);
      expect(res.status).toBe(0);
      const mask = res.stdout.indexOf(`::add-mask::${hex}\n`);
      expect(mask).toBeGreaterThan(-1);
      expect(mask).toBeLessThan(res.stdout.indexOf('mcp-publisher ran'));
      expect(res.stdout.replace(`::add-mask::${hex}`, '')).not.toContain(hex);
    });

    it('stops with the error, before mcp-publisher, on an empty or bad key', () => {
      for (const key of ['', 'not a key']) {
        const res = runLogin(key);
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/::error::MCP_PRIVATE_KEY/);
        expect(fs.existsSync(path.join(runner, 'args'))).toBe(false);
      }
    });
  });
});

describe('.github/workflows/release.yml MCP Registry job', () => {
  const wf = readWorkflow('release.yml');
  const job = wf.jobs['mcp-registry'];

  it('calls mcp-registry.yml after the release job, with read-only permissions', () => {
    expect(job.uses).toBe('./.github/workflows/mcp-registry.yml');
    expect(job.needs).toBe('release');
    expect(job.permissions).toEqual({ contents: 'read' });
  });

  it('runs only when the release published @testivai/mcp', () => {
    expect(job.if).toBe(
      `needs.release.outputs.published == 'true' && contains(needs.release.outputs.publishedPackages, '"@testivai/mcp"')`,
    );
  });

  // publishedPackages is changesets/action's JSON list of {name, version}.
  // Matching the quoted name keeps a package such as @testivai/mcp-extra out.
  it('matches the quoted package name in the published list', () => {
    const published = (names: string[]) => JSON.stringify(names.map((name) => ({ name, version: '1.0.0' })));
    expect(published(['@testivai/witness', '@testivai/mcp']).includes('"@testivai/mcp"')).toBe(true);
    expect(published(['@testivai/mcp-extra']).includes('"@testivai/mcp"')).toBe(false);
  });
});
