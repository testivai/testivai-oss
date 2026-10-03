import { TOOL_META } from '../tool-meta';

/**
 * The model reads a tool's description before it calls the tool, so the
 * description must not contradict the verdicts the tool returns (verdictFor).
 * Since witness 1.6.0 an identical DOM is not enough to call a diff noise:
 * the computed styles must match too, and a style-only change is real.
 */
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
});
