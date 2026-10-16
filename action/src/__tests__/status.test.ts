/**
 * Tests for status builder
 */

import { determineStatus, resolveStatusContext, STATUS_CONTEXT } from '../status';
import type { ResultsData } from '../types';

describe('STATUS_CONTEXT', () => {
  it('T6.7 - context is TestivAI / visual', () => {
    expect(STATUS_CONTEXT).toBe('TestivAI / visual');
  });
});

describe('resolveStatusContext', () => {
  it('returns the provided status-context input', () => {
    expect(resolveStatusContext('TestivAI / visual (pytest)')).toBe('TestivAI / visual (pytest)');
  });

  it('falls back to the default when input is empty', () => {
    expect(resolveStatusContext('')).toBe(STATUS_CONTEXT);
  });

  it('falls back to the default when input is whitespace-only', () => {
    expect(resolveStatusContext('   ')).toBe(STATUS_CONTEXT);
  });

  it('trims surrounding whitespace from the input', () => {
    expect(resolveStatusContext('  TestivAI / e2e  ')).toBe('TestivAI / e2e');
  });
});

describe('determineStatus', () => {
  it('T6.8 - no diffs returns success', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 3, passed: 3, changed: 0, newSnapshots: 0 },
      snapshots: [],
    };

    const status = determineStatus(results, { failOnDiff: false });
    expect(status.state).toBe('success');
    expect(status.description).toContain('All 3 snapshots passed');
  });

  it('T6.9 - diffs + failOnDiff=true returns failure', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 3, passed: 1, changed: 2, newSnapshots: 0 },
      snapshots: [],
    };

    const status = determineStatus(results, { failOnDiff: true });
    expect(status.state).toBe('failure');
    expect(status.description).toContain('2 snapshots changed');
  });

  it('T6.10 - diffs + failOnDiff=false returns success', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 3, passed: 1, changed: 1, newSnapshots: 1 },
      snapshots: [],
    };

    const status = determineStatus(results, { failOnDiff: false });
    // The commit status has no `neutral`, so it stays green — but the check run
    // now says `neutral`, which is what a reviewer actually sees.
    expect(status.state).toBe('success');
    expect(status.conclusion).toBe('neutral');
    expect(status.description).toContain('review');
  });

  it('returns success for new snapshots only', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 2, passed: 0, changed: 0, newSnapshots: 2 },
      snapshots: [],
    };

    const status = determineStatus(results, { failOnDiff: true });
    expect(status.state).toBe('success');
    expect(status.description).toContain('new');
  });

  it('handles empty results', () => {
    const results: ResultsData = {
      timestamp: Date.now(),
      summary: { total: 0, passed: 0, changed: 0, newSnapshots: 0 },
      snapshots: [],
    };

    const status = determineStatus(results, { failOnDiff: false });
    expect(status.state).toBe('success');
    expect(status.description).toContain('No visual snapshots');
  });

  describe('check-run conclusions', () => {
    const results = (over: Partial<ResultsData['summary']> & { missingBaselines?: string[] }): ResultsData => {
      const { missingBaselines, ...summary } = over;
      return {
        timestamp: Date.now(),
        summary: { total: 4, passed: 4, changed: 0, newSnapshots: 0, ...summary },
        snapshots: [],
        ...(missingBaselines ? { missingBaselines } : {}),
      } as ResultsData;
    };

    it('is success only when nothing needs a human', () => {
      const s = determineStatus(results({}), { failOnDiff: false });
      expect(s.conclusion).toBe('success');
      expect(s.state).toBe('success');
    });

    // summary.passed counts snapshots that witness auto-passed through a
    // configured pass criterion (maxDiffPercent / maxDiffPixels /
    // shiftTolerance / noiseAutoPass), so a real pixel diff may be among
    // them: "nothing detected" would be false.
    it('all-passed summary does not claim nothing was detected', () => {
      const s = determineStatus(results({}), { failOnDiff: false });
      expect(s.summary).toBe(
        'No visual changes need review (diffs within your configured pass criteria count as passed).',
      );
      expect(s.summary).not.toMatch(/detected/i);
    });

    it('is neutral for changes when not gating — not a green tick', () => {
      const s = determineStatus(results({ passed: 1, changed: 3 }), { failOnDiff: false });
      expect(s.conclusion).toBe('neutral');
      expect(s.title).toContain('needs review');
      expect(s.summary).toContain('does not block');
    });

    it('is neutral for new snapshots awaiting a baseline', () => {
      const s = determineStatus(results({ passed: 2, newSnapshots: 2 }), { failOnDiff: false });
      expect(s.conclusion).toBe('neutral');
    });

    it('is failure for changes when the team opted in', () => {
      const s = determineStatus(results({ passed: 1, changed: 3 }), { failOnDiff: true });
      expect(s.conclusion).toBe('failure');
      expect(s.state).toBe('failure');
    });

    describe('missing baselines', () => {
      const missing = results({
        total: 2,
        passed: 2,
        missing: 2,
        missingBaselines: ['checkout', 'pricing'],
      } as never);

      it('surfaces them at all — they used to be invisible', () => {
        const s = determineStatus(missing, { failOnDiff: false });
        expect(s.title).toContain('received no capture');
        expect(s.summary).toContain('checkout');
        expect(s.summary).toContain('pricing');
      });

      it('is neutral by default', () => {
        expect(determineStatus(missing, { failOnDiff: false }).conclusion).toBe('neutral');
      });

      it('fails when fail-on-missing is set', () => {
        const s = determineStatus(missing, { failOnDiff: false, failOnMissing: true });
        expect(s.conclusion).toBe('failure');
        expect(s.state).toBe('failure');
      });

      it('takes precedence over changes — lost coverage is the harder miss', () => {
        const both = results({
          total: 3,
          passed: 1,
          changed: 2,
          missing: 1,
          missingBaselines: ['gone'],
        } as never);
        expect(determineStatus(both, { failOnDiff: false }).title).toContain('received no capture');
      });
    });
  });
});