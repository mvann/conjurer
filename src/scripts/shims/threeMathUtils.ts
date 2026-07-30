// LinearVariation deep-imports `three/src/math/MathUtils`, a path three's
// package exports do not expose to CommonJS — so ts-node cannot resolve it
// and any test script that transitively touches that class fails to load.
//
// Rather than edit upstream's import (the whole point of this branch is to
// change nothing of theirs), tsconfig.script.json maps that specifier here
// for script runs only. The app build resolves the real module through
// webpack as usual.
export const lerp = (x: number, y: number, t: number) => x + (y - x) * t;

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export const damp = (
  x: number,
  y: number,
  lambda: number,
  dt: number,
): number => lerp(x, y, 1 - Math.exp(-lambda * dt));
