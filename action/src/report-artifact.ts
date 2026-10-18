/**
 * The report artifact across re-runs.
 *
 * A re-run uploads the report again under the same name, and artifact IDs are
 * not in upload order (testivai/testivai-site#20: the second attempt's
 * artifact had a lower ID than the first's). actions/download-artifact and
 * the artifact toolkit pick the highest ID among same-named artifacts, so a
 * step that downloads the report by name could get an earlier attempt's. So:
 *
 * - on a re-run, the reporter deletes the earlier attempts' report before it
 *   uploads, leaving one report of that name in the run;
 * - it writes the run and attempt next to results.json (testivai-run.json),
 *   so a step that reads the report can tell when it got an earlier attempt's
 *   (the review action then skips instead of triaging a stale report).
 */
import * as fs from 'fs';
import * as path from 'path';

/** Written next to results.json in the uploaded report. */
export const RUN_STAMP_FILE = 'testivai-run.json';

/** The run that uploaded a report. */
export interface RunStamp {
  runId: string;
  runAttempt: number;
  sha?: string;
}

type Env = Record<string, string | undefined>;

/** The subset of @actions/artifact's client this module uses. */
export interface ReportArtifactClient {
  deleteArtifact(name: string): Promise<{ id: number }>;
  uploadArtifact(name: string, files: string[], rootDir: string, options: { retentionDays?: number }): Promise<{ id?: number; size?: number }>;
}

interface Log {
  info(message: string): void;
  warning(message: string): void;
}

/** Enough for any run: each re-run leaves at most one earlier report behind. */
const MAX_EARLIER_REPORTS = 20;

const isNotFound = (err: unknown): boolean => err instanceof Error && err.name === 'ArtifactNotFoundError';

/**
 * Upload the report. On a re-run (attempt 2 or later), first delete every
 * earlier attempt's artifact of the same name, so a download by name finds
 * this attempt's. A failed delete warns and the upload goes ahead. On the
 * first attempt nothing is deleted: there is no earlier report, and a
 * same-named artifact would belong to another job of this run.
 */
export async function uploadReport({
  client,
  name,
  files,
  rootDir,
  retentionDays,
  runAttempt,
  log,
}: {
  client: ReportArtifactClient;
  name: string;
  files: string[];
  rootDir: string;
  retentionDays?: number;
  runAttempt: number;
  log: Log;
}): Promise<{ id?: number; size?: number }> {
  if (runAttempt > 1) {
    for (let i = 0; i < MAX_EARLIER_REPORTS; i++) {
      try {
        const { id } = await client.deleteArtifact(name);
        log.info(`Deleted artifact '${name}' (ID ${id}) from an earlier attempt of this run, so a download by name gets this attempt's report.`);
      } catch (err) {
        if (!isNotFound(err)) {
          const reason = err instanceof Error ? err.message : String(err);
          log.warning(
            `Could not delete artifact '${name}' from an earlier attempt of this run (${reason}). A step that downloads '${name}' by name may get the earlier attempt's report; the review action skips a report it can tell is stale.`,
          );
        }
        break;
      }
    }
  }
  return client.uploadArtifact(name, files, rootDir, { retentionDays });
}

/** Write testivai-run.json into the report directory; null outside GitHub Actions. */
export function writeRunStamp(reportDir: string, env: Env): string | null {
  const runId = env.GITHUB_RUN_ID;
  if (!runId) return null;
  const stamp: RunStamp = { runId, runAttempt: Number(env.GITHUB_RUN_ATTEMPT || '1'), ...(env.GITHUB_SHA ? { sha: env.GITHUB_SHA } : {}) };
  const file = path.join(reportDir, RUN_STAMP_FILE);
  fs.writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`);
  return file;
}

/** The report's stamp, or null when it has none or it cannot be read. */
export function readRunStamp(reportDir: string): RunStamp | null {
  try {
    return parseRunStamp(fs.readFileSync(path.join(reportDir, RUN_STAMP_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** A stamp from its JSON text; null for anything that is not one. */
export function parseRunStamp(text: string): RunStamp | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { runId, runAttempt, sha } = raw as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof runAttempt !== 'number' || !Number.isInteger(runAttempt) || runAttempt < 1) return null;
  return { runId, runAttempt, ...(typeof sha === 'string' ? { sha } : {}) };
}

/**
 * When the report came from an earlier attempt of the run reading it: the
 * two attempts; otherwise null (this attempt, another run, or no stamp).
 */
export function staleReport(stamp: RunStamp | null, env: Env): { reportAttempt: number; thisAttempt: number } | null {
  if (!stamp || !env.GITHUB_RUN_ID || stamp.runId !== env.GITHUB_RUN_ID) return null;
  const thisAttempt = Number(env.GITHUB_RUN_ATTEMPT || '1');
  return stamp.runAttempt < thisAttempt ? { reportAttempt: stamp.runAttempt, thisAttempt } : null;
}
