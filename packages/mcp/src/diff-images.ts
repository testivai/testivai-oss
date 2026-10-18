import * as fs from 'fs';
import { PNG } from 'pngjs';
import { imageContent, MAX_IMAGE_EDGE, resolveImage, verdictFor, type ProjectPaths, type RegionInfo, type SnapshotResult, type ToolContent } from './lib';

/**
 * What get_diff returns for a snapshot: the full page downscaled to fit
 * (it shows where the changes are), then the changed regions cropped at
 * native scale and as wide as the page (up to 1280 px), since a tall
 * full-page capture downscaled to 1024 px is too small to read (390×11844
 * becomes 33×987). The regions are the ones in
 * results.json, on the diff canvas: witness pads the two captures to max
 * width × max height, anchored at the top left, so a region's box is the
 * same place in the baseline, the current capture and the diff.
 */

/**
 * The bounds on get_diff's crops. Its description (tool-meta.ts), the
 * README and docs/mcp.md quote these numbers, and tests hold them to it.
 */
export const CROP_LIMITS = {
  /** Crops in a get_diff response without `region` or `y`; each is sent as baseline, current and diff. */
  maxCrops: 3,
  /** Pixels of context around each region, on every side. */
  padding: 32,
  /** The widest crop at native scale: a wider area is sampled at 1/2, 1/3 and so on. */
  maxWidth: 1280,
  /** The most rows a crop shows at its scale: a taller area shows its top rows. */
  maxHeight: 1024,
  /** Pixels the crops of one response hold together, in each of the three images. */
  maxTotalPixels: 2_000_000,
} as const;

/** More regions than this are counted, not listed, in the get_diff text. */
const MAX_LISTED_REGIONS = 20;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How an area of the canvas is shown in a crop. */
export interface CropWindow {
  /** The area asked for, inside the canvas. */
  area: Box;
  /** The part of it the crop shows: `area`, cut to its top rows when it is taller than the limit. */
  shown: Box;
  /** 1 at native scale; n samples every nth pixel, for an area wider than CROP_LIMITS.maxWidth. */
  scale: number;
}

/** A crop of one or more nearby regions (indices into the snapshot's results.json `regions`). */
export interface PlannedCrop extends CropWindow {
  regions: number[];
}

export interface CropPlan {
  /** The crops to send, in the order to send them. */
  crops: PlannedCrop[];
  /** Regions in none of them (over the caps, or with no area inside the canvas), ascending. */
  notShown: number[];
}

/** The overlap of two boxes, or null when they share no pixel. */
function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Whether two boxes overlap or touch. */
const meet = (a: Box, b: Box): boolean => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

/** A region's box inside the canvas; null for a region with no area there. */
function boxInside(region: Box, canvas: { width: number; height: number }): Box | null {
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) return null;
  return intersect(region, { x: 0, y: 0, width: canvas.width, height: canvas.height });
}

/** A box plus the padding on every side, inside the canvas. */
function padded(box: Box, canvas: { width: number; height: number }): Box {
  const p = CROP_LIMITS.padding;
  return intersect({ x: box.x - p, y: box.y - p, width: box.width + 2 * p, height: box.height + 2 * p }, { x: 0, y: 0, width: canvas.width, height: canvas.height }) as Box;
}

/** A region's box plus the padding, inside the canvas; null for a region with no area there. */
function paddedArea(region: Box, canvas: { width: number; height: number }): Box | null {
  const inside = boxInside(region, canvas);
  return inside ? padded(inside, canvas) : null;
}

/**
 * The area as wide as the page, up to maxWidth, centred on it and inside the
 * canvas: whole lines, so wrapping and clipping can be judged (a crop that
 * stops at the region's columns cuts a changed heading mid-word). An area
 * already wider keeps its width.
 */
function widened(area: Box, canvas: { width: number; height: number }): Box {
  const width = Math.min(canvas.width, Math.max(area.width, CROP_LIMITS.maxWidth));
  if (width <= area.width) return area;
  const x = Math.min(Math.max(0, Math.round(area.x + area.width / 2 - width / 2)), canvas.width - width);
  return { ...area, x, width };
}

const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

const boxArea = (b: Box): number => b.width * b.height;

/**
 * How to show `area`: at native scale when it is at most maxWidth wide,
 * otherwise sampled at the smallest whole step that fits; and its top
 * maxHeight rows (at that scale) when it is taller.
 */
export function cropWindow(area: Box): CropWindow {
  const scale = Math.max(1, Math.ceil(area.width / CROP_LIMITS.maxWidth));
  return { area: { ...area }, shown: { ...area, height: Math.min(area.height, CROP_LIMITS.maxHeight * scale) }, scale };
}

/** Pixels in each image of a crop. */
const cropPixels = (w: CropWindow): number => Math.ceil(w.shown.width / w.scale) * Math.ceil(w.shown.height / w.scale);

/**
 * Which regions to crop, and how. Each region gets its box plus
 * CROP_LIMITS.padding px on every side, inside the canvas. Regions whose
 * padded areas meet share one crop while the merged area still fits
 * maxWidth × maxHeight. Each crop is then made as wide as the page, up to
 * maxWidth (see widened), and a region that lies inside the box another
 * crop shows joins that crop (a tall region's crop shows only its top rows,
 * so the two cannot always merge). Changes come before shifts (a shift is
 * content that only moved), then results.json order (top to bottom). At
 * most maxCrops crops, holding at most maxTotalPixels together: a crop that
 * would pass it is skipped, and a smaller one after it can still fit.
 */
export function planCrops(regions: ReadonlyArray<RegionInfo>, canvas: { width: number; height: number }): CropPlan {
  const notShown: number[] = [];
  let groups: Array<{ regions: number[]; boxes: Box[]; area: Box; shift: boolean }> = [];
  regions.forEach((r, i) => {
    const box = boxInside(r, canvas);
    if (box) groups.push({ regions: [i], boxes: [box], area: padded(box, canvas), shift: r.classification === 'shift' });
    else notShown.push(i);
  });

  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; ) {
        const a = groups[i];
        const b = groups[j];
        const area = union(a.area, b.area);
        if (meet(a.area, b.area) && area.width <= CROP_LIMITS.maxWidth && area.height <= CROP_LIMITS.maxHeight) {
          groups[i] = { regions: [...a.regions, ...b.regions], boxes: [...a.boxes, ...b.boxes], area, shift: a.shift && b.shift };
          groups.splice(j, 1);
          merged = true;
        } else {
          j++;
        }
      }
    }
  }

  // Smallest first, each group whose regions all lie inside a larger crop's
  // shown box joins it; the host's box does not change.
  const windows = new Map(groups.map((g) => [g, cropWindow(widened(g.area, canvas))]));
  for (const g of [...groups].sort((a, b) => boxArea((windows.get(a) as CropWindow).shown) - boxArea((windows.get(b) as CropWindow).shown))) {
    const shown = (windows.get(g) as CropWindow).shown;
    const host = groups.find((h) => {
      const hostShown = (windows.get(h) as CropWindow).shown;
      return h !== g && boxArea(hostShown) >= boxArea(shown) && g.boxes.every((b) => contains(hostShown, b));
    });
    if (!host) continue;
    host.regions.push(...g.regions);
    host.boxes.push(...g.boxes);
    host.shift = host.shift && g.shift;
    groups = groups.filter((x) => x !== g);
  }
  for (const g of groups) g.regions.sort((m, n) => m - n);

  groups.sort((a, b) => Number(a.shift) - Number(b.shift) || a.regions[0] - b.regions[0]);
  const crops: PlannedCrop[] = [];
  let used = 0;
  for (const g of groups) {
    const w = windows.get(g) as CropWindow;
    const pixels = cropPixels(w);
    if (crops.length >= CROP_LIMITS.maxCrops || used + pixels > CROP_LIMITS.maxTotalPixels) {
      notShown.push(...g.regions);
      continue;
    }
    crops.push({ ...w, regions: g.regions });
    used += pixels;
  }
  return { crops, notShown: notShown.sort((a, b) => a - b) };
}

/**
 * Cut `box` out of an image, inside the image's own bounds (a capture
 * smaller than the canvas has no pixels in the padded band), taking every
 * `scale`th pixel. Null when the box is outside the image.
 */
export function cropPng(png: PNG, box: Box, scale: number): { png: PNG; box: Box } | null {
  const inside = intersect(box, { x: 0, y: 0, width: png.width, height: png.height });
  if (!inside) return null;
  const width = Math.ceil(inside.width / scale);
  const height = Math.ceil(inside.height / scale);
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const row = ((inside.y + y * scale) * png.width + inside.x) * 4;
    if (scale === 1) {
      png.data.copy(out.data, y * width * 4, row, row + width * 4);
      continue;
    }
    for (let x = 0; x < width; x++) {
      png.data.copy(out.data, (y * width + x) * 4, row + x * scale * 4, row + x * scale * 4 + 4);
    }
  }
  return { png: out, box: inside };
}

/** What get_diff crops on request: one region, or a full-width band. */
export interface DiffRequest {
  /** Index into the snapshot's results.json `regions`. */
  region?: number;
  /** Top of the band, in canvas pixels; 0 when only `height` is given. */
  y?: number;
  /** Rows of the band; maxHeight at the band's scale when only `y` is given. */
  height?: number;
}

type ImageKind = 'baseline' | 'current' | 'diff';

const OWNER: Record<ImageKind, string> = { baseline: 'the baseline', current: 'the current capture', diff: 'the diff image' };

interface LoadedImage {
  kind: ImageKind;
  png: PNG;
}

const text = (t: string): ToolContent => ({ type: 'text', text: t });

const ordinal = (n: number): string => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
};

const scaleText = (scale: number): string =>
  scale === 1 ? 'native scale' : `1/${scale} scale (every ${ordinal(scale)} pixel, as it is wider than ${CROP_LIMITS.maxWidth} px)`;

const boxText = (b: Box): string => `x=${b.x} y=${b.y} ${b.width}×${b.height}`;

/** A region's smallest element, safe to quote in backticks. */
function selectorOf(region: RegionInfo): string | null {
  const selector = region.elements?.[0]?.selector?.replace(/[`\r\n]/g, '').trim();
  if (!selector) return null;
  return selector.length > 120 ? `${selector.slice(0, 119)}…` : selector;
}

function describeRegion(region: RegionInfo): string {
  const selector = selectorOf(region);
  return `${boxText(region)}${region.classification ? `, ${region.classification}` : ''}${selector ? `, \`${selector}\`` : ''}`;
}

/** The crop's box, what it adds around the region(s), its scale, and where to continue when it shows only the top rows. */
function describeWindow(w: CropWindow, what: 'the region' | 'the regions', canvas: { width: number }): string {
  const s = w.shown;
  const full = w.area.width === canvas.width ? ', full width' : '';
  const top =
    s.height < w.area.height ? `, the top ${s.height} of its ${w.area.height} rows (get_diff with y: ${s.y + s.height} shows the rows below)` : '';
  return `${boxText(s)} (${what} plus ${CROP_LIMITS.padding} px${full}) at ${scaleText(w.scale)}${top}`;
}

/** Each image cut to the window, labelled; an image the window misses, or only partly covers, says so. */
function croppedImages(images: LoadedImage[], w: CropWindow, tag: string): ToolContent[] {
  const content: ToolContent[] = [];
  for (const image of images) {
    const label = `${image.kind}${tag}`;
    const size = `${image.png.width}×${image.png.height}`;
    const cut = cropPng(image.png, w.shown, w.scale);
    if (!cut) {
      content.push(text(`${label}: none — this area is outside ${OWNER[image.kind]}'s ${size}.`));
      continue;
    }
    const whole = cut.box.width === w.shown.width && cut.box.height === w.shown.height;
    content.push(text(whole ? `${label}:` : `${label} (cut to ${OWNER[image.kind]}'s ${size}: ${boxText(cut.box)}):`));
    content.push({ type: 'image', data: PNG.sync.write(cut.png).toString('base64'), mimeType: 'image/png' });
  }
  return content;
}

/** The region list and the planned crops, after the full-page images. */
function regionCrops(regions: ReadonlyArray<RegionInfo>, canvas: { width: number; height: number }, images: LoadedImage[]): ToolContent[] {
  const plan = planCrops(regions, canvas);
  const cropOf = new Map<number, number>();
  plan.crops.forEach((c, k) => {
    for (const i of c.regions) cropOf.set(i, k);
  });

  const lines = [`Regions (${regions.length}) on the ${canvas.width}×${canvas.height} diff canvas, in results.json order (get_diff with region: <n> crops one):`];
  regions.slice(0, MAX_LISTED_REGIONS).forEach((r, i) => {
    const k = cropOf.get(i);
    const crop = k === undefined ? null : plan.crops[k];
    const where = crop ? `crop ${(k as number) + 1}${r.y + r.height > crop.shown.y + crop.shown.height ? ' (its top rows)' : ''}` : 'not cropped';
    lines.push(`- #${i} ${describeRegion(r)}: ${where}`);
  });
  if (regions.length > MAX_LISTED_REGIONS) {
    lines.push(
      `- … and ${regions.length - MAX_LISTED_REGIONS} more (#${MAX_LISTED_REGIONS}–#${regions.length - 1}): get_report lists them, and region: <n> crops any of them`,
    );
  }
  lines.push(
    plan.crops.length > 0
      ? 'The crops below are at native scale (one image pixel per page pixel) unless they say otherwise: read text, wrapping and clipping there, not in the downscaled full-page images above. get_diff with y and height crops any other band of the page.'
      : 'No region has an area inside the canvas, so there is nothing to crop. get_diff with y and height crops a band of the page.',
  );

  const content: ToolContent[] = [text(lines.join('\n'))];
  plan.crops.forEach((c, k) => {
    const members = c.regions.slice(0, 6).map((i) => {
      const selector = selectorOf(regions[i]);
      return `#${i}${selector ? ` \`${selector}\`` : ''}`;
    });
    const more = c.regions.length > 6 ? `, and ${c.regions.length - 6} more` : '';
    const which = `${c.regions.length === 1 ? 'region' : 'regions'} ${members.join(', ')}${more}`;
    content.push(text(`Crop ${k + 1} of ${plan.crops.length}: ${which} — ${describeWindow(c, c.regions.length === 1 ? 'the region' : 'the regions', canvas)}:`));
    content.push(...croppedImages(images, c, `, crop ${k + 1}`));
  });
  return content;
}

/** One region, cropped on request. */
function requestedRegion(snapshot: SnapshotResult, index: number, canvas: { width: number; height: number }, images: LoadedImage[]): ToolContent[] {
  const regions = snapshot.regions ?? [];
  if (regions.length === 0) {
    return [text(`${snapshot.name} has no regions in the latest results: get_diff with y and height crops a band of the page instead.`)];
  }
  const region = regions[index];
  if (!region) {
    const range = regions.length === 1 ? '1 region (#0)' : `${regions.length} regions (#0–#${regions.length - 1})`;
    return [text(`${snapshot.name} has ${range}: there is no region #${index}.`)];
  }
  const area = paddedArea(region, canvas);
  if (!area) {
    return [text(`Region #${index} of ${snapshot.name} (${describeRegion(region)}) has no area inside its ${canvas.width}×${canvas.height} canvas.`)];
  }
  const w = cropWindow(widened(area, canvas));
  return [
    text(`Region #${index} of ${regions.length}: ${describeRegion(region)} — ${describeWindow(w, 'the region', canvas)}:`),
    ...croppedImages(images, w, ''),
  ];
}

/** A full-width band, cropped on request. */
function requestedBand(snapshot: SnapshotResult, request: DiffRequest, canvas: { width: number; height: number }, images: LoadedImage[]): ToolContent[] {
  const y = request.y ?? 0;
  const size = `${canvas.width}×${canvas.height}`;
  if (y >= canvas.height) return [text(`y=${y} is below the bottom of ${snapshot.name}'s ${size} canvas.`)];
  const scale = cropWindow({ x: 0, y, width: canvas.width, height: 1 }).scale;
  const asked = request.height ?? CROP_LIMITS.maxHeight * scale;
  const area = { x: 0, y, width: canvas.width, height: Math.min(asked, canvas.height - y) };
  const w = cropWindow(area);
  const end = w.shown.y + w.shown.height;
  const notes: string[] = [];
  if (w.shown.height < area.height) notes.push(`get_diff with y: ${end} shows the rows below`);
  if (y + asked > canvas.height) notes.push(`the canvas ends at y=${canvas.height}`);
  const top = w.shown.height < area.height ? `, the top ${w.shown.height} of the ${asked} rows asked for` : '';
  const header = `Band y=${y}–${end} of the ${size} canvas, full width, at ${scaleText(w.scale)}${top}${notes.length ? ` (${notes.join('; ')})` : ''}:`;
  return [text(header), ...croppedImages(images, w, ', band')];
}

/**
 * get_diff's content for a snapshot in the results. Without a request: the
 * verdict, the baseline, current and diff images downscaled to fit, then,
 * when one of them had to be downscaled, the region list and native-scale
 * crops of the changed regions (planCrops); a page that fits is already at
 * native scale, and crops would only repeat its pixels.
 * With `region`, or `y` and `height`: the verdict and only that crop. An
 * image that is not on disk is left out; one that is not a PNG is said.
 */
export function snapshotDiffContent(paths: ProjectPaths, snapshot: SnapshotResult, request: DiffRequest = {}): ToolContent[] {
  const content: ToolContent[] = [text(`${snapshot.name}: ${verdictFor(snapshot)}`)];
  const wantsBand = request.y !== undefined || request.height !== undefined;
  const onRequest = request.region !== undefined || wantsBand;
  if (request.region !== undefined && wantsBand) {
    content.push(text('Pass region, or y and height, not both.'));
    return content;
  }

  const images: LoadedImage[] = [];
  for (const [kind, rel] of [
    ['baseline', snapshot.baselinePath],
    ['current', snapshot.currentPath],
    ['diff', snapshot.diffPath],
  ] as const) {
    const abs = rel ? resolveImage(paths, rel) : null;
    if (!abs) continue;
    const raw = fs.readFileSync(abs);
    let png: PNG;
    try {
      png = PNG.sync.read(raw);
    } catch (err) {
      content.push(text(`${kind}: ${rel} could not be read as a PNG (${err instanceof Error ? err.message : String(err)}).`));
      continue;
    }
    images.push({ kind, png });
    if (!onRequest) content.push(...imageContent(kind, raw, png));
  }

  // The regions are on the diff canvas: the larger of the two captures.
  const canvas =
    images.length > 0 ? { width: Math.max(...images.map((i) => i.png.width)), height: Math.max(...images.map((i) => i.png.height)) } : null;
  if (!onRequest) {
    const downscaled = images.some((i) => Math.max(i.png.width, i.png.height) > MAX_IMAGE_EDGE);
    if (canvas && downscaled && snapshot.regions && snapshot.regions.length > 0) content.push(...regionCrops(snapshot.regions, canvas, images));
    return content;
  }
  if (!canvas) {
    content.push(text(`No images on disk for ${snapshot.name}.`));
    return content;
  }
  content.push(...(request.region !== undefined ? requestedRegion(snapshot, request.region, canvas, images) : requestedBand(snapshot, request, canvas, images)));
  return content;
}
