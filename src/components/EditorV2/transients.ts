// Transient (onset) detection for snap-to-transient editing. Pure
// TypeScript, testable against synthesized tracks (yarn test:transients).
//
// The design follows the standard onset-detection recipe (Bello 2005,
// Dixon "Onset Detection Revisited" 2006):
//
// 1. DETECTION FUNCTION. Split the signal into three bands (low < 150Hz,
//    mid, high > 2kHz), frame each, and take the half-wave rectified
//    difference of log-compressed frame energies, summed across bands.
//    The log compression keeps quiet hats registering next to loud
//    kicks; the band split keeps a hat's rise from hiding under a
//    simultaneous bass note's energy. Frames hop every 256 samples
//    (~5ms) for editing-grade time resolution.
//
// 2. PEAK PICKING (the part that needs a sensitivity). A frame is an
//    onset when it is the local maximum within a small window, rises
//    above delta + sensitivity * localMean (the mean spans a few hundred
//    milliseconds, so build-ups do not spray false onsets and breakdowns
//    still register soft hits), and reaches a fraction of the strongest
//    peak within a second (a blip several times quieter than the
//    material around it is an artifact, not a snap target). The
//    sensitivity multiplier scales both adaptive criteria: the single
//    dial trading missed onsets against phantom ones. Onsets closer
//    than 50ms merge into the stronger one.
//
// 3. TIMING. Sub-frame peak position by parabolic interpolation, minus a
//    small constant lead (energy rises register slightly before the
//    transient's own time), calibrated against synthesized clicks.

// Relative import so ts-node test scripts resolve it without the "@/"
// alias (same pattern as automation.ts).
import { lowpass } from "./bpm";

const FRAME = 1024;
const HOP = 256;
// Local-max window (frames) for peak picking: ~16ms each side.
const PEAK_WINDOW = 3;
// Adaptive-mean window (frames): ~330ms each side.
const MEAN_WINDOW = 62;
// Onsets closer than this merge into the stronger one.
const MIN_GAP_SECONDS = 0.05;
// Local-max window (frames): ~1s each side, for the relative floor.
const MAX_WINDOW = 187;
// At the default sensitivity, an onset must reach this fraction of the
// strongest onset within a second of it. Quiet REAL hits (a hat between
// kicks) sit well above it; incidental blips a few times quieter than
// their surroundings fall below.
const RELATIVE_FLOOR = 0.25;
// Absolute floor (in normalized novelty units) so silence stays silent:
// broadband noise sums across the three normalized bands, so the floor
// sits above what noise alone reaches (calibrated in test:transients,
// which demands a phantom-free 5s silent gap).
const DELTA = 1.2;
// The default sensitivity: threshold = DELTA + sensitivity * localMean.
// Lower finds more (and more dubious) onsets; higher keeps only the
// obvious hits. Calibrated on synthesized kick/hat/ghost tracks.
export const DEFAULT_SENSITIVITY = 1.5;
// Frame-time correction, in frames, SUBTRACTED from the peak position.
// Negative: frame i's energy covers samples [i*HOP, i*HOP + FRAME), so
// its timestamp (i*HOP) sits well before the audio that produced the
// rise, and the novelty peak lands ~3 frames before the transient's
// true time. Calibrated against synthesized kicks and hats (both land
// within 0.5ms of truth at this value; yarn test:transients).
const ONSET_LEAD_FRAMES = -3.15;

export const analyzeTransientSamples = (
  input: Float32Array,
  sampleRate: number,
  sensitivity = DEFAULT_SENSITIVITY,
): number[] => {
  if (input.length < FRAME * 4) return [];
  const frameCount = Math.floor((input.length - FRAME) / HOP);
  if (frameCount < 8) return [];

  // Three bands from two lowpass splits.
  const low = lowpass(input, sampleRate, 150, 2);
  const lowMid = lowpass(input, sampleRate, 2000, 2);
  const bands = [
    (i: number) => low[i],
    (i: number) => lowMid[i] - low[i],
    (i: number) => input[i] - lowMid[i],
  ];

  const combined = new Float32Array(frameCount);
  const bandNovelty = new Float32Array(frameCount);
  for (const band of bands) {
    let previous = 0;
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      const start = i * HOP;
      for (let j = 0; j < FRAME; j++) {
        const value = band(start + j);
        sum += value * value;
      }
      const energy = Math.log1p(1000 * Math.sqrt(sum / FRAME));
      bandNovelty[i] = i === 0 ? 0 : Math.max(0, energy - previous);
      previous = energy;
    }
    for (let i = 0; i < frameCount; i++) combined[i] += bandNovelty[i];
  }

  // One global normalization so DELTA and the sensitivity are
  // scale-free across recordings. Per-band normalization would equalize
  // the bands too, but it backfires: a nearly-empty band has a tiny
  // spread and amplifies its noise into phantom onsets. The log
  // compression above already keeps quiet hits competitive with loud
  // ones inside each band.
  {
    let mean = 0;
    for (let i = 0; i < frameCount; i++) mean += combined[i];
    mean /= frameCount;
    let variance = 0;
    for (let i = 0; i < frameCount; i++) {
      const d = combined[i] - mean;
      variance += d * d;
    }
    const std = Math.sqrt(variance / frameCount) || 1;
    for (let i = 0; i < frameCount; i++) combined[i] /= std;
  }

  // Prefix sums make the adaptive local mean O(1) per frame.
  const prefix = new Float64Array(frameCount + 1);
  for (let i = 0; i < frameCount; i++) prefix[i + 1] = prefix[i] + combined[i];
  const localMean = (i: number) => {
    const from = Math.max(0, i - MEAN_WINDOW);
    const to = Math.min(frameCount - 1, i + MEAN_WINDOW);
    return (prefix[to + 1] - prefix[from]) / (to + 1 - from);
  };
  const localMax = (i: number) => {
    const from = Math.max(0, i - MAX_WINDOW);
    const to = Math.min(frameCount - 1, i + MAX_WINDOW);
    let max = 0;
    for (let j = from; j <= to; j++) if (combined[j] > max) max = combined[j];
    return max;
  };

  // The relative floor scales with sensitivity so a permissive setting
  // genuinely hears more, all the way down to the noise floor.
  const relativeFloor = (RELATIVE_FLOOR * sensitivity) / DEFAULT_SENSITIVITY;
  const minGapFrames = (MIN_GAP_SECONDS * sampleRate) / HOP;
  const onsets: { frame: number; strength: number }[] = [];
  for (let i = 1; i < frameCount - 1; i++) {
    const value = combined[i];
    if (value < DELTA + sensitivity * localMean(i)) continue;
    // Insignificant next to its neighborhood's real hits: a blip a few
    // times quieter than the material around it is an artifact, not a
    // snap target.
    if (value < relativeFloor * localMax(i)) continue;
    // Local maximum within the peak window.
    let isPeak = true;
    for (let j = Math.max(0, i - PEAK_WINDOW); j <= i + PEAK_WINDOW; j++) {
      if (j < frameCount && combined[j] > value) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    const last = onsets[onsets.length - 1];
    if (last && i - last.frame < minGapFrames) {
      if (value > last.strength)
        onsets[onsets.length - 1] = { frame: i, strength: value };
      continue;
    }
    onsets.push({ frame: i, strength: value });
  }

  return onsets.map(({ frame }) => {
    // Sub-frame peak position.
    const a = combined[frame - 1] ?? 0;
    const b = combined[frame];
    const c = combined[frame + 1] ?? 0;
    const denominator = a - 2 * b + c;
    const shift =
      Math.abs(denominator) > 1e-12
        ? Math.min(Math.max((0.5 * (a - c)) / denominator, -0.5), 0.5)
        : 0;
    return Math.max(
      0,
      ((frame + shift - ONSET_LEAD_FRAMES) * HOP) / sampleRate,
    );
  });
};

// Browser entry point, kept async for call-site symmetry with analyzeBpm.
export async function analyzeTransients(
  buffer: AudioBuffer,
): Promise<number[]> {
  return analyzeTransientSamples(buffer.getChannelData(0), buffer.sampleRate);
}
