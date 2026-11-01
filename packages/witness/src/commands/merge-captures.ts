/**
 * `testivai merge-captures <dirs...>`
 *
 * Unions captures produced by several sharded CI machines into this project's
 * `.testivai/temp/`, so a single `testivai report` can compare the whole suite
 * at once.
 *
 * WHY THIS EXISTS
 * ---------------
 * A shard only runs a slice of the suite. Comparing inside a shard therefore
 * reports every baseline the *other* shards own as missing coverage — measured
 * on a real 8-shard run, every shard exited 3 with roughly 90% of the suite
 * listed as missing, and produced 8 partial reports with no combined view.
 *
 * The fix is not to merge eight reports; it is to not produce them. Shards
 * capture (the reporter does this automatically when Playwright reports a
 * sharded run), CI collects the capture directories, this command unions them,
 * and `testivai report` compares once against the full set.
 *
 * Accepts either shape, because `actions/download-artifact` produces the
 * first and a manual copy tends to produce the second:
 *
 *   collected/temp-shard-1/<snapshot>/screenshot.png   ← parent of artifacts
 *   collected/<snapshot>/screenshot.png                ← a temp dir itself
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { MERGE_RECORD, type MergeRecord } from '../capture/shard';

/** A directory is a capture if it holds the file every capture must have. */
function isCaptureDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'screenshot.png'));
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Written by the reporter into each shard's capture dir at end of run. */
export interface ShardManifest {
  shard: { current: number; total: number };
  captures?: string[];
  /** False when a shard wrote captures but never reached end of run. */
  complete?: boolean;
  status?: string;
}

export interface MergeResult {
  merged: string[];
  /** Snapshot names supplied by more than one source directory. */
  conflicts: string[];
  /** Inputs that contained no captures at all. */
  empty: string[];
  /** Shard indices that reported, ascending. Empty when nothing was sharded. */
  shardsSeen: number[];
  /** Shard total the manifests agree on, if any reported. */
  shardTotal: number | null;
  /** Expected-but-absent shard indices — a crashed or lost node. */
  shardsMissing: number[];
  /** Shards that captured but never signalled end of run. */
  shardsIncomplete: number[];
}

const MANIFEST = 'testivai-shard.json';

function readManifest(dir: string): ShardManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf-8'));
    const cur = raw?.shard?.current;
    const tot = raw?.shard?.total;
    if (typeof cur !== 'number' || typeof tot !== 'number') return null;
    return raw as ShardManifest;
  } catch {
    return null;
  }
}

/**
 * Collect capture directories from `sources` into `destTemp`.
 *
 * A shard that ran zero tests legitimately produces nothing, so an empty input
 * is reported rather than treated as an error. A snapshot arriving from two
 * sources IS suspicious — shards should partition the suite — so it is
 * surfaced; last write wins.
 */
export function mergeCaptures(
  sources: string[],
  destTemp: string,
  options: { expect?: number } = {},
): MergeResult {
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
  const empty: string[] = [];
  const manifests: ShardManifest[] = [];

  fs.mkdirSync(destTemp, { recursive: true });

  for (const source of sources) {
    if (!fs.existsSync(source)) {
      empty.push(source);
      continue;
    }

    // Either the source is itself a capture dir's parent, or it is a parent of
    // artifact dirs which are in turn parents of capture dirs. The manifest
    // sits beside the capture dirs, so look for it at whichever level matched.
    let captureDirs = subdirs(source).filter(isCaptureDir);
    if (captureDirs.length > 0) {
      const m = readManifest(source);
      if (m) manifests.push(m);
    } else {
      for (const d of subdirs(source)) {
        const m = readManifest(d);
        if (m) manifests.push(m);
      }
      captureDirs = subdirs(source).flatMap((d) => subdirs(d).filter(isCaptureDir));
    }

    if (captureDirs.length === 0) {
      empty.push(source);
      continue;
    }

    for (const dir of captureDirs) {
      const name = path.basename(dir);
      const prior = seen.get(name);
      if (prior && prior !== dir) conflicts.push(name);
      seen.set(name, dir);
      fs.cpSync(dir, path.join(destTemp, name), { recursive: true });
    }
  }

  const shardsSeen = [...new Set(manifests.map((m) => m.shard.current))].sort((a, b) => a - b);
  // `complete === false` means the adapter had no end-of-run hook, OR the run
  // died partway. Only flag it when some shard proved completion is trackable,
  // otherwise every Selenium/RSpec run would warn about itself.
  const tracksCompletion = manifests.some((m) => m.complete === true);
  const shardsIncomplete = tracksCompletion
    ? [...new Set(manifests.filter((m) => m.complete !== true).map((m) => m.shard.current))].sort(
        (a, b) => a - b,
      )
    : [];
  // A shard that ran zero tests uploads no captures, so completeness cannot be
  // inferred from file counts — the manifests are the only reliable evidence.
  // They also self-describe the total, so --expect is an optional override.
  const declared = manifests.length > 0 ? Math.max(...manifests.map((m) => m.shard.total)) : null;
  const shardTotal = options.expect ?? declared;
  const shardsMissing =
    shardTotal === null
      ? []
      : Array.from({ length: shardTotal }, (_, i) => i + 1).filter((i) => !shardsSeen.includes(i));

  // Say whether the merge is the whole suite, beside the captures (shard.ts).
  const record: MergeRecord = {
    shardTotal,
    shardsSeen,
    shardsMissing,
    merged: seen.size,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(destTemp, MERGE_RECORD), JSON.stringify(record, null, 2));

  return {
    merged: [...seen.keys()].sort(),
    conflicts: [...new Set(conflicts)].sort(),
    empty,
    shardsSeen,
    shardTotal,
    shardsMissing,
    shardsIncomplete,
  };
}

export const mergeCapturesCommand = new Command('merge-captures')
  .description('Union sharded capture directories into .testivai/temp/ before running report')
  .argument('<dirs...>', 'directories holding captures (or parents of downloaded artifacts)')
  .option('--json', 'print a machine-readable result to stdout')
  .option(
    '--expect <n>',
    'number of shards that should have reported; overrides the total the shards declare',
    (v) => parseInt(v, 10),
  )
  .option('--allow-incomplete', 'warn instead of failing when a shard did not report')
  .action((dirs: string[], options: { json?: boolean; expect?: number; allowIncomplete?: boolean }) => {
    const destTemp = path.join(process.cwd(), '.testivai', 'temp');
    const result = mergeCaptures(dirs, destTemp, { expect: options.expect });
    const incomplete = result.shardsMissing.length > 0;

    if (options.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      if (incomplete && !options.allowIncomplete) process.exitCode = 1;
      return;
    }

    console.log();
    console.log(chalk.green(`  ✓ merged ${result.merged.length} capture(s) into .testivai/temp/`));
    for (const name of result.merged) console.log(chalk.gray(`    ${name}`));

    if (result.empty.length > 0) {
      console.log();
      console.log(chalk.gray(`  ${result.empty.length} input(s) held no captures (a shard may have run no tests):`));
      for (const d of result.empty) console.log(chalk.gray(`    ${d}`));
    }

    if (result.conflicts.length > 0) {
      console.log();
      console.log(chalk.yellow('  ⚠ the same snapshot arrived from more than one source:'));
      for (const name of result.conflicts) console.log(chalk.yellow(`    ${name}`));
      console.log(chalk.gray('    Shards should partition the suite — check for an overlapping --shard split.'));
    }

    // Completeness. A missing shard means the comparison that follows would run
    // against partial coverage — which passes silently whenever failOnMissing is
    // off. Better a loud, specific failure here than a quiet gap downstream.
    if (result.shardTotal !== null) {
      console.log();
      if (incomplete) {
        const label = options.allowIncomplete ? chalk.yellow('  ⚠') : chalk.red('  ✗');
        console.log(
          `${label} expected ${result.shardTotal} shard(s), received ${result.shardsSeen.length} ` +
            `(missing: ${result.shardsMissing.join(', ')})`,
        );
        console.log(chalk.gray('    A shard that crashed or was cancelled reports no manifest.'));
        console.log(chalk.gray('    Comparing now would check only part of the suite.'));
        if (!options.allowIncomplete) {
          console.log(chalk.gray('    Re-run the missing shard(s), or pass --allow-incomplete to proceed.'));
          console.log();
          process.exitCode = 1;
          return;
        }
      } else {
        console.log(chalk.green(`  ✓ all ${result.shardTotal} shard(s) reported`));
      }
    }

    console.log();
    console.log(chalk.cyan('  Next: npx testivai report --fail-on-diff'));
    console.log();
  });
