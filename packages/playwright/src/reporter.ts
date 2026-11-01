import type { Reporter, FullConfig, Suite, FullResult } from './reporter-types';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  parseShardEnv,
  resolveCaptureOnly as resolveCaptureOnlyShared,
  writeShardManifest,
} from '@testivai/witness';

interface TestivaiReporterOptions {
  debug?: boolean;
  /**
   * Capture only — write `.testivai/temp/` and skip comparison and report
   * generation entirely.
   *
   * This is what a sharded run needs. Each shard only executes a slice of the
   * suite, so comparing inside a shard reports every baseline the *other*
   * shards own as missing coverage: measured on an 8-shard run, every shard
   * exited 3 with ~90% of the suite listed as missing. Capture in the shards,
   * merge the captures, compare once.
   *
   * Left unset this auto-enables when Playwright reports a sharded run
   * (`--shard=i/N` with N > 1). Set it explicitly to `false` to force
   * per-shard reports anyway.
   */
  captureOnly?: boolean;
}

export class TestivAIPlaywrightReporter implements Reporter {
  private options: TestivaiReporterOptions;
  private tempDir = path.join(process.cwd(), '.testivai', 'temp');
  private captureOnly = false;
  private shard: { current: number; total: number } | null = null;

  constructor(options: TestivaiReporterOptions = {}) {
    this.options = {
      debug: options.debug || process.env.TESTIVAI_DEBUG === 'true',
      captureOnly: options.captureOnly,
    };
  }

  /**
   * Capture-only resolution, most explicit wins:
   *   1. the reporter option (including an explicit `false` to opt out)
   *   2. TESTIVAI_CAPTURE_ONLY — for CI that can't edit playwright.config
   *   3. auto: Playwright says this is shard i/N with N > 1
   */
  private resolveCaptureOnly(_config: FullConfig): boolean {
    return resolveCaptureOnlyShared(this.options.captureOnly, this.shard);
  }

  async onBegin(config: FullConfig, _suite: Suite): Promise<void> {
    // Playwright's own --shard wins; TESTIVAI_SHARD covers CI that splits work
    // some other way, and is the same contract the non-JS adapters honour.
    this.shard = config.shard ?? parseShardEnv(process.env.TESTIVAI_SHARD);
    this.captureOnly = this.resolveCaptureOnly(config);

    // Clean temp directory
    await fs.emptyDir(this.tempDir);
  }

  async onEnd(result: FullResult): Promise<void> {
    // Wrap entire reporter logic in try-catch to prevent crashes
    try {
      // ── Capture-only: leave the captures on disk and stop ─────────────────
      //    Comparing here would be wrong for a shard (it can only see its own
      //    slice) so we say what to do next instead of producing a misleading
      //    report and exit code.
      if (this.captureOnly) {
        // Drop a manifest naming this shard, so the merge step can prove every
        // shard reported. Written HERE rather than at onBegin on purpose: a
        // shard killed mid-run (OOM, runner loss) never reaches onEnd and so
        // leaves no manifest, which is precisely the case worth catching.
        // Without this a crashed shard silently reduces coverage whenever
        // failOnMissing is off.
        if (this.shard) {
          writeShardManifest(path.join(process.cwd(), '.testivai', 'temp'), this.shard, {
            complete: true,
            status: result.status,
          });
        }

        const where = this.shard ? `shard ${this.shard.current}/${this.shard.total}` : 'capture-only mode';
        console.log(`\n  TestivAI: ${where} — captured to .testivai/temp/, comparison skipped.`);
        console.log('  Collect every shard\'s .testivai/temp/, then compare once:');
        console.log('    npx testivai merge-captures <dirs...> && npx testivai report --fail-on-diff');
        // A CI step runs only on success by default, so one failing test would
        // skip the comparison and leave the pull request without a report.
        console.log('  Run that step even when a test fails: in GitHub Actions, `if: ${{ !cancelled() }}`');
        console.log('  (and on a job that `needs` the shards, too).');
        return;
      }

      // ── Generate the HTML report ──────────────────────────────────────────
      if (this.options.debug) {
        console.log('Testivai Reporter: [DEBUG] Generating visual report...');
      }

      // Dynamic import of @testivai/witness/report
      const { generateReport } = await import('@testivai/witness/report');

      // Load local config for report settings
      const localConfigPath = path.join(process.cwd(), '.testivai', 'config.json');
      const localConfig = fs.existsSync(localConfigPath)
        ? fs.readJsonSync(localConfigPath)
        : { threshold: 0.1, reportDir: 'visual-report', autoOpen: false };

      const reportData = generateReport({
        projectRoot: process.cwd(),
        reportDir: localConfig.reportDir || 'visual-report',
        threshold: localConfig.threshold,
        autoOpen: localConfig.autoOpen,
      });

      // Print summary
      const { summary } = reportData;
      const missing = reportData.missingBaselines?.length ?? 0;
      console.log(`\n  === TestivAI Visual Report ===`);
      console.log(`  Total: ${summary.total}  |  Passed: ${summary.passed}  |  Changed: ${summary.changed}  |  New: ${summary.newSnapshots}`);
      if (missing > 0) {
        console.log(`  Missing baselines (no capture this run): ${missing}`);
      }

      // A reporter cannot change the process exit code — Playwright owns it,
      // and it reflects test results, not visual results. Saying nothing here
      // meant a run could print "Changed: 3" and still exit 0, which reads
      // like a check that passed. State it plainly and name the gate.
      if (summary.changed > 0 || summary.newSnapshots > 0 || missing > 0) {
        console.log(`\n  NOTE: this did NOT fail the build — a reporter cannot set the exit code.`);
        console.log(`     Gate it in CI:  npx testivai report --fail-on-diff`);
        console.log(`     To approve:     npx testivai approve --all`);
      }

      if (this.options.debug) {
        console.log(`Testivai Reporter: [DEBUG] Report generated at ${path.join(process.cwd(), localConfig.reportDir || 'visual-report')}`);
      }
    } catch (error: any) {
      // Log error but don't throw - let tests complete normally
      console.error('Testivai Reporter: Error:', error.message);
      if (this.options.debug) {
        console.error('Error stack:', error.stack);
      }
      // Don't throw - reporter errors should not crash the test run
    }
  }

}

export default TestivAIPlaywrightReporter;
