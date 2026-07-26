import { expect, Page } from "@playwright/test";

// Navigate to the spell crafter with a clean slate (no saves/autosaves).
export const gotoEditorClean = async (page: Page) => {
  await page.goto("/editor");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator("h1", { hasText: "Conjurer" })).toBeVisible();
  await expect(page.locator("[class*=docsStrip]")).toBeVisible();
};

// The patterns panel's aside (the songs panel renders earlier in the DOM).
export const patternsAside = (page: Page) =>
  page.locator("aside").filter({ hasText: "Add Pattern" });

export const openPatternPanel = async (page: Page) => {
  await page.getByLabel("Open pattern library").click();
  await expect(
    page.locator("[class*=panelSectionLabel]", { hasText: "Patterns" }),
  ).toBeVisible();
};

// Adds a pattern from the library (defaults to the first/selected one).
export const insertPattern = async (page: Page, name?: string) => {
  await page.getByRole("button", { name: "Add Pattern" }).click();
  if (name)
    await page
      .locator("[class*=tileGrid] button")
      .filter({ hasText: new RegExp(`^${name}$`) })
      .click();
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  // Let the panel's slide-back animation settle before measuring layout.
  await page.waitForTimeout(400);
};

// The pattern panel's empty-state hint (the hidden songs panel has its own).
export const patternsEmptyHint = (page: Page) =>
  patternsAside(page).locator("[class*=panelEmpty]");

export const closePanel = async (page: Page) => {
  await page
    .locator("[class*=panelBackdrop]")
    .click({ position: { x: 700, y: 400 } });
};

// Right-clicks a param row and adds an automation lane for it.
export const addLaneOnParam = async (page: Page, paramName: string) => {
  await page
    .locator("[data-doc=param-row]")
    .filter({ hasText: paramName })
    .first()
    .click({ button: "right" });
  await page.getByRole("button", { name: "Add Automation Lane" }).click();
};

// The seeded song's library row, by its exact accessible name so user
// uploads with similar names never collide with it.
export const seededSongItem = (page: Page) =>
  page.getByRole("button", { name: "Shiny_2 no homework", exact: true });

// Loads the seeded local song and waits for it to be ready to play.
export const loadSeededSong = async (page: Page) => {
  await page.getByRole("button", { name: "Add Song" }).click();
  // Exact name: the library may hold user uploads whose names contain
  // the seeded song's name as a prefix.
  await seededSongItem(page).click();
  await expect(page.locator("canvas[class*=waveform]")).toBeVisible();
  await expect(page.getByLabel("Play", { exact: true })).toBeEnabled({
    timeout: 20_000,
  });
  // Song setup is async (fetch, decode); the transport publishes a real
  // duration only once the audio is actually playable and scrubable.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as Record<string, { durationSeconds: number }>)
              .__editorTransportTime?.durationSeconds ?? 0,
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
};

export const scaleTicks = (page: Page) =>
  page.locator("[class*=valueTickLabel]").allTextContents();
