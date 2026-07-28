import { Store } from "@/src/types/Store";
import { Experience, EXPERIENCE_VERSION } from "@/src/types/Experience";
import { migrateLegacySave } from "@/src/components/EditorV2/migrateLegacySave";
import { SerializedEditorState } from "@/src/components/EditorV2/experiencePersistence";

// The autosave draft channel: unsaved work persists per-browser, keyed
// separately from the experiences table. The row (via their tRPC save)
// is the document of record; the draft only protects the gap between
// explicit saves. Anonymous sessions draft too (no user required).

const DRAFT_KEY = "spellcrafter:draft";
const LEGACY_KEYS = [
  "editorV2:untitled:autosave",
  "editorV2:untitled:save",
] as const;

export type SpellDraft = {
  savedAt: number;
  experienceName: string;
  experience: Experience;
};

// A serialization that never throws: the draft doesn't need a user
// (their Store.serialize refuses without one).
export const draftSerialize = (store: Store): Experience => ({
  id: store.experienceId,
  name: store.experienceName,
  user:
    store.experienceUser ?? ({ id: -1, username: "" } as Experience["user"]),
  song: store.audioStore.selectedSong,
  status: store.experienceStatus,
  version: EXPERIENCE_VERSION,
  data: { layers: store.layers.map((layer) => layer.serialize()) },
  thumbnailURL: store.experienceThumbnailURL,
});

export const writeDraft = (store: Store) => {
  try {
    const draft: SpellDraft = {
      savedAt: Date.now(),
      experienceName: store.experienceName,
      experience: draftSerialize(store),
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota or serialization failure: the draft is best-effort.
  }
};

export const readDraft = (): SpellDraft | null => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as SpellDraft) : null;
  } catch {
    return null;
  }
};

export const clearDraft = () => {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {}
};

// A draft is worth offering when it exists for the loaded experience
// and holds different content than what just loaded.
export const draftIsAhead = (store: Store): SpellDraft | null => {
  const draft = readDraft();
  if (!draft || draft.experienceName !== store.experienceName) return null;
  try {
    const current = JSON.stringify(draftSerialize(store).data);
    const drafted = JSON.stringify(draft.experience.data);
    return current === drafted ? null : draft;
  } catch {
    return null;
  }
};

// One-time legacy migration: an old Spell Crafter save (fraction-time
// wrapper) becomes a draft the prompt then offers. The legacy slots are
// renamed to backups, never deleted.
export const migrateLegacyIfPresent = () => {
  try {
    if (localStorage.getItem(DRAFT_KEY)) return;
    const raw = LEGACY_KEYS.map((key) => localStorage.getItem(key)).find(
      Boolean,
    );
    if (!raw) return;
    const legacy = JSON.parse(raw) as SerializedEditorState;
    // Legacy saves never stored the song's duration; the nominal basis
    // keeps curve shapes (there is no audio to sync against here).
    const experience = migrateLegacySave(legacy, undefined);
    const draft: SpellDraft = {
      savedAt: legacy.savedAt ?? Date.now(),
      experienceName: "untitled",
      experience,
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    for (const key of LEGACY_KEYS) {
      const value = localStorage.getItem(key);
      if (value) {
        localStorage.setItem(`${key}:backup`, value);
        localStorage.removeItem(key);
      }
    }
  } catch {
    // A malformed legacy save must never block the editor from opening.
  }
};
