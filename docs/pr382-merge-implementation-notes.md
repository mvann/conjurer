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

## Questions for the owner (batched)

- (none yet)

## Cleanup at the end

- Remove the /private/tmp worktree's stray branch + uncommitted
  copies; keep or drop the worktree itself.
- Reconcile package.json test-script additions with the merged tree.
