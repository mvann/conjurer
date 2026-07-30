// Spell Crafter's load and save orchestration.
//
// Upstream's Store is the document: `store.layers` holds the layers, blocks,
// and region lanes, and `store.serialize()` / `store.deserialize()` are the
// only two calls needed to move it to and from a row. Spell Crafter drives
// those itself instead of routing through upstream's ExperienceStore, for one
// reason: ExperienceStore reaches for tRPC directly, and the static demo has
// no backend. Owning the orchestration puts the transport choice in
// experienceClient.ts and leaves upstream untouched.
//
// Autosave becomes a localStorage DRAFT keyed by experience name, compared
// against the row (decision 17). Upstream has no autosave concept and quietly
// writing a shared row would violate both its UX and its permissions, so the
// draft never leaves the browser until an explicit Save.

import { runInAction } from "mobx";
import type { Store } from "@/src/types/Store";
import { Experience, EXPERIENCE_VERSION } from "@/src/types/Experience";
import { NO_SONG } from "@/src/types/Song";
import { IS_DEMO } from "@/src/utils/demo";
import {
  DEMO_USER,
  fetchExperience,
  saveExperience,
} from "@/src/components/EditorV2/experienceClient";

export const DEFAULT_EXPERIENCE_NAME = "untitled";

const draftKey = (name: string) => `spellCrafter:draft:${name}`;

export type Draft = {
  savedAt: number;
  /** The row's updatedAt when this draft forked from it, if it had one. */
  basedOn: number | null;
  experience: Experience;
};

// -------------------------------------------------------------- lane order
//
// Lane display order has no home in the blob and must not get one: it is view
// state, and the constraint is that Spell Crafter adds no new information to
// the experience. Decision 21 keeps it local, alongside upstream's own
// `lanedParams`, which it stores the same way and for the same reason.

const laneOrderKey = (name: string) => `spellCrafter:laneOrder:${name}`;

export const readLaneOrder = (name: string): string[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(laneOrderKey(name));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
};

export const writeLaneOrder = (name: string, order: string[]) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(laneOrderKey(name), JSON.stringify(order));
  } catch {
    // A full quota should never take the editor down with it.
  }
};

// ------------------------------------------------------------------- drafts

export const readDraft = (name: string): Draft | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(draftKey(name));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
};

export const writeDraft = (
  name: string,
  experience: Experience,
  basedOn: number | null,
) => {
  if (typeof window === "undefined") return;
  const draft: Draft = { savedAt: Date.now(), basedOn, experience };
  try {
    localStorage.setItem(draftKey(name), JSON.stringify(draft));
  } catch {
    // A full quota should never take the editor down with it.
  }
};

export const clearDraft = (name: string) => {
  if (typeof window === "undefined") return;
  localStorage.removeItem(draftKey(name));
};

// -------------------------------------------------------------------- load

export type LoadResult = {
  /** What the store now holds. */
  experience: Experience;
  /** A draft newer than the row, for the "unsaved work is ahead" prompt. */
  aheadDraft: Draft | null;
  /** False when nothing was stored under this name and we started fresh. */
  existed: boolean;
};

const emptyExperience = (store: Store, name: string): Experience => ({
  id: undefined,
  user: store.userStore.me ?? (IS_DEMO ? DEMO_USER : { id: -1, username: "" }),
  name,
  song: NO_SONG,
  status: "inprogress",
  version: EXPERIENCE_VERSION,
  // A new experience starts with one layer, matching upstream's own empty
  // shape so Spell Crafter output is indistinguishable from theirs.
  data: { layers: [{ blockMap: {} }] },
  thumbnailURL: "",
});

/**
 * Put the named experience into the store, through upstream's own deserialize
 * — so the v1 migration and the bake-to-curves pass both run and both editors
 * hold identical in-memory data (decision 26).
 *
 * A newer draft is reported rather than applied: restoring unsaved work is
 * the author's call, the same prompt Spell Crafter shows today.
 */
export const loadExperienceIntoStore = async (
  store: Store,
  name: string,
): Promise<LoadResult> => {
  let row: Experience | null = null;
  try {
    row = await fetchExperience(name, store.usingLocalData);
  } catch {
    // No backend, or a name that is not there: fall through to empty.
    row = null;
  }

  const experience = row ?? emptyExperience(store, name);
  store.deserialize(experience);
  runInAction(() => {
    store.hasSaved = !!row;
    store.experienceLastSavedAt = row ? Date.now() : 0;
  });

  const draft = readDraft(name);
  return { experience, aheadDraft: draft, existed: !!row };
};

/** Apply a draft the author chose to restore. */
export const restoreDraft = (store: Store, draft: Draft) => {
  store.deserialize(draft.experience);
};

/**
 * Whether a draft is unsaved work rather than a stale copy of what was saved.
 *
 * Existence IS the answer: saving clears the draft, so anything still sitting
 * there was written after the last save. Comparing timestamps against the row
 * would be worse than redundant — the row's own updatedAt is not carried on the
 * experience, so the comparison would silently be against load time and every
 * genuine draft would look stale.
 *
 * This is the condition behind both "the save button should only glow if the
 * most recent auto save is ahead of the last save" and the reopen prompt.
 */
export const draftIsAhead = (draft: Draft | null) => !!draft;

/**
 * The store as an experience, for DRAFTING only.
 *
 * Mirrors Store.serialize with one substitution: it does not require a user.
 * Upstream's serialize throws without one, which is right for a save — the row
 * has an owner and a permission model — but a draft is local unsaved work that
 * nobody has saved yet, and the editor has always worked logged out. Routing
 * drafts through the authenticated path would silently stop autosaving for
 * anyone not signed in, which is most of the time in development.
 */
const draftExperience = (store: Store): Experience => ({
  id: store.experienceId,
  name: store.experienceName || DEFAULT_EXPERIENCE_NAME,
  user: store.userStore.me ?? { id: -1, username: "" },
  song: store.audioStore.selectedSong,
  status: store.experienceStatus,
  version: store.experienceVersion,
  data: { layers: store.layers.map((layer) => layer.serialize()) },
  thumbnailURL: store.experienceThumbnailURL,
});

/** Capture the store as a draft: unsaved work, local to this browser. */
export const captureDraft = (store: Store) => {
  const serialized = draftExperience(store);
  writeDraft(serialized.name, serialized, store.experienceLastSavedAt || null);
  return serialized;
};

// -------------------------------------------------------------------- save

/**
 * Write the store to a row. Demo mode lands in localStorage; connected mode
 * posts the same payload upstream's own save does, with every column Spell
 * Crafter does not render carried straight through.
 */
export const saveStoreToExperience = async (store: Store) => {
  // Upstream's serialize needs an author; the demo has no auth, so it gets a
  // stand-in rather than a special case further down (plan gap A).
  if (IS_DEMO && !store.userStore.me)
    runInAction(() => {
      store.userStore.setMe({ ...DEMO_USER, isAdmin: false } as never);
    });

  const serialized = store.serialize() as Experience;
  const { id } = await saveExperience(serialized, store.usingLocalData);

  runInAction(() => {
    if (id !== undefined) store.experienceId = id;
    store.hasSaved = true;
    store.experienceLastSavedAt = Date.now();
  });
  // The row is now the truth; the draft has nothing left to restore.
  clearDraft(serialized.name);
  return { id };
};
