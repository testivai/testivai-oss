/**
 * Read a report artifact (a ZIP) that someone else's CI run uploaded.
 *
 * Only what the published report is rebuilt from is read: results.json, the
 * run stamp (testivai-run.json, from action/src/report-artifact.ts) and the
 * baseline/current/diff/thumb PNGs under images/<snapshot>/. Every other entry,
 * the artifact's own index.html included, is never decompressed, and nothing
 * is written to disk.
 *
 * A fork controls its artifact, so sizes are not trusted: the ZIP is fed to
 * the decompressor in small slices, each entry's inflated size is counted as
 * it grows, and the whole archive is refused as soon as an entry, or the
 * total, is over its limit. A "zip bomb" (or an archive that understates
 * its sizes) costs at most one slice's worth of inflation past the limit.
 */

import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from 'fflate';

export interface ArchiveLimits {
  maxEntries: number;
  /** Everything read, inflated. */
  maxTotalBytes: number;
  maxImageBytes: number;
  /** results.json and testivai-run.json. */
  maxJsonBytes: number;
}

const MB = 1024 * 1024;

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 50_000,
  maxTotalBytes: 400 * MB,
  maxImageBytes: 50 * MB,
  maxJsonBytes: 20 * MB,
};

export interface ReportArchive {
  results?: Uint8Array;
  runStamp?: Uint8Array;
  /** By path in the archive: images/<snapshot>/(baseline|current|diff|thumb).png. */
  images: Map<string, Uint8Array>;
}

/** The archive is over a limit; nothing from it is used. */
export class ArchiveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveRefused';
  }
}

/** Compressed bytes handed to the decompressor at a time. */
const SLICE = 16 * 1024;

const IMAGE_PATH = /^images\/(.+)\/(baseline|current|diff|thumb)\.png$/;

/** A plain relative path: no backslash, NUL, leading slash, empty, '.' or '..' segment. */
function isPlainPath(name: string): boolean {
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/')) return false;
  return name.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

type Kind = 'results' | 'runStamp' | 'image';

function kindOf(name: string): Kind | undefined {
  if (name === 'results.json') return 'results';
  if (name === 'testivai-run.json') return 'runStamp';
  if (isPlainPath(name) && IMAGE_PATH.test(name)) return 'image';
  return undefined;
}

export function readReportArchive(zip: Uint8Array, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ReportArchive {
  const out: ReportArchive = { images: new Map() };
  let entries = 0;
  let total = 0;
  let refusal: ArchiveRefused | undefined;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file: UnzipFile) => {
    if (refusal) return;
    entries += 1;
    if (entries > limits.maxEntries) {
      refusal = new ArchiveRefused(`the report has more than ${limits.maxEntries} entries`);
      return;
    }
    const kind = kindOf(file.name);
    if (!kind) {
      file.ondata = () => {};
      return;
    }
    const cap = kind === 'image' ? limits.maxImageBytes : limits.maxJsonBytes;
    if (file.originalSize !== undefined && file.originalSize > cap) {
      refusal = new ArchiveRefused(`${file.name} is ${file.originalSize} bytes, over the ${cap}-byte limit`);
      file.ondata = () => {};
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (refusal) return;
      if (err) {
        refusal = new ArchiveRefused(`${file.name} could not be decompressed (${err.message})`);
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > cap) {
        refusal = new ArchiveRefused(`${file.name} inflates past the ${cap}-byte limit (stopped after ${size} bytes)`);
        file.terminate();
        return;
      }
      if (total > limits.maxTotalBytes) {
        refusal = new ArchiveRefused(`the report inflates past the ${limits.maxTotalBytes}-byte limit`);
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const data = concat(chunks, size);
        if (kind === 'image') out.images.set(file.name, data);
        else out[kind] = data;
      }
    };
    file.start();
  };

  for (let offset = 0; offset < zip.length && !refusal; offset += SLICE) {
    const end = Math.min(offset + SLICE, zip.length);
    try {
      unzip.push(zip.subarray(offset, end), end === zip.length);
    } catch (error) {
      refusal = new ArchiveRefused(`the report is not a readable ZIP (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (refusal) throw refusal;
  return out;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
