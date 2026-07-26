/**
 * Tests for the transient detector (yarn test:transients) against
 * synthesized tracks with known hit times.
 *
 * Invariants:
 * - Every synthesized hit (kicks AND quiet hats: the multi-band novelty
 *   must hear both) is detected within 10ms.
 * - No onsets appear inside a long silent gap.
 * - Sensitivity behaves: at the default, small blips sitting between
 *   the real hits are ignored (the adaptive threshold tracks the local
 *   loudness); a permissive sensitivity hears them. Onset count matches
 *   the true count exactly.
 */
import { analyzeTransientSamples } from "../components/EditorV2/transients";

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.error("FAIL: " + message);
};

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SAMPLE_RATE = 48000;

const addBurst = (
  data: Float32Array,
  at: number,
  frequency: number,
  amplitude: number,
  decaySeconds: number,
) => {
  const start = Math.round(at * SAMPLE_RATE);
  const length = Math.round(decaySeconds * 4 * SAMPLE_RATE);
  for (let i = 0; i < length && start + i < data.length; i++) {
    const t = i / SAMPLE_RATE;
    data[start + i] +=
      amplitude *
      Math.exp(-t / decaySeconds) *
      Math.sin(2 * Math.PI * frequency * t);
  }
};

// A 40-second track: kicks every 0.6s for the first 15s, then a 5s
// silent gap, then alternating kicks and QUIET HATS for the rest.
// Ghost blips sit barely above the noise floor and must not register.
const random = mulberry32(7);
const seconds = 40;
const data = new Float32Array(seconds * SAMPLE_RATE);
const trueHits: number[] = [];
for (let t = 0.5; t < 15; t += 0.6) {
  trueHits.push(t);
  addBurst(data, t, 55, 0.9, 0.05);
}
for (let t = 20.5; t < seconds - 0.5; t += 0.6) {
  trueHits.push(t);
  if (Math.round(t / 0.6) % 2 === 0) addBurst(data, t, 55, 0.9, 0.05);
  else addBurst(data, t, 5200, 0.18, 0.02);
}
// Ghosts: small blips tucked between the loud hits. The adaptive
// threshold must ignore them at the default sensitivity: next to real
// material they are insignificant artifacts, not snap targets.
for (const t of [3.25, 7.45, 22.15]) addBurst(data, t, 900, 0.025, 0.01);
for (let i = 0; i < data.length; i++) data[i] += (random() - 0.5) * 0.02;

const onsets = analyzeTransientSamples(data, SAMPLE_RATE);

// Every true hit detected, and timed within 10ms.
let worst = 0;
for (const hit of trueHits) {
  let best = Infinity;
  for (const onset of onsets) best = Math.min(best, Math.abs(onset - hit));
  if (best > 0.01)
    fail(
      `hit at ${hit.toFixed(2)}s: nearest onset ${(best * 1000).toFixed(1)}ms away`,
    );
  worst = Math.max(worst, best);
}

// Nothing detected inside the silent gap (15.5s .. 20s).
for (const onset of onsets)
  if (onset > 15.5 && onset < 20)
    fail(`phantom onset at ${onset.toFixed(2)}s inside the silent gap`);

// Count matches exactly: no doubled or phantom onsets anywhere.
if (onsets.length !== trueHits.length)
  fail(`detected ${onsets.length} onsets, expected ${trueHits.length}`);

// Sensitivity dial: a permissive setting hears the ghosts, proving the
// threshold (not luck) is what excludes them at the default.
const permissive = analyzeTransientSamples(data, SAMPLE_RATE, 0.1);
if (permissive.length <= trueHits.length)
  fail(
    `sensitivity 0.1 found ${permissive.length} onsets; expected more than ${trueHits.length}`,
  );

if (failures > 0) {
  console.error(`FAIL: ${failures} transient invariant failures`);
  process.exit(1);
}
console.log(
  `PASS: ${trueHits.length} hits detected, worst timing ${(worst * 1000).toFixed(1)}ms, ` +
    `silence clean, ghosts excluded at default sensitivity`,
);
