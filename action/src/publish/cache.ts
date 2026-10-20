/**
 * Report ZIPs kept between publishes, so a publish downloads only the runs it
 * has not built before.
 *
 * A run's report never changes: a re-run uploads a new artifact, with a new
 * id. So each ZIP a build downloads is kept here as <artifact id>.zip, and
 * publish/action.yml restores and saves the folder with actions/cache. What
 * is kept is the artifact as GitHub serves it, not a page built from it:
 * every page is still rebuilt from the report on every publish, by the same
 * checks as a download, so a page never depends on what an earlier publish
 * built, and the site is byte for byte the one a build without the cache
 * writes.
 *
 * Nothing in the folder is trusted. Any workflow run on the default branch
 * can save an Actions cache under any key, so an entry is used only when its
 * SHA-256 is the digest GitHub lists for the artifact (upload-artifact v4 and
 * later); an artifact without one is never kept. Other bytes, a file cut
 * short, a symbolic link, a named pipe, a directory or a name that is not
 * <number>.zip is a miss: the report is downloaded again, and prune()
 * removes the rest. The cache never fails the publish: when the folder
 * cannot be used, every report is downloaded, as without it.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Log } from './build';

export interface ReportCacheStats {
  /** Reports read from the cache, and their bytes. */
  hits: number;
  hitBytes: number;
  /** Downloads kept for the next publish. */
  stored: number;
  /** Entries prune() removed: reports no longer published, and anything else in the folder. */
  removed: number;
}

export interface ReportCache {
  /** The artifact's ZIP, when the cache holds one whose SHA-256 is the digest GitHub lists for it. */
  read(artifactId: number, digest: string | undefined): Uint8Array | undefined;
  /** Keep a downloaded ZIP for the next publish, when it is the one the digest names. */
  write(artifactId: number, digest: string | undefined, zip: Uint8Array): void;
  /** Remove everything this build did not read or write, so the cache holds one site's reports at most. */
  prune(): void;
  readonly stats: ReportCacheStats;
}

export interface ReportCacheOptions {
  log: Log;
  /** No entry is read or kept over this size (one run's report limit). */
  maxEntryBytes: number;
}

const DIGEST = /^sha256:([0-9a-f]{64})$/i;

/**
 * Read-only, not through a symbolic link, and without waiting: tar restores a
 * named pipe, and opening one to read would wait for a writer that never
 * comes, so the publish would hang. With O_NONBLOCK the open returns at once
 * and the type check makes the pipe a miss; on a regular file it changes
 * nothing. (Windows has neither flag.)
 */
const OPEN_ENTRY = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The hex SHA-256 a digest names, or undefined for anything else. */
function sha256Of(digest: string | undefined): string | undefined {
  const m = typeof digest === 'string' ? DIGEST.exec(digest) : null;
  return m ? m[1].toLowerCase() : undefined;
}

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The entry's name: from a whole positive number only. */
function entryName(artifactId: number): string | undefined {
  return Number.isSafeInteger(artifactId) && artifactId > 0 ? `${artifactId}.zip` : undefined;
}

export function openReportCache(dir: string, { log, maxEntryBytes }: ReportCacheOptions): ReportCache {
  const stats: ReportCacheStats = { hits: 0, hitBytes: 0, stored: 0, removed: 0 };
  /** Entries this build read or wrote. */
  const used = new Set<string>();

  // The folder itself must be a folder: a symbolic link (or a file) in its
  // place is removed, never followed.
  let usable = true;
  try {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    usable = false;
    log.warning(`The report cache ${dir} is not used (${message(error)}): every report is downloaded.`);
  }

  const remove = (file: string) => {
    try {
      // On a symbolic link this removes the link, not what it points to.
      fs.rmSync(file, { recursive: true, force: true });
    } catch (error) {
      log.warning(`The report cache could not remove ${path.basename(file)} (${message(error)}).`);
    }
  };

  return {
    stats,

    read(artifactId, digest) {
      const name = entryName(artifactId);
      const want = sha256Of(digest);
      if (!usable || !name || !want) return undefined;
      const file = path.join(dir, name);
      // Opened once, never through a symbolic link (that open fails, ELOOP)
      // nor waiting on a named pipe, and checked and read through that one
      // descriptor: no other file can take its place between the check and
      // the read.
      let bytes: Buffer | undefined;
      let unusable = '';
      let fd: number | undefined;
      try {
        fd = fs.openSync(file, OPEN_ENTRY);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) unusable = 'is not a file';
        else if (stat.size > maxEntryBytes) unusable = `is over the ${maxEntryBytes}-byte limit`;
        else bytes = fs.readFileSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        unusable = `could not be read (${message(error)})`;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      if (!bytes) {
        log.info(`Report cache: ${name} ${unusable}: downloaded again.`);
        remove(file);
        return undefined;
      }
      if (hex(bytes) !== want) {
        log.warning(`Report cache: ${name} is not the ZIP of artifact ${artifactId} (its SHA-256 is not the digest GitHub lists): downloaded again.`);
        remove(file);
        return undefined;
      }
      used.add(name);
      stats.hits += 1;
      stats.hitBytes += bytes.byteLength;
      return bytes;
    },

    write(artifactId, digest, zip) {
      const name = entryName(artifactId);
      const want = sha256Of(digest);
      if (!usable || !name || !want || zip.byteLength > maxEntryBytes) return;
      if (hex(zip) !== want) {
        log.warning(`The report downloaded for artifact ${artifactId} is not the one GitHub lists (its SHA-256 is not the digest): not kept in the report cache.`);
        return;
      }
      const file = path.join(dir, name);
      try {
        remove(file);
        // 'wx' creates the file or fails: it never writes through a link put in its place.
        fs.writeFileSync(file, zip, { flag: 'wx' });
        used.add(name);
        stats.stored += 1;
      } catch (error) {
        log.warning(`Report cache: ${name} could not be written (${message(error)}).`);
        remove(file);
      }
    },

    prune() {
      if (!usable) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        log.warning(`The report cache could not be listed (${message(error)}).`);
        return;
      }
      for (const entry of entries) {
        if (used.has(entry.name) && entry.isFile()) continue;
        remove(path.join(dir, entry.name));
        stats.removed += 1;
      }
    },
  };
}
