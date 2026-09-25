import * as fs from 'node:fs';
import * as path from 'node:path';

// server.json is the MCP registry listing. It ships in the npm tarball and
// is what `mcp-publisher` submits, so a stale version advertises a release
// that is not the one on npm.
const pkgDir = path.resolve(__dirname, '..', '..');
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(pkgDir, file), 'utf8'));

describe('server.json (MCP registry listing)', () => {
  const pkg = readJson('package.json');
  const server = readJson('server.json');

  it('top-level version matches package.json', () => {
    expect(server.version).toBe(pkg.version);
  });

  it('npm package entry matches package.json name and version', () => {
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
  });
});

// The release flow keeps the two in step: `pnpm version-packages` (what
// changesets/action runs to build the Version PR) calls this after
// `changeset version` bumps package.json.
const repoRoot = path.resolve(pkgDir, '..', '..');
const syncScript = path.join(repoRoot, 'scripts', 'sync-mcp-server-json.js');

describe('scripts/sync-mcp-server-json.js', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mcp-server-json-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (file: string, data: unknown) =>
    fs.writeFileSync(path.join(tmp, file), JSON.stringify(data, null, 2) + '\n');
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(tmp, file), 'utf8'));

  it('copies the package.json version into both server.json version fields', () => {
    write('package.json', { name: '@testivai/mcp', version: '1.2.3' });
    write('server.json', {
      name: 'ai.testiv/mcp',
      version: '0.0.1',
      packages: [{ registryType: 'npm', identifier: '@testivai/mcp', version: '0.0.1', transport: { type: 'stdio' } }],
    });

    const { syncServerJson } = require(syncScript);
    expect(syncServerJson(tmp)).toEqual({ from: '0.0.1', to: '1.2.3', changed: true });

    const server = read('server.json');
    expect(server.version).toBe('1.2.3');
    expect(server.packages[0].version).toBe('1.2.3');
    // Everything else is left as authored.
    expect(server.name).toBe('ai.testiv/mcp');
    expect(server.packages[0].transport).toEqual({ type: 'stdio' });
  });

  it('leaves the file byte-for-byte untouched when already in sync', () => {
    write('package.json', { name: '@testivai/mcp', version: '1.2.3' });
    write('server.json', { version: '1.2.3', packages: [{ identifier: '@testivai/mcp', version: '1.2.3' }] });
    const before = fs.readFileSync(path.join(tmp, 'server.json'), 'utf8');

    const { syncServerJson } = require(syncScript);
    expect(syncServerJson(tmp)).toEqual({ from: '1.2.3', to: '1.2.3', changed: false });
    expect(fs.readFileSync(path.join(tmp, 'server.json'), 'utf8')).toBe(before);
  });

  it('refuses to guess when the npm entry does not name this package', () => {
    write('package.json', { name: '@testivai/mcp', version: '1.2.3' });
    write('server.json', { version: '0.0.1', packages: [{ identifier: '@someone/else', version: '0.0.1' }] });

    const { syncServerJson } = require(syncScript);
    expect(() => syncServerJson(tmp)).toThrow(/@testivai\/mcp/);
  });

  it('runs as part of `pnpm version-packages`, after `changeset version`', () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(rootPkg.scripts['version-packages']).toMatch(
      /^changeset version && node scripts\/sync-mcp-server-json\.js(\s|$)/,
    );
  });
});
