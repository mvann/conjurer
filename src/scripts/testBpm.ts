/**
 * Tests for the beat analyzer (yarn test:bpm) against synthesized tracks
 * with known tempo and phase.
 *
 * Each track is a kick pattern (decaying 55 Hz sine bursts) at an exact
 * BPM and offset, plus adversarial extras the analyzer must shrug off:
 * broadband noise, off-beat hats (high-frequency bursts), and off-beat
 * ghost kicks at lower level. Invariants:
 *
 * - The recovered BPM matches the truth (folded into 90-180) within
 *   0.15 BPM.
 * - Every true kick in the track lies within 15 ms of a recovered grid
 *   line: the grid sits ON the kicks, not between them.
 */
import { analyzeBpmSamples } from "../components/EditorV2/bpm";

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.error("FAIL: " + message);
};

// Deterministic PRNG so failures reproduce.
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SAMPLE_RATE = 44100;

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

const synthesize = (
  bpm: number,
  offset: number,
  seconds: number,
  seed: number,
  // Fraction of the track that carries kicks; the rest is an outro of
  // just noise (the fit must not need onsets all the way to the end).
  kickUntil = 1,
) => {
  const random = mulberry32(seed);
  const data = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const beat = 60 / bpm;
  const kicks: number[] = [];
  for (let t = offset; t < seconds * kickUntil - 0.5; t += beat) {
    kicks.push(t);
    addBurst(data, t, 55, 0.9, 0.05);
    // Off-beat hat, well above the analyzer's low band.
    addBurst(data, t + beat / 2, 4200, 0.5, 0.02);
    // Occasional off-beat ghost kick at lower level.
    if (random() < 0.25) addBurst(data, t + beat * 0.75, 60, 0.3, 0.03);
  }
  // Noise floor.
  for (let i = 0; i < data.length; i++) data[i] += (random() - 0.5) * 0.03;
  return { data, kicks };
};

const fold = (bpm: number) => {
  let folded = bpm;
  while (folded < 90) folded *= 2;
  while (folded >= 180) folded /= 2;
  return folded;
};

// Long tracks are where period error shows: a few thousandths of a BPM
// compounds into a visible end-of-song slide, so the five-minute cases
// assert the same 15ms kick-to-grid bound across hundreds of beats.
// 127.87 exercises the free fit (no nice snap available); 104 exact must
// snap; the kickUntil case proves the fit survives a silent outro.
const cases: {
  bpm: number;
  offset: number;
  seed: number;
  seconds?: number;
  kickUntil?: number;
  // Assert the recovered BPM this tightly (defaults to 0.15); the
  // exact-integer long case demands the snap.
  bpmTolerance?: number;
}[] = [
  { bpm: 120, offset: 0, seed: 1 },
  { bpm: 128, offset: 0.31, seed: 2 },
  { bpm: 95, offset: 0.11, seed: 3 },
  { bpm: 174, offset: 0.44, seed: 4 },
  { bpm: 104.3, offset: 0.2, seed: 5 },
  { bpm: 140, offset: 0.57, seed: 6 },
  { bpm: 127.87, offset: 0.25, seed: 7, seconds: 300 },
  { bpm: 104, offset: 0.12, seed: 8, seconds: 300, bpmTolerance: 0.005 },
  { bpm: 133, offset: 0.4, seed: 9, seconds: 240, kickUntil: 0.85 },
];

for (const testCase of cases) {
  const seconds = testCase.seconds ?? 45;
  const label = `${testCase.bpm}bpm@${testCase.offset}s/${seconds}s`;
  const { data, kicks } = synthesize(
    testCase.bpm,
    testCase.offset,
    seconds,
    testCase.seed,
    testCase.kickUntil ?? 1,
  );
  const analysis = analyzeBpmSamples(data, SAMPLE_RATE);
  if (!analysis) {
    fail(`${label}: analyzer returned null`);
    continue;
  }

  const expected = fold(testCase.bpm);
  // The analyzer may land on a half/double folding of the kick rate;
  // compare against the folding closest to what it chose.
  const candidates = [expected, fold(expected * 2), fold(expected / 2)];
  const bpmError = Math.min(
    ...candidates.map((candidate) => Math.abs(analysis.bpm - candidate)),
  );
  if (bpmError > (testCase.bpmTolerance ?? 0.15))
    fail(
      `${label}: bpm ${analysis.bpm.toFixed(3)} (error ${bpmError.toFixed(3)})`,
    );

  // Every kick must sit on a grid line.
  const beat = 60 / analysis.bpm;
  let worst = 0;
  for (const kick of kicks) {
    const position = (kick - analysis.offsetSeconds) / beat;
    const distance = Math.abs(position - Math.round(position)) * beat;
    if (distance > worst) worst = distance;
  }
  if (worst > 0.015)
    fail(
      `${label}: worst kick-to-grid distance ${(worst * 1000).toFixed(1)}ms`,
    );

  if (analysis.confidence <= 0.1)
    fail(`${label}: confidence ${analysis.confidence.toFixed(2)} too low`);

  console.log(
    `${label}: bpm ${analysis.bpm.toFixed(2)}, offset ${analysis.offsetSeconds.toFixed(3)}s, worst alignment ${(worst * 1000).toFixed(1)}ms, confidence ${analysis.confidence.toFixed(2)}`,
  );
}

if (failures > 0) {
  console.error(`FAIL: ${failures} bpm invariant failures`);
  process.exit(1);
}
console.log("PASS: all bpm analysis invariants held");
