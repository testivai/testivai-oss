/**
 * enable-pages: creating a GitHub Pages site where a repository has none, and
 * never touching one that exists.
 *
 * The lookup step reads the Pages settings (pages-found: 'true', 'false' on a
 * 404, 'unknown' on any other error) and decides whether the enablement step
 * runs: only with no site at all, and only for a public repository unless
 * enable-pages is 'always', because a new site is public on every plan but
 * GitHub Enterprise Cloud. The build step then says how the enablement went.
 */

import type { PublishApi, RepoInfo } from '../publish/api';
import { decideEnablePages, ENABLE_STEP_NAME, enablementNote, lookupPages, parseEnablePages, type EnablePages } from '../publish/enable';
import type { PagesInfo } from '../publish/pages';

const REPO: RepoInfo = { id: 1, fullName: 'testivai/testivai-example', visibility: 'public', defaultBranch: 'main' };
const WORKFLOW_SITE: PagesInfo = { found: true, buildType: 'workflow', public: true, htmlUrl: 'https://testivai.github.io/testivai-example/' };
const BRANCH_SITE: PagesInfo = { found: true, buildType: 'legacy', public: true, htmlUrl: 'https://testivai.github.io/testivai-example/' };

function fakeApi(pages: PagesInfo | Error, repo: RepoInfo = REPO) {
  const calls = { repo: 0, pages: 0 };
  const api: Pick<PublishApi, 'repo' | 'pages'> = {
    repo: async () => {
      calls.repo++;
      return repo;
    },
    pages: async () => {
      calls.pages++;
      if (pages instanceof Error) throw pages;
      return pages;
    },
  };
  return { api, calls };
}

describe('parseEnablePages', () => {
  it.each([
    ['true', 'true'],
    ['false', 'false'],
    ['always', 'always'],
    [' Always ', 'always'],
    ['FALSE', 'false'],
  ])('reads %j as %j', (value, mode) => {
    expect(parseEnablePages(value)).toBe(mode);
  });

  it.each(['', 'yes', 'on', 'public', '1'])('refuses %j', (value) => {
    expect(() => parseEnablePages(value)).toThrow(/enable-pages must be true, false or always/);
  });
});

describe('decideEnablePages', () => {
  it('enables a public repository that has no Pages site', () => {
    for (const mode of ['true', 'always'] as EnablePages[]) {
      const d = decideEnablePages({ pagesFound: 'false', repoVisibility: 'public', mode });
      expect(d.enable).toBe(true);
      expect(d.reason).toMatch(/no GitHub Pages site/);
      expect(d.reason).toContain('GitHub Actions');
    }
  });

  it('never enables where a site exists, whatever enable-pages says: its settings are left as they are', () => {
    for (const mode of ['true', 'always', 'false'] as EnablePages[]) {
      for (const repoVisibility of ['public', 'private', 'internal'] as const) {
        expect(decideEnablePages({ pagesFound: 'true', repoVisibility, mode }).enable).toBe(false);
      }
    }
    expect(decideEnablePages({ pagesFound: 'true', repoVisibility: 'public', mode: 'true' }).reason).toMatch(/leaves/);
  });

  it('never enables when the Pages settings could not be read: no site is assumed missing', () => {
    for (const mode of ['true', 'always'] as EnablePages[]) {
      expect(decideEnablePages({ pagesFound: 'unknown', repoVisibility: 'public', mode }).enable).toBe(false);
    }
  });

  it('never enables with enable-pages false', () => {
    expect(decideEnablePages({ pagesFound: 'false', repoVisibility: 'public', mode: 'false' }).enable).toBe(false);
  });

  it('does not enable a private or internal repository by default, and says how to', () => {
    for (const repoVisibility of ['private', 'internal'] as const) {
      const d = decideEnablePages({ pagesFound: 'false', repoVisibility, mode: 'true' });
      expect(d.enable).toBe(false);
      // The person who passed a token expected Pages to come on: a notice, not a log line.
      expect(d.notice).toBe(true);
      expect(d.reason).toContain(repoVisibility);
      expect(d.reason).toMatch(/public/);
      expect(d.reason).toMatch(/enable-pages: always/);
      expect(d.reason).toMatch(/Settings → Pages/);
    }
  });

  it("enables a private or internal repository with enable-pages: always, and says the site is public and the consent still decides", () => {
    for (const repoVisibility of ['private', 'internal'] as const) {
      const d = decideEnablePages({ pagesFound: 'false', repoVisibility, mode: 'always' });
      expect(d.enable).toBe(true);
      expect(d.reason).toMatch(/public/);
      expect(d.reason).toContain('TESTIVAI_PUBLIC_REPORTS');
    }
  });

  it('treats a repository of unknown visibility as not public', () => {
    expect(decideEnablePages({ pagesFound: 'false', mode: 'true' }).enable).toBe(false);
    expect(decideEnablePages({ pagesFound: 'false', mode: 'always' }).enable).toBe(true);
  });
});

describe('lookupPages', () => {
  it("pages-found is 'false' on a 404 (no site), and a public repository gets enabled", async () => {
    const { api, calls } = fakeApi({ found: false });

    const r = await lookupPages(api, 'true');

    expect(r.pagesFound).toBe('false');
    expect(r.enable).toBe(true);
    expect(calls.repo).toBe(1);
  });

  it("pages-found is 'true' for a workflow site, and nothing is enabled", async () => {
    const { api, calls } = fakeApi(WORKFLOW_SITE);

    const r = await lookupPages(api, 'always');

    expect(r).toMatchObject({ pagesFound: 'true', enable: false });
    // The visibility only matters when there is no site.
    expect(calls.repo).toBe(0);
  });

  it("pages-found is 'true' for a branch-based site too: it is never switched to GitHub Actions", async () => {
    const { api } = fakeApi(BRANCH_SITE);

    expect(await lookupPages(api, 'always')).toMatchObject({ pagesFound: 'true', enable: false });
  });

  it("pages-found is 'unknown' on any other error from the Pages API, nothing is enabled, and the error is in the reason", async () => {
    for (const status of [401, 403, 500, undefined]) {
      const { api, calls } = fakeApi(Object.assign(new Error('Resource not accessible by integration'), status ? { status } : {}));

      const r = await lookupPages(api, 'always');

      expect(r).toMatchObject({ pagesFound: 'unknown', enable: false });
      expect(r.reason).toContain('Resource not accessible by integration');
      expect(calls.repo).toBe(0);
    }
  });

  it('keeps a private repository without Pages off unless enable-pages is always', async () => {
    const privateRepo: RepoInfo = { ...REPO, visibility: 'private' };

    expect(await lookupPages(fakeApi({ found: false }, privateRepo).api, 'true')).toMatchObject({ pagesFound: 'false', enable: false, notice: true });
    expect(await lookupPages(fakeApi({ found: false }, privateRepo).api, 'always')).toMatchObject({ pagesFound: 'false', enable: true });
  });

  it('enables nothing with enable-pages false, and still says what it found', async () => {
    expect(await lookupPages(fakeApi({ found: false }).api, 'false')).toMatchObject({ pagesFound: 'false', enable: false });
  });
});

describe('enablementNote', () => {
  it('says the site was created when the enablement step succeeded', () => {
    const note = enablementNote('success');
    expect(note?.level).toBe('notice');
    expect(note?.message).toContain(ENABLE_STEP_NAME);
    expect(note?.message).toMatch(/created/);
    expect(note?.message).toContain('GitHub Actions');
  });

  it('says the enablement was attempted and failed, where the error is, and the usual causes', () => {
    const note = enablementNote('failure');
    expect(note?.level).toBe('warning');
    expect(note?.message).toMatch(/failed/);
    expect(note?.message).toContain(ENABLE_STEP_NAME);
    expect(note?.message).toContain('GITHUB_TOKEN');
    expect(note?.message).toMatch(/Administration/);
  });

  it('says nothing when the enablement step did not run', () => {
    for (const outcome of ['skipped', '', undefined, 'cancelled']) expect(enablementNote(outcome)).toBeUndefined();
  });
});
