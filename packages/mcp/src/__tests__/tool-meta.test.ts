import { TOOL_META, type ToolMeta } from '../tool-meta';

/**
 * The model reads a tool's description before it calls the tool, so the
 * description must not contradict the verdicts the tool returns (verdictFor).
 * Since witness 1.6.0 an identical DOM is not enough to call a diff noise:
 * the computed styles must match too, and a style-only change is real.
 */
// Words that tell the model to wave a diff through as noise.
const NOISE_ADVICE = /likely (render )?noise|don't block|do not block|mention it/i;

const clauses = (text: string): string[] =>
  text
    .split(/[.;](?:\s+|$)/)
    .map((c) => c.trim())
    .filter(Boolean);

describe('get_visual_results description', () => {
  const description = TOOL_META.get_visual_results.description;

  it('does not claim DOM-identical diffs are noise', () => {
    expect(description).not.toMatch(/DOM-identical diffs are (likely )?(render )?noise/i);
    // Wherever noise is mentioned, styles must be part of the condition.
    const noiseWithoutStyles = clauses(description).filter((c) => /noise/i.test(c) && !/\bstyles?\b/i.test(c));
    expect(noiseWithoutStyles).toEqual([]);
  });

  it('says a style-only change (identical DOM, different styles) is a real change', () => {
    const styleOnly = clauses(description).filter(
      (c) =>
        /style-only change/i.test(c) &&
        /identical DOM|DOM is identical/i.test(c) &&
        /different (computed )?styles|styles differ/i.test(c) &&
        /\breal\b/i.test(c),
    );
    expect(styleOnly).toHaveLength(1);
  });

  it('ties noise to the DOM and the computed styles both matching', () => {
    const noise = clauses(description).filter((c) => /noise/i.test(c));
    expect(noise.some((c) => /\bDOM and (the )?(computed )?styles both match/i.test(c))).toBe(true);
  });

  // witness also raises the noise hint when no style digests were comparable;
  // the verdict then says the styles were not compared, and so must this.
  it('says the verdict flags diffs whose styles could not be compared', () => {
    expect(clauses(description).some((c) => /styles (could not be|were not) compared/i.test(c))).toBe(true);
  });

  // Styles not compared is unknown, not noise: a stylesheet-only change is
  // not ruled out. The verdict says so, and the description must not tell
  // the model to treat that case as noise.
  it('does not call a diff whose styles were not compared noise', () => {
    const notCompared = clauses(description).filter((c) => /not (be )?compared/i.test(c));
    expect(notCompared.length).toBeGreaterThan(0);
    for (const c of notCompared) expect(c).not.toMatch(NOISE_ADVICE);
    expect(notCompared.some((c) => /could be render noise or a stylesheet-only change/i.test(c))).toBe(true);
    expect(notCompared.some((c) => /look at the diff/i.test(c))).toBe(true);
  });
});

/**
 * The review-visual-changes prompt decides how the model sorts each diff, so
 * it carries the same four cases as the verdicts: likely render noise (DOM
 * and computed styles match), style-only change, structural change, and
 * styles not compared (unknown: render noise or a stylesheet-only change).
 */
describe('review-visual-changes prompt', () => {
  const { REVIEW_PROMPT } = require('../tool-meta') as typeof import('../tool-meta');
  const text = REVIEW_PROMPT.text;

  it('is the prompt the server registers', () => {
    expect(REVIEW_PROMPT.name).toBe('review-visual-changes');
  });

  it('names the styles-not-compared case and sends the model to the images, not to noise', () => {
    const line = text.split('\n').find((l) => /styles not compared/i.test(l));
    expect(line).toBeDefined();
    expect(text).toMatch(/styles not compared[^.]*could be render noise or a stylesheet-only change/i);
    expect(text).toMatch(/styles not compared[^.]*get_diff/i);
  });

  it('only calls a diff likely render noise when the DOM and computed styles match', () => {
    expect(text).toMatch(/likely render noise \(identical DOM and computed styles match/i);
    // Every other mention of render noise is the unknown case, never a verdict.
    const bare = text.match(/(?<!likely )render noise(?! or a stylesheet-only change)/gi) ?? [];
    expect(bare).toEqual([]);
  });

  it('never recommends ignoring a diff as noise', () => {
    expect(text).not.toMatch(/ignore-as-noise|\bignore\b/i);
  });

  it('keeps baseline approval a human decision', () => {
    expect(text).toMatch(/baseline approval is a human decision/i);
    expect(text).toMatch(/Never call approve_snapshot\/approve_all yourself/);
  });
});

/**
 * Approving a baseline rewrites what "correct" means, so it must come from a
 * person. `anthropic/requiresUserInteraction` makes Claude Code show the
 * tool's permission prompt on every call, even in auto-approving permission
 * modes, so the approval happens in the user's terminal or UI. Clients that
 * don't know the key ignore it.
 */
const REQUIRES_USER = 'anthropic/requiresUserInteraction';
const APPROVE_TOOLS = ['approve_snapshot', 'approve_all'];
const metaOf = (name: string): ToolMeta => (TOOL_META as Record<string, ToolMeta>)[name];

describe('approval tools require a person to confirm every call', () => {
  it.each(APPROVE_TOOLS)('%s is marked as requiring user interaction', (name) => {
    expect(metaOf(name)._meta?.[REQUIRES_USER]).toBe(true);
  });

  it('no read-only tool forces a prompt', () => {
    const forced = Object.keys(TOOL_META).filter(
      (name) => !APPROVE_TOOLS.includes(name) && metaOf(name)._meta?.[REQUIRES_USER] !== undefined,
    );
    expect(forced).toEqual([]);
  });
});

describe('toolMetaFor (approval prompt setting)', () => {
  const { toolMetaFor } = require('../tool-meta') as typeof import('../tool-meta');

  it('marks the approve tools by default (approvalPrompt: true)', () => {
    expect(toolMetaFor({ approvalPrompt: true })).toEqual(TOOL_META);
  });

  it('drops the marker from every tool when the prompt is turned off, and changes nothing else', () => {
    const off = toolMetaFor({ approvalPrompt: false }) as Record<string, ToolMeta>;
    expect(Object.keys(off)).toEqual(Object.keys(TOOL_META));
    for (const [name, meta] of Object.entries(off)) {
      expect(meta._meta?.[REQUIRES_USER]).toBeUndefined();
      expect({ title: meta.title, description: meta.description }).toEqual({
        title: metaOf(name).title,
        description: metaOf(name).description,
      });
    }
  });
});
