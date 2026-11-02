#!/usr/bin/env node
/**
 * Tag a GitHub Action release and move its major tag, from a maintainer's
 * clone, with the maintainer's own git credentials.
 *
 * Pushing a vX.Y.Z tag starts .github/workflows/release-action.yml, which
 * moves the major tag (v1) itself. GitHub refuses that push when a workflow
 * file changed since the major tag's old commit and the workflow's token has
 * no `workflows` permission (see action/README.md, "Releases"). This script
 * does both steps here instead, so a release never depends on that token.
 * The workflow still runs on the tag push and moves the major tag to the same
 * commit, or fails harmlessly.
 *
 * Usage:
 *   node scripts/release-action.js vX.Y.Z [--ref <commit>] [--remote <name>] [--message <text>] [--dry-run]
 *
 *   --ref      the commit to release (default: <remote>/main, after a fetch)
 *   --remote   default: origin
 *   --message  the release tag's message (default: "Action vX.Y.Z")
 *   --dry-run  check everything and say what would happen; change nothing
 *
 * It refuses, changing nothing, when: the version is not vMAJOR.MINOR.PATCH;
 * the commit is not on <remote>/main; the commit has no action/dist/index.js
 * or no "## [X.Y.Z]" section in action/CHANGELOG.md; the tag exists at
 * another commit; or the version is older than an existing release of the
 * same major (the major tag never moves backwards). A tag that already exists
 * at the same commit is reused, so a re-run finishes moving the major tag.
 *
 * Git runs without a shell (execFileSync), so no argument is ever run as a
 * command.
 */

const { execFileSync } = require('child_process');

const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const USAGE = 'Usage: node scripts/release-action.js vX.Y.Z [--ref <commit>] [--remote <name>] [--message <text>] [--dry-run]';

class Refusal extends Error {}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

/** git, or null when it fails (an object that does not exist, a ref git cannot resolve). */
function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const opts = { remote: 'origin', dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--ref' || arg === '--remote' || arg === '--message') {
      const value = argv[++i];
      if (value === undefined) throw new Refusal(`${arg} needs a value.\n${USAGE}`);
      opts[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) throw new Refusal(`Unknown option ${arg}.\n${USAGE}`);
    else rest.push(arg);
  }
  if (rest.length !== 1) throw new Refusal(USAGE);
  opts.version = rest[0];
  return opts;
}

const semver = (tag) => VERSION.exec(tag)?.slice(1).map(Number) ?? null;
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The commit a tag on the remote points at, or null when the remote has no such tag. */
function remoteTagCommit(remote, tag) {
  const out = git(['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (!out) return null;
  const lines = out.split('\n').map((l) => l.split('\t'));
  const peeled = lines.find(([, ref]) => ref.endsWith('^{}'));
  return (peeled ?? lines[0])[0];
}

function main(argv) {
  const opts = parseArgs(argv);
  const parts = semver(opts.version);
  if (!parts) throw new Refusal(`"${opts.version}" is not a release version: use vMAJOR.MINOR.PATCH, e.g. v1.6.2 (pre-releases do not move the major tag).`);
  const version = opts.version;
  const major = `v${parts[0]}`;
  const plain = version.slice(1);
  const { remote } = opts;

  console.log(`Fetching ${remote} main and tags...`);
  git(['fetch', '--quiet', '--force', '--tags', remote, 'main']);
  const mainRef = `refs/remotes/${remote}/main`;
  if (!gitOrNull(['rev-parse', '--verify', '--quiet', mainRef])) {
    throw new Refusal(`${remote}/main not found after the fetch.`);
  }

  // The major tag never moves backwards.
  const sameMajor = git(['tag', '--list', `${major}.*`])
    .split('\n')
    .map((t) => ({ tag: t, parts: semver(t) }))
    .filter((t) => t.parts && t.parts[0] === parts[0] && t.tag !== version);
  const newer = sameMajor.filter((t) => compare(t.parts, parts) > 0).sort((a, b) => compare(b.parts, a.parts))[0];
  if (newer) throw new Refusal(`${version} is older than ${newer.tag}: ${major} would move backwards.`);

  const ref = opts.ref ?? `${remote}/main`;
  const sha = gitOrNull(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  if (!sha) throw new Refusal(`Could not resolve "${ref}" to a commit.`);

  if (gitOrNull(['merge-base', '--is-ancestor', sha, mainRef]) === null) {
    throw new Refusal(`${sha} is not on ${remote}/main: release only merged commits.`);
  }
  if (gitOrNull(['cat-file', '-e', `${sha}:action/dist/index.js`]) === null) {
    throw new Refusal(`${sha} has no action/dist/index.js: the action would not run.`);
  }
  const changelog = gitOrNull(['show', `${sha}:action/CHANGELOG.md`]) ?? '';
  if (!changelog.split('\n').some((line) => line.startsWith(`## [${plain}]`))) {
    throw new Refusal(`action/CHANGELOG.md at ${sha} has no "## [${plain}]" section: add it in a pull request first.`);
  }

  const existing = remoteTagCommit(remote, version);
  if (existing && existing !== sha) {
    throw new Refusal(`${version} already exists at ${existing}, not ${sha}. Pick the next version.`);
  }

  const majorMessage = `Rolling major tag → ${version} (${sha})`;
  if (opts.dryRun) {
    console.log(`\nDry run: nothing changed. Would:`);
    console.log(existing ? `  reuse ${version} (already at ${sha})` : `  tag ${version} at ${sha} and push it to ${remote}`);
    console.log(`  move ${major} to ${version} (${sha}) on ${remote}`);
    return;
  }

  if (existing) {
    console.log(`${version} already exists at ${sha}; reusing it.`);
  } else {
    git(['tag', '--annotate', version, '--message', opts.message ?? `Action ${version}`, sha]);
    git(['push', '--quiet', remote, `refs/tags/${version}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    console.log(`Pushed ${version} (${sha}).`);
  }

  git(['tag', '--force', '--annotate', major, '--message', majorMessage, sha]);
  git(['push', '--quiet', '--force', remote, `refs/tags/${major}`], { stdio: ['ignore', 'pipe', 'inherit'] });

  const now = remoteTagCommit(remote, major);
  if (now !== sha) throw new Error(`${major} on ${remote} points at ${now ?? 'nothing'}, not ${sha}.`);
  console.log(`${major} now points at ${version} (${sha}) on ${remote}.`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(`Refused: ${err.message}`);
    } else {
      const detail = err?.stderr ? String(err.stderr).trim() : '';
      console.error(`Failed: ${err instanceof Error ? err.message : String(err)}${detail ? `\n${detail}` : ''}`);
    }
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, Refusal };
