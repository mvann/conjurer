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

  test("editor: open, add and delete nodes, split a wave, retype, inspector", async ({
    page,
  }) => {
    await loadFixture(page);
    const laneState = () =>
      page.evaluate(() => {
        const block = (window as any).__editorStore.layers[0].getAllBlocks()[0];
        return block.parameterVariations.u_timeFactor.map((region: any) => ({
          type: region.type,
          nodes: region.nodes?.length ?? 0,
        }));
      });

    // Open the ramp lane; the pane label names the path.
    await page.locator("[data-doc=lane-row]").first().click();
    await expect(page.locator("[data-doc=automation-editor]")).toBeVisible();
    await expect(page.locator("[class*=paneLabel]").first()).toContainText(
      "Automation · Nebula · Time Factor",
    );

    // The baked ramp is one curve region with two nodes -> two dots.
    expect(await laneState()).toEqual([{ type: "curve", nodes: 2 }]);
    await expect(page.locator("[data-doc=keyframe]")).toHaveCount(2);

    // Double-click mid-span: a node lands there.
    const area = (await page.locator("[data-doc=editor-area]").boundingBox())!;
    await page.mouse.dblclick(
      area.x + area.width * 0.5,
      area.y + area.height * 0.5,
    );
    await expect(page.locator("[data-doc=keyframe]")).toHaveCount(3);
    expect(await laneState()).toEqual([{ type: "curve", nodes: 3 }]);

    // Right-click ON the curve inside the first span (nodes are now
    // (0,0)(30,0.5)(60,1), so at x=25% the ramp sits at value 0.25 ->
    // 75% down): retype the span to a Wave.
    await page.mouse.click(
      area.x + area.width * 0.25,
      area.y + area.height * 0.75,
      { button: "right" },
    );
    await expect(page.locator("[data-doc=retype-menu]")).toBeVisible();
    await page.getByRole("button", { name: "Wave", exact: true }).click();
    const types = (await laneState()).map((region: any) => region.type);
    expect(types).toContain("periodic");

    // Click the wave's span ON its curve: at the span's center a whole
    // number of cycles has elapsed, so the value equals the wave's
    // offset; aim the click there.
    const waveSpanIndex = types.indexOf("periodic");
    const waveOffset = await page.evaluate(
      (index) =>
        (window as any).__editorStore.layers[0].getAllBlocks()[0]
          .parameterVariations.u_timeFactor[index].offset,
      waveSpanIndex,
    );
    const waveBoxForClick = (await page
      .locator("[data-doc=span-hit]")
      .nth(waveSpanIndex)
      .boundingBox())!;
    await page.mouse.click(
      waveBoxForClick.x + waveBoxForClick.width / 2,
      area.y +
        Math.min(area.height - 5, Math.max(5, (1 - waveOffset) * area.height)),
    );
    await expect(page.locator("[data-doc=segment-inspector]")).toBeVisible();
    await expect(page.locator("[data-doc=segment-inspector]")).toContainText(
      "Frequency",
    );

    // Double-click inside the wave: it splits into two periodics.
    const before = (await laneState()).filter(
      (region: any) => region.type === "periodic",
    ).length;
    const waveSpan = page.locator("[data-doc=span-hit]").nth(waveSpanIndex);
    const waveBox = (await waveSpan.boundingBox())!;
    await page.mouse.dblclick(
      waveBox.x + waveBox.width / 2,
      area.y + area.height * 0.5,
    );
    const after = (await laneState()).filter(
      (region: any) => region.type === "periodic",
    ).length;
    expect(after).toBe(before + 1);

    // Escape peels: selection first, then the editor closes.
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-doc=segment-inspector]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-doc=automation-editor]")).toHaveCount(0);
  });

  test("editor: node value entry via right-click; snap menu on empty area", async ({
    page,
  }) => {
    await loadFixture(page);
    await page.locator("[data-doc=lane-row]").first().click();
    await expect(page.locator("[data-doc=automation-editor]")).toBeVisible();

    // Right-click a node: type an exact value, Enter commits.
    await page
      .locator("[data-doc=keyframe]")
      .first()
      .click({ button: "right" });
    const input = page.locator("[data-doc=keyframe-value]");
    await expect(input).toBeVisible();
    await input.fill("0.62");
    await input.press("Enter");
    const firstNodeValue = await page.evaluate(() => {
      const block = (window as any).__editorStore.layers[0].getAllBlocks()[0];
      return block.parameterVariations.u_timeFactor[0].nodes[0].value;
    });
    expect(firstNodeValue).toBeCloseTo(0.62, 6);

    // Right-click empty area: the snap menu with Off active (grid and
    // transients disabled without a song).
    const area = (await page.locator("[data-doc=editor-area]").boundingBox())!;
    await page.mouse.click(area.x + area.width * 0.5, area.y + 10, {
      button: "right",
    });
    const menu = page.locator("[data-doc=snap-menu]");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: "Off" })).toHaveClass(
      /contextMenuItemActive/,
    );
    await expect(menu.getByRole("button", { name: "BPM Grid" })).toBeDisabled();
  });

  test("right-click a param arms its lane and opens the editor", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Warp" })
      .first()
      .click({ button: "right" });
    await page.getByRole("button", { name: "Add Automation Lane" }).click();
    // The editor opens on the promoted lane: a lone constant curve at
    // the manual value.
    await expect(page.locator("[data-doc=automation-editor]")).toBeVisible();
    await expect(page.locator("[class*=paneLabel]").first()).toContainText(
      "Warp",
    );
    const lane = await page.evaluate(() => {
      const block = (window as any).__editorStore.layers[0].getAllBlocks()[0];
      return {
        regions: block.parameterVariations.u_warp.map((r: any) => r.type),
        armed: [...block.lanedParams],
      };
    });
    expect(lane.regions).toEqual(["curve"]);
    expect(lane.armed).toContain("u_warp");
    // Promoted: the lane row shows even though it is constant.
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-lane-key$="/u_warp"]')).toHaveCount(1);
  });

  test("backdrop toggles: teardrop and waveform buttons", async ({ page }) => {
    await loadFixture(page);
    await page.locator("[data-doc=lane-row]").first().click();
    const editor = page.locator("[data-doc=automation-editor]");
    await expect(editor).toBeVisible();
    // Canopy defaults on (see-through class present); toggling removes.
    await expect(editor).toHaveClass(/SeeThrough/);
    await page.locator("[data-doc=backdrop-canopy]").click();
    await expect(editor).not.toHaveClass(/SeeThrough/);
    // The waveform toggle mounts its canvas.
    await page.locator("[data-doc=backdrop-waveform]").click();
    await expect(page.locator("[class*=editorWaveformCanvas]")).toHaveCount(1);
  });

  test("clipboard: select, copy, bridge-delete, paste at cursor", async ({
    page,
  }) => {
    await loadFixture(page);
    await page.locator("[data-doc=lane-row]").first().click();
    await expect(page.locator("[data-doc=automation-editor]")).toBeVisible();
    const area = (await page.locator("[data-doc=editor-area]").boundingBox())!;
    const laneState = () =>
      page.evaluate(() => {
        const regions = (
          window as any
        ).__editorStore.layers[0].getAllBlocks()[0].parameterVariations
          .u_timeFactor;
        return {
          total: regions.reduce((s: number, r: any) => s + r.duration, 0),
          nodes: regions.reduce(
            (s: number, r: any) => s + (r.nodes?.length ?? 0),
            0,
          ),
        };
      });

    // Drag a selection across [25%, 50%] near the top (far from the
    // rising ramp there).
    await page.mouse.move(area.x + area.width * 0.25, area.y + 20);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * 0.5, area.y + 20, {
      steps: 6,
    });
    await page.mouse.up();
    await expect(page.locator("[data-doc=time-selection]")).toBeVisible();

    // Copy, then bridge-delete: the lane total is conserved and the
    // bridge merged into the surrounding curves.
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    const before = await laneState();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.locator("[data-doc=time-selection]")).toHaveCount(0);
    const bridged = await laneState();
    expect(bridged.total).toBeCloseTo(before.total, 3);

    // Place the cursor at 75% (open space below the curve there) and
    // paste: the clip overwrites at the cursor, total still conserved.
    await page.mouse.click(
      area.x + area.width * 0.75,
      area.y + area.height - 15,
    );
    await expect(page.locator("[data-doc=edit-cursor]")).toBeVisible();
    await page.keyboard.press("Control+v");
    const pasted = await laneState();
    expect(pasted.total).toBeCloseTo(before.total, 3);
    expect(pasted.nodes).toBeGreaterThan(bridged.nodes);
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
