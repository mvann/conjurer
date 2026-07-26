import { expect, test, Page } from "@playwright/test";
import {
  gotoEditorClean,
  insertPattern,
  loadSeededSong,
  openPatternPanel,
} from "./helpers";

// Pixel-level smoke tests for the params -> shader pipeline. The rest of
// the suite asserts DOM and serialized state; these assert the actual
// rendered output, which is what silently breaks when the live param
// objects get disconnected from the canopy's materials (the class of bug
// that once shipped through a fully green suite).
//
// Technique: Nebula's motion comes entirely from u_time * u_timeFactor
// and u_time * u_colorShift. Zeroing both makes the render a pure
// function of the other params — so a frozen canopy proves edits landed,
// and any repaint after an edit proves the edit reached the shader.

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

// Nebula with its time-driven params zeroed: a static render that only
// changes when some other param reaches the shader.
const insertStaticNebula = async (page: Page) => {
  await openPatternPanel(page);
  await insertPattern(page, "Nebula");
  await setParam(page, "Time Factor", 0);
  await setParam(page, "Color Shift", 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
};

test.describe("canopy pixel smoke", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("param edits reach the shader; zeroed time params freeze the render", async ({
    page,
  }) => {
    await insertStaticNebula(page);

    // Frozen: consecutive frames a second apart are identical, which
    // both proves the canopy is rendering deterministically and that the
    // two zeroing edits landed.
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

  test("automation drives the shader as the transport moves", async ({
    page,
  }) => {
    await insertStaticNebula(page);

    // A Warp lane with two very different keyframes.
    await openPatternPanel(page);
    await page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Warp" })
      .click({ button: "right" });
    await page.getByRole("button", { name: "Add Automation Lane" }).click();
    await page.keyboard.press("Escape");
    await page.locator("[class*=laneRow]").first().click();
    const area = (await page.locator("[class*=editorLineArea]").boundingBox())!;
    await page.mouse.dblclick(
      area.x + area.width * 0.2,
      area.y + area.height * 0.9,
    );
    await page.mouse.dblclick(
      area.x + area.width * 0.7,
      area.y + area.height * 0.1,
    );
    await page.getByLabel("Close automation editor").click();

    await loadSeededSong(page);

    // Seek to two points on the curve: the drive loop must push each
    // point's Warp value into the shader, visibly changing the render.
    const waveform = page.locator("canvas[class*=waveform]");
    const box = (await waveform.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const early = await shoot(page);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const late = await shoot(page);
    expect(diffBytes(early, late)).toBeGreaterThan(2_000);
  });

  test("param edits still repaint after an undo", async ({ page }) => {
    // Regression: undo once replaced the live pattern instances, leaving
    // every later edit writing into objects the canopy no longer
    // rendered. Only a pixel assertion catches that.
    await insertStaticNebula(page);

    await openPatternPanel(page);
    await setParam(page, "Warp", 2);
    await page.waitForTimeout(600);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);

    const beforeEdit = await shoot(page);
    await setParam(page, "Warp", 6);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const afterEdit = await shoot(page);
    expect(diffBytes(beforeEdit, afterEdit)).toBeGreaterThan(2_000);
  });
});
