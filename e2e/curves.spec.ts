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

// A curve segment is a cubic Bezier, the way upstream stores one: "by default
// now, we're gonna do the curves that they do, which is, like, the Bezier
// handles."
//
// It used to be a Schlick bend, which the data model cannot hold, so every
// save refitted the shape and the fitter's extra nodes came back as keyframes.
// These are the symptoms that produced, each of which the owner reported.

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

test.describe("curve segments", () => {
  test("bending a segment never adds keyframes", async ({ page }) => {
    const box = await openLane(page, [
      [0.2, 0.6],
      [0.5, 0.3],
      [0.8, 0.65],
    ]);
    expect(await marks(page)).toHaveLength(3);

    // Drag the middle of the first segment far off the chord, hard enough that
    // a refit would have needed extra nodes.
    const a = (await page.locator("[class*=keyframeDot]").nth(0).boundingBox())!;
    const b = (await page.locator("[class*=keyframeDot]").nth(1).boundingBox())!;
    const x = (a.x + b.x) / 2 + a.width / 2;
    const y = (a.y + b.y) / 2 + a.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(50);
    let worst = 3;
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(x, y - i * 6, { steps: 2 });
      worst = Math.max(worst, (await marks(page)).length);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);

    expect(worst).toBe(3);
    expect(await marks(page)).toHaveLength(3);
  });

  test("a keyframe dragged at its neighbour stops there, and deletes nothing", async ({
    page,
  }) => {
    await openLane(page, [
      [0.2, 0.6],
      [0.4, 0.35],
      [0.6, 0.5],
      [0.85, 0.3],
    ]);

    // Make the right-hand segment flat, the shape the report used.
    const c = (await page.locator("[class*=keyframeDot]").nth(2).boundingBox())!;
    const d = (await page.locator("[class*=keyframeDot]").nth(3).boundingBox())!;
    await page.mouse.click((c.x + d.x) / 2 + 4, (c.y + d.y) / 2 + 4, {
      button: "right",
    });
    await page
      .locator("[data-doc=segment-menu]")
      .getByRole("button", { name: "Flat" })
      .first()
      .click();
    await page.waitForTimeout(300);
    const before = await marks(page);
    expect(before).toHaveLength(4);

    // Drag the curve run's inner keyframe right, well past the flat's start.
    const b = (await page.locator("[class*=keyframeDot]").nth(1).boundingBox())!;
    const x0 = b.x + b.width / 2;
    const y0 = b.y + b.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.waitForTimeout(50);
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(x0 + i * 20, y0, { steps: 2 });
      expect(await marks(page)).toHaveLength(4);
    }
    await page.mouse.up();
    await page.waitForTimeout(300);

    // It stopped ON its neighbour rather than passing it: "It should stop. It
    // should not be able to pass that point."
    const after = await marks(page);
    expect(after).toHaveLength(4);
    expect(parseFloat(after[1])).toBeCloseTo(parseFloat(after[2]), 1);
    expect(parseFloat(after[3])).toBeCloseTo(parseFloat(before[3]), 1);
  });
});
