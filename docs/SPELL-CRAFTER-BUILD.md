# Spell Crafter → upstream data model: build contract

Read this file first. It is the working contract for adapting Spell Crafter
(`/editor`, `src/components/EditorV2/`) onto the data model that landed
upstream in PR #382, so the result can squash-merge onto `SotSF/conjurer:main`
as a purely additive change.

## The goal

Take everything that works about the Spell Crafter editor and adapt it so it
runs on the upstream `Block`/`LayerV2`/region data model. Owner's framing:

> The goal is basically take everything that's working about the first editor
> and then just adapt it so that it can work for the new data model, which
> includes some radical changes like the blocks.

Deliverable shape: a branch whose diff against `upstream/main` reads as "adds
the Spell Crafter editor." Git history is disposable (we squash); only the
final file set matters. **No PR without the owner's explicit approval.**

## Why the previous attempt failed — do not repeat this

A prior branch (`pr382-merge`, tip `d8c9f3e`, preserved under tag
`pr382-merge-snapshot`) implemented this same plan and had to be abandoned.
58 of its 84 commits were repairs to damage it caused. The diagnosis, in the
owner's words:

> It wasn't even so much that the earlier model started a new editor from
> scratch. It was more that it abandoned a lot of the decisions and design
> decisions that were in the old editor.

Mechanically what happened: the plan says *"every Spell Crafter UI concept
becomes a **view** over that model."* The implementation correctly built the
read-model adapter (`laneModel.ts`, projecting regions into view keyframes and
spans) — and then wrote a brand-new view (`RegionEditorView`) instead of
feeding that adapter into the existing, working `AutomationEditorView`. The old
editor was left in the tree referenced by nothing. It built the adapter and
never used it for its purpose.

Consequences that followed from that one move, all reported by the owner as
bugs: the lane preview stopped lining up with the expanded editor, the waveform
backdrop drew outside its box, automation curves stopped spanning their block,
and the color/palette lane became a stripped-down editor with no grid or
backdrop toggles. On `dev` the preview and the expanded editor shared one time
viewport and one `laneViewRange` helper, which is *why* the preview was a
faithful scale model. The rewrite gave each its own, independently computed.

### Hard rules

1. **Port, never re-author.** Adapt the existing component. If a file becomes
   unreferenced, that is the smell — stop and check whether it should have been
   adapted instead.
2. **One source of time mapping and value range** shared between a lane preview
   and its expanded editor. Never let them compute their own.
3. **Never delete guard tests.** `dev`'s `e2e/automation.spec.ts` (994 lines),
   `effects.spec.ts`, and `snap.spec.ts` were deleted last time, which is how
   the branch reported "47/47 green" over a visibly broken editor. Port them.
4. **`dev` running side by side is the oracle**, not a feature ledger document.
   A ledger was tried and the owner's verdict was "the ledger doesn't seem to
   work at all."
5. **Re-read the spec at every step boundary.** Context goes stale; the
   transcript does not. See below.
6. **Open questions go to the owner**, not to my own judgment. Where the plan
   flags something undesigned, ask rather than guess.
7. **Commit after each feature increment**, so any regression stays bisectable.

## Where the spec lives

The authoritative specification is the session transcript, not this repo. The
owner is emphatic about this:

> The transcript, it seems like, has most of that spec more so than anything
> else, which is why I keep referencing the transcript.

Durable extracts (survive context compaction), at
`~/.claude/projects/-Users-mvann-GitHub-mvann-conjurer/spec/`:

| file | what it is |
|---|---|
| `SPEC-user.txt` | 532 deduped owner messages, the authoritative voice. Grep this first. |
| `SPEC-full.txt` | Full conversation, user + assistant, 8202 lines. Line refs `@@L<n>` point into the raw JSONL. |
| `merge-plan.md` | The 530-line plan: 32 decisions + audits. Also committed here as `docs/spell-crafter-pr382-merge-plan.md`. |
| `decision-list.md` | The pre-merge difference inventory (`docs/spell-crafter-vs-pr382.md`). |

Raw transcript: `~/.claude/projects/-Users-mvann-GitHub-mvann-conjurer/52cf8c7c-6c1a-50ff-9449-f47e2b8c1f77.jsonl` (79MB, 19640 lines — never read whole).

Before implementing any feature, grep `SPEC-user.txt` for it and read how `dev`
did it (`git show dev:<path>`). Both, every time.

## What must survive unchanged

The plan is worded as continuity throughout — the owner's UX is the invariant,
the data model is the only thing that moves. Verbatim from the plan and
transcript: *takeover behavior stays* · *right-click on a segment **still**
changes its type* · *all of my grid stuff should work just the same* · *grid and
transient snapping carry over untouched* · *my UI for adding songs stays the
same* · *the lane labels keep their left column exactly as today* · Escape and
Cmd+Z *keep yours — a strict superset* · undo is the *same snapshot undo, over
their data model* · the clipboard *re-bases* on `CurveVariation.splitAtTime`.

**Decision 24 is the keystone.** New blocks get `startTime 0, duration = song
length`, so a Spell Crafter user never discovers blocks exist unless they grab
an edge. That is what lets the always-on VJ stack survive on a sequenced block
model. Verified safe: `LayerV2.autoFadeWindows` uses strict inequalities, so
identical-span blocks generate no crossfade and composite additively — which is
exactly `CanopyPane`'s existing semantics.

## Build order

From the plan's own dependency ordering:

1. Three upstream `fix:` commits — audio smoothing, layer visibility, unknown-pattern guard. **Re-check whether upstream already fixed these.**
2. Data foundation — adopt their types/store/load pipeline (26), tRPC seam + demo stub (17), legacy save migration (22).
3. Model semantics — regions-as-segments (13–15), lone-flat manual value (7–8), block timing (10–12, 16, 24).
4. UI restructure — layer list pane (1–2, 28), lanes hierarchy (3–4), `lanedParams` + shadow ordering (9, 21), opacity row (25).
5. Interactions — clipboard/selection with range normalization, gradient rendering, dimmed zones, generator boundary stacks, unzip/zip.
6. Chrome — header (18), gear pane (27), Info Strip rewrite, keyboard bindings.
7. Parity tests — overlap-opacity check, two-way round-trip tests.

## Verification

- `npx tsc --noEmit` — must stay at zero errors.
- `corepack yarn playwright test --project=chrome` — the e2e suite.
- Round-trip test is the objective measure of the whole effort: author through
  their code path → open through Spell Crafter → save → re-read through theirs.
  Sampled evaluation equivalence at 1% tolerance, and structurally idempotent
  on the second cycle (their load pipeline rewrites data on first pass, so
  assert tolerance, never byte equality).
- Dev server on `127.0.0.1:3000` (never `0.0.0.0`).

## Deltas since the plan was written

The plan targeted PR #382 at `369c255`. It merged as `ce98032` — 55 commits
later — plus seven PRs since. Gap E of the plan requires re-verifying decisions
13–16 and 25 against released code. Known deltas:

- **Saw waves.** `PeriodicVariationType` gained `sawUp`/`sawDown` (PR #397). The
  wave vocabulary is five kinds now, not three.
- **A flagged worry is already solved upstream.** Decision 13 flagged that
  splitting a wave must phase-correct the right half. `PeriodicVariation.shiftStart(dt)`
  does exactly that, and handles the triangle phase-unit quirk. Use theirs.
- The auto-crossfade pushback the owner planned to raise on the PR is moot; #382
  merged. We implement their auto-fade per decision 25.

## Progress log

- **`c1309fb`** Merged `upstream/main` (`c1ad601`). Textually clean, zero type
  errors, both `/` and `/editor` render. dev's editor work and upstream's
  main-app work turned out almost entirely disjoint.
- **`59616ec`** The merge plan and this contract, onto the branch.
- **`cf695a5`** Demo publishes from this branch, so pushes refresh the Pages demo.
- **Step 1 done** — the three upstream fixes, each its own `fix:` commit, all
  three still needed on `c1ad601`: `33586b4` AudioVariation smoothing,
  `5dfcf1f` layer visibility, `4ff8f4c` unknown-pattern guard (that one now
  returns undefined and four call sites skip it, instead of taking the whole
  experience down over one renamed pattern).
- **`eac2af5`** Additive model vocabulary: saw waves (upstream grew them in
  #397 after the plan was written) and Bezier handles + `colorTo` on keyframes.
- **`a860609`** **The projection** (`regionCurve.ts`) — region list <-> curve,
  both ways, stateless. `yarn test:regioncurve`, 15 cases: everything exact at
  0.000% except named easings at 0.648% (upstream's own fitter, 1% tolerance).
  Also taught `evaluateSegment` real Bezier evaluation; without it a handled
  segment silently fell back to a Schlick bend of 1, i.e. a straight line,
  flattening every curve arriving from the data model.
- **`c5daed7`** Load and save through the shared store, with the transport
  seam (`experienceClient.ts`) that demo mode swaps for localStorage. **The UI
  still runs on legacy state** — deliberately. Full e2e green (63 passed, 1
  timing flake).
- **`f55b0bd`** Legacy save migration (decision 22), `yarn test:migrate`.
  Establishes the entry→block mapping rules the UI switch will reuse:
  full-song blocks, one layer, lone-constant regions as manual values, effects
  as nested blocks with their lane keys dissolved, visibility as opacity.

Demo deploy from this branch is confirmed working — each push rebuilds the
GitHub Pages demo (`gh run list --repo mvann/conjurer`). Note `gh` defaults to
the UPSTREAM remote here, so always pass `--repo mvann/conjurer`.

Unit suites: `migrate`, `regioncurve`, `autorange`, `clipboard`, `bpm`,
`peaks`, `transients`, `docs` — all green, zero type errors.

- **`810eadb`** The block lane read model (`blockLanes.ts`), `yarn
  test:blocklanes`. Stable curve identity via mobx `computed`, invalidation on
  write, lane existence by the lone-constant convention, effect lanes framed by
  the parent block.

- **Value lanes** — color and palette *sequences* now project both ways, with
  gradients carried on `colorTo` (decision 23). This was the prerequisite that
  blocked touching color lanes at all.
- **`blockStack.ts`** — the block-side operations for layers, patterns, and
  effect chains, implementing decision 24 (full-song blocks) and 28 (layer
  lifecycle). Nothing calls it yet.

### The layer design, and its two gaps

Specified by the owner (@@L10477, @@L11012, @@L18418): the left pane becomes a
layer list holding patterns-as-blocks; the lane hierarchy is layer lane → block
header lane labelled with the pattern name → that block's automated param lanes
beneath; the block's header lane is a spacer for now, opacity maybe later; **Add
Layer** sits under all layers and **Add Pattern** inside each layer, adding a
full-width block to *that* layer; rename by double-clicking the layer name, the
same gesture as a parameter value; reorder by click-and-**hold** then drag, and
layer order is real blob data; layers get their own lane in the automation area,
ordered to match the left pane; assign mode works as in dev but over the layer
panel's params.

Both former gaps are now answered:

- **Layer collapse:** the same gesture as a pattern row in the old pattern list —
  the `FaCaretRight` / `FaCaretDown` caret that toggles `expanded` there toggles
  a layer's collapsed state here. It maps onto upstream's `LayerV2.collapsed`,
  which is editor-only and unserialized, so it costs nothing in the blob.
- **Layer deletion:** proceed as built — mirror upstream, keep the last layer
  (an experience with no layers has nowhere to put a pattern).

### The model swap: DONE

`store.layers` is now the source of truth. `StackEntry` carries its `Block`; a
lane's curve is projected from `block.parameterVariations` on read and written
straight back on edit, so no curve lives in React state. Entry and effect ids
are block ids. Pattern add/remove/duplicate and effect add/remove/reorder are
block operations. Persistence keeps its existing shape but sources curves from
the blocks, so existing saves still load.

**Full e2e suite: 64 of 64** — better than the pre-swap baseline of 63 plus a
flake. All nine unit suites green, zero type errors.

Hard-won details, each of which cost a debugging round and would cost another
if undone:

- **Takeover cannot live on the block.** Decision 6 makes it memory-only, so
  suspension sits beside the projection and folds into the curve's `active`
  flag, leaving every `isCurveActive` call untouched.
- **Arming must NOT seed a region.** Upstream's `setParamLanes` does; adopting
  that erased Spell Crafter's EMPTY lane, which the manual value line and its
  takeover affordances are built around. Decision 7 governs LOADING, not the
  add-lane gesture.
- **The editor works with no song** — its curves are fractions, not seconds —
  so the projection keeps a nominal basis and blocks re-span when a song
  arrives, carrying their lanes with them via `applySongDuration`.
- **Regions carry no start time**; position IS the sum of durations before
  them. The lane is a tiling of spans with keyframes placed INSIDE them.
- **Never let the fitter see a discontinuity.** `fitCurveNodes` requires a
  continuous function; a flat segment steps. Fitting across it subdivides to
  the 64-node ceiling and the lane grows on every edit.
- **`ensureTerminalNode` and whole-span fitting invent keyframes** the author
  never placed. Both avoided.
- **Lane order is arming order** (decision 21, `lanedParams` is insertion
  ordered), not param-declaration order.
- **Restored blocks keep their saved id** — lane order and selections are keyed
  `${entryId}/${laneKey}`.
- **`Block.clone` does not copy `lanedParams`**, so duplication must.
- **Test hooks must be built during render**, not in an effect, or an observer
  never tracks the state they read.

### Decisions made WITHOUT a transcript check — review these

Debugging hides design decisions inside things that look like bugs. These three
were settled mid-debug from code and the plan rather than from the owner's own
words. All three were checked afterwards; none contradicted anything he said,
because he never covered them. Listed so they stay reviewable:

- **Curves stretch when the song length changes** (`applySongDuration`). Not in
  the transcript. Settled by `dev` instead, which is the oracle: its keyframe
  times are *"a fraction 0..1 of the song"* evaluated at
  `seconds / durationSeconds`, so swapping to a longer song already stretched
  every curve proportionally there. The implementation reproduces that.
- **leadIn becomes the first region.** Zero occurrences in the owner's messages
  — it is a Claude-side term from the original build, so nothing was overridden.
  The reading preserves dev's period count, which is the conservative choice.
- **Easing keeps its own region** rather than folding into a Bezier. Decision 15
  is Claude's analysis in the plan, not the owner's words. Flagged to him at the
  time; still open to veto.

The lesson worth keeping: the check happens reliably at forks that ANNOUNCE
themselves, and unreliably during a long debugging run, where a design decision
arrives disguised as a failing test. When a fix requires choosing what something
should DO rather than why it broke, that is a fork — grep first.

One deliberate divergence to keep in mind: `easing` IS written as its own
region even though upstream bakes it on load. Folding it away at write time
destroyed the named easing the moment the author picked it. See the commit.

### Two corrections the owner made after review

Both are cases where the build had followed the plan and the plan was thinner
than the transcript. Both are logged here because the *reason* generalizes.

- **The block's left edge — raised, changed, and changed back.** Decision 16
  said regions are untouched on resize, matching upstream. The owner first ruled
  that wrong for the left edge, on the grounds that sliding the automation
  spends the gesture on something the move gesture already does: *"you could
  always just move the block to move the start forward. And this way, it's like
  you have more functionality total if moving the left side, like, extends the
  front of the automation just like how moving the right side moves the back."*
  That was built — capture the lanes as curves, set the new frame, replay, with
  a real front clip so trimming did not steepen what survived — and then
  reversed after he used it: *"I think that the curve probably should start at
  the start of the block. So moving the left side of the block should move the
  start of the curve... makes it closer to the upstream behaviour and in line
  with the data model."* So decision 16 stands as originally written, and the
  invariant it protects is now stated positively and tested: **a block's
  automation begins where the block does.** The whole curve slides, keeping its
  shape and its length; growing the block leaves the tail holding, shrinking it
  leaves regions overhanging and unplayed. Do not rebuild the rebase.
- **Horizontal orientation.** It is not a rearrangement. *"The expanded editor
  stays where it is in vertical view and the canopy viewer goes into a new pane
  that's to the left of the vertical view stack."* The stack keeps its order and
  the canopy leaves it — which is exactly why the editor "just stays up": it
  inherits the vacated slot, so there is nothing to close back to. Hence no X
  (@@L11357), no Escape, no toggle-shut on a repeat lane click, and "No
  automation selected" when nothing is picked (@@L14616).

The generalizable lesson is not the one it first looked like. The left-edge
episode reads at first as "the plan generalized past the transcript" — but the
plan had it right, and it was the fresh ruling that did not survive contact with
the running app. So: when a change would make Spell Crafter diverge from
upstream's own behaviour on the shared data model, that cost is worth saying out
loud BEFORE building, because it is the thing that decided the reversal. The
horizontal-mode correction below is the other kind, where the transcript really
did hold detail the plan had compressed away.

### Where the next increment picks up

### The colour lane diverges too much — consolidate it

The owner's read, and it is correct: *"there are a number of differences for how
the color automation operates that are different from other lane types. No need
for it to be so different. I'm guessing it's unnecessarily duplicated logic."*

The value lane grew as a parallel implementation rather than a variation, and
the reported symptoms are all consequences of that:

- **No keyframe dots in the preview.** `LaneCurve` renders `laneKeyframeDot`
  for numeric lanes; `LaneValueSwatches` is a separate component that renders a
  baseline and chips and no dots at all. Measured: 0 dots, 2 chips.
- **No time selection.** The selection gestures are gated off for value lanes
  rather than sharing the numeric path. `dev` never had this either; the owner
  confirmed it is in scope to fix rather than preserve.
- **"The automation curve is always greyed out."** NOT suspension — measured
  `curve.active` undefined and 0 dimmed swatches, so nothing is suspended. The
  grey he is seeing is `.valueBaseline`, drawn as a deliberately neutral line
  because a value lane has no vertical meaning (@@L5846: *"that animation curve
  should just be a straight line"*). Either it is styled dimmer than `dev` drew
  it, or the neutral grey reads as "disabled". Worth showing him both before
  choosing.

So the fix is not three more patches onto the parallel component. It is to make
the value lane a VARIATION of the numeric one — same keyframe rendering, same
selection machinery, same active/suspended treatment — differing only where the
spec says it does: no value axis, keyframes at mid-height, chips instead of a
shaped curve. That is the same "port, never re-author" rule as hard rule 1,
applied to a divergence this branch introduced itself.

Done already: the gradient toggle (decision 23, memory-only) and the colour
ramp.


In order:

1. **Consolidate the value lane** — the section above. Doing this first is what
   makes items 2 and 3 fall out rather than being built twice.
2. **Time selection on colour lanes.** Comes free from 1 if 1 is done properly;
   if it does not, 1 was not done properly.
3. **Keyframe dots in the colour lane preview.** Same.
4. **Undo** over `store.layers` snapshots, `lanedParams` included, takeover
   excluded (decision 6 makes it memory-only).
5. **Info Strip copy** still speaks in pattern-stack vocabulary, not layers and
   blocks.
6. **Demo seed** — `demoExperience.json` is still the legacy blob.
7. The `untitled`-name save guard (the no-song guard is done and working; it is
   what refuses a save until a song is chosen).

### Already done, do not rebuild

Opacity as a pseudo-param (decision 25) with its tri-state and Reset to Auto,
and opacity wired into CanopyPane's merge chain so it actually renders. The
gradient toggle (decision 23) and the double-width gradient chip. Colour periods
ramping across their span. Block bounds at the song's end. One grid stride
shared by drawing and snapping. Manual values reaching their params on load AND
writing through on edit — both halves of decision 7, which had neither.

Effect opacity exclusion needs nothing: upstream's own `lanableParamNames`
already excludes `u_opacity` on effect blocks.

### Running the tests

`corepack yarn playwright test --project=chrome` — 81 tests, ~3.5 min at the
configured two workers. Four workers is faster but flakes the pointer-drag
tests; one worker is 6.3 min. There is no result caching to add: these tests
reach the app over HTTP rather than importing it, so `--only-changed` sees no
dependency from a source edit to a spec and selects nothing at all.

During iteration run the affected spec by name (10-30s) and the full suite once
before committing.

### A note on the pixel tests

`e2e/canopy.spec.ts` used to compare screenshots byte for byte. PNG is
compressed, so one altered pixel rewrites everything after it — 107 pixels
differing by a single channel step moved 8,132 bytes against a 100-byte
"nothing moved" threshold. That is the GPU's own noise floor, so the static
assertions were intermittently false for reasons unrelated to the app. They
decode and count visibly-changed pixels now. If a pixel test starts flapping,
check the metric before the app.

## The color / palette lane — resolved

The plan compressed this to "gradient toggle, memory-only," which is not enough
to build from. The real spec is in the transcript, and `dev` already implements
most of it. **Grep `SPEC-user.txt` before touching this**; see
[[check-the-transcript-first]].

From the owner, verbatim:

> "that animation curve should just be a straight line, and there should be no
> range on the right side because you're just picking different palettes and
> different colors for different periods of time. You're not really changing the
> color." (@@L5846)

> "I don't want the animation curve to be the color of what you're picking. I
> just want, like, a little tiny square to hover above that segment with the
> color inside of it, and you can also click that to select the segment… It's
> just a tiny rectangle with the color inside of it and a border, like other
> things have, and that just sits in the middle of the segment." (@@L6136)

> "for the color, you don't need to have that golden circle representing the
> value." (@@L6141)

So the lane is:

- **No value axis** — no scale, no guides, no curve shapes, no golden value dot.
  Keyframes sit at the vertical MIDDLE (`top: 50%`). dev does this already; the
  abandoned branch moved them to the top, which the owner flagged (@@L18666).
- **One bordered chip per period, centred in the segment**, clickable to select.
  Same chip in the lane preview (@@L6136).
- **A gradient period** (`from != to`) uses that same centred chip filled
  left-to-right with the gradient, and the chip is **twice as wide** as a solid
  one. Owner's call, chosen over end-stop chips or a full-width sweep.
- **The inspector opens only on segment selection** and closes on any click
  elsewhere (@@L18666, @@L17728).
- **Time selection works on color lanes.** It does not on `dev` — a real gap the
  owner confirmed (@@L19430) — and it is in scope to fix here, not preserve.
- **It IS the regular expanded editor**, not a stripped-down variant: same BPM
  grid, same canopy/waveform backdrops. dev gates neither on lane kind. The
  abandoned branch built a separate stripped editor, which drew the owner's
  sharpest complaint (@@L19078).
- The preview must **fit the block** (@@L18784).
- One deliberate change from dev: decision 30 replaces the backdrop *menu* with
  two toggle BUTTONS — teardrop for canopy, the conjurer waveform icon for
  waveform.

## Questions for the owner

Held here rather than blocking. All currently answered: canopy docks **left** in
horizontal mode; pushing to `origin` (the owner's fork only) is approved; the
color lane is settled above.
