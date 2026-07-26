// Max-pooled waveform peaks: column i holds the peak of samples in
// [i, i+1) * (length / columns), so the array spans the WHOLE signal
// exactly. The column boundaries are fractional by design: flooring a
// shared samples-per-column instead makes each column slightly short,
// and the truncation compounds — with 32k columns over a five-minute
// song the rendered waveform ran ~0.07% slow, sliding transients ~200ms
// off the (correctly timed) beat grid by the end.
export const computePeaks = (
  data: Float32Array,
  columns: number,
): Float32Array => {
  const count = Math.min(columns, data.length);
  const peaks = new Float32Array(count);
  for (let column = 0; column < count; column++) {
    const start = Math.floor((column * data.length) / count);
    const end = Math.max(
      start + 1,
      Math.floor(((column + 1) * data.length) / count),
    );
    // Sampling every few samples is enough for a visual peak; scale the
    // stride to the column width.
    const stride = Math.max(1, Math.floor((end - start) / 16));
    let max = 0;
    for (let i = start; i < end; i += stride) {
      const value = Math.abs(data[i]);
      if (value > max) max = value;
    }
    peaks[column] = max;
  }
  return peaks;
};
