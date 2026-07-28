import { expect, test } from "@playwright/test";
import { gotoEditorClean, insertPattern, openPatternPanel } from "./helpers";

// The region lanes: layer -> block -> parameter hierarchy, with the
// lone-flat convention deciding what displays. A fixture experience is
// loaded through the store's own pipeline (deserialize + bake), the
// same path an upstream-authored row takes.

const FIXTURE = {
  id: undefined,
  name: "fixture",
  user: { id: 7, username: "gandalf" },
  song: { id: -1, name: "", artist: "", filename: "" },
  status: "inprogress",
  version: 2,
  thumbnailURL: "",
  data: {
    layers: [
      {
        id: "layer-1",
        name: "Fixture Layer",
        blockMap: {
          "block-1": {
            id: "block-1",
            pattern: "Nebula",
            startTime: 0,
            duration: 60,
            parameterVariations: {
              // Non-constant: a ramp — this shows as a lane.
              u_timeFactor: [{ type: "linear", duration: 60, from: 0, to: 1 }],
              // Constant flat — the manual value; NO lane.
              u_warp: [{ type: "flat", duration: 60, value: 1.2 }],
              // A live generator — shows as a lane.
              u_period: [
                {
                  type: "periodic",
                  duration: 60,
                  periodicType: "sine",
                  amplitude: 0.5,
                  period: 4,
                  phase: 0,
                  offset: 2,
                },
              ],
            },
            effectBlocks: [],
          },
        },
      },
    ],
  },
};

const loadFixture = async (page: any) => {
  // The page's own init loads "untitled" asynchronously; loading the
  // fixture before that lands would get overwritten by it.
  await page.waitForFunction(
    () => (window as any).__editorStore?.initializationState === "initialized",
  );
  await page.evaluate((fixture: unknown) => {
    const store = (window as any).__editorStore;
    store.experienceStore.loadExperience(fixture);
  }, FIXTURE);
};

test.describe("region lanes", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("empty document: a layer lane and nothing else", async ({ page }) => {
    await expect(page.locator("[data-doc=lane-layer]")).toHaveCount(1);
    await expect(page.locator("[data-doc=lane-block]")).toHaveCount(0);
    await expect(page.locator("[data-doc=lane-row]")).toHaveCount(0);
  });

  test("a fresh block shows its header bar and no param lanes", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Plasma");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-doc=lane-block]")).toHaveCount(1);
    await expect(page.locator("[data-doc=block-bar]")).toHaveCount(1);
    // Fresh blocks carry no variations: every param is a manual value.
    await expect(page.locator("[data-doc=lane-row]")).toHaveCount(0);
  });

  test("fixture: non-constant lanes show; the lone flat does not", async ({
    page,
  }) => {
    await loadFixture(page);
    await expect(page.locator("[data-doc=lane-layer]")).toContainText(
      "Fixture Layer",
    );
    await expect(page.locator("[data-doc=lane-block]")).toContainText("Nebula");
    // The ramp and the sine display; the lone flat (u_warp) is the
    // manual value and does not.
    await expect(page.locator("[data-doc=lane-row]")).toHaveCount(2);
    const laneKeys = await page
      .locator("[data-doc=lane-row]")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-lane-key")),
      );
    expect(laneKeys.some((key) => key?.endsWith("/u_timeFactor"))).toBe(true);
    expect(laneKeys.some((key) => key?.endsWith("/u_period"))).toBe(true);
    expect(laneKeys.some((key) => key?.endsWith("/u_warp"))).toBe(false);

    // The flat still landed: the manual value shows in the params list.
    await openPatternPanel(page);
    await expect(
      page
        .locator("[data-doc=param-row]")
        .filter({ hasText: "Warp" })
        .locator("[class*=paramScrub]"),
    ).toHaveText("1.2");
  });

  test("expand and shrink ride the lane toggle", async ({ page }) => {
    await loadFixture(page);
    const lane = page.locator("[data-doc=lane-row]").first();
    // Lanes start shrunk (not in lanedParams).
    await expect(lane.locator("[class*=laneShrunk]")).toHaveCount(1);
    await lane.getByLabel("Expand lane").click();
    await expect(lane.locator("[class*=laneShrunk]")).toHaveCount(0);
    await lane.getByLabel("Shrink lane").click();
    await expect(lane.locator("[class*=laneShrunk]")).toHaveCount(1);
  });

  test("block bar drags: move, left trim, right grow", async ({ page }) => {
    await loadFixture(page);
    const timing = () =>
      page.evaluate(() => {
        const block = (window as any).__editorStore.layers[0].getAllBlocks()[0];
        return {
          start: block.startTime,
          duration: block.duration,
          regions: block.parameterVariations.u_timeFactor.reduce(
            (sum: number, r: any) => sum + r.duration,
            0,
          ),
        };
      });
    const before = await timing();
    expect(before.start).toBe(0);

    // No song loaded: the bar spans the full area at 60s. Right-trim by
    // dragging the right edge left a quarter of the area (~15s).
    const bar = page.locator("[data-doc=block-bar]");
    let box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, {
      steps: 6,
    });
    await page.mouse.up();
    let now = await timing();
    expect(now.duration).toBeLessThan(before.duration - 5);
    expect(now.start).toBe(0);
    // Regions are untouched by timing edits: they overhang, unplayed.
    expect(now.regions).toBeCloseTo(before.regions, 3);

    // Move: grab the middle, drag right; start advances, duration holds.
    const trimmed = now;
    box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, {
      steps: 6,
    });
    await page.mouse.up();
    now = await timing();
    expect(now.start).toBeGreaterThan(2);
    expect(now.duration).toBeCloseTo(trimmed.duration, 1);

    // Left trim: drag the left edge left; start decreases AND duration
    // grows (the right edge holds still).
    const moved = now;
    box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    now = await timing();
    expect(now.start).toBeLessThan(moved.start);
    expect(now.start + now.duration).toBeCloseTo(
      moved.start + moved.duration,
      1,
    );
  });

  test("the baked pipeline drives the canopy from fixture regions", async ({
    page,
  }) => {
    // The ramp on u_timeFactor: at t=0 the value is 0. The per-frame
    // driver writes region values into the live params.
    await loadFixture(page);
    await page.waitForTimeout(600);
    const value = await page.evaluate(() => {
      const store = (window as any).__editorStore;
      const block = store.layers[0].getAllBlocks()[0];
      return block.pattern.params.u_timeFactor.value;
    });
    expect(value).toBeLessThan(0.05);
  });
});
