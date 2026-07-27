import { expect, test } from "@playwright/test";
import {
  addLaneOnParam,
  closePanel,
  gotoEditorClean,
  insertPattern,
  loadSeededSong,
  openPatternPanel,
  scaleTicks,
} from "./helpers";

const openTimeFactorLane = async (page: any) => {
  await openPatternPanel(page);
  await insertPattern(page, "Nebula");
  await addLaneOnParam(page, "Time Factor");
  await closePanel(page);
  await page.locator("[class*=laneRow]").first().click();
  await expect(page.locator("[class*=automationEditor__]")).toBeVisible();
};

// Disc's Radius declares no min or max: the lane that exercises the
// self-managing zero-centered range.
const openRadiusLane = async (page: any) => {
  await openPatternPanel(page);
  await insertPattern(page, "Disc");
  await addLaneOnParam(page, "Radius");
  await closePanel(page);
  await page.locator("[class*=laneRow]").first().click();
  await expect(page.locator("[class*=automationEditor__]")).toBeVisible();
};

test.describe("automation editor", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("lane click expands over the canopy; close via X, Escape, re-click", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    await expect(page.locator("[class*=paneLabel]").first()).toContainText(
      "Automation",
    );
    await page.getByLabel("Close automation editor").click();
    await expect(page.locator("[class*=automationEditor__]")).toHaveCount(0);

    await page.locator("[class*=laneRow]").first().click();
    await page.keyboard.press("Escape");
    await expect(page.locator("[class*=automationEditor__]")).toHaveCount(0);
  });

  test("no keyframes: the curve is a line at the manual value; bounds pin the range", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    await expect(
      page.locator("[class*=automationEditor__] [class*=laneValueLine]"),
    ).toBeVisible();
    await expect(page.locator("[class*=curveSvg]")).toHaveCount(0);
    // Time Factor declares 0..1: the view is exactly that range.
    const ticks = await scaleTicks(page);
    expect(ticks).toContain("0.00");
    expect(ticks).toContain("1.00");
    expect(ticks.some((tick: string) => parseFloat(tick) < 0)).toBe(false);
  });

  test("a bounded param pins the range and clamps the line drag", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const handle = page.locator("[class*=valueLineHandle]");
    const box = (await handle.boundingBox())!;
    // Drag far past the top (well over a full span of travel): the value
    // pins at the declared max and the view never changes.
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y - 800, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const ticks = await scaleTicks(page);
    expect(ticks).toContain("1.00");
    expect(ticks.some((tick: string) => parseFloat(tick) > 1)).toBe(false);
    await openPatternPanel(page);
    await expect(
      page
        .locator("[data-doc=param-row]")
        .filter({ hasText: "Time Factor" })
        .locator("[class*=paramScrub]"),
    ).toHaveText("1");
  });

  test("an unbounded param's line drags freely and refits the range", async ({
    page,
  }) => {
    await openRadiusLane(page);
    const handle = page.locator("[class*=valueLineHandle]");
    const box = (await handle.boundingBox())!;
    // Radius (0.5, no bounds) starts in -1..1; dragging far above refits
    // the range on release.
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y - 320, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => scaleTicks(page), { timeout: 5_000 })
      .toContain("2");
  });

  test("double click creates keyframes; first is a constant", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    await page.mouse.dblclick(
      box.x + box.width * 0.3,
      box.y + box.height * 0.5,
    );
    await expect(page.locator("[class*=keyframeDot]")).toHaveCount(1);
    // A constant curve is a perfectly horizontal path (zero-height bounding
    // box, so visibility checks do not apply): assert its shape instead.
    const constantPath = page.locator(
      "[class*=automationEditor__] [class*=curvePath]",
    );
    await expect(constantPath).toHaveCount(1);
    const d = (await constantPath.getAttribute("d"))!;
    const ys = [...d.matchAll(/[ML] [-\d.]+ ([-\d.]+)/g)].map((m) =>
      parseFloat(m[1]),
    );
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.01);
    // The separate manual value line is gone once a keyframe exists.
    await expect(
      page.locator("[class*=automationEditor__] [class*=laneValueLine]"),
    ).toHaveCount(0);

    await page.mouse.dblclick(
      box.x + box.width * 0.7,
      box.y + box.height * 0.3,
    );
    await expect(page.locator("[class*=keyframeDot]")).toHaveCount(2);
    await expect(page.locator("[class*=curveHit]")).toHaveCount(1);

    // The mirror: double clicking a keyframe deletes it.
    const dot = page.locator("[class*=keyframeDot]").first();
    const dotBox = (await dot.boundingBox())!;
    await page.mouse.dblclick(dotBox.x + 4, dotBox.y + 4);
    await expect(page.locator("[class*=keyframeDot]")).toHaveCount(1);
  });

  test("right-clicking a keyframe types its value; Enter commits, Escape cancels", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width * 0.4, box.y + box.height / 2);
    const dot = page.locator("[class*=keyframeDot]").first();
    await expect(dot).toBeVisible();

    const laneValue = () =>
      page.evaluate(() => {
        const entries = (
          window as unknown as Record<
            string,
            { automation: Record<string, { keyframes: { value: number }[] }> }[]
          >
        ).__editorEntries;
        return Object.values(entries[0].automation)[0].keyframes[0].value;
      });

    // Type an exact value; it commits on Enter.
    await dot.click({ button: "right" });
    const input = page.locator("[data-doc=keyframe-value]");
    await expect(input).toBeVisible();
    await input.fill("0.62");
    await input.press("Enter");
    await expect(input).toHaveCount(0);
    expect(await laneValue()).toBeCloseTo(0.62, 9);

    // Out-of-range values clamp to the parameter's bounds (0..1 here).
    await dot.click({ button: "right" });
    await input.fill("5");
    await input.press("Enter");
    expect(await laneValue()).toBe(1);

    // Escape cancels without committing.
    await dot.click({ button: "right" });
    await input.fill("0.11");
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    expect(await laneValue()).toBe(1);
  });

  test("keyframes drag to the song start and stack at the same time", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    const dots = page.locator("[class*=keyframeDot]");
    await page.mouse.dblclick(box.x + box.width * 0.4, box.y + box.height / 2);
    await page.mouse.dblclick(box.x + box.width * 0.7, box.y + box.height / 2);
    await expect(dots).toHaveCount(2);

    // The current lane's keyframe times, from the latest history snapshot
    // (captured 400ms after an edit settles).
    const keyframeTimes = async () => {
      await page.waitForTimeout(600);
      return page.evaluate(() => {
        const history = (
          window as unknown as Record<
            string,
            { stack: unknown[]; index: number }
          >
        ).__editorHistory;
        const times: number[][] = [];
        const walk = (node: unknown) => {
          if (!node || typeof node !== "object") return;
          const record = node as Record<string, unknown>;
          if (Array.isArray(record.keyframes))
            times.push(
              (record.keyframes as { time: number }[]).map(
                (keyframe) => keyframe.time,
              ),
            );
          for (const key of Object.keys(record)) walk(record[key]);
        };
        walk(history.stack[history.index]);
        return times[0] ?? [];
      });
    };

    // Drag the first keyframe far past the left edge: it pins at time 0
    // exactly (the song's start), not an epsilon short of it.
    const first = (await dots.nth(0).boundingBox())!;
    await page.mouse.move(first.x + 5, first.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x - 200, first.y + 5, { steps: 5 });
    await page.mouse.up();
    let times = await keyframeTimes();
    expect(times[0]).toBe(0);

    // Drag the second keyframe onto the first: they stack at the exact
    // same time (a vertical step) with no minimum gap.
    const second = (await dots.nth(1).boundingBox())!;
    await page.mouse.move(second.x + 5, second.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x - 200, second.y + 5, { steps: 5 });
    await page.mouse.up();
    times = await keyframeTimes();
    expect(times).toEqual([0, 0]);
    const firstAfter = (await dots.nth(0).boundingBox())!;
    const secondAfter = (await dots.nth(1).boundingBox())!;
    expect(Math.abs(firstAfter.x - secondAfter.x)).toBeLessThan(1);
  });

  test("undo steps one edit at a time and keeps the editor open", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    const dots = page.locator("[class*=keyframeDot]");

    // Three keyframes, each far enough apart to be its own history step.
    for (const x of [0.2, 0.5, 0.8]) {
      await page.mouse.dblclick(
        box.x + box.width * x,
        box.y + box.height * 0.5,
      );
      await page.waitForTimeout(600);
    }
    await expect(dots).toHaveCount(3);

    // Each undo removes exactly one, and the editor stays open (entry
    // identity survives the restore).
    await page.keyboard.press("Control+z");
    await expect(dots).toHaveCount(2);
    await expect(page.locator("[class*=automationEditor__]")).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(dots).toHaveCount(1);

    // An edit made immediately after an undo is captured normally.
    await page.mouse.dblclick(
      box.x + box.width * 0.65,
      box.y + box.height * 0.4,
    );
    await expect(dots).toHaveCount(2);
    await page.waitForTimeout(600);
    await page.keyboard.press("Control+z");
    await expect(dots).toHaveCount(1);
    await page.keyboard.press("Control+Shift+z");
    await expect(dots).toHaveCount(2);
  });

  test("segments bend by dragging; keyframes drag to move", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    await page.mouse.dblclick(
      box.x + box.width * 0.2,
      box.y + box.height * 0.7,
    );
    await page.mouse.dblclick(
      box.x + box.width * 0.8,
      box.y + box.height * 0.3,
    );

    const editorPath = page.locator(
      "[class*=automationEditor__] [class*=curvePath]",
    );
    const pathBefore = await editorPath.getAttribute("d");
    // Bend the segment upward.
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35, {
      steps: 4,
    });
    await page.mouse.up();
    await expect(editorPath).not.toHaveAttribute("d", pathBefore!);

    // Drag a keyframe: its dot moves.
    const dot = page.locator("[class*=keyframeDot]").first();
    const dotLeftBefore = await dot.evaluate(
      (el) => (el as HTMLElement).style.left,
    );
    const dotBox = (await dot.boundingBox())!;
    await page.mouse.move(dotBox.x + 4, dotBox.y + 4);
    await page.mouse.down();
    await page.mouse.move(dotBox.x + 120, dotBox.y - 40, { steps: 4 });
    await page.mouse.up();
    const dotLeftAfter = await dot.evaluate(
      (el) => (el as HTMLElement).style.left,
    );
    expect(dotLeftAfter).not.toBe(dotLeftBefore);
  });

  test("auto-range reacts to out-of-range keyframes and keeps margins", async ({
    page,
  }) => {
    await openRadiusLane(page);
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    const before = await scaleTicks(page);
    // A keyframe at the very top edge forces a range step.
    await page.mouse.dblclick(box.x + box.width * 0.5, box.y + 4);
    await expect
      .poll(async () => JSON.stringify(await scaleTicks(page)), {
        timeout: 5_000,
      })
      .not.toBe(JSON.stringify(before));
  });

  test("editor times line up with the lanes; the song start line marks zero", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    // Fully zoomed out, time zero sits at the lane area's left edge: the
    // song start line in the editor must sit exactly there, even though
    // the editor's drawing area extends further left.
    const editorBox = (await page
      .locator("[class*=editorLineArea]")
      .boundingBox())!;
    const laneBox = (await page.locator("[class*=laneArea]").boundingBox())!;
    expect(editorBox.x).toBeLessThan(laneBox.x - 100);
    const startBox = (await page
      .locator("[class*=songStartLine]")
      .boundingBox())!;
    expect(Math.abs(startBox.x + 1 - laneBox.x)).toBeLessThan(1.5);
    expect(
      Math.abs(editorBox.x + editorBox.width - (laneBox.x + laneBox.width)),
    ).toBeLessThan(1);

    // Alignment must survive a CONTAINER resize with no window resize:
    // opening the pattern dock pushes the editor narrower while it is
    // open (regression: the width refreshed only on window resize, so
    // the mapping went stale and everything sat shifted).
    await openPatternPanel(page);
    await page.waitForTimeout(500);
    const laneAfter = (await page.locator("[class*=laneArea]").boundingBox())!;
    const startAfter = (await page
      .locator("[class*=songStartLine]")
      .boundingBox())!;
    expect(Math.abs(startAfter.x + 1 - laneAfter.x)).toBeLessThan(1.5);
  });

  test("dashed guides sit at every multiple of the magnitude step", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    // Time Factor's 0..1 range with 10% margins: a guide at every
    // sixteenth (0.0625) from 0 through 1 inclusive: 17 lines.
    await expect(page.locator("[class*=magnitudeLine]")).toHaveCount(17);
  });

  test("value scale ticks are rounded values", async ({ page }) => {
    await openTimeFactorLane(page);
    const ticks = await scaleTicks(page);
    expect(ticks.length).toBeGreaterThan(2);
    for (const tick of ticks) expect(Number.isNaN(Number(tick))).toBe(false);
  });
});

// Two keyframes with distinct values, leaving one segment whose midpoint
// sits at the vertical center of the area.
const makeOneSegment = async (page: any) => {
  const area = page.locator("[class*=editorLineArea]");
  const box = (await area.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * 0.2, box.y + box.height * 0.7);
  await page.mouse.dblclick(box.x + box.width * 0.8, box.y + box.height * 0.3);
  await expect(page.locator("[class*=keyframeDot]")).toHaveCount(2);
  return box;
};

const pathCommands = async (page: any) => {
  const d = (await page
    .locator("[class*=automationEditor__] [class*=curvePath]")
    .getAttribute("d"))!;
  return [...d.matchAll(/[ML] ([-\d.]+) ([-\d.]+)/g)].map((m) => ({
    x: parseFloat(m[1]),
    y: parseFloat(m[2]),
  }));
};

test.describe("segment types", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("audio segment follows the song's loudness envelope", async ({
    page,
  }) => {
    await loadSeededSong(page);
    await openTimeFactorLane(page);
    const box = await makeOneSegment(page);
    const before = await pathCommands(page);

    // Select the segment while it still sits at the click point, then
    // convert through the inspector's type pills (selection survives the
    // conversion; the displaced curve would be fiddly to re-click).
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const inspector = page.locator("[data-doc=segment-inspector]");
    await expect(inspector).toBeVisible();
    await inspector.getByRole("button", { name: "Audio" }).click();

    // The path now traces the envelope: far denser than any shape.
    await expect
      .poll(async () => (await pathCommands(page)).length)
      .toBeGreaterThan(before.length + 100);

    // The inspector edits the audio segment's Amount and Smoothing.
    await expect(inspector).toContainText("Amount");
    await expect(inspector).toContainText("Smoothing");

    // The right-click menu offers Audio too, marked once chosen.
    await expect(
      page.locator("[data-doc=segment-inspector]").getByRole("button", {
        name: "Audio",
      }),
    ).toHaveClass(/pillActive/);
  });

  test("right-click menu lists the types; Wave gets a kind selector", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const box = await makeOneSegment(page);
    const before = await pathCommands(page);

    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5, {
      button: "right",
    });
    const menu = page.locator("[data-doc=segment-menu]");
    await expect(menu).toBeVisible();
    for (const label of ["Curve", "Flat", "Linear", "Wave", "Easing"])
      await expect(menu.getByRole("button", { name: label })).toBeVisible();
    // The current type is marked.
    await expect(menu.getByRole("button", { name: "Curve" })).toHaveClass(
      /contextMenuItemActive/,
    );

    await menu.getByRole("button", { name: "Wave" }).click();
    await expect(menu).toHaveCount(0);

    // The inspector opens with the wave's parameters.
    const inspector = page.locator("[data-doc=segment-inspector]");
    await expect(inspector).toBeVisible();
    for (const label of ["Sine", "Square", "Triangle"])
      await expect(
        inspector.getByRole("button", { name: label }),
      ).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Sine" })).toHaveClass(
      /pillActive/,
    );
    await expect(inspector.getByText("Amplitude")).toBeVisible();
    await expect(inspector.getByText("Cycles")).toBeVisible();
    await expect(inspector.getByText("Phase")).toBeVisible();

    // A wave path oscillates: far more samples than the straight line.
    const after = await pathCommands(page);
    expect(after.length).toBeGreaterThan(before.length + 20);

    // Switching the kind re-renders the curve.
    await inspector.getByRole("button", { name: "Triangle" }).click();
    await expect(
      inspector.getByRole("button", { name: "Triangle" }),
    ).toHaveClass(/pillActive/);
  });

  test("flat renders as a hold-then-step", async ({ page }) => {
    await openTimeFactorLane(page);
    const box = await makeOneSegment(page);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5, {
      button: "right",
    });
    await page
      .locator("[data-doc=segment-menu]")
      .getByRole("button", { name: "Flat" })
      .click();

    // Left extension, hold at the first value, step down at the second
    // keyframe, right extension. Two y plateaus with one step between.
    const commands = await pathCommands(page);
    expect(commands.length).toBe(6);
    const ys = commands.map((c) => c.y);
    for (const y of ys.slice(0, 3))
      expect(Math.abs(y - ys[0])).toBeLessThan(0.01);
    for (const y of ys.slice(3)) expect(Math.abs(y - ys[5])).toBeLessThan(0.01);
    expect(Math.abs(ys[2] - ys[3])).toBeGreaterThan(5);
  });

  test("a wave with fractional cycles still connects to its end keyframe", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const box = await makeOneSegment(page);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5, {
      button: "right",
    });
    await page
      .locator("[data-doc=segment-menu]")
      .getByRole("button", { name: "Wave" })
      .click();

    // A quarter cycle extra ends the sine at full amplitude, away from
    // the keyframe; the drawn path must still route through it.
    const inspector = page.locator("[data-doc=segment-inspector]");
    await inspector
      .locator("[class*=inspectorRow]")
      .filter({ hasText: "Cycles" })
      .locator("[class*=paramScrub]")
      .click();
    const input = page.locator(
      "[data-doc=segment-inspector] [class*=paramInput]",
    );
    await input.fill("4.25");
    await input.press("Enter");

    const dot = page.locator("[class*=keyframeDot]").nth(1);
    const left = parseFloat(
      await dot.evaluate((el) => (el as HTMLElement).style.left),
    );
    const top = parseFloat(
      await dot.evaluate((el) => (el as HTMLElement).style.top),
    );
    const commands = await pathCommands(page);
    const throughKeyframe = commands.some(
      (c) => Math.abs(c.x - left) < 0.6 && Math.abs(c.y - top) < 0.6,
    );
    expect(throughKeyframe).toBe(true);
    // The right extension leaves at the keyframe's height, not the wave's
    // stray endpoint.
    expect(Math.abs(commands[commands.length - 1].y - top)).toBeLessThan(0.6);
  });

  test("color lanes hold whole values per period, edited in the inspector", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Disc");
    await addLaneOnParam(page, "Color");
    await closePanel(page);
    await page.locator("[class*=laneRow]").first().click();
    await expect(page.locator("[class*=automationEditor__]")).toBeVisible();

    // No value scale, no numeric chrome.
    await expect(page.locator("[class*=valueTickLabel]")).toHaveCount(0);

    // Two keyframes make two periods, drawn as strips.
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    await page.mouse.dblclick(
      box.x + box.width * 0.3,
      box.y + box.height * 0.5,
    );
    await page.mouse.dblclick(
      box.x + box.width * 0.7,
      box.y + box.height * 0.5,
    );
    await expect(page.locator("[class*=keyframeDot]")).toHaveCount(2);
    // Keyframes are boundaries: two keyframes make three periods, each
    // marked by a small bordered swatch above the line.
    await expect(page.locator("[data-doc=value-swatch]")).toHaveCount(3);

    // Clicking a swatch opens the color editor; a typed hex recolors it.
    const swatches = page.locator("[data-doc=value-swatch]");
    await swatches.nth(2).click();
    const inspector = page.locator("[data-doc=segment-inspector]");
    await expect(inspector.locator("[data-doc=color-editor]")).toBeVisible();
    const before = await swatches
      .nth(2)
      .evaluate((swatch) => (swatch as HTMLElement).style.background);
    await inspector.locator("input").fill("#ff0000");
    await expect
      .poll(async () =>
        swatches
          .nth(2)
          .evaluate((swatch) => (swatch as HTMLElement).style.background),
      )
      .not.toBe(before);

    // The gold time dot stays hidden on value lanes.
    await expect(page.locator("[data-doc=time-dot]")).toHaveCSS("opacity", "0");
  });

  test("boolean params get On/Off automation with flat steps only", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Gradient Circles");
    await addLaneOnParam(page, "Clockwise");
    await closePanel(page);
    await page.locator("[class*=laneRow]").first().click();
    await expect(page.locator("[class*=automationEditor__]")).toBeVisible();

    // The scale reads On and Off instead of numbers.
    const ticks = await scaleTicks(page);
    expect(ticks).toContain("On");
    expect(ticks).toContain("Off");

    // Keyframes snap to the two states wherever the clicks land.
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    await page.mouse.dblclick(
      box.x + box.width * 0.25,
      box.y + box.height * 0.3,
    );
    await page.mouse.dblclick(
      box.x + box.width * 0.75,
      box.y + box.height * 0.8,
    );
    // On sits at 10% and Off at 90%: the bounds keep a margin from the
    // view's edges.
    const tops = await page
      .locator("[class*=keyframeDot]")
      .evaluateAll((dots) => dots.map((dot) => (dot as HTMLElement).style.top));
    expect(tops.sort()).toEqual(["10%", "90%"]);

    // Steps only: no segment hit strokes to bend or retype, and the
    // drawn path is a hold followed by a vertical step.
    await expect(page.locator("[class*=curveHit]")).toHaveCount(0);
    const commands = await pathCommands(page);
    const ys = commands.map((command) => command.y);
    for (const y of ys)
      expect(Math.abs(y - 10) < 0.01 || Math.abs(y - 90) < 0.01).toBe(true);

    // Dragging a keyframe flips it between the two states.
    const onDot = page.locator("[class*=keyframeDot]").first();
    const dotBox = (await onDot.boundingBox())!;
    await page.mouse.move(dotBox.x + 4, dotBox.y + 4);
    await page.mouse.down();
    await page.mouse.move(dotBox.x + 4, dotBox.y + box.height * 0.6, {
      steps: 5,
    });
    await page.mouse.up();
    const topsAfter = await page
      .locator("[class*=keyframeDot]")
      .evaluateAll((dots) => dots.map((dot) => (dot as HTMLElement).style.top));
    expect(topsAfter).toEqual(["90%", "90%"]);
  });

  test("an active visibility curve drives the eye during playback", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    await page.getByLabel("Hide pattern").click({ button: "right" });
    await page.getByRole("button", { name: "Add Automation Lane" }).click();
    await expect(page.getByLabel("Hide pattern")).toHaveClass(/eyeBarActive/);
    await closePanel(page);

    // Visibility is a boolean lane: on until halfway, off after.
    await page.locator("[class*=laneRow]").first().click();
    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    await page.mouse.dblclick(
      box.x + box.width * 0.2,
      box.y + box.height * 0.3,
    );
    await page.mouse.dblclick(
      box.x + box.width * 0.5,
      box.y + box.height * 0.8,
    );
    await page.getByLabel("Close automation editor").click();

    // Seek into the off region (retrying: the first seek after load can
    // be dropped): the eye follows the curve.
    await loadSeededSong(page);
    const tl = page.locator("canvas[class*=waveform]");
    const tlBox = (await tl.boundingBox())!;
    const timeLabel = page.locator("[data-doc=current-time]");
    await expect
      .poll(
        async () => {
          await page.mouse.click(tlBox.x + tlBox.width * 0.8, tlBox.y + 10);
          await page.waitForTimeout(300);
          return timeLabel.textContent();
        },
        { timeout: 10_000 },
      )
      .not.toMatch(/^0:00/);
    await openPatternPanel(page);
    await expect(page.getByLabel("Show pattern")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("time selection copies, deletes, and pastes at the clicked playhead", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    await makeOneSegment(page);
    await page.getByLabel("Close automation editor").click();
    await loadSeededSong(page);
    await page.locator("[class*=laneRow]").first().click();
    await expect(page.locator("[class*=automationEditor__]")).toBeVisible();

    const area = page.locator("[class*=editorLineArea]");
    const box = (await area.boundingBox())!;
    const lowY = box.y + box.height * 0.9;

    // Drag horizontally: a gold window with Copy and Delete appears.
    await page.mouse.move(box.x + box.width * 0.3, lowY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, lowY, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator("[data-doc=time-selection]")).toBeVisible();
    await page.getByRole("button", { name: "Copy" }).click();

    // A plain click places the silver cursor and drops the selection;
    // the transport does not move. Paste appears once both the clipboard
    // and a cursor exist.
    await page.mouse.click(box.x + box.width * 0.7, lowY);
    await expect(page.locator("[data-doc=time-selection]")).toHaveCount(0);
    await expect(page.locator("[data-doc=edit-cursor]")).toBeVisible();
    await expect(page.locator("[data-doc=current-time]")).toContainText(
      "0:00.0",
    );
    await expect(page.getByRole("button", { name: "Paste" })).toBeVisible();

    // Paste lays the copied window down at the cursor: the two copied
    // boundary keyframes arrive plus the pinned keyframe where the cursor
    // bisected the segment (the second original keyframe falls inside the
    // replaced window).
    await page.getByRole("button", { name: "Paste" }).click();
    await expect(page.locator("[class*=keyframeDot]")).toHaveCount(4);

    // Select across the middle and delete: the curve changes.
    const pathBefore = await page
      .locator("[class*=automationEditor__] [class*=curvePath]")
      .getAttribute("d");
    await page.mouse.move(box.x + box.width * 0.35, lowY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, lowY, { steps: 5 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("[data-doc=time-selection]")).toHaveCount(0);
    await expect(
      page.locator("[class*=automationEditor__] [class*=curvePath]"),
    ).not.toHaveAttribute("d", pathBefore!);
  });

  test("automation drives the parameter value at the playhead", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    await makeOneSegment(page);
    await page.getByLabel("Close automation editor").click();
    await loadSeededSong(page);

    // Seek to halfway: the linear segment between the keyframes at 20%
    // and 80% crosses its midpoint value there, and the pattern editor's
    // number must show it (the curve drives the live param). Media seeks
    // right after load can be dropped, so the click retries until the
    // transport label moves off zero.
    const tl = page.locator("canvas[class*=waveform]");
    const box = (await tl.boundingBox())!;
    const timeLabel = page.locator("[data-doc=current-time]");
    await expect
      .poll(
        async () => {
          await page.mouse.click(box.x + box.width * 0.5, box.y + 10);
          await page.waitForTimeout(300);
          return timeLabel.textContent();
        },
        { timeout: 10_000 },
      )
      .not.toMatch(/^0:00/);

    await openPatternPanel(page);
    // In the pinned 0..1 view the two keyframes sit at 0.3 and 0.7, so
    // the halfway point of the linear segment is 0.5.
    const scrub = page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Time Factor" })
      .locator("[class*=paramScrub]");
    await expect
      .poll(
        async () => Math.abs(parseFloat((await scrub.textContent())!) - 0.5),
        { timeout: 5_000 },
      )
      .toBeLessThan(0.08);
  });

  test("a wave's amplitude drives the range, not just the keyframes", async ({
    page,
  }) => {
    await openRadiusLane(page);
    const box = await makeOneSegment(page);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5, {
      button: "right",
    });
    await page
      .locator("[data-doc=segment-menu]")
      .getByRole("button", { name: "Wave" })
      .click();

    // Keyframes stay within the default -1..1 view, but an amplitude of 2
    // sends the wave's peaks to about 2.4: the range must refit to hold
    // the curve itself.
    const inspector = page.locator("[data-doc=segment-inspector]");
    await inspector
      .locator("[class*=inspectorRow]")
      .filter({ hasText: "Amplitude" })
      .locator("[class*=paramScrub]")
      .click();
    const input = page.locator(
      "[data-doc=segment-inspector] [class*=paramInput]",
    );
    await input.fill("2");
    await input.press("Enter");

    await expect
      .poll(async () => scaleTicks(page), { timeout: 5_000 })
      .toContain("4");
  });

  test("editing an automated param deactivates the lane; curve edits reactivate", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const box = await makeOneSegment(page);
    await page.getByLabel("Close automation editor").click();

    // Active lane: green edge on the param row.
    await openPatternPanel(page);
    const row = page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Time Factor" });
    await expect(row).toHaveClass(/laneEdgeActive/);

    // Scrubbing the param takes over: red edge, and the lane draws the
    // curve dimmed under a dashed manual value line. Wait out the
    // panel's slide-in so the measured position is where the drag lands.
    await page.waitForTimeout(500);
    const scrub = row.locator("[class*=paramScrub]");
    const scrubBox = (await scrub.boundingBox())!;
    await page.mouse.move(scrubBox.x + 5, scrubBox.y + 5);
    await page.mouse.down();
    await page.mouse.move(scrubBox.x + 5, scrubBox.y - 40, { steps: 4 });
    await page.mouse.up();
    await expect(row).toHaveClass(/laneEdgeInactive/);
    await closePanel(page);
    await expect(page.locator("[class*=curveDimmed]")).toHaveCount(1);
    await expect(page.locator("[class*=laneValueLineDashed]")).toHaveCount(1);

    // Reopen the editor: dimmed curve plus the dashed line there too.
    await page.locator("[class*=laneRow]").first().click();
    expect(
      await page.locator("[class*=laneValueLineDashed]").count(),
    ).toBeGreaterThan(1);

    // Any curve edit reactivates: add a keyframe.
    await page.mouse.dblclick(
      box.x + box.width * 0.5,
      box.y + box.height * 0.5,
    );
    await page.getByLabel("Close automation editor").click();
    await expect(page.locator("[class*=curveDimmed]")).toHaveCount(0);
    await openPatternPanel(page);
    await expect(row).toHaveClass(/laneEdgeActive/);
  });

  test("right-click disables and re-enables; the editor offers re-enable", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    await makeOneSegment(page);
    await page.getByLabel("Close automation editor").click();

    await openPatternPanel(page);
    const row = page
      .locator("[data-doc=param-row]")
      .filter({ hasText: "Time Factor" });
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "Disable Automation" }).click();
    await expect(row).toHaveClass(/laneEdgeInactive/);

    // The menu item flips while disabled.
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "Re-enable Automation" }).click();
    await expect(row).toHaveClass(/laneEdgeActive/);

    // Disable again, then re-enable from inside the editor.
    await row.click({ button: "right" });
    await page.getByRole("button", { name: "Disable Automation" }).click();
    await closePanel(page);
    await page.locator("[class*=laneRow]").first().click();
    const reenable = page.getByRole("button", {
      name: "Re-enable automation",
    });
    await expect(reenable).toBeVisible();
    await reenable.click();
    await expect(reenable).toHaveCount(0);
    await page.getByLabel("Close automation editor").click();
    await openPatternPanel(page);
    await expect(row).toHaveClass(/laneEdgeActive/);
  });

  test("click selects with inspector; Easing has modes and families; Escape peels layers", async ({
    page,
  }) => {
    await openTimeFactorLane(page);
    const box = await makeOneSegment(page);

    // Left click selects the segment and opens the inspector on the
    // default curve type.
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const inspector = page.locator("[data-doc=segment-inspector]");
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Curve" })).toHaveClass(
      /pillActive/,
    );
    await expect(inspector.getByText("Bend")).toBeVisible();

    // Switch to easing from the inspector's type pills.
    await inspector.getByRole("button", { name: "Easing" }).click();
    await expect(inspector.getByRole("button", { name: "In Out" })).toHaveClass(
      /pillActive/,
    );
    await expect(inspector.getByRole("button", { name: "Sine" })).toHaveClass(
      /pillActive/,
    );
    await inspector.getByRole("button", { name: "Bounce" }).click();
    await expect(inspector.getByRole("button", { name: "Bounce" })).toHaveClass(
      /pillActive/,
    );

    // First Escape drops the selection; the editor stays open. The second
    // closes the editor.
    await page.keyboard.press("Escape");
    await expect(inspector).toHaveCount(0);
    await expect(page.locator("[class*=automationEditor__]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[class*=automationEditor__]")).toHaveCount(0);
  });
});
