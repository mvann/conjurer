// The timeline's visible time window, as fractions of the song, shared with
// the automation editor so both follow the minimap. The timeline mutates
// its viewport imperatively (canvas drawing), so this is a tiny mutable
// store plus a window event rather than React state.
export const timeViewport = { left: 0, width: 1 };

export const TIME_VIEWPORT_EVENT = "editorv2-timeview";

export const publishTimeViewport = (left: number, width: number) => {
  timeViewport.left = left;
  timeViewport.width = width;
  window.dispatchEvent(new Event(TIME_VIEWPORT_EVENT));
};

// The transport's current time, shared the same way (the automation
// editor marks it on the curve). Consumers read it in their own
// animation loops; no event needed.
export const transportTime = { seconds: 0, durationSeconds: 0 };

export const publishTransportTime = (
  seconds: number,
  durationSeconds: number,
) => {
  transportTime.seconds = seconds;
  transportTime.durationSeconds = durationSeconds;
};

// Test hooks: e2e tests read the live viewport and transport through
// these (transport readiness in particular: durationSeconds turns
// nonzero once the song is fetched, decoded, and playable).
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__editorTimeViewport =
    timeViewport;
  (window as unknown as Record<string, unknown>).__editorTransportTime =
    transportTime;
}
