# pr382-merge: implementation notes

Running log of assumptions made and questions deferred during the
build, per the owner's instruction: keep going, track, review after.

## Assumptions made (review these)

1. **Branch strategy**: `pr382-merge` off `dev` (linear history), PR
   #382 content squash-merged as one commit at 369c255, the three
   upstream fixes cherry-picked on top as their own commits. `dev`
   itself untouched; the demo deploy (dev-only trigger) unaffected.
   Pushed to origin as a backup branch.
2. **Conflict resolutions** in the squash: layer header keeps dev's
   layer-management chrome (drag/collapse/rename/delete) and adopts
   the PR's deletion of the legacy variation gutter; palette editor
   keeps dev's backgroundClip fix.
3. The throwaway worktree branch `spell-crafter-pr382` in
   /private/tmp/conjurer-parameter-editor-overhaul carried the fix
   commits and an aborted port direction; superseded, will be
   cleaned up at the end (worktree kept meanwhile as the pinned
   369c255 reference).
4. dev/main already gained layer management (add/remove/reorder/
   rename/collapse) that the PR-at-369c255 lacked — the merged tree
   has BOTH layer management and regions. The plan's decision 28 UI
   still governs Spell Crafter's own layer list.

## Progress log

- DONE: three upstream `fix:` commits (smoothing, layer visibility,
  unknown-pattern guard), cherry-picked onto the branch.
- DONE: PR #382 squash-merged onto dev lineage (`1a94e38`); full e2e
  battery green (73/73 after adding the settleBox wait to the
  boolean-lane test); branch pushed to origin as `pr382-merge`.
- DONE: `migrateLegacySave` module + `yarn test:migrate` unit suite
  (emits serialized literals; ts-node-safe; covers constants, fits,
  steps, waves incl. triangle-phase quirk, audio, deactivated curves,
  value lanes, effects, visibility→u_opacity, no-song basis).
- DONE: /editor provides Store("experienceEditor") + StoreContext;
  initializeClientSide loads ?experience= (or untitled) through the
  shared pipeline; EditorV2Page is an observer; header shows
  "name by author" (decision 18). Battery still 73/73 (legacy state
  still drives the UI).
- DONE (slice A, 537c797): LayersPanel replaces PatternsPanel —
  layers with rename/eye/trash, per-layer Add Pattern inserting
  full-song blocks, effects via Block APIs, right-click Duplicate.
  Canopy renders visible layers' blocks; per-frame driver evaluates
  each active block's regions at block-local time. Legacy
  entries/wrapper/undo/autosave/save/assign/visibility-lanes deleted
  from the page. Lane-dependent suites parked (describe.skip):
  automation, snap, effects, canopy, persistence. panels.spec
  rewritten (layers). helpers: openPatternPanel waits "Layers";
  insertPattern uses [data-doc=add-pattern].
- DONE (slice B1, 5241fad): RegionLanesPane — layer/block/param lane
  hierarchy, block extent bars, lone-flat convention + lanedParams
  promotion/expand-shrink, sampled polyline previews, value tiles,
  self-sizing pane. lanes.spec (5 tests) loads a fixture experience
  through store.experienceStore.loadExperience.
- NEXT, in order:
  1. Block timing drags on the bar (decision 10): left/right edge
     trim (regions untouched, decision 16), whole-bar move; dimmed
     zones arrive with the editor re-base.
  2. Expanded editor re-base (the monster): AutomationEditorView
     rewritten against CurveVariation nodes + region segments,
     keyframe=node-in-curves/boundary-elsewhere (decision 13),
     generators with boundary stacks (14), unzip/zip, right-click
     retype, snap integration, dimming outside the block (11/dimmed
     zones do nothing), lane click opens it. Un-park automation/
     snap/effects/canopy specs progressively, rewritten.
  3. Save/autosave: useSaveExperience path (needs ChakraProvider on
     the editor page), draft channel (nonce-keyed), updatedAt
     comparison; legacy-save migration wired into load (uses
     migrateLegacySave + song duration).
  4. Demo seam: tRPC custom link backed by localStorage + Gandalf
     user; demo redeploy.
  5. UI restructure leftovers (task 7): gear/settings pane (27, with
     verified menu order), header user/roles (18), chevron sliver
     (29), backdrop toggle buttons (30), performance overlay (31),
     orientation (32), opacity pseudo-param row (25), Info Strip
     rewrite, keyboard bindings (27b), OS-clipboard interop.
- THEN: demo seam (tRPC custom link, Gandalf user), UI restructure
  (task 7), gear pane, orientation, docs/Info Strip, e2e rework.

## Additional assumptions (review these)

5. Migration honors old `active:false` semantics at conversion time:
   inactive curve → manual value as lone constant, curve dropped.
6. Migration seeds no `lanedParams` (armed-but-empty legacy lanes are
   dropped; rare). Real lanes surface automatically as non-constant.
7. `tsconfig.script.json` gained baseUrl/paths + tsconfig-paths so
   test scripts can use `@/` imports.
8. The demo stub is deferred until after the Store wiring; local dev
   uses the real local DB meanwhile.

## Questions for the owner (batched)

- (none yet — decisions covered everything so far)

## Cleanup at the end

- Remove the /private/tmp worktree's stray branch + uncommitted
  copies; keep or drop the worktree itself.
- Reconcile package.json test-script additions with the merged tree.
