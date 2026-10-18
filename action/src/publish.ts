/**
 * The publish action's two github-script steps (publish/action.yml), bundled
 * as dist/publish.cjs.
 *
 * build: decide from the repository's Pages settings, build the site into
 * $RUNNER_TEMP/testivai-pages/site and record what was published next to it.
 * finish (after actions/deploy-pages): check the site answers and add the
 * report links to the pull requests.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveUpsertMarker } from './comment';
import { octokitApi, type OctokitLike } from './publish/api';
import { buildSite, finishPublish, type Log, type PublishState } from './publish/build';
import { resolveStatusContext } from './status';

interface Core extends Log {
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

export async function build({ github, context, core, env }: { github: OctokitLike; context: Context; core: Core; env: Env }): Promise<void> {
  const runsPerPr = parseRunsPerPr(env.RUNS_PER_PR ?? '3');
  if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is not set: this runs as a GitHub Actions step');
  const root = path.join(env.RUNNER_TEMP, 'testivai-pages');
  const siteDir = path.join(root, 'site');
  const stateFile = path.join(root, 'state.json');

  const result = await buildSite(octokitApi(github, context.repo.owner, context.repo.repo), {
    artifactName: env.ARTIFACT_NAME || 'testivai-visual-report',
    runsPerPr,
    consent: env.PUBLIC_REPORTS,
    siteDir,
    serverUrl: context.serverUrl,
    log: core,
  });
  if (!result.published) {
    core.notice(result.reason);
    core.setOutput('published', 'false');
    return;
  }
  fs.writeFileSync(stateFile, JSON.stringify(result.state));
  core.info(`Built the site: ${result.files} files, ${Math.round(result.bytes / 1024)} KB.`);
  core.setOutput('published', 'true');
  core.setOutput('site-dir', siteDir);
  core.setOutput('state-file', stateFile);
  core.setOutput('page-url', result.state.siteUrl);
}

export async function finish({ github, context, core, env }: { github: OctokitLike; context: Context; core: Core; env: Env }): Promise<void> {
  const comment = parseComment(env.COMMENT ?? 'true');
  if (!env.STATE_FILE) throw new Error('STATE_FILE is not set: the build step did not publish');
  const state = JSON.parse(fs.readFileSync(env.STATE_FILE, 'utf8')) as PublishState;
  await finishPublish(octokitApi(github, context.repo.owner, context.repo.repo), {
    state,
    pageUrl: env.PAGE_URL,
    comment,
    marker: resolveUpsertMarker(resolveStatusContext(env.STATUS_CONTEXT ?? '')),
    log: core,
  });
}
