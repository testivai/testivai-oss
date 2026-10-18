/**
 * Whether to publish reports to this repository's GitHub Pages site, and
 * where it is.
 *
 * Who can open the site is GitHub's setting, changed only by admins: whether
 * Pages is on, its source, and its visibility (a private site needs GitHub
 * Enterprise Cloud; on other plans a site is public even when the repository
 * is private). This reads those settings and never changes them. The one
 * case it refuses on its own is a private (or internal) repository with a
 * public site: publishing would put that repository's screenshots on the
 * open internet, so it needs an admin's yes, given as
 * TESTIVAI_PUBLIC_REPORTS=true on the github-pages environment (which only
 * admins can configure) and passed in here.
 */

/** What GET /repos/{owner}/{repo}/pages said; found: false for a 404. */
export interface PagesInfo {
  found: boolean;
  /** 'workflow' when the source is GitHub Actions, 'legacy' for a branch. */
  buildType?: string;
  /** false for a private site; absent where GitHub does not report it (treated as public). */
  public?: boolean;
  /** The site's address: <owner>.github.io/<repo>/, a private *.pages.github.io one, or a custom domain. */
  htmlUrl?: string;
}

export interface PublishDecision {
  publish: boolean;
  /** Why, in words for the job log (and the comment when nothing is published). */
  reason: string;
  /** The site address, ending in '/'. Present when publishing. */
  siteUrl?: string;
  visibility?: 'public' | 'private';
}

export const CONSENT_VARIABLE = 'TESTIVAI_PUBLIC_REPORTS';

export function decidePublish(input: {
  pages: PagesInfo;
  repoVisibility: 'public' | 'private' | 'internal';
  /** The value of TESTIVAI_PUBLIC_REPORTS from the github-pages environment, if set. */
  publicReportsConsent?: string;
}): PublishDecision {
  const { pages, repoVisibility, publicReportsConsent } = input;
  if (!pages.found) {
    return {
      publish: false,
      reason:
        'GitHub Pages is not enabled for this repository, so reports are not published; the PR comment keeps the report ZIP. An admin can enable it under Settings → Pages, with the source "GitHub Actions".',
    };
  }
  if (pages.buildType !== 'workflow') {
    return {
      publish: false,
      reason:
        'GitHub Pages here builds from a branch, so reports are not published. An admin can set Settings → Pages → Source to "GitHub Actions" for TestivAI to publish them.',
    };
  }
  const siteUrl = pagesAddress(pages.htmlUrl);
  if (!siteUrl) {
    return {
      publish: false,
      reason: pages.htmlUrl
        ? `GitHub reports the Pages site at ${pages.htmlUrl}, which is not served over https, so reports are not published: their links must be https. An admin can turn on Settings → Pages → Enforce HTTPS.`
        : 'GitHub did not report an address for the Pages site, so reports are not published.',
    };
  }
  if (pages.public === false) {
    return {
      publish: true,
      siteUrl,
      visibility: 'private',
      reason: 'The Pages site is private: only people with read access to this repository can open the reports.',
    };
  }
  if (repoVisibility !== 'public' && publicReportsConsent !== 'true') {
    return {
      publish: false,
      reason: `This repository is ${repoVisibility} but its GitHub Pages site is public, so published reports (screenshots included) would be readable by anyone on the internet. Reports are not published. An admin can allow it by setting the variable ${CONSENT_VARIABLE}=true on the github-pages environment (Settings → Environments → github-pages), or make the site private (GitHub Enterprise Cloud: Settings → Pages → Visibility).`,
    };
  }
  return {
    publish: true,
    siteUrl,
    visibility: 'public',
    reason:
      repoVisibility === 'public'
        ? 'The Pages site is public, like this repository.'
        : `The Pages site is public; an admin allowed publishing this ${repoVisibility} repository's reports there (${CONSENT_VARIABLE}=true).`,
  };
}

/**
 * A Pages site's https address ending in '/', or undefined. GitHub can report
 * a github.io site as http:// (the Pages API's html_url and deploy-pages'
 * page_url both do for testivai/testivai-example), but github.io serves only
 * https: browsers have it on their HSTS preload list. So an http address on
 * github.io or a subdomain of it is read as https; any other http address
 * (a custom domain without Enforce HTTPS) is not used.
 */
export function pagesAddress(raw?: string): string | undefined {
  if (!raw || /[\s"'<>()`\\]/.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const githubIo = url.hostname === 'github.io' || url.hostname.endsWith('.github.io');
  if (url.protocol === 'http:' && githubIo) url = new URL(`https://${url.href.slice('http://'.length)}`);
  if (url.protocol !== 'https:') return undefined;
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}
