import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import type { VectorizeOptions, VectorizeResult } from './vectorize-types';
import { defaultOptions } from './vectorize-types';

const execFileAsync = promisify(execFile);

// ============================================================
// Constants
// ============================================================
const KMEANS_SAMPLE_SIZE = 600; // Max sample dimension for K-Means
const KMEANS_MAX_ITERATIONS = 40;
const KMEANS_RETRIES = 5; // Run K-Means multiple times, pick best
const MIN_PATH_BBOX_AREA = 4; // Minimum bounding box area (px²) to keep a path

// ============================================================
// Potrace CLI Trace Result
// ============================================================
interface PotraceTraceResult {
  rawSvg: string;
  paths: string[];
  transformStr: string;
  transform: { sx: number; sy: number; tx: number; ty: number };
  viewBoxWidth: number;
  viewBoxHeight: number;
}

// ============================================================
// RGB ↔ LAB Color Space Conversion
// ============================================================

function srgbToLinear(c: number): number {
  c = c / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  c = Math.max(0, Math.min(1, c));
  return c <= 0.0031308 ? Math.round(c * 12.92 * 255) : Math.round((1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  // sRGB → linear RGB
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  // linear RGB → XYZ (D65)
  let x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  let y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
  let z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041;

  // XYZ → normalized (D65 reference white)
  x /= 0.95047;
  y /= 1.0;
  z /= 1.08883;

  // XYZ → Lab
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  const L = 116 * fy - 16;
  const A = 500 * (fx - fy);
  const B = 200 * (fy - fz);

  return [L, A, B];
}

// ============================================================
// Image Preprocessing
// ============================================================
async function preprocessImage(
  imageBuffer: Buffer,
  options: VectorizeOptions
): Promise<Buffer> {
  let pipeline = sharp(imageBuffer).removeAlpha().flatten({
    background: { r: 255, g: 255, b: 255 },
  });

  if (options.denoise > 0) {
    pipeline = pipeline.median(options.denoise);
  }

  return pipeline.png().toBuffer();
}

// ============================================================
// Potrace CLI Invocation
// ============================================================
async function potraceTraceCli(
  imageBuffer: Buffer,
  width: number,
  height: number,
  options: VectorizeOptions,
  isMask: boolean = false
): Promise<PotraceTraceResult> {
  const tmpDir = path.join(os.tmpdir(), 'vectorforge');
  await fs.mkdir(tmpDir, { recursive: true });

  const tmpId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pbmPath = path.join(tmpDir, `${tmpId}.pbm`);
  const svgPath = path.join(tmpDir, `${tmpId}.svg`);

  try {
    // Convert input to PGM (grayscale, 1 channel) for potrace
    const pgmBuffer = await sharp(imageBuffer)
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data: rawGray, info: grayInfo } = pgmBuffer;

    // Build PGM (P5 binary) file
    const header = `P5\n${grayInfo.width} ${grayInfo.height}\n255\n`;
    const headerBuf = Buffer.from(header, 'ascii');
    const pgmBuf = Buffer.concat([headerBuf, rawGray]);

    await fs.writeFile(pbmPath, pgmBuf);

    // Build potrace CLI arguments
    const args: string[] = [
      '-s', // SVG output
      '-o',
      svgPath,
      '--turdsize',
      String(isMask ? Math.max(options.turdSize, 3) : options.turdSize),
      '--alphamax',
      String(options.alphaMax),
    ];

    // optCurve: potrace optimizes curves by default; use --longcurve to disable
    if (!options.optCurve) {
      args.push('--longcurve');
    }

    args.push('--opttolerance', String(options.optTolerance));

    if (!isMask && options.mode === 'bw') {
      args.push('-k', String(options.threshold / 255));
    } else {
      args.push('-k', '0.5'); // Default threshold for masks
    }

    args.push(pbmPath);

    await execFileAsync('potrace', args, { timeout: 60000 });

    // Read output SVG
    const rawSvg = await fs.readFile(svgPath, 'utf-8');

    // Parse the result
    return parsePotraceSvg(rawSvg);
  } finally {
    // Cleanup temp files
    await fs.unlink(pbmPath).catch(() => {});
    await fs.unlink(svgPath).catch(() => {});
  }
}

// ============================================================
// Parse Potrace SVG Output
// ============================================================
function parsePotraceSvg(rawSvg: string): PotraceTraceResult {
  // Extract viewBox
  const viewBoxMatch = rawSvg.match(/viewBox="([^"]+)"/);
  const viewBoxParts = viewBoxMatch?.[1]?.split(/\s+/).map(Number) ?? [0, 0, 0, 0];
  const viewBoxWidth = viewBoxParts[2] || 0;
  const viewBoxHeight = viewBoxParts[3] || 0;

  // Extract <g> transform
  const transformMatch = rawSvg.match(/<g[^>]*transform="([^"]+)"[^>]*>/);
  const transformStr = transformMatch?.[1] ?? '';

  // Parse transform: "translate(tx, ty) scale(sx, sy)"
  let sx = 1,
    sy = 1,
    tx = 0,
    ty = 0;
  if (transformStr) {
    const translateMatch = transformStr.match(/translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/);
    const scaleMatch = transformStr.match(/scale\(\s*([\d.e+-]+)\s*,\s*([-\d.e+-]+)\s*\)/);
    if (translateMatch) {
      tx = parseFloat(translateMatch[1]);
      ty = parseFloat(translateMatch[2]);
    }
    if (scaleMatch) {
      sx = parseFloat(scaleMatch[1]);
      sy = parseFloat(scaleMatch[2]);
    }
  }

  // Extract path d attributes
  const pathRegex = /<path\s+d="([^"]+)"/g;
  const paths: string[] = [];
  let pathMatch: RegExpExecArray | null;
  while ((pathMatch = pathRegex.exec(rawSvg)) !== null) {
    paths.push(pathMatch[1]);
  }

  return {
    rawSvg,
    paths,
    transformStr,
    transform: { sx, sy, tx, ty },
    viewBoxWidth,
    viewBoxHeight,
  };
}

// ============================================================
// SVG Path Coordinate Transformation
// ============================================================

function parseSVGPath(d: string): Array<{ cmd: string; args: number[] }> {
  const commands: Array<{ cmd: string; args: number[] }> = [];
  const tokenRegex = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  let currentCmd = '';
  let currentArgs: number[] = [];
  let m: RegExpExecArray | null;

  while ((m = tokenRegex.exec(d)) !== null) {
    if (m[1]) {
      if (currentCmd) {
        commands.push({ cmd: currentCmd, args: currentArgs });
      }
      currentCmd = m[1];
      currentArgs = [];
    } else if (m[2]) {
      currentArgs.push(parseFloat(m[2]));
    }
  }
  if (currentCmd) {
    commands.push({ cmd: currentCmd, args: currentArgs });
  }

  return commands;
}

function transformSVGPath(
  d: string,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  precision: number = 2
): string {
  const commands = parseSVGPath(d);
  const result: string[] = [];

  let curX = 0,
    curY = 0;

  for (const { cmd, args } of commands) {
    const isRelative = cmd === cmd.toLowerCase();
    const base = cmd.toUpperCase();

    switch (base) {
      case 'M': {
        const newArgs: string[] = [];
        for (let i = 0; i < args.length; i += 2) {
          if (i + 1 >= args.length) break;
          const x = args[i],
            y = args[i + 1];
          if (isRelative) {
            curX += x;
            curY += y;
            newArgs.push((x * sx).toFixed(precision), (y * sy).toFixed(precision));
          } else {
            curX = x;
            curY = y;
            newArgs.push((x * sx + tx).toFixed(precision), (y * sy + ty).toFixed(precision));
          }
        }
        if (args.length > 2) {
          const firstPair = newArgs.splice(0, 2);
          result.push(`${cmd}${firstPair.join(' ')}`);
          const lineCmd = isRelative ? 'l' : 'L';
          for (let i = 0; i < newArgs.length; i += 2) {
            result.push(`${lineCmd}${newArgs[i]} ${newArgs[i + 1]}`);
          }
        } else {
          result.push(`${cmd}${newArgs.join(' ')}`);
        }
        break;
      }
      case 'L': {
        const newArgs: string[] = [];
        for (let i = 0; i < args.length; i += 2) {
          if (i + 1 >= args.length) break;
          const x = args[i],
            y = args[i + 1];
          if (isRelative) {
            curX += x;
            curY += y;
            newArgs.push((x * sx).toFixed(precision), (y * sy).toFixed(precision));
          } else {
            curX = x;
            curY = y;
            newArgs.push((x * sx + tx).toFixed(precision), (y * sy + ty).toFixed(precision));
          }
        }
        result.push(`${cmd}${newArgs.join(' ')}`);
        break;
      }
      case 'H': {
        for (const x of args) {
          if (isRelative) {
            curX += x;
            result.push(`l${(x * sx).toFixed(precision)} 0`);
          } else {
            curX = x;
            result.push(`L${(x * sx + tx).toFixed(precision)} ${(curY * sy + ty).toFixed(precision)}`);
          }
        }
        break;
      }
      case 'V': {
        for (const y of args) {
          if (isRelative) {
            curY += y;
            result.push(`l0 ${(y * sy).toFixed(precision)}`);
          } else {
            curY = y;
            result.push(`L${(curX * sx + tx).toFixed(precision)} ${(y * sy + ty).toFixed(precision)}`);
          }
        }
        break;
      }
      case 'C': {
        const newArgs: string[] = [];
        for (let i = 0; i < args.length; i += 6) {
          if (i + 5 >= args.length) break;
          const x1 = args[i], y1 = args[i + 1];
          const x2 = args[i + 2], y2 = args[i + 3];
          const x = args[i + 4], y = args[i + 5];

          if (isRelative) {
            curX += x;
            curY += y;
            newArgs.push(
              (x1 * sx).toFixed(precision), (y1 * sy).toFixed(precision),
              (x2 * sx).toFixed(precision), (y2 * sy).toFixed(precision),
              (x * sx).toFixed(precision), (y * sy).toFixed(precision)
            );
          } else {
            curX = x;
            curY = y;
            newArgs.push(
              (x1 * sx + tx).toFixed(precision), (y1 * sy + ty).toFixed(precision),
              (x2 * sx + tx).toFixed(precision), (y2 * sy + ty).toFixed(precision),
              (x * sx + tx).toFixed(precision), (y * sy + ty).toFixed(precision)
            );
          }
        }
        result.push(`${cmd}${newArgs.join(' ')}`);
        break;
      }
      case 'S': {
        const newArgs: string[] = [];
        for (let i = 0; i < args.length; i += 4) {
          if (i + 3 >= args.length) break;
          const x2 = args[i], y2 = args[i + 1];
          const x = args[i + 2], y = args[i + 3];

          if (isRelative) {
            curX += x;
            curY += y;
            newArgs.push(
              (x2 * sx).toFixed(precision), (y2 * sy).toFixed(precision),
              (x * sx).toFixed(precision), (y * sy).toFixed(precision)
            );
          } else {
            curX = x;
            curY = y;
            newArgs.push(
              (x2 * sx + tx).toFixed(precision), (y2 * sy + ty).toFixed(precision),
              (x * sx + tx).toFixed(precision), (y * sy + ty).toFixed(precision)
            );
          }
        }
        result.push(`${cmd}${newArgs.join(' ')}`);
        break;
      }
      case 'Q': {
        const newArgs: string[] = [];
        for (let i = 0; i < args.length; i += 4) {
          if (i + 3 >= args.length) break;
          const x1 = args[i], y1 = args[i + 1];
          const x = args[i + 2], y = args[i + 3];

          if (isRelative) {
            curX += x;
            curY += y;
            newArgs.push(
              (x1 * sx).toFixed(precision), (y1 * sy).toFixed(precision),
              (x * sx).toFixed(precision), (y * sy).toFixed(precision)
            );
          } else {
            curX = x;
            curY = y;
            newArgs.push(
              (x1 * sx + tx).toFixed(precision), (y1 * sy + ty).toFixed(precision),
              (x * sx + tx).toFixed(precision), (y * sy + ty).toFixed(precision)
            );
          }
        }
        result.push(`${cmd}${newArgs.join(' ')}`);
        break;
      }
      case 'T': {
        const newArgs: string[] = [];
        for (let i = 0; i < args.length; i += 2) {
          if (i + 1 >= args.length) break;
          const x = args[i], y = args[i + 1];

          if (isRelative) {
            curX += x;
            curY += y;
            newArgs.push((x * sx).toFixed(precision), (y * sy).toFixed(precision));
          } else {
            curX = x;
            curY = y;
            newArgs.push(
              (x * sx + tx).toFixed(precision), (y * sy + ty).toFixed(precision)
            );
          }
        }
        result.push(`${cmd}${newArgs.join(' ')}`);
        break;
      }
      case 'A': {
        const newArgs: string[] = [];
        for (let i = 0; i < args.length; i += 7) {
          if (i + 6 >= args.length) break;
          const rx = args[i];
          const ry = args[i + 1];
          const xRot = args[i + 2];
          const largeArc = args[i + 3];
          let sweep = args[i + 4];
          const x = args[i + 5], y = args[i + 6];

          if (sy < 0) sweep = 1 - sweep;

          if (isRelative) {
            curX += x;
            curY += y;
            newArgs.push(
              (rx * Math.abs(sx)).toFixed(precision),
              (ry * Math.abs(sy)).toFixed(precision),
              xRot.toFixed(precision),
              largeArc.toFixed(0),
              sweep.toFixed(0),
              (x * sx).toFixed(precision),
              (y * sy).toFixed(precision)
            );
          } else {
            curX = x;
            curY = y;
            newArgs.push(
              (rx * Math.abs(sx)).toFixed(precision),
              (ry * Math.abs(sy)).toFixed(precision),
              xRot.toFixed(precision),
              largeArc.toFixed(0),
              sweep.toFixed(0),
              (x * sx + tx).toFixed(precision),
              (y * sy + ty).toFixed(precision)
            );
          }
        }
        result.push(`${cmd}${newArgs.join(' ')}`);
        break;
      }
      case 'Z': {
        result.push(isRelative ? 'z' : 'Z');
        break;
      }
    }
  }

  return result.join(' ');
}

// ============================================================
// K-Means Color Quantization (LAB color space)
// ============================================================

/**
 * Histogram-based palette initialization.
 * Quantizes RGB space into bins, finds the most frequent colors,
 * and uses them as K-Means initial centroids.
 * This anchors centroids to actual dominant colors rather than antialiased mid-tones.
 */
function initializeCentroidsHistogram(
  pixelData: Uint8Array,
  pixelCount: number,
  channels: number,
  k: number
): number[][] {
  // Quantize to 5-bit per channel (32 levels = 32768 bins) for histogram
  const BIN_BITS = 5;
  const BIN_SIZE = 1 << BIN_BITS;
  const BIN_MASK = BIN_SIZE - 1;
  const histogram = new Map<number, number>();

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * channels;
    const r = pixelData[idx] >> (8 - BIN_BITS);
    const g = pixelData[idx + 1] >> (8 - BIN_BITS);
    const b = pixelData[idx + 2] >> (8 - BIN_BITS);
    const key = (r << (2 * BIN_BITS)) | (g << BIN_BITS) | b;
    histogram.set(key, (histogram.get(key) || 0) + 1);
  }

  // Sort bins by frequency (descending)
  const sortedBins = [...histogram.entries()]
    .sort((a, b) => b[1] - a[1]);

  // Pick top-K bins that are well-separated in color space
  const centroids: number[][] = [];
  const minLabDist = 8; // Minimum LAB distance between initial centroids

  for (const [key] of sortedBins) {
    const r5 = (key >> (2 * BIN_BITS)) & BIN_MASK;
    const g5 = (key >> BIN_BITS) & BIN_MASK;
    const b5 = key & BIN_MASK;
    // Convert back to 8-bit RGB (center of bin)
    const r8 = Math.round((r5 + 0.5) * (256 / BIN_SIZE));
    const g8 = Math.round((g5 + 0.5) * (256 / BIN_SIZE));
    const b8 = Math.round((b5 + 0.5) * (256 / BIN_SIZE));

    // Check distance to existing centroids
    const [L, A, B] = rgbToLab(r8, g8, b8);
    let tooClose = false;
    for (const c of centroids) {
      const dL = L - c[0];
      const dA = A - c[1];
      const dB = B - c[2];
      if (dL * dL + dA * dA + dB * dB < minLabDist * minLabDist) {
        tooClose = true;
        break;
      }
    }

    if (!tooClose) {
      centroids.push([L, A, B]);
      if (centroids.length >= k) break;
    }
  }

  // If we didn't get enough centroids (unlikely), fall back to K-Means++ on LAB
  if (centroids.length < k) {
    const labPixels = new Float64Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const idx = i * channels;
      const [L, A, B] = rgbToLab(pixelData[idx], pixelData[idx + 1], pixelData[idx + 2]);
      labPixels[i * 3] = L;
      labPixels[i * 3 + 1] = A;
      labPixels[i * 3 + 2] = B;
    }
    while (centroids.length < k) {
      // K-Means++ fallback
      const distances = new Float64Array(pixelCount);
      let totalDist = 0;
      for (let i = 0; i < pixelCount; i++) {
        const idx = i * 3;
        let minDist = Infinity;
        for (const c of centroids) {
          const dL = labPixels[idx] - c[0];
          const dA = labPixels[idx + 1] - c[1];
          const dB = labPixels[idx + 2] - c[2];
          const dist = dL * dL + dA * dA + dB * dB;
          if (dist < minDist) minDist = dist;
        }
        distances[i] = minDist;
        totalDist += minDist;
      }
      if (totalDist === 0) break;
      let target = Math.random() * totalDist;
      for (let i = 0; i < pixelCount; i++) {
        target -= distances[i];
        if (target <= 0) {
          centroids.push([labPixels[i * 3], labPixels[i * 3 + 1], labPixels[i * 3 + 2]]);
          break;
        }
      }
      if (centroids.length >= k) break;
    }
  }

  return centroids.slice(0, k);
}

/** K-Means++ initialization in LAB color space (fallback) */
function initializeCentroidsKMeansPP(
  labPixels: Float64Array,
  pixelCount: number,
  k: number
): number[][] {
  const centroids: number[][] = [];

  const firstIdx = Math.floor(pixelCount * 0.25) * 3;
  centroids.push([labPixels[firstIdx], labPixels[firstIdx + 1], labPixels[firstIdx + 2]]);

  // K-Means++ for remaining centroids
  while (centroids.length < k) {
    const distances = new Float64Array(pixelCount);
    let totalDist = 0;

    for (let i = 0; i < pixelCount; i++) {
      const idx = i * 3;
      const L = labPixels[idx];
      const A = labPixels[idx + 1];
      const B = labPixels[idx + 2];

      let minDist = Infinity;
      for (const centroid of centroids) {
        const dL = L - centroid[0];
        const dA = A - centroid[1];
        const dB = B - centroid[2];
        const dist = dL * dL + dA * dA + dB * dB;
        if (dist < minDist) minDist = dist;
      }
      distances[i] = minDist;
      totalDist += minDist;
    }

    if (totalDist === 0) break;

    let target = Math.random() * totalDist;
    let selected = false;
    for (let i = 0; i < pixelCount; i++) {
      target -= distances[i];
      if (target <= 0) {
        const idx = i * 3;
        centroids.push([labPixels[idx], labPixels[idx + 1], labPixels[idx + 2]]);
        selected = true;
        break;
      }
    }

    if (!selected) {
      const randomIdx = Math.floor(Math.random() * pixelCount) * 3;
      centroids.push([labPixels[randomIdx], labPixels[randomIdx + 1], labPixels[randomIdx + 2]]);
    }
  }

  return centroids.slice(0, k);
}

function kMeansQuantizeLAB(
  labPixels: Float64Array,
  pixelCount: number,
  k: number,
  maxIterations: number = KMEANS_MAX_ITERATIONS,
  initialCentroids?: number[][]
): { centroids: number[][]; assignments: Uint8Array; inertia: number } {
  const centroids = initialCentroids || initializeCentroidsKMeansPP(labPixels, pixelCount, k);
  const assignments = new Uint8Array(pixelCount);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    // Assignment step
    for (let i = 0; i < pixelCount; i++) {
      const idx = i * 3;
      const L = labPixels[idx];
      const A = labPixels[idx + 1];
      const B = labPixels[idx + 2];

      let minDist = Infinity;
      let bestCluster = 0;

      for (let j = 0; j < k; j++) {
        const dL = L - centroids[j][0];
        const dA = A - centroids[j][1];
        const dB = B - centroids[j][2];
        const dist = dL * dL + dA * dA + dB * dB;
        if (dist < minDist) {
          minDist = dist;
          bestCluster = j;
        }
      }

      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed = true;
      }
    }

    if (!changed) break;

    // Update step
    const sums = Array.from({ length: k }, () => [0, 0, 0]);
    const counts = new Array(k).fill(0);

    for (let i = 0; i < pixelCount; i++) {
      const cluster = assignments[i];
      const idx = i * 3;
      sums[cluster][0] += labPixels[idx];
      sums[cluster][1] += labPixels[idx + 1];
      sums[cluster][2] += labPixels[idx + 2];
      counts[cluster]++;
    }

    for (let j = 0; j < k; j++) {
      if (counts[j] > 0) {
        centroids[j] = [
          sums[j][0] / counts[j],
          sums[j][1] / counts[j],
          sums[j][2] / counts[j],
        ];
      }
    }
  }

  // Calculate inertia
  let inertia = 0;
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 3;
    const c = centroids[assignments[i]];
    const dL = labPixels[idx] - c[0];
    const dA = labPixels[idx + 1] - c[1];
    const dB = labPixels[idx + 2] - c[2];
    inertia += dL * dL + dA * dA + dB * dB;
  }

  return { centroids, assignments, inertia };
}

/** Run K-Means multiple times and return the best result (lowest inertia) */
function kMeansQuantizeBestLAB(
  labPixels: Float64Array,
  pixelCount: number,
  k: number,
  rgbPixelData: Uint8Array,
  channels: number
): { centroids: number[][]; assignments: Uint8Array } {
  // Initialize centroids from histogram peaks (anchors to dominant colors)
  const histogramCentroids = initializeCentroidsHistogram(rgbPixelData, pixelCount, channels, k);

  // Run once with histogram initialization (usually the best)
  const histogramResult = kMeansQuantizeLAB(labPixels, pixelCount, k, KMEANS_MAX_ITERATIONS, histogramCentroids);

  // Also run a couple of K-Means++ trials for comparison
  let bestResult = histogramResult;
  const kmeansRetries = Math.min(KMEANS_RETRIES - 1, 2);
  for (let run = 0; run < kmeansRetries; run++) {
    const result = kMeansQuantizeLAB(labPixels, pixelCount, k);
    if (result.inertia < bestResult.inertia) {
      bestResult = result;
    }
  }

  return { centroids: bestResult.centroids, assignments: bestResult.assignments };
}

// ============================================================
// BW Tracing
// ============================================================
async function traceBW(
  imageBuffer: Buffer,
  width: number,
  height: number,
  options: VectorizeOptions
): Promise<string> {
  const traceResult = await potraceTraceCli(imageBuffer, width, height, {
    ...options,
    mode: 'bw',
  }, false);

  if (traceResult.paths.length === 0) {
    return buildCleanSVG(width, height, []);
  }

  // Transform all paths from potrace coordinates to image coordinates
  const { sx, sy, tx, ty } = traceResult.transform;
  const transformedPaths = traceResult.paths.map((d) =>
    transformSVGPath(d, sx, sy, tx, ty, options.decimalPrecision)
  );

  return buildCleanSVG(width, height, [
    { paths: transformedPaths, fill: '#000000', fillRule: 'nonzero' },
  ]);
}

// ============================================================
// Color Tracing (improved)
// ============================================================
async function traceColor(
  imageBuffer: Buffer,
  width: number,
  height: number,
  options: VectorizeOptions
): Promise<{ svg: string; palette: string[] }> {
  const channels = 3;

  // Load image pixels at full resolution
  const imageData = await sharp(imageBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data: fullData, info: fullInfo } = imageData;
  const fullPixelCount = fullInfo.width * fullInfo.height;
  const imgWidth = fullInfo.width;
  const imgHeight = fullInfo.height;

  // Convert full image to LAB for K-Means
  const fullLabPixels = new Float64Array(fullPixelCount * 3);
  for (let i = 0; i < fullPixelCount; i++) {
    const idx = i * channels;
    const [L, A, B] = rgbToLab(fullData[idx], fullData[idx + 1], fullData[idx + 2]);
    fullLabPixels[i * 3] = L;
    fullLabPixels[i * 3 + 1] = A;
    fullLabPixels[i * 3 + 2] = B;
  }

  // For K-Means, use a sample if image is very large (>800px)
  let sampleLabPixels: Float64Array;
  let samplePixelCount: number;
  let sampleRgbData: Uint8Array;

  const maxDim = Math.max(imgWidth, imgHeight);
  if (maxDim > KMEANS_SAMPLE_SIZE) {
    const scale = KMEANS_SAMPLE_SIZE / maxDim;
    const sampleWidth = Math.round(imgWidth * scale);
    const sampleHeight = Math.round(imgHeight * scale);
    const sampleImage = await sharp(imageBuffer)
      .resize(sampleWidth, sampleHeight, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    samplePixelCount = sampleWidth * sampleHeight;
    sampleRgbData = sampleImage.data;
    sampleLabPixels = new Float64Array(samplePixelCount * 3);
    for (let i = 0; i < samplePixelCount; i++) {
      const idx = i * channels;
      const [L, A, B] = rgbToLab(sampleRgbData[idx], sampleRgbData[idx + 1], sampleRgbData[idx + 2]);
      sampleLabPixels[i * 3] = L;
      sampleLabPixels[i * 3 + 1] = A;
      sampleLabPixels[i * 3 + 2] = B;
    }
  } else {
    sampleLabPixels = fullLabPixels;
    samplePixelCount = fullPixelCount;
    sampleRgbData = fullData;
  }

  // Run K-Means color quantization in LAB space
  const k = Math.max(2, options.colorCount);
  const { centroids: labCentroids } = kMeansQuantizeBestLAB(
    sampleLabPixels,
    samplePixelCount,
    k,
    sampleRgbData,
    channels
  );

  // Convert LAB centroids back to RGB
  const paletteRgb: number[][] = labCentroids.map((labCentroid) => {
    const rgb = labToRgb(labCentroid[0], labCentroid[1], labCentroid[2]);
    return [
      Math.max(0, Math.min(255, rgb[0])),
      Math.max(0, Math.min(255, rgb[1])),
      Math.max(0, Math.min(255, rgb[2])),
    ];
  });

  // Assign full image pixels to palette using LAB distance
  const fullAssignments = new Uint8Array(fullPixelCount);
  for (let i = 0; i < fullPixelCount; i++) {
    const idx = i * 3;
    const L = fullLabPixels[idx];
    const A = fullLabPixels[idx + 1];
    const B = fullLabPixels[idx + 2];

    let minDist = Infinity;
    let bestCluster = 0;
    for (let j = 0; j < paletteRgb.length; j++) {
      const cL = labCentroids[j][0];
      const cA = labCentroids[j][1];
      const cB = labCentroids[j][2];
      const dL = L - cL;
      const dA = A - cA;
      const dB = B - cB;
      const dist = dL * dL + dA * dA + dB * dB;
      if (dist < minDist) {
        minDist = dist;
        bestCluster = j;
      }
    }
    fullAssignments[i] = bestCluster;
  }

  // Apply majority filter (2 passes) to reduce salt-and-pepper noise
  // For each pixel, if 5+ of 8 neighbors share a different cluster, switch to that cluster
  for (let pass = 0; pass < 2; pass++) {
    const newAssignments = new Uint8Array(fullAssignments);
    for (let y = 1; y < imgHeight - 1; y++) {
      for (let x = 1; x < imgWidth - 1; x++) {
        const idx = y * imgWidth + x;
        const current = fullAssignments[idx];
        // Count neighbors per cluster
        const neighborCounts = new Map<number, number>();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nIdx = (y + dy) * imgWidth + (x + dx);
            const nCluster = fullAssignments[nIdx];
            neighborCounts.set(nCluster, (neighborCounts.get(nCluster) || 0) + 1);
          }
        }
        // Find the most common neighbor cluster
        let maxCount = 0;
        let dominantCluster = current;
        for (const [cluster, count] of neighborCounts) {
          if (count > maxCount) {
            maxCount = count;
            dominantCluster = cluster;
          }
        }
        // Switch if dominant cluster is different and has 5+ neighbors
        if (dominantCluster !== current && maxCount >= 5) {
          newAssignments[idx] = dominantCluster;
        }
      }
    }
    fullAssignments.set(newAssignments);
  }

  // Sort colors by area (largest first = background first, drawn at bottom)
  const colorAreas = paletteRgb.map((color, index) => {
    let count = 0;
    for (let i = 0; i < fullPixelCount; i++) {
      if (fullAssignments[i] === index) count++;
    }
    return { index, count, color };
  });
  colorAreas.sort((a, b) => b.count - a.count);

  // Skip colors with very small area (< 0.1% of total pixels)
  const minArea = Math.max(fullPixelCount * 0.001, 10);
  const significantColors = colorAreas.filter(c => c.count >= minArea);

  // Trace each color layer
  const svgPaths: Array<{ paths: string[]; fill: string; fillRule: string }> = [];

  for (let ci = 0; ci < significantColors.length; ci++) {
    const colorEntry = significantColors[ci];
    const colorIndex = colorEntry.index;
    const [cr, cg, cb] = colorEntry.color;
    const hexColor = rgbToHex(cr, cg, cb);

    // Create binary mask: pixels of this color are black (0), others white (255)
    const maskData = Buffer.alloc(fullPixelCount);
    for (let i = 0; i < fullPixelCount; i++) {
      maskData[i] = fullAssignments[i] === colorIndex ? 0 : 255;
    }

    // Apply morphological close operation using sharp:
    // Dilate then erode to fill 1px gaps without expanding boundaries
    const maskSharp = sharp(maskData, {
      raw: { width: imgWidth, height: imgHeight, channels: 1 },
    });

    // Use median(3) for a strong morphological cleanup that removes small noise
    const cleanedMaskBuffer = await maskSharp
      .median(3)
      .png()
      .toBuffer();

    // Write to temp PGM
    const tmpDir = path.join(os.tmpdir(), 'vectorforge');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-c${colorIndex}`;
    const pgmPath = path.join(tmpDir, `${tmpId}.pgm`);
    const svgPath = path.join(tmpDir, `${tmpId}.svg`);

    try {
      // Read the cleaned mask as raw grayscale
      const cleanedGray = await sharp(cleanedMaskBuffer)
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const header = `P5\n${imgWidth} ${imgHeight}\n255\n`;
      const headerBuf = Buffer.from(header, 'ascii');
      const pgmBuf = Buffer.concat([headerBuf, cleanedGray.data]);
      await fs.writeFile(pgmPath, pgmBuf);

      // Trace with potrace — use larger turdsize for masks to skip tiny specks
      const effectiveTurdSize = Math.max(options.turdSize, 5);
      const args: string[] = [
        '-s',
        '-o',
        svgPath,
        '--turdsize',
        String(effectiveTurdSize),
        '--alphamax',
        String(options.alphaMax),
        ...(options.optCurve ? [] : ['--longcurve']),
        '--opttolerance',
        String(options.optTolerance),
        '-k',
        '0.5', // Binary threshold
        pgmPath,
      ];

      await execFileAsync('potrace', args, { timeout: 60000 });

      const rawSvg = await fs.readFile(svgPath, 'utf-8');
      const traceResult = parsePotraceSvg(rawSvg);

      if (traceResult.paths.length > 0) {
        const { sx, sy, tx, ty } = traceResult.transform;
        const transformedPaths = traceResult.paths.map((d) =>
          transformSVGPath(d, sx, sy, tx, ty, options.decimalPrecision)
        );
        // Use evenodd for all color paths to handle cutouts correctly
        svgPaths.push({ paths: transformedPaths, fill: hexColor, fillRule: 'evenodd' });
      }
    } finally {
      await fs.unlink(pgmPath).catch(() => {});
      await fs.unlink(svgPath).catch(() => {});
    }
  }

  const svg = buildCleanSVG(width, height, svgPaths);
  const paletteHex = colorAreas.map((c) => rgbToHex(c.color[0], c.color[1], c.color[2]));

  return { svg, palette: paletteHex };
}

// ============================================================
// Build Clean SVG from Transformed Paths
// ============================================================
function buildCleanSVG(
  width: number,
  height: number,
  colorGroups: Array<{ paths: string[]; fill: string; fillRule: string }>
): string {
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n`;

  for (const group of colorGroups) {
    for (const d of group.paths) {
      // Filter out tiny paths (bounding box area check)
      const bboxArea = estimatePathBBoxArea(d);
      if (bboxArea < MIN_PATH_BBOX_AREA) continue;

      svg += `<path d="${d}" fill="${group.fill}" fill-rule="${group.fillRule}"/>\n`;
    }
  }

  svg += `</svg>`;
  return svg;
}

/**
 * Estimate bounding box area from path data (rough check for filtering tiny paths).
 * Returns the area of the bounding box of all coordinates in the path.
 */
function estimatePathBBoxArea(d: string): number {
  const numbers = d.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
  if (!numbers || numbers.length < 4) return 0;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  // Skip every other pair that might be control points —
  // For a rough estimate, just use all coordinate values
  for (let i = 0; i < numbers.length - 1; i += 2) {
    const x = parseFloat(numbers[i]);
    const y = parseFloat(numbers[i + 1]);
    if (isFinite(x) && isFinite(y)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (!isFinite(minX) || !isFinite(maxX)) return 0;
  const area = (maxX - minX) * (maxY - minY);
  return area;
}

// ============================================================
// Utility Functions
// ============================================================

function labToRgb(L: number, A: number, B: number): [number, number, number] {
  // Lab → XYZ (D65)
  const fy = (L + 16) / 116;
  const fx = A / 500 + fy;
  const fz = fy - B / 200;

  const xr = fx > 0.206897 ? fx * fx * fx : (fx - 16 / 116) / 7.787;
  const yr = fy > 0.206897 ? fy * fy * fy : (fy - 16 / 116) / 7.787;
  const zr = fz > 0.206897 ? fz * fz * fz : (fz - 16 / 116) / 7.787;

  const x = xr * 0.95047;
  const y = yr * 1.0;
  const z = zr * 1.08883;

  // XYZ → linear RGB
  const lr = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const lg = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  const lb = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  const r = linearToSrgb(lr);
  const g = linearToSrgb(lg);
  const b = linearToSrgb(lb);

  // Guard against NaN (from out-of-gamut Lab values)
  return [
    isFinite(r) ? r : 0,
    isFinite(g) ? g : 0,
    isFinite(b) ? b : 0,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function countPaths(svg: string): number {
  return (svg.match(/<path/g) || []).length;
}

function countNodes(svg: string): number {
  const m = svg.match(/[Mm]\s*[\d.-]/g);
  return m ? m.length : 0;
}

function optimizeSVG(svg: string, options: VectorizeOptions): string {
  let optimized = svg;
  if (options.decimalPrecision < 4) {
    optimized = optimized.replace(/(\d+\.\d+)[0\s]+(?=[^.\d])/g, (_, num) => {
      return parseFloat(num).toString();
    });
  }
  return optimized;
}

// ============================================================
// SVG Path → PostScript Conversion (for EPS output)
// ============================================================

function svgPathToPostScript(d: string): string {
  const commands = parseSVGPath(d);
  const lines: string[] = [];
  let curX = 0,
    curY = 0;

  for (const { cmd, args } of commands) {
    const isRelative = cmd === cmd.toLowerCase();
    const base = cmd.toUpperCase();

    switch (base) {
      case 'M': {
        for (let i = 0; i < args.length; i += 2) {
          if (i + 1 >= args.length) break;
          const x = args[i], y = args[i + 1];
          if (isRelative) {
            curX += x;
            curY += y;
          } else {
            curX = x;
            curY = y;
          }
          lines.push(`${curX} ${curY} moveto`);
        }
        break;
      }
      case 'L': {
        for (let i = 0; i < args.length; i += 2) {
          if (i + 1 >= args.length) break;
          const x = args[i], y = args[i + 1];
          if (isRelative) {
            curX += x;
            curY += y;
          } else {
            curX = x;
            curY = y;
          }
          lines.push(`${curX} ${curY} lineto`);
        }
        break;
      }
      case 'H': {
        for (const x of args) {
          if (isRelative) {
            curX += x;
          } else {
            curX = x;
          }
          lines.push(`${curX} ${curY} lineto`);
        }
        break;
      }
      case 'V': {
        for (const y of args) {
          if (isRelative) {
            curY += y;
          } else {
            curY = y;
          }
          lines.push(`${curX} ${curY} lineto`);
        }
        break;
      }
      case 'C': {
        for (let i = 0; i < args.length; i += 6) {
          if (i + 5 >= args.length) break;
          if (isRelative) {
            const cx1 = curX + args[i], cy1 = curY + args[i + 1];
            const cx2 = curX + args[i + 2], cy2 = curY + args[i + 3];
            const ex = curX + args[i + 4], ey = curY + args[i + 5];
            lines.push(`${cx1} ${cy1} ${cx2} ${cy2} ${ex} ${ey} curveto`);
            curX = ex;
            curY = ey;
          } else {
            lines.push(
              `${args[i]} ${args[i + 1]} ${args[i + 2]} ${args[i + 3]} ${args[i + 4]} ${args[i + 5]} curveto`
            );
            curX = args[i + 4];
            curY = args[i + 5];
          }
        }
        break;
      }
      case 'S': {
        for (let i = 0; i < args.length; i += 4) {
          if (i + 3 >= args.length) break;
          if (isRelative) {
            const cx2 = curX + args[i], cy2 = curY + args[i + 1];
            const ex = curX + args[i + 2], ey = curY + args[i + 3];
            lines.push(`${cx2} ${cy2} ${ex} ${ey} curveto`);
            curX = ex;
            curY = ey;
          } else {
            lines.push(
              `${args[i]} ${args[i + 1]} ${args[i + 2]} ${args[i + 3]} curveto`
            );
            curX = args[i + 2];
            curY = args[i + 3];
          }
        }
        break;
      }
      case 'Q': {
        for (let i = 0; i < args.length; i += 4) {
          if (i + 3 >= args.length) break;
          let qx: number, qy: number, ex: number, ey: number;
          if (isRelative) {
            qx = curX + args[i];
            qy = curY + args[i + 1];
            ex = curX + args[i + 2];
            ey = curY + args[i + 3];
          } else {
            qx = args[i];
            qy = args[i + 1];
            ex = args[i + 2];
            ey = args[i + 3];
          }
          // Convert quadratic to cubic bezier
          const cx1 = curX + (2 / 3) * (qx - curX);
          const cy1 = curY + (2 / 3) * (qy - curY);
          const cx2 = ex + (2 / 3) * (qx - ex);
          const cy2 = ey + (2 / 3) * (qy - ey);
          lines.push(`${cx1.toFixed(2)} ${cy1.toFixed(2)} ${cx2.toFixed(2)} ${cy2.toFixed(2)} ${ex} ${ey} curveto`);
          curX = ex;
          curY = ey;
        }
        break;
      }
      case 'Z': {
        lines.push('closepath');
        break;
      }
    }
  }

  return lines.join('\n');
}

export function generateEPS(svg: string, width: number, height: number): string {
  const pathRegex = /<path\s+d="([^"]+)"(?:\s+fill="([^"]+)")?/g;
  const paths: { d: string; fill: string }[] = [];
  let pathMatch: RegExpExecArray | null;

  while ((pathMatch = pathRegex.exec(svg)) !== null) {
    paths.push({
      d: pathMatch[1],
      fill: pathMatch[2] || '#000000',
    });
  }

  let eps = `%!PS-Adobe-3.0 EPSF-3.0\n`;
  eps += `%%BoundingBox: 0 0 ${width} ${height}\n`;
  eps += `%%Title: VectorForge Export\n`;
  eps += `%%Creator: VectorForge Bitmap-to-Vector Engine\n`;
  eps += `%%EndComments\n\n`;

  for (const p of paths) {
    const [r, g, b] = hexToRgb(p.fill);
    const rn = (r / 255).toFixed(4);
    const gn = (g / 255).toFixed(4);
    const bn = (b / 255).toFixed(4);

    eps += `newpath\n`;
    eps += svgPathToPostScript(p.d);
    eps += `\n${rn} ${gn} ${bn} setrgbcolor\n`;
    eps += `fill\n\n`;
  }

  eps += `showpage\n%%EOF\n`;
  return eps;
}

// ============================================================
// Main Vectorization Function
// ============================================================

export async function vectorize(
  imageBuffer: Buffer,
  options: VectorizeOptions = defaultOptions
): Promise<VectorizeResult> {
  const startTime = Date.now();

  const originalMeta = await sharp(imageBuffer).metadata();
  const preprocessed = await preprocessImage(imageBuffer, options);
  const meta = await sharp(preprocessed).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;

  let svg: string;
  let colorPalette: string[];

  if (options.mode === 'bw') {
    svg = await traceBW(preprocessed, width, height, options);
    colorPalette = ['#000000', '#ffffff'];
  } else {
    const result = await traceColor(preprocessed, width, height, options);
    svg = result.svg;
    colorPalette = result.palette;
  }

  svg = optimizeSVG(svg, options);

  const pathCount = countPaths(svg);
  const nodeCount = countNodes(svg);
  const fileSize = Buffer.byteLength(svg, 'utf-8');
  const processingTime = Date.now() - startTime;

  const eps = generateEPS(svg, width, height);
  const epsSize = Buffer.byteLength(eps, 'utf-8');

  return {
    svg,
    eps,
    width,
    height,
    pathCount,
    nodeCount,
    fileSize,
    epsSize,
    processingTime,
    originalSize: {
      width: originalMeta.width || 0,
      height: originalMeta.height || 0,
    },
    colorPalette,
  };
}
