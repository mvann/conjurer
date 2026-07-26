import { expect, test, Page } from "@playwright/test";
import { gotoEditorClean, loadSeededSong } from "./helpers";

// The playhead's rendered position is the published transport time; these
// tests watch it the way a user watches the cursor. The second test
// reproduces, deterministically, the field stutter (press play; the
// playhead moves, freezes ~a quarter second, then continues): Chromium's
// media clock can briefly freeze around playback start while output syncs
// to the audio hardware clock, then jump forward. Headless test runs mute
// audio and never hit it naturally, so the test freezes the media clock
// itself and asserts the smoothed playback clock bridges the gap.

type Sample = { at: number; t: number };

// Sample the published transport time on every animation frame for the
// given duration.
const sampleTransport = (page: Page, ms: number): Promise<Sample[]> =>
  page.evaluate(
    (durationMs) =>
      new Promise<{ at: number; t: number }[]>((resolve) => {
        const samples: { at: number; t: number }[] = [];
        const started = performance.now();
        const tick = () => {
          const now = performance.now();
          samples.push({
            at: now,
            t: (window as unknown as Record<string, { seconds: number }>)
              .__editorTransportTime.seconds,
          });
          if (now - started < durationMs) requestAnimationFrame(tick);
          else resolve(samples);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );

// The longest span (ms) across which the rendered time failed to advance.
const longestStall = (samples: Sample[]) => {
  let longest = 0;
  let plateauStart = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t > plateauStart.t) plateauStart = samples[i];
    else longest = Math.max(longest, samples[i].at - plateauStart.at);
  }
  return longest;
};

test.describe("playhead motion", () => {
  test.beforeEach(async ({ page }) => gotoEditorClean(page));

  test("advances smoothly and monotonically through playback", async ({
    page,
  }) => {
    await loadSeededSong(page);
    await page.keyboard.press("Space");
    await page.waitForTimeout(300);

    const samples = await sampleTransport(page, 2_500);
    await page.keyboard.press("Space");

    expect(samples.length).toBeGreaterThan(50);
    // Never moves backward.
    for (let i = 1; i < samples.length; i++)
      expect(samples[i].t).toBeGreaterThanOrEqual(samples[i - 1].t);
    // Never visibly stops.
    expect(longestStall(samples)).toBeLessThan(200);
    // Tracks wall time overall (within 15%).
    const elapsed = (samples[samples.length - 1].at - samples[0].at) / 1000;
    const advanced = samples[samples.length - 1].t - samples[0].t;
    expect(Math.abs(advanced - elapsed)).toBeLessThan(elapsed * 0.15);
  });

  test("bridges a frozen media clock without stalling or jumping", async ({
    page,
  }) => {
    await loadSeededSong(page);
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);

    // Freeze the media element's currentTime getter for 400ms mid-
    // playback — the same shape as the field stutter — then restore it,
    // which also replays the post-freeze forward jump.
    const freeze = page.evaluate(() => {
      const player = (
        window as unknown as Record<string, { media: HTMLMediaElement }>
      ).__editorSongPlayer;
      const media = player.media;
      const frozenAt = media.currentTime;
      Object.defineProperty(media, "currentTime", {
        configurable: true,
        get: () => frozenAt,
        set: () => {},
      });
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          delete (media as unknown as Record<string, unknown>).currentTime;
          resolve();
        }, 400),
      );
    });
    const samples = await sampleTransport(page, 1_600);
    await freeze;
    await page.keyboard.press("Space");

    // Through the freeze and the recovery jump, the rendered playhead
    // neither stops nor moves backward.
    for (let i = 1; i < samples.length; i++)
      expect(samples[i].t).toBeGreaterThanOrEqual(samples[i - 1].t);
    expect(longestStall(samples)).toBeLessThan(200);
  });
});
