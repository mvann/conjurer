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
});
