/**
 * The publish action's two github-script steps (publish/action.yml), bundled
 * as dist/publish.cjs.
 *
 * build: decide from the repository's Pages settings, build the site into
 * $RUNNER_TEMP/testivai-pages/site and record what was published next to it;
 * report ZIPs are kept in $RUNNER_TEMP/testivai-pages/cache (cache-save: the
 * cache changed, so the action saves it).
 * finish (after actions/deploy-pages): check the site answers and add the
 * report links to the pull requests.
 * The job summary (publish/summary.ts) says what was published, from finish,
 * or why nothing was, from build.
 *
 * With site-dir, the site is published at the root and the reports under
 * reports-path; published says the site was deployed, reports-published
 * whether the reports are on it, and page-url is the reports' address (the
 * site's when it was deployed without them).
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveUpsertMarker } from './comment';
import { type SummaryCore, writeJobSummary } from './job-summary';
import { octokitApi, type OctokitLike } from './publish/api';
import { buildSite, finishPublish, reportsAddress, type Log, type PublishState } from './publish/build';
import { publishSummary } from './publish/summary';
import { resolveStatusContext } from './status';

interface Core extends Log, SummaryCore {
  setOutput: (name: string, value: string) => void;
}

interface Context {
  repo: { owner: string; repo: string };
  serverUrl: string;
}

type Env = Record<string, string | undefined>;

export function parseRunsPerPr(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n < 1 || n > 10) throw new Error(`runs-per-pr must be a whole number from 1 to 10, not ${JSON.stringify(value)}`);
  return n;
}

export function parseComment(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`comment must be true or false, not ${JSON.stringify(value)}`);
}

export function parseCache(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`cache must be true or false, not ${JSON.stringify(value)}`);
}

/** include-dir (relative to the workspace) and include-name, or undefined without include-dir. */
export function parseInclude(env: Env): { dir: string; name: string } | undefined {
  const dir = (env.INCLUDE_DIR ?? '').trim();
  if (!dir) return undefined;
  const name = (env.INCLUDE_NAME ?? '').trim();
  if (!name) throw new Error('include-name is required with include-dir: the folder the pages go in on the site, such as demo');
  return { dir: path.resolve(env.GITHUB_WORKSPACE || process.cwd(), dir), name };
}

/**
 * site-dir (relative to the workspace) and reports-path (a '/' at either end
 * taken off), or undefined without either. Each needs the other.
 */
export function parseSite(env: Env): { dir: string; reportsPath: string } | undefined {
  const dir = (env.SITE_DIR ?? '').trim();
  const reportsPath = (env.REPORTS_PATH ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!dir && !reportsPath) return undefined;
  if (!dir) throw new Error('reports-path needs site-dir: the reports go under a path of a site of your own, published at the root');
  if (!reportsPath) throw new Error('reports-path is required with site-dir: the folder the reports go in on the site, such as visual-reports');
  return { dir: path.resolve(env.GITHUB_WORKSPACE || process.cwd(), dir), reportsPath };
}

export async function build({ github, context, core, env }: { github: OctokitLike; context: Context; core: Core; env: Env }): Promise<void> {
  const runsPerPr = parseRunsPerPr(env.RUNS_PER_PR ?? '3');
  if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is not set: this runs as a GitHub Actions step');
  const root = path.join(env.RUNNER_TEMP, 'testivai-pages');
  const siteDir = path.join(root, 'site');
  const stateFile = path.join(root, 'state.json');

  const include = parseInclude(env);
  const site = parseSite(env);
  // The folder publish/action.yml restores and saves with actions/cache.
  const cacheDir = parseCache(env.CACHE ?? 'false') ? env.CACHE_DIR?.trim() || path.join(root, 'cache') : undefined;

  const result = await buildSite(octokitApi(github, context.repo.owner, context.repo.repo), {
    artifactName: env.ARTIFACT_NAME || 'testivai-visual-report',
    runsPerPr,
    consent: env.PUBLIC_REPORTS,
    siteDir,
    serverUrl: context.serverUrl,
    ...(include ? { include } : {}),
    ...(site ? { site } : {}),
    ...(cacheDir ? { cacheDir } : {}),
    log: core,
  });
  if (!result.published) {
    core.notice(result.reason);
    core.setOutput('published', 'false');
    core.setOutput('reports-published', 'false');
    core.setOutput('cache-save', 'false');
    // The reason on the run page too: the steps after this one do not run.
    await writeJobSummary(core, publishSummary({ published: false, reason: result.reason }));
    return;
  }
  // A site of your own deployed without its reports: why, next to the other notices.
  if (!result.reports) core.notice(`The site is deployed without the reports: ${result.reason}`);
  core.setOutput('cache-save', result.downloads.cacheChanged ? 'true' : 'false');
  fs.writeFileSync(stateFile, JSON.stringify(result.state));
  core.info(`Built the site: ${result.files} files, ${Math.round(result.bytes / 1024)} KB.`);
  core.setOutput('published', 'true');
  core.setOutput('reports-published', result.reports ? 'true' : 'false');
  core.setOutput('site-dir', siteDir);
  core.setOutput('state-file', stateFile);
  core.setOutput('page-url', result.reports ? reportsAddress(result.state) : result.state.siteUrl);
}

export async function finish({ github, context, core, env }: { github: OctokitLike; context: Context; core: Core; env: Env }): Promise<void> {
  const comment = parseComment(env.COMMENT ?? 'true');
  if (!env.STATE_FILE) throw new Error('STATE_FILE is not set: the build step did not publish');
  const state = JSON.parse(fs.readFileSync(env.STATE_FILE, 'utf8')) as PublishState;
  const { siteUrl, reportsUrl } = await finishPublish(octokitApi(github, context.repo.owner, context.repo.repo), {
    state,
    pageUrl: env.PAGE_URL,
    comment,
    marker: resolveUpsertMarker(resolveStatusContext(env.STATUS_CONTEXT ?? '')),
    log: core,
  });
  core.setOutput('page-url', reportsUrl ?? siteUrl);
  // What was published, at the address the comments link, once it is live.
  await writeJobSummary(
    core,
    state.reportsSkipped !== undefined || !reportsUrl
      ? publishSummary({ published: true, siteUrl, reportsSkipped: state.reportsSkipped ?? '' })
      : publishSummary({ published: true, siteUrl: reportsUrl, ...(state.site ? { site: state.site } : {}) }),
  );
}
