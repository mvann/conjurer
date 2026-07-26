import { expect, test } from "@playwright/test";
import {
  gotoEditorClean,
  insertPattern,
  openPatternPanel,
  patternsEmptyHint,
} from "./helpers";

test.describe("persistence and docs", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("autosave prompt lifecycle: change, reload, open, save, reload", async ({
    page,
  }) => {
    const saveButton = page.getByRole("button", { name: "Save", exact: true });
    await expect(saveButton).not.toHaveClass(/saveButtonDirty/);

    await openPatternPanel(page);
    await insertPattern(page, "Plasma");
    // A change makes Save glow and writes an autosave (debounced).
    await expect(saveButton).toHaveClass(/saveButtonDirty/);
    await page.waitForTimeout(1_200);

    await page.reload();
    await expect(page.locator("[class*=autosaveOverlay]")).toBeVisible();
    await page.getByRole("button", { name: "Open Auto Save" }).click();
    await openPatternPanel(page);
    await expect(page.locator("[class*=patternName]").first()).toHaveText(
      "Plasma",
    );
    await page.keyboard.press("Escape");

    await saveButton.click();
    await expect(saveButton).not.toHaveClass(/saveButtonDirty/);
    await page.reload();
    await expect(page.locator("[class*=autosaveOverlay]")).toHaveCount(0);
    await openPatternPanel(page);
    await expect(page.locator("[class*=patternName]").first()).toHaveText(
      "Plasma",
    );
  });

  test("dismissing the autosave prompt keeps the saved state", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page);
    await page.waitForTimeout(1_200);
    await page.reload();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await openPatternPanel(page);
    await expect(patternsEmptyHint(page)).toHaveText("No patterns yet");
  });

  test("control z undoes and control shift z redoes", async ({ page }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Plasma");
    // Let the history debounce capture the change.
    await page.waitForTimeout(600);

    await page.keyboard.press("Control+z");
    await expect(patternsEmptyHint(page)).toHaveText("No patterns yet");

    await page.keyboard.press("Control+Shift+z");
    await expect(page.locator("[class*=patternName]").first()).toHaveText(
      "Plasma",
    );
  });

  test("undo keeps the live pattern instance so params still drive the canopy", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Plasma");
    await page.waitForTimeout(600);

    // Type a param value, let history capture it, then remember the live
    // params object.
    const row = page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Time Factor" });
    await row.locator("[data-doc=param-value]").click();
    await row.locator("input").fill("0.9");
    await row.locator("input").press("Enter");
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const entries = (
        window as unknown as Record<string, { pattern: { params: unknown } }[]>
      ).__editorEntries;
      (window as unknown as Record<string, unknown>).__probeParams =
        entries[0].pattern.params;
    });

    // Undo the edit: the value reverts, but the params OBJECT must be the
    // same one — the canopy's materials and the scrub fields hold it by
    // reference, so a new instance would silently disconnect them.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    const probe = await page.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      const params = w.__editorEntries[0].pattern.params;
      return {
        sameObject: params === w.__probeParams,
        timeFactor: params.u_timeFactor.value,
      };
    });
    expect(probe.sameObject).toBe(true);
    expect(probe.timeFactor).not.toBe(0.9);
  });

  test("docs strip follows hover; ? opens and closes the overlay", async ({
    page,
  }) => {
    await expect(page.locator("[class*=docsTitle]")).toHaveText(
      "Conjurer Spell Crafter",
    );
    await page.locator("[data-doc=canopy]").hover();
    await expect(page.locator("[class*=docsTitle]")).toHaveText(
      "Canopy Preview",
    );

    await page.keyboard.press("?");
    await expect(page.locator("[class*=docsOverlayTitle]")).toHaveText(
      "Canopy Preview",
    );
    await page.keyboard.press("/");
    await expect(page.locator("[class*=docsOverlay]")).toHaveCount(0, {
      timeout: 3_000,
    });
  });
});
