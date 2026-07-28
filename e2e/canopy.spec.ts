import { expect, test, Page } from "@playwright/test";
import { gotoEditorClean, insertPattern, openPatternPanel } from "./helpers";

// Pixel-level smoke tests for the params -> shader pipeline, on the
// block model. These assert the actual rendered output, which is what
// silently breaks when live param objects get disconnected from the
// canopy's materials.

const canopyClip = async (page: Page) => {
  const box = (await page
    .locator("[data-doc=canopy] canvas")
    .first()
    .boundingBox())!;
  return {
    x: box.x + box.width * 0.3,
    y: box.y + box.height * 0.25,
    width: Math.min(box.width * 0.4, 500),
    height: Math.min(box.height * 0.5, 350),
  };
};

const shoot = async (page: Page) =>
  page.screenshot({ clip: await canopyClip(page) });

const diffBytes = (a: Buffer, b: Buffer) => {
  let diff = Math.abs(a.length - b.length);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) diff++;
  return diff;
};

const setParam = async (page: Page, label: string, value: number) => {
  const row = page.locator("[data-doc=param-row]").filter({ hasText: label });
  await row.locator("[data-doc=param-value]").click();
  await row.locator("input").fill(String(value));
  await row.locator("input").press("Enter");
};

test.describe("canopy pixel smoke", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("param edits reach the shader; zeroed time params freeze the render", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await setParam(page, "Time Factor", 0);
    await setParam(page, "Color Shift", 0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);

    // Frozen: consecutive frames a second apart are identical.
    const still1 = await shoot(page);
    await page.waitForTimeout(1_000);
    const still2 = await shoot(page);
    expect(diffBytes(still1, still2)).toBeLessThan(100);

    // An edit repaints: Warp dramatically changes Nebula's shape.
    await openPatternPanel(page);
    await setParam(page, "Warp", 3);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const warped = await shoot(page);
    expect(diffBytes(still2, warped)).toBeGreaterThan(2_000);
  });

  test("region automation drives the shader through the block driver", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await setParam(page, "Time Factor", 0);
    await setParam(page, "Color Shift", 0);
    await page.keyboard.press("Escape");
    // Install an extreme Warp ramp as regions, then jump the transport
    // by writing block-local evaluation inputs: with no song, the
    // driver holds t=0, so instead compare region-driven values by
    // rewriting the region's constant.
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      const block = store.layers[0].getAllBlocks()[0];
      block.parameterVariations.u_warp = [
        { type: "flat", duration: 60, value: 0, valueAtTime: () => 0 },
      ];
    });
    await page.waitForTimeout(500);
    const flat = await shoot(page);
    await page.evaluate(() => {
      const store = (window as any).__editorStore;
      const block = store.layers[0].getAllBlocks()[0];
      block.parameterVariations.u_warp = [
        { type: "flat", duration: 60, value: 6, valueAtTime: () => 6 },
      ];
    });
    await page.waitForTimeout(500);
    const warped = await shoot(page);
    expect(diffBytes(flat, warped)).toBeGreaterThan(2_000);
  });
});
