import { expect, test } from "@playwright/test";
import {
  addLaneOnParam,
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

  test("chevron opens the pattern dock; it stays open on outside clicks", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await expect(patternsEmptyHint(page)).toHaveText("No patterns yet");
    // The dock pushes the main column aside instead of overlaying it, so
    // clicking the canopy area must NOT close it.
    await page.mouse.click(800, 300);
    await expect(patternsAside(page)).toHaveClass(/patternsDockOpen/);
    await page.keyboard.press("Escape");
    await expect(patternsAside(page)).not.toHaveClass(/patternsDockOpen/);
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
    await expect(patternsAside(page)).toHaveClass(/patternsDockWide/);
    await page.getByLabel("Back to pattern list").click();
    await expect(patternsAside(page)).not.toHaveClass(/patternsDockWide/);
  });

  test("Add New Automation assigns a lane from the pattern editor", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await page.keyboard.press("Escape");
    await expect(patternsAside(page)).not.toHaveClass(/patternsDockOpen/);

    // Clicking the final lane opens the dock and arms assignment (the
    // cursor badge appears).
    await page.getByRole("button", { name: "Add New Automation" }).click();
    await expect(patternsAside(page)).toHaveClass(/patternsDockOpen/);
    await expect(page.locator("[class*=assignCursor]")).toHaveCount(1);

    // Over an automatable row the badge turns green; elsewhere it is
    // silver.
    const warpRow = page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Warp" });
    await warpRow.hover();
    await expect(page.locator("[class*=assignCursor]")).toHaveClass(
      /assignCursorHot/,
    );
    await page.mouse.move(900, 300);
    await expect(page.locator("[class*=assignCursor]")).not.toHaveClass(
      /assignCursorHot/,
    );

    // Clicking a parameter creates its lane and ends the mode; the dock
    // stays open.
    await warpRow.click();
    await expect(page.locator("[class*=laneRow]")).toHaveCount(1);
    await expect(page.locator("[class*=laneRow]")).toContainText("Warp");
    await expect(page.locator("[class*=assignCursor]")).toHaveCount(0);
    await expect(patternsAside(page)).toHaveClass(/patternsDockOpen/);
  });

  test("assignment cancels on Escape and on outside clicks; dock stays open", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");

    // Escape cancels the assignment but leaves the dock open.
    await page.getByRole("button", { name: "Add New Automation" }).click();
    await expect(page.locator("[class*=assignCursor]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("[class*=assignCursor]")).toHaveCount(0);
    await expect(page.locator("[class*=laneRow]")).toHaveCount(0);
    await expect(patternsAside(page)).toHaveClass(/patternsDockOpen/);

    // A click outside the pattern editor cancels too.
    await page.getByRole("button", { name: "Add New Automation" }).click();
    await expect(page.locator("[class*=assignCursor]")).toHaveCount(1);
    await page.mouse.click(900, 300);
    await expect(page.locator("[class*=assignCursor]")).toHaveCount(0);
    await expect(page.locator("[class*=laneRow]")).toHaveCount(0);
    await expect(patternsAside(page)).toHaveClass(/patternsDockOpen/);
  });

  test("lane controls: the eye toggles the curve; the trash deletes the lane", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await addLaneOnParam(page, "Warp");
    await closePanel(page);

    // No keyframes yet: the eye is disabled (an empty lane drives
    // nothing).
    const lane = page.locator("[class*=laneRow]").first();
    await expect(lane.getByLabel("Disable lane")).toBeDisabled();

    // Two keyframes, then the eye disables and re-enables the curve.
    await lane.click();
    const area = (await page.locator("[class*=editorLineArea]").boundingBox())!;
    await page.mouse.dblclick(
      area.x + area.width * 0.3,
      area.y + area.height * 0.3,
    );
    await page.mouse.dblclick(
      area.x + area.width * 0.7,
      area.y + area.height * 0.7,
    );
    await page.getByLabel("Close automation editor").click();

    const laneActive = () =>
      page.evaluate(() => {
        const entries = (
          window as unknown as Record<
            string,
            { automation: Record<string, { active?: boolean }> }[]
          >
        ).__editorEntries;
        return Object.values(entries[0].automation)[0].active !== false;
      });
    await lane.getByLabel("Disable lane").click();
    expect(await laneActive()).toBe(false);
    await lane.getByLabel("Enable lane").click();
    expect(await laneActive()).toBe(true);

    // The trash removes the lane; the expanded editor closes with it.
    await lane.click();
    await expect(page.locator("[class*=automationEditor__]")).toBeVisible();
    await page.getByLabel("Delete lane").click();
    await expect(page.locator("[class*=laneRow]")).toHaveCount(0);
    await expect(page.locator("[class*=automationEditor__]")).toHaveCount(0);
  });

  test("dragging a lane label reorders lanes; the order persists", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await addLaneOnParam(page, "Warp");
    await addLaneOnParam(page, "Time Factor");
    await closePanel(page);
    // Let the dock's width animation settle: the lane rows slide left
    // while it closes, and a drag must start from their resting boxes.
    await page.waitForTimeout(400);

    const laneTexts = () => page.locator("[class*=laneRow]").allTextContents();
    expect((await laneTexts()).map((text) => text.includes("Warp"))).toEqual([
      true,
      false,
    ]);

    // Drag the Warp label below the Time Factor lane.
    const warpLabel = page
      .locator("[class*=laneRow]", { hasText: "Warp" })
      .locator("[class*=laneLabelText]");
    const from = (await warpLabel.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      from.x + from.width / 2,
      from.y + from.height / 2 + 80,
      { steps: 8 },
    );
    await page.mouse.up();
    expect((await laneTexts()).map((text) => text.includes("Warp"))).toEqual([
      false,
      true,
    ]);
    // The drag did not also expand the editor.
    await expect(page.locator("[class*=automationEditor__]")).toHaveCount(0);

    // The order survives a reload through the autosave.
    await page.waitForTimeout(1_200);
    await page.reload();
    await page.getByRole("button", { name: "Open Auto Save" }).click();
    expect((await laneTexts()).map((text) => text.includes("Warp"))).toEqual([
      false,
      true,
    ]);
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
