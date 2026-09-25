#!/usr/bin/env node
/**
 * Keeps packages/mcp/server.json (the MCP registry listing) on the same
 * version as packages/mcp/package.json.
 *
 * Changesets bumps package.json but knows nothing about server.json, so the
 * listing drifted (0.5.7 while npm moved on to 0.5.10). This runs inside
 * `pnpm version-packages`, right after `changeset version`, so the bump
 * lands in the same Version PR as the package.json change.
 *
 * Only the two version fields are rewritten; everything else stays as
 * authored. Publishing the listing to the registry (`mcp-publisher`) is a
 * separate step and is not done here.
 *
 * Usage:
 *   node scripts/sync-mcp-server-json.js [packageDir]   (default: packages/mcp)
 */

const fs = require('fs');
const path = require('path');

function syncServerJson(pkgDir) {
  const pkgPath = path.join(pkgDir, 'package.json');
  const serverPath = path.join(pkgDir, 'server.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const raw = fs.readFileSync(serverPath, 'utf8');
  const server = JSON.parse(raw);

  const entry = (server.packages || []).find((p) => p.identifier === pkg.name);
  if (!entry) {
    throw new Error(`${serverPath} has no packages[] entry with identifier "${pkg.name}"`);
  }

  const from = server.version;
  const to = pkg.version;
  if (server.version === to && entry.version === to) {
    return { from, to, changed: false };
  }

  server.version = to;
  entry.version = to;
  fs.writeFileSync(serverPath, JSON.stringify(server, null, 2) + '\n');
  return { from, to, changed: true };
}

module.exports = { syncServerJson };

if (require.main === module) {
  const pkgDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'packages', 'mcp'));
  const { from, to, changed } = syncServerJson(pkgDir);
  console.log(changed ? `server.json: ${from} -> ${to}` : `server.json: already at ${to}`);
}
