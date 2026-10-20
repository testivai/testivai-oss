/**
 * The CI review (review@v1) judges with the MCP triage rubric it bundles, so
 * its prompt carries the capture-health row: an unhealthy capture is a glitch
 * of the capture or a broken asset, never noise, and never a baseline.
 */
import * as review from '../review';

describe('the review prompt and capture health', () => {
  const prompt = review.buildPrompt({
    repo: 'acme/shop',
    pr: 42,
    title: 'New fonts',
    body: 'Switches the body text to the brand font.',
    diffPath: 'visual-report/triage/pr.diff',
    reportDir: 'visual-report',
    baselinesDir: '.testivai/baselines',
    snapshots: [{ name: 'home', status: 'changed' }],
  });

  it('reads an unhealthy capture as a glitch or a broken asset to fix, never a baseline', () => {
    expect(prompt).toContain('| captureHealth.unhealthy set (the verdict says "unhealthy capture") |');
    expect(prompt).toContain(
      'an unhealthy capture is a glitch of the capture or a broken asset; fix the page, the server or the test; never approve it as a baseline',
    );
  });

  it('a change that broke the asset itself is a bug, not a glitch', () => {
    expect(prompt).toContain('It is a glitch unless the change under test touched the asset that failed');
  });
});
