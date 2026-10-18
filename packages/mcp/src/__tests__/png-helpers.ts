import { PNG } from 'pngjs';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A page whose every pixel is a colour of its own position, so a crop that is
 * off by a single pixel or row fails a byte comparison. `ink` draws
 * text-like detail (dark one-pixel strokes in lines of glyph height).
 */
export function page(width: number, height: number, ink?: Box): PNG {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = x & 255;
      png.data[i + 1] = y & 255;
      png.data[i + 2] = ((y >> 8) * 16 + (x >> 8)) & 255;
      png.data[i + 3] = 255;
      if (ink && x >= ink.x && x < ink.x + ink.width && y >= ink.y && y < ink.y + ink.height) {
        const stroke = (x - ink.x) % 5 < 2 && (y - ink.y) % 14 < 10 && (x * 7 + y * 3) % 11 > 2;
        png.data[i] = stroke ? 20 : 250;
        png.data[i + 1] = stroke ? 20 : 250;
        png.data[i + 2] = stroke ? 30 : 250;
      }
    }
  }
  return png;
}

/**
 * A PNG file of `png`. Each row uses the Sub filter: pngjs's default
 * (adaptive, which also tries Paeth) is about a hundred times slower under
 * Jest than in plain Node (10 s for a 390×3000 page), and a fixture's
 * filter does not change the pixels a test compares.
 */
export const encode = (png: PNG): Buffer => PNG.sync.write(png, { filterType: 1 });

/** The RGBA bytes of `box` in `png`, row by row. */
export function pixels(png: PNG, box: Box): Buffer {
  const rows: Buffer[] = [];
  for (let y = box.y; y < box.y + box.height; y++) {
    const start = (y * png.width + box.x) * 4;
    rows.push(Buffer.from(png.data.subarray(start, start + box.width * 4)));
  }
  return Buffer.concat(rows);
}
