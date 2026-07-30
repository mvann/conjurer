# Spell Crafter ↔ PR #382: merge plan (working notes)

Living document for the planning conversation. Each session adds to it;
nothing here is committed-to until the plan is done.

## Goal

Merge Spell Crafter with the PR #382 branch such that Spell Crafter
adopts the PR's save model outright.

## Constraints (as stated)

1. **Adopt their save model.** Spell Crafter reads and writes the PR's
   experience blob — the `experiences` row with
   `data: { layers: [{ id, name, blockMap }] }` and region-based
   variations.
2. **Change nothing of theirs.** No modifications to the PR's format,
   code, or behavior should be required to accommodate Spell Crafter.
3. **Add no new information.** No new fields, no side-channel data in
   the blob. Spell Crafter's concepts must map onto existing fields
   only.
4. **Two-way compatibility.** An experience authored in the PR's UI
   opens in Spell Crafter; an experience authored in Spell Crafter
   opens in the PR's UI. Both directions, no loss that breaks the
   other editor.
5. **Not merging code yet.** This is a data/model plan first.

## Mapping decisions (to be filled in as we talk)

### UI restructure

1. **The left pane becomes a layer list, not a pattern list.** Layers
   contain patterns exactly as the data model has it
   (`layers → blockMap → blocks`, each block carrying a pattern).
2. **Patterns in the list represent blocks.**
3. **Blocks live in the automation lanes area as groups.** Each block
   gets one lane of its own — a header lane, labeled with the pattern
   name (e.g. "Nebula") on the left — and beneath it, one lane per
   automated parameter of that block.
4. **The block's own lane is a spacer for now.** It carries no curve
   yet; opacity may live there in the future (which would line up with
   the PR's `u_opacity` channel). For now its job is to group and
   label.

### Manual-value takeover

6. **Takeover behavior stays, but as memory-only state.** Scrubbing an
   automated parameter still deactivates its curve with the full
   current behavior (red edge, "Re-enable Automation", manual value
   drives). But the deactivated flag (`active: false`) is no longer
   part of the data model — it lives in memory only and is never
   serialized. Consequence, accepted: save while suspended and reload,
   and the curve drives again (the suspended manual value is not
   stored). The UI should make it clear this state does not persist.

### Block timing

10. **Blocks are edge-resizable in their header lane.** Lane labels
    stay in the left column as today; the block renders as a time-range
    bar inside the lanes plot area. Edge semantics (right edge fixed
    unless grabbed):
    - Drag LEFT edge left: start time earlier AND duration grows.
    - Drag RIGHT edge right: duration grows, start unchanged.
    Grabbing the TOP of the bar (the header lane sharing the pattern
    name label) drags the whole block left/right — moving all of its
    keyframes with it. Blocks are real timed clips, matching the PR's
    `startTime`/`duration` — no longer implicitly full-song.
12. **Time is block-local seconds.** Adopted outright — it is what
    the data model does. Song-fraction times are gone; a block's
    curves live in its local timeline and travel when the block moves.

11. **The expanded automation editor dims outside the block.** When a
    lane belonging to a block is opened in the full editor, the view
    still spans the whole song, but everywhere outside the block's
    time frame is darkened.

### Segments become regions

13. **Storage is the PR's region list, always fully tiling the
    block.** Spell Crafter maintains the partition invariant itself.
    No "add region" UI. Default interpolation is the PR's Bézier
    curve (handles); right-click on a segment still changes its type.
    "I have segments, they have regions — same thing." Refined
    keyframe semantics (after Claude's merge-survival point):
    - Double-click inside a CURVE span: adds a node. No split.
    - Double-click inside a NON-curve region (e.g. a wave): splits it
      into two regions of the same type at that point.
    - Right-click the segment between two adjacent keyframes: change
      its type → that span becomes its own region (splitting the
      containing region at the bounding keyframes as needed; merging
      applies when retyping back to curve).
    - Flag (Claude): splitting a wave should phase-correct the right
      half (their periodic time is region-local) so the waveform is
      visually unchanged by the split.

14. **Generator semantics (waves AND anything offset-based, e.g.
    audio): PR's flat generator, adopted.** offset = y-axis
    center (constant; waves can never sit on an angle), period in
    seconds (NO whole-cycle snapping — rejected), phase in radians.
    Continuity is never a model invariant — only a courtesy at
    creation. Boundary UI:
    - Creating a wave seeds offset from the LEFT boundary value with
      phase 0 (starts lined up); the right side lands wherever the
      sine lands.
    - Creating a wave also creates its OWN keyframe UI elements at
      both boundaries, stacked on the neighbors' keyframes at the
      same times. Dragging a stacked pair picks one — the wave is
      value-decoupled from its neighbors; dragging the wave's own
      keyframe edits the wave (offset), dragging the flat's edits the
      flat.
    - RESOLVED: dragging EITHER edge keyframe vertically moves the
      whole generator's offset.
    - RESOLVED: time-dragging a stacked pair apart does NOT trim the
      neighbors — it opens a new Bézier curve segment between the two
      keyframes, a transition region connecting the two values.
    - Inverse rule: dragging a curve segment's endpoints together
      until it is a zero-width vertical line (neighbors non-curve)
      deletes the degenerate region from the data — the stack itself
      encodes the step. (Claude endorses: it is the exact inverse of
      the pull-apart gesture, and zero-duration regions are junk their
      editor never creates; with curve neighbors the adjacent-curve
      merge handles it instead. Not overcomplicated — it is hygiene.)

15. **Waves are defined by frequency + phase in the inspector.**
    Dragging the region's right edge outward reveals MORE cycles —
    the wave never stretches. This is exactly the PR's storage
    semantics (period fixed in seconds, independent of duration);
    inspector frequency = 1/period. Phase stored in radians; display
    unit is a UI choice.
    - Claude's analysis (what does/doesn't work): see readback of
      2026-07-27. Key adjustments: within curve spans a keyframe must
      be a NODE (their editor structurally merges adjacent curve
      regions, so split-curves don't survive); region boundaries exist
      only at type changes; wave/audio segments must adopt the PR's
      ABSOLUTE generator semantics (endpoint-riding baseline is not
      representable); easing is better as a handle preset than a
      stored type (their load pipeline bakes easing to curves anyway);
      grid/transient snap carries over with a startTime subtraction.

### Manual values and the lone-flat convention

7. **A lone flat region IS the manual value.** On load, a parameter
   whose variation list is a single flat (or a constant curve region)
   gets no automation lane. Scrubbing its value in the pattern list
   writes straight through to that flat region — the blob stays the
   single source of truth at all times, no save-time backfill logic
   needed. (Should apply equally to the other constant fingerprints:
   `linear4` with from == to, lone palette variation.)
8. **Adding a lane promotes the flat to true automation — in memory.**
   Once the user expresses intent by adding an automation lane for
   such a parameter, the same flat region is thereafter treated as a
   real automation: the lane appears (showing the flat line), and
   scrubbing the manual value now triggers takeover/deactivation
   (decision 6) instead of writing through. The flat-vs-manual
   distinction is memory-only; the blob never changes shape.
   - Rejected along the way: using `lanedParams` as the "has
     automation" list — it isn't persisted and it's open-lane view
     state, not automation existence.
   - RESOLVED how: the promotion flag is membership in the PR's
     `lanedParams` (decision 9). Because that store persists
     (localStorage, keyed by experience + block), promotion survives
     reload per-browser — the earlier demotion-on-reload concern is
     closed. Accepted trade: closing the lane in EITHER editor demotes
     a lone flat back to manual value; that is shared semantics, not a
     bug.

9. **Lanes get an expand/shrink control, backed by `lanedParams`.**
   Every automation lane has a button toggling it between the current
   lane height ("expanded" — the normal lane view, not the full-screen
   editor) and a single line ("shrunk"). `lanedParams` records which
   are expanded. Its meaning by case:
   - Real (non-constant) automation: always shown as a lane; in
     `lanedParams` = expanded, absent = shrunk to a single line.
   - Lone flat: in `lanedParams` = promoted, shown as a true
     automation lane with takeover semantics; absent = no lane at all,
     the flat is the manual value and scrubbing writes through to it.
   - Cross-editor note: upstream, absence means "no lane shown at
     all" even for real automations; Spell Crafter shows shrunk lanes
     instead. Display divergence only — no data consequences.

### Panel chevron

29. **The open/close chevron lives INSIDE the side panel now.** A
    sliver of the panel always sticks out past the closed edge, with
    the chevron in it — always visible, always clickable. The chevron
    moves slightly left of its current position (into the sliver) and
    gets a little smaller.

### Gear pane ordering (verified against 369c255's MenuBar)

Items appear in THEIR menu order, sections separated by unnamed
hairlines: [file group] New experience, Open…, Save, Save as… /
[edit group] Copy experience JSON to clipboard / [view group] Render size
(256/512/1024, as theirs), Display mode (canopy / cartesian space /
canopy space), Show performance overlay — in their View-menu order / [tools group] Transmit data to canopy, Set
audio latency (shows current ms, as theirs does), Admin, Playground
(no upstream menu slot exists — PatternDrawer links it; placed
beside Admin) / [help group] About Conjurer, Keyboard shortcuts,
Laws of Conjury, Report an issue.

### Performance overlay

31. **Reuse their performance overlay's machinery, restyled to Spell
    Crafter's look.** (Owner briefly considered keeping their styling;
    final call: ours.)

### App orientation (decision 32 — ACCEPTED, amended)

32. **Adopt their horizontalLayout flag** (shared uiStore +
    localStorage UI settings). Vertical = current stacked layout.
    Horizontal = **canopy docks LEFT as a full-height column;
    timeline + all automation on the RIGHT**. In horizontal mode the
    expanded automation view is permanently open — the ✕ close
    button disappears; it never closes. Widescreen support is the
    point. "App orientation" sits FIRST in the gear's view group,
    matching their View menu order.

### Backdrop toggles

30. **The expanded editor's backdrop menu becomes two separate
    toggle buttons.** Canopy backdrop = the little teardrop shape;
    waveform backdrop = the same waveform-looking icon the conjurer
    app uses for its waveform toggle. Both remain toggles.

### Header

18. **Header, right side, in Spell Crafter styling:** user display in
    the top right exactly as upstream has it; to its left, the roles
    dropdown, showing "Spell Crafter (alpha)". SUPERSEDED: no Save
    button in the top bar — Save lives ONLY in the gear/settings
    pane. Next to
    "Spell Crafter" in the nav bar: the current experience shown as
    "name by author", exactly as the main app displays it.

### Visibility

5. **Visibility moves from patterns to layers, and stops being
   automatable.** Pattern-level visibility (and its `__visibility`
   automation lane) goes away. The layer's eye behaves exactly as
   upstream layers do: a runtime/in-memory toggle, not serialized —
   whatever the PR does, Spell Crafter does. No visibility curve
   anywhere.

## Open questions / hard spots (flagged, not yet decided)

- ~~Manual value / intent~~ — RESOLVED by decisions 7–8: lone-flat =
  manual value with write-through; adding a lane promotes it, in
  memory. Remaining sub-question: whether to persist the promotion in
  localStorage à la `lanedParams`.
- ~~Visibility lanes~~ — RESOLVED: visibility automation is dropped;
  visibility lives on the layer, runtime-only, matching upstream (see
  decision 5).
- **`laneOrder`** (lane display order). No home in the blob. Candidate:
  localStorage next to the PR's `lanedParams` (same philosophy: view
  state stays out of the row).
- ~~Time model~~ — RESOLVED (decision 12): block-local seconds,
  adopted outright because that is what the data model does. Curves
  travel with their block. PENDING: user will explain how keyframes
  shift on block resize in the new model.
- **Segment vocabulary.** wave→periodic, audio→audio, curve/easing→
  curve regions (Bézier fit). Lossy direction: free Béziers back into
  named segment types.

## Mid-plan audit (requested; not the final one)

Fact found in their code: **block resize does not touch regions at
all.** Right-trim leaves regions overhanging (unplayed); extension
leaves the tail holding the last value; left-trim slides ALL automation
along with the edge (region time is block-local). Their partition
invariant is maintained by lane edits only, not by block edits.

Outstanding decisions:
1. ~~Block-resize keyframe behavior~~ — RESOLVED (decision 16): match
   theirs exactly. Regions untouched on resize; extending the right
   edge holds the last value implicitly (NO flat region added to the
   data); a wave's region keeps its size and does not oscillate into
   the extension — the value freezes at the region's end.
2. ~~Storage transport~~ — RESOLVED (decision 17): use their plumbing
   verbatim (ExperienceStore/Store + tRPC row handling; version 2;
   pass through columns Spell Crafter does not render). Autosave
   becomes a localStorage draft keyed by experience, compared against
   the row for the "autosave is ahead" prompt. DEMO MODE: stub the
   API at the seam — a localStorage-backed implementation of the
   experience client (and the demo song fetch), swapped in when
   IS_DEMO. The wrapper SerializedEditorState dies.
3. ~~Songs~~ — RESOLVED (decision 19): the add-song UI/UX stays
   exactly as it is; under the covers it does as close to what the PR
   does as possible (songId + served audio in connected mode; the
   demo stub covers local).
4. ~~Effects mapping~~ — RESOLVED (decision 20): effects work the
   same way patterns do; the mechanical mapping (lane keys → nested
   effect block's parameterVariations, chain order = array order,
   parent-timeline params) is approved as assumed; adjust at
   implementation if reality disagrees.
5. ~~laneOrder~~ — RESOLVED (decision 21): global order dead;
   per-block ordering rides in `lanedParams` itself. The persisted
   form is an ordered array and their save/load round-trips insertion
   order faithfully; their UI renders in param-declaration order (by
   choice, commented) but never rewrites the stored order except on
   toggle. Caveat accepted: reordering shows only in Spell Crafter.
   REFINED: toggling a lane off/on in Spell Crafter must restore its
   position, not append — so Spell Crafter keeps a duplicate
   per-block order memory in its own localStorage. Precedence:
   `lanedParams` order wins for everything in it; anything absent
   (shrunk/closed lanes) takes its position from the shadow order.
   Re-arming inserts at the remembered position (rewriting the array
   in order — harmless; their app is order-blind). Their-UI toggles
   still append; Spell Crafter shows those at the end per precedence.
   Shadow hygiene: (a) the shadow does NOT keep lanes that no longer
   exist — prune stale entries; (b) on load, `lanedParams` order is
   written back into the shadow: the subset present in both reorders
   inside the shadow to match `lanedParams` (absent lanes keep their
   relative slots). The shadow continuously reconciles toward
   `lanedParams`.
6. ~~Existing Spell Crafter saves~~ — RESOLVED (decision 22): migrate
   them (fraction-time → block-local seconds, old wrapper → blob).
   The migration logic ships in the final PR.

Conflicts to accept or resolve:
7. ~~Color lanes~~ — RESOLVED (decision 23): the blob's color region
   is always linear4 from→to (structurally always a gradient;
   constant = from == to). Spell Crafter's UI reading:
   - Load: from == to → shown as a single color.
   - Inspector: a "Gradient" toggle per color segment. Toggling on
     adds a second color, deliberately noticeably different (so the
     change is visible and the region does not immediately re-read
     as constant).
   - Gradient-ness is memory-only UI state: if the user drags the
     second color equal to the first, the session keeps showing the
     gradient UI (in-memory flag), but a reload with from == to
     shows gradient off. In the data model the gradient is "always
     there"; the toggle is an interpretation.
8. Audio smoothing (and layer visibility): lost on their save path —
   upstream serialize bugs. Accept, or land a small upstream bugfix.
9. Render parity beyond the blob: the automatic equal-power crossfade
   (u_opacity absent) and honoring authored u_opacity lanes — must be
   implemented to display their experiences faithfully.
10. Load pipeline: adopt theirs wholesale (V1 migration +
    previewAllParamsAsCurves) so both editors see identical in-memory
    data; otherwise Spell Crafter must handle raw easing/spline
    regions their editor would have baked away.
11. leadIn dissolves (first region starts at block start). Noted, fine.

### Opacity (decision 25)

25. **Opacity is a pseudo-param at the top of every pattern's list.**
    u_opacity is BASE_UNIFORMS upstream (verified: backfill skips it,
    so absence — auto — survives saves); Spell Crafter special-cases
    the row into the list. Tri-state:
    - Absent entry = "auto" (their equal-power crossfade; adopted
      after all — the pushback stays as an upstream review comment).
    - Dragging the value materializes a lone flat = manual opacity
      (decision 7 write-through applies). The auto→manual transition
      is made visible (it kills a live crossfade).
    - Adding a lane promotes via lanedParams (decision 8); on an
      overlapped block, seed from materializeAutoOpacity (the real
      fade), not flat 1.
    - **Right-click the opacity row → "Reset to auto"** (deletes the
      entry; their resetOpacityToAuto).

### Load pipeline (decision 26)

26. **Adopt their load pipeline wholesale** (Store.deserialize: V1→V2
    layer migration + previewAllParamsAsCurves bake). Both editors
    hold identical in-memory data; all fingerprint conventions key on
    post-bake shapes.

## Final audit: what the plan has not covered (2026-07-27)

Ordered by how much design they still need:

1. ~~Experience management UI~~ — RESOLVED (decision 27): the
   settings pane. A gear icon left of the roles dropdown opens a
   full-height pane sliding in from the right (song-pane style)
   holding: Save, Save As, Open, New Experience, Copy experience
   JSON to clipboard, Show Performance Overlay (toggle), Transmit
   Data to Canopy (from their Tools menu), Set Audio Latency.
   Items needing input (Save As, Open, New) slide a second panel
   out to the LEFT of the settings pane — the "New Song" gesture —
   with the dialog/field inside.
   Navigate/Help circle-back RESOLVED: also include Playground and
   Admin (links), About Conjurer, Laws of Conjury, Report an Issue,
   and the rest of the Help section including Keyboard Shortcuts.
   Layout: group items in the same sections as the main app's
   menus, but WITHOUT section names — separated by a hairline /
   clean break only.
   REMINDER (open): keyboard shortcuts — go through theirs one by
   one and assess whether Spell Crafter can adopt them as-is;
   revisit together.
   Demo: pragmatic — do whatever makes the demo keep working; the
   old demo experience's fate is unimportant.
2. ~~Layer & block lifecycle~~ — RESOLVED (decision 28):
   - "Add Layer" button under all layers; "Add Pattern" button
     within each layer under its patterns → adds a full-width block
     (decision 24) to THAT layer. Effects addable per block as
     before. Layers can hold many patterns.
   - Rename: double-click the layer name (same gesture as param
     value editing).
   - Reorder: click-and-hold a layer, drag — real blob data (layer
     array order).
   - Layers appear in the automation lanes area too: a layer lane
     (like a block's header lane), with lanes-area order matching
     the left pane's layer order.
   - Note (Claude): two full-width blocks in one layer fully
     overlap → verify their auto-fade degenerates to full opacity
     there (summing ≈ the old stack behavior), not to a fade.
   - Block delete: assumed = the pattern row's trash, as today.
3. ~~Clipboard & time-selection~~ — RESOLVED: window (time
   selection) operations first SPLIT regions at the selection edges
   (existing split semantics incl. wave phase-correction), then act
   on whole regions. Delete BRIDGES the gap with one curve segment
   connecting the edge values (no ripple). Paste may OVERHANG the
   block's end (overhang is already a legitimate state; unplayed
   until the block grows). Paste OVERWRITES the range it covers
   (split at cursor and cursor+clip-length, swap the middle).
   Cross-lane paste NORMALIZES between ranges: the source lane's
   range maps linearly onto the destination lane's range (shape
   preserved proportionally). Range = the param's declared min/max
   when present, else the lane's current effective (auto-fit) range.
   Same-param pastes map through identity automatically. The linear
   map applies to everything in the clip: node values and handle dv
   scale; generator offset maps and amplitude scales by the ratio.
4. ~~Undo~~ — RESOLVED: same snapshot undo, over their data model;
   lanedParams IS included in snapshots (undoable); takeover flags
   are not. Session-scoped (cleared on refresh) — accepted, so no
   cross-session weirdness. In-place identity restore rebuilt for
   Block/Pattern instances.
5. ~~Concurrent-edit detection~~ — RESOLVED: as described — draft
   compared against the row's updatedAt.
   Also confirmed: full-overlap auto-opacity degenerating to full
   opacity for both blocks is the DESIRED behavior (test it);
   block delete = pattern row trash confirmed.
6. **Un-baked color/palette sequences.** The bake is scalar-only:
   V1 content can carry multi-region linear4/palette sequences with
   real gradients. Decision 23 covers one region; the value-lane UI
   must render/edit SEQUENCES of them.
7. ~~Dimmed zones~~ — RESOLVED: interactions outside the block do
   nothing. A highlight started inside the block clamps at the
   block's edges; double-clicks in the dim are ignored.
8. **Effect opacity exclusion.** Upstream excludes u_opacity from
   effect blocks' lanable params; Spell Crafter's effect param lists
   must exclude it too (per-pattern opacity only).
9. **Demo seed data.** demoExperience.json must be migrated to the
   new blob format and seeded through the demo stub.
10. **Docs/Info Strip.** All copy referencing patterns-as-stack,
    visibility lanes, manual values, and song-fraction times needs
    rewriting to the layer/block vocabulary.
11. **Housekeeping state.** Per-entry `expanded` (pattern list) and
    similar UI state lose their wrapper home → memory or
    localStorage, trivial but must land somewhere.

### Keyboard shortcuts (final)

27b. Adopt theirs: Space, ←/→ scan, Ctrl+/- zoom, Cmd+S save,
    Cmd+Shift+S save-as, Cmd+O open, Cmd+N (parity-bound; browser
    shadows it), Cmd+C/V + Delete/Backspace for TIME-SELECTION
    clipboard, E (+ their Enter alias) for keyframe value. Keep Spell
    Crafter's Escape peel and Cmd+Z/Shift+Z undo (superset). NOT
    adopted: block selection, Cmd+A, Cmd+D — rejected outright.
    Block duplication instead: right-click the block's header lane →
    Duplicate → copy drops directly beneath (mirrors the pattern
    list's right-click Duplicate, which also stays). No hotkey.
    The Keyboard Shortcuts reference lives in the gear/settings pane
    (Help section group), listing the final adopted set above.

## Second-pass gaps (Claude's verified additions)

A. RESOLVED: demo stub fakes auth with demo user "Gandalf".
B. RESOLVED: third upstream fix: commit — loader skips unknown
   pattern names (with a console warning) instead of crashing.
C. RESOLVED: migrated old saves land as an unsaved-work draft (no
   auto-opened Save As). Autosave association: the migrated blob
   simply lands IN the draft channel — the same nonce-keyed draft
   slot new experiences autosave to — so it needs no special case;
   it persists like any unsaved work until saved to a row.
D. RESOLVED: nonce-keyed drafts until first save assigns the id.
E. RESOLVED: pin 369c255, build against it, rebase late and
   deliberately; re-verify decisions 13–16/25 after upstream changes.
F. Verified non-gap: song upload exists upstream (S3 + /api/upload +
   createSong) — decision 19 implementable as stated.

## Clean-room follow-up resolutions

- Sub-0.1s regions: migration merges/deletes them. At runtime, Spell
  Crafter does NOT enforce the minimum (copy-paste may produce tiny
  regions; accepted — it is their UX preference, not a correctness
  rule).
- Ramped waves/audio in legacy saves: fit-with-fallback (Claude's
  call; owner indifferent — few exist).
- No-song legacy saves: migrate on a nominal 60s basis (Claude's
  call).
- Deactivated-curve localStorage stash: REJECTED with rationale —
  persisting takeover would make the manual value feel like real
  data when it is deliberately not part of the experience. Decision
  6 (memory-only) stands.
- ColorRemap: branch skew (added to main 2026-07-24), self-resolves
  on the PR's rebase; the unknown-pattern guard commit covers the
  window.
- Audio smoothing fix commit: persist the field with THEIR
  evaluation semantics; Spell Crafter's evaluator adopts their
  envelope function for parity.
- Permission-check bug: left as a REVIEW COMMENT on the PR, not a
  fix commit (server behavior change — bigger blast radius than the
  serializer one-liners).
- OS-clipboard interop (their text/plain serialized-block format):
  adopted as a small implementation item.

## My standing duties

- User will resolve most contradictions with the current Spell Crafter
  model as the plan unfolds; do not litigate each one mid-stream.
- **At the end: audit the plan and report what was forgotten** —
  Spell Crafter features with no home, mapping gaps, interop holes.

## Heard, verbatim-ish log

- Wants Spell Crafter to use the same save model as the PR so nothing
  of theirs must change; no new information added; experiences created
  in either UI open in the other. Code merge comes later; plan first.
- Left pane: layer list (layers hold patterns per the data model), not
  a pattern list. Patterns represent blocks. Lanes area shows one
  header lane per block (labeled with the pattern name) with that
  block's automated parameter lanes nested under it. The block lane is
  spacer-only for now; opacity later, maybe.
- Will fix own model contradictions along the way; Claude audits for
  forgotten things at the end. Visibility: layer-level only, same as
  upstream (runtime, unserialized), not automatable anymore.
- Manual-value takeover (deactivate/re-enable) kept as behavior but
  memory-only; doesn't persist; UI should say so. Loading-an-experience
  topic deferred to next.
