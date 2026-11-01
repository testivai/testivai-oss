/**
 * merge-captures — unioning sharded captures.
 *
 * These mirror the shapes a real sharded CI run produces, including the two
 * directory layouts (`download-artifact` parents vs. a temp dir copied
 * directly) and the shard that legitimately ran no tests.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeCaptures } from '../../commands/merge-captures';
import { MERGE_RECORD } from '../../capture/shard';

function writeManifest(dir: string, current: number, total: number): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'testivai-shard.json'),
    JSON.stringify({ shard: { current, total }, status: 'passed' }),
  );
}

function makeCapture(dir: string, name: string, bytes = 'png'): void {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'screenshot.png'), bytes);
  fs.writeFileSync(path.join(d, 'dom.html'), `<html><!-- ${name} --></html>`);
  fs.writeFileSync(path.join(d, 'elements.json'), '[]');
}

describe('mergeCaptures', () => {
  let root: string;
  let dest: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-captures-'));
    dest = path.join(root, 'project', '.testivai', 'temp');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('unions captures from download-artifact style parents', () => {
    // collected/temp-shard-N/<snapshot>/screenshot.png
    const collected = path.join(root, 'collected');
    makeCapture(path.join(collected, 'temp-shard-1'), 'home');
    makeCapture(path.join(collected, 'temp-shard-2'), 'buttons');
    makeCapture(path.join(collected, 'temp-shard-3'), 'products');

    const result = mergeCaptures([collected], dest);

    expect(result.merged).toEqual(['buttons', 'home', 'products']);
    expect(result.conflicts).toEqual([]);
    for (const name of result.merged) {
      expect(fs.existsSync(path.join(dest, name, 'screenshot.png'))).toBe(true);
      expect(fs.existsSync(path.join(dest, name, 'dom.html'))).toBe(true);
      expect(fs.existsSync(path.join(dest, name, 'elements.json'))).toBe(true);
    }
  });

  it('accepts temp directories passed directly', () => {
    const a = path.join(root, 'tempA');
    const b = path.join(root, 'tempB');
    makeCapture(a, 'home');
    makeCapture(b, 'checkout');

    const result = mergeCaptures([a, b], dest);

    expect(result.merged).toEqual(['checkout', 'home']);
  });

  it('reports a shard that captured nothing without failing', () => {
    const collected = path.join(root, 'collected');
    makeCapture(path.join(collected, 'temp-shard-1'), 'home');
    // shard 2 ran no tests: artifact directory exists but holds no captures
    fs.mkdirSync(path.join(collected, 'temp-shard-2'), { recursive: true });
    const missing = path.join(root, 'never-uploaded');

    const result = mergeCaptures([collected, missing], dest);

    expect(result.merged).toEqual(['home']);
    expect(result.empty).toContain(missing);
  });

  it('flags the same snapshot arriving from two shards', () => {
    const collected = path.join(root, 'collected');
    makeCapture(path.join(collected, 'temp-shard-1'), 'home', 'first');
    makeCapture(path.join(collected, 'temp-shard-2'), 'home', 'second');

    const result = mergeCaptures([collected], dest);

    expect(result.merged).toEqual(['home']);
    expect(result.conflicts).toEqual(['home']);
    // last write wins, deterministically
    expect(fs.readFileSync(path.join(dest, 'home', 'screenshot.png'), 'utf-8')).toBe('second');
  });

  it('creates the destination when the project has no temp dir yet', () => {
    const collected = path.join(root, 'collected');
    makeCapture(path.join(collected, 'temp-shard-1'), 'home');

    expect(fs.existsSync(dest)).toBe(false);
    mergeCaptures([collected], dest);
    expect(fs.existsSync(path.join(dest, 'home'))).toBe(true);
  });

  it('ignores directories that are not captures', () => {
    const collected = path.join(root, 'collected');
    makeCapture(path.join(collected, 'temp-shard-1'), 'home');
    // a stray directory with no screenshot.png must not be treated as a capture
    fs.mkdirSync(path.join(collected, 'temp-shard-1', 'not-a-capture'), { recursive: true });
    fs.writeFileSync(path.join(collected, 'temp-shard-1', 'not-a-capture', 'notes.txt'), 'x');

    const result = mergeCaptures([collected], dest);

    expect(result.merged).toEqual(['home']);
  });

  describe('shard completeness', () => {
    it('confirms every shard reported', () => {
      const collected = path.join(root, 'collected');
      for (let i = 1; i <= 3; i++) {
        const d = path.join(collected, `captures-${i}`);
        makeCapture(d, `snap-${i}`);
        writeManifest(d, i, 3);
      }

      const r = mergeCaptures([collected], dest);

      expect(r.shardTotal).toBe(3);
      expect(r.shardsSeen).toEqual([1, 2, 3]);
      expect(r.shardsMissing).toEqual([]);
    });

    // The hole this closes: a crashed shard uploads nothing, so with
    // failOnMissing off the run would otherwise pass on partial coverage.
    it('names the shards that never reported', () => {
      const collected = path.join(root, 'collected');
      for (const i of [1, 2, 5]) {
        const d = path.join(collected, `captures-${i}`);
        makeCapture(d, `snap-${i}`);
        writeManifest(d, i, 5);
      }

      const r = mergeCaptures([collected], dest);

      expect(r.shardTotal).toBe(5);
      expect(r.shardsSeen).toEqual([1, 2, 5]);
      expect(r.shardsMissing).toEqual([3, 4]);
    });

    it('infers the total from the manifests, so --expect is optional', () => {
      const collected = path.join(root, 'collected');
      const d = path.join(collected, 'captures-1');
      makeCapture(d, 'only');
      writeManifest(d, 1, 8);

      const r = mergeCaptures([collected], dest);

      expect(r.shardTotal).toBe(8);
      expect(r.shardsMissing).toEqual([2, 3, 4, 5, 6, 7, 8]);
    });

    it('lets --expect override the declared total', () => {
      const collected = path.join(root, 'collected');
      for (const i of [1, 2]) {
        const d = path.join(collected, `captures-${i}`);
        makeCapture(d, `snap-${i}`);
        writeManifest(d, i, 2);
      }

      const r = mergeCaptures([collected], dest, { expect: 4 });

      expect(r.shardTotal).toBe(4);
      expect(r.shardsMissing).toEqual([3, 4]);
    });

    it('reports no shard data for an unsharded merge', () => {
      const collected = path.join(root, 'collected');
      makeCapture(path.join(collected, 'temp-shard-1'), 'home');

      const r = mergeCaptures([collected], dest);

      expect(r.shardTotal).toBeNull();
      expect(r.shardsMissing).toEqual([]);
      expect(r.merged).toEqual(['home']);
    });

    it('counts a shard that captured nothing but did report', () => {
      const collected = path.join(root, 'collected');
      const a = path.join(collected, 'captures-1');
      makeCapture(a, 'home');
      writeManifest(a, 1, 2);
      // shard 2 ran no tests: manifest present, no capture dirs
      writeManifest(path.join(collected, 'captures-2'), 2, 2);

      const r = mergeCaptures([collected], dest);

      expect(r.shardsSeen).toEqual([1, 2]);
      expect(r.shardsMissing).toEqual([]);
      expect(r.merged).toEqual(['home']);
    });

    it('ignores a malformed manifest rather than crashing', () => {
      const collected = path.join(root, 'collected');
      const d = path.join(collected, 'captures-1');
      makeCapture(d, 'home');
      fs.writeFileSync(path.join(d, 'testivai-shard.json'), 'not json');

      const r = mergeCaptures([collected], dest);

      expect(r.merged).toEqual(['home']);
      expect(r.shardTotal).toBeNull();
    });
  });

  /**
   * The merge record in the destination: whether every shard reported. When
   * the merge fails, the comparison after it does not run, and the GitHub
   * Action (run after a failure too) reads this to know the captures it finds
   * in .testivai/temp/ are part of the suite, and not compare them.
   */
  describe('merge record', () => {
    const readRecord = () => JSON.parse(fs.readFileSync(path.join(dest, MERGE_RECORD), 'utf-8'));

    it('names the shards that never reported', () => {
      const collected = path.join(root, 'collected');
      for (const i of [1, 2, 3]) {
        const d = path.join(collected, `captures-${i}`);
        makeCapture(d, `page-${i}`);
        writeManifest(d, i, 4);
      }

      mergeCaptures([collected], dest);

      expect(readRecord()).toMatchObject({ shardTotal: 4, shardsSeen: [1, 2, 3], shardsMissing: [4], merged: 3 });
    });

    it('says every shard reported when they all did', () => {
      const collected = path.join(root, 'collected');
      for (const i of [1, 2]) {
        const d = path.join(collected, `captures-${i}`);
        makeCapture(d, `page-${i}`);
        writeManifest(d, i, 2);
      }

      mergeCaptures([collected], dest);

      expect(readRecord()).toMatchObject({ shardTotal: 2, shardsSeen: [1, 2], shardsMissing: [], merged: 2 });
    });

    it('records an unsharded merge with no shard total', () => {
      makeCapture(path.join(root, 'collected', 'temp-shard-1'), 'home');

      mergeCaptures([path.join(root, 'collected')], dest);

      expect(readRecord()).toMatchObject({ shardTotal: null, shardsMissing: [], merged: 1 });
    });

    it('is a file beside the captures, never a capture itself', () => {
      makeCapture(path.join(root, 'collected', 'temp-shard-1'), 'home');

      mergeCaptures([path.join(root, 'collected')], dest);

      expect(fs.statSync(path.join(dest, MERGE_RECORD)).isFile()).toBe(true);
      expect(fs.readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)).toEqual(['home']);
    });
  });
});
