import { expect, test } from "@playwright/test";
import {
  closePanel,
  gotoEditorClean,
  insertPattern,
  openPatternPanel,
  patternsAside,
  patternsEmptyHint,
} from "./helpers";

test.describe("layout and pattern panel", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("page shows the spell crafter layout", async ({ page }) => {
    await expect(page.locator("[class*=subtitle]")).toHaveText("Spell Crafter");
    await expect(page.locator("[class*=paneLabel]").first()).toHaveText(
      "Canopy",
    );
    await expect(page.getByRole("button", { name: "Add Song" })).toBeVisible();
    await expect(page.getByLabel("Play", { exact: true })).toBeDisabled();
  });

  test("chevron opens the pattern panel; Escape closes it", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await expect(patternsEmptyHint(page)).toHaveText("No patterns yet");
    await page.keyboard.press("Escape");
    await expect(patternsAside(page)).not.toHaveClass(/sidePanelOpen/);
  });

  test("add pattern flow inserts into the stack and starts expanded", async ({
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
    await page.getByRole("button", { name: "Add Pattern" }).click();
    await expect(patternsAside(page)).toHaveClass(/sidePanelWide/);
    await page.getByLabel("Back to pattern list").click();
    await expect(patternsAside(page)).not.toHaveClass(/sidePanelWide/);
  });

  test("visibility toggle and trash work", async ({ page }) => {
    await openPatternPanel(page);
    await insertPattern(page);
    await page.getByLabel("Hide pattern").click();
    await expect(page.getByLabel("Show pattern")).toBeVisible();
    await page.getByLabel("Remove pattern").click();
    await expect(patternsEmptyHint(page)).toHaveText("No patterns yet");
  });

  test("numeric params scrub by dragging and edit by click-to-type", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    // A specific numeric row: the palette editor's coefficient scrubs
    // share the scrub class but have no click-to-type.
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

    // Quick click opens the type-in box; Enter commits. Scope to the row:
    // the palette editor's hex input shares the input class.
    await scrub.click();
    const input = page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Time Factor" })
      .locator("[class*=paramInput]");
    await input.fill("0.5");
    await input.press("Enter");
    await expect(scrub).toHaveText("0.5");
  });

  test("palette params expose the shared editor and automate as a whole", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    // The composite expands into the palette editor: gradient preview,
    // preset swatches, and the coefficient grid.
    await expect(page.locator("[data-doc=palette-editor]")).toBeVisible();
    expect(
      await page.locator("[class*=palettePresetSwatch]").count(),
    ).toBeGreaterThan(4);

    // Right-click on the composite row: the lane menu appears (the whole
    // palette automates as one lane).
    await page
      .locator("[data-doc=param-row]")
      .filter({ hasText: /^Palette$/ })
      .click({ button: "right" });
    await expect(
      page.getByRole("button", { name: "Add Automation Lane" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add Automation Lane" }).click();
    await closePanel(page);
    await expect(page.locator("[class*=laneRow]")).toHaveCount(1);
  });

  test("automation lane add and delete via context menu", async ({ page }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    const timeFactor = page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Time Factor" });
    await timeFactor.click({ button: "right" });
    await page.getByRole("button", { name: "Add Automation Lane" }).click();
    await expect(timeFactor).toHaveClass(/paramAutomated/);
    await closePanel(page);
    await expect(page.locator("[class*=laneRow]")).toHaveCount(1);

    await openPatternPanel(page);
    await timeFactor.click({ button: "right" });
    await page.getByRole("button", { name: "Delete Automation Lane" }).click();
    await closePanel(page);
    await expect(page.locator("[class*=laneRow]")).toHaveCount(0);
  });
});
