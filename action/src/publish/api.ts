/**
 * The GitHub API calls the publish step makes, over Octokit's request().
 *
 * Read-only except the two comment calls. Needs, on the workflow's token:
 * contents: read (the repository), pages: read (its Pages settings; the
 * deploy itself needs pages: write), actions: read (runs, artifacts and their
 * download), pull-requests: read (open pull requests) and, for the links in
 * comments, pull-requests: write.
 */

import type { ExistingComment } from './comments';
import type { PagesInfo } from './pages';
import type { PlanArtifact, PlanPr, PlanRun } from './plan';

export interface RepoInfo {
  id: number;
  /** owner/name. */
  fullName: string;
  visibility: 'public' | 'private' | 'internal';
  defaultBranch: string;
}

export interface OpenPr extends PlanPr {
  headRepoId: number;
}

export interface ApiArtifact extends PlanArtifact {
  headRepoId?: number;
  headBranch?: string;
}

export interface PublishApi {
  repo(): Promise<RepoInfo>;
  pages(): Promise<PagesInfo>;
  /** Open pull requests whose head repository still exists. */
  openPrs(): Promise<OpenPr[]>;
  /** Artifacts of that name, newest first, up to maxPages pages of 100. */
  artifacts(name: string, maxPages: number): Promise<{ artifacts: ApiArtifact[]; truncated: boolean }>;
  /** A workflow run; undefined when it no longer exists. */
  run(id: number): Promise<PlanRun | undefined>;
  /** An artifact's ZIP. */
  download(artifactId: number): Promise<Uint8Array>;
  comments(pr: number): Promise<ExistingComment[]>;
  createComment(pr: number, body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
}

/** The part of Octokit this uses. */
export interface OctokitLike {
  request: (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }>;
}

type Json = Record<string, any>;

const PAGE = 100;
const MAX_LIST_PAGES = 10;

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('the artifact download returned no data');
}

export function octokitApi(github: OctokitLike, owner: string, repo: string): PublishApi {
  const base = { owner, repo };
  let fullName = `${owner}/${repo}`;

  const list = async (route: string, params: Record<string, unknown>, pick: (data: unknown) => unknown[], maxPages: number) => {
    const items: unknown[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await github.request(route, { ...base, ...params, per_page: PAGE, page });
      const batch = pick(data);
      items.push(...batch);
      if (batch.length < PAGE) return { items, truncated: false };
    }
    return { items, truncated: true };
  };

  return {
    async repo() {
      const { data } = (await github.request('GET /repos/{owner}/{repo}', base)) as { data: Json };
      fullName = data.full_name;
      const visibility = data.visibility === 'public' || data.visibility === 'internal' ? data.visibility : data.private === false ? 'public' : 'private';
      return { id: data.id, fullName: data.full_name, visibility, defaultBranch: data.default_branch };
    },

    async pages() {
      try {
        const { data } = (await github.request('GET /repos/{owner}/{repo}/pages', base)) as { data: Json };
        return {
          found: true,
          buildType: typeof data.build_type === 'string' ? data.build_type : undefined,
          ...(typeof data.public === 'boolean' ? { public: data.public } : {}),
          htmlUrl: typeof data.html_url === 'string' ? data.html_url : undefined,
        };
      } catch (error) {
        if (statusOf(error) === 404) return { found: false };
        throw error;
      }
    },

    async openPrs() {
      const { items } = await list('GET /repos/{owner}/{repo}/pulls', { state: 'open' }, (d) => d as unknown[], MAX_LIST_PAGES);
      return (items as Json[])
        .filter((p) => p.head?.repo?.full_name)
        .map((p) => ({
          number: p.number,
          headRepo: p.head.repo.full_name,
          headRepoId: p.head.repo.id,
          headRef: p.head.ref,
          headSha: p.head.sha,
          author: p.user?.login ?? '',
          fork: String(p.head.repo.full_name).toLowerCase() !== fullName.toLowerCase(),
          title: typeof p.title === 'string' ? p.title : undefined,
          createdAt: typeof p.created_at === 'string' ? p.created_at : undefined,
        }));
    },

    async artifacts(name, maxPages) {
      const { items, truncated } = await list('GET /repos/{owner}/{repo}/actions/artifacts', { name }, (d) => (d as Json).artifacts ?? [], maxPages);
      const artifacts = (items as Json[])
        .filter((a) => a.workflow_run?.id)
        .map((a) => ({
          id: a.id,
          runId: a.workflow_run.id,
          name: a.name,
          sizeBytes: a.size_in_bytes,
          expired: a.expired === true,
          createdAt: a.created_at,
          headRepoId: a.workflow_run.head_repository_id,
          headBranch: a.workflow_run.head_branch,
        }));
      return { artifacts, truncated };
    },

    async run(id) {
      try {
        const { data } = (await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { ...base, run_id: id })) as { data: Json };
        return {
          id: data.id,
          attempt: data.run_attempt ?? 1,
          headRepo: data.head_repository?.full_name ?? '',
          headBranch: data.head_branch ?? '',
          headSha: data.head_sha ?? '',
          event: data.event ?? '',
          status: data.status ?? '',
          createdAt: data.created_at ?? '',
        };
      } catch (error) {
        if (statusOf(error) === 404) return undefined;
        throw error;
      }
    },

    async download(artifactId) {
      const { data } = await github.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
        ...base,
        artifact_id: artifactId,
        archive_format: 'zip',
      });
      return toBytes(data);
    },

    async comments(pr) {
      const { items } = await list('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { issue_number: pr }, (d) => d as unknown[], MAX_LIST_PAGES);
      return (items as Json[]).map((c) => ({ id: c.id, body: c.body ?? '', author: c.user?.login ?? '' }));
    },

    async createComment(pr, body) {
      await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...base, issue_number: pr, body });
    },

    async updateComment(id, body) {
      await github.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', { ...base, comment_id: id, body });
    },
  };
}
