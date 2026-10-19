/**
 * enable-pages: create a GitHub Pages site, with the source "GitHub Actions",
 * where the repository has none at all, and never touch one that exists.
 *
 * The publish action's first step (lookup) reads the Pages settings and
 * decides here whether its next step, actions/configure-pages with
 * enablement: true, runs. That step needs a token that can create a site
 * (enable-pages-token): GitHub's API for it requires Administration write,
 * which the job's GITHUB_TOKEN can never be given. It runs only when GET
 * /pages answered 404; configure-pages itself only creates a site when its
 * own lookup finds none, and GitHub answers 409 to a create where one exists,
 * so an existing site's settings, a branch-based one included, never change.
 *
 * Only a public repository gets a site by default: on every plan but GitHub
 * Enterprise Cloud with private Pages, a new site is public, so turning it on
 * for a private repository is a visible change of its own, even though
 * decidePublish (pages.ts) still publishes nothing there without
 * TESTIVAI_PUBLIC_REPORTS=true. enable-pages: always allows it.
 */

import type { PublishApi, RepoInfo } from './api';
import { CONSENT_VARIABLE } from './pages';

export type EnablePages = 'true' | 'false' | 'always';

/** What GET /pages said: 'false' only for a 404, 'unknown' for any other error. */
export type PagesFound = 'true' | 'false' | 'unknown';

/** The name of the configure-pages step in publish/action.yml, as the log refers to it. */
export const ENABLE_STEP_NAME = 'Enable GitHub Pages';

export interface EnableDecision {
  enable: boolean;
  /** Why, in words for the job log. */
  reason: string;
  /** True when the reason should be a notice: someone who gave a token expected Pages to come on. */
  notice?: boolean;
}

export function parseEnablePages(value: string): EnablePages {
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === 'false' || v === 'always') return v;
  throw new Error(`enable-pages must be true, false or always, not ${JSON.stringify(value)}`);
}

export function decideEnablePages(input: { pagesFound: PagesFound; repoVisibility?: RepoInfo['visibility']; mode: EnablePages }): EnableDecision {
  const { pagesFound, repoVisibility, mode } = input;
  if (mode === 'false') return { enable: false, reason: 'enable-pages is false: the action does not turn GitHub Pages on.' };
  if (pagesFound === 'true') {
    return { enable: false, reason: 'This repository has a GitHub Pages site: enable-pages leaves its settings as they are.' };
  }
  if (pagesFound === 'unknown') {
    return { enable: false, reason: 'The GitHub Pages settings could not be read, so enable-pages turns nothing on.' };
  }
  if (repoVisibility === 'public') {
    return { enable: true, reason: `This repository has no GitHub Pages site: the step "${ENABLE_STEP_NAME}" creates one, with the source "GitHub Actions" (enable-pages).` };
  }
  const repository = repoVisibility ? `This ${repoVisibility} repository` : 'This repository';
  if (mode === 'always') {
    return {
      enable: true,
      reason: `${repository} has no GitHub Pages site: the step "${ENABLE_STEP_NAME}" creates one, with the source "GitHub Actions" (enable-pages: always). The new site is public unless the organization has private Pages (GitHub Enterprise Cloud), and reports go on a public site only with ${CONSENT_VARIABLE}=true.`,
    };
  }
  return {
    enable: false,
    notice: true,
    reason: `${repository} has no GitHub Pages site, and enable-pages creates one only for a public repository: a new site is public unless the organization has private Pages (GitHub Enterprise Cloud). An admin can turn Pages on under Settings → Pages, with the source "GitHub Actions", or set enable-pages: always.`,
  };
}

/** Reads the Pages settings (and, when there is no site, the repository's visibility) and decides. */
export async function lookupPages(api: Pick<PublishApi, 'repo' | 'pages'>, mode: EnablePages): Promise<EnableDecision & { pagesFound: PagesFound }> {
  let pagesFound: PagesFound;
  let error: string | undefined;
  try {
    pagesFound = (await api.pages()).found ? 'true' : 'false';
  } catch (e) {
    pagesFound = 'unknown';
    error = e instanceof Error ? e.message : String(e);
  }
  const repoVisibility = pagesFound === 'false' ? (await api.repo()).visibility : undefined;
  const decision = decideEnablePages({ pagesFound, repoVisibility, mode });
  return { pagesFound, ...decision, ...(error ? { reason: `${decision.reason} GitHub said: ${error}` } : {}) };
}

/** What the build step says about the enablement step's outcome (steps.enable.outcome), if it ran. */
export function enablementNote(outcome: string | undefined): { level: 'notice' | 'warning'; message: string } | undefined {
  if (outcome === 'success') {
    return {
      level: 'notice',
      message: `enable-pages: this repository had no GitHub Pages site, so the step "${ENABLE_STEP_NAME}" created one, with the source "GitHub Actions". Pages is on now; enable-pages-token can be removed, or a publish after Pages is turned off would turn it back on.`,
    };
  }
  if (outcome === 'failure') {
    return {
      level: 'warning',
      message: `enable-pages: creating the GitHub Pages site was attempted and failed; GitHub's error is in the log of the step "${ENABLE_STEP_NAME}". enable-pages-token needs Administration and Pages write on this repository (the job's GITHUB_TOKEN cannot have them), and a private repository needs a plan with GitHub Pages.`,
    };
  }
  return undefined;
}
