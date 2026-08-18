import { expect, test, Page } from "@playwright/test";
import {
  addLaneOnParam,
  closePanel,
  gotoEditorClean,
  insertPattern,
  loadSeededSong,
  openPatternPanel,
  settleBox,
} from "./helpers";

// Generator boundary stacks, unzip and zip (decision 14). In the owner's
// words:
//
//   "When you create a wave, it will create two additional keyframe UI
//    elements on the left and the right side that are on the same time point
//    as whatever other keyframes are there. And when you click and drag one of
//    those keyframes that are effectively now stacked on top of each other, it
//    will just pick one of them, and you'll drag that one. But the wave will be
//    decoupled from whatever value the one on the left or the right is."
//
//   "Dragging the right edge keyframe up and down does move the entire offset.
//    If you time drag a stacked pair, I think it should actually create a new
//    curve segment between the two."
//
// It is a generator rule, not a wave rule: anything offset-based (audio too)
// follows it.

// Every keyframe dot as "left@top", so a stacked pair reads as two entries
// sharing a left.
const marks = (page: Page) =>
  page
    .locator("[class*=keyframeDot]")
    .evaluateAll((nodes) =>
      nodes.map(
        (n) =>
          `${parseFloat((n as HTMLElement).style.left).toFixed(1)}@${parseFloat(
            (n as HTMLElement).style.top,
          ).toFixed(0)}`,
      ),
    );

const openLane = async (page: Page, points: [number, number][]) => {
  await gotoEditorClean(page);
  await openPatternPanel(page);
  await insertPattern(page, "Nebula");
  await addLaneOnParam(page, "Time Factor");
  await closePanel(page);
  await loadSeededSong(page);
  await page.locator("[class*=laneRow]").first().click();
  await settleBox(page, "[class*=editorLineArea]");
  const box = (await page.locator("[class*=editorLineArea]").boundingBox())!;
  for (const [fx, fy] of points)
    await page.mouse.dblclick(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(300);
  return box;
};

// Right-click the midpoint between two dots so the click lands on the
// segment's hit stroke wherever the curve runs.
const retype = async (page: Page, i: number, type: string) => {
  const a = (await page.locator("[class*=keyframeDot]").nth(i).boundingBox())!;
  const b = (await page
    .locator("[class*=keyframeDot]")
    .nth(i + 1)
    .boundingBox())!;
  await page.mouse.click(
    (a.x + b.x) / 2 + a.width / 2,
    (a.y + b.y) / 2 + a.height / 2,
    { button: "right" },
  );
  await page
    .locator("[data-doc=segment-menu]")
    .getByRole("button", { name: type })
    .first()
    .click();
  await page.waitForTimeout(350);
};

const drag = async (
  page: Page,
  index: number,
  dx: number,
  dy: number,
  onStep?: () => Promise<void>,
) => {
  const db = (await page
    .locator("[class*=keyframeDot]")
    .nth(index)
    .boundingBox())!;
  const x = db.x + db.width / 2;
  const y = db.y + db.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(x + (dx * i) / 20, y + (dy * i) / 20);
    if (onStep) await onStep();
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
};

test.describe("generator boundary stacks", () => {
  test("creating a wave stacks its own keyframes on both neighbours", async ({
    page,
  }) => {
    await openLane(page, [
      [0.15, 0.6],
      [0.4, 0.35],
      [0.65, 0.7],
      [0.9, 0.45],
    ]);
    expect(await marks(page)).toHaveLength(4);

    await retype(page, 1, "Wave");

    // One new keyframe per neighbour: the generator's own boundaries.
    const after = await marks(page);
    expect(after).toHaveLength(6);

    const lefts = after.map((m) => parseFloat(m));
    const tops = after.map((m) => parseFloat(m.split("@")[1]));
    // Two coincident pairs, one at each boundary.
    expect(lefts[1]).toBeCloseTo(lefts[2], 1);
    expect(lefts[3]).toBeCloseTo(lefts[4], 1);
    // The generator holds ONE constant offset across its span: it is absolute
    // and can never sit on an angle.
    expect(tops[2]).toBeCloseTo(tops[3], 0);
    // Seeded from the left boundary, so it "starts lined up" there...
    expect(tops[1]).toBeCloseTo(tops[2], 0);
    // ...while the right neighbour keeps its own value. That difference at one
    // shared time IS the decoupling, and the stack is what encodes the step.
    expect(Math.abs(tops[4] - tops[3])).toBeGreaterThan(10);
  });

  test("dragging either edge vertically moves the whole offset", async ({
    page,
  }) => {
    await openLane(page, [
      [0.15, 0.6],
      [0.4, 0.35],
      [0.65, 0.7],
      [0.9, 0.45],
    ]);
    await retype(page, 1, "Wave");
    const before = (await marks(page)).map((m) => parseFloat(m.split("@")[1]));

    // Index 2 is the generator's own left boundary (index 1 is the
    // neighbour's, stacked at the same time).
    await drag(page, 2, 0, -60);

    const after = (await marks(page)).map((m) => parseFloat(m.split("@")[1]));
    // Both of the generator's endpoints rode together...
    expect(after[2]).toBeLessThan(before[2] - 5);
    expect(after[3]).toBeCloseTo(after[2], 0);
    // ...and neither neighbour moved.
    expect(after[1]).toBeCloseTo(before[1], 0);
    expect(after[4]).toBeCloseTo(before[4], 0);
  });

  test("a wave cannot be squeezed out of existence", async ({ page }) => {
    // A zero-duration region is never written, so a wave collapsed onto its
    // own far edge used to vanish on the next save while the editor went on
    // drawing it.
    const box = await openLane(page, [
      [0.15, 0.6],
      [0.4, 0.35],
      [0.65, 0.7],
      [0.9, 0.45],
    ]);
    await retype(page, 1, "Wave");
    expect(await marks(page)).toHaveLength(6);

    // The wave owns dots 2 and 3; drag its right edge hard left, past its own
    // left edge.
    await drag(page, 3, -box.width * 0.6, 0);

    const periodic = await page.evaluate(() => {
      const store = (window as unknown as Record<string, any>).__editorStore;
      const block = store.layers[0].blockMap.getAllBlocks()[0];
      return Object.entries(block.parameterVariations).flatMap(
        ([name, list]: [string, any]) =>
          (list ?? []).map((v: any) => ({
            name,
            type: v.type,
            duration: v.duration,
          })),
      );
    });
    const wave = periodic.find((v: any) => v.type === "periodic");
    expect(wave).toBeTruthy();
    expect(wave!.duration).toBeGreaterThan(0);
  });

  test("time-dragging a stacked pair unzips one bridge, not one per frame", async ({
    page,
  }) => {
    await openLane(page, [
      [0.2, 0.6],
      [0.5, 0.3],
      [0.8, 0.65],
    ]);
    await retype(page, 0, "Wave");
    const start = await marks(page);
    // Segment 0 has no left neighbour, so only the right boundary stacks.
    expect(start).toHaveLength(4);

    // Pull the generator's right boundary left, hard, watching every frame.
    // This is the reported glitch: it used to spawn keyframes continuously,
    // because the editor drew a sloped wave the data model could not store and
    // handed back a different value on every round trip.
    let worst = start.length;
    await drag(page, 1, -260, 12, async () => {
      worst = Math.max(worst, (await marks(page)).length);
    });
    expect(worst).toBe(start.length);

    const end = await marks(page);
    expect(end).toHaveLength(4);
    // The pair came apart, which is the unzip: a real Bezier now spans the
    // gap between the generator's offset and the neighbour's value.
    expect(parseFloat(end[2]) - parseFloat(end[1])).toBeGreaterThan(5);
  });
});
