// Where Spell Crafter's experiences come from and go to.
//
// Connected mode is upstream's plumbing verbatim: the same tRPC routes, the
// same `experiences` row, version 2, and every column Spell Crafter does not
// render passed straight back through (decision 17). Demo mode — the static
// GitHub Pages build with no backend — swaps this one module for localStorage
// and everything above it is identical code.
//
// The swap lives HERE, in Spell Crafter's own code, rather than inside
// upstream's ExperienceStore. Spell Crafter orchestrates its own load and
// save and calls only the store's public serialize/deserialize, so upstream
// keeps working exactly as it does today and this branch stays additive.

import { trpcClient } from "@/src/utils/trpc";
import {
  Experience,
  EXPERIENCE_VERSION,
  ExperienceStatus,
} from "@/src/types/Experience";
import { NO_SONG } from "@/src/types/Song";
import { IS_DEMO, DEMO_SONGS } from "@/src/utils/demo";

/** Demo mode keeps rows here, one entry per experience name. */
const DEMO_ROWS_KEY = "spellCrafter:demo:experiences";
/** The stand-in author for demo saves; upstream's serialize needs a user. */
export const DEMO_USER = { id: 1, username: "Gandalf" };

export type ExperienceSummary = {
  id: number | undefined;
  name: string;
  username: string;
  updatedAt?: string;
};

// ------------------------------------------------------------- demo backing

type DemoRow = Experience & { updatedAt: string };

const readDemoRows = (): Record<string, DemoRow> => {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(DEMO_ROWS_KEY) || "{}");
  } catch {
    return {};
  }
};

const writeDemoRows = (rows: Record<string, DemoRow>) => {
  if (typeof window === "undefined") return;
  localStorage.setItem(DEMO_ROWS_KEY, JSON.stringify(rows));
};

// --------------------------------------------------------------- public API

/**
 * The experience saved under `name`, or null when there is none — the
 * caller decides whether that means "start something empty".
 */
export const fetchExperience = async (
  name: string,
  usingLocalData: boolean,
): Promise<Experience | null> => {
  if (IS_DEMO) return readDemoRows()[name] ?? null;
  const experience = await trpcClient.experience.getExperience.query({
    experienceName: name,
    usingLocalData,
  });
  return experience ?? null;
};

/**
 * Write an experience back. `serialized` is whatever `Store.serialize()`
 * produced, so every column upstream fills is already in it and nothing
 * Spell Crafter does not render gets clobbered.
 */
export const saveExperience = async (
  serialized: Experience,
  usingLocalData: boolean,
  username?: string,
): Promise<{ id: number | undefined }> => {
  if (IS_DEMO) {
    const rows = readDemoRows();
    rows[serialized.name] = {
      ...serialized,
      // Demo rows are their own database, so the name is the identity and a
      // stable id is only needed to look like a real row.
      id: rows[serialized.name]?.id ?? Object.keys(rows).length + 1,
      updatedAt: new Date().toISOString(),
    };
    writeDemoRows(rows);
    return { id: rows[serialized.name].id };
  }

  // saveExperience is a userProcedure: the server resolves the author from a
  // `username` in the input, so it is not optional. It returns the row's id,
  // which first saves need in order to update rather than collide on the
  // unique name next time.
  const savedId = await trpcClient.experience.saveExperience.mutate({
    id: serialized.id,
    name: serialized.name,
    song: { id: serialized.song?.id ?? NO_SONG.id },
    data: serialized.data,
    status: (serialized.status ?? "inprogress") as ExperienceStatus,
    version: serialized.version ?? EXPERIENCE_VERSION,
    thumbnailURL: serialized.thumbnailURL ?? "",
    usingLocalData,
    username: username ?? serialized.user?.username ?? "",
  } as Parameters<typeof trpcClient.experience.saveExperience.mutate>[0]);

  return { id: typeof savedId === "number" ? savedId : serialized.id };
};

/** Everything available to open. */
export const listExperiences = async (
  usingLocalData: boolean,
): Promise<ExperienceSummary[]> => {
  if (IS_DEMO)
    return Object.values(readDemoRows()).map((row) => ({
      id: row.id,
      name: row.name,
      username: row.user?.username ?? DEMO_USER.username,
      updatedAt: row.updatedAt,
    }));

  const experiences = await trpcClient.experience.listExperiences.query({
    usingLocalData,
  });
  return (experiences ?? []).map((experience: any) => ({
    id: experience.id,
    name: experience.name,
    username: experience.user?.username ?? "",
    updatedAt: experience.updatedAt,
  }));
};

/** The song list: bundled in demo mode, the songs table otherwise. */
export const fetchSongs = async (usingLocalData: boolean) => {
  if (IS_DEMO) return DEMO_SONGS;
  return await trpcClient.song.listSongs.query({ usingLocalData });
};
