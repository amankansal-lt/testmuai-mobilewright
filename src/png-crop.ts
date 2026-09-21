import { deflateSync, inflateSync } from 'node:zlib';
import type { Bounds } from '@mobilewright/protocol';

// Element screenshots arrive as `clip` on a full-screen PNG. Cropping here
// keeps the package dependency-free: mobilewright dropped sharp in 0.0.56, and
// pulling a native image library back in for one call is not worth it.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

let crcTable: Uint32Array | undefined;

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses PNG scanline filtering in place, returning raw pixel rows. */
function unfilter(data: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    const src = data.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : undefined;

    for (let i = 0; i < stride; i++) {
      const a = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
      const x = src[i];
      switch (filter) {
        case 0: row[i] = x; break;
        case 1: row[i] = (x + a) & 0xff; break;
        case 2: row[i] = (x + b) & 0xff; break;
        case 3: row[i] = (x + ((a + b) >> 1)) & 0xff; break;
        case 4: row[i] = (x + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`Unsupported PNG filter type ${filter}`);
      }
    }
  }
  return out;
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

function readHeader(png: Buffer): Header {
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
    interlace: png[28],
  };
}

/**
 * Crops a PNG to `clip`, given in layout points; `scale` converts to pixels
 * (iOS reports points, Android pixels, screenshots are always pixels).
 *
 * Returns the original buffer untouched for anything this decoder does not
 * handle — a full-screen screenshot is a better outcome than a failed test.
 */
export function cropPng(png: Buffer, clip: Bounds, scale = 1): Buffer {
  try {
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return png;

    const header = readHeader(png);
    const channels = CHANNELS[header.colorType];
    if (header.bitDepth !== 8 || header.interlace !== 0 || !channels) return png;

    const idat: Buffer[] = [];
    let offset = 8;
    while (offset + 8 <= png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
      if (type === 'IEND') break;
      offset += length + 12;
    }
    if (idat.length === 0) return png;

    const { width, height } = header;
    const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);

    const x = Math.max(0, Math.min(Math.round(clip.x * scale), width - 1));
    const y = Math.max(0, Math.min(Math.round(clip.y * scale), height - 1));
    const w = Math.max(1, Math.min(Math.round(clip.width * scale), width - x));
    const h = Math.max(1, Math.min(Math.round(clip.height * scale), height - y));

    const stride = width * channels;
    const outStride = w * channels;
    const filtered = Buffer.alloc((outStride + 1) * h);
    for (let row = 0; row < h; row++) {
      filtered[row * (outStride + 1)] = 0;
      raw.copy(
        filtered,
        row * (outStride + 1) + 1,
        (y + row) * stride + x * channels,
        (y + row) * stride + (x + w) * channels,
      );
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = header.bitDepth;
    ihdr[9] = header.colorType;

    return Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(filtered)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  } catch {
    return png;
  }
}
