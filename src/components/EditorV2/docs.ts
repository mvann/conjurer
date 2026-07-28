// Copy registry for the info strip. Elements declare a
// `data-doc="<key>"` attribute; the strip shows `short` for the hovered
// element, and the press-? overlay shows `long`.
//
// Style rules for this copy, enforced in part by `yarn test:docs`:
// - No em dashes.
// - Written as a manual: dry, imperative instructions for USING the
//   element, not a description of what the element is. Lead with the
//   action; keep conceptual notes short and only where they change what
//   the reader does.
// - No comparisons to other products.

export type DocEntry = {
  title: string;
  short: string;
  long: string;
};

export const docs: Record<string, DocEntry> = {
  welcome: {
    title: "Conjurer Spell Crafter",
    short: "Hover any control for a one line how-to. Press ? for more.",
    long: `To build an experience: open the layer list with the chevron at the left edge, add a pattern to a layer, set its parameters, load a song with Add Song, and automate parameters by right clicking them and choosing Add Automation Lane.

Hover any control and this strip explains how to use it. Press ? (or /) for the full instructions for that control; press it again, or Escape, to close them.

Save with command s, or from the gear in the top right, which glows while work is unsaved; everything in between lands in a local draft that is offered back on the next open.`,
  },
  experience: {
    title: "Current Experience",
    short: "The loaded experience, shown as name by author.",
    long: `The experience currently open in the editor, shown as its name and author. Experiences live in the shared conjurer library: anything saved here opens in the main experience editor, and anything made there opens here.`,
  },
  canopy: {
    title: "Canopy Preview",
    short: "Drag to orbit. Scroll to zoom.",
    long: `Drag anywhere in the view to orbit the canopy; scroll to zoom in and out.

To put something on the canopy, open the pattern editor (the chevron at the left edge) and add a pattern. Every visible pattern renders at once, summed together; use each pattern's eye toggle to choose which ones contribute.

The checkerboard means the stack is empty or every pattern is hidden.`,
  },
  volume: {
    title: "Volume",
    short: "Click, then drag the slider up or down. Zero mutes.",
    long: `Click the button to open the slider, then drag up for louder or down for quieter. Drag to the bottom to mute; the icon changes to show it. Click away to close the slider.

Volume only affects monitoring in the editor; it is not saved with the experience.`,
  },
  dust: {
    title: "Dust",
    short: "Click, then drag the slider to set the dust density.",
    long: `Click the button to open the slider, then drag up for denser dust or down for less. At the bottom the layer is off and costs nothing.

Dust is a preview atmosphere for the editor view: drifting fog lit by whatever the patterns display. It is not part of the experience and never reaches the physical canopy.`,
  },
  timeline: {
    title: "Timeline",
    short: "Click to move the playhead; drag to scrub. Space plays.",
    long: `Click anywhere on the waveform to move the playhead there; hold and drag to scrub, with the seek applied on release. Press space, or the transport's play button, to start and stop playback.

To load a song, use Add Song. To remove the loaded one, use the trash button in the corner.

To see more or less of the song at once, use the minimap above the waveform.`,
  },
  minimap: {
    title: "Minimap",
    short: "Drag the window sideways to pan, up to zoom out, down to zoom in.",
    long: `Drag the outlined window sideways to pan the timeline. Drag it upward to widen the window and see more of the song; drag it downward to narrow it and zoom in. The automation lanes and the automation editor follow the same view.

The view never moves on its own: pan somewhere during playback and it stays put. To move the playhead, click the timeline itself; the minimap only controls the view.`,
  },
  "transport-play": {
    title: "Play / Stop",
    short: "Starts and stops playback. Space does the same.",
    long: `Click to start playback from the playhead; click again to stop in place. The spacebar does the same from anywhere, unless a text box has focus.

Load a song first; the transport stays disabled until one is in the timeline.

Patterns keep animating on their own clocks while playback is stopped.`,
  },
  "transport-start": {
    title: "Go to Start",
    short: "Moves the playhead to the start of the song.",
    long: `Click to move the playhead to the very beginning of the song. Playback, if running, continues from there.`,
  },
  "transport-end": {
    title: "Go to End",
    short: "Moves the playhead to the end of the song.",
    long: `Click to move the playhead to the very end of the song.`,
  },
  "transport-back10": {
    title: "Back 10 Seconds",
    short: "Moves the playhead back ten seconds.",
    long: `Click to jump the playhead ten seconds earlier. Use it repeatedly to step back through a section.`,
  },
  "transport-forward10": {
    title: "Forward 10 Seconds",
    short: "Moves the playhead forward ten seconds.",
    long: `Click to jump the playhead ten seconds later.`,
  },
  "transport-rate": {
    title: "Playback Speed",
    short: "Choose 1x, 0.5x, or 0.25x playback.",
    long: `Choose a rate to slow the song down without changing its pitch: half or quarter speed give more time to judge automation against the music. Return to 1x for real time.`,
  },
  "current-time": {
    title: "Current Time",
    short: "How far into the song playback is, as minutes and seconds.",
    long: `Reads the current playback position as minutes, seconds, and tenths. It follows playback, and follows the playhead while clicking or dragging in the timeline.

To go to a specific moment, click or drag on the timeline waveform; there is no typed entry here.`,
  },
  bpm: {
    title: "Detected Tempo",
    short: "The song's detected tempo. The beat grid and snapping use it.",
    long: `Nothing to operate here: the tempo is detected automatically when a song loads, and the beat grid on the timeline and in the automation editor aligns to it.

To snap automation edits to this grid, right click in the automation editor and set Snap to BPM Grid.

Detection assumes a constant tempo and is most reliable for music with a steady low end. If the grid sits badly on a song, the song itself likely drifts; there is no manual tempo entry yet.`,
  },
  save: {
    title: "Save",
    short: "Saves the experience. It glows when there are unsaved changes.",
    long: `Click to save the experience: the pattern stack, parameter values, effects, automation, and the loaded song. The button glows while unsaved changes exist.

Between saves, every change writes an autosave; if the editor is closed and reopened, a prompt offers to restore it. Saves live in the browser for now.`,
  },
  autosave: {
    title: "Auto Save Found",
    short: "Open the newer autosave, or dismiss to keep the last save.",
    long: `Choose Open Auto Save to restore the newer autosaved state; press Save afterward if you want to keep it. Choose Dismiss to stay on the last explicit save; the autosave will be overwritten by the next change you make.

This prompt appears when the editor opens with an autosave newer than the last save, which usually means the editor was closed without saving.`,
  },
  "add-song": {
    title: "Add Song",
    short: "Opens the song library. Pick a song to load it.",
    long: `Click to open the song library, then pick a song to load it into the timeline. Loading draws the waveform, detects the tempo, and enables the transport.

To add a new song to the library, use Upload Song at the bottom of the list.`,
  },
  "song-library": {
    title: "Song Library",
    short: "Click a song to load it into the timeline.",
    long: `Click a song to load it and close the library. Press Escape or click outside to leave without loading.

To add a song, use Upload Song at the bottom. While the upload form is open, the list parks at the panel's right edge; click that edge to return to it.`,
  },
  "song-item": {
    title: "Song",
    short: "Click to load this song into the timeline.",
    long: `Click to load this song. The library closes, the waveform draws, the tempo is analyzed, and the transport enables. Any song already in the timeline is replaced; the experience keeps its patterns and automation.`,
  },
  "upload-song": {
    title: "Upload Song",
    short: "Choose an MP3, name it, press Upload.",
    long: `Click to reveal the upload form. Choose an MP3 file, enter the song's name and artist (all three are required), and press Upload. The new song loads into the timeline immediately and joins the library for next time.`,
  },
  "remove-song": {
    title: "Remove Song",
    short: "Removes the loaded song from the timeline.",
    long: `Click to take the song out of the timeline. Playback stops and the transport disables until another song is loaded. The song stays in the library; nothing on disk is deleted.`,
  },
  "panel-toggle": {
    title: "Pattern Editor",
    short: "Opens the pattern stack. Escape or a click outside closes it.",
    long: `Click the chevron to open the pattern editor. Close it with Escape, a click outside the panel, or the chevron again.

Inside: expand a pattern's row with the caret to reach its parameters, toggle its eye to show or hide it on the canopy, add patterns with Add Pattern at the bottom, and remove one with its trash button.`,
  },
  "pattern-row": {
    title: "Pattern",
    short:
      "Caret expands parameters. Eye toggles visibility. Trash removes. Right click to duplicate.",
    long: `Use the caret to expand this pattern's parameters and effects. Use the eye to show or hide it on the canopy; hiding keeps its settings and automation intact. Use the trash to remove it from the stack entirely, which also removes its automation lanes (undo restores everything). Right click the row and choose Duplicate for a full copy of the pattern, parameters, effects, and automation included, inserted just below it.

All visible patterns render at once, summed together; hide others to isolate the one being adjusted.`,
  },
  "pattern-expand": {
    title: "Expand Pattern",
    short: "Shows or hides this pattern's parameters.",
    long: `Click to expand the pattern's parameters and effects in place; click again to collapse them.

Once expanded: drag numeric values to change them, click one to type it, and right click any parameter for its automation menu. The Add Effect action at the bottom of the list appends an effect to this pattern.`,
  },
  "pattern-visibility": {
    title: "Pattern Visibility",
    short: "Click to show or hide. Right click to automate it.",
    long: `Click the eye to show or hide this pattern on the canopy. Hiding keeps parameter values and automation intact.

To automate visibility, right click the eye and choose Add Automation Lane; it automates as an on and off switch. While a curve drives it, a small bar under the eye reads green (active) or red (deactivated). Clicking the eye by hand takes over and deactivates the curve; edit the curve to hand control back. The same right click menu disables, re-enables, or deletes the lane.`,
  },
  "pattern-remove": {
    title: "Remove Pattern",
    short: "Removes this pattern and its automation lanes.",
    long: `Click to remove the pattern from the stack, along with any automation lanes on its parameters.

Control z restores it exactly, parameters and lanes included. Adding the same pattern fresh from the library instead starts it at defaults.`,
  },
  "param-row": {
    title: "Parameter",
    short: "Drag the value to change it. Right click to automate.",
    long: `Drag the value up or down to change it; the canopy updates as you drag. Click the value to type an exact number.

To animate this parameter over the song, right click it and choose Add Automation Lane; the lane appears in the automation pane beneath the timeline. The same menu deletes the lane, or disables and re-enables its automation once the lane has keyframes.`,
  },
  "param-component": {
    title: "Parameter Component",
    short: "One number inside a composite value. Drag to change it.",
    long: `Drag to change this component, or click to type it. A palette exposes twelve components (four vectors of three channels); a color exposes four (red, green, blue, alpha).

To automate, right click the component; each component automates individually.`,
  },
  "param-value": {
    title: "Parameter Value",
    short: "Drag up or down. Shift for fine steps. Click to type.",
    long: `Drag up or down to change the value; the full range spans roughly 300 pixels of drag. Hold Shift for steps ten times finer.

Click (a brief press without movement) to type instead: enter a value and press Enter, or Escape to cancel. Typed and dragged values clamp to the parameter's allowed range.`,
  },
  "pattern-tile": {
    title: "Pattern Library",
    short: "Click to preview. Insert adds it to the stack.",
    long: `Click a tile to select it and see it rendered live in the preview above. Press Insert to add the selection to the stack.

Add the same pattern as many times as needed; each copy keeps its own parameter values and automation.`,
  },
  "pattern-preview": {
    title: "Pattern Preview",
    short: "The selected pattern, live. Drag to orbit. Scroll to zoom.",
    long: `Drag to orbit the preview; scroll to zoom. What you see is exactly what Insert adds: the same shader with the same default parameter values.

Use the view selector above to switch between the canopy rendering and the flat texture views.`,
  },
  "preview-mode": {
    title: "Preview View",
    short: "Switches the preview: canopy, cartesian space, or canopy space.",
    long: `Choose how to look at the selected pattern before inserting it.

Canopy renders it onto the LED geometry in three dimensions, orbitable by dragging. Cartesian Space shows the raw output texture, flat. Canopy Space shows the texture remapped into the canopy's coordinate space, the form the physical canopy receives.`,
  },
  "insert-pattern": {
    title: "Insert",
    short: "Adds the selected pattern to the bottom of the stack.",
    long: `Click to add the selected pattern to the stack and return to the pattern list. It arrives visible with default values and starts rendering immediately, summed with the rest of the stack.`,
  },
  "cancel-add": {
    title: "Cancel",
    short: "Closes the pattern library without adding anything.",
    long: `Click to close the library and return to the pattern list with nothing added. Escape, or a click on the list's exposed edge, does the same.`,
  },
  sliver: {
    title: "Back to Pattern List",
    short: "Click the exposed edge to return to the pattern list.",
    long: `Click the exposed edge of the pattern list to close the library view and bring the list back. This is the same as Cancel.`,
  },
  "automation-pane": {
    title: "Automation",
    short: "Click a lane to edit its curve. Drag the top edge to resize.",
    long: `Each lane here is one automated parameter. Click a lane to expand it into the automation editor; click it again, or press Escape, to close it.

To create a lane, click Add Automation at the bottom of the lanes and pick a parameter, or right click a parameter in the pattern editor and choose Add Automation Lane; delete it from that same menu. Drag the pane's top edge to resize it.`,
  },
  "lane-visibility": {
    title: "Lane Eye",
    short: "Toggles whether this curve drives its parameter.",
    long: `Click the eye to disable the lane's automation: the curve dims, the manual value takes over (the bright dashed line), and the eye slashes and reads red. Click again to re-enable it. This is the same switch as Disable Automation in the parameter's right click menu, and editing the curve re-enables it too.

The eye is dimmed while the lane has no keyframes; an empty lane drives nothing either way.`,
  },
  "lane-delete": {
    title: "Delete Lane",
    short: "Removes this lane and its curve.",
    long: `Click to delete the lane, discarding its keyframes and curve. The parameter keeps its manual value. If the lane was expanded in the automation editor, the editor closes.

Control z restores the lane, curve and all.`,
  },
  "add-lane": {
    title: "Add Automation",
    short: "Click, then pick a parameter in the pattern editor.",
    long: `Click to start an assignment: the pattern editor opens and a small curve badge rides beside the cursor. Click any parameter (pattern or effect) to give it an automation lane; the new lane appears here.

Press Escape, or click anywhere outside the pattern editor, to cancel. The pattern editor stays open either way.`,
  },
  "automation-resize": {
    title: "Resize Automation Pane",
    short: "Drag up or down to resize the automation pane.",
    long: `Drag this edge up for more lane space or down for more canopy. The height is limited to between one lane and sixty percent of the screen.`,
  },
  "automation-lane": {
    title: "Automation Lane",
    short: "Click to expand this lane into the editor view.",
    long: `Click the lane to expand it into the automation editor and shape its curve; click it again or press Escape to close.

The label names the pattern (and effect, for effect parameters) above the parameter. Drag the label up or down to reorder the lanes; the order is saved with the experience. The eye beside it disables and re-enables the curve; the trash deletes the lane. The miniature shows the curve, its keyframes, and the gold dot marking the value at the playhead.

While a song is loaded, an active curve drives the parameter. To take manual control, just edit the parameter in the pattern editor: the edit becomes the manual value, the curve deactivates (drawn dimmed, with a bright dashed line at the manual value now driving the parameter), and the row's edge turns red. Edit the curve in any way to hand control back to it. To disable or re-enable without editing, use the parameter's right click menu.

To delete the lane, right click its parameter and choose Delete Automation Lane.`,
  },
  "value-swatch": {
    title: "Color Period",
    short: "Click the swatch to edit this span's color or palette.",
    long: `Click a swatch to open its color or palette in the inspector and change it. Double click empty space to add a keyframe, splitting a period in two; double click a keyframe to remove it and merge periods; drag keyframes to move the boundaries.

Color and palette lanes automate the whole value: keyframes are boundaries dividing the song into periods, each holding one color or palette. There is no vertical axis in these lanes.`,
  },
  "color-editor": {
    title: "Color Editor",
    short: "Drag in the field and hue bar, or type a hex value.",
    long: `Drag in the large field to set saturation and brightness, drag the bar beneath it for hue, or type a hex value and press Enter.

Editing an automated parameter's own color takes over from its curve and deactivates it; edit the lane to hand control back.`,
  },
  "palette-editor": {
    title: "Palette Editor",
    short: "Click a preset, or drag the coefficient grid to tune.",
    long: `Click a preset swatch to apply it; the bar above previews the palette across one period. To tune by hand, drag any cell in the coefficient grid (a, b, c, d by red, green, blue), with Shift for fine steps.

Editing an automated parameter's own palette takes over from its curve and deactivates it.`,
  },
  "docs-strip": {
    title: "Info Strip",
    short: "Hover any control for its how-to. Press ? for the full manual.",
    long: `Hover any control and this strip shows how to use it, staying on the last hovered element. Press the question mark key, or the slash key, to open the full instructions for that element; Escape or another press closes them.

The strip narrows to the space between open side panels rather than disappearing beneath them.`,
  },
  "time-selection": {
    title: "Time Selection",
    short: "Copy or Delete the highlighted window of time.",
    long: `Drag horizontally across empty space in the automation editor to highlight a window of time. Press Copy to lift the curve inside it to the clipboard, or Delete to remove it, leaving a straight bridge. The curve outside the window is never touched.

Cut edges shorten segments faithfully: a wave keeps its amplitude and phase and carries a proportional number of cycles; flats stay flat, linears stay linear, bends and easings refit to the cut.

Press Escape or click elsewhere to drop the selection. With snapping on, both edges land on the grid or on transients.`,
  },
  "editor-playhead": {
    title: "Playhead",
    short: "The transport's position. Move it on the timeline, not here.",
    long: `The gold line tracks the transport, aligned with the timeline below. To move it, click or drag on the timeline; clicks inside the editor place the silver cursor instead and never seek.`,
  },
  "edit-cursor": {
    title: "Cursor",
    short: "Click empty space to place it. Paste lands here.",
    long: `Click empty space in the automation editor to place the silver cursor, then Paste to lay the clipboard down starting there. The cursor is independent of the transport: playback and the gold playhead carry on without it.

With snapping on, the cursor lands on the beat grid or on transients. Starting a drag selection dismisses it.`,
  },
  "paste-action": {
    title: "Paste",
    short: "Lays the copied curve down at the cursor.",
    long: `Place the cursor where the clip should start, then press Paste (or the usual keyboard shortcut). The clip replaces what that window held, starting exactly at the cursor; everything left of the cursor is preserved, with an instant step at the junction if the values differ. A clip running past the end of the song is trimmed, shortening any segment it cuts.

The clipboard is shared between lanes: copy from one parameter and paste into another.`,
  },
  "automation-scale": {
    title: "Value Scale",
    short: "The visible value range. It manages itself; no zoom needed.",
    long: `Nothing to operate: the scale labels the visible value range and manages itself.

A switch parameter (zero or one) reads On and Off, and every edit in its lane snaps to the two states. A parameter with declared bounds keeps them a tenth in from the view's edges, and edits clamp to them. An unbounded parameter gets a zero centered range that steps between power-of-two pairs to fit the curve's furthest point, wave peaks and easing overshoots included; it holds still during drags and refits on release.

The dashed guides cross at every multiple of an eighth of the range's radius and travel with the scale.`,
  },
  "segment-menu": {
    title: "Segment Type",
    short: "Choose how the curve travels between two keyframes.",
    long: `Right click a segment and choose its type. Curve is the default: drag the segment up or down to bend it. Flat holds the first keyframe's value, then steps. Linear is a fixed straight line. Wave oscillates around the straight line with a sine, square, or triangle shape. Easing follows a named easing function. Audio rides the song's loudness: the straight line between the keyframes plus the audio envelope at each moment, scaled by the inspector's Amount.

The current type is marked. Choosing a type resets the segment's parameters; select the segment to edit them in the inspector. Splitting a segment with a new keyframe gives both halves the original's type and parameters.

Below the types sit the Snap to options; right click empty space to reach those on their own.`,
  },
  "opacity-row": {
    title: "Opacity",
    short: "auto crossfades on overlap. Click to take manual control.",
    long: `The block's output opacity, applied after its whole effect chain. On auto, overlapping blocks in a layer crossfade into each other with equal power; nothing is stored. Click auto to take manual control: the value becomes a constant you can scrub, saved with the experience. Right click for Reset to Auto, or Add Automation Lane to shape opacity over time.`,
  },
  "layer-row": {
    title: "Layer",
    short: "Double click the name to rename. Eye hides. Trash removes.",
    long: `Layers are the parallel tracks of an experience: every visible layer renders to the canopy at once, summed together. Double click the layer's name to rename it. The eye hides the layer's blocks from the canopy without touching them (a runtime toggle; it is not saved). The trash removes the layer and its blocks; the last layer cannot be removed.`,
  },
  "layer-visibility": {
    title: "Layer Visibility",
    short: "Hides this layer's blocks from the canopy. Not saved.",
    long: `Hides or shows everything on this layer. A hidden layer keeps all of its blocks and automation; only the canopy ignores it. Visibility is a live control and is not part of the saved experience, matching the main experience editor.`,
  },
  "layer-remove": {
    title: "Remove Layer",
    short: "Removes the layer and all of its blocks.",
    long: `Removes this layer and every block on it. The last remaining layer cannot be removed.`,
  },
  "add-layer": {
    title: "Add Layer",
    short: "Adds an empty layer below the others.",
    long: `Creates a new empty layer. Layers render simultaneously; use them to group blocks you want to manage or hide together.`,
  },
  "add-pattern": {
    title: "Add Pattern",
    short: "Adds a pattern to this layer as a full-song block.",
    long: `Opens the pattern library and inserts the chosen pattern into this layer as a block spanning the whole song. Blocks can be trimmed and moved afterward from their bar in the automation lanes.`,
  },
  "lane-layer": {
    title: "Layer Lane",
    short: "This layer's section of the automation lanes.",
    long: `Groups the lanes below it by layer, in the same order as the layer list on the left.`,
  },
  "lane-block": {
    title: "Block Lane",
    short: "The block's time extent. Drag edges to trim, middle to move.",
    long: `The bar shows when this block plays. Drag its left edge to change the start (the right edge stays put), the right edge to change the duration, or the middle to move the whole block, automation and all. Timing edits never modify the block's automation: regions past a trimmed end simply stop playing, and an extended block holds its last value.`,
  },
  "block-bar": {
    title: "Block Extent",
    short: "Drag: left edge trims start, right edge duration, middle moves.",
    long: `Drag the left edge to move the start while the right edge holds. Drag the right edge to grow or trim the duration. Drag the body to move the whole block along the song, keyframes and all.`,
  },
  "lane-row": {
    title: "Automation Lane",
    short: "Click to edit. The +/- expands or shrinks the preview.",
    long: `A parameter with automation. Click the lane to open the full editor over the canopy. The small control on the label expands the lane's preview or shrinks it to a single line; which lanes are expanded is shared with the main experience editor's open lanes.`,
  },
  "automation-editor": {
    title: "Automation Editor",
    short: "Double click to add. Right click a segment to retype it.",
    long: `The full editor for one lane. The view spans the whole song; the area outside the block is dimmed and inert. Double click empty space to add a keyframe; double click inside a wave to split it. Drag keyframes to move them; drag a wave's edge dots to move its center line. Right click ON the curve to change a segment's type; right click away from the curve for the snap menu; right click a keyframe to type its exact value. Escape steps back one layer at a time.`,
  },
  "editor-area": {
    title: "Editor Area",
    short: "Double click adds. Drag moves. Right click for menus.",
    long: `Double click in a curve to add a keyframe there, or inside a wave to split it in two. Right click on the curve to change the segment's type; right click in open space for the snap menu.`,
  },
  keyframe: {
    title: "Keyframe",
    short: "Drag to move. Double click deletes. Right click types a value.",
    long: `A point the curve passes through. Drag it in time and value; snapping applies when a snap mode is on. Double click deletes it. Right click opens a small field to type its exact value. The dots at a wave's edges are different: dragging either one moves the wave's whole center line up and down.`,
  },
  "retype-menu": {
    title: "Segment Type",
    short: "Curve, Wave, or Audio for the clicked segment.",
    long: `Changes what drives this stretch of the lane. Curve is a freeform line you shape with keyframes. Wave is a live oscillator: it has a frequency, amplitude, phase, and center, set in the inspector, and it never bends with the keyframes around it. Audio follows the song's loudness, live. Converting to Curve bakes whatever was there into keyframes.`,
  },
  "backdrop-canopy": {
    title: "Canopy Backdrop",
    short: "See the canopy through the editor.",
    long: `Thins the editor's backdrop so the live canopy shows through behind the curve. On by default.`,
  },
  "backdrop-waveform": {
    title: "Waveform Backdrop",
    short: "Draw the song's waveform behind the curve.",
    long: `Draws the loaded song's waveform behind the curve for lining automation up against the music. Stacks with the canopy backdrop.`,
  },
  gear: {
    title: "Settings",
    short: "Everything else lives in here. Glows when unsaved.",
    long: `Opens the settings pane: saving and opening experiences, view options, tools, and help. The gear glows while there is unsaved work.`,
  },
  "gear-pane": {
    title: "Settings Pane",
    short: "File, view, tools, and help, in the main app's order.",
    long: `The groups mirror the main experience editor's menus: file actions first, then the clipboard, view options, tools, and help. Items that need input slide a second panel out to the left.`,
  },
  "gear-item": {
    title: "Settings Item",
    short: "Click to act. Underlined items are currently on.",
    long: `Acts immediately, cycles a setting, or opens a slide-out. Underlined items show an active toggle.`,
  },
  "gear-open": {
    title: "Open Experience",
    short: "Browse the shared experience library.",
    long: `Lists every experience in the shared library. Opening one loads it here; anything saved from the main experience editor appears too, because both editors read and write the same experiences.`,
  },
  "gear-orientation": {
    title: "Orientation",
    short: "Stacked, or canopy beside the automation for wide screens.",
    long: `Vertical stacks the canopy above the timeline and lanes. Horizontal docks the canopy on the left with the timeline, lanes, and a permanently open automation editor on the right. The setting is shared with the main experience editor.`,
  },
  "gear-experience": {
    title: "Experience",
    short: "Click to open it here.",
    long: `Opens this experience in the spell crafter. Unsaved work in the current experience stays in the local draft.`,
  },
  "gear-sub-pane": {
    title: "Settings Detail",
    short: "The open browser or the shortcut list.",
    long: `The slide-out beside the settings pane. Escape closes it first, then the pane.`,
  },
  roles: {
    title: "Spell Crafter (alpha)",
    short: "You are in the spell crafter. Switch faces here.",
    long: `The conjurer app has several faces; this is the spell crafter, the alternate experience editor. The links jump to the main experience editor, the pattern playground, or the viewer. Experiences travel between the editors because they share one library.`,
  },
  "keyframe-value": {
    title: "Keyframe Value",
    short: "Type the exact value, then press Enter.",
    long: `Right click a keyframe, or hover it and press E, to open this field, pre-filled and selected. Type a value and press Enter, or click away, to commit; press Escape to cancel. Values clamp to the parameter's declared range.

Drag the keyframe itself to move it in time. Color and palette keyframes edit through the inspector instead.`,
  },
  "effect-row": {
    title: "Effect",
    short: "Arrows reorder the chain. Trash removes. Params work as usual.",
    long: `Adjust an effect's parameters exactly like a pattern's: drag or type values, use the color and palette editors, and right click any of them for an automation lane. Effect lanes carry the effect's name in the automation list.

Effects apply in order, top to bottom: use the arrows to reorder the chain and the trash to remove one. Removing an effect removes its automation lanes too (undo restores both).`,
  },
  "add-effect": {
    title: "Add Effect",
    short: "Appends an effect from the catalog to this pattern.",
    long: `Click to open the effect catalog inline, then click an effect (tints, masks, kaleidoscopes, projections and more) to append it to this pattern's chain. Reorder or remove it from its header row; automate its parameters like any others.`,
  },
  "see-through": {
    title: "Backdrop",
    short: "Toggle the canopy and the waveform behind the curve.",
    long: `Click the corner button, then toggle each backdrop layer on or off; the menu stays open for both. Canopy (on by default) thins the editor so the live canopy renders through it; use it to watch what a curve does while shaping it. Waveform draws the song's waveform dimly behind the curve, lined up with the editor's time axis; use it to place automation against the audio by eye. Turn both on to stack them, or both off for the plain solid backdrop.

Curves, keyframes, and controls stay at full strength over any backdrop. Waveform needs a loaded song.`,
  },
  "snap-menu": {
    title: "Snap To",
    short: "Choose Off, BPM Grid, or Transients for time edits.",
    long: `Right click anywhere in the automation editor and choose a snap mode. Off places time edits exactly at the pointer. BPM Grid lands them on the nearest beat. Transients lands them on the nearest detected hit in the audio itself, often tighter than the grid for humanized material.

Snapping applies to dragging keyframes, double click creation, the edit cursor, and both edges of a time selection. Grid and Transients enable once a song is loaded and analyzed.`,
  },
  "segment-inspector": {
    title: "Segment Inspector",
    short: "Edits the selected segment's type and parameters.",
    long: `Click a segment to select it and open this card. Use the top row to switch its type; the rows below hold that type's parameters.

For a curve, set the bend: one is linear, below one bows early, above one bows late. For a wave, set the shape (sine, square, triangle), amplitude, cycles across the segment, and phase in fractions of a cycle. For an easing, choose the mode (in, out, in and out) and family. For audio, set the amount the loudness is scaled by (negative inverts it) and a smoothing window in seconds. Flat and linear have nothing to set.

Numbers here edit like everywhere else: drag, Shift for fine, click to type. Escape or a click on empty space drops the selection.`,
  },
};

export const getDoc = (key: string | null): DocEntry =>
  (key && docs[key]) || docs.welcome;
