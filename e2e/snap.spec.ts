import { expect, test, Page } from "@playwright/test";
import {
  addLaneOnParam,
  closePanel,
  gotoEditorClean,
  insertPattern,
  loadSeededSong,
  openPatternPanel,
  settleBox,
} from "./helpers";

// Snap-to for time edits in the automation editor: Off, BPM Grid, and
// Transients, chosen from the right-click menu. These tests assert the
// SNAPPED RESULT through the live-state hooks: a keyframe created under
// grid snap lands exactly on a beat of the detected grid; under
// transient snap it lands exactly on a detected onset.

const openLaneWithSong = async (page: Page) => {
  await loadSeededSong(page);
  await openPatternPanel(page);
  await insertPattern(page, "Nebula");
  await addLaneOnParam(page, "Time Factor");
  await closePanel(page);
  await page.locator("[class*=laneRow]").first().click();
  await expect(page.locator("[class*=automationEditor__]")).toBeVisible();
  // The dock is still sliding closed; wait for resting geometry.
  await settleBox(page, "[class*=editorLineArea]");
  // Beat and transient analysis both finish before snapping is offered.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            !!(window as unknown as Record<string, unknown>).__editorBeatGrid &&
            !!(window as unknown as Record<string, unknown>).__editorTransients,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
};

const openSnapMenu = async (page: Page) => {
  const area = page.locator("[class*=editorLineArea]");
  const box = (await area.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.15, {
    button: "right",
  });
  await expect(page.locator("[data-doc=snap-menu]")).toBeVisible();
  return box;
};

// The first automation curve's keyframe times, straight from live state.
const laneKeyframeTimes = (page: Page) =>
  page.evaluate(() => {
    const entries = (
      window as unknown as Record<
        string,
        { automation: Record<string, { keyframes: { time: number }[] }> }[]
      >
    ).__editorEntries;
    const curves = Object.values(entries[0]?.automation ?? {});
    return curves[0]?.keyframes.map((keyframe) => keyframe.time) ?? [];
  });

test.describe("snap to", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("menu offers the modes; BPM Grid lands keyframes on beats", async ({
    page,
  }) => {
    await openLaneWithSong(page);
    const box = await openSnapMenu(page);

    const menu = page.locator("[data-doc=snap-menu]");
    for (const label of ["Off", "BPM Grid", "Transients"])
      await expect(menu.getByRole("button", { name: label })).toBeEnabled();
    await expect(menu.getByRole("button", { name: "Off" })).toHaveClass(
      /contextMenuItemActive/,
    );

    await menu.getByRole("button", { name: "BPM Grid" }).click();
    await page.mouse.dblclick(box.x + box.width * 0.45, box.y + box.height / 2);
    await expect.poll(() => laneKeyframeTimes(page)).toHaveLength(1);

    const [time] = await laneKeyframeTimes(page);
    const grid = await page.evaluate(
      () =>
        (
          window as unknown as Record<
            string,
            { bpm: number; offsetSeconds: number; durationSeconds: number }
          >
        ).__editorBeatGrid,
    );
    const beats =
      (time * grid.durationSeconds - grid.offsetSeconds) / (60 / grid.bpm);
    expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-3);
  });

  test("Transients lands keyframes on detected onsets", async ({ page }) => {
    await openLaneWithSong(page);
    const box = await openSnapMenu(page);
    await page
      .locator("[data-doc=snap-menu]")
      .getByRole("button", { name: "Transients" })
      .click();

    await page.mouse.dblclick(box.x + box.width * 0.55, box.y + box.height / 2);
    await expect.poll(() => laneKeyframeTimes(page)).toHaveLength(1);

    const [time] = await laneKeyframeTimes(page);
    const nearest = await page.evaluate(
      (t) =>
        Math.min(
          ...(
            window as unknown as Record<string, number[]>
          ).__editorTransients.map((onset) => Math.abs(onset - t)),
        ),
      time,
    );
    expect(nearest).toBeLessThan(1e-9);
  });

  test("snap mode survives closing and reopening the editor", async ({
    page,
  }) => {
    await openLaneWithSong(page);
    await openSnapMenu(page);
    await page
      .locator("[data-doc=snap-menu]")
      .getByRole("button", { name: "BPM Grid" })
      .click();

    await page.getByLabel("Close automation editor").click();
    await page.locator("[class*=laneRow]").first().click();
    await expect(page.locator("[class*=automationEditor__]")).toBeVisible();

    await openSnapMenu(page);
    await expect(
      page
        .locator("[data-doc=snap-menu]")
        .getByRole("button", { name: "BPM Grid" }),
    ).toHaveClass(/contextMenuItemActive/);
  });

  test("without a song, grid and transient options are dimmed", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await addLaneOnParam(page, "Time Factor");
    await closePanel(page);
    await page.locator("[class*=laneRow]").first().click();
    await openSnapMenu(page);

    const menu = page.locator("[data-doc=snap-menu]");
    await expect(menu.getByRole("button", { name: "Off" })).toBeEnabled();
    await expect(menu.getByRole("button", { name: "BPM Grid" })).toBeDisabled();
    await expect(
      menu.getByRole("button", { name: "Transients" }),
    ).toBeDisabled();
  });
});
