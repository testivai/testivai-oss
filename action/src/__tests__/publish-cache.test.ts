/**
 * The report cache: the report ZIPs a publish downloaded, kept in a folder
 * that publish/action.yml restores and saves with actions/cache.
 *
 * Nothing in the folder is trusted. An entry is used only when its SHA-256 is
 * the digest GitHub lists for the artifact; anything else (other bytes, a cut
 * short file, a symbolic link, a directory, a stray name) is a miss, and
 * goes when the build prunes the folder. The folder never makes the publish
 * fail.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openReportCache } from '../publish/cache';

const sha256 = (bytes: Uint8Array) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 10, 20, 30, 40]);
const OTHER = new Uint8Array([0x50, 0x4b, 3, 4, 99]);
const MB = 1024 * 1024;

let dir: string;
let cacheDir: string;
const log = { info: jest.fn(), notice: jest.fn(), warning: jest.fn() };
const open = (over: { maxEntryBytes?: number } = {}) => openReportCache(cacheDir, { log, maxEntryBytes: 150 * MB, ...over });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-cache-'));
  cacheDir = path.join(dir, 'cache');
  jest.clearAllMocks();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('openReportCache', () => {
  it('creates the folder', () => {
    open();

    expect(fs.lstatSync(cacheDir).isDirectory()).toBe(true);
  });

  it('replaces a symbolic link in its place with a folder of its own, and never touches the target', () => {
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, '30.zip'), ZIP);
    fs.symlinkSync(elsewhere, cacheDir);

    const cache = open();
    cache.prune();

    expect(fs.lstatSync(cacheDir).isDirectory()).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual(['30.zip']);
  });

  it('replaces a file in its place', () => {
    fs.writeFileSync(cacheDir, 'not a folder');

    const cache = open();
    cache.write(30, sha256(ZIP), ZIP);

    expect(fs.readdirSync(cacheDir)).toEqual(['30.zip']);
  });

  it('turns itself off, with a warning, when the folder cannot be made', () => {
    const blocked = path.join(dir, 'file');
    fs.writeFileSync(blocked, 'x');
    const cache = openReportCache(path.join(blocked, 'cache'), { log, maxEntryBytes: 150 * MB });

    cache.write(30, sha256(ZIP), ZIP);

    expect(cache.read(30, sha256(ZIP))).toBeUndefined();
    expect(() => cache.prune()).not.toThrow();
    expect(cache.stats).toMatchObject({ hits: 0, stored: 0, removed: 0 });
    expect(log.warning).toHaveBeenCalledWith(expect.stringMatching(/report cache.*not used/i));
  });
});

describe('read and write', () => {
  it('returns a stored ZIP when its SHA-256 is the digest GitHub lists', () => {
    open().write(30, sha256(ZIP), ZIP);

    const cache = open();
    const read = cache.read(30, sha256(ZIP));

    expect(read && Buffer.from(read).equals(Buffer.from(ZIP))).toBe(true);
    expect(cache.stats).toMatchObject({ hits: 1, hitBytes: ZIP.length, stored: 0 });
  });

  it('misses an artifact it has not stored', () => {
    expect(open().read(30, sha256(ZIP))).toBeUndefined();
  });

  it.each([undefined, '', 'md5:abc', 'sha256:xyz', `sha1:${'a'.repeat(40)}`, `sha256:${'a'.repeat(63)}`])(
    'neither stores nor reads anything without a SHA-256 digest (%j)',
    (digest) => {
      const cache = open();
      cache.write(30, digest, ZIP);
      fs.writeFileSync(path.join(cacheDir, '30.zip'), ZIP);

      expect(cache.read(30, digest)).toBeUndefined();
      expect(cache.stats.stored).toBe(0);
    },
  );

  it('accepts the digest in capitals too', () => {
    const cache = open();
    cache.write(30, sha256(ZIP).toUpperCase().replace('SHA256', 'sha256'), ZIP);

    expect(cache.read(30, sha256(ZIP))).toBeDefined();
  });

  it('does not keep a download that is not the ZIP the digest names, and says so', () => {
    const cache = open();

    cache.write(30, sha256(OTHER), ZIP);

    expect(fs.existsSync(path.join(cacheDir, '30.zip'))).toBe(false);
    expect(log.warning).toHaveBeenCalledWith(expect.stringMatching(/artifact 30.*digest/));
  });

  it.each([
    ['other bytes', () => OTHER],
    ['cut short', () => ZIP.slice(0, 5)],
    ['empty', () => new Uint8Array(0)],
  ])('treats an entry with %s as a miss and removes it', (_, bytes) => {
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, '30.zip'), bytes());
    const cache = open();

    expect(cache.read(30, sha256(ZIP))).toBeUndefined();
    expect(fs.existsSync(path.join(cacheDir, '30.zip'))).toBe(false);
    expect(cache.stats.hits).toBe(0);
  });

  it('never reads through a symbolic link, and writing replaces the link, not its target', () => {
    const outside = path.join(dir, 'outside.zip');
    fs.writeFileSync(outside, ZIP);
    fs.mkdirSync(cacheDir);
    fs.symlinkSync(outside, path.join(cacheDir, '30.zip'));
    const cache = open();

    expect(cache.read(30, sha256(ZIP))).toBeUndefined();
    cache.write(30, sha256(OTHER), OTHER);

    expect(fs.lstatSync(path.join(cacheDir, '30.zip')).isFile()).toBe(true);
    expect(Buffer.from(fs.readFileSync(outside)).equals(Buffer.from(ZIP))).toBe(true);
  });

  it('treats a directory in an entry’s place as a miss, and replaces it on write', () => {
    fs.mkdirSync(path.join(cacheDir, '30.zip'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, '30.zip', 'inside'), 'x');
    const cache = open();

    expect(cache.read(30, sha256(ZIP))).toBeUndefined();
    cache.write(30, sha256(ZIP), ZIP);

    expect(cache.read(30, sha256(ZIP))).toBeDefined();
  });

  it('does not read an entry over the size limit, nor keep a download over it', () => {
    const big = new Uint8Array(2048);
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, '30.zip'), big);
    const cache = open({ maxEntryBytes: 1024 });

    expect(cache.read(30, sha256(big))).toBeUndefined();
    cache.write(31, sha256(big), big);

    expect(fs.existsSync(path.join(cacheDir, '31.zip'))).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])('takes only a whole positive artifact id (%p)', (id) => {
    const cache = open();

    cache.write(id, sha256(ZIP), ZIP);

    expect(cache.read(id, sha256(ZIP))).toBeUndefined();
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });
});

describe('prune', () => {
  it('removes every entry this build did not read or store, and anything else in the folder', () => {
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep-me'), 'x');
    const seed = open();
    seed.write(10, sha256(ZIP), ZIP);
    seed.write(99, sha256(ZIP), ZIP);
    fs.writeFileSync(path.join(cacheDir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(cacheDir, '20.zip.tmp'), 'x');
    fs.mkdirSync(path.join(cacheDir, 'nested'));
    fs.symlinkSync(outside, path.join(cacheDir, '40.zip'));

    const cache = open();
    cache.read(10, sha256(ZIP));
    cache.write(30, sha256(OTHER), OTHER);
    cache.prune();

    expect(fs.readdirSync(cacheDir).sort()).toEqual(['10.zip', '30.zip']);
    expect(fs.readdirSync(outside)).toEqual(['keep-me']);
    expect(cache.stats).toMatchObject({ hits: 1, stored: 1, removed: 5 });
  });

  it('removes nothing when the build used every entry', () => {
    open().write(10, sha256(ZIP), ZIP);
    const cache = open();
    cache.read(10, sha256(ZIP));

    cache.prune();

    expect(cache.stats).toMatchObject({ hits: 1, stored: 0, removed: 0 });
  });
});
