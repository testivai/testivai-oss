/**
 * rotateAndWait (android-helpers.ts) against a fake `adb` on PATH: the
 * screen stays portrait for a set number of screencaps, then turns. No
 * emulator needed; the real one is exercised by android-native.ts in CI.
 */

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rotateAndWait } from './android-helpers';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-'));
const state = path.join(dir, 'state.json');
const calls = path.join(dir, 'calls.log');

// The fake adb: `exec-out screencap -p` prints a PNG header whose size is
// portrait until `portraitFor` screencaps have been taken; everything else
// is recorded and succeeds.
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/usr/bin/env node
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
if (args.join(' ') === 'exec-out screencap -p') {
  const landscape = s.shots >= s.portraitFor;
  s.shots += 1;
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(landscape ? 2400 : 1080, 16);
  png.writeUInt32BE(landscape ? 1080 : 2400, 20);
  process.stdout.write(png);
}
`,
  { mode: 0o755 },
);
process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;

function setup(portraitFor: number): void {
  fs.writeFileSync(state, JSON.stringify({ shots: 0, portraitFor }));
  fs.writeFileSync(calls, '');
}
const rotations = () => fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.includes('user_rotation'));
const shots = () => (JSON.parse(fs.readFileSync(state, 'utf8')) as { shots: number }).shots;

async function main(): Promise<void> {
  // Already turned: one look, one request.
  setup(0);
  await rotateAndWait(1, { timeoutMs: 2000, pollMs: 10 });
  assert.deepEqual(rotations(), ['shell settings put system user_rotation 1']);
  assert.equal(shots(), 1);
  console.log('✓ returns as soon as the screen is landscape');

  // Slow turn: waits for it instead of capturing a portrait screen.
  setup(5);
  await rotateAndWait(1, { timeoutMs: 5000, pollMs: 10 });
  assert.equal(shots(), 6);
  assert.equal(rotations().length, 1);
  console.log('✓ waits until the turn has happened (5 portrait screens, then landscape)');

  // Still portrait halfway: asks once more, and only once.
  setup(Number.MAX_SAFE_INTEGER);
  await assert.rejects(rotateAndWait(1, { timeoutMs: 300, pollMs: 20 }), /the display did not turn: 1080x2400 after \d+ ms/);
  assert.deepEqual(rotations(), ['shell settings put system user_rotation 1', 'shell settings put system user_rotation 1']);
  console.log('✓ asks again once halfway, then fails with the size it saw');

  // Back to portrait: portrait counts as done.
  fs.writeFileSync(state, JSON.stringify({ shots: 0, portraitFor: Number.MAX_SAFE_INTEGER }));
  fs.writeFileSync(calls, '');
  await rotateAndWait(0, { timeoutMs: 2000, pollMs: 10 });
  assert.deepEqual(rotations(), ['shell settings put system user_rotation 0']);
  console.log('✓ a turn back to portrait waits for portrait');
}

main()
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
