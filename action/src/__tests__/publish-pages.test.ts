/**
 * Whether to publish reports to this repository's GitHub Pages site.
 *
 * GitHub decides who can open the site, and only admins change that: whether
 * Pages is on, its source, and its visibility (private sites need GitHub
 * Enterprise Cloud; on other plans a site is public even for a private
 * repository). The publisher only reads those settings. The one case it
 * refuses on its own is a private repository with a public site: publishing
 * would put the private repo's screenshots on the open internet, so it needs
 * an admin's yes (TESTIVAI_PUBLIC_REPORTS=true on the github-pages
 * environment, passed in as publicReportsConsent).
 */

import { canDeploySite, decidePublish, siteAddress } from '../publish/pages';

const SITE = 'https://testivai.github.io/testivai-example/';

describe('decidePublish', () => {
  it('publishes to a public site of a public repository', () => {
    const d = decidePublish({
      pages: { found: true, buildType: 'workflow', public: true, htmlUrl: SITE },
      repoVisibility: 'public',
    });

    expect(d).toEqual({ publish: true, siteUrl: SITE, visibility: 'public', reason: expect.any(String) });
  });

  it('publishes to a private site (Enterprise Cloud), at the address GitHub gives it', () => {
    const privateSite = 'https://reliable-adventure-1a2b3c.pages.github.io/';
    const d = decidePublish({
      pages: { found: true, buildType: 'workflow', public: false, htmlUrl: privateSite },
      repoVisibility: 'private',
    });

    expect(d.publish).toBe(true);
    expect(d.siteUrl).toBe(privateSite);
    expect(d.visibility).toBe('private');
  });

  it('does not publish when Pages is not enabled, and says how to enable it', () => {
    const d = decidePublish({ pages: { found: false }, repoVisibility: 'public' });

    expect(d.publish).toBe(false);
    expect(d.reason).toMatch(/not enabled/i);
    expect(d.reason).toMatch(/Settings → Pages/);
    expect(d.reason).toMatch(/GitHub Actions/);
  });

  it('does not publish when the site builds from a branch', () => {
    const d = decidePublish({
      pages: { found: true, buildType: 'legacy', public: true, htmlUrl: SITE },
      repoVisibility: 'public',
    });

    expect(d.publish).toBe(false);
    expect(d.reason).toMatch(/GitHub Actions/);
  });

  it.each(['private', 'internal'] as const)('does not publish a %s repository to a public site without an admin\'s yes', (repoVisibility) => {
    for (const publicReportsConsent of [undefined, '', 'false', 'yes', 'TRUE ']) {
      const d = decidePublish({
        pages: { found: true, buildType: 'workflow', public: true, htmlUrl: SITE },
        repoVisibility,
        publicReportsConsent,
      });

      expect(d.publish).toBe(false);
      expect(d.reason).toMatch(/public/i);
      expect(d.reason).toMatch(/TESTIVAI_PUBLIC_REPORTS/);
      expect(d.reason).toMatch(/github-pages/);
    }
  });

  it("publishes a private repository's reports to a public site when an admin said yes", () => {
    const d = decidePublish({
      pages: { found: true, buildType: 'workflow', public: true, htmlUrl: SITE },
      repoVisibility: 'private',
      publicReportsConsent: 'true',
    });

    expect(d.publish).toBe(true);
    expect(d.visibility).toBe('public');
  });

  it('treats a site whose visibility GitHub does not report as public', () => {
    const d = decidePublish({
      pages: { found: true, buildType: 'workflow', htmlUrl: SITE },
      repoVisibility: 'private',
    });

    expect(d.publish).toBe(false);
    expect(d.reason).toMatch(/TESTIVAI_PUBLIC_REPORTS/);
  });

  it.each([undefined, 'not a url', 'ftp://testivai.github.io/x/'])('does not publish when the site address is %p', (htmlUrl) => {
    const d = decidePublish({
      pages: { found: true, buildType: 'workflow', public: true, htmlUrl },
      repoVisibility: 'public',
    });

    expect(d.publish).toBe(false);
  });

  it.each([
    ['http://testivai.github.io/testivai-example/', 'https://testivai.github.io/testivai-example/'],
    ['http://testivai.github.io/', 'https://testivai.github.io/'],
    ['http://abc123.pages.github.io/', 'https://abc123.pages.github.io/'],
    ['HTTP://Testivai.GitHub.io/testivai-example', 'https://testivai.github.io/testivai-example/'],
    ['http://testivai.github.io/My-Repo/', 'https://testivai.github.io/My-Repo/'],
  ])("takes GitHub's http address %s for a github.io site as https: github.io serves only https", (htmlUrl, siteUrl) => {
    // GitHub reports http://<owner>.github.io/<repo>/ for testivai-example
    // (deploy-pages' page_url says the same), though the site answers on https.
    const d = decidePublish({ pages: { found: true, buildType: 'workflow', public: true, htmlUrl }, repoVisibility: 'public' });

    expect(d).toMatchObject({ publish: true, siteUrl });
  });

  it.each(['http://github.io.evil.example/', 'http://evilgithub.io/', 'http://testivai.github.io.example.com/'])(
    'does not take a look-alike host %s for github.io',
    (htmlUrl) => {
      expect(decidePublish({ pages: { found: true, buildType: 'workflow', public: true, htmlUrl }, repoVisibility: 'public' }).publish).toBe(false);
    },
  );

  it('says why a custom domain on http is not used, with the address and the setting to change', () => {
    const d = decidePublish({ pages: { found: true, buildType: 'workflow', public: true, htmlUrl: 'http://reports.example.com/' }, repoVisibility: 'public' });

    expect(d.publish).toBe(false);
    expect(d.reason).toContain('http://reports.example.com/');
    expect(d.reason).toContain('Enforce HTTPS');
  });

  it('ends the site address with a slash, so run folders join onto it', () => {
    const d = decidePublish({
      pages: { found: true, buildType: 'workflow', public: true, htmlUrl: 'https://reports.example.com' },
      repoVisibility: 'public',
    });

    expect(d.siteUrl).toBe('https://reports.example.com/');
  });
});

describe('canDeploySite (site-dir: the site deploys even when its reports are not published)', () => {
  it('is true only when Pages is on with the source "GitHub Actions"', () => {
    expect(canDeploySite({ found: true, buildType: 'workflow', public: true, htmlUrl: SITE })).toBe(true);
    // Settings that refuse the reports do not stop the site.
    expect(canDeploySite({ found: true, buildType: 'workflow', public: true })).toBe(true);
    expect(canDeploySite({ found: true, buildType: 'workflow', public: true, htmlUrl: 'http://www.example.com/' })).toBe(true);
    // A branch serves the site: an Actions deploy is not the site's.
    expect(canDeploySite({ found: true, buildType: 'legacy', public: true, htmlUrl: SITE })).toBe(false);
    expect(canDeploySite({ found: true, public: true, htmlUrl: SITE })).toBe(false);
    expect(canDeploySite({ found: false })).toBe(false);
  });
});

describe('siteAddress (the address of a site deployed without reports)', () => {
  it.each([
    ['https://www.budisugianto.com', 'https://www.budisugianto.com/'],
    ['http://testivai.github.io/testivai-example', 'https://testivai.github.io/testivai-example/'],
    // A custom domain without Enforce HTTPS: the reports need https, the site does not.
    ['http://www.example.com/', 'http://www.example.com/'],
  ])('reads %s as %s', (raw, address) => {
    expect(siteAddress(raw)).toBe(address);
  });

  it.each([undefined, '', 'not a url', 'ftp://www.example.com/', 'javascript:alert(1)//', 'http://www.example.com/"><x'])('has none for %p', (raw) => {
    expect(siteAddress(raw)).toBeUndefined();
  });
});
