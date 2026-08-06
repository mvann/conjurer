import { expect, test } from "@playwright/test";
import {
  addLaneOnParam,
  closePanel,
  gotoEditorClean,
  insertPattern,
  openPatternPanel,
} from "./helpers";

// Horizontal orientation (decision 32).
//
// The owner's description is the thing to hold onto here, because it is NOT a
// rearrangement: "the expanded editor stays where it is in vertical view and the
// canopy viewer goes into a new pane that's to the left of the vertical view
// stack." The stack keeps its order; the canopy simply leaves it. And because
// the canopy has vacated that slot, the editor owns it permanently — "the
// expanded automation view will just stay open. It won't close, which means the
// X button disappears", plus "you should not be able to close the expanded
// automation view by clicking on the same lane again. If no lane is selected it
// should say something like 'no automation selected'".
//
// These assertions exist because the abandoned branch got each of them wrong.

const goHorizontal = async (page: import("@playwright/test").Page) => {
  // The pane slides in and out on a transform, so it stays in the layout when
  // closed; aria-hidden is what actually tells the two states apart.
  const pane = page.locator("[data-doc=gear-pane]");
  await page.locator("[data-doc=gear]").click();
  await expect(pane).toHaveAttribute("aria-hidden", "false");
  await page.getByRole("button", { name: "Horizontal", exact: true }).click();
  // Close it so it stops covering the right column.
  await page.locator("[class*=panelBackdrop]").click();
  await expect(pane).toHaveAttribute("aria-hidden", "true");
};

test.describe("horizontal orientation", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("the canopy leaves the stack; the editor pane keeps its slot", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await addLaneOnParam(page, "Time Factor");
    await closePanel(page);
    await goHorizontal(page);

    const canopy = page.locator("[data-doc=canopy]");
    const editorPane = page.locator("[data-doc=editor-pane]");
    const lanes = page.locator("[class*=automationPane]").first();

    const canopyBox = (await canopy.boundingBox())!;
    const editorBox = (await editorPane.boundingBox())!;
    const lanesBox = (await lanes.boundingBox())!;

    // The canopy is its own full-height pane to the LEFT of everything else.
    expect(canopyBox.x + canopyBox.width).toBeLessThanOrEqual(editorBox.x + 1);
    expect(canopyBox.x + canopyBox.width).toBeLessThanOrEqual(lanesBox.x + 1);
    expect(canopyBox.height).toBeGreaterThan(editorBox.height);

    // And the stack to its right is still a stack, in the same order: the
    // editor's slot sits above the lanes.
    expect(editorBox.y).toBeLessThan(lanesBox.y);
    expect(editorBox.x).toBeGreaterThanOrEqual(canopyBox.x + canopyBox.width - 1);
  });

  test("the editor stays up: no X, no toggle shut, no Escape", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await addLaneOnParam(page, "Time Factor");
    await closePanel(page);
    await goHorizontal(page);

    const editor = page.locator("[class*=automationEditor__]");
    const lane = page.locator("[class*=laneRow]").first();

    await lane.click();
    await expect(editor).toBeVisible();
    await expect(
      page.getByLabel("Close automation editor"),
    ).toHaveCount(0);

    // Clicking the same lane again is a no-op rather than a close.
    await lane.click();
    await expect(editor).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
  });

  test("the empty pane says so, and vertical keeps every closing gesture", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await addLaneOnParam(page, "Time Factor");
    await closePanel(page);
    await goHorizontal(page);

    // Nothing selected yet: the pane is not blank, it says what it is waiting
    // for.
    await expect(page.locator("[data-doc=editor-empty]")).toHaveText(
      "No automation selected",
    );

    await page.locator("[class*=laneRow]").first().click();
    await expect(page.locator("[data-doc=editor-empty]")).toHaveCount(0);

    // Back to vertical: the canopy returns to the stack and closing works
    // again, exactly as it always did.
    await page.locator("[data-doc=gear]").click();
    await page.getByRole("button", { name: "Vertical", exact: true }).click();
    await page.locator("[class*=panelBackdrop]").click();
    await expect(page.locator("[data-doc=gear-pane]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.locator("[data-doc=editor-pane]")).toHaveCount(0);

    const editor = page.locator("[class*=automationEditor__]");
    await expect(editor).toBeVisible();
    await expect(page.getByLabel("Close automation editor")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
  });
});
