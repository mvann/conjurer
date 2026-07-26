/**
 * Diagnostic: run the BPM analyzer against a real audio file and measure
 * how the beat grid's residuals evolve over the song. A straight sloped
 * residual line means the tempo is constant but our period is slightly
 * off (fixable); a curved or wandering line means the source itself
 * drifts (a constant grid cannot fit it).
 *
 *   yarn ts-node --project tsconfig.script.json \
 *     src/scripts/measureBpmDrift.ts "public/cloud-assets/audio/<file>"
 *
 * Requires ffmpeg on PATH for decoding.
 */
import { execFileSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyzeBpmSamples } from "../components/EditorV2/bpm";

const SAMPLE_RATE = Number(process.env.BPM_RATE ?? 44100);
const FRAME = 1024;
const HOP = 512;

const decode = (path: string): Float32Array => {
  const raw = join(tmpdir(), `bpm-drift-${process.pid}.f32`);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    path,
    "-f",
    "f32le",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    raw,
  ]);
  const buffer = readFileSync(raw);
  unlinkSync(raw);
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 4,
  );
};

// The analyzer's novelty pipeline, reproduced for measurement.
const noveltyOf = (input: Float32Array) => {
  const w0 = (2 * Math.PI * 150) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * 0.7071);
  const cos = Math.cos(w0);
  const b0 = (1 - cos) / 2;
  const b1 = 1 - cos;
  const b2 = (1 - cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const low = Float32Array.from(input);
  for (let pass = 0; pass < 2; pass++) {
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let i = 0; i < low.length; i++) {
      const x0 = low[i];
      const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      low[i] = y0;
    }
  }
  const frameCount = Math.floor((low.length - FRAME) / HOP);
  const energy = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    const start = i * HOP;
    for (let j = 0; j < FRAME; j++) sum += low[start + j] * low[start + j];
    energy[i] = Math.log1p(1000 * Math.sqrt(sum / FRAME));
  }
  const novelty = new Float32Array(frameCount);
  for (let i = 1; i < frameCount; i++)
    novelty[i] = Math.max(0, energy[i] - energy[i - 1]);
  return novelty;
};

const path = process.argv[2];
if (!path) {
  console.error("usage: measureBpmDrift.ts <audio file>");
  process.exit(1);
}

const samples = decode(path);
const durationSeconds = samples.length / SAMPLE_RATE;
const analysis = analyzeBpmSamples(samples, SAMPLE_RATE);
if (!analysis) {
  console.error("analyzer returned null");
  process.exit(1);
}
console.log(
  `duration ${durationSeconds.toFixed(1)}s | bpm ${analysis.bpm.toFixed(4)} ` +
    `| offset ${analysis.offsetSeconds.toFixed(4)}s | confidence ${analysis.confidence.toFixed(2)}`,
);

const novelty = noveltyOf(samples);
const frameRate = SAMPLE_RATE / HOP;
const periodFrames = (60 / analysis.bpm) * frameRate;
// The analyzer reports offsets corrected by its onset-lead constant;
// undo that to compare against raw novelty peaks.
const offsetFrames = (analysis.offsetSeconds * SAMPLE_RATE) / HOP - 1.15;

// Match each grid line to the strongest nearby novelty peak (generous
// window so late-song drift still matches the true kicks).
const WINDOW = 6;
type Residual = { k: number; ms: number; weight: number };
const residuals: Residual[] = [];
const beats = Math.floor((novelty.length - offsetFrames) / periodFrames);
for (let k = 0; k <= beats; k++) {
  const grid = offsetFrames + k * periodFrames;
  const from = Math.max(1, Math.round(grid - WINDOW));
  const to = Math.min(novelty.length - 2, Math.round(grid + WINDOW));
  let peakAt = -1;
  let peakValue = 0;
  for (let i = from; i <= to; i++)
    if (novelty[i] > peakValue) {
      peakValue = novelty[i];
      peakAt = i;
    }
  if (peakAt < 0 || peakValue <= 0) continue;
  const a = novelty[peakAt - 1];
  const b = novelty[peakAt];
  const c = novelty[peakAt + 1];
  const denominator = a - 2 * b + c;
  const shift =
    Math.abs(denominator) > 1e-12
      ? Math.min(Math.max((0.5 * (a - c)) / denominator, -0.5), 0.5)
      : 0;
  residuals.push({
    k,
    ms: (((peakAt + shift - grid) * HOP) / SAMPLE_RATE) * 1000,
    weight: peakValue,
  });
}

// Weighted linear fit of residual vs beat index.
let sw = 0,
  swk = 0,
  swr = 0,
  swkk = 0,
  swkr = 0;
for (const { k, ms, weight } of residuals) {
  sw += weight;
  swk += weight * k;
  swr += weight * ms;
  swkk += weight * k * k;
  swkr += weight * k * ms;
}
const det = sw * swkk - swk * swk;
const slope = (sw * swkr - swk * swr) / det;
const intercept = (swkk * swr - swk * swkr) / det;
console.log(
  `matched ${residuals.length}/${beats + 1} beats | ` +
    `residual slope ${(slope * 1000).toFixed(2)}us/beat | ` +
    `intercept ${intercept.toFixed(2)}ms | ` +
    `implied total drift ${(slope * beats).toFixed(1)}ms over the song`,
);
const impliedBpm = analysis.bpm / (1 + (slope / 1000 / 60) * analysis.bpm);
console.log(`implied true bpm ${impliedBpm.toFixed(4)}`);

// Curvature check: mean residual per song sixth. Roughly linear means a
// constant-tempo source; wandering means real tempo drift.
const SLICES = 6;
for (let s = 0; s < SLICES; s++) {
  const from = (beats / SLICES) * s;
  const to = (beats / SLICES) * (s + 1);
  const slice = residuals.filter(({ k }) => k >= from && k < to);
  if (slice.length === 0) continue;
  let weightSum = 0;
  let msSum = 0;
  for (const { ms, weight } of slice) {
    weightSum += weight;
    msSum += weight * ms;
  }
  console.log(
    `sixth ${s + 1}: mean residual ${(msSum / weightSum).toFixed(2)}ms ` +
      `(${slice.length} beats)`,
  );
}
