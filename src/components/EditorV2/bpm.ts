// Beat analysis for the timeline grid. Pure TypeScript (no WebAudio), so
// the whole pipeline is testable against synthesized click tracks (yarn
// test:bpm).
//
// The design follows the standard beat-tracking recipe (Scheirer 1998,
// Ellis 2007):
//
// 1. NOVELTY. Low-pass the song (biquad at 150 Hz, two passes) to isolate
//    kicks, then frame the signal and take the half-wave rectified
//    difference of log-compressed frame energies. Rises in low-band
//    energy become spikes; steady state becomes silence.
// 2. TEMPO. Autocorrelate the novelty over lags spanning 60-200 BPM.
//    Each lag's score is reinforced by its harmonics (2x, 3x, 4x the
//    lag), which resolves octave ambiguities; the winning lag is refined
//    by parabolic interpolation for sub-BPM precision, then folded into
//    the 90-180 range.
// 3. PHASE. Try many candidate grid offsets within one beat period and
//    keep the one whose grid lines collect the most novelty (with a
//    one-frame tolerance). Unlike averaging onset phases, this puts the
//    grid ON the kicks by construction: off-beat energy can only win by
//    outweighing the on-beat energy, not by dragging a mean sideways.
//
// Assumes a constant tempo, which holds for the electronic sets this
// tool is aimed at.

export type BpmAnalysis = {
  bpm: number;
  // Time of the first beat, in seconds; the grid is offset + k * (60/bpm).
  offsetSeconds: number;
  // 0..1; how much of the song's onset energy lands on the chosen grid.
  confidence: number;
};

const FRAME = 1024;
const HOP = 512;
// Novelty frames lead the audio slightly: a transient raises the energy
// of every frame whose window overlaps it, so the rise registers about a
// frame before the transient's own time. Calibrated against synthesized
// kicks (yarn test:bpm asserts grid-to-kick alignment).
const ONSET_CORRECTION_FRAMES = 1.15;

// RBJ cookbook biquad lowpass, applied in place per pass.
const lowpass = (
  input: Float32Array,
  sampleRate: number,
  cutoff: number,
  passes: number,
) => {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w0) / (2 * 0.7071);
  const cos = Math.cos(w0);
  const b0 = (1 - cos) / 2;
  const b1 = 1 - cos;
  const b2 = (1 - cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;

  const out = Float32Array.from(input);
  for (let pass = 0; pass < passes; pass++) {
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x0 = out[i];
      const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      out[i] = y0;
    }
  }
  return out;
};

export const analyzeBpmSamples = (
  input: Float32Array,
  sampleRate: number,
): BpmAnalysis | null => {
  if (input.length < sampleRate * 4) return null;

  const low = lowpass(input, sampleRate, 150, 2);

  // Log-compressed frame energies.
  const frameCount = Math.floor((low.length - FRAME) / HOP);
  const frameRate = sampleRate / HOP;
  if (frameCount < frameRate * 4) return null;
  const energy = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    const start = i * HOP;
    for (let j = 0; j < FRAME; j++) sum += low[start + j] * low[start + j];
    energy[i] = Math.log1p(1000 * Math.sqrt(sum / FRAME));
  }

  // Novelty: rectified energy rise.
  const novelty = new Float32Array(frameCount);
  let noveltyTotal = 0;
  for (let i = 1; i < frameCount; i++) {
    novelty[i] = Math.max(0, energy[i] - energy[i - 1]);
    noveltyTotal += novelty[i];
  }
  if (noveltyTotal <= 0) return null;

  // Autocorrelation with the mean removed, over 60..200 BPM lags.
  const mean = noveltyTotal / frameCount;
  const centered = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) centered[i] = novelty[i] - mean;
  const minLag = Math.max(2, Math.floor((60 / 200) * frameRate));
  const maxLag = Math.min(frameCount - 2, Math.ceil((60 / 60) * frameRate));
  if (maxLag <= minLag) return null;
  const maxHarmonicLag = Math.min(frameCount - 1, maxLag * 4 + 2);
  const acf = new Float32Array(maxHarmonicLag + 1);
  for (let lag = minLag; lag <= maxHarmonicLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < frameCount; i++)
      sum += centered[i] * centered[i + lag];
    acf[lag] = Math.max(0, sum / (frameCount - lag));
  }

  const harmonicScore = (lag: number) => {
    let score = 0;
    for (let harmonic = 1; harmonic <= 4; harmonic++) {
      const at = Math.round(lag * harmonic);
      if (at > maxHarmonicLag) break;
      // Neighborhood max softens rounding error at higher harmonics.
      const value = Math.max(acf[at] ?? 0, acf[at - 1] ?? 0, acf[at + 1] ?? 0);
      score += value / harmonic;
    }
    return score;
  };

  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = harmonicScore(lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestScore <= 0) return null;

  let bpm = (60 * frameRate) / bestLag;
  while (bpm < 90) bpm *= 2;
  while (bpm >= 180) bpm /= 2;
  const initialPeriod = (60 * frameRate) / bpm;

  // Novelty with a one-frame tolerance window on both sides, for the
  // grid scoring below.
  const tolerant = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++)
    tolerant[i] = Math.max(
      novelty[i],
      novelty[i - 1] ?? 0,
      novelty[i + 1] ?? 0,
    );

  // The offset (in frames, within one period) whose grid collects the
  // most tolerant novelty, for a given period.
  const bestOffsetFor = (period: number, steps: number) => {
    let bestOffset = 0;
    let bestSum = -Infinity;
    for (let step = 0; step < steps; step++) {
      const offset = (step / steps) * period;
      let sum = 0;
      for (let position = offset; position < frameCount; position += period)
        sum += tolerant[Math.round(position)] ?? 0;
      if (sum > bestSum) {
        bestSum = sum;
        bestOffset = offset;
      }
    }
    return { offset: bestOffset, sum: bestSum };
  };

  // Coarse joint search: the integer-lag tempo can be off by a couple of
  // percent, which drifts the grid over a whole song. Sweep periods
  // around the estimate and keep the one whose best grid collects the
  // most onset energy.
  let period = initialPeriod;
  let offset = 0;
  let gridSum = -Infinity;
  for (let i = -30; i <= 30; i++) {
    const candidate = initialPeriod * (1 + i / 1000);
    const { offset: candidateOffset, sum } = bestOffsetFor(candidate, 64);
    if (sum > gridSum) {
      gridSum = sum;
      period = candidate;
      offset = candidateOffset;
    }
  }

  // Precision: match each grid line to the strongest novelty peak nearby
  // (sub-frame position via parabolic interpolation), then fit
  // time = offset + k * period by weighted least squares. Two passes,
  // the second with a tighter window. Regression over the whole song
  // pins both tempo and phase with no cumulative drift.
  for (const window of [3, 1.5]) {
    let sumW = 0;
    let sumWk = 0;
    let sumWt = 0;
    let sumWkk = 0;
    let sumWkt = 0;
    const count = Math.floor((frameCount - offset) / period);
    for (let k = 0; k <= count; k++) {
      const grid = offset + k * period;
      const from = Math.max(1, Math.round(grid - window));
      const to = Math.min(frameCount - 2, Math.round(grid + window));
      let peakAt = -1;
      let peakValue = 0;
      for (let i = from; i <= to; i++)
        if (novelty[i] > peakValue) {
          peakValue = novelty[i];
          peakAt = i;
        }
      if (peakAt < 0 || peakValue <= 0) continue;
      // Sub-frame peak position.
      const a = novelty[peakAt - 1];
      const b = novelty[peakAt];
      const c = novelty[peakAt + 1];
      const denominator = a - 2 * b + c;
      const shift =
        Math.abs(denominator) > 1e-12
          ? Math.min(Math.max((0.5 * (a - c)) / denominator, -0.5), 0.5)
          : 0;
      const t = peakAt + shift;
      const w = peakValue;
      sumW += w;
      sumWk += w * k;
      sumWt += w * t;
      sumWkk += w * k * k;
      sumWkt += w * k * t;
    }
    const det = sumW * sumWkk - sumWk * sumWk;
    if (sumW <= 0 || Math.abs(det) < 1e-9) break;
    const fittedOffset = (sumWkk * sumWt - sumWk * sumWkt) / det;
    const fittedPeriod = (sumW * sumWkt - sumWk * sumWt) / det;
    if (fittedPeriod > 0) {
      period = fittedPeriod;
      offset = fittedOffset;
    }
  }

  bpm = (60 * frameRate) / period;
  while (bpm < 90) bpm *= 2;
  while (bpm >= 180) bpm /= 2;
  const normalizedOffset = ((offset % period) + period) % period;
  const offsetSeconds =
    ((normalizedOffset + ONSET_CORRECTION_FRAMES) * HOP) / sampleRate;

  // Confidence: the share of total onset energy the final grid collects,
  // relative to what a uniform spread would collect.
  const { sum: finalSum } = bestOffsetFor(period, 128);
  const gridPoints = Math.max(1, Math.floor(frameCount / period));
  const uniformShare = Math.min(0.9, (gridPoints * 3) / frameCount);
  const gridShare = finalSum / noveltyTotal;
  const confidence = Math.min(
    1,
    Math.max(0, (gridShare - uniformShare) / (1 - uniformShare)),
  );

  return { bpm, offsetSeconds, confidence };
};

// Browser entry point, kept async for call-site compatibility.
export async function analyzeBpm(
  buffer: AudioBuffer,
): Promise<BpmAnalysis | null> {
  return analyzeBpmSamples(buffer.getChannelData(0), buffer.sampleRate);
}
