/**
 * Main entry point for TestivAI GitHub Action
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import * as artifact from '@actions/artifact';
import { uploadReport, writeRunStamp } from './report-artifact';
import * as fs from 'fs';
import * as path from 'path';
import { buildComment, buildEmptyComment, resolveUpsertMarker, runKeyFromEnv } from './comment';
import { summaryFromComment, writeJobSummary } from './job-summary';
import { determineStatus, resolveStatusContext, type VisualStatus } from './status';
import {
  buildNoReportComment,
  cannotCompare,
  compareCaptures,
  comparedByActionNotice,
  findCaptures,
  noReportFailure,
  noReportStatus,
  type NoReportReason,
} from './missing-report';
import type { ResultsData } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Recursively collect all file paths under a directory.
 * Used so the artifact upload includes visual-report/images/ subdirectories.
 */
function collectFilesRecursively(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? collectFilesRecursively(fullPath) : [fullPath];
  });
}

/**
 * Upload the report directory as the artifact; resolves to the link the
 * comment gives for it (undefined outside a workflow run). Throws when the
 * upload fails.
 */
async function uploadReportArtifact(reportDir: string, artifactName: string, retentionDays: number): Promise<string | undefined> {
  const artifactClient = new artifact.DefaultArtifactClient();
  // Stamp the run and attempt next to results.json, so a step reading the
  // report can tell an earlier attempt's (report-artifact.ts).
  writeRunStamp(reportDir, process.env);
  const files = collectFilesRecursively(reportDir);

  // On a re-run, replaces the earlier attempts' report of the same name.
  const uploadResult = await uploadReport({
    client: artifactClient,
    name: artifactName,
    files,
    rootDir: reportDir,
    retentionDays,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || '1'),
    log: core,
  });

  core.info(`Uploaded ${files.length} files as artifact '${artifactName}'`);

  // Expose artifact ID as an output for downstream steps
  if (uploadResult.id) {
    core.setOutput('artifact-id', String(uploadResult.id));
  }

  // Build a direct ZIP download link for the artifact
  const runId = process.env.GITHUB_RUN_ID;
  const context = github.context;
  if (runId && uploadResult.id) {
    // Direct link triggers artifact ZIP download
    const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${runId}/artifacts/${uploadResult.id}`;
    core.info(`Report link: ${url}`);
    return url;
  }
  if (runId) {
    // Fallback: link to the workflow run page (artifact ID unavailable)
    const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${runId}`;
    core.info(`Report link (fallback): ${url}`);
    return url;
  }
  return undefined;
}

/**
 * Post the comment on a pull request, updating this lane's earlier one (a
 * push has no comment).
 */
async function upsertComment(octokit: Octokit, upsertMarker: string, body: string): Promise<void> {
  const context = github.context;
  if (!(context.eventName === 'pull_request' && context.payload.pull_request)) {
    core.info('Not a PR event, skipping comment');
    return;
  }
  const prNumber = context.payload.pull_request.number;

  const { data: comments } = await octokit.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: prNumber,
  });

  // Look for this lane's existing comment to upsert
  const existingComment = comments.find(c =>
    c.body?.includes(upsertMarker)
  );

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existingComment.id,
      body,
    });
    core.info('Updated existing PR comment');
  } else {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      body,
    });
    core.info('Created new PR comment');
  }
}

/** The commit the run is about: the pull request's head, or the pushed commit. */
function headSha(): string {
  const context = github.context;
  return context.payload.pull_request?.head.sha || context.sha;
}

/** Post the check run and the commit status for this commit. */
async function postStatus(octokit: Octokit, statusContext: string, status: VisualStatus): Promise<void> {
  const context = github.context;
  const sha = headSha();

  // A check run carries `neutral`, which a commit status cannot express — so
  // a run that needs review stops reporting green. GitHub treats neutral as
  // satisfying a required check, so this is visible without blocking.
  //
  // Needs `checks: write`. Existing workflows won't have it, so a failure
  // here must never break the job: we warn, and the commit status below still
  // carries the result.
  let checkRunPosted = false;
  try {
    await octokit.rest.checks.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      name: statusContext,
      head_sha: sha,
      status: 'completed',
      conclusion: status.conclusion,
      output: { title: status.title, summary: status.summary },
    });
    checkRunPosted = true;
    core.info(`Check run: ${status.conclusion} - ${status.title}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    core.warning(
      `Could not create a check run (${reason}). Add \`checks: write\` to the workflow's ` +
        'permissions for a non-blocking "neutral" result; falling back to the commit status.',
    );
  }

  // Commit status stays for now: it is what existing branch-protection rules
  // reference, and it works without `checks: write`. It has no `neutral`, so
  // a review-needed run maps to `success` here — the check run is the honest
  // signal when both are present.
  try {
    await octokit.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha,
      state: status.state,
      context: statusContext,
      description: status.description,
    });
    core.info(`Commit status: ${status.state} - ${status.description}`);
  } catch (err) {
    if (!checkRunPosted) throw err;
    core.warning(`Could not set the commit status: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The run has no visual report: say so in the job summary, the comment, the
 * check run and the commit status (replacing an earlier run's), and fail the
 * step (missing-report.ts).
 */
async function reportNoVisualReport(
  octokit: Octokit,
  reason: NoReportReason,
  resultsPath: string,
  statusContext: string,
  upsertMarker: string,
): Promise<void> {
  const body = buildNoReportComment(reason, {
    resultsPath,
    sha: headSha(),
    marker: upsertMarker,
    runKey: runKeyFromEnv(process.env),
  });
  await writeJobSummary(core, summaryFromComment(body));
  await upsertComment(octokit, upsertMarker, body);
  await postStatus(octokit, statusContext, noReportStatus(reason, resultsPath));
  core.setFailed(noReportFailure(reason, resultsPath));
}

async function run(): Promise<void> {
  // Why the report artifact could not be uploaded, when it could not. The
  // step fails for it last, whatever else happened.
  let uploadError: string | undefined;
  let artifactName = 'testivai-visual-report';
  try {
    // Read inputs
    const token = core.getInput('github-token', { required: true });
    const reportDir = core.getInput('report-dir', { required: true });
    const failOnDiff = core.getBooleanInput('fail-on-diff');
    // Optional input: workflows pinned to an older action.yml won't have it.
    const failOnMissing = (core.getInput('fail-on-missing') || 'false').toLowerCase() === 'true';
    const uploadArtifact = core.getBooleanInput('upload-artifact');
    const artifactRetentionDays = parseInt(core.getInput('artifact-retention-days'), 10);
    artifactName = core.getInput('artifact-name') || artifactName;
    const statusContext = resolveStatusContext(core.getInput('status-context'));
    const upsertMarker = resolveUpsertMarker(statusContext);

    core.info(`Reading results from ${reportDir}...`);

    const octokit = github.getOctokit(token);

    // Read results.json. Without one, the compare step did not run (a CI
    // step runs only on success by default, so a failing test skips it):
    // compare the captures the tests left, or say there is no visual report
    // for this run, so the pull request never keeps showing an earlier
    // run's result (missing-report.ts).
    const resultsPath = path.join(reportDir, 'results.json');
    let notice: string | undefined;
    if (!fs.existsSync(resultsPath)) {
      const found = findCaptures(path.join(process.cwd(), '.testivai', 'temp'));
      let reason = cannotCompare(found);
      if (!reason) {
        core.info(`${resultsPath} not found; comparing the ${found.names.length} capture(s) in .testivai/temp/ against the baselines.`);
        try {
          compareCaptures(process.cwd(), reportDir);
        } catch (err) {
          reason = { kind: 'compare-failed', captures: found.names.length, error: err instanceof Error ? err.message : String(err) };
        }
      }
      if (reason) {
        await reportNoVisualReport(octokit, reason, resultsPath, statusContext, upsertMarker);
        return;
      }
      notice = comparedByActionNotice(found.names.length);
    }

    const results: ResultsData = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

    // Bundle pending baselines into the report dir so the approve action can
    // access them when a developer posts /testivai approve on the PR.
    // .testivai/temp/<name>/ is generated during the test run and is not
    // committed to the repo; copying it here makes it available in the artifact.
    const tempDir = path.join(process.cwd(), '.testivai', 'temp');
    if (fs.existsSync(tempDir)) {
      const pendingDir = path.join(reportDir, 'pending-baselines');
      fs.mkdirSync(pendingDir, { recursive: true });
      let copied = 0;
      for (const name of fs.readdirSync(tempDir)) {
        const src = path.join(tempDir, name);
        const dst = path.join(pendingDir, name);
        if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, dst, { recursive: true });
          copied++;
        }
      }
      if (copied > 0) core.info(`Bundled ${copied} pending baseline(s) for approval`);
    }

    // Upload artifact if enabled (recursive so images/ and pending-baselines/ are included).
    // A failed upload (an artifact storage quota, a service outage) must not
    // hide the visual result: the comment and the status still go out, from
    // results.json, saying the report could not be uploaded, and the step
    // fails for it after that (below).
    let artifactUrl: string | undefined;
    if (uploadArtifact) {
      try {
        artifactUrl = await uploadReportArtifact(reportDir, artifactName, artifactRetentionDays);
      } catch (err) {
        uploadError = err instanceof Error ? err.message : String(err);
        core.info(`Could not upload the visual report artifact '${artifactName}' (${uploadError}); posting the results without it.`);
      }
    }

    // Build comment — includes artifact link when available. It is also the
    // job summary, for every event.
    // The run marker lets the publish step check the comment is still
    // about this run before adding the published report's links.
    const links = { runKey: runKeyFromEnv(process.env) };
    const commentBody = results.snapshots.length === 0
      ? buildEmptyComment(artifactUrl, upsertMarker, links, uploadError, notice)
      : buildComment(results, artifactUrl, upsertMarker, links, uploadError, notice);

    // The comment on the run's page, for every event (a push has no comment).
    // Written before the comment is posted: a token that cannot comment (a
    // fork's pull request, no `pull-requests: write`, a rate limit) fails the
    // job below, and the summary is then where the result shows. A failed
    // write only warns (job-summary.ts).
    await writeJobSummary(core, summaryFromComment(commentBody));

    await upsertComment(octokit, upsertMarker, commentBody);

    const status = determineStatus(results, { failOnDiff, failOnMissing });
    await postStatus(octokit, statusContext, status);

    // Only a genuine failure conclusion fails the job. Everything else is
    // reported and left to the reviewer — the point of this action is to be
    // informative, not a gate.
    if (status.conclusion === 'failure') {
      core.setFailed(status.description);
    } else if (status.conclusion === 'neutral') {
      core.warning(`${status.title} — not blocking; see the report artifact.`);
    } else {
      core.info(status.title);
    }

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred');
    }
  }

  if (uploadError !== undefined) {
    core.setFailed(
      `Could not upload the visual report artifact '${artifactName}', which /testivai approve needs; ` +
        `re-run the job once the upload can succeed. Error: ${uploadError}`,
    );
  }
}

run();
