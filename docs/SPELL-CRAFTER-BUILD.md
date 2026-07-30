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

### Where the next increment picks up

The projection exists and is trusted, and the store loads. Not yet done:

1. **Feed the projection to the existing components.** `AutomationPane`'s
   `LaneCurve` and `AutomationEditorView` both take `curve: AutomationCurve`
   props today, so they can be fed `variationsToCurve(...)` without being
   rewritten — that is the whole point. Write path: edits call
   `curveToVariations` back onto the block. **This is the step the previous
   attempt got wrong**: it built the adapter and then wrote a new view anyway.
2. Color/palette *sequences* — blocked on an owner decision, see below.
3. Left pane becomes the layer list (decisions 1–2, 28).
4. Legacy save migration (22): fraction-time curves to block-local seconds.

## Questions for the owner

Held here rather than blocking. (Answered: canopy docks **left** in horizontal
mode; pushing this branch to `origin` — the owner's fork only — is approved.)

- **Color/palette region *sequences*** (plan final-audit item 6) is the one
  genuinely undesigned area, and it is exactly what broke last time. The plan
  reduced scope to "make decision 23 apply per-region across a sequence, and
  render gradients," but no editor surface was ever designed for editing runs of
  gradient regions. Will need a decision before step 5.
