/**
 * Minimal BlurHash decoder (no dependency). Decodes a BlurHash string into RGBA
 * pixels for a small placeholder canvas while the real image loads — the
 * "nice loading feature" NIP-92 recommends.
 *
 * Algorithm per the reference implementation: https://github.com/woltapp/blurhash
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(str: string): number {
  let value = 0;
  for (const char of str) {
    const i = DIGITS.indexOf(char);
    if (i === -1) throw new Error('Invalid BlurHash character');
    value = value * 83 + i;
  }
  return value;
}

function sRGBToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearTosRGB(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.round(v * 12.92 * 255 + 0.5)
    : Math.round((1.055 * v ** (1 / 2.4) - 0.055) * 255 + 0.5);
}

const signPow = (value: number, exp: number): number => Math.sign(value) * Math.abs(value) ** exp;

function decodeDC(value: number): [number, number, number] {
  return [sRGBToLinear(value >> 16), sRGBToLinear((value >> 8) & 255), sRGBToLinear(value & 255)];
}

function decodeAC(value: number, maxValue: number): [number, number, number] {
  const r = Math.floor(value / (19 * 19));
  const g = Math.floor(value / 19) % 19;
  const b = value % 19;
  return [signPow((r - 9) / 9, 2) * maxValue, signPow((g - 9) / 9, 2) * maxValue, signPow((b - 9) / 9, 2) * maxValue];
}

export function isValidBlurhash(hash: string): boolean {
  if (!hash || hash.length < 6) return false;
  const sizeFlag = DIGITS.indexOf(hash[0] ?? '');
  if (sizeFlag < 0) return false;
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;
  return hash.length === 4 + 2 * numX * numY;
}

/**
 * Decode a BlurHash into an RGBA pixel buffer of size `width * height * 4`.
 * `punch` boosts contrast (default 1). Throws on malformed input.
 */
export function decodeBlurhash(hash: string, width: number, height: number, punch = 1): Uint8ClampedArray {
  if (!isValidBlurhash(hash)) throw new Error('Invalid BlurHash');
  const sizeFlag = decode83(hash[0] ?? '');
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;
  const maxValue = (decode83(hash[1] ?? '') + 1) / 166;

  const colors: [number, number, number][] = new Array(numX * numY);
  for (let i = 0; i < colors.length; i++) {
    if (i === 0) {
      colors[i] = decodeDC(decode83(hash.slice(2, 6)));
    } else {
      colors[i] = decodeAC(decode83(hash.slice(4 + i * 2, 6 + i * 2)), maxValue * punch);
    }
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < numY; j++) {
        for (let i = 0; i < numX; i++) {
          const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
          const color = colors[i + j * numX];
          if (!color) continue;
          r += color[0] * basis;
          g += color[1] * basis;
          b += color[2] * basis;
        }
      }
      const idx = 4 * (x + y * width);
      pixels[idx] = linearTosRGB(r);
      pixels[idx + 1] = linearTosRGB(g);
      pixels[idx + 2] = linearTosRGB(b);
      pixels[idx + 3] = 255;
    }
  }
  return pixels;
}

/** Decode a BlurHash to a data URL via an offscreen canvas, or null on failure. */
export function blurhashToDataUrl(hash: string, width = 32, height = 32, punch = 1): string | null {
  try {
    const pixels = decodeBlurhash(hash, width, height, punch);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  } catch {
    return null;
  }
}
