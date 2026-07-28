import { expect, test, Page } from "@playwright/test";
import {
  closePanel,
  gotoEditorClean,
  insertPattern,
  loadSeededSong,
  openPatternPanel,
  settleBox,
} from "./helpers";

// Effects on patterns: shaders chained after the pattern (u_texture in,
// transformed image out), with params that scrub, persist, and automate
// exactly like pattern params. Pixel assertions target the canopy with
// Nebula's time-driven params zeroed, so only real changes repaint.

const canopyShot = async (page: Page) => {
  const box = (await page
    .locator("[data-doc=canopy] canvas")
    .first()
    .boundingBox())!;
  return page.screenshot({
    clip: {
      x: box.x + box.width * 0.3,
      y: box.y + box.height * 0.25,
      width: Math.min(box.width * 0.4, 500),
      height: Math.min(box.height * 0.5, 350),
    },
  });
};

const diffBytes = (a: Buffer, b: Buffer) => {
  let diff = Math.abs(a.length - b.length);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) diff++;
  return diff;
};

const typeParam = async (
  scope: ReturnType<Page["locator"]>,
  label: string,
  value: number,
) => {
  const row = scope.locator("[data-doc=param-row]").filter({ hasText: label });
  await row.locator("[data-doc=param-value]").click();
  await row.locator("input").fill(String(value));
  await row.locator("input").press("Enter");
};

const insertStaticNebula = async (page: Page) => {
  await openPatternPanel(page);
  await insertPattern(page, "Nebula");
  const panel = page.locator("aside").filter({ hasText: "Add Pattern" });
  await typeParam(panel, "Time Factor", 0);
  await typeParam(panel, "Color Shift", 0);
};

const addEffect = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "Add Effect" }).click();
  await page
    .locator("[class*=effectPickerItem]")
    .filter({ hasText: name })
    .click();
};

test.describe.skip("effects", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("adding an effect shows its params and transforms the canopy", async ({
    page,
  }) => {
    await insertStaticNebula(page);
    await closePanel(page);
    await page.waitForTimeout(600);
    const before = await canopyShot(page);

    await openPatternPanel(page);
    await addEffect(page, "Color Tint");
    const effectRow = page.locator("[data-doc=effect-row]");
    await expect(effectRow).toBeVisible();
    await typeParam(effectRow, "Intensity", 1);
    await closePanel(page);
    await page.waitForTimeout(500);
    const tinted = await canopyShot(page);
    expect(diffBytes(before, tinted)).toBeGreaterThan(2_000);

    // Removing the effect restores the untinted render.
    await openPatternPanel(page);
    await page.getByLabel("Remove effect").click();
    await expect(effectRow).toHaveCount(0);
    await closePanel(page);
    await page.waitForTimeout(500);
    const restored = await canopyShot(page);
    expect(diffBytes(before, restored)).toBeLessThan(200);
  });

  test("effect params automate: lane, editor label, canopy driven by curve", async ({
    page,
  }) => {
    await insertStaticNebula(page);
    await addEffect(page, "Color Tint");
    const effectRow = page.locator("[data-doc=effect-row]");
    await typeParam(effectRow, "Intensity", 0);

    // A lane on the effect's Intensity, via the same context menu as any
    // param.
    await effectRow
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Intensity" })
      .click({ button: "right" });
    await page.getByRole("button", { name: "Add Automation Lane" }).click();
    await closePanel(page);
    const lane = page.locator("[class*=laneRow]").first();
    await expect(lane).toContainText("Color Tint");
    await expect(lane).toContainText("Intensity");

    // Two keyframes: no tint early, full tint late.
    await lane.click();
    await expect(page.locator("[class*=paneLabel]").first()).toContainText(
      "Color Tint",
    );
    await settleBox(page, "[class*=editorLineArea]");
    const area = (await page.locator("[class*=editorLineArea]").boundingBox())!;
    await page.mouse.dblclick(
      area.x + area.width * 0.2,
      area.y + area.height * 0.88,
    );
    await page.mouse.dblclick(
      area.x + area.width * 0.7,
      area.y + area.height * 0.12,
    );
    await page.getByLabel("Close automation editor").click();

    await loadSeededSong(page);
    const waveform = page.locator("canvas[class*=waveform]");
    const box = (await waveform.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const early = await canopyShot(page);
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const late = await canopyShot(page);
    expect(diffBytes(early, late)).toBeGreaterThan(2_000);
  });

  test("effects persist across reload and reorder; removal drops their lanes", async ({
    page,
  }) => {
    await insertStaticNebula(page);
    await addEffect(page, "Color Tint");
    await addEffect(page, "Kaleidoscope");
    const effectNames = () =>
      page.evaluate(() =>
        (
          window as unknown as Record<
            string,
            { effects: { pattern: { name: string } }[] }[]
          >
        ).__editorEntries[0].effects.map((effect) => effect.pattern.name),
      );
    expect(await effectNames()).toEqual(["Color Tint", "Kaleidoscope"]);

    // Reorder: Kaleidoscope up.
    await page.getByLabel("Move effect up").nth(1).click();
    expect(await effectNames()).toEqual(["Kaleidoscope", "Color Tint"]);

    // A lane on an effect param, then reload: chain and lane survive the
    // autosave round trip.
    const tintRow = page
      .locator("[data-doc=effect-row]")
      .filter({ hasText: "Color Tint" });
    await tintRow
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Intensity" })
      .click({ button: "right" });
    await page.getByRole("button", { name: "Add Automation Lane" }).click();
    await page.waitForTimeout(1_200);
    await page.reload();
    await page.getByRole("button", { name: "Open Auto Save" }).click();
    expect(await effectNames()).toEqual(["Kaleidoscope", "Color Tint"]);
    await expect(page.locator("[class*=laneRow]")).toHaveCount(1);

    // Removing the effect takes its lane with it.
    await openPatternPanel(page);
    await page
      .locator("[data-doc=effect-row]")
      .filter({ hasText: "Color Tint" })
      .getByLabel("Remove effect")
      .click();
    await expect(page.locator("[class*=laneRow]")).toHaveCount(0);
  });
});
