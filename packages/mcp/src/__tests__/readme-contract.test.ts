import * as fs from 'fs';
import * as path from 'path';
import { TOOL_META } from '../tool-meta';

/**
 * Guards against README ↔ server drift. The package README is what npm shows
 * and what people (and agents) read to learn the tool surface, so it must
 * document every tool the server registers and must not contradict it.
 */
const PKG_DIR = path.join(__dirname, '..', '..');
const REPO_ROOT = path.join(PKG_DIR, '..', '..');
const README = path.join(PKG_DIR, 'README.md');
const read = (file: string) => fs.readFileSync(file, 'utf-8');

describe('@testivai/mcp README', () => {
  const readme = read(README);

  it('documents every tool the server registers', () => {
    const undocumented = Object.keys(TOOL_META).filter((name) => !readme.includes(`\`${name}\``));
    expect(undocumented).toEqual([]);
  });

  it('describes the style-only verdict, not just DOM-identical noise', () => {
    expect(readme).toMatch(/style-only/i);
  });

  // An identical DOM whose styles were not compared is unknown, not noise:
  // the README must document that verdict and must not group it as noise.
  it('describes the styles-not-compared verdict without calling it noise', () => {
    const row = readme.split('\n').find((l) => l.startsWith('| `get_visual_results`'));
    expect(row).toBeDefined();
    expect(row).toMatch(/styles not compared[^/|]*could be render noise or a stylesheet-only change/i);
    expect(row).not.toMatch(/the same kind of noise/i);
    expect(readme).not.toMatch(/whether it's real or just render noise/i);
  });

  // Matching styles are likely noise only for a small, scattered diff: the
  // README must say so and document the concentrated-or-large verdict.
  it('describes likely noise as small and scattered, and the concentrated-or-large verdict as not noise', () => {
    const row = readme.split('\n').find((l) => l.startsWith('| `get_visual_results`'));
    expect(row).toMatch(/likely render noise \(the DOM and computed styles both match and the diff is small and scattered/i);
    expect(row).toMatch(/concentrated in one area or large[^/|]*bad capture or a change the style check does not cover[^/|]*compare the images/i);
  });
});

// Missing baselines (committed, but no capture this run) are served by
// get_visual_results, explain_snapshot and get_diff, and triaged by the
// triage-visual-diff prompt: both docs that describe the tools say so.
describe('docs describe missing baselines', () => {
  const flat = (file: string) => read(file).replace(/\s+/g, ' ');
  const row = (text: string, tool: string) => text.split('\n').find((l) => l.startsWith(`| \`${tool}\``)) ?? '';

  it.each([
    ['packages/mcp/README.md', README],
    ['docs/mcp.md', path.join(REPO_ROOT, 'docs', 'mcp.md')],
  ])('%s: the tools table covers them', (_rel, file) => {
    const text = read(file);
    expect(row(text, 'get_visual_results')).toMatch(/missing baselines? \(committed, but no capture this run\)[^|]*nothing to approve/i);
    expect(row(text, 'explain_snapshot')).toMatch(/for a missing baseline, status `missing`, the committed baseline files and what to check instead/i);
    expect(row(text, 'get_diff')).toMatch(/for a missing baseline, the committed baseline image only/i);
  });

  it('docs/mcp.md: the triage prompt covers them, never as a glitch', () => {
    const doc = flat(path.join(REPO_ROOT, 'docs', 'mcp.md'));
    expect(doc).toMatch(/`snapshot`: triage one snapshot or missing baseline; empty triages every changed or new snapshot and every missing baseline/);
    expect(doc).toMatch(
      /A missing baseline \(committed, but no capture this run[^)]*\) is never a glitch: the model reads the change under test for a removed or renamed test, or one broken before its capture, and otherwise calls it a possible bug and says to check the test run's log/,
    );
    expect(doc).toMatch(/Approving does nothing for a missing baseline: an intended removal deletes its baseline directory in the same change/);
  });
});

// get_diff follows the downscaled full page with native-scale crops of the
// changed regions; both tool tables say so, with the caps the crops use.
describe('docs describe the get_diff crops and their caps', () => {
  const { CROP_LIMITS } = require('../diff-images') as typeof import('../diff-images');
  const row = (text: string) => text.split('\n').find((l) => l.startsWith('| `get_diff`')) ?? '';

  it.each([
    ['packages/mcp/README.md', README],
    ['docs/mcp.md', path.join(REPO_ROOT, 'docs', 'mcp.md')],
  ])('%s: the get_diff row', (_rel, file) => {
    const r = row(read(file));
    expect(r).toMatch(/downscaled/);
    expect(r).toMatch(/cropped at native scale/);
    expect(r).toContain(`up to ${CROP_LIMITS.maxCrops} crops`);
    expect(r).toContain(`${CROP_LIMITS.padding} px`);
    expect(r).toContain(`${CROP_LIMITS.maxWidth}×${CROP_LIMITS.maxHeight} px`);
    expect(r).toContain(`${CROP_LIMITS.maxTotalPixels.toLocaleString('en-US')} px`);
    expect(r).toMatch(/`region`[^|]*`y`[^|]*`height`/);
  });
});

// approve_snapshot / approve_all exist so a human can approve in conversation;
// a guide that says there is no approve tool sends readers to the wrong flow.
describe('agent guides describe the approve tools that exist', () => {
  const GUIDES = [README, path.join(REPO_ROOT, 'CLAUDE.md'), path.join(REPO_ROOT, 'AGENTS.md')];

  it.each(GUIDES.map((file) => [path.relative(REPO_ROOT, file), file]))(
    '%s does not claim the MCP server has no approve tool',
    (_rel, file) => {
      expect(read(file)).not.toMatch(/no approve tool/i);
    },
  );
});
