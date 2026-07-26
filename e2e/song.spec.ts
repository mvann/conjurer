import { expect, test } from "@playwright/test";
import { gotoEditorClean, loadSeededSong, seededSongItem } from "./helpers";

test.describe("song, timeline, transport", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("song library lists the seeded song; upload form validates", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Add Song" }).click();
    await expect(seededSongItem(page)).toBeVisible();

    await page.getByRole("button", { name: "Upload Song" }).click();
    await expect(page.locator("aside", { hasText: "Upload Song" })).toHaveClass(
      /songsPanelWide/,
    );
    await expect(
      page.getByRole("button", { name: "Upload", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("Back to song list").click();
    await expect(
      page.locator("aside", { hasText: "Upload Song" }),
    ).not.toHaveClass(/songsPanelWide/);
  });

  test("loading a song: waveform, transport, BPM, time label", async ({
    page,
  }) => {
    await loadSeededSong(page);
    await expect(page.locator("[class*=bpmLabel]")).toContainText("BPM", {
      timeout: 30_000,
    });
    await expect(page.locator("[class*=timeLabel]")).toContainText("0:00");

    // Spacebar starts playback, spacebar stops it.
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Pause", { exact: true })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Play", { exact: true })).toBeVisible();
  });

  test("timeline scrubbing moves the playhead without seek storms", async ({
    page,
  }) => {
    await loadSeededSong(page);
    const canvas = page.locator("canvas[class*=waveform]");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    const label = await page.locator("[class*=timeLabel]").textContent();
    expect(label).not.toBe("0:00.0");
  });

  test("the viewport never follows the playhead during playback", async ({
    page,
  }) => {
    await loadSeededSong(page);
    const minimap = page.locator("[class*=minimapCanvas]");
    const box = (await minimap.boundingBox())!;

    const readViewport = () =>
      page.evaluate(
        () =>
          (window as unknown as Record<string, { left: number; width: number }>)
            .__editorTimeViewport,
      );

    // Zoom in so the view covers a fraction of the song. Retried whole:
    // the minimap can swallow a drag while the waveform is still laying
    // out, and a repeated drag just zooms further.
    await expect
      .poll(async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + 120, {
          steps: 6,
        });
        await page.mouse.up();
        return (await readViewport()).width;
      })
      .toBeLessThan(0.9);

    // Start playback (playhead near 0, inside the view), then pan the
    // viewfinder far to the right and let go. The view must stay where it
    // was put — not snap back to the playhead.
    await page.keyboard.press("Space");
    await page.waitForTimeout(300);
    const viewport = await readViewport();
    const grabX = box.x + (viewport.left + viewport.width / 2) * box.width;
    await page.mouse.move(grabX, box.y + box.height / 2);
    await page.mouse.down();
    // Pan far enough to leave the playhead behind, but keep headroom on
    // the right so the later page-flip isn't clamped at the song's end.
    await page.mouse.move(
      grabX + (0.35 - viewport.left) * box.width,
      box.y + box.height / 2,
      { steps: 6 },
    );
    await page.mouse.up();
    const leftAfterPan = (await readViewport()).left;
    expect(leftAfterPan).toBeGreaterThan(0.15);
    expect(leftAfterPan).toBeLessThan(0.5);
    await page.waitForTimeout(1_200);
    const leftLater = (await readViewport()).left;
    expect(Math.abs(leftLater - leftAfterPan)).toBeLessThan(0.02);

    // Even when the playhead exits the view mid-playback (seek near the
    // visible window's right edge and let it run out), the viewport does
    // not move: the minimap is fully independent of the playhead.
    const waveform = page.locator("canvas[class*=waveform]");
    const waveBox = (await waveform.boundingBox())!;
    await page.mouse.click(
      waveBox.x + waveBox.width * 0.97,
      waveBox.y + waveBox.height / 2,
    );
    await page.waitForTimeout(4_000);
    expect(Math.abs((await readViewport()).left - leftAfterPan)).toBeLessThan(
      0.001,
    );
    await page.keyboard.press("Space");
  });

  test("minimap zooms and pans; dragging stays stable during playback", async ({
    page,
  }) => {
    await loadSeededSong(page);
    const minimap = page.locator("[class*=minimapCanvas]");
    const box = (await minimap.boundingBox())!;

    // Drag the viewfinder down to zoom in. Retried whole: the minimap can
    // swallow a drag while the waveform is still laying out, and a
    // repeated drag just zooms further.
    const readViewport = () =>
      page.evaluate(
        () =>
          (window as unknown as Record<string, { left: number; width: number }>)
            .__editorTimeViewport,
      );
    await expect
      .poll(async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + 120, {
          steps: 6,
        });
        await page.mouse.up();
        return (await readViewport()).width;
      })
      .toBeLessThan(0.9);

    // Grab the viewfinder, then start playback with the spacebar while
    // holding the drag: the playhead (far to the left) must never move
    // the viewport out from under the drag.
    const viewport = await readViewport();
    const grabX = box.x + (viewport.left + viewport.width / 2) * box.width;
    await page.mouse.move(grabX, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(grabX + box.width * 0.55, box.y + box.height / 2, {
      steps: 6,
    });
    const readLeft = () =>
      page.evaluate(
        () =>
          (window as unknown as Record<string, { left: number }>)
            .__editorTimeViewport.left,
      );
    const leftAfterDrag = await readLeft();
    expect(leftAfterDrag).toBeGreaterThan(0.3);
    await page.keyboard.press("Space");
    // Hold through a second of playback; the playhead is far to the left,
    // so the old bug would yank the viewport back toward 0.
    await page.waitForTimeout(1_000);
    const leftDuringHold = await readLeft();
    await page.mouse.up();
    await page.keyboard.press("Space");
    expect(Math.abs(leftDuringHold - leftAfterDrag)).toBeLessThan(0.02);
  });

  test("removing the song returns to Add Song and disables transport", async ({
    page,
  }) => {
    await loadSeededSong(page);
    await page.getByLabel("Remove song").click();
    await expect(page.getByRole("button", { name: "Add Song" })).toBeVisible();
    await expect(page.getByLabel("Play", { exact: true })).toBeDisabled();
  });
});
