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
- NEXT (the big one): wire /editor onto their Store — StoreContext
  provider on the editor page, ExperienceStore load pipeline,
  EditorV2Page reading store.layers/blocks instead of entries[].
  Then: lone-flat read model, lanedParams, block timing UI, u_time
  block-local transport drive, per-input merge opacity + crossfade.
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
