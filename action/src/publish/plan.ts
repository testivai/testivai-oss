/**
 * Which runs' reports go on the site.
 *
 * The site is rebuilt from scratch on every publish, from what is true now:
 * the last `runsPerPr` runs of every open pull request (forks included) and
 * the latest run on the default branch (main/, the approved state other pull
 * requests merge into). A closed pull request is simply not in the next
 * build, so cleanup needs no job of its own, and two publishes that race
 * each build a complete site.
 *
 * Folders are named only from numbers GitHub gives (pull request, run id,
 * attempt), never from branch or repository names.
 */

export interface PlanPr {
  number: number;
  /** owner/name of the repository the pull request's branch lives in. */
  headRepo: string;
  headRef: string;
  headSha: string;
  author: string;
  fork: boolean;
  /** Shown (as text) on the site's index pages. */
  title?: string;
}

export interface PlanRun {
  id: number;
  /** The run's latest attempt. */
  attempt: number;
  headRepo: string;
  headBranch: string;
  headSha: string;
  event: string;
  status: string;
  createdAt: string;
}

export interface PlanArtifact {
  id: number;
  runId: number;
  name: string;
  sizeBytes: number;
  expired: boolean;
  createdAt: string;
}

export interface PlanLimits {
  runsPerPr: number;
  /** The whole site; GitHub Pages refuses a site over 1 GB. */
  maxSiteBytes: number;
  /** One run's report. */
  maxPrBytes: number;
  artifactName: string;
}

export interface PlanInput {
  prs: PlanPr[];
  runs: PlanRun[];
  artifacts: PlanArtifact[];
  defaultBranch: string;
  /** owner/name of this repository. */
  repo: string;
  limits: PlanLimits;
}

export interface PlannedRun {
  runId: number;
  attempt: number;
  artifactId: number;
  sizeBytes: number;
  /** Where the report goes on the site: 'main' or 'pr/<number>/<run id>-<attempt>'. */
  dir: string;
  headSha: string;
  createdAt: string;
  fork: boolean;
}

export interface DroppedRun {
  runId: number;
  pr?: number;
  reason: string;
}

export interface SitePlan {
  main?: PlannedRun;
  /** Pull requests with at least one report, each newest run first. */
  prs: Array<{ pr: PlanPr; runs: PlannedRun[] }>;
  dropped: DroppedRun[];
  totalBytes: number;
}

const MB = 1024 * 1024;
const mb = (bytes: number) => `${Math.round(bytes / MB)} MB`;

export function planSite(input: PlanInput): SitePlan {
  const { limits } = input;
  const dropped: DroppedRun[] = [];

  // The newest unexpired report of the right name, per run (a re-run whose
  // earlier report was not deleted leaves two).
  const reportOf = new Map<number, PlanArtifact>();
  for (const a of input.artifacts) {
    if (a.name !== limits.artifactName || a.expired) continue;
    const current = reportOf.get(a.runId);
    if (!current || a.createdAt > current.createdAt || (a.createdAt === current.createdAt && a.id > current.id)) {
      reportOf.set(a.runId, a);
    }
  }

  const finished = input.runs
    .filter((r) => r.status === 'completed' && reportOf.has(r.id))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));

  const planned = (r: PlanRun, dir: string, fork: boolean): PlannedRun => {
    const report = reportOf.get(r.id)!;
    return { runId: r.id, attempt: r.attempt, artifactId: report.id, sizeBytes: report.sizeBytes, dir, headSha: r.headSha, createdAt: r.createdAt, fork };
  };

  const mainRun = finished.find((r) => r.headRepo === input.repo && r.headBranch === input.defaultBranch);
  let main = mainRun ? planned(mainRun, 'main', false) : undefined;

  let prs: SitePlan['prs'] = [];
  for (const pr of input.prs) {
    const runs: PlannedRun[] = [];
    for (const r of finished) {
      if (runs.length >= limits.runsPerPr) break;
      if (r.headRepo !== pr.headRepo || r.headBranch !== pr.headRef) continue;
      const entry = planned(r, `pr/${Math.trunc(pr.number)}/${Math.trunc(r.id)}-${Math.trunc(r.attempt)}`, pr.fork);
      if (entry.sizeBytes > limits.maxPrBytes) {
        dropped.push({ runId: r.id, pr: pr.number, reason: `its report is ${mb(entry.sizeBytes)}, over the ${mb(limits.maxPrBytes)} limit for one run` });
        continue;
      }
      runs.push(entry);
    }
    if (runs.length > 0) prs.push({ pr, runs });
  }

  // Over the site budget: drop the oldest reports first, a fork's before a
  // branch's, and a pull request's latest run only after all older ones.
  const size = () => (main?.sizeBytes ?? 0) + prs.reduce((n, p) => n + p.runs.reduce((m, r) => m + r.sizeBytes, 0), 0);
  let total = size();
  if (total > limits.maxSiteBytes) {
    const candidates = prs.flatMap((p) => p.runs.map((r, i) => ({ pr: p.pr.number, run: r, latest: i === 0 })));
    candidates.sort((a, b) => {
      if (a.latest !== b.latest) return a.latest ? 1 : -1;
      if (a.run.fork !== b.run.fork) return a.run.fork ? -1 : 1;
      return a.run.createdAt < b.run.createdAt ? -1 : a.run.createdAt > b.run.createdAt ? 1 : a.run.runId - b.run.runId;
    });
    const drop = new Set<PlannedRun>();
    for (const c of candidates) {
      if (total <= limits.maxSiteBytes) break;
      drop.add(c.run);
      total -= c.run.sizeBytes;
      dropped.push({ runId: c.run.runId, pr: c.pr, reason: `the site would be over its ${mb(limits.maxSiteBytes)} budget` });
    }
    prs = prs.map((p) => ({ pr: p.pr, runs: p.runs.filter((r) => !drop.has(r)) })).filter((p) => p.runs.length > 0);
    if (main && total > limits.maxSiteBytes) {
      dropped.push({ runId: main.runId, reason: `the site would be over its ${mb(limits.maxSiteBytes)} budget` });
      total -= main.sizeBytes;
      main = undefined;
    }
  }

  return { ...(main ? { main } : {}), prs, dropped, totalBytes: size() };
}
