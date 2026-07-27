# Spell Crafter vs PR #382 — decision list

Every meaningful difference between this branch's editor (`/editor`)
and upstream PR #382 (`parameter-editor-overhaul`: automation lanes,
region editor, parameter panel), as a checklist to work through one by
one. For each item: what differs, and the options as I see them.
Check items off with a decision noted inline.

Context: both build direct-manipulation parameter animation. Theirs
retrofits the main experience editor (per-block, MobX, DB-backed, V1
to V2 migration). Ours is the standalone spell crafter (song-global,
localStorage, schemas untouched). Scale is comparable.

## Architecture

- [ ] **Time model: per-block regions vs song-global curves.** Their
      lanes span one block; regions partition the block's span exactly
      (every operation conserves total time). Our curves span the whole
      song in fractional time, over an always-on merged stack. This is the
      deepest divergence and mostly a product question: sequenced blocks
      vs VJ-style stack. Options: keep both as different roles; adopt
      block-scoping later; or map our curves onto their regions at the
      plugin boundary.

- [ ] **Value model: Bezier regions vs typed segments.** Their Curve
      region is freeform pen-tool cubic Beziers (nodes with independent
      in/out handles; value-at-time solves X(s)=t). Ours is keyframes with
      typed segments (Schlick curve, flat, linear, wave, easing, audio).
      Segments are structured and clipboard-exact; Beziers are freer to
      draw. Options: keep segments; add a "bezier" segment type for
      freeform stretches; or full convergence (segments are representable
      as Beziers, so a lossless export in that direction exists).

- [ ] **Two serialization formats for animation.** If #382 lands,
      upstream has regions/CurveVariation while we have AutomationCurve in
      localStorage. The plugin plan eventually needs one format or a
      mapping layer. Waves map to their LFO, audio to their Audio, curves
      approximately to Beziers. Decide when to write the converter and in
      which direction.

- [ ] **MergeNode opacity (collision).** They changed MergeNode to
      take per-frame opacity uniforms for crossfades; our CanopyPane
      renders through MergeNode. First rebase onto their branch must
      update StackPipeline. Low effort, but track it.

## Features they have that we lack

- [x] **Audio-reactive value source.** DONE 2026-07-27: audio segment
      type (factor x loudness at absolute song time + smoothing), matching
      AudioVariation semantics.

- [x] **Effect chains with automatable params.** DONE 2026-07-27:
      per-pattern effect chains, add/reorder/remove, effect:<id>:<uniform>
      lanes.

- [ ] **Per-block opacity + automatic crossfades.** Overlapping blocks
      crossfade live; each block can hold a manual opacity curve. Our
      stack sums patterns with no per-pattern level control at all. A
      per-pattern opacity (automatable like visibility, but continuous)
      would be the equivalent, and is probably the highest-value item in
      this list for us.

- [ ] **Dot-row glanceability.** Per-block dots showing which params
      are animated vs at default (diamonds for effects); click a dot to
      open that param's lane. Our equivalents are the green/red lane edges
      inside the pattern editor, visible only when expanded. Worth a
      glance-level affordance on collapsed pattern rows?

- [ ] **Region bar operations.** Add/insert a region by painting a
      span, resize by dragging seams, remove with neighbors backfilling,
      convert type in place. Our closest tools are segment type conversion
      plus clipboard windows. The "paint a span to insert" gesture is the
      one we genuinely lack; the rest roughly correspond.

- [ ] **Per-region value range (min/max).** Each region can declare
      the range it maps into. Ours is per-parameter (declared bounds or
      the self-managing power-of-two range). Decide if per-segment ranges
      are wanted; possibly subsumed by wave amplitude + keyframe values.

- [ ] **Numeric node editor via keyboard ("e"/Enter).** They open a
      numeric editor on the selected node from the keyboard. We have
      right-click-to-type on keyframes. Adding the keyboard path to the
      selected segment's keyframes would be cheap parity.

- [ ] **Versioned data migration.** They migrate V1 experience data in
      memory, non-destructively, re-saving only on explicit save. We have
      no versioning on the localStorage format (old saves survive by
      tolerant parsing). Adopt a version field before the demo's format
      spreads further?

## Features we have that they lack

(No action needed; leverage/UPstreaming material. Listed so the
comparison is honest in both directions.)

- Tempo analysis (sub-ms beat grid) and transient detection, with
  snap-to-grid and snap-to-transient editing.
- Structured segment types with exact clipboard slicing (wave cycles,
  phase carry, flush paste).
- Boolean on/off lanes; whole-value color/palette period lanes with
  lead-in.
- Activation/takeover semantics with the manual value line (they
  arm/disarm lanes; we round-trip control between hand and curve).
- Custom audio engine: blob playback, smoothed playback clock,
  waveform/minimap renderer, waveform backdrop in the editor.
- Undo/redo with live-instance identity preservation.
- Info strip + press-? manual.
- Test infrastructure: seven unit suites plus ~70 e2e tests including
  pixel assertions on the rendered canopy.

## Process differences

- [ ] **They ship inside the main editor; we ship beside it.** The
      role/plugin question: whether the spell crafter stays a separate
      role, replaces the experience editor's parameter UI, or both ship.
      This decision shapes every convergence item above; probably worth
      raising with brollin/milotoor on the PR itself.
