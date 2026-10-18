/**
 * Tests for status builder
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
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

      it('leads the title over changes — lost coverage is the harder miss', () => {
        const both = results({
          total: 3,
          passed: 1,
          changed: 2,
          missing: 1,
          missingBaselines: ['gone'],
        } as never);
        expect(determineStatus(both, { failOnDiff: false }).title).toContain('received no capture');
      });

      // Missing baselines come first in the message, never in the gate: a
      // pull request that drops one snapshot must not wave through a change
      // to another (the CLI's exit codes rank changed above missing too).
      describe('with changed or new snapshots in the same run', () => {
        const both = results({
          total: 3,
          passed: 1,
          changed: 2,
          missing: 1,
          missingBaselines: ['gone'],
        } as never);

        it('still fails on the changes when fail-on-diff is set', () => {
          const s = determineStatus(both, { failOnDiff: true });
          expect(s.conclusion).toBe('failure');
          expect(s.state).toBe('failure');
          expect(s.description).toBe('2 snapshots changed');
          // The check run shows only the title and summary (index.ts), so they
          // say what failed it, not just the missing baseline that leads them.
          expect(s.title).toBe('1 baseline received no capture; 2 changed — visual regression');
          expect(s.summary).toMatch(/^Fails the check: 2 snapshots changed\.\n\n/);
          expect(s.summary).toContain('gone');
          expect(s.summary).toContain('Also 2 changed');
          expect(s.summary).toContain('/testivai approve');
        });

        it('fails on the missing baseline alone when only fail-on-missing is set', () => {
          const s = determineStatus(both, { failOnDiff: false, failOnMissing: true });
          expect(s.conclusion).toBe('failure');
          expect(s.description).toBe('1 baseline not covered');
          expect(s.title).toBe('1 baseline received no capture; 2 changed');
          expect(s.summary).toMatch(/^Fails the check: 1 baseline not covered\.\n\n/);
        });

        it('names both reasons when both inputs fail the run', () => {
          const s = determineStatus(both, { failOnDiff: true, failOnMissing: true });
          expect(s.conclusion).toBe('failure');
          expect(s.description).toBe('2 snapshots changed, 1 baseline not covered');
        });

        it('stays neutral without either input, and says what else needs review', () => {
          const s = determineStatus(both, { failOnDiff: false });
          expect(s.conclusion).toBe('neutral');
          expect(s.state).toBe('success');
          expect(s.description).toBe('1 baseline not covered, 2 changed — review');
          expect(s.summary).not.toContain('Fails the check');
          expect(s.summary).toContain('gone');
          expect(s.summary).toContain('2 changed');
          expect(s.summary).toContain('/testivai approve');
        });

        it('never fails on new snapshots, whatever fail-on-diff says', () => {
          const added = results({
            total: 2,
            passed: 1,
            newSnapshots: 1,
            missing: 1,
            missingBaselines: ['gone'],
          } as never);
          const s = determineStatus(added, { failOnDiff: true });
          expect(s.conclusion).toBe('neutral');
          expect(s.title).toContain('1 new');
        });
      });
    });
  });
});

describe('docs: what the Action posts', () => {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const tableRows = (doc: string) =>
    doc
      .split('\n')
      .filter((line) => line.startsWith('| '))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  // The check-run table: | Situation | Conclusion | Blocks the merge? |
  const statusRows = tableRows(read('docs/github-action.md')).filter(
    (cells) => cells.length === 3 && /`(failure|neutral|success)`/.test(cells[1]),
  );

  it('says a missing baseline does not stop a changed snapshot from failing the check', () => {
    const both = statusRows.filter(([situation]) => /changed/i.test(situation) && /no capture/i.test(situation));
    expect(both.length).toBeGreaterThan(0);
    for (const [situation, conclusion, blocks] of both) {
      if (!situation.includes('`fail-on-diff: true`')) continue;
      expect(conclusion).toBe('`failure`');
      expect(blocks).toBe('yes');
    }
    expect(both.some(([situation]) => situation.includes('`fail-on-diff: true`'))).toBe(true);
  });

  it('lists every action.yml input in both Inputs tables', () => {
    const inputs = Object.keys(parse(read('action.yml')).inputs as Record<string, unknown>);
    for (const file of ['docs/github-action.md', 'action/README.md']) {
      const listed = tableRows(read(file)).map(([name]) => name);
      for (const input of inputs) expect({ file, input, listed: listed.includes(`\`${input}\``) }).toEqual({ file, input, listed: true });
    }
  });
});
