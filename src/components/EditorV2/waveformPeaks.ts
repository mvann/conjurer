// Max-pooled waveform peaks: column i holds the peak of samples in
// [i, i+1) * (length / columns), so the array spans the WHOLE signal
// exactly. The column boundaries are fractional by design: flooring a
// shared samples-per-column instead makes each column slightly short,
// and the truncation compounds — with 32k columns over a five-minute
// song the rendered waveform ran ~0.07% slow, sliding transients ~200ms
// off the (correctly timed) beat grid by the end.
// Draw waveform bars for the time window [viewLeft, viewLeft + viewWidth)
// straight from the peak array, restricted to destination columns
// [fromX, toX). Each screen column max-pools its exact share of peak
// columns, so peaks stay crisp at every zoom, positions are exact, and
// there is no image scaling or level-of-detail switching to snap.
// Fractions outside [0, 1) simply draw nothing, so callers whose view
// extends beyond the song (the automation editor's left strip) need no
// clamping of their own.
export const drawBars = (
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array,
  viewLeft: number,
  viewWidth: number,
  destWidth: number,
  height: number,
  fromX: number,
  toX: number,
  color: string,
) => {
  ctx.fillStyle = color;
  const first = Math.max(0, Math.floor(fromX));
  const last = Math.min(destWidth, Math.ceil(toX));
  for (let x = first; x < last; x++) {
    const f0 = viewLeft + viewWidth * (x / destWidth);
    const f1 = viewLeft + viewWidth * ((x + 1) / destWidth);
    const i0 = Math.floor(f0 * peaks.length);
    const i1 = Math.max(i0 + 1, Math.ceil(f1 * peaks.length));
    if (i0 < 0 || i0 >= peaks.length) continue;
    let max = 0;
    for (let i = i0; i < i1 && i < peaks.length; i++)
      if (peaks[i] > max) max = peaks[i];
    const barHeight = Math.max(1, max * height);
    ctx.fillRect(x, (height - barHeight) / 2, 1, barHeight);
  }
};

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
