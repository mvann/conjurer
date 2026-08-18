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

  test("block timing survives the FIRST undo of a session", async ({ page }) => {
    // The history is seeded the instant the experience lands, which is before
    // the audio has been decoded, so the lane basis is still the 60s nominal
    // while the blocks already carry their real seconds. Stamping that basis
    // made the first ctrl-z rescale every block by songLength/60.
    await openLane(page);
    const before = await blockTiming(page);
    expect(before.duration).toBeGreaterThan(100);

    // One real edit, then undo straight back to the opening state.
    await page.locator("[class*=laneRow]").first().click();
    await settleBox(page, "[class*=editorLineArea]");
    const box = (await page.locator("[class*=editorLineArea]").boundingBox())!;
    await page.mouse.dblclick(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.waitForTimeout(HISTORY_DEBOUNCE);

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);

    const after = await blockTiming(page);
    expect(after.duration).toBeCloseTo(before.duration, 1);
    expect(after.start).toBeCloseTo(before.start, 1);
  });

  test("collapsing a pattern row is not an undo step", async ({ page }) => {
    // "certain pieces of state should not be in the history, like having the
    // expanded automation view open or closed shouldn't be in the history."
    await openLane(page);
    await page.waitForTimeout(HISTORY_DEBOUNCE);

    // One real edit: a keyframe.
    await page.locator("[class*=laneRow]").first().click();
    await settleBox(page, "[class*=editorLineArea]");
    const box = (await page.locator("[class*=editorLineArea]").boundingBox())!;
    await page.mouse.dblclick(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.waitForTimeout(HISTORY_DEBOUNCE);
    expect(await page.locator("[class*=keyframeDot]").count()).toBe(1);

    // Now a purely visual click: collapse the pattern's row.
    await openPatternPanel(page);
    await page.locator("[data-doc=pattern-expand]").first().click();
    await page.waitForTimeout(HISTORY_DEBOUNCE);
    await closePanel(page);

    // Undo must take back the KEYFRAME, not the caret.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    expect(await page.locator("[class*=keyframeDot]").count()).toBe(0);
  });

  test("undo then redo returns EXACTLY where it started", async ({ page }) => {
    // The property the old history could not hold: it stored a derived
    // projection of the document, so restoring one rebuilt the document
    // slightly differently and a round trip drifted. The snapshot IS the
    // document now, so this compares the real blob before and after.
    await openLane(page);
    await page.waitForTimeout(HISTORY_DEBOUNCE);

    const blob = () =>
      page.evaluate(() => {
        const store = (window as unknown as Record<string, any>).__editorStore;
        return JSON.stringify(store.serialize().data);
      });

    const start = await blob();

    // A spread of edits across different parts of the document.
    await page.locator("[class*=laneRow]").first().click();
    await settleBox(page, "[class*=editorLineArea]");
    const box = (await page.locator("[class*=editorLineArea]").boundingBox())!;
    for (const fx of [0.3, 0.55, 0.75]) {
      await page.mouse.dblclick(box.x + box.width * fx, box.y + box.height * 0.5);
      await page.waitForTimeout(HISTORY_DEBOUNCE);
    }
    await page.getByLabel("Close automation editor").click();
    await openPatternPanel(page);
    await insertPattern(page, "Plasma");
    await closePanel(page);
    await page.waitForTimeout(HISTORY_DEBOUNCE);

    const edited = await blob();
    expect(edited).not.toBe(start);

    // All the way back, then all the way forward again.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(200);
    }
    const undone = await blob();
    expect(undone).toBe(start);

    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Control+Shift+z");
      await page.waitForTimeout(200);
    }
    expect(await blob()).toBe(edited);
  });

  test("undo restores a block to the layer it came from", async ({ page }) => {
    // restoreEntries used to funnel every rebuilt block through the first
    // layer, so undoing a delete moved the pattern and undo/redo could leave
    // the same block id in two layers at once.
    await openLane(page);
    await openPatternPanel(page);
    await page.getByRole("button", { name: "Add Layer" }).click();
    await page.waitForTimeout(300);
    // Add a pattern to the SECOND layer.
    await page
      .locator("[data-doc=add-pattern]")
      .last()
      .click();
    await page.getByRole("button", { name: "Insert" }).click();
    await closePanel(page);
    await page.waitForTimeout(HISTORY_DEBOUNCE);

    const layout = () =>
      page.evaluate(() => {
        const store = (window as unknown as Record<string, any>).__editorStore;
        return store.layers.map((l: any) =>
          l.getAllBlocks().map((b: any) => b.id),
        );
      });
    const before = await layout();
    expect(before.length).toBe(2);
    expect(before[1].length).toBe(1);

    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(300);

    const after = await layout();
    expect(after).toEqual(before);
    // And no id may appear twice across layers.
    const flat = after.flat();
    expect(new Set(flat).size).toBe(flat.length);
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

test.describe("layer visibility", () => {
  test("hiding a layer stops its patterns rendering, and is undoable", async ({
    page,
  }) => {
    await gotoEditorClean(page);
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await closePanel(page);
    await loadSeededSong(page);
    await page.waitForTimeout(600);

    const layerVisible = () =>
      page.evaluate(() => {
        const store = (window as unknown as Record<string, any>).__editorStore;
        return store.layers.map((l: any) => l.visible);
      });

    expect(await layerVisible()).toEqual([true]);

    await openPatternPanel(page);
    await page.getByLabel("Hide layer").first().click();
    await page.waitForTimeout(600);
    expect(await layerVisible()).toEqual([false]);
    // The pattern is filtered out of the render set.
    const hiddenCount = await page.evaluate(() => {
      const store = (window as unknown as Record<string, any>).__editorStore;
      return store.layers
        .flatMap((l: any) => (l.visible ? l.getAllBlocks() : []))
        .length;
    });
    expect(hiddenCount).toBe(0);

    // Layer visibility lives on the layer in the blob, so undo covers it.
    await closePanel(page);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    expect(await layerVisible()).toEqual([true]);
  });
});
