import type { Song } from "@/src/types/Song";

// Static-demo mode: the spell crafter exported to GitHub Pages with no
// backend. The song library is a bundled list (the audio ships as a
// static asset), uploads are hidden, and a starter experience seeds
// localStorage on first visit (see experiencePersistence).
export const IS_DEMO = process.env.NEXT_PUBLIC_SPELL_DEMO === "1";

// GitHub Pages serves project sites under /<repo>; every asset URL built
// outside of Next's own routing needs the prefix.
export const DEMO_BASE_PATH = IS_DEMO ? "/conjurer" : "";

// Mirrors the song row referenced by demoExperience.json exactly.
export const DEMO_SONGS: Song[] = [
  {
    id: 2,
    name: "shiny_2",
    artist: "no homework",
    filename: "no homework - shiny_2.mp3",
    createdAt: "2026-07-25 04:53:07",
    updatedAt: "2026-07-25 04:53:07",
  },
];
