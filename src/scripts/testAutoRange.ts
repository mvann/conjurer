/**
 * Fuzz tests for the automation editor's auto-ranging and its interaction
 * with dragging (yarn test:autorange).
 *
 * Simulates the coupled system exactly as the component implements it:
 * - The view keeps easing toward its target DURING drags.
 * - Dragged values change only on pointer movement, by the pointer's
 *   delta through the CURRENT span, so the animating view cannot move a
 *   stationary keyframe.
 * - Shrink hysteresis on the span.
 *
 * Invariants checked across thousands of randomized trials:
 * - A stationary cursor never moves the value mid-drag, even while the
 *   view is animating (no feedback runaway).
 * - After release the view settles within a bounded number of frames.
 * - Once settled, the target is a fixed point (no immediate re-extension).
 * - Settled data keeps at least ~20% margins (or lives in the 0..1
 *   default's middle band).
 * - Small jitters around the settled state cause at most one span change
 *   (no flapping).
 * - No NaN/Infinity anywhere.
 */
import {
  computeTargetView,
  easeView,
  extremesOf,
  ViewRange,
} from "../components/EditorV2/autoRange";

// Deterministic PRNG (mulberry32) so failures are reproducible by seed.
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.error("FAIL: " + message);
};

const finiteView = (view: ViewRange, context: string) => {
  if (!isFinite(view.center) || !isFinite(view.span) || view.span <= 0)
    fail(`${context}: view degenerate ${JSON.stringify(view)}`);
};

// Maps a cursor y fraction (0 top .. 1 bottom) to a value through a view,
// as clientYToValue does (used for keyframe placement, not dragging).
const yToValue = (view: ViewRange, yFrac: number) =>
  view.center + view.span / 2 - yFrac * view.span;

type Sim = {
  values: number[];
  view: ViewRange;
  lastTarget: ViewRange | null;
};

const settle = (sim: Sim, maxFrames = 800, context = "") => {
  for (let i = 0; i < maxFrames; i++) {
    const target = computeTargetView(
      extremesOf(sim.values),
      sim.lastTarget,
      false,
    );
    sim.lastTarget = target;
    const { next, settled } = easeView(sim.view, target);
    sim.view = next;
    finiteView(sim.view, context + " settle");
    if (settled) return i;
  }
  fail(`${context}: did not settle within ${maxFrames} frames`);
  return maxFrames;
};

// One animation frame of the live view chase, exactly as the component's
// loop does it (runs during drags too).
const frameStep = (sim: Sim, context: string, isDragging = false) => {
  const target = computeTargetView(
    extremesOf(sim.values),
    sim.lastTarget,
    isDragging,
  );
  sim.lastTarget = target;
  sim.view = easeView(sim.view, target).next;
  finiteView(sim.view, context + " frame");
};

// Drag one value along a y-fraction profile: each step is a pointer move
// applying the DELTA through the current span (as the component does),
// followed by an animation frame easing the live view. Then release and
// settle.
const dragProfile = (
  sim: Sim,
  valueIndex: number,
  profile: number[],
  context: string,
) => {
  let lastY = profile[0] ?? 0.5;
  const radiusBefore = (sim.lastTarget?.span ?? sim.view.span) / 2;
  for (const yFrac of profile) {
    sim.values[valueIndex] += (lastY - yFrac) * sim.view.span;
    lastY = yFrac;
    if (!isFinite(sim.values[valueIndex]))
      fail(`${context}: dragged value not finite`);
    frameStep(sim, context, true);
    // Frozen while dragging: the target radius never changes at all,
    // even when the value crosses the 10% edge bands.
    const radiusNow = (sim.lastTarget?.span ?? 2) / 2;
    if (Math.abs(radiusNow - radiusBefore) > 1e-9)
      fail(
        `${context}: range changed mid-drag (${radiusBefore} -> ${radiusNow})`,
      );
  }
  settle(sim, 800, context);
};

const random = mulberry32(20260724);

const profiles: Record<string, (rng: () => number) => number[]> = {
  // Down a whole bunch, then back up.
  downThenUp: (rng) => {
    const out: number[] = [];
    for (let i = 0; i <= 40; i++) out.push(0.5 + (i / 40) * 2.5);
    for (let i = 40; i >= 0; i--) out.push(0.5 + (i / 40) * 2.5);
    return out;
  },
  // Slow sweep off the top.
  sweepUp: () => {
    const out: number[] = [];
    for (let i = 0; i <= 60; i++) out.push(0.5 - (i / 60) * 3);
    return out;
  },
  // Sine wiggle around the middle.
  wiggle: (rng) => {
    const out: number[] = [];
    const amp = 0.3 + rng() * 1.5;
    for (let i = 0; i < 80; i++) out.push(0.5 + Math.sin(i / 6) * amp);
    return out;
  },
  // Jumpy random walk, occasionally far outside the view.
  randomWalk: (rng) => {
    const out: number[] = [];
    let y = 0.5;
    for (let i = 0; i < 100; i++) {
      y += (rng() - 0.5) * (rng() < 0.1 ? 3 : 0.3);
      out.push(y);
    }
    return out;
  },
  // Teleports between extremes.
  teleport: (rng) => {
    const out: number[] = [];
    for (let i = 0; i < 30; i++) out.push(rng() < 0.5 ? -1.5 : 2.5);
    return out;
  },
};

// ---- Trial 1: stationary cursor mid-drag never moves the value, even
// while the view is actively animating to a new range. ----
{
  const sim: Sim = {
    values: [0.4, 0.9],
    view: { center: 0.5, span: 1 },
    lastTarget: null,
  };
  settle(sim, 800, "hold-still setup");
  // Pointer moves once, far outside the range, then holds still while the
  // view chases: values must not change during the hold (no move events).
  sim.values[1] += (0.5 - -1.5) * sim.view.span;
  const held = sim.values[1];
  for (let frame = 0; frame < 300; frame++) {
    frameStep(sim, "hold-still");
    if (Math.abs(sim.values[1] - held) > 1e-12)
      fail(`hold-still: value drifted by ${Math.abs(sim.values[1] - held)}`);
  }
}

// ---- Trial 2: fuzz drags across profiles. ----
{
  let trials = 0;
  for (const [name, makeProfile] of Object.entries(profiles)) {
    for (let t = 0; t < 120; t++) {
      trials++;
      const rng = mulberry32(1000 + t * 7919 + name.length);
      const count = 1 + Math.floor(rng() * 4);
      const values = Array.from({ length: count }, () => rng() * 2 - 0.5);
      const sim: Sim = {
        values,
        view: { center: 0.5, span: 1 },
        lastTarget: null,
      };
      const context = `${name}#${t}`;
      settle(sim, 800, context + " initial");

      const index = Math.floor(rng() * count);
      dragProfile(sim, index, makeProfile(rng), context);

      // Fixed point: recomputing the target after settling changes nothing.
      const target = computeTargetView(extremesOf(sim.values), sim.lastTarget);
      if (
        Math.abs(target.center - sim.view.center) > 1e-9 ||
        Math.abs(target.span - sim.view.span) > 1e-9
      )
        fail(
          `${context}: settled view is not a fixed point (view ${JSON.stringify(
            sim.view,
          )} target ${JSON.stringify(target)})`,
        );

      // Center pinned to 0 and radius a power of two (>= 1).
      if (Math.abs(sim.view.center) > 1e-9)
        fail(`${context}: view not centered on 0 (${sim.view.center})`);
      const radius = sim.view.span / 2;
      const octave = Math.log2(radius);
      if (Math.abs(octave - Math.round(octave)) > 1e-9 || radius < 1)
        fail(`${context}: radius not a power of two (${radius})`);

      // Released fit: the outermost value is outside the 10% edge bands,
      // and the radius is MINIMAL (one halving down would violate).
      const extremes = extremesOf(sim.values)!;
      const outermost = Math.max(
        Math.abs(extremes.low),
        Math.abs(extremes.high),
      );
      if (outermost > 0.8 * radius + 1e-9)
        fail(
          `${context}: outermost ${outermost} inside the 10% band of radius ${radius}`,
        );
      if (radius > 1 && outermost <= 0.8 * (radius / 2) + 1e-12)
        fail(
          `${context}: radius ${radius} not minimal for outermost ${outermost}`,
        );
    }
  }
  console.log(
    `fuzzed ${trials} drag trials across ${Object.keys(profiles).length} profiles`,
  );
}

// ---- Trial 3: no flapping under small jitter near a ladder boundary. ----
{
  for (let t = 0; t < 200; t++) {
    const rng = mulberry32(555 + t * 104729);
    // The outermost value hovering around the fit boundary of the -1..1
    // view (|v| near 0.8), jittered WHILE DRAGGING: the range is frozen
    // during drags, so it must not change at all.
    const dev = 0.75 + rng() * 0.1;
    const sim: Sim = {
      values: [-0.2, dev],
      view: { center: 0, span: 2 },
      lastTarget: null,
    };
    settle(sim, 800, `flap#${t} setup`);

    let spanChanges = 0;
    let lastSpan = sim.view.span;
    for (let step = 0; step < 200; step++) {
      // Jitter the outermost value by up to 0.5% of the span, dragging.
      sim.values[1] = dev + (rng() - 0.5) * 0.01 * sim.view.span;
      const target = computeTargetView(
        extremesOf(sim.values),
        sim.lastTarget,
        true,
      );
      sim.lastTarget = target;
      sim.view = easeView(sim.view, target).next;
      if (Math.abs(target.span - lastSpan) > 1e-9) {
        spanChanges++;
        lastSpan = target.span;
      }
    }
    if (spanChanges > 0)
      fail(`flap#${t}: span changed ${spanChanges} times mid-drag`);
  }
  console.log("flap tests passed (200 boundary scenarios)");
}

if (failures > 0) {
  console.error(`FAIL: ${failures} auto-range invariant failures`);
  process.exit(1);
}
console.log("PASS: all auto-range fuzz invariants held");
