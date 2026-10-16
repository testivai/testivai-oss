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

  // testiv.ai publishes its key as a DNS TXT record; it serves no
  // /.well-known/mcp-registry-auth file for HTTP login.
  it('logs in by DNS to the domain the server name is under, refusing an empty key first', () => {
    const login = step('login');
    expect(login.env).toEqual({
      MCP_PRIVATE_KEY: '${{ secrets.MCP_PRIVATE_KEY }}',
      DOMAIN: '${{ steps.check.outputs.domain }}',
    });
    const run = login.run ?? '';
    expect(run).toMatch(/^if \[ -z "\$MCP_PRIVATE_KEY" \]/);
    expect(run).toMatch(/mcp-publisher" login dns --domain "\$DOMAIN" --private-key "\$MCP_PRIVATE_KEY"\s*$/);
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
