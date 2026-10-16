#!/usr/bin/env node
/**
 * The decisions behind publishing packages/mcp/server.json to the official
 * MCP Registry (registry.modelcontextprotocol.io), run by
 * .github/workflows/mcp-registry.yml around `mcp-publisher`.
 *
 *   check   Is this version already listed? If not, does npm serve it with
 *           the mcpName the registry checks? Writes publish=true|false and
 *           the domain to log in with as step outputs.
 *   verify  After `mcp-publisher publish`: is the version listed, under this
 *           repository? Warns when it is not the latest.
 *
 * Publishing was a manual step before this, and the listing stayed at 0.5.7,
 * under the repository's old owner, while npm moved on to 0.7.0.
 *
 * Usage:
 *   node scripts/mcp-registry.js check|verify [packageDir]   (default: packages/mcp)
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
const NPM_URL = 'https://registry.npmjs.org';

/** The domain a reverse-DNS server name is under: ai.testiv/mcp -> testiv.ai. */
function domainFor(name) {
  const namespace = name.split('/')[0];
  if (namespace.startsWith('io.github.')) {
    throw new Error(`${name} is under a GitHub namespace, which logs in with GitHub, not a domain`);
  }
  return namespace.split('.').reverse().join('.');
}

/** server.json, checked against package.json: what would be published. */
function readListing(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const server = JSON.parse(fs.readFileSync(path.join(pkgDir, 'server.json'), 'utf8'));

  const entry = (server.packages || []).find((p) => p.identifier === pkg.name);
  if (!entry) {
    throw new Error(`server.json has no packages[] entry with identifier "${pkg.name}"`);
  }
  for (const [field, version] of [
    ['version', server.version],
    ['packages[].version', entry.version],
  ]) {
    if (version !== pkg.version) {
      throw new Error(`server.json ${field} is ${version} but package.json is at ${pkg.version}`);
    }
  }
  if (server.name !== pkg.mcpName) {
    throw new Error(`package.json mcpName is ${pkg.mcpName} but server.json is named ${server.name}`);
  }

  return {
    name: server.name,
    version: server.version,
    identifier: entry.identifier,
    domain: domainFor(server.name),
    repositoryUrl: server.repository?.url,
  };
}

const registryVersionUrl = ({ name, version }) =>
  `${REGISTRY_URL}/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;

/** The registry's entry for this version, or null when it is not listed. */
async function registryEntry(listing, fetch) {
  const url = registryVersionUrl(listing);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`MCP Registry answered ${res.status} for ${url}`);
  return res.json();
}

const defaults = { attempts: 10, intervalMs: 15000 };

async function check({ pkgDir, fetch, sleep, attempts = defaults.attempts, intervalMs = defaults.intervalMs }) {
  const listing = readListing(pkgDir);
  const { name, version, identifier, domain } = listing;
  if (await registryEntry(listing, fetch)) {
    return { publish: false, name, version, domain };
  }

  // The same request the registry makes to check ownership.
  const url = `${NPM_URL}/${identifier.replace('/', '%2F')}/${version}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (res.status === 200) {
      const doc = await res.json();
      if (doc.mcpName !== name) {
        throw new Error(
          doc.mcpName
            ? `npm ${identifier}@${version} has mcpName ${doc.mcpName}, not ${name}`
            : `npm ${identifier}@${version} has no mcpName; the registry needs "mcpName": "${name}"`,
        );
      }
      return { publish: true, name, version, domain };
    }
    if (attempt >= attempts) {
      throw new Error(`${identifier}@${version} is not on npm (last answer ${res.status}); publish it to npm first`);
    }
    await sleep(intervalMs);
  }
}

async function verify({ pkgDir, fetch, sleep, attempts = 6, intervalMs = 10000 }) {
  const listing = readListing(pkgDir);
  for (let attempt = 1; ; attempt++) {
    const entry = await registryEntry(listing, fetch);
    if (entry) {
      const url = entry.server?.repository?.url;
      if (url !== listing.repositoryUrl) {
        throw new Error(`The registry lists ${listing.name}@${listing.version} under ${url}, not ${listing.repositoryUrl}`);
      }
      const official = entry._meta?.['io.modelcontextprotocol.registry/official'] || {};
      return { isLatest: official.isLatest === true };
    }
    if (attempt >= attempts) {
      throw new Error(`${listing.name}@${listing.version} is not in the MCP Registry after publishing`);
    }
    await sleep(intervalMs);
  }
}

/** The CLI, with its effects passed in. Resolves to the exit code. */
async function main(argv, { env, fetch, sleep, log }) {
  const [command, dir] = argv;
  const pkgDir = path.resolve(dir || path.join(__dirname, '..', 'packages', 'mcp'));
  try {
    if (command === 'check') {
      const result = await check({ pkgDir, fetch, sleep });
      if (!result.publish) {
        log(`::notice::${result.name} ${result.version} is already in the MCP Registry; nothing to publish.`);
      }
      const outputs = ['publish', 'name', 'version', 'domain'].map((key) => `${key}=${result[key]}\n`).join('');
      if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, outputs);
      else log(outputs.trimEnd());
      return 0;
    }
    if (command === 'verify') {
      const listing = readListing(pkgDir);
      const { isLatest } = await verify({ pkgDir, fetch, sleep });
      if (isLatest) {
        log(`::notice::${listing.name} ${listing.version} is the latest version in the MCP Registry.`);
      } else {
        log(`::warning::${listing.name} ${listing.version} is listed, but it is not the latest version in the MCP Registry.`);
      }
      return 0;
    }
    throw new Error(`unknown command "${command}"; use check or verify`);
  } catch (err) {
    log(`::error::${err.message}`);
    return 1;
  }
}

module.exports = { REGISTRY_URL, NPM_URL, domainFor, readListing, check, verify, main };

if (require.main === module) {
  main(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  }).then((code) => {
    process.exitCode = code;
  });
}
