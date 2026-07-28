import { expect, test } from "@playwright/test";
import {
  gotoEditorClean,
  insertPattern,
  openPatternPanel,
  patternsAside,
} from "./helpers";

test.describe("layout and layers panel", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("page shows the spell crafter layout", async ({ page }) => {
    await expect(page.locator("[class*=subtitle]")).toHaveText("Spell Crafter");
    await expect(page.locator("[class*=paneLabel]").first()).toHaveText(
      "Canopy",
    );
    await expect(page.getByRole("button", { name: "Add Song" })).toBeVisible();
    await expect(page.getByLabel("Play", { exact: true })).toBeDisabled();
    // The loaded experience shows as name (by author) in the header.
    await expect(page.locator("[data-doc=experience]")).toHaveText("untitled");
  });

  test("chevron opens the layer dock; it stays open on outside clicks", async ({
    page,
  }) => {
    await openPatternPanel(page);
    // One default layer, empty.
    await expect(page.locator("[data-doc=layer-row]")).toHaveCount(1);
    // The dock pushes the main column aside instead of overlaying it, so
    // clicking the canopy area must NOT close it.
    await page.mouse.click(800, 300);
    await expect(patternsAside(page)).toHaveClass(/patternsDockOpen/);
    await page.keyboard.press("Escape");
    await expect(patternsAside(page)).not.toHaveClass(/patternsDockOpen/);
  });

  test("add pattern flow inserts a block into the layer, expanded", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Plasma");
    await expect(page.locator("[class*=patternName]").first()).toHaveText(
      "Plasma",
    );
    // Default expanded: parameters are visible without clicking the caret.
    expect(await page.locator("[data-doc=param-row]").count()).toBeGreaterThan(
      0,
    );
  });

  test("sliver click returns from the add-pattern view", async ({ page }) => {
    await openPatternPanel(page);
    await page.locator("[data-doc=add-pattern]").first().click();
    await expect(patternsAside(page)).toHaveClass(/patternsDockWide/);
    await page.getByLabel("Back to pattern list").click();
    await expect(patternsAside(page)).not.toHaveClass(/patternsDockWide/);
  });

  test("layers add, rename, hide, and remove", async ({ page }) => {
    await openPatternPanel(page);

    // Add: a second layer appears with a generated name.
    await page.locator("[data-doc=add-layer]").click();
    await expect(page.locator("[data-doc=layer-row]")).toHaveCount(2);

    // Rename: double-click the name, type, Enter.
    await page.locator("[class*=layerName_]").first().dblclick();
    const input = page.locator("[class*=layerNameInput]");
    await input.fill("Bass Layer");
    await input.press("Enter");
    await expect(page.locator("[class*=layerName_]").first()).toHaveText(
      "Bass Layer",
    );

    // Hide: the layer's eye toggles its canopy presence (runtime-only).
    await page.getByLabel("Hide layer").first().click();
    await expect(page.getByLabel("Show layer").first()).toBeVisible();
    await page.getByLabel("Show layer").first().click();

    // Remove: the second layer deletes; the last one cannot.
    await page.getByLabel("Remove layer").nth(1).click();
    await expect(page.locator("[data-doc=layer-row]")).toHaveCount(1);
    await expect(page.getByLabel("Remove layer")).toBeDisabled();
  });

  test("blocks land in the layer whose Add Pattern was used", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await page.locator("[data-doc=add-layer]").click();
    // Insert into the SECOND layer.
    await page.locator("[data-doc=add-pattern]").nth(1).click();
    await page
      .locator("[class*=tileGrid] button")
      .filter({ hasText: /^Disc$/ })
      .click();
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    await page.waitForTimeout(400);
    // The block row renders under the second layer: the panel's block
    // ids report one empty layer then one with a block.
    const blocksByLayer = await page.evaluate(() =>
      (window as any).__editorBlocks.map((ids: string[]) => ids.length),
    );
    expect(blocksByLayer).toEqual([0, 1]);
  });

  test("right click duplicates a block with its parameter values", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");

    // Give the original a distinctive value first.
    const timeFactorRow = (index: number) =>
      page
        .locator("[data-doc=param-row]")
        .filter({ hasText: "Time Factor" })
        .nth(index);
    await timeFactorRow(0).locator("[class*=paramScrub]").click();
    const input = timeFactorRow(0).locator("[class*=paramInput]");
    await input.fill("0.5");
    await input.press("Enter");

    await page
      .locator("[data-doc=pattern-row]")
      .first()
      .click({ button: "right" });
    await page.getByRole("button", { name: "Duplicate" }).click();

    await expect(page.locator("[class*=patternName]")).toHaveCount(2);
    await expect(page.locator("[class*=patternName]").nth(1)).toHaveText(
      "Nebula",
    );
    await expect(timeFactorRow(1).locator("[class*=paramScrub]")).toHaveText(
      "0.5",
    );

    // The copy is independent: editing it leaves the original alone.
    await timeFactorRow(1).locator("[class*=paramScrub]").click();
    const copyInput = timeFactorRow(1).locator("[class*=paramInput]");
    await copyInput.fill("0.9");
    await copyInput.press("Enter");
    await expect(timeFactorRow(0).locator("[class*=paramScrub]")).toHaveText(
      "0.5",
    );
  });

  test("block trash removes the block", async ({ page }) => {
    await openPatternPanel(page);
    await insertPattern(page);
    await page.getByLabel("Remove pattern").click();
    await expect(page.locator("[data-doc=pattern-row]")).toHaveCount(0);
  });

  test("numeric params scrub by dragging and edit by click-to-type", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    const scrub = page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Time Factor" })
      .locator("[class*=paramScrub]");
    const before = await scrub.textContent();
    const box = (await scrub.boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 5, box.y - 60, { steps: 5 });
    await page.mouse.up();
    await expect(scrub).not.toHaveText(before!);

    await scrub.click();
    const input = page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Time Factor" })
      .locator("[class*=paramInput]");
    await input.fill("0.5");
    await input.press("Enter");
    await expect(scrub).toHaveText("0.5");
  });

  test("palette params expose the shared editor", async ({ page }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await expect(page.locator("[data-doc=palette-editor]")).toBeVisible();
    expect(
      await page.locator("[class*=palettePresetSwatch]").count(),
    ).toBeGreaterThan(4);
  });

  test("opacity: auto by default; manual writes through; reset returns", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    const opacityRegions = () =>
      page.evaluate(
        () =>
          (window as any).__editorStore.layers[0].getAllBlocks()[0]
            .parameterVariations.u_opacity?.length ?? 0,
      );

    // Auto: no stored regions, the row reads "auto".
    const row = page.locator("[data-doc=opacity-row]");
    await expect(row).toContainText("auto");
    expect(await opacityRegions()).toBe(0);

    // Click auto: a lone constant materializes; the scrub appears.
    await row.getByRole("button", { name: "auto" }).click();
    expect(await opacityRegions()).toBe(1);
    await expect(row.locator("[class*=paramScrub]")).toHaveText("1");

    // Scrub writes through to the constant region.
    await row.locator("[class*=paramScrub]").click();
    const input = row.locator("[class*=paramInput]");
    await input.fill("0.4");
    await input.press("Enter");
    const constant = await page.evaluate(() => {
      const regions = (window as any).__editorStore.layers[0].getAllBlocks()[0]
        .parameterVariations.u_opacity;
      return regions[0].nodes.map((n: any) => n.value);
    });
    expect(constant.every((v: number) => Math.abs(v - 0.4) < 1e-6)).toBe(true);

    // Reset to Auto deletes the entry.
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "Reset to Auto" }).click();
    expect(await opacityRegions()).toBe(0);
    await expect(row).toContainText("auto");
  });

  test("effects add, reorder, and remove on a block", async ({ page }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");

    await page.locator("[data-doc=add-effect]").click();
    await page
      .locator("[class*=effectPickerItem]")
      .filter({ hasText: "Color Tint" })
      .click();
    await expect(page.locator("[data-doc=effect-row]")).toHaveCount(1);

    await page.locator("[data-doc=add-effect]").click();
    await page
      .locator("[class*=effectPickerItem]")
      .filter({ hasText: "Kaleidoscope" })
      .click();
    await expect(page.locator("[data-doc=effect-row]")).toHaveCount(2);

    // Reorder: move the second effect up; it becomes first.
    await page.getByLabel("Move effect up").nth(1).click();
    await expect(
      page.locator("[data-doc=effect-row] [class*=effectName]").first(),
    ).toContainText("Kaleidoscope");

    // Remove both.
    await page.getByLabel("Remove effect").first().click();
    await page.getByLabel("Remove effect").first().click();
    await expect(page.locator("[data-doc=effect-row]")).toHaveCount(0);
  });
});
