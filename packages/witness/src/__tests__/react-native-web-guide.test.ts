/**
 * docs/guides/react-native-web.md states facts that live elsewhere in the
 * repo: the config the Expo example commits, the versions it was verified
 * with, and links into other docs. This keeps the guide from drifting away
 * from them: the config block is the example's config, the versions are the
 * example's, and every relative link and #anchor resolves.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const GUIDE = 'docs/guides/react-native-web.md';
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf-8');

/** GitHub / Docusaurus heading slug: lower case, punctuation dropped, spaces to dashes. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsOf(markdown: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m) out.add(slug(m[1]));
  }
  return out;
}

describe('docs/guides/react-native-web.md', () => {
  const guide = read(GUIDE);

  it('has a title in its front matter', () => {
    expect(guide).toMatch(/^---\ntitle: .+\n---\n/);
  });

  it('shows the config the Expo example commits, exactly', () => {
    const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
    const example = JSON.parse(read('examples/expo-web/.testivai/config.json'));
    expect(blocks).toContainEqual(example);
  });

  it('names the versions the example pins', () => {
    const pkg = JSON.parse(read('examples/expo-web/package.json'));
    const versions = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    expect(guide).toContain(`Expo SDK ${versions.expo.replace(/^~/, '').split('.')[0]}`);
    expect(guide).toContain(`react-native-web ${versions['react-native-web'].replace(/^~/, '')}`);
    expect(guide).toContain(`@playwright/test ${versions['@playwright/test']}`);
  });

  it('every relative link and anchor resolves', () => {
    const dir = path.dirname(GUIDE);
    const links = [...guide.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) {
      const [file, anchor] = link.split('#');
      const target = file ? path.normalize(path.join(dir, file)) : GUIDE;
      expect({ link, exists: fs.existsSync(path.join(ROOT, target)) }).toEqual({ link, exists: true });
      if (anchor && target.endsWith('.md')) {
        expect({ link, anchor: anchorsOf(read(target)).has(anchor) }).toEqual({ link, anchor: true });
      }
    }
  });

  it('is linked from the docs index and the mobile web guide', () => {
    expect(read('docs/README.md')).toContain('(./guides/react-native-web.md)');
    expect(read('docs/guides/mobile-web.md')).toContain('(./react-native-web.md)');
  });
});
