/**
 * Shard participation — the framework-agnostic half of parallel runs.
 *
 * Playwright can tell its reporter `--shard=i/N`; pytest, JUnit, RSpec and a
 * bare Selenium script cannot. So the mechanism is environment, not framework
 * API, and every adapter honours the same two variables:
 *
 *   TESTIVAI_CAPTURE_ONLY=1   capture, do not compare or write a report
 *   TESTIVAI_SHARD=3/8        this process is shard 3 of 8
 *
 * A framework that happens to know its own shard (Playwright) may fill these in
 * itself, but the env var is the contract — that is what keeps a Selenium or
 * pytest suite a first-class citizen of the same sharded CI flow.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ShardInfo {
  current: number;
  total: number;
}

export const SHARD_MANIFEST = 'testivai-shard.json';

/**
 * Written by `merge-captures` beside the captures it merged: whether every
 * shard reported. When one did not, the merge fails and the comparison after
 * it does not run; the GitHub Action, which runs after a failure too, reads
 * this so it never compares part of the suite as if it were the whole.
 */
export const MERGE_RECORD = 'testivai-merge.json';

export interface MergeRecord {
  /** The shard total the manifests declare (or --expect); null for an unsharded merge. */
  shardTotal: number | null;
  shardsSeen: number[];
  /** Shards that never reported: the merged captures are part of the suite. */
  shardsMissing: number[];
  /** How many captures were merged. */
  merged: number;
  timestamp: string;
}

/** Parse `TESTIVAI_SHARD` in either `3/8` or `3of8` form. Invalid → null. */
export function parseShardEnv(value: string | undefined): ShardInfo | null {
  if (!value) return null;
  const m = /^\s*(\d+)\s*(?:\/|of)\s*(\d+)\s*$/i.exec(value);
  if (!m) return null;
  const current = parseInt(m[1], 10);
  const total = parseInt(m[2], 10);
  if (!Number.isFinite(current) || !Number.isFinite(total)) return null;
  if (total < 1 || current < 1 || current > total) return null;
  return { current, total };
}

/**
 * Capture-only resolution shared by every JS adapter.
 * An explicit argument wins; then the env var; then "are we a shard of many".
 */
export function resolveCaptureOnly(
  explicit: boolean | undefined,
  shard: ShardInfo | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const raw = env.TESTIVAI_CAPTURE_ONLY;
  if (raw !== undefined && raw !== '') return raw !== '0' && raw.toLowerCase() !== 'false';
  return !!(shard && shard.total > 1);
}

export interface ShardManifest {
  shard: ShardInfo;
  captures: string[];
  /**
   * True once the run finished. Adapters with a run-end hook (Playwright,
   * pytest, JUnit) set it; adapters without one (a bare Selenium script, RSpec)
   * write the manifest per capture and leave it false. `merge-captures` uses it
   * to tell "this shard finished" from "this shard started and vanished".
   */
  complete: boolean;
  status?: string;
  timestamp: string;
}

/**
 * Write (or refresh) the manifest for this shard.
 *
 * Safe to call on every capture: it rewrites the file with the captures present
 * so far, which is what makes it usable by adapters that have no end-of-run
 * hook to attach to.
 */
export function writeShardManifest(
  tempRoot: string,
  shard: ShardInfo,
  options: { complete?: boolean; status?: string } = {},
): void {
  try {
    fs.mkdirSync(tempRoot, { recursive: true });
    const captures = fs
      .readdirSync(tempRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const manifest: ShardManifest = {
      shard,
      captures,
      complete: options.complete ?? false,
      status: options.status,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tempRoot, SHARD_MANIFEST), JSON.stringify(manifest, null, 2));
  } catch {
    // A manifest we cannot write must never fail a capture. The merge step
    // degrades to "no completeness check" and says so.
  }
}
