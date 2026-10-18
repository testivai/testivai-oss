import { Command } from 'commander';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import { collectHostEnvironment, type EnvironmentPolicy, type HostEnvironment } from '../capture/environment';
import { loadLocalConfig } from '../config/local-config';

/**
 * `testivai env` — this machine's part of the capture environment: the OS
 * and distro, CI and its runner image, a container, TESTIVAI_ENV_LABEL,
 * and the environmentPolicy that decides what a change of environment does.
 * The rest of the block (browser, framework, adapter, render settings) is
 * recorded by each capture, since it depends on the browser a test opens.
 *
 * `--fonts` adds a fingerprint of the installed font list (fc-list): two
 * machines whose fingerprints differ draw text differently, the most common
 * reason the same page renders differently "at the same URL". Not recorded
 * per capture: listing fonts costs a process spawn.
 */

/** Count and a short hash of a font list (fc-list output), independent of its order and duplicates. */
export function fontFingerprint(fcListOutput: string): { count: number; sha256: string } {
  const fonts = [...new Set(fcListOutput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))].sort();
  return { count: fonts.length, sha256: crypto.createHash('sha256').update(fonts.join('\n')).digest('hex').slice(0, 12) };
}

/** The installed fonts' fingerprint, or 'unavailable' when fc-list cannot run here. */
export function readFontFingerprint(): { count: number; sha256: string } | 'unavailable' {
  try {
    const out = execFileSync('fc-list', [':', 'family', 'style'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    return fontFingerprint(out);
  } catch {
    return 'unavailable';
  }
}

export interface EnvironmentReport {
  host: HostEnvironment;
  policy: EnvironmentPolicy;
  /** null: not asked for; 'unavailable': no fc-list. */
  fonts: { count: number; sha256: string } | 'unavailable' | null;
}

/** The human-readable `testivai env` output. */
export function formatEnvironment(report: EnvironmentReport): string {
  const { host, policy, fonts } = report;
  const os = `${host.os.platform} ${host.os.release} ${host.os.arch}${host.os.distro ? ` (${host.os.distro})` : ''}`;
  const ci = host.ci ? `${host.ci.provider}${host.ci.runnerImage ? ` (runner image ${host.ci.runnerImage})` : ''}` : 'none';
  const fontLine =
    fonts === null
      ? 'not checked (pass --fonts)'
      : fonts === 'unavailable'
        ? 'fc-list is not available on this machine'
        : `${fonts.count} installed, fingerprint ${fonts.sha256}`;
  return [
    'TestivAI capture environment (this machine)',
    `  os:        ${os}`,
    `  ci:        ${ci}`,
    `  container: ${host.container ? 'yes' : 'no'}`,
    `  label:     ${host.label ?? 'none (set TESTIVAI_ENV_LABEL to name this environment)'}`,
    `  fonts:     ${fontLine}`,
    `  policy:    environmentPolicy "${policy}"`,
    'Browser, framework, adapter and render settings are recorded by each capture (metadata.json `environment`).',
  ].join('\n');
}

export const envCommand = new Command('env')
  .description("Print this machine's capture environment (OS, distro, CI, container, label) and the environmentPolicy")
  .option('--fonts', 'Also fingerprint the installed fonts (fc-list): differing fingerprints mean text renders differently')
  .option('--json', 'Print machine-readable JSON')
  .action((options: { fonts?: boolean; json?: boolean }) => {
    const report: EnvironmentReport = {
      host: collectHostEnvironment(),
      policy: loadLocalConfig(process.cwd()).environmentPolicy ?? 'warn',
      fonts: options.fonts ? readFontFingerprint() : null,
    };
    if (options.json) {
      const payload: Record<string, unknown> = { environment: report.host, environmentPolicy: report.policy };
      if (report.fonts !== null) payload.fonts = report.fonts;
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatEnvironment(report)}\n`);
    }
  });
