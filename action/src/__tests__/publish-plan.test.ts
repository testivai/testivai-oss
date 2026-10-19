/**
 * Which runs' reports go on the site.
 *
 * The site is rebuilt from scratch on every publish, from what is true now:
 * the last few runs of every open pull request (forks included) and the
 * latest run on the default branch. A closed pull request is simply not in
 * the next build, so cleanup needs no job of its own. The size budget keeps
 * the site under GitHub Pages' 1 GB limit; when it is over, the oldest
 * reports go first, a fork's before a branch's, and a pull request's latest
 * run last.
 */

import { planSite, type PlanInput, type PlannedRun } from '../publish/plan';

const MB = 1024 * 1024;

type Pr = PlanInput['prs'][number];
type Run = PlanInput['runs'][number];
type Artifact = PlanInput['artifacts'][number];

function pr(number: number, over: Partial<Pr> = {}): Pr {
  return { number, headRepo: 'testivai/testivai-example', headRef: `feature-${number}`, headSha: `sha${number}`, author: 'dev', fork: false, ...over };
}

let nextRun = 1000;
function run(over: Partial<Run> = {}): Run {
  const id = nextRun++;
  return {
    id,
    attempt: 1,
    headRepo: 'testivai/testivai-example',
    headBranch: 'feature-1',
    headSha: `sha-${id}`,
    event: 'pull_request',
    status: 'completed',
    createdAt: `2026-10-18T10:${String(id % 60).padStart(2, '0')}:00Z`,
    ...over,
  };
}

function artifact(runId: number, over: Partial<Artifact> = {}): Artifact {
  return { id: runId * 10, runId, name: 'testivai-visual-report', sizeBytes: 2 * MB, expired: false, createdAt: '2026-10-18T10:00:00Z', ...over };
}

function input(over: Partial<PlanInput>): PlanInput {
  return {
    prs: [],
    runs: [],
    artifacts: [],
    defaultBranch: 'main',
    repo: 'testivai/testivai-example',
    limits: { runsPerPr: 3, maxSiteBytes: 900 * MB, maxPrBytes: 150 * MB, artifactName: 'testivai-visual-report' },
    ...over,
  };
}

const dirs = (runs: PlannedRun[]) => runs.map((r) => r.dir);

describe('planSite', () => {
  it("publishes each open pull request's last 3 runs, newest first, in pr/<number>/<run>-<attempt>", () => {
    const runs = [1, 2, 3, 4].map((i) => run({ createdAt: `2026-10-18T10:0${i}:00Z` }));
    const plan = planSite(input({ prs: [pr(1)], runs, artifacts: runs.map((r) => artifact(r.id)) }));

    expect(dirs(plan.prs[0].runs)).toEqual([4, 3, 2].map((i) => `pr/1/${runs[i - 1].id}-1`));
    expect(plan.prs[0].pr.number).toBe(1);
  });

  it("matches a run to its pull request by the head repository and branch, whatever started it", () => {
    const own = run({ headBranch: 'feature-1', event: 'pull_request' });
    const rerun = run({ headBranch: 'feature-1', event: 'workflow_dispatch' }); // the approve job's re-run
    const otherBranch = run({ headBranch: 'feature-2' });
    const sameBranchOtherFork = run({ headRepo: 'someone/testivai-example', headBranch: 'feature-1' });
    const runs = [own, rerun, otherBranch, sameBranchOtherFork];

    const plan = planSite(input({ prs: [pr(1)], runs, artifacts: runs.map((r) => artifact(r.id)) }));

    expect(plan.prs[0].runs.map((r) => r.runId).sort()).toEqual([own.id, rerun.id].sort());
  });

  it("includes a fork's pull request, marked as a fork", () => {
    const fork = pr(7, { headRepo: 'someone/testivai-example', headRef: 'patch-1', fork: true, author: 'someone' });
    const r = run({ headRepo: 'someone/testivai-example', headBranch: 'patch-1' });

    const plan = planSite(input({ prs: [fork], runs: [r], artifacts: [artifact(r.id)] }));

    expect(plan.prs[0].runs).toHaveLength(1);
    expect(plan.prs[0].runs[0].fork).toBe(true);
  });

  it('uses the latest run on the default branch for main/', () => {
    const older = run({ headBranch: 'main', event: 'push', createdAt: '2026-10-18T09:00:00Z' });
    const latest = run({ headBranch: 'main', event: 'push', createdAt: '2026-10-18T11:00:00Z' });

    const plan = planSite(input({ runs: [older, latest], artifacts: [artifact(older.id), artifact(latest.id)] }));

    expect(plan.main?.runId).toBe(latest.id);
    expect(plan.main?.dir).toBe('main');
  });

  it('ignores the default branch of a fork when picking main/', () => {
    const forkMain = run({ headRepo: 'someone/testivai-example', headBranch: 'main', event: 'push' });

    const plan = planSite(input({ runs: [forkMain], artifacts: [artifact(forkMain.id)] }));

    expect(plan.main).toBeUndefined();
  });

  it('skips runs that are not finished, or have no report, or whose report expired', () => {
    const running = run({ status: 'in_progress' });
    const noReport = run();
    const expired = run();
    const otherName = run();
    const good = run();
    const runs = [running, noReport, expired, otherName, good];

    const plan = planSite(
      input({
        prs: [pr(1)],
        runs,
        artifacts: [artifact(running.id), artifact(expired.id, { expired: true }), artifact(otherName.id, { name: 'demo-report' }), artifact(good.id)],
      }),
    );

    expect(plan.prs[0].runs.map((r) => r.runId)).toEqual([good.id]);
  });

  it('uses the newest report when a run has more than one of that name (an earlier attempt not deleted)', () => {
    const r = run({ attempt: 2 });
    const plan = planSite(
      input({
        prs: [pr(1)],
        runs: [r],
        artifacts: [artifact(r.id, { id: 900, createdAt: '2026-10-18T12:00:00Z' }), artifact(r.id, { id: 50, createdAt: '2026-10-18T10:00:00Z' })],
      }),
    );

    expect(plan.prs[0].runs[0]).toMatchObject({ artifactId: 900, dir: `pr/1/${r.id}-2` });
  });

  it('leaves out a pull request with no published run, and a closed one is simply not listed', () => {
    const plan = planSite(input({ prs: [pr(1)], runs: [], artifacts: [] }));

    expect(plan.prs).toEqual([]);
  });

  it("drops a run over the per-pull-request size cap, keeping the others", () => {
    const big = run({ createdAt: '2026-10-18T10:05:00Z' });
    const small = run({ createdAt: '2026-10-18T10:04:00Z' });

    const plan = planSite(
      input({ prs: [pr(1)], runs: [big, small], artifacts: [artifact(big.id, { sizeBytes: 200 * MB }), artifact(small.id)] }),
    );

    expect(plan.prs[0].runs.map((r) => r.runId)).toEqual([small.id]);
    expect(plan.dropped).toEqual([expect.objectContaining({ runId: big.id, pr: 1, reason: expect.stringMatching(/150 MB/) })]);
  });

  it('keeps the site under its budget: oldest first, forks before branches, each pull request latest last', () => {
    const own = pr(1);
    const fork = pr(2, { headRepo: 'someone/testivai-example', headRef: 'patch', fork: true });
    const ownRuns = [1, 2, 3].map((i) => run({ headBranch: 'feature-1', createdAt: `2026-10-18T10:0${i}:00Z` }));
    const forkRuns = [4, 5, 6].map((i) => run({ headRepo: 'someone/testivai-example', headBranch: 'patch', createdAt: `2026-10-18T10:0${i}:00Z` }));
    const main = run({ headBranch: 'main', event: 'push' });
    const all = [...ownRuns, ...forkRuns, main];
    const artifacts = all.map((r) => artifact(r.id, { sizeBytes: 10 * MB }));

    // 7 reports of 10 MB; a 45 MB budget keeps 4.
    const plan = planSite(input({ prs: [own, fork], runs: all, artifacts, limits: { runsPerPr: 3, maxSiteBytes: 45 * MB, maxPrBytes: 150 * MB, artifactName: 'testivai-visual-report' } }));

    const kept = new Set([...(plan.main ? [plan.main.runId] : []), ...plan.prs.flatMap((p) => p.runs.map((r) => r.runId))]);
    expect(kept.has(main.id)).toBe(true);
    expect(kept.has(ownRuns[2].id)).toBe(true); // a branch PR's latest
    expect(kept.has(forkRuns[2].id)).toBe(true); // a fork PR's latest
    expect(kept.has(ownRuns[1].id)).toBe(true); // a branch's older run outlasts a fork's
    expect(kept.size).toBe(4);
    expect(plan.dropped.map((d) => d.runId)).toEqual([forkRuns[0].id, forkRuns[1].id, ownRuns[0].id]);
    expect(plan.totalBytes).toBe(40 * MB);
  });

  it('leaves out runs from before the pull request was opened: an earlier pull request on the same branch', () => {
    // #16 ran twice on the branch and was closed; #17 was opened from the same branch.
    const reused = pr(17, { headRef: 'shared', createdAt: '2026-10-18T22:44:04Z' });
    const earlier = [run({ headBranch: 'shared', createdAt: '2026-10-18T21:17:11Z' }), run({ headBranch: 'shared', createdAt: '2026-10-18T21:19:09Z' })];
    const sameSecond = run({ headBranch: 'shared', createdAt: '2026-10-18T22:44:04Z' });
    const own = run({ headBranch: 'shared', createdAt: '2026-10-18T22:50:00Z' });
    const runs = [...earlier, sameSecond, own];

    const plan = planSite(input({ prs: [reused], runs, artifacts: runs.map((r) => artifact(r.id)) }));

    expect(plan.prs[0].runs.map((r) => r.runId)).toEqual([own.id, sameSecond.id]);
    // Not this pull request's runs at all, so not listed as "not published" on its page either.
    expect(plan.dropped).toEqual([]);
  });

  it('leaves out a pull request whose only runs are from before it was opened', () => {
    const reused = pr(17, { headRef: 'shared', createdAt: '2026-10-18T22:44:04Z' });
    const earlier = run({ headBranch: 'shared', createdAt: '2026-10-18T21:19:09Z' });

    const plan = planSite(input({ prs: [reused], runs: [earlier], artifacts: [artifact(earlier.id)] }));

    expect(plan.prs).toEqual([]);
  });

  it('counts the runs-per-pr from the pull request’s own runs, not the earlier ones', () => {
    const reused = pr(17, { headRef: 'shared', createdAt: '2026-10-18T12:00:00Z' });
    const earlier = [1, 2, 3].map((i) => run({ headBranch: 'shared', createdAt: `2026-10-18T11:0${i}:00Z` }));
    const own = [1, 2].map((i) => run({ headBranch: 'shared', createdAt: `2026-10-18T12:0${i}:00Z` }));
    const runs = [...earlier, ...own];

    const plan = planSite(input({ prs: [reused], runs, artifacts: runs.map((r) => artifact(r.id)) }));

    expect(plan.prs[0].runs.map((r) => r.runId)).toEqual([own[1].id, own[0].id]);
  });

  it('keeps every run on the branch when the opening time is unknown or unreadable', () => {
    const runs = [run({ headBranch: 'shared', createdAt: '2026-10-18T21:17:11Z' }), run({ headBranch: 'shared', createdAt: '2026-10-18T22:50:00Z' })];
    const artifacts = runs.map((r) => artifact(r.id));

    for (const createdAt of [undefined, '', 'not a date']) {
      const plan = planSite(input({ prs: [pr(17, { headRef: 'shared', ...(createdAt === undefined ? {} : { createdAt }) })], runs, artifacts }));
      expect(plan.prs[0].runs).toHaveLength(2);
    }
  });

  it('compares the times as instants, whatever their format', () => {
    // 22:44:04Z written with an offset and milliseconds; the run is 1 s earlier.
    const reused = pr(17, { headRef: 'shared', createdAt: '2026-10-19T00:44:04.000+02:00' });
    const before = run({ headBranch: 'shared', createdAt: '2026-10-18T22:44:03Z' });
    const after = run({ headBranch: 'shared', createdAt: '2026-10-18T22:44:05Z' });

    const plan = planSite(input({ prs: [reused], runs: [before, after], artifacts: [artifact(before.id), artifact(after.id)] }));

    expect(plan.prs[0].runs.map((r) => r.runId)).toEqual([after.id]);
  });

  it('names folders only from numbers', () => {
    const hostile = pr(3, { headRef: '../../evil', headRepo: 'x/../../y' });
    const r = run({ headRepo: 'x/../../y', headBranch: '../../evil' });

    const plan = planSite(input({ prs: [hostile], runs: [r], artifacts: [artifact(r.id)] }));

    expect(plan.prs[0].runs[0].dir).toBe(`pr/3/${r.id}-1`);
  });
});
