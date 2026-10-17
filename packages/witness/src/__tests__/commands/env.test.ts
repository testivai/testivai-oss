/**
 * `testivai env`: this machine's part of the capture environment, the block
 * every capture records, so a team can see what its baselines will be
 * compared against before a run (and why two machines render differently).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { envCommand, fontFingerprint, formatEnvironment } from '../../commands/env';

describe('fontFingerprint', () => {
  it('counts the fonts and hashes the sorted, de-duplicated list, so the order fc-list prints in does not matter', () => {
    const a = fontFingerprint('DejaVu Sans:style=Book\nLiberation Serif:style=Regular\nDejaVu Sans:style=Book\n');
    const b = fontFingerprint('Liberation Serif:style=Regular\n\nDejaVu Sans:style=Book\n');
    expect(a).toEqual({ count: 2, sha256: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(b).toEqual(a);
  });

  it('another font set has another hash', () => {
    expect(fontFingerprint('DejaVu Sans:style=Book\n').sha256).not.toBe(fontFingerprint('Noto Sans:style=Regular\n').sha256);
  });
});

describe('formatEnvironment', () => {
  it('lists the host block, the policy, and the fonts when asked', () => {
    const text = formatEnvironment({
      host: {
        os: { platform: 'linux', release: '6.8.0-1017-azure', arch: 'x64', distro: 'ubuntu 24.04' },
        ci: { provider: 'github-actions', runnerImage: 'ubuntu24/20251012.1.0' },
        container: true,
        label: 'pw-1.64',
      },
      policy: 'warn',
      fonts: { count: 103, sha256: 'abcdef012345' },
    });
    expect(text.split('\n')).toEqual([
      'TestivAI capture environment (this machine)',
      '  os:        linux 6.8.0-1017-azure x64 (ubuntu 24.04)',
      '  ci:        github-actions (runner image ubuntu24/20251012.1.0)',
      '  container: yes',
      '  label:     pw-1.64',
      '  fonts:     103 installed, fingerprint abcdef012345',
      '  policy:    environmentPolicy "warn"',
      'Browser, framework, adapter and render settings are recorded by each capture (metadata.json `environment`).',
    ]);
  });

  it('says what is absent instead of leaving it out', () => {
    const text = formatEnvironment({ host: { os: { platform: 'darwin', release: '24.6.0', arch: 'arm64' } }, policy: 'strict', fonts: null });
    expect(text).toContain('  os:        darwin 24.6.0 arm64\n');
    expect(text).toContain('  ci:        none\n');
    expect(text).toContain('  container: no\n');
    expect(text).toContain('  label:     none (set TESTIVAI_ENV_LABEL to name this environment)\n');
    expect(text).toContain('  fonts:     not checked (pass --fonts)\n');
  });

  it('a machine without fc-list says so', () => {
    const text = formatEnvironment({ host: { os: { platform: 'win32', release: '10.0.26100', arch: 'x64' } }, policy: 'warn', fonts: 'unavailable' });
    expect(text).toContain('  fonts:     fc-list is not available on this machine\n');
  });
});

describe('testivai env --json', () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-env-cmd-'));
    cwd = process.cwd();
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prints the host block and the policy as JSON', async () => {
    fs.mkdirSync(path.join(root, '.testivai'));
    fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ environmentPolicy: 'separate' }));
    const out: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      await envCommand.parseAsync(['--json'], { from: 'user' });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(out.join(''));
    expect(parsed.environmentPolicy).toBe('separate');
    expect(parsed.environment.os.platform).toBe(process.platform);
    expect(parsed.fonts).toBeUndefined();
  });
});
