import { expect, Page } from "@playwright/test";

// Navigate to the spell crafter with a clean slate (no saves/autosaves).
//
// Clearing localStorage also clears who was signed in, and an experience is a
// row with an owner — so the editor asks who you are before anything else.
// Every test therefore starts by logging in, exactly as a person would.
export const gotoEditorClean = async (page: Page) => {
  await page.goto("/editor");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator("h1", { hasText: "Conjurer" })).toBeVisible();
  await logIn(page);
  await expect(page.locator("[class*=docsStrip]")).toBeVisible();
};

// Pick the seeded user from the log in panel, which opens itself when nobody
// is signed in. Tolerant of already being signed in.
export const logIn = async (page: Page, username = "mvann") => {
  const button = page.locator("[data-doc=login]");
  await expect(button).toBeVisible();
  if ((await button.textContent())?.trim() === username) return;
  // The panel opens on its own once the store reports nobody signed in, so
  // waiting for the entry is the whole interaction.
  await page
    .locator("[data-doc=login-panel]")
    .getByLabel(`Log in as ${username}`)
    .click({ timeout: 20_000 });
  await expect(button).toHaveText(username);
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

// The pattern dock stays open on outside clicks; Escape closes it.
export const closePanel = async (page: Page) => {
  await page.keyboard.press("Escape");
  await expect(patternsAside(page)).not.toHaveClass(/patternsDockOpen/);
};

// Waits for an element's box to hold still. The dock closes with a
// width transition that slides the whole main column; geometry measured
// mid-flight lands later clicks on stale coordinates.
export const settleBox = async (page: Page, selector: string) => {
  const locator = page.locator(selector).first();
  let prev = await locator.boundingBox();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    const next = await locator.boundingBox();
    if (
      prev &&
      next &&
      Math.abs(next.x - prev.x) < 0.5 &&
      Math.abs(next.y - prev.y) < 0.5 &&
      Math.abs(next.width - prev.width) < 0.5
    )
      return;
    prev = next;
  }
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
  // Mute playback for the test run: Chromium is launched muted by
  // Playwright, but WebKit has no browser-level mute and would play the
  // song through the machine's speakers.
  await page.evaluate(() =>
    (
      window as unknown as Record<string, { setVolume(v: number): void }>
    ).__editorSongPlayer?.setVolume(0),
  );
};

export const scaleTicks = (page: Page) =>
  page.locator("[class*=valueTickLabel]").allTextContents();
