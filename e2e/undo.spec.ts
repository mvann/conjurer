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

// Undo is "the same snapshot undo, over their data model" — and the model
// swap moved the source of truth into store.layers. So the things the swap
// introduced are exactly the ones a snapshot taken over the OLD shape would
// drop: block timing, which layer a block lives in, and lane arming order.
//
// The owner also ruled on what must NOT be in the history: "certain pieces of
// state should not be in the history, like having the expanded automation view
// open or closed shouldn't be in the history." And on granularity: "I hit
// control z, and it deleted three of them" when he had added one.

const HISTORY_DEBOUNCE = 600;

const blockTiming = (page: Page) =>
  page.evaluate(() => {
    const store = (window as unknown as Record<string, any>).__editorStore;
    const block = store.layers[0].blockMap.getAllBlocks()[0];
    return { start: block.startTime, duration: block.duration };
  });

const laneKeys = (page: Page) =>
  page
    .locator("[data-lane-key]")
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-lane-key") as string),
    );

const openLane = async (page: Page) => {
  await gotoEditorClean(page);
  await openPatternPanel(page);
  await insertPattern(page, "Nebula");
  await addLaneOnParam(page, "Time Factor");
  await closePanel(page);
  await loadSeededSong(page);
  await settleBox(page, "[class*=blockLaneArea]");
};

test.describe("undo over the layer/block model", () => {
  test("block timing comes back", async ({ page }) => {
    await openLane(page);
    const before = await blockTiming(page);
    await page.waitForTimeout(HISTORY_DEBOUNCE);

    // Shrink the block from its left edge.
    const area = (await page
      .locator("[class*=blockLaneArea]")
      .first()
      .boundingBox())!;
    const left = page.locator("[data-doc=block-edge-left]").first();
    const box = (await left.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.move(
      area.x + area.width * 0.4,
      box.y + box.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    await page.waitForTimeout(HISTORY_DEBOUNCE);

    const resized = await blockTiming(page);
    expect(resized.start).toBeGreaterThan(before.start + 1);

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);

    const undone = await blockTiming(page);
    expect(undone.start).toBeCloseTo(before.start, 1);
    expect(undone.duration).toBeCloseTo(before.duration, 1);
  });

  test("arming a lane is undoable, and lane order survives", async ({
    page,
  }) => {
    await openLane(page);
    await page.waitForTimeout(HISTORY_DEBOUNCE);
    const one = await laneKeys(page);
    expect(one).toHaveLength(1);

    await openPatternPanel(page);
    await addLaneOnParam(page, "Warp");
    await closePanel(page);
    await page.waitForTimeout(HISTORY_DEBOUNCE);
    const two = await laneKeys(page);
    expect(two).toHaveLength(2);
    // Lane order is arming order (decision 21).
    expect(two[0]).toBe(one[0]);

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    expect(await laneKeys(page)).toEqual(one);

    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(300);
    expect(await laneKeys(page)).toEqual(two);
  });

  test("the expanded automation view is not part of the history", async ({
    page,
  }) => {
    await openLane(page);
    await page.waitForTimeout(HISTORY_DEBOUNCE);

    // Open the expanded editor, then make one real edit inside it.
    await page.locator("[class*=laneRow]").first().click();
    await expect(page.locator("[class*=automationEditor__]")).toBeVisible();
    await settleBox(page, "[class*=editorLineArea]");
    const box = (await page.locator("[class*=editorLineArea]").boundingBox())!;
    await page.mouse.dblclick(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.waitForTimeout(HISTORY_DEBOUNCE);
    expect(await page.locator("[class*=keyframeDot]").count()).toBe(1);

    // Undo takes back the keyframe and leaves the editor open: "it closes the
    // expanded automation view, which it shouldn't do."
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    expect(await page.locator("[class*=keyframeDot]").count()).toBe(0);
    await expect(page.locator("[class*=automationEditor__]")).toBeVisible();
  });

  test("one edit is one undo", async ({ page }) => {
    await openLane(page);
    await page.locator("[class*=laneRow]").first().click();
    await settleBox(page, "[class*=editorLineArea]");
    const box = (await page.locator("[class*=editorLineArea]").boundingBox())!;

    // Three keyframes, each its own settled edit.
    for (const fx of [0.3, 0.5, 0.7]) {
      await page.mouse.dblclick(box.x + box.width * fx, box.y + box.height * 0.5);
      await page.waitForTimeout(HISTORY_DEBOUNCE);
    }
    expect(await page.locator("[class*=keyframeDot]").count()).toBe(3);

    // "I added one keyframe. I hit control z, and it deleted three of them."
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    expect(await page.locator("[class*=keyframeDot]").count()).toBe(2);
  });
});
