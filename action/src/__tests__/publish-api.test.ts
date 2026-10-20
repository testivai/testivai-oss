/**
 * The publish step's GitHub API calls: the routes it requests and how it
 * reads GitHub's responses (shapes from the REST API reference).
 */

import { octokitApi, type OctokitLike } from '../publish/api';

type Handler = (params: Record<string, any>) => unknown;

function fake(routes: Record<string, Handler>) {
  const calls: Array<{ route: string; params: Record<string, any> }> = [];
  const github: OctokitLike = {
    request: async (route, params = {}) => {
      calls.push({ route, params });
      const handler = routes[route];
      if (!handler) throw Object.assign(new Error(`unexpected ${route}`), { status: 500 });
      return { data: handler(params) };
    },
  };
  return { github, calls };
}

const notFound = () => {
  throw Object.assign(new Error('Not Found'), { status: 404 });
};

describe('octokitApi', () => {
  it('reads the repository: id, name, visibility and default branch', async () => {
    const { github } = fake({
      'GET /repos/{owner}/{repo}': () => ({ id: 42, full_name: 'TestivAI/testivai-example', private: true, visibility: 'internal', default_branch: 'trunk' }),
    });

    expect(await octokitApi(github, 'testivai', 'testivai-example').repo()).toEqual({ id: 42, fullName: 'TestivAI/testivai-example', visibility: 'internal', defaultBranch: 'trunk' });
  });

  it('reads a repository without a visibility field from private (GitHub Enterprise Server)', async () => {
    const api = (isPrivate: boolean) =>
      octokitApi(fake({ 'GET /repos/{owner}/{repo}': () => ({ id: 1, full_name: 'o/r', private: isPrivate, default_branch: 'main' }) }).github, 'o', 'r');

    expect((await api(false).repo()).visibility).toBe('public');
    expect((await api(true).repo()).visibility).toBe('private');
  });

  it('reads the Pages settings', async () => {
    const { github } = fake({
      'GET /repos/{owner}/{repo}/pages': () => ({ build_type: 'workflow', public: false, html_url: 'https://example.pages.github.io/', status: 'built' }),
    });

    expect(await octokitApi(github, 'o', 'r').pages()).toEqual({ found: true, buildType: 'workflow', public: false, htmlUrl: 'https://example.pages.github.io/' });
  });

  it('leaves out public where GitHub does not report it', async () => {
    const { github } = fake({ 'GET /repos/{owner}/{repo}/pages': () => ({ build_type: 'legacy', html_url: 'https://o.github.io/r/' }) });

    expect(await octokitApi(github, 'o', 'r').pages()).toEqual({ found: true, buildType: 'legacy', htmlUrl: 'https://o.github.io/r/' });
  });

  it('reads a 404 as Pages not enabled, and passes other errors on', async () => {
    expect(await octokitApi(fake({ 'GET /repos/{owner}/{repo}/pages': notFound }).github, 'o', 'r').pages()).toEqual({ found: false });

    const forbidden = fake({
      'GET /repos/{owner}/{repo}/pages': () => {
        throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
      },
    });
    await expect(octokitApi(forbidden.github, 'o', 'r').pages()).rejects.toThrow(/not accessible/);
  });

  it('lists open pull requests, marks forks, and skips one whose fork was deleted', async () => {
    const { github, calls } = fake({
      'GET /repos/{owner}/{repo}': () => ({ id: 1, full_name: 'testivai/testivai-example', visibility: 'public', default_branch: 'main' }),
      'GET /repos/{owner}/{repo}/pulls': () => [
        { number: 14, title: 'Restyle', created_at: '2026-10-18T09:00:00Z', user: { login: 'dev' }, head: { ref: 'feature', sha: 'aaa', repo: { id: 1, full_name: 'testivai/testivai-example' } } },
        { number: 15, title: 'Typo', created_at: '2026-10-18T09:30:00Z', user: { login: 'someone' }, head: { ref: 'patch-1', sha: 'bbb', repo: { id: 9, full_name: 'someone/testivai-example' } } },
        { number: 16, title: 'Gone', created_at: '2026-10-18T10:00:00Z', user: { login: 'ghost' }, head: { ref: 'x', sha: 'ccc', repo: null } },
      ],
    });
    const api = octokitApi(github, 'testivai', 'testivai-example');
    await api.repo();

    expect(await api.openPrs()).toEqual([
      { number: 14, headRepo: 'testivai/testivai-example', headRepoId: 1, headRef: 'feature', headSha: 'aaa', author: 'dev', fork: false, title: 'Restyle', createdAt: '2026-10-18T09:00:00Z' },
      { number: 15, headRepo: 'someone/testivai-example', headRepoId: 9, headRef: 'patch-1', headSha: 'bbb', author: 'someone', fork: true, title: 'Typo', createdAt: '2026-10-18T09:30:00Z' },
    ]);
    expect(calls.find((c) => c.route.endsWith('/pulls'))?.params).toMatchObject({ state: 'open', per_page: 100, page: 1 });
  });

  it("compares names with the repository's own, so a renamed repository or another letter case is not a fork", async () => {
    const own = { ref: 'feature', sha: 'aaa', repo: { id: 1, full_name: 'TestivAI/testivai-example' } };
    const routes = {
      'GET /repos/{owner}/{repo}': () => ({ id: 1, full_name: 'TestivAI/testivai-example', visibility: 'public', default_branch: 'main' }),
      'GET /repos/{owner}/{repo}/pulls': () => [{ number: 14, user: { login: 'dev' }, head: own }],
    };
    const renamed = octokitApi(fake(routes).github, 'testivai', 'old-name');
    await renamed.repo();
    expect((await renamed.openPrs())[0].fork).toBe(false);

    const lowerCase = octokitApi(fake(routes).github, 'testivai', 'testivai-example');
    expect((await lowerCase.openPrs())[0].fork).toBe(false);
  });

  it('pages through a long list until a short page', async () => {
    const pr = (n: number) => ({ number: n, head: { ref: 'b', sha: 's', repo: { id: 1, full_name: 'o/r' } }, user: { login: 'u' } });
    const { github, calls } = fake({
      'GET /repos/{owner}/{repo}/pulls': (p) => (p.page === 1 ? Array.from({ length: 100 }, (_, i) => pr(i)) : [pr(100)]),
    });

    expect(await octokitApi(github, 'o', 'r').openPrs()).toHaveLength(101);
    expect(calls.map((c) => c.params.page)).toEqual([1, 2]);
  });

  it('lists artifacts of a name with their run, and says when it stopped at the page cap', async () => {
    const artifact = (id: number) => ({
      id,
      name: 'testivai-visual-report',
      size_in_bytes: 2048,
      expired: false,
      created_at: '2026-10-18T10:00:00Z',
      workflow_run: { id: id * 10, repository_id: 1, head_repository_id: 9, head_branch: 'patch-1', head_sha: 'bbb' },
    });
    const { github, calls } = fake({
      'GET /repos/{owner}/{repo}/actions/artifacts': () => ({ total_count: 500, artifacts: Array.from({ length: 100 }, (_, i) => artifact(i + 1)) }),
    });

    const { artifacts, truncated } = await octokitApi(github, 'o', 'r').artifacts('testivai-visual-report', 2);

    expect(truncated).toBe(true);
    expect(artifacts).toHaveLength(200);
    expect(artifacts[0]).toEqual({ id: 1, runId: 10, name: 'testivai-visual-report', sizeBytes: 2048, expired: false, createdAt: '2026-10-18T10:00:00Z', headRepoId: 9, headBranch: 'patch-1' });
    expect(calls[0].params).toMatchObject({ name: 'testivai-visual-report', per_page: 100, page: 1 });
  });

  it('reads a run, and a deleted one as undefined', async () => {
    const { github } = fake({
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}': (p) =>
        p.run_id === 7
          ? { id: 7, run_attempt: 2, head_repository: { full_name: 'someone/r' }, head_branch: 'patch-1', head_sha: 'bbb', event: 'pull_request', status: 'completed', created_at: '2026-10-18T10:00:00Z' }
          : notFound(),
    });
    const api = octokitApi(github, 'o', 'r');

    expect(await api.run(7)).toEqual({ id: 7, attempt: 2, headRepo: 'someone/r', headBranch: 'patch-1', headSha: 'bbb', event: 'pull_request', status: 'completed', createdAt: '2026-10-18T10:00:00Z' });
    expect(await api.run(8)).toBeUndefined();
  });

  it('passes on an error reading a run other than not found', async () => {
    const { github } = fake({
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}': () => {
        throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
      },
    });

    await expect(octokitApi(github, 'o', 'r').run(7)).rejects.toThrow(/rate limit/);
  });

  it("reads an artifact's SHA-256 digest, and leaves it out where GitHub has none (upload-artifact before v4)", async () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const { github } = fake({
      'GET /repos/{owner}/{repo}/actions/artifacts': () => ({
        artifacts: [
          { id: 1, name: 'n', size_in_bytes: 1, expired: false, created_at: 't', digest, workflow_run: { id: 2, head_repository_id: 3, head_branch: 'b' } },
          { id: 4, name: 'n', size_in_bytes: 1, expired: false, created_at: 't', digest: null, workflow_run: { id: 5, head_repository_id: 3, head_branch: 'b' } },
        ],
      }),
    });

    const { artifacts } = await octokitApi(github, 'o', 'r').artifacts('n', 1);

    expect(artifacts[0].digest).toBe(digest);
    expect('digest' in artifacts[1]).toBe(false);
  });

  it('marks an expired artifact', async () => {
    const { github } = fake({
      'GET /repos/{owner}/{repo}/actions/artifacts': () => ({
        artifacts: [{ id: 1, name: 'n', size_in_bytes: 1, expired: true, created_at: 't', workflow_run: { id: 2, head_repository_id: 3, head_branch: 'b' } }],
      }),
    });

    expect((await octokitApi(github, 'o', 'r').artifacts('n', 1)).artifacts[0].expired).toBe(true);
  });

  it('downloads an artifact as a ZIP, as an ArrayBuffer or a Buffer', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
    for (const data of [bytes.buffer.slice(0), Buffer.from(bytes)]) {
      const { github, calls } = fake({ 'GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}': () => data });

      expect(Array.from(await octokitApi(github, 'o', 'r').download(4402))).toEqual([0x50, 0x4b, 3, 4]);
      expect(calls[0].params).toMatchObject({ artifact_id: 4402, archive_format: 'zip' });
    }
  });

  it('lists, creates and updates pull request comments', async () => {
    const { github, calls } = fake({
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': () => [{ id: 5, body: 'hi', user: { login: 'github-actions[bot]' } }, { id: 6, body: null, user: null }],
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': () => ({}),
      'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}': () => ({}),
    });
    const api = octokitApi(github, 'o', 'r');

    expect(await api.comments(14)).toEqual([
      { id: 5, body: 'hi', author: 'github-actions[bot]' },
      { id: 6, body: '', author: '' },
    ]);
    await api.createComment(14, 'new');
    await api.updateComment(5, 'edited');
    expect(calls.slice(1).map((c) => [c.route, c.params.issue_number ?? c.params.comment_id, c.params.body])).toEqual([
      ['POST /repos/{owner}/{repo}/issues/{issue_number}/comments', 14, 'new'],
      ['PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', 5, 'edited'],
    ]);
  });
});
