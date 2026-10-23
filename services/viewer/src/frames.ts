// Batch frames for browsers (spec 07 section 3.1): scaled to the requested width,
// never enlarged, lossy WebP or JPEG; one encoding per image, width and quality.
import type { Image } from '@sth/model';
import sharp from 'sharp';

export type FrameFormat = 'webp' | 'jpeg';

export interface EncodedFrame {
  data: Buffer;
  type: string;
  width: number;
  height: number;
}

/** Defaults for open question 2 (spec 07 section 3.1); data saver lowers width and quality. */
export const QUALITY = { webp: 72, jpeg: 78 };
export const SAVER = { widthFactor: 0.6, webp: 45, jpeg: 50 };
const MIN_WIDTH = 64;

/** Raw BGRA (as captured) to RGB for sharp. */
function bgraToRgb(src: Uint8Array, width: number, height: number): Buffer {
  const out = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
    out[j] = src[i + 2];
    out[j + 1] = src[i + 1];
    out[j + 2] = src[i];
  }
  return out;
}

export class FrameStore {
  private readonly encoded = new Map<string, Promise<EncodedFrame>>();
  private readonly lookup: (imageId: string) => Image | undefined;

  constructor(lookup: (imageId: string) => Image | undefined) {
    this.lookup = lookup;
  }

  /** The frame at `width` device pixels, or null when the image is gone. */
  get(imageId: string, width: number, dataSaver: boolean, format: FrameFormat): Promise<EncodedFrame> | null {
    const img = this.lookup(imageId);
    if (!img) return null;
    const full = img.image.width;
    const wanted = Math.round(width * (dataSaver ? SAVER.widthFactor : 1));
    // quantize to 64 px steps so similar screens share one encoding
    const w = Math.min(full, Math.max(MIN_WIDTH, Math.ceil(wanted / 64) * 64));
    const quality = dataSaver ? SAVER[format] : QUALITY[format];
    const key = `${imageId}|${w}|${quality}|${format}`;
    let p = this.encoded.get(key);
    if (!p) {
      p = this.encode(img, w, quality, format);
      this.encoded.set(key, p);
      p.catch(() => this.encoded.delete(key));
    }
    return p;
  }

  /** Forget encodings of images no source keeps any more. */
  drop(imageIds: string[]): void {
    const ids = new Set(imageIds);
    for (const key of this.encoded.keys()) if (ids.has(key.slice(0, key.indexOf('|')))) this.encoded.delete(key);
  }

  private async encode(img: Image, w: number, quality: number, format: FrameFormat): Promise<EncodedFrame> {
    const e = img.image;
    let pipeline =
      e.format === 'raw_bgra8'
        ? sharp(bgraToRgb(e.data, e.width, e.height), { raw: { width: e.width, height: e.height, channels: 3 } })
        : sharp(e.data);
    if (w < e.width) pipeline = pipeline.resize({ width: w });
    pipeline = format === 'webp' ? pipeline.webp({ quality }) : pipeline.jpeg({ quality, mozjpeg: true });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data, type: `image/${format}`, width: info.width, height: info.height };
  }
}
