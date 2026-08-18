import { expect, test, Page } from "@playwright/test";
import {
  addLaneOnParam,
  closePanel,
  gotoEditorClean,
  insertPattern,
  openPatternPanel,
  settleBox,
} from "./helpers";

// The colour lane's gradient (decision 23), in the owner's words:
//
//   "in the inspector for that segment in my version, there should just be a
//    little toggle for, like, gradient. And then when you click that, it adds
//    a second color different from the first color, notably... Gradient, for
//    me, will only be in memory as far as UI goes, which is funny because in
//    the data model, it's always there."
//
// Upstream stores every colour period as linear4 from->to, so a gradient is
// not a separate kind of thing to persist: equal ends ARE what "one colour"
// means. The toggle's state is therefore derived, never serialized.

const openColourLane = async (page: Page) => {
  await openPatternPanel(page);
  await insertPattern(page, "Disc");
  await addLaneOnParam(page, "Color");
  await closePanel(page);
  await page.locator("[class*=laneRow]").first().click();
  await settleBox(page, "[class*=editorLineArea]");
  // An empty lane shows one display-only period; a keyframe makes real,
  // selectable ones.
  const area = (await page.locator("[class*=editorLineArea]").boundingBox())!;
  await page.mouse.dblclick(
    area.x + area.width * 0.5,
    area.y + area.height * 0.5,
  );
  await page.waitForTimeout(300);
};

const firstRegion = (page: Page) =>
  page.evaluate(() => {
    const block = (
      window as unknown as Record<string, any>
    ).__editorStore.layers[0].blockMap.getAllBlocks()[0];
    const region = (block.parameterVariations.u_color ?? [])[0];
    return region ? region.serialize() : null;
  });

test.describe("colour gradients", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("the toggle adds a visibly different far end, on a wider chip", async ({
    page,
  }) => {
    await openColourLane(page);
    await expect(page.locator("[data-doc=value-swatch]")).toHaveCount(2);

    await page.locator("[data-doc=value-swatch]").first().click();
    await expect(page.locator("[data-doc=segment-inspector]")).toBeVisible();
    const toggle = page.locator("[data-doc=gradient-toggle]");
    await expect(toggle).not.toBeChecked();
    // A solid period draws a normal-width chip.
    await expect(
      page.locator('[data-doc=value-swatch][data-gradient="true"]'),
    ).toHaveCount(0);

    await toggle.check();
    await page.waitForTimeout(300);

    // The far end is different enough to see, and the chip says so by being
    // twice as wide.
    const region = (await firstRegion(page)) as any;
    expect(region.type).toBe("linear4");
    const distance = region.from.reduce(
      (sum: number, component: number, index: number) =>
        sum + Math.abs(component - region.to[index]),
      0,
    );
    expect(distance).toBeGreaterThan(0.5);
    await expect(
      page.locator('[data-doc=value-swatch][data-gradient="true"]'),
    ).toHaveCount(1);

    const wide = await page
      .locator('[data-doc=value-swatch][data-gradient="true"]')
      .boundingBox();
    const solid = await page
      .locator('[data-doc=value-swatch][data-gradient="false"]')
      .first()
      .boundingBox();
    expect(wide!.width).toBeCloseTo(solid!.width * 2, 0);
  });

  test("switching it off puts the ends back together", async ({ page }) => {
    await openColourLane(page);
    await page.locator("[data-doc=value-swatch]").first().click();
    const toggle = page.locator("[data-doc=gradient-toggle]");
    await toggle.check();
    await page.waitForTimeout(300);
    await toggle.uncheck();
    await page.waitForTimeout(300);

    // Equal ends is the data model's way of saying "one colour" — there is no
    // separate flag to clear, which is exactly why the toggle is memory only.
    const region = (await firstRegion(page)) as any;
    expect(region.from).toEqual(region.to);
    await expect(
      page.locator('[data-doc=value-swatch][data-gradient="true"]'),
    ).toHaveCount(0);
  });
  test("a colour keyframe cannot be dragged outside its block", async ({
    page,
  }) => {
    // A value lane's periods ARE regions, and a region cannot sit outside the
    // block, so a colour keyframe dragged past an edge could not be stored and
    // was silently dropped on the next write. Scalar lanes keep their overhang
    // deliberately; value lanes are penned in.
    await openColourLane(page);
    const before = await page.locator("[class*=keyframeDot]").count();
    expect(before).toBe(1);

    const box = (await page.locator("[class*=editorLineArea]").boundingBox())!;
    const dot = page.locator("[class*=keyframeDot]").first();
    const db = (await dot.boundingBox())!;
    await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(50);
    // Far past the right edge of the whole view.
    await page.mouse.move(box.x + box.width + 400, db.y + db.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await page.waitForTimeout(400);

    // It survives, and its period is still a real region.
    expect(await page.locator("[class*=keyframeDot]").count()).toBe(before);
    const regions = await page.evaluate(() => {
      const store = (window as unknown as Record<string, any>).__editorStore;
      const block = store.layers[0].blockMap.getAllBlocks()[0];
      return (block.parameterVariations.u_color ?? []).map((r: any) =>
        Number(r.duration.toFixed(3)),
      );
    });
    expect(regions.length).toBeGreaterThan(0);
    expect(Math.min(...regions)).toBeGreaterThan(0);
  });

});

// The colour lane is a VARIATION of the numeric lane, not a parallel
// implementation of it. It had grown as one, and these are the symptoms the
// owner reported from that: the lane preview drew chips but no keyframe dots,
// and a highlight drag did nothing at all ("highlighting a section doesn't
// work in this although it looks like that's just for colors").
test.describe("the colour lane behaves like any other lane", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("the lane preview shows keyframe dots, like every other lane", async ({
    page,
  }) => {
    await openColourLane(page);
    await page.getByLabel("Close automation editor").click();

    // "the automation preview curve should also show the keyframes but they
    // should be smaller" — with no exception carved out for colour.
    const lane = page.locator("[class*=laneRow]").first();
    await expect(lane.locator("[class*=laneKeyframeDot]")).toHaveCount(1);
    await expect(
      lane.locator("[class*=valueSwatchMini]").first(),
    ).toBeVisible();

    // And they are circles, not the ovals a squished curve would give.
    const dot = (await lane
      .locator("[class*=laneKeyframeDot]")
      .first()
      .boundingBox())!;
    expect(dot.width).toBeCloseTo(dot.height, 0);
  });

  test("a highlight drag selects time, copies, and deletes", async ({
    page,
  }) => {
    await openColourLane(page);
    // Two more periods, so there is something in the middle to lose.
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width * 0.7, box.y + box.height / 2);
    await page.waitForTimeout(300);
    await expect(page.locator("[data-doc=value-swatch]")).toHaveCount(3);

    const lowY = box.y + box.height * 0.9;
    await page.mouse.move(box.x + box.width * 0.4, lowY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, lowY, { steps: 5 });
    await page.mouse.up();

    // The same gold window and the same actions the numeric lane offers.
    await expect(page.locator("[data-doc=time-selection]")).toBeVisible();
    await page
      .locator("[class*=selectionActions]")
      .getByRole("button", { name: "Copy" })
      .click();

    await page.mouse.move(box.x + box.width * 0.4, lowY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, lowY, { steps: 5 });
    await page.mouse.up();
    await page
      .locator("[class*=selectionActions]")
      .getByRole("button", { name: "Delete" })
      .click();

    // The window covered every keyframe, so the lane empties back to the one
    // display-only period an unautomated lane shows — the numeric contract
    // ("deleting the whole keyframe span empties the curve") applied here.
    await expect(page.locator("[data-doc=time-selection]")).toHaveCount(0);
    await expect(page.locator("[data-doc=value-swatch]")).toHaveCount(1);

    // Paste puts the periods back, and each one still carries its own colour.
    // A keyframe that arrived without its payload would start a period with
    // no colour at all, which draws as the neutral placeholder — so the real
    // assertion is that none of them is that placeholder.
    await page.mouse.click(box.x + box.width * 0.45, lowY);
    await page.getByRole("button", { name: "Paste" }).click();
    await page.waitForTimeout(300);
    const swatches = page.locator("[data-doc=value-swatch]");
    expect(await swatches.count()).toBeGreaterThan(1);
    for (const background of await swatches.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).background),
    ))
      expect(background).not.toContain("232, 236, 244");
  });
});
