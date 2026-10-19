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
import { determineStatus, resolveStatusContext } from './status';
import type { ResultsData } from './types';

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

async function run(): Promise<void> {
  try {
    // Read inputs
    const token = core.getInput('github-token', { required: true });
    const reportDir = core.getInput('report-dir', { required: true });
    const failOnDiff = core.getBooleanInput('fail-on-diff');
    // Optional input: workflows pinned to an older action.yml won't have it.
    const failOnMissing = (core.getInput('fail-on-missing') || 'false').toLowerCase() === 'true';
    const uploadArtifact = core.getBooleanInput('upload-artifact');
    const artifactRetentionDays = parseInt(core.getInput('artifact-retention-days'), 10);
    const artifactName = core.getInput('artifact-name') || 'testivai-visual-report';
    const statusContext = resolveStatusContext(core.getInput('status-context'));
    const upsertMarker = resolveUpsertMarker(statusContext);

    core.info(`Reading results from ${reportDir}...`);

    // Read results.json
    const resultsPath = path.join(reportDir, 'results.json');
    if (!fs.existsSync(resultsPath)) {
      core.setFailed(`results.json not found at ${resultsPath}. Did the tests run?`);
      return;
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

    // Upload artifact if enabled (recursive so images/ and pending-baselines/ are included)
    let artifactUrl: string | undefined;
    if (uploadArtifact) {
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
        retentionDays: artifactRetentionDays,
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || '1'),
        log: core,
      });

      core.info(`Uploaded ${files.length} files as artifact '${artifactName}'`);

      // Build a direct ZIP download link for the artifact
      const runId = process.env.GITHUB_RUN_ID;
      const context = github.context;
      if (runId && uploadResult.id) {
        // Direct link triggers artifact ZIP download
        artifactUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${runId}/artifacts/${uploadResult.id}`;
        core.info(`Report link: ${artifactUrl}`);
      } else if (runId) {
        // Fallback: link to the workflow run page (artifact ID unavailable)
        artifactUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${runId}`;
        core.info(`Report link (fallback): ${artifactUrl}`);
      }

      // Expose artifact ID as an output for downstream steps
      if (uploadResult.id) {
        core.setOutput('artifact-id', String(uploadResult.id));
      }
    }

    // Get GitHub context
    const octokit = github.getOctokit(token);
    const context = github.context;

    // Build comment — includes artifact link when available. It is also the
    // job summary (below), for every event.
    // The run marker lets the publish step check the comment is still
    // about this run before adding the published report's links.
    const links = { runKey: runKeyFromEnv(process.env) };
    const commentBody = results.snapshots.length === 0
      ? buildEmptyComment(artifactUrl, upsertMarker, links)
      : buildComment(results, artifactUrl, upsertMarker, links);

    // Only post comment on PRs
    if (context.eventName === 'pull_request' && context.payload.pull_request) {
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
          body: commentBody,
        });
        core.info('Updated existing PR comment');
      } else {
        await octokit.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: commentBody,
        });
        core.info('Created new PR comment');
      }
    } else {
      core.info('Not a PR event, skipping comment');
    }

    // The comment on the run's page, for every event (a push has no comment):
    // a failed write only warns (job-summary.ts).
    await writeJobSummary(core, summaryFromComment(commentBody));

    const status = determineStatus(results, { failOnDiff, failOnMissing });
    const sha = context.payload.pull_request?.head.sha || context.sha;

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
}

run();
