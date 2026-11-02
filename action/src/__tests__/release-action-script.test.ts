/**
 * scripts/release-action.js: tag an action release and move its major tag
 * (v1) from a maintainer's clone, with the maintainer's own git credentials.
 * It is the fallback for when .github/workflows/release-action.yml cannot
 * move the major tag (a token without the `workflows` permission), and works
 * as the whole release step on its own.
 *
 * Each test runs the script as a process in a clone of a local bare remote
 * laid out like this repository (main, action/dist/index.js,
 * action/CHANGELOG.md, earlier release tags and v1).
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'release-action.js');

let dir: string;
let remote: string;
let work: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
/** The commit a tag on the remote resolves to, through any tag objects; null when it has no such tag. */
const remoteRef = (ref: string) => {
  try {
    return git(remote, 'rev-parse', '--verify', '--quiet', `refs/tags/${ref}^{commit}`);
  } catch {
    return null;
  }
};

/** A commit on the current branch with the action's dist and a changelog listing the versions given. */
function commit(message: string, versions: string[], dist = true) {
  fs.mkdirSync(path.join(work, 'action', 'dist'), { recursive: true });
  const distPath = path.join(work, 'action', 'dist', 'index.js');
  if (dist) fs.writeFileSync(distPath, `// ${message}\n`);
  else fs.rmSync(distPath, { force: true });
  fs.writeFileSync(
    path.join(work, 'action', 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n${versions.map((v) => `## [${v}] - 2026-11-01\n\n- ${v}\n`).join('\n')}`,
  );
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
}

let released: string; // the commit v1.6.1 and v1 are on
let next: string; // main's head: changelog lists 1.6.2

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-action-script-'));
  remote = path.join(dir, 'remote.git');
  work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) {
    git(work, 'config', k, v);
  }
  git(work, 'remote', 'add', 'origin', remote);
  released = commit('release 1.6.1', ['1.6.1', '1.6.0']);
  git(work, 'tag', '-a', 'v1.6.1', '-m', 'v1.6.1');
  git(work, 'tag', '-a', 'v1', '-m', 'v1', 'v1.6.1^{commit}');
  next = commit('release 1.6.2', ['1.6.2', '1.6.1', '1.6.0']);
  git(work, 'push', '-q', 'origin', 'main', '--tags');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('a release', () => {
  it('tags origin/main, moves v1 to it, and checks the remote', () => {
    const { code, output } = run('v1.6.2');

    expect(code).toBe(0);
    expect(remoteRef('v1.6.2')).toBe(next);
    expect(remoteRef('v1')).toBe(next);
    expect(git(remote, 'tag', '-l', '--format=%(contents:subject)', 'v1')).toBe(`Rolling major tag → v1.6.2 (${next})`);
    expect(output).toContain(`v1 now points at v1.6.2 (${next})`);
  });

  it('takes the tag message from --message', () => {
    expect(run('v1.6.2', '--message', 'Action v1.6.2: a fix').code).toBe(0);
    expect(git(remote, 'tag', '-l', '--format=%(contents:subject)', 'v1.6.2')).toBe('Action v1.6.2: a fix');
  });

  it('works when the local clone is behind: it fetches main and the tags first', () => {
    git(work, 'reset', '-q', '--hard', released);
    git(work, 'tag', '-d', 'v1.6.1');

    expect(run('v1.6.2').code).toBe(0);
    expect(remoteRef('v1.6.2')).toBe(next);
  });

  it('re-run after the tag was pushed but v1 was not moved: reuses the tag and moves v1', () => {
    git(work, 'tag', '-a', 'v1.6.2', '-m', 'Action v1.6.2', next);
    git(work, 'push', '-q', 'origin', 'refs/tags/v1.6.2');

    const { code, output } = run('v1.6.2');

    expect(code).toBe(0);
    expect(output).toMatch(/v1\.6\.2 already exists at/);
    expect(remoteRef('v1')).toBe(next);
  });

  it('--ref releases an earlier commit of main', () => {
    const older = commit('later work', ['1.6.2', '1.6.1', '1.6.0']);
    git(work, 'push', '-q', 'origin', 'main');

    expect(run('v1.6.2', '--ref', next).code).toBe(0);
    expect(remoteRef('v1.6.2')).toBe(next);
    expect(remoteRef('v1.6.2')).not.toBe(older);
  });
});

describe('--dry-run', () => {
  it('says what it would do and changes nothing', () => {
    const { code, output } = run('v1.6.2', '--dry-run');

    expect(code).toBe(0);
    expect(output).toContain('Dry run');
    expect(output).toContain(next);
    expect(remoteRef('v1.6.2')).toBeNull();
    expect(remoteRef('v1')).toBe(released);
    expect(git(work, 'tag', '-l', 'v1.6.2')).toBe('');
  });
});

describe('refuses, changing nothing', () => {
  function expectRefused(result: { code: number | null; output: string }, message: RegExp) {
    expect(result.code).toBe(1);
    expect(result.output).toMatch(message);
    expect(remoteRef('v1')).toBe(released);
  }

  it.each(['1.6.2', 'v1.6', 'v1.6.2-rc.1', 'v01.6.2', '', 'v1.6.2; touch pwned'])('a version that is not vMAJOR.MINOR.PATCH: %j', (version) => {
    expectRefused(run(version), /vMAJOR\.MINOR\.PATCH/);
    expect(fs.existsSync(path.join(work, 'pwned'))).toBe(false);
  });

  it('no version at all', () => {
    expectRefused(run(), /Usage/);
  });

  it('a tag that already exists at another commit', () => {
    git(work, 'tag', '-a', 'v1.6.2', '-m', 'x', released);
    git(work, 'push', '-q', 'origin', 'refs/tags/v1.6.2');

    expectRefused(run('v1.6.2'), /v1\.6\.2 already exists at .* not /);
  });

  it('a version older than an existing release of the same major', () => {
    commit('changelog for 1.5.9', ['1.5.9', '1.6.1']);
    git(work, 'push', '-q', 'origin', 'main');

    expectRefused(run('v1.5.9'), /older than v1\.6\.1/);
    expect(remoteRef('v1.5.9')).toBeNull();
  });

  it('a commit that is not on origin/main', () => {
    git(work, 'checkout', '-q', '-b', 'feature');
    const side = commit('side', ['1.6.2', '1.6.1']);

    expectRefused(run('v1.6.2', '--ref', side), /not on origin\/main/);
    expect(remoteRef('v1.6.2')).toBeNull();
  });

  it('a commit without action/dist/index.js', () => {
    commit('no dist', ['1.6.2', '1.6.1'], false);
    git(work, 'push', '-q', 'origin', 'main');

    expectRefused(run('v1.6.2'), /action\/dist\/index\.js/);
  });

  it('a commit whose action/CHANGELOG.md has no section for the version', () => {
    expectRefused(run('v1.7.0'), /## \[1\.7\.0\]/);
    expect(remoteRef('v1.7.0')).toBeNull();
  });

  it('a --ref that git cannot resolve, without running it', () => {
    expectRefused(run('v1.6.2', '--ref', 'main; touch pwned'), /resolve/);
    expect(fs.existsSync(path.join(work, 'pwned'))).toBe(false);
  });

  it('a remote that refuses the push: fails with git\'s error, and v1 stays', () => {
    const hooks = path.join(remote, 'hooks');
    fs.writeFileSync(path.join(hooks, 'refusal.txt'), 'Permission to testivai/testivai-oss.git denied\n');
    fs.writeFileSync(path.join(hooks, 'pre-receive'), '#!/bin/sh\ncat "$(dirname "$0")/refusal.txt" >&2\nexit 1\n');
    fs.chmodSync(path.join(hooks, 'pre-receive'), 0o755);

    const result = run('v1.6.2');

    expect(result.code).toBe(1);
    expect(result.output).toContain('Failed:');
    expect(result.output).toContain('Permission to testivai/testivai-oss.git denied');
    expect(remoteRef('v1.6.2')).toBeNull();
    expect(remoteRef('v1')).toBe(released);
  });

  it('an unknown option', () => {
    expectRefused(run('v1.6.2', '--force'), /Unknown option/);
  });
});
