import { expect, test, Page } from "@playwright/test";
import {
  gotoEditorClean,
  insertPattern,
  loadSeededSong,
  openPatternPanel,
  saveFromGear,
  settleBox,
} from "./helpers";

// Opacity as a pseudo-param (decision 25). The owner's words:
//
//   "you can add it as an additional parameter for all patterns at the top of
//    the list. Just call opacity, and it will just be auto. And then you can
//    drag it up or down to create a new automation, which is just flat."
//   "Just right click to reset to auto works for opacity."
//
// Three states rather than two, because `u_opacity` is in upstream's
// BASE_UNIFORMS and so has one more below "lone flat": no entry at all.
// Absence IS auto, and it has to survive a save — which it does precisely
// because the save-time backfill skips base uniforms.

const opacityRow = (page: Page) =>
  page.locator("[data-doc=param-row]").filter({ hasText: "Opacity" }).first();

const opacityValue = (page: Page) =>
  opacityRow(page).locator("[class*=paramScrub]");

// Drags the row's value down, which is what turns auto into a real value.
const dragOpacity = async (page: Page, downBy = 60) => {
  // The dock slides, and a box measured mid-slide puts the drag somewhere the
  // row no longer is.
  await settleBox(page, "[data-doc=param-row]");
  const scrub = opacityValue(page);
  const box = (await scrub.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.move(box.x + box.width / 2, box.y + downBy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
};

const blockState = (page: Page) =>
  page.evaluate(() => {
    const block = (
      window as unknown as Record<string, any>
    ).__editorStore.layers[0].blockMap.getAllBlocks()[0];
    return {
      manual: block.hasManualOpacity,
      value: block.pattern.params.u_opacity.value,
      regions: (block.parameterVariations.u_opacity ?? []).length,
      armed: [...block.lanedParams].includes("u_opacity"),
    };
  });

test.describe("opacity", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("sits at the top of the list and reads auto", async ({ page }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");

    // Above all the other parameters, not merely present.
    await expect(page.locator("[data-doc=param-row]").first()).toContainText(
      "Opacity",
    );
    await expect(opacityRow(page)).toHaveAttribute("data-opacity-mode", "auto");
    await expect(opacityValue(page)).toHaveText("auto");
    // Auto is the ABSENCE of an entry, not a stored 1.
    expect((await blockState(page)).regions).toBe(0);
  });

  test("dragging makes it a real value; right-click returns it to auto", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");

    await dragOpacity(page);
    await expect(opacityRow(page)).toHaveAttribute(
      "data-opacity-mode",
      "manual",
    );
    const after = await blockState(page);
    expect(after.manual).toBe(true);
    expect(after.regions).toBeGreaterThan(0);
    expect(after.value).toBeLessThan(1);
    // The value reached the region too, not just the param — otherwise it
    // would not survive a save.
    await expect(opacityValue(page)).not.toHaveText("auto");

    await opacityRow(page).click({ button: "right" });
    await page.locator("[data-doc=reset-opacity]").click();
    await expect(opacityRow(page)).toHaveAttribute("data-opacity-mode", "auto");
    const reset = await blockState(page);
    expect(reset.manual).toBe(false);
    expect(reset.regions).toBe(0);
  });

  test("both auto and a manual value survive a save and reopen", async ({
    page,
  }) => {
    await loadSeededSong(page);
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");

    // Auto first: absence has to come back as absence. It does because
    // u_opacity is a base uniform, so upstream's save-time backfill — which
    // writes a flat for every param that has no variations — skips it.
    await page.keyboard.press("Escape");
    await saveFromGear(page);
    await page.waitForTimeout(500);
    await page.reload();
    await openPatternPanel(page);
    const expand = page.getByLabel("Expand parameters");
    if (await expand.count()) await expand.first().click();
    await expect(opacityRow(page)).toHaveAttribute("data-opacity-mode", "auto");
    expect((await blockState(page)).regions).toBe(0);

    // Then a real value.
    await dragOpacity(page);
    const dragged = (await blockState(page)).value;
    expect(dragged).toBeLessThan(1);
    await page.keyboard.press("Escape");
    await saveFromGear(page);
    await page.waitForTimeout(500);
    await page.reload();
    await openPatternPanel(page);
    const expandAgain = page.getByLabel("Expand parameters");
    if (await expandAgain.count()) await expandAgain.first().click();
    await expect(opacityRow(page)).toHaveAttribute(
      "data-opacity-mode",
      "manual",
    );
    expect((await blockState(page)).value).toBeCloseTo(dragged, 4);
  });

  test("adding a lane promotes it, seeded rather than blank", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");

    await opacityRow(page).click({ button: "right" });
    await page.getByRole("button", { name: "Add Automation Lane" }).click();
    await page.waitForTimeout(300);

    const state = await blockState(page);
    expect(state.armed).toBe(true);
    // Opacity has no empty state to open onto — absence already means auto —
    // so promoting it materializes real variations rather than arming an
    // empty lane the way other params do.
    expect(state.regions).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await expect(
      page.locator("[class*=laneRow]").filter({ hasText: "Opacity" }),
    ).toHaveCount(1);
  });

  test("effects have no opacity row", async ({ page }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await page.locator("[data-doc=add-effect]").click();
    await page.locator("[class*=effectPicker] button").first().click();
    await page.waitForTimeout(400);

    // Opacity applies once per pattern, after its whole effect chain —
    // upstream's own lanableParamNames excludes it on effect blocks.
    await expect(
      page.locator("[data-doc=param-row]").filter({ hasText: "Opacity" }),
    ).toHaveCount(1);
  });
});
