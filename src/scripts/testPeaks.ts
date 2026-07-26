/**
 * Tests for the waveform peak downsampler (yarn test:peaks).
 *
 * The invariant that matters is POSITIONAL: a transient at time
 * fraction f of the signal must land in peak column round(f * columns),
 * including near the end of a long signal whose length does not divide
 * evenly by the column count. The historical failure: flooring a shared
 * samples-per-column made the peaks array span slightly less than the
 * signal, so rendered transients slid ~200ms off the beat grid by the
 * end of a five-minute song.
 */
import { computePeaks } from "../components/EditorV2/waveformPeaks";

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.error("FAIL: " + message);
};

const COLUMNS = 32000;

// A five-minute 48kHz signal, deliberately NOT divisible by the column
// count (13,737,600 samples = 429.3 per column: the truncation case).
const LENGTH = 286.2 * 48000;

const clickFractions = [0.001, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999];
const data = new Float32Array(Math.round(LENGTH));
for (const fraction of clickFractions) {
  const at = Math.round(fraction * (data.length - 1));
  // A short, loud click (a few samples wide so striding cannot miss it).
  for (let i = 0; i < 40 && at + i < data.length; i++) data[at + i] = 1;
}

const peaks = computePeaks(data, COLUMNS);
if (peaks.length !== COLUMNS)
  fail(`expected ${COLUMNS} columns, got ${peaks.length}`);

for (const fraction of clickFractions) {
  const expected = Math.round(fraction * (COLUMNS - 1));
  let found = -1;
  // The click must light up a column within +-1 of its true position.
  for (let c = Math.max(0, expected - 1); c <= expected + 1; c++)
    if (peaks[c] === 1) found = c;
  if (found < 0) {
    // Locate where it actually landed, for the failure message.
    let actual = -1;
    for (let c = 0; c < peaks.length; c++)
      if (peaks[c] === 1 && Math.abs(c - expected) < 200) actual = c;
    fail(
      `click at fraction ${fraction}: expected column ~${expected}, ` +
        `found ${actual >= 0 ? actual : "nowhere nearby"} ` +
        `(off by ${actual >= 0 ? actual - expected : "?"} columns)`,
    );
  }
}

// Quiet regions must stay quiet: the clicks light at most a few columns.
let lit = 0;
for (let c = 0; c < peaks.length; c++) if (peaks[c] > 0) lit++;
if (lit > clickFractions.length * 3)
  fail(`${lit} columns lit; expected at most ${clickFractions.length * 3}`);

if (failures > 0) {
  console.error(`FAIL: ${failures} peak positioning failures`);
  process.exit(1);
}
console.log(
  `PASS: ${clickFractions.length} clicks landed on their columns across ` +
    `${COLUMNS} columns (indivisible length)`,
);
