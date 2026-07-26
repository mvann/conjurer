// The widths of the open side panels, published so the docs strip can
// shrink out from under them: the strip shares the panels' layer instead
// of being covered by them. A tiny mutable store plus a window event,
// like timeViewport.
export const panelInsets = { left: 0, right: 0 };

export const PANEL_INSETS_EVENT = "editorv2-panelinsets";

export const publishPanelInset = (side: "left" | "right", width: number) => {
  if (panelInsets[side] === width) return;
  panelInsets[side] = width;
  window.dispatchEvent(new Event(PANEL_INSETS_EVENT));
};
