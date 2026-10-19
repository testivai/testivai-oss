/**
 * The results.json schema is documented in three places that must agree:
 * docs/extension-api.md (the full field table), the "results.json schema"
 * block in CLAUDE.md and the "Public contract" block in AGENTS.md (the same
 * example and reading rules for coding agents). Drift between them misleads
 * whoever reads the one that was not updated.
 */
import * as fs from 'fs';
import * as path from 'path';
import { RESULTS_SCHEMA_VERSION } from '../report/generator';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf-8');

/** From the schema section's json block to the line the section's prose ends at. */
function schemaSection(file: string, heading: string, endsAt: RegExp): string {
  const text = read(file);
  const start = text.indexOf('```json', text.indexOf(heading));
  if (start === -1) throw new Error(`${file}: no json block after "${heading}"`);
  const rest = text.slice(start);
  const end = rest.search(endsAt);
  return end === -1 ? rest : rest.slice(0, end).trimEnd();
}

describe('results.json schema documents', () => {
  const claude = schemaSection('CLAUDE.md', '## results.json schema', /^Exit-code contract/m);
  const agents = schemaSection('AGENTS.md', '## Public contract', /^Breaking changes/m);
  const extensionApi = read('docs/extension-api.md');

  it('CLAUDE.md and AGENTS.md carry the same example and reading rules', () => {
    expect(agents).toBe(claude);
  });

  it('every document names the current schema version', () => {
    expect(claude).toContain(`"version": "${RESULTS_SCHEMA_VERSION}"`);
    expect(extensionApi).toContain(`"version": "${RESULTS_SCHEMA_VERSION}"`);
  });

  it('the capture-provenance fields are documented in all three', () => {
    for (const doc of [claude, extensionApi]) {
      expect(doc).toContain('"environment"');
      expect(doc).toContain('"renderingDelta"');
    }
    for (const field of [
      '`environment`',
      '`snapshots[].environment`',
      '`snapshots[].environment.delta`',
      '`snapshots[].environment.renderingDelta`',
      '`snapshots[].environment.baseline` / `.candidate`',
      '`snapshots[].environment.policy`',
    ]) {
      expect(extensionApi).toContain(`| ${field} |`);
    }
  });

  it('the capture-health fields (schema 2.6.0) are documented in all three', () => {
    for (const doc of [claude, extensionApi]) {
      expect(doc).toContain('"captureHealth"');
      expect(doc).toContain('"unhealthy"');
    }
    for (const field of [
      '`snapshots[].captureHealth`',
      '`snapshots[].captureHealth.candidate` / `.baseline`',
      '`snapshots[].captureHealth.unhealthy`',
      '`snapshots[].captureHealth.reasons`',
      '`snapshots[].captureHealth.warnings`',
    ]) {
      expect(extensionApi).toContain(`| ${field} |`);
    }
  });

  it('the metadata.json health block is documented for community adapters', () => {
    expect(extensionApi).toMatch(/### Capture health: `health` in metadata\.json/);
    for (const field of ['fonts.status', 'fonts.failed[]', 'stylesheets.failed', 'images.broken', 'resources.status']) {
      expect(extensionApi).toContain(`\`${field}\``);
    }
  });

  it('the metadata.json environment block every adapter writes is documented for community adapters', () => {
    expect(extensionApi).toMatch(/### Capture provenance: `environment` in metadata\.json/);
    for (const field of ['os.platform', 'browser.name', 'adapter.captureMethod', 'render.deviceScaleFactor']) {
      expect(extensionApi).toContain(`\`${field}\``);
    }
  });
});
