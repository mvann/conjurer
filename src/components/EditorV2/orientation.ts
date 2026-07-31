// App orientation (decision 32): whether the canopy sits ABOVE the timeline
// and lanes, or beside them.
//
// - Vertical  — canopy on top, timeline and lanes beneath. The default.
// - Horizontal — canopy docks LEFT as a full-height column, timeline and all
//   automation on the RIGHT. Widescreen support is the point.
//
// The plan said to adopt upstream's `horizontalLayout` flag so the two apps
// would share the setting. That flag no longer exists — upstream deleted it
// from UIStore — so this is Spell Crafter's own preference now. The behaviour
// the owner asked for is unchanged; only the sharing is lost, and there is
// nothing left to share with.
//
// It persists locally rather than in the experience: which shape the app takes
// belongs to the person and their monitor, not to the piece.

import { observable, runInAction } from "mobx";

export type Orientation = "vertical" | "horizontal";

const STORAGE_KEY = "spellCrafter:orientation";

const read = (): Orientation => {
  if (typeof window === "undefined") return "vertical";
  return localStorage.getItem(STORAGE_KEY) === "horizontal"
    ? "horizontal"
    : "vertical";
};

const box = observable.box<Orientation>("vertical");

/** Adopt whatever was stored. Safe to call more than once. */
export const initializeOrientation = () => {
  const stored = read();
  if (box.get() !== stored) runInAction(() => box.set(stored));
};

export const getOrientation = () => box.get();

export const setOrientation = (next: Orientation) => {
  if (box.get() === next) return;
  runInAction(() => box.set(next));
  if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, next);
};
