import { expect, test } from "@playwright/test";
import {
  dismissLoginIfOpen,
  gotoEditorClean,
  insertPattern,
  openPatternPanel,
} from "./helpers";

// The draft channel: unsaved work persists per-browser and is offered
// on the next open; the experiences row (their tRPC save) is the
// document of record. Legacy Spell Crafter saves migrate into the same
// channel once.

test.describe("persistence and drafts", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("edits draft; reload offers the draft; restore recovers", async ({
    page,
  }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Nebula");
    // The debounced draft lands.
    await expect
      .poll(() =>
        page.evaluate(() => !!localStorage.getItem("spellcrafter:draft")),
      )
      .toBe(true);

    // Reload WITHOUT clearing: the prompt offers the draft.
    await page.reload();
    await expect(page.locator("[data-doc=autosave]")).toBeVisible({
      timeout: 15_000,
    });
    await dismissLoginIfOpen(page);
    await page.getByRole("button", { name: "Open Auto Save" }).click();
    await expect(page.locator("[data-doc=autosave]")).toHaveCount(0);
    const blocks = await page.evaluate(() =>
      (window as any).__editorStore.layers
        .flatMap((layer: any) => layer.getAllBlocks())
        .map((block: any) => block.pattern.name),
    );
    expect(blocks).toEqual(["Nebula"]);
  });

  test("dismissing the prompt keeps the loaded document", async ({ page }) => {
    await openPatternPanel(page);
    await insertPattern(page, "Plasma");
    await expect
      .poll(() =>
        page.evaluate(() => !!localStorage.getItem("spellcrafter:draft")),
      )
      .toBe(true);
    await page.reload();
    await expect(page.locator("[data-doc=autosave]")).toBeVisible({
      timeout: 15_000,
    });
    await dismissLoginIfOpen(page);
    await page.getByRole("button", { name: "Dismiss" }).click();
    const blockCount = await page.evaluate(
      () =>
        (window as any).__editorStore.layers.flatMap((layer: any) =>
          layer.getAllBlocks(),
        ).length,
    );
    expect(blockCount).toBe(0);
  });

  test("a legacy save migrates into the draft channel", async ({ page }) => {
    // Seed an old-format Spell Crafter save: one Nebula entry with a
    // ramp lane and a hidden Disc.
    await page.evaluate(() => {
      localStorage.setItem(
        "editorV2:untitled:autosave",
        JSON.stringify({
          savedAt: 123,
          song: null,
          laneOrder: [],
          entries: [
            {
              pattern: "Nebula",
              id: 1,
              params: { u_timeFactor: 0.5 },
              effects: [],
              visible: true,
              expanded: true,
              automatedParams: ["u_timeFactor"],
              automation: {
                u_timeFactor: {
                  keyframes: [
                    { time: 0.2, value: 0 },
                    { time: 0.8, value: 1 },
                  ],
                  segments: [{ type: "linear" }],
                },
              },
            },
            {
              pattern: "Disc",
              id: 2,
              params: {},
              effects: [],
              visible: false,
              expanded: true,
              automatedParams: [],
              automation: {},
            },
          ],
        }),
      );
    });
    await page.reload();
    await expect(page.locator("[data-doc=autosave]")).toBeVisible({
      timeout: 15_000,
    });
    await dismissLoginIfOpen(page);
    await page.getByRole("button", { name: "Open Auto Save" }).click();

    const state = await page.evaluate(() => {
      const blocks = (window as any).__editorStore.layers.flatMap(
        (layer: any) => layer.getAllBlocks(),
      );
      return blocks.map((block: any) => ({
        pattern: block.pattern.name,
        laneTypes: Object.keys(block.parameterVariations),
        opacity: block.parameterVariations.u_opacity?.length ?? 0,
      }));
    });
    expect(state.length).toBe(2);
    expect(state[0].pattern).toBe("Nebula");
    expect(state[0].laneTypes).toContain("u_timeFactor");
    // The hidden Disc carries a constant-zero opacity lane.
    expect(state[1].pattern).toBe("Disc");
    expect(state[1].opacity).toBe(1);

    // The legacy slots became backups.
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys).toContain("editorV2:untitled:autosave:backup");
    expect(keys).not.toContain("editorV2:untitled:autosave");
  });
});
