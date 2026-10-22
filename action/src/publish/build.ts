/**
 * The publish step: build the whole site, then, after GitHub deploys it,
 * check it answers and add its links to the pull requests.
 *
 * buildSite starts from an empty folder every time and rebuilds the site from
 * what is true now (plan.ts), downloading and rebuilding one report at a time
 * so a large site never sits in memory; a report an earlier publish
 * downloaded comes from the report cache instead (cache.ts), and its page is
 * rebuilt all the same. finishPublish runs after
 * actions/deploy-pages, so a comment never links a page that is not live.
 *
 * With a site of your own (site-dir), that site is copied as it is to the
 * root, and everything TestivAI makes goes under reports-path: site.url (the
 * base of every report link) is the site's address plus reports-path. No site
 * file is ever written over: a site that already has reports-path is refused
 * before anything is read from GitHub, and every file is created only if it
 * does not exist. Where the settings refuse the reports but allow a deploy
 * (canDeploySite), the site is deployed alone, and no report is downloaded.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PublishApi } from './api';
import { ArchiveRefused, readReportArchive, type ReportArchive } from './archive';
import { openReportCache, type ReportCache } from './cache';
import { commentFor, type PublishedPr } from './comments';
import { canDeploySite, decidePublish, pagesAddress, siteAddress, type PagesInfo } from './pages';
import { planSite, type PlannedRun, type PlanPr, type SitePlan } from './plan';
import { buildIndexPages, buildRunReport, type RunOutcome, type SiteFile, type SiteInfo } from './site';
import { publishedSite, type PublishedSite } from './summary';

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
  /**
   * A site of your own, already built from the default branch: published as
   * it is at the root, with the reports under reportsPath (one to four
   * lowercase folder names joined by '/'), which the site must not have.
   * Not with include.
   */
  site?: { dir: string; reportsPath: string };
  /**
   * A folder of report ZIPs kept between publishes (cache.ts; publish/action.yml
   * restores and saves it with actions/cache): a report found there, with the
   * SHA-256 GitHub lists for its artifact, is not downloaded again. Without
   * it, every report is downloaded.
   */
  cacheDir?: string;
  log: Log;
}

/** Where this build's reports came from. */
export interface DownloadStats {
  downloaded: number;
  downloadedBytes: number;
  fromCache: number;
  /** The cache gained or lost an entry, so it is worth saving. */
  cacheChanged: boolean;
}

export interface PublishState {
  /** The site's address (its root), ending in '/'. */
  siteUrl: string;
  /** With a site of your own: the folder the reports are in, under siteUrl. */
  reportsPath?: string;
  /** With a site of your own deployed without its reports: why they were not published. */
  reportsSkipped?: string;
  visibility: 'public' | 'private';
  /** Each open pull request's latest published run. */
  prs: PublishedPr[];
  /** What the site holds, for the job summary (summary.ts). */
  site?: PublishedSite;
}

/** published: a site was built to deploy; reports: it holds the reports (false only for a site of your own deployed without them). */
export type BuildResult =
  | { published: false; reason: string }
  | { published: true; reports: boolean; reason: string; state: PublishState; files: number; bytes: number; downloads: DownloadStats };

/** The address the reports are at: the site's, plus reports-path with a site of your own. */
export function reportsAddress(state: Pick<PublishState, 'siteUrl' | 'reportsPath'>): string {
  return state.reportsPath ? `${state.siteUrl}${state.reportsPath}/` : state.siteUrl;
}

/** root/rel, for a path made only of letters, digits, '-' and '_' segments ending in .html or .png. */
export function safeSitePath(root: string, rel: string): string {
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:html|png)$/.test(rel)) throw new Error(`not a site path: ${JSON.stringify(rel)}`);
  return path.join(root, rel);
}

const mb = (bytes: number) => `${Math.round(bytes / MB)} MB`;
const mb1 = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;
const sizeOf = (f: SiteFile) => (typeof f.data === 'string' ? Buffer.byteLength(f.data) : f.data.byteLength);

/** Folder names the reports use. */
const RESERVED = new Set(['pr', 'main']);

/** A folder's regular files (relative paths) and their total size; symbolic links are skipped. */
function readFolder(dir: string, label: string, maxBytes: number, log: Log): { files: string[]; bytes: number } {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) throw new Error(`${label} ${dir} is not a folder`);
  const files: string[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) log.warning(`${label}: ${child} is a symbolic link: skipped.`);
      else if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        files.push(child);
        bytes += fs.statSync(path.join(dir, child)).size;
      }
    }
  };
  walk('');
  if (bytes > maxBytes) throw new Error(`${label} ${dir} is ${mb(bytes)}, over the site's ${mb(maxBytes)} budget`);
  return { files, bytes };
}

function readInclude(include: { dir: string; name: string }, maxBytes: number, log: Log): { files: string[]; bytes: number } {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(include.name) || RESERVED.has(include.name)) {
    throw new Error(`include-name must be a lowercase folder name (letters, digits, '-', '_'), not pr or main; got ${JSON.stringify(include.name)}`);
  }
  return readFolder(include.dir, 'include-dir', maxBytes, log);
}

const FOLDER = '[a-z0-9][a-z0-9_-]{0,39}';
const REPORTS_PATH = new RegExp(`^${FOLDER}(?:/${FOLDER}){0,3}$`);

/** The site's files, once reports-path is known to be free in it. */
function readOwnSite(site: { dir: string; reportsPath: string }, maxBytes: number, log: Log): { files: string[]; bytes: number } {
  if (!REPORTS_PATH.test(site.reportsPath)) {
    throw new Error(
      `reports-path must be one to four lowercase folder names (letters, digits, '-', '_') joined by '/', such as visual-reports; got ${JSON.stringify(site.reportsPath)}`,
    );
  }
  if (!fs.existsSync(site.dir) || !fs.lstatSync(site.dir).isDirectory()) throw new Error(`site-dir ${site.dir} is not a folder`);
  // Never write over a site file: reports-path, and every folder on the way to it, must be free or a folder.
  const parts = site.reportsPath.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join('/');
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(site.dir, rel));
    } catch {
      break;
    }
    if (i === parts.length || !stat.isDirectory()) {
      throw new Error(
        `site-dir ${site.dir} already has ${rel}${i === parts.length ? '' : `, which is not a folder`}: reports-path ${site.reportsPath} must be a path the site does not use, so that no site file is written over. Choose another reports-path, or take ${rel} out of the site.`,
      );
    }
  }
  return readFolder(site.dir, 'site-dir', maxBytes, log);
}

/** Copies files (relative paths) from one folder to another, never over an existing file. */
export function copyFiles(from: string, to: string, files: string[]): void {
  for (const rel of files) {
    const target = path.join(to, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, rel), target, fs.constants.COPYFILE_EXCL);
  }
}

export async function buildSite(api: PublishApi, options: BuildOptions): Promise<BuildResult> {
  const { log } = options;
  const limits = { ...PUBLISH_LIMITS, ...options.limits };
  if (options.site && options.include) {
    throw new Error('include-dir cannot be used with site-dir: put those pages in the site, which is published as it is');
  }
  const include = options.include ? readInclude(options.include, limits.maxSiteBytes, log) : undefined;
  const own = options.site ? readOwnSite(options.site, limits.maxSiteBytes, log) : undefined;

  const repo = await api.repo();
  const pages = await api.pages();
  const decision = decidePublish({ pages, repoVisibility: repo.visibility, publicReportsConsent: options.consent });
  if (!decision.publish || !decision.siteUrl || !decision.visibility) {
    if (!options.site || !own) return { published: false, reason: decision.reason };
    if (!canDeploySite(pages)) {
      const why = pages.found ? ' site-dir is not deployed either: the branch keeps serving the site.' : ' site-dir is not deployed either.';
      return { published: false, reason: `${decision.reason}${why}` };
    }
    return deployOwnSiteAlone(options, own, pages, decision.reason);
  }
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
  const reportsPath = options.site?.reportsPath;
  // Where every file TestivAI makes goes, and the address all its links start from.
  const reportsDir = reportsPath ? path.join(options.siteDir, ...reportsPath.split('/')) : options.siteDir;
  const reportsUrl = reportsAddress({ siteUrl: decision.siteUrl, ...(reportsPath ? { reportsPath } : {}) });
  const site: SiteInfo = { url: reportsUrl, repo: repo.fullName, serverUrl: options.serverUrl, defaultBranch: repo.defaultBranch };
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
  if (own && options.site) {
    copyFiles(options.site.dir, options.siteDir, own.files);
    bytes += own.bytes;
    files += own.files.length;
    log.info(`Published ${options.site.dir} at the site's root: ${own.files.length} files; the reports go under ${options.site.reportsPath}/.`);
  }
  if (include && options.include) {
    copyFiles(options.include.dir, path.join(options.siteDir, options.include.name), include.files);
    bytes += include.bytes;
    files += include.files.length;
    log.info(`Published ${options.include.dir} as ${options.include.name}/: ${include.files.length} files.`);
  }
  const cache = options.cacheDir ? openReportCache(options.cacheDir, { log, maxEntryBytes: limits.maxPrBytes }) : undefined;
  const digests = new Map(artifacts.map((a) => [a.id, a.digest]));
  const downloads = { count: 0, bytes: 0 };
  for (const { run, pr } of order) {
    const archive = await fetchArchive(api, run, { cache, digest: digests.get(run.artifactId), downloads });
    const built = buildRunReport({ site, run, ...(pr ? { pr } : {}), artifactUrl: artifactUrl(run), archive });
    const size = built.files.reduce((n, f) => n + sizeOf(f), 0);
    if (bytes + size > limits.maxSiteBytes) {
      left.add(run);
      plan.dropped.push({ runId: run.runId, ...(pr ? { pr: pr.number } : {}), reason: `the site would be over its ${mb(limits.maxSiteBytes)} budget` });
      log.warning(`Run ${run.runId} is not published: the site would be over its ${mb(limits.maxSiteBytes)} budget.`);
      continue;
    }
    writeFiles(reportsDir, built.files);
    bytes += size;
    files += built.files.length;
    outcomes.set(run.runId, built.outcome);
    log.info(`${built.outcome.url}: ${built.outcome.ok ? 'published' : `could not be shown (${built.outcome.reason})`}`);
  }
  cache?.prune();
  const downloaded = `Reports: ${downloads.count} downloaded (${mb1(downloads.bytes)})`;
  log.info(
    cache
      ? `${downloaded}, ${cache.stats.hits} from the cache (${mb1(cache.stats.hitBytes)}); ${cache.stats.stored} added to the cache, ${cache.stats.removed} removed from it.`
      : `${downloaded}.`,
  );
  const published: SitePlan = {
    ...plan,
    ...(plan.main && left.has(plan.main) ? { main: undefined } : {}),
    prs: plan.prs.map((p) => ({ pr: p.pr, runs: p.runs.filter((r) => !left.has(r)) })).filter((p) => p.runs.length > 0),
  };

  const index = buildIndexPages({
    site,
    plan: published,
    outcomes,
    runsPerPr: options.runsPerPr,
    ...(options.include ? { include: options.include.name } : {}),
    ...(options.site ? { notFoundPage: false } : {}),
  });
  writeFiles(reportsDir, index);
  bytes += index.reduce((n, f) => n + sizeOf(f), 0);
  files += index.length;

  const state: PublishState = {
    siteUrl: decision.siteUrl,
    ...(reportsPath ? { reportsPath } : {}),
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
    site: publishedSite({ site, plan: published, outcomes, runsPerPr: options.runsPerPr, ...(options.include ? { include: options.include.name } : {}) }),
  };
  const stats: DownloadStats = {
    downloaded: downloads.count,
    downloadedBytes: downloads.bytes,
    fromCache: cache?.stats.hits ?? 0,
    cacheChanged: cache !== undefined && cache.stats.stored + cache.stats.removed > 0,
  };
  return { published: true, reports: true, reason: decision.reason, state, files, bytes, downloads: stats };
}

/**
 * A site of your own, deployed without its reports: the settings allow a
 * deploy but not the reports (pages.ts decidePublish says why). Nothing
 * about the reports is read from GitHub, and nothing goes under reports-path,
 * so reports an earlier publish put there are taken down.
 */
function deployOwnSiteAlone(options: BuildOptions, own: { files: string[]; bytes: number }, pages: PagesInfo, reason: string): BuildResult {
  const site = options.site as { dir: string; reportsPath: string };
  fs.rmSync(options.siteDir, { recursive: true, force: true });
  fs.mkdirSync(options.siteDir, { recursive: true });
  copyFiles(site.dir, options.siteDir, own.files);
  options.log.info(`Published ${site.dir} at the site's root: ${own.files.length} files, without the reports.`);
  const state: PublishState = {
    siteUrl: siteAddress(pages.htmlUrl) ?? '',
    visibility: pages.public === false ? 'private' : 'public',
    reportsPath: site.reportsPath,
    reportsSkipped: reason,
    prs: [],
  };
  return {
    published: true,
    reports: false,
    reason,
    state,
    files: own.files.length,
    bytes: own.bytes,
    downloads: { downloaded: 0, downloadedBytes: 0, fromCache: 0, cacheChanged: false },
  };
}

/** The run's report: from the cache when it holds the artifact's ZIP, else downloaded (and kept there). */
async function fetchArchive(
  api: PublishApi,
  run: PlannedRun,
  from: { cache?: ReportCache; digest?: string; downloads: { count: number; bytes: number } },
): Promise<ReportArchive | { refused: string }> {
  let zip = from.cache?.read(run.artifactId, from.digest);
  if (!zip) {
    try {
      zip = await api.download(run.artifactId);
    } catch (error) {
      return { refused: `the report could not be downloaded (${error instanceof Error ? error.message : String(error)})` };
    }
    from.downloads.count += 1;
    from.downloads.bytes += zip.byteLength;
    from.cache?.write(run.artifactId, from.digest, zip);
  }
  try {
    return readReportArchive(zip);
  } catch (error) {
    if (error instanceof ArchiveRefused) return { refused: error.message };
    throw error;
  }
}

/** Writes the files TestivAI makes; each is new ('wx'), so none is written over. */
export function writeFiles(root: string, files: SiteFile[]): void {
  for (const f of files) {
    const to = safeSitePath(root, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, f.data, { flag: 'wx' });
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

/**
 * verified: whether the site answered; siteUrl: the site's address (the
 * deploy's, as https, else the build's); reportsUrl: where the reports are
 * on it, which the links use (siteUrl plus reports-path with a site of your
 * own), absent when the site was deployed without them.
 */
export async function finishPublish(
  api: PublishApi,
  options: FinishOptions,
): Promise<{ verified: boolean | 'skipped'; siteUrl: string; reportsUrl?: string }> {
  const { log } = options;
  let { state } = options;

  const deployed = pagesAddress(options.pageUrl);
  if (deployed && deployed !== state.siteUrl) {
    log.warning(`GitHub deployed the site at ${deployed}, not ${state.siteUrl} as its settings said before; the comments link ${deployed}.`);
    state = { ...state, siteUrl: deployed, prs: state.prs.map((p) => ({ ...p, url: deployed + p.url.slice(state.siteUrl.length) })) };
  }

  const reportsUrl = state.reportsSkipped === undefined ? reportsAddress(state) : undefined;
  const result = (verified: boolean | 'skipped') => ({ verified, siteUrl: state.siteUrl, ...(reportsUrl ? { reportsUrl } : {}) });

  // Only the address the deploy reports is opened: it is what GitHub says is
  // live. The reports' front page when there are reports, else the site.
  let verified: boolean | 'skipped' = 'skipped';
  if (state.visibility !== 'public') {
    log.info('The site is private: it is not opened from here (it needs a GitHub sign-in).');
  } else if (!deployed) {
    log.info('The deploy reported no address, so the site is not opened from here.');
  } else {
    const fetchFn = options.fetch ?? ((url: string) => fetch(url, { redirect: 'follow' }));
    const retries = options.retries ?? 6;
    // state.siteUrl is the deployed address by now, so reportsUrl is on it.
    const opened = reportsUrl ?? deployed;
    verified = false;
    for (let attempt = 1; attempt <= retries && !verified; attempt++) {
      try {
        verified = (await fetchFn(opened)).status === 200;
      } catch {
        verified = false;
      }
      if (!verified && attempt < retries) await new Promise((r) => setTimeout(r, options.delayMs ?? 10_000));
    }
    if (verified) log.info(`The site answers at ${opened}.`);
    else log.warning(`The site did not answer at ${opened} after ${retries} tries. GitHub reported the deploy as done, so the links are added anyway.`);
  }

  if (!options.comment) return result(verified);
  for (const published of state.prs) {
    try {
      // A private site's images cannot be fetched for the comment (GitHub's image proxy has no sign-in).
      const action = commentFor(published, await api.comments(published.pr), options.marker, { thumbnails: state.visibility === 'public' });
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
  return result(verified);
}
