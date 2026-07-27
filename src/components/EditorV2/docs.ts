// Documentation registry for the docs strip. Elements declare a
// `data-doc="<key>"` attribute; the strip shows `short` for the hovered
// element, and the press-? overlay shows `long`.
//
// Style rules for this copy, enforced in part by `yarn test:docs`:
// - No em dashes.
// - Dry, informational language, in the manner of a glossary.
// - No comparisons to other products.

export type DocEntry = {
  title: string;
  short: string;
  long: string;
};

export const docs: Record<string, DocEntry> = {
  welcome: {
    title: "Conjurer Spell Crafter",
    short: "Hover over any control to display its documentation.",
    long: `The spell crafter composes patterns, sets their parameters, and will automate parameter values over time against a song.

The screen is divided into panes: the canopy preview at the top, the timeline and transport below it, automation lanes below that, and this documentation strip at the bottom. The pattern editor opens from the chevron at the left edge of the screen.

This strip describes the element currently under the cursor. Press ? (or /) to open the full documentation for that element. Press it again, or Escape, to close it.

Every change is kept in history: control z (or command z) undoes, and adding shift redoes.`,
  },
  canopy: {
    title: "Canopy Preview",
    short: "A 3D preview of the canopy. Drag to orbit. Scroll to zoom.",
    long: `The canopy preview renders the output of the pattern stack onto the canopy's LED geometry in three dimensions.

Drag to orbit the view. Scroll to zoom.

When the pattern stack is empty, a checkerboard placeholder indicates the canopy's shape. When one or more patterns are visible, each visible pattern is rendered and their colors are summed to produce the displayed image. This is the same additive compositing used by the standard experience editor.

Pattern visibility is controlled per pattern by the eye toggle in the pattern editor.`,
  },
  volume: {
    title: "Volume",
    short: "Playback volume. Click for a slider; drag it up or down.",
    long: `Controls the loudness of song playback. Clicking the button opens a vertical slider; drag up for louder, down for quieter. The button shows a muted icon at zero.

Volume affects monitoring in the editor only; it is not part of the experience.`,
  },
  dust: {
    title: "Dust",
    short: "Adds a layer of glowing dust over the canopy view.",
    long: `Overlays the canopy view with drifting dust that catches the canopy's light: the fog field is textured noise, and its color comes from a blurred sample of the pattern composite, so the dust glows with whatever the patterns display.

Clicking the button opens a vertical slider controlling the dust's density. At zero the layer is off and costs nothing.

Dust is a preview effect for the editor view; it is not part of the experience and does not affect the physical canopy.`,
  },
  timeline: {
    title: "Timeline",
    short:
      "Holds the loaded song as a waveform. Click or drag to move the playhead.",
    long: `The timeline holds the song an experience is arranged against.

With no song loaded, the Add Song control opens the song library. A loaded song is displayed as its waveform. Clicking the waveform moves the playhead; holding and dragging scrubs it, with the seek applied on release. The trash button in the corner removes the song.

The transport at the left controls playback of the loaded song.`,
  },
  minimap: {
    title: "Minimap",
    short:
      "The whole song in miniature. Drag the window sideways to pan; up to widen; down to narrow.",
    long: `The minimap shows the entire loaded song in miniature. The outlined window marks the portion currently visible in the timeline below; the automation lanes share the same viewport.

Dragging the window sideways pans the timeline. Dragging it upward widens the window, showing more of the song (zooming out). Dragging it downward narrows the window, showing less (zooming in).

The minimap does not control playback; the playhead is moved in the timeline itself.`,
  },
  "transport-play": {
    title: "Play / Stop",
    short:
      "Starts and stops timeline playback. Disabled until a song is loaded.",
    long: `The transport button alternates between play and stop. Play begins playback of the loaded song, moving the playhead; stop halts it in place. The spacebar does the same.

Disabled until a song is loaded into the timeline.

While playback is stopped, all visible patterns in the stack continue to render on the canopy, animating on their own clocks.`,
  },
  "transport-start": {
    title: "Go to Start",
    short: "Moves the playhead to the start of the timeline.",
    long: `Moves the playhead to the beginning of the timeline.

Disabled until a song is loaded into the timeline.`,
  },
  "transport-end": {
    title: "Go to End",
    short: "Moves the playhead to the end of the timeline.",
    long: `Moves the playhead to the end of the timeline.

Disabled until a song is loaded into the timeline.`,
  },
  "transport-back10": {
    title: "Back 10 Seconds",
    short: "Moves the playhead back ten seconds.",
    long: `Moves the playhead ten seconds earlier in the timeline.

Disabled until a song is loaded into the timeline.`,
  },
  "transport-forward10": {
    title: "Forward 10 Seconds",
    short: "Moves the playhead forward ten seconds.",
    long: `Moves the playhead ten seconds later in the timeline.

Disabled until a song is loaded into the timeline.`,
  },
  "transport-rate": {
    title: "Playback Speed",
    short: "Sets the playback rate: 1x, 0.5x, or 0.25x.",
    long: `Sets the rate at which the timeline plays: full speed, half speed, or quarter speed. Slower rates are useful for detailed editing against a song.

Disabled until a song is loaded into the timeline.`,
  },
  "current-time": {
    title: "Current Time",
    short: "How far into the song playback is, as minutes and seconds.",
    long: `The current playback position in the loaded song, shown as minutes, seconds, and tenths.

It advances during playback and follows the playhead while clicking or dragging in the timeline.`,
  },
  bpm: {
    title: "Detected Tempo",
    short:
      "The song's tempo, estimated from the audio. The beat grid aligns to it.",
    long: `The tempo is estimated when a song loads: the audio is lowpass filtered to isolate the low end, onset peaks are detected, and the intervals between peaks vote on a tempo between 90 and 180 beats per minute. The grid's phase is set to the densest cluster of peak positions within a beat.

The beat grid drawn on the timeline aligns to this tempo, with a heavier line every fourth beat. The grid thins as beats crowd together at low zoom.

The estimate assumes a constant tempo throughout the song. It is most reliable for music with a steady low-frequency pulse. Automation editing will snap to this grid.`,
  },
  save: {
    title: "Save",
    short: "Saves the experience. Autosaves happen continuously in between.",
    long: `Saves the current state of the experience: the pattern stack, parameter values, visibility, automation lanes, and the loaded song.

Saves are stored in the browser for now; database persistence arrives with full experience management.

Between saves, every change writes an autosave. If the editor is closed and reopened with an autosave newer than the last save, a prompt offers to open the autosave.`,
  },
  autosave: {
    title: "Auto Save Found",
    short:
      "A newer autosave exists. Open it, or dismiss to keep the last save.",
    long: `Every change in the editor writes an autosave. This prompt appears over the canopy view when the editor opens and the autosave is newer than the last explicit save, which usually means the editor was closed without saving.

Open Auto Save restores the autosaved state; press Save afterward to persist it. Dismiss keeps the last saved state; the autosave is overwritten by the next change.`,
  },
  "add-song": {
    title: "Add Song",
    short: "Opens the song library for loading a song into the timeline.",
    long: `Opens the song library, a panel on the right listing every song in the database. Selecting a song loads it into the timeline and enables the transport.

New songs are added with the Upload Song action at the bottom of the list.`,
  },
  "song-library": {
    title: "Song Library",
    short: "Songs in the database. Click one to load it into the timeline.",
    long: `The song library lists every song in the database by name and artist. Selecting a song loads it into the timeline, displays its waveform, and enables the transport.

The Upload Song action at the bottom reveals the upload form. While the form is open, the library parks at the panel's right edge; clicking its exposed edge returns to the list.`,
  },
  "song-item": {
    title: "Song",
    short: "Click to load this song into the timeline.",
    long: `A song in the database, shown as its name and artist.

Clicking it closes the library and loads the song into the timeline: the waveform draws, the tempo is analyzed, and the transport enables.`,
  },
  "upload-song": {
    title: "Upload Song",
    short: "Adds an MP3 to the song library: choose a file, name it, upload.",
    long: `Reveals the upload form. Choose an MP3 file from the computer, enter the song's name and artist, and press Upload.

The file is stored under a filename built from the artist and song name, a database row is created, and the new song loads into the timeline immediately. Upload requires all three fields.`,
  },
  "remove-song": {
    title: "Remove Song",
    short: "Removes the loaded song from the timeline.",
    long: `Removes the loaded song from the timeline. Playback stops and the transport is disabled until another song is loaded.

The audio file on disk is not affected.`,
  },
  "panel-toggle": {
    title: "Pattern Editor",
    short:
      "Opens the pattern editor: the stack of patterns and their parameters.",
    long: `The chevron at the left edge of the screen opens the pattern editor, a panel containing the pattern stack.

Each pattern in the stack renders to the canopy when its visibility toggle is on. All visible patterns render simultaneously, summed together.

The caret on a row expands that pattern's parameters. The Add Pattern button at the bottom adds a pattern to the stack. The trash button on a row removes that pattern.

Escape, or a click outside the panel, closes it.`,
  },
  "pattern-row": {
    title: "Pattern",
    short:
      "One pattern in the stack. Expand for parameters. Toggle visibility. Remove.",
    long: `Each row is one pattern in the stack. All visible patterns render to the canopy simultaneously, summed together.

The caret expands the pattern's parameter list. The eye toggles the pattern's visibility on the canopy without removing it. The trash removes the pattern from the stack, along with any automation lanes on its parameters.`,
  },
  "pattern-expand": {
    title: "Expand Pattern",
    short: "Shows or hides this pattern's parameters.",
    long: `Expands the pattern row in place, listing every parameter the pattern exposes: numbers, colors, and palettes.

Numeric parameters are edited by dragging or by clicking to type. A right click on any parameter opens the automation lane menu.`,
  },
  "pattern-visibility": {
    title: "Pattern Visibility",
    short:
      "Toggles whether this pattern renders. Right click to add an automation lane.",
    long: `The eye controls whether this pattern contributes to the canopy render.

A hidden pattern remains in the stack with its parameter values and automation lanes intact; it only stops rendering. Visibility is commonly used to isolate one pattern while adjusting its parameters.

Visibility is automatable, as an on and off switch. A right click on the eye opens a menu to add an automation lane for it, delete the lane, or disable and re-enable its automation. While a song is loaded, an active curve drives the eye. A small bar under the eye shows the lane's state: green while the curve is active, red while deactivated. Clicking the eye by hand takes over and deactivates the curve, like editing any automated parameter.`,
  },
  "pattern-remove": {
    title: "Remove Pattern",
    short: "Removes this pattern from the stack, with its automation lanes.",
    long: `Removes the pattern from the stack immediately. Automation lanes belonging to its parameters are removed with it.

Control z undoes the removal, restoring the pattern with its parameters and lanes. A freshly re-added pattern instead returns with default parameter values.`,
  },
  "param-row": {
    title: "Parameter",
    short:
      "A pattern parameter. Right click to add or delete an automation lane.",
    long: `Parameters control what a pattern generates. Each pattern exposes its own set: palettes, speeds, sizes, thresholds, and so on.

Numeric values are edited by dragging up or down, or by clicking to type an exact value. Changes apply to the canopy immediately.

A right click on a parameter opens a menu to add an automation lane for it, or to delete the lane if one exists. Lanes appear in the automation pane beneath the timeline.`,
  },
  "param-component": {
    title: "Parameter Component",
    short:
      "One number inside a composite parameter. Drag to change. Right click to automate.",
    long: `Composite parameters (palettes and colors) are made of multiple numbers. Expanding the parameter lists each component: a palette has twelve (four vectors, three channels each) and a color has four (red, green, blue, alpha).

Each component edits like any numeric value: drag to scrub, click to type. Each component is automatable individually via right click; the composite parameter as a whole is not, since a single automation curve carries one number.`,
  },
  "param-value": {
    title: "Parameter Value",
    short:
      "Drag up or down to change. Hold Shift for fine steps. Click to type.",
    long: `A numeric parameter value.

Drag up or down to change the value. The canopy updates while dragging. The parameter's full range corresponds to roughly 300 pixels of drag.

Hold Shift while dragging for steps ten times finer.

Click (a brief press without movement) to open a text box. Type a value and press Enter to commit it, or Escape to cancel. Values are clamped to the parameter's allowed range.`,
  },
  "add-pattern": {
    title: "Add Pattern",
    short: "Opens the pattern library for inserting a pattern into the stack.",
    long: `Opens the add-pattern view. The panel widens and the pattern list slides aside; the exposed edge of the list can be clicked to return.

The library lists every available pattern as a tile. Selecting a tile shows a live preview. Insert adds the selected pattern to the bottom of the stack. Cancel, Escape, or a click on the list's exposed edge closes the view without adding.`,
  },
  "pattern-tile": {
    title: "Pattern Library",
    short:
      "Click to select and preview. Insert adds the selection to the stack.",
    long: `The library contains every pattern known to Conjurer. Clicking a tile selects it, and the preview above renders the pattern's shader.

Insert adds the selected pattern to the stack. The same pattern may be added multiple times; each copy keeps independent parameter values and automation.`,
  },
  "pattern-preview": {
    title: "Pattern Preview",
    short: "The selected pattern rendered on the canopy. Drag to orbit.",
    long: `A live preview of the selected pattern, rendered by its fragment shader onto the canopy geometry, as in the main canopy view.

Drag to orbit the view. Scroll to zoom.

The inserted pattern is identical to the preview: the same shader with the same default parameter values.`,
  },
  "preview-mode": {
    title: "Preview View",
    short:
      "Selects the preview's view: canopy, cartesian space, or canopy space.",
    long: `Selects how the preview displays the selected pattern.

Canopy renders the pattern onto the canopy's LED geometry in three dimensions, orbitable by dragging.

Cartesian Space shows the pattern's raw output texture, flat.

Canopy Space shows the texture remapped into the canopy's coordinate space, which is how the data is sent to the physical canopy.`,
  },
  "insert-pattern": {
    title: "Insert",
    short: "Adds the selected pattern to the bottom of the stack.",
    long: `Adds the currently selected pattern to the stack and returns to the pattern list.

The new pattern arrives visible, with default parameter values, and begins rendering on the canopy immediately, summed with the rest of the stack.`,
  },
  "cancel-add": {
    title: "Cancel",
    short: "Closes the pattern library without adding anything.",
    long: `Closes the add-pattern view and returns the pattern list to its position. Nothing is added to the stack.

Escape and a click on the pattern list's exposed edge have the same effect.`,
  },
  sliver: {
    title: "Back to Pattern List",
    short: "Click the exposed edge of the pattern list to return to it.",
    long: `While the add-pattern view is open, the pattern list sits mostly off screen with its right edge exposed. Clicking that edge closes the add-pattern view and returns the list to its position. This is equivalent to Cancel.`,
  },
  "automation-pane": {
    title: "Automation",
    short:
      "Automation lanes. Right click a parameter in the pattern editor to add one.",
    long: `The automation pane contains one lane per automated parameter.

A lane is added by right clicking a parameter in the pattern editor and choosing Add Automation Lane, and deleted the same way. Each lane is labeled at the left with its pattern and parameter names, and shows the parameter's underlying value as a horizontal line.

The pane is resized by dragging its top edge. Automation curves, which change parameter values over the timeline, are not yet implemented.`,
  },
  "automation-resize": {
    title: "Resize Automation Pane",
    short: "Drag up or down to resize the automation pane.",
    long: `Dragging this edge resizes the automation pane. The canopy preview above absorbs the difference. The pane's height is limited to between one lane and sixty percent of the screen.`,
  },
  "automation-lane": {
    title: "Automation Lane",
    short: "One automated parameter. Click to expand it into the editor view.",
    long: `A lane belongs to one parameter of one pattern, named in the label at the left. The label's lower text is the parameter; the upper text is the pattern.

The lane shows its automation curve. With no keyframes, the curve is a horizontal line at the underlying value: the value the parameter holds in the pattern editor, moving in real time as it is changed there. The vertical position maps the value within the parameter's allowed range.

While a song is loaded, the parameter follows its curve: the value at the transport's current time, marked by the gold dot, is applied to the pattern live, so the canopy and the pattern editor both show it.

Editing an automated parameter in the pattern editor takes control back: the edit sets the underlying value and deactivates the curve. A deactivated lane draws its curve dimmed with a bright dashed line at the underlying value, which is what drives the parameter; the gold dot follows that line. The colored edge on the parameter's row shows the state: green while the curve is active, red while deactivated. Editing the curve in any way reactivates it. The parameter's right click menu offers Disable Automation and Re-enable Automation directly, and a deactivated editor shows a Re-enable automation control beside its close button.

Clicking a lane expands it into the automation editor, which fills the canopy area. Clicking the lane again, or pressing Escape, closes the editor. A lane is deleted by right clicking its parameter and choosing Delete Automation Lane.`,
  },
  "automation-editor": {
    title: "Automation Editor",
    short: "The selected lane, expanded. Scroll to change the value scale.",
    long: `The automation editor fills the canopy area with an expanded view of the selected lane. A given time lines up vertically across the editor, the timeline, and the lanes. The editor extends further left than the lanes, over the label column's width; that strip shows time from before the visible window, and a glowing vertical line marks the start of the song. The curve begins at that line.

The view shows the lane's automation curve. With no keyframes, the curve is a horizontal line at the underlying value: the value the parameter holds in the pattern editor, tracked in real time. They are one and the same line, not separate elements. The scale on the right labels the visible value range, which stays centered on zero and steps between symmetric power-of-two pairs as the curve's furthest point crosses its thresholds. A deactivated lane draws the curve dimmed under a bright dashed line at the underlying value; editing the curve reactivates it.

A double click adds a keyframe at that time and value; a double click on an existing keyframe deletes it. A single keyframe is a constant. The leftmost keyframe extends horizontally to the left and the rightmost to the right; between keyframes the curve is a straight line by default, and dragging a segment up or down bends it. Keyframes drag to move in time and value, bounded by their neighbors. The beat grid of the loaded song is drawn behind the curve.

A right click on a segment opens the segment type menu. A left click selects a segment, highlighting it and opening the inspector card, where the segment's type and parameters are edited. Pressing Escape drops the selection before it closes the editor.

Color and palette parameters automate differently: their keyframes divide time into periods, each holding a whole color or palette, shown as a colored strip. Clicking a period opens its color or palette editor in the inspector. These lanes have no value scale and no curve shapes.

A click on empty space places the cursor, a silver line marking a position in time; the transport's gold playhead is never moved by clicks here. Dragging horizontally across empty space instead selects a window of time: Copy lifts the curve inside it to the clipboard and Delete flattens the window to a straight bridge. Paste, from the lower left corner or the usual keyboard shortcut, lays the clipboard down starting at the cursor, replacing what the window covered. A cut through the middle of a segment shortens it faithfully: half of a three cycle wave pastes as one and a half cycles.

Clicking the lane again, pressing Escape, or the corner close button closes the editor and returns the canopy view.`,
  },
  "value-swatch": {
    title: "Color Period",
    short: "One span of time holding a color or palette. Click to edit.",
    long: `A color or palette lane automates the whole value rather than a number: keyframes are boundaries dividing time into periods, exactly as the main experience editor picks palettes for spans of time. One keyframe makes two periods; two make three.

Each period shows its color, or its palette's gradient, in a small swatch above the middle of its span. Clicking the swatch opens the period's editor in the inspector; double clicking empty space adds a keyframe, splitting a period; double clicking a keyframe removes it. These lanes have no vertical meaning: no value scale, no curve shapes, no bends.`,
  },
  "color-editor": {
    title: "Color Editor",
    short: "Picks the color: the wheel, or a typed hex value.",
    long: `The color editor drives a color parameter or a color period in the automation editor. Drag in the field to pick saturation and brightness, the bar below it for hue, or type a hex value directly. Edits to an automated parameter's own color take over from the curve, deactivating it.`,
  },
  "palette-editor": {
    title: "Palette Editor",
    short: "Picks a preset palette or tunes the cosine coefficients.",
    long: `Palettes are cosine gradients with four coefficient vectors (a, b, c, d), as in the main experience editor. The bar previews the palette across one period. The swatches apply the curated presets; the grid below adjusts each coefficient channel by dragging, with shift for fine steps.

Edits to an automated parameter's own palette take over from the curve, deactivating it.`,
  },
  "docs-strip": {
    title: "Documentation Strip",
    short: "A one line how-to for whatever the cursor is over.",
    long: `The strip at the bottom of the screen follows the cursor: hover any control and its name and a one line description appear here, staying on the last hovered element. Pressing the question mark key, or the slash key, opens the full documentation for that element; Escape or another press closes it.

When a side panel slides open the strip narrows to the space between the panels rather than disappearing beneath them.`,
  },
  "time-selection": {
    title: "Time Selection",
    short: "A highlighted window of time. Copy or delete the curve in it.",
    long: `Dragging horizontally across empty space in the automation editor highlights a window of time. Copy lifts the curve inside the window to the clipboard; Delete removes it, leaving a straight bridge between the window's edges. The curve outside the window is untouched.

A window edge that cuts through the middle of a segment shortens that segment faithfully. A wave keeps its amplitude and phase and carries a proportional number of cycles: half of a three cycle wave is one and a half cycles. Flats stay flat and linears stay linear; curve bends and easings are refit to the cut window.

Pressing Escape or clicking elsewhere drops the selection.`,
  },
  "editor-playhead": {
    title: "Playhead",
    short: "The transport's position, aligned with the timeline below.",
    long: `The gold vertical line marks the transport's current time inside the automation editor, aligned with the timeline below. It only moves with the transport; clicks inside the editor place the silver cursor instead. Seeking still happens on the timeline.`,
  },
  "edit-cursor": {
    title: "Cursor",
    short: "A clicked position in time. Paste lands here.",
    long: `The silver vertical line marks the position placed by clicking empty space in the automation editor. It is independent of the transport: the gold playhead keeps following playback while the cursor stays put. Paste lays the clipboard down starting at the cursor.`,
  },
  "paste-action": {
    title: "Paste",
    short: "Lays the copied curve down at the cursor.",
    long: `Paste places the clipboard's contents starting at the cursor, replacing whatever the curve held in that window. When the cursor bisects a segment, a keyframe is pinned at the intersection first, so the curve to the left of the cursor is unchanged and the paste steps off it. The copied span keeps its length; a clip running past the end of the song is trimmed, shortening any segment it cuts through. The clipboard is shared between lanes, so a window copied from one parameter can be pasted into another.`,
  },
  "automation-scale": {
    title: "Value Scale",
    short: "The visible value range. It follows the curve automatically.",
    long: `The scale labels the value range currently visible in the automation editor. Ticks sit at rounded values.

A parameter that is a switch, zero or one in single steps, shows On and Off in place of numbers. Every edit in such a lane snaps to the two states and every segment is a flat step; there are no curves to bend and no segment types to choose.

A parameter that declares a minimum and maximum uses that range, fixed, drawn with a small margin so the bounds sit a tenth of the view in from the edges; edits clamp to the declared range. For unbounded parameters the range manages itself: it is always centered on zero and spans a symmetric power-of-two pair, negative one to one, then negative two to two, then negative four to four, and so on. The point of the curve furthest from zero dictates the self-managed range: a wave segment's peaks and an overshooting easing count, not only the keyframes. While a drag is in progress the range holds still, even in the top or bottom ten percent of the view. Releasing the drag refits it to the smallest pair that keeps that keyframe outside the ten percent bands, growing or shrinking as needed. There is no manual zoom, and the time axis is never affected.

Dashed horizontal guides cross the editor at every multiple of an eighth of the range's radius. The guides are pinned to values, moving with the scale as the range animates, and thin out whenever they would crowd together.`,
  },
  "segment-menu": {
    title: "Segment Type",
    short: "Sets how the curve travels between two keyframes.",
    long: `Each segment between two keyframes has a type, chosen by right clicking the segment. The types mirror the variations of the main experience editor.

Curve is the default: a straight line that bends toward the cursor when dragged up or down. Flat holds the first keyframe's value for the whole segment, then steps to the second. Linear is a fixed straight line that does not bend. Wave oscillates around the straight line between the keyframes with a sine, square, or triangle shape. Easing travels between the keyframes along a named easing function.

The current type is marked in the menu. Choosing a type resets the segment's parameters to defaults; the inspector card then edits them. Splitting a segment with a new keyframe gives both halves the original segment's type and parameters. Below the types, the menu also carries the Snap to options; right clicking empty space opens those on their own.`,
  },
  "keyframe-value": {
    title: "Keyframe Value",
    short: "Types an exact value for the right-clicked keyframe.",
    long: `Right click a keyframe to type its value directly: a glowing field opens beside the dot, pre-filled and selected. Enter or clicking away commits (clamped to the parameter's declared range); Escape cancels. Dragging remains the way to move a keyframe in time; typing pins its value exactly. Color and palette keyframes are edited through the inspector instead.`,
  },
  "effect-row": {
    title: "Effect",
    short:
      "Transforms the pattern's output; parameters automate like any other.",
    long: `Effects are shaders that transform the pattern's rendered output: tints, kaleidoscopes, masks, distortions. They apply in order, top to bottom; the arrows reorder and the trash removes one (its automation lanes go with it).

Every effect parameter behaves exactly like a pattern parameter: scrub or type values, open the shared color and palette editors, and right click for an automation lane. Effect lanes carry the effect's name in the automation list.`,
  },
  "add-effect": {
    title: "Add Effect",
    short: "Appends an effect from the catalog to this pattern's chain.",
    long: `Opens the effect catalog inline: tints, masks, kaleidoscopes, projections and more, drawn from the main app's effect library. The chosen effect lands at the end of this pattern's chain, ready to reorder or automate.`,
  },
  "see-through": {
    title: "See Through",
    short: "Thins the editor's backdrop so the canopy shows behind it.",
    long: `The toggle in the editor's bottom right corner makes the expanded automation view slightly transparent: the live canopy renders through the backdrop while every curve, keyframe, and control stays at full strength on top. Toggle it again to restore the solid backdrop. Useful for dialing a curve while watching what it does to the canopy in the same glance.`,
  },
  "snap-menu": {
    title: "Snap To",
    short: "Snaps time edits to the beat grid or the song's transients.",
    long: `Right click anywhere in the automation editor to choose a snap mode. Off places time edits exactly where the pointer is. BPM Grid lands them on the nearest beat of the detected tempo grid. Transients lands them on the nearest detected hit in the song itself: kicks, snares, and other onsets found by analyzing the audio, which is often tighter than the grid for humanized material.

Snapping applies to dragging keyframes, creating keyframes with a double click, placing the edit cursor, and both edges of a time selection. A grid or transient option is dimmed until a song is loaded and its analysis has finished.`,
  },
  "segment-inspector": {
    title: "Segment Inspector",
    short: "Edits the selected segment's type and parameters.",
    long: `The inspector card appears in the upper left of the automation editor when a segment is selected by clicking it. The top row switches the segment's type; the rows below it hold the parameters of that type.

A curve segment has a bend amount: one is linear, values below one bow early, values above one bow late. A wave segment has a shape (sine, square, or triangle), an amplitude in value units, a cycle count across the segment, and a phase in fractions of a cycle. An easing segment has a mode (in, out, or in and out) and a family, from gentle trigonometric shapes to bouncing ones. Flat and linear segments have no parameters.

Numbers here edit like the pattern editor's: drag up or down to change them, hold shift for fine steps, click to type a value. Pressing Escape or clicking empty space drops the selection and hides the inspector.`,
  },
};

export const getDoc = (key: string | null): DocEntry =>
  (key && docs[key]) || docs.welcome;
