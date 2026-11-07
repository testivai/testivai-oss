/**
 * disablePlayServices (android-helpers.ts) against a fake `adb` on PATH.
 *
 * On the google_apis emulator image, Google Play Services applies a module
 * update about two minutes after boot and kills its own processes to restart
 * ("Module config changed, forcing restart"). Android then kills every app
 * that uses one of its providers: the WebView fixture uses its FontsProvider,
 * so the app and its WebView renderer died mid-check (#266, #270). The checks
 * disable Play Services before any app under test starts.
 */

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { disablePlayServices } from './android-helpers';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-adb-gms-'));
const state = path.join(dir, 'state.json');
const calls = path.join(dir, 'calls.log');

// The fake adb knows whether com.google.android.gms is installed and
// enabled; `pm disable-user` disables it unless `stuck` is set.
fs.writeFileSync(
  path.join(dir, 'adb'),
  `#!/usr/bin/env node
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(calls)}, args + '\\n');
const GMS = 'com.google.android.gms';
if (args === 'shell pm list packages ' + GMS) {
  if (s.installed) process.stdout.write('package:' + GMS + '\\npackage:' + GMS + '.policy_sidecar_aps\\n');
} else if (args === 'shell pm list packages -d ' + GMS) {
  if (s.installed && s.disabled) process.stdout.write('package:' + GMS + '\\n');
} else if (args === 'shell pm disable-user --user 0 ' + GMS) {
  if (!s.installed) { process.stderr.write('Unknown package: ' + GMS + '\\n'); process.exit(1); }
  if (!s.stuck) s.disabled = true;
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
  process.stdout.write('Package ' + GMS + ' new state: disabled-user\\n');
}
`,
  { mode: 0o755 },
);
process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;

function setup(s: { installed: boolean; disabled?: boolean; stuck?: boolean }): void {
  fs.writeFileSync(state, JSON.stringify({ disabled: false, stuck: false, ...s }));
  fs.writeFileSync(calls, '');
}
const disables = () => fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.includes('disable-user'));

try {
  setup({ installed: true });
  assert.equal(disablePlayServices(), 'disabled');
  assert.deepEqual(disables(), ['shell pm disable-user --user 0 com.google.android.gms']);
  console.log('✓ disables Play Services when the image has it, and checks it is disabled');

  setup({ installed: true, disabled: true });
  assert.equal(disablePlayServices(), 'disabled');
  console.log('✓ already disabled is fine (the second check calls it again)');

  setup({ installed: false });
  assert.equal(disablePlayServices(), 'not installed');
  assert.deepEqual(disables(), []);
  console.log('✓ an image without Play Services needs nothing');

  setup({ installed: true, stuck: true });
  assert.throws(() => disablePlayServices(), /fixture: Google Play Services is still enabled/);
  console.log('✓ fails, as a fixture problem, when Play Services stays enabled');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
