/**
 * The publish step: build the whole site, then, after GitHub deploys it,
 * check it answers and add its links to the pull requests.
 *
 * buildSite starts from an empty folder every time and rebuilds the site from
 * what is true now (plan.ts), downloading and rebuilding one report at a time
 * so a large site never sits in memory. finishPublish runs after
 * actions/deploy-pages, so a comment never links a page that is not live.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PublishApi } from './api';
import { ArchiveRefused, readReportArchive, type ReportArchive } from './archive';
import { commentFor, type PublishedPr } from './comments';
import { decidePublish } from './pages';
import { planSite, type PlannedRun, type PlanPr, type SitePlan } from './plan';
import { buildIndexPages, buildRunReport, type RunOutcome, type SiteFile, type SiteInfo } from './site';

export interface Log {
  info: (message: string) => void;
  notice: (message: string) => void;
  warning: (message: string) => void;
}

const MB = 1024 * 1024;

export const PUBLISH_LIMITS = {
  /** The whole site; GitHub Pages refuses a site over 1 GB. */
  maxSiteBytes: 900 * MB,
  /** One run's report ZIP. */
  maxPrBytes: 150 * MB,
  /** Pages of 100 artifacts read, newest first. */
  maxArtifactPages: 10,
};

export interface BuildOptions {
  artifactName: string;
  runsPerPr: number;
  /** TESTIVAI_PUBLIC_REPORTS, as the workflow passes it. */
  consent?: string;
  siteDir: string;
  /** https://github.com, or the GitHub Enterprise Server address. */
  serverUrl: string;
  limits?: Partial<typeof PUBLISH_LIMITS>;
  /**
   * Pages of your own, built earlier in the job from the default branch:
   * published as they are under <name>/, and linked from the front page.
   */
  include?: { dir: string; name: string };
  log: Log;
}

export interface PublishState {
  siteUrl: string;
  visibility: 'public' | 'private';
  /** Each open pull request's latest published run. */
  prs: PublishedPr[];
}

export type BuildResult =
  | { published: false; reason: string }
  | { published: true; reason: string; state: PublishState; files: number; bytes: number };

/** root/rel, for a path made only of letters, digits, '-' and '_' segments ending in .html or .png. */
export function safeSitePath(root: string, rel: string): string {
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:html|png)$/.test(rel)) throw new Error(`not a site path: ${JSON.stringify(rel)}`);
  return path.join(root, rel);
}

const mb = (bytes: number) => `${Math.round(bytes / MB)} MB`;
const sizeOf = (f: SiteFile) => (typeof f.data === 'string' ? Buffer.byteLength(f.data) : f.data.byteLength);

/** Folder names the reports use. */
const RESERVED = new Set(['pr', 'main']);

/** The include folder's regular files (relative paths) and their total size; symbolic links are skipped. */
function readInclude(include: { dir: string; name: string }, maxBytes: number, log: Log): { files: string[]; bytes: number } {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(include.name) || RESERVED.has(include.name)) {
    throw new Error(`include-name must be a lowercase folder name (letters, digits, '-', '_'), not pr or main; got ${JSON.stringify(include.name)}`);
  }
  if (!fs.existsSync(include.dir) || !fs.lstatSync(include.dir).isDirectory()) throw new Error(`include-dir ${include.dir} is not a folder`);
  const files: string[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(include.dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) log.warning(`include-dir: ${child} is a symbolic link: skipped.`);
      else if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        files.push(child);
        bytes += fs.statSync(path.join(include.dir, child)).size;
      }
    }
  };
  walk('');
  if (bytes > maxBytes) throw new Error(`include-dir ${include.dir} is ${mb(bytes)}, over the site's ${mb(maxBytes)} budget`);
  return { files, bytes };
}

export async function buildSite(api: PublishApi, options: BuildOptions): Promise<BuildResult> {
  const { log } = options;
  const limits = { ...PUBLISH_LIMITS, ...options.limits };
  const include = options.include ? readInclude(options.include, limits.maxSiteBytes, log) : undefined;

  const repo = await api.repo();
  const decision = decidePublish({ pages: await api.pages(), repoVisibility: repo.visibility, publicReportsConsent: options.consent });
  if (!decision.publish || !decision.siteUrl || !decision.visibility) return { published: false, reason: decision.reason };
  log.info(decision.reason);

  const prs = await api.openPrs();
  const { artifacts, truncated } = await api.artifacts(options.artifactName, limits.maxArtifactPages);
  if (truncated) {
    log.warning(`Read the newest ${artifacts.length} artifacts only; a pull request whose last report is older than those is not published.`);
  }

  // The runs worth looking up: per open pull request (its head repository and
  // branch) its newest runs with a report, one more than published in case
  // the newest is still running; the same for the default branch.
  const wanted = new Map<string, { limit: number; runs: Set<number> }>();
  for (const pr of prs) wanted.set(`${pr.headRepoId}:${pr.headRef}`, { limit: options.runsPerPr + 1, runs: new Set() });
  wanted.set(`${repo.id}:${repo.defaultBranch}`, { limit: 2, runs: new Set() });
  const newestFirst = [...artifacts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
  for (const a of newestFirst) {
    if (a.name !== options.artifactName || a.expired) continue;
    const slot = wanted.get(`${a.headRepoId}:${a.headBranch}`);
    if (slot && slot.runs.size < slot.limit) slot.runs.add(a.runId);
  }
  const runIds = [...new Set([...wanted.values()].flatMap((w) => [...w.runs]))];
  const runs = (await mapLimit(runIds, 8, (id) => api.run(id))).filter((r) => r !== undefined);
  const candidate = new Set(runIds);

  const plan = planSite({
    prs,
    runs,
    artifacts: artifacts.filter((a) => candidate.has(a.runId)),
    defaultBranch: repo.defaultBranch,
    repo: repo.fullName,
    limits: { runsPerPr: options.runsPerPr, maxSiteBytes: limits.maxSiteBytes, maxPrBytes: limits.maxPrBytes, artifactName: options.artifactName },
  });
  for (const d of plan.dropped) log.info(`Run ${d.runId}${d.pr ? ` (#${d.pr})` : ''} is not published: ${d.reason}.`);

  fs.rmSync(options.siteDir, { recursive: true, force: true });
  fs.mkdirSync(options.siteDir, { recursive: true });
  const site: SiteInfo = { url: decision.siteUrl, repo: repo.fullName, serverUrl: options.serverUrl, defaultBranch: repo.defaultBranch };
  const artifactUrl = (r: PlannedRun) => `${options.serverUrl}/${repo.fullName}/actions/runs/${r.runId}/artifacts/${r.artifactId}`;

  // The most useful reports first, so a site over its size loses the older runs.
  const order: Array<{ run: PlannedRun; pr?: PlanPr }> = [
    ...(plan.main ? [{ run: plan.main }] : []),
    ...plan.prs.map((p) => ({ run: p.runs[0], pr: p.pr })),
    ...plan.prs.flatMap((p) => p.runs.slice(1).map((run) => ({ run, pr: p.pr }))),
  ];
  const outcomes = new Map<number, RunOutcome>();
  const left = new Set<PlannedRun>();
  let bytes = 0;
  let files = 0;
  if (include && options.include) {
    for (const rel of include.files) {
      const to = path.join(options.siteDir, options.include.name, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(options.include.dir, rel), to);
    }
    bytes += include.bytes;
    files += include.files.length;
    log.info(`Published ${options.include.dir} as ${options.include.name}/: ${include.files.length} files.`);
  }
  for (const { run, pr } of order) {
    const archive = await fetchArchive(api, run);
    const built = buildRunReport({ site, run, ...(pr ? { pr } : {}), artifactUrl: artifactUrl(run), archive });
    const size = built.files.reduce((n, f) => n + sizeOf(f), 0);
    if (bytes + size > limits.maxSiteBytes) {
      left.add(run);
      plan.dropped.push({ runId: run.runId, ...(pr ? { pr: pr.number } : {}), reason: `the site would be over its ${mb(limits.maxSiteBytes)} budget` });
      log.warning(`Run ${run.runId} is not published: the site would be over its ${mb(limits.maxSiteBytes)} budget.`);
      continue;
    }
    writeFiles(options.siteDir, built.files);
    bytes += size;
    files += built.files.length;
    outcomes.set(run.runId, built.outcome);
    log.info(`${built.outcome.url}: ${built.outcome.ok ? 'published' : `could not be shown (${built.outcome.reason})`}`);
  }
  const published: SitePlan = {
    ...plan,
    ...(plan.main && left.has(plan.main) ? { main: undefined } : {}),
    prs: plan.prs.map((p) => ({ pr: p.pr, runs: p.runs.filter((r) => !left.has(r)) })).filter((p) => p.runs.length > 0),
  };

  const index = buildIndexPages({ site, plan: published, outcomes, runsPerPr: options.runsPerPr, ...(options.include ? { include: options.include.name } : {}) });
  writeFiles(options.siteDir, index);
  bytes += index.reduce((n, f) => n + sizeOf(f), 0);
  files += index.length;

  const state: PublishState = {
    siteUrl: decision.siteUrl,
    visibility: decision.visibility,
    prs: published.prs.map(({ pr, runs: [latest] }) => {
      const outcome = outcomes.get(latest.runId) as RunOutcome;
      return {
        pr: pr.number,
        fork: pr.fork,
        runId: latest.runId,
        attempt: latest.attempt,
        headSha: latest.headSha,
        url: outcome.url,
        artifactUrl: artifactUrl(latest),
        outcome: outcome.ok ? { ok: true, summary: outcome.summary, data: outcome.data } : { ok: false, reason: outcome.reason },
      };
    }),
  };
  return { published: true, reason: decision.reason, state, files, bytes };
}

async function fetchArchive(api: PublishApi, run: PlannedRun): Promise<ReportArchive | { refused: string }> {
  let zip: Uint8Array;
  try {
    zip = await api.download(run.artifactId);
  } catch (error) {
    return { refused: `the report could not be downloaded (${error instanceof Error ? error.message : String(error)})` };
  }
  try {
    return readReportArchive(zip);
  } catch (error) {
    if (error instanceof ArchiveRefused) return { refused: error.message };
    throw error;
  }
}

function writeFiles(root: string, files: SiteFile[]): void {
  for (const f of files) {
    const to = safeSitePath(root, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, f.data);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface FinishOptions {
  state: PublishState;
  /** actions/deploy-pages' page_url. */
  pageUrl?: string;
  /** Add the links to the pull requests' comments. */
  comment: boolean;
  /** The reporter's comment marker (resolveUpsertMarker). */
  marker: string;
  fetch?: (url: string) => Promise<{ status: number }>;
  retries?: number;
  delayMs?: number;
  log: Log;
}

export async function finishPublish(api: PublishApi, options: FinishOptions): Promise<{ verified: boolean | 'skipped' }> {
  const { log } = options;
  let { state } = options;

  const deployed = httpsBase(options.pageUrl);
  if (deployed && deployed !== state.siteUrl) {
    log.warning(`GitHub deployed the site at ${deployed}, not ${state.siteUrl} as its settings said before; the comments link ${deployed}.`);
    state = { ...state, siteUrl: deployed, prs: state.prs.map((p) => ({ ...p, url: deployed + p.url.slice(state.siteUrl.length) })) };
  }

  let verified: boolean | 'skipped' = 'skipped';
  if (state.visibility === 'public') {
    const fetchFn = options.fetch ?? ((url: string) => fetch(url, { redirect: 'follow' }));
    const retries = options.retries ?? 6;
    verified = false;
    for (let attempt = 1; attempt <= retries && !verified; attempt++) {
      try {
        verified = (await fetchFn(state.siteUrl)).status === 200;
      } catch {
        verified = false;
      }
      if (!verified && attempt < retries) await new Promise((r) => setTimeout(r, options.delayMs ?? 10_000));
    }
    if (verified) log.info(`The site answers at ${state.siteUrl}.`);
    else log.warning(`The site did not answer at ${state.siteUrl} after ${retries} tries. GitHub reported the deploy as done, so the links are added anyway.`);
  } else {
    log.info('The site is private: it is not opened from here (it needs a GitHub sign-in).');
  }

  if (!options.comment) return { verified };
  for (const published of state.prs) {
    try {
      const action = commentFor(published, await api.comments(published.pr), options.marker);
      if (action.kind === 'create') {
        await api.createComment(published.pr, action.body);
        log.info(`#${published.pr}: posted the report link.`);
      } else if (action.kind === 'update') {
        await api.updateComment(action.id, action.body);
        log.info(`#${published.pr}: added the report links to the TestivAI comment.`);
      } else {
        log.info(`#${published.pr}: comment left as is (${action.why}).`);
      }
    } catch (error) {
      log.warning(
        `#${published.pr}: could not update the comment (${error instanceof Error ? error.message : String(error)}). The workflow needs pull-requests: write for the report links.`,
      );
    }
  }
  return { verified };
}

/** An https address ending in '/', or undefined. */
function httpsBase(value?: string): string | undefined {
  if (!value || /[\s"'<>()`\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    url.hash = '';
    url.search = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return undefined;
  }
}
