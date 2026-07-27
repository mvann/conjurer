// Editor preferences that outlive the expanded automation editor, which
// remounts per selected lane. Deliberately in-memory only: they reset
// with the page, not with every lane switch.
export const editorPrefs: {
  snapMode: "off" | "grid" | "transients";
} = {
  snapMode: "off",
};
