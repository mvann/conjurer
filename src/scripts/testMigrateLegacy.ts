/* eslint-disable no-console */
// Unit test for the legacy-save migration (SerializedEditorState ->
// experience blob). Run: yarn test:migrate
import { migrateLegacySave } from "@/src/components/EditorV2/migrateLegacySave";
import { SerializedEditorState } from "@/src/components/EditorV2/experiencePersistence";

let failures = 0;
const expect = (label: string, condition: boolean) => {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${label}`);
  }
};
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const SONG_SECONDS = 100;

const legacy: SerializedEditorState = {
  savedAt: 0,
  song: null,
  laneOrder: [],
  entries: [
    {
      pattern: "Nebula",
      id: 1,
      params: {
        u_untouched: 0.7,
        u_number: 0.5,
        u_wave: 0.25,
        u_audio: 0.1,
        u_stepped: 0,
        u_inactive: 0.9,
        u_color: [1, 0, 0, 1],
      },
      effects: [
        {
          id: 5,
          pattern: "Color Tint",
          params: { u_intensity: 0.4 },
        },
      ],
      visible: true,
      expanded: true,
      automatedParams: [
        "u_number",
        "u_wave",
        "u_audio",
        "u_stepped",
        "u_inactive",
        "effect:5:u_intensity",
        "__visibility",
      ],
      automation: {
        // Plain two-keyframe ramp: one fitted curve region.
        u_number: {
          keyframes: [
            { time: 0.2, value: 0 },
            { time: 0.8, value: 1 },
          ],
          segments: [{ type: "linear" }],
        },
        // Flat-baseline wave between equal keyframes: periodic region.
        u_wave: {
          keyframes: [
            { time: 0.25, value: 0.5 },
            { time: 0.75, value: 0.5 },
          ],
          segments: [
            { type: "wave", wave: "sine", amplitude: 0.2, cycles: 4, phase: 0 },
          ],
        },
        // Audio segment: live audio region with the left value as offset.
        u_audio: {
          keyframes: [
            { time: 0.1, value: 0.3 },
            { time: 0.9, value: 0.3 },
          ],
          segments: [{ type: "audio", factor: 0.6, smoothing: 0.05 }],
        },
        // Stacked pair (step): two curve regions split at the step.
        u_stepped: {
          keyframes: [
            { time: 0.5, value: 0 },
            { time: 0.5, value: 1 },
          ],
          segments: [{ type: "flat" }],
        },
        // Deactivated curve: manual value wins, curve dropped.
        u_inactive: {
          keyframes: [
            { time: 0.3, value: 0.1 },
            { time: 0.6, value: 0.2 },
          ],
          segments: [{ type: "linear" }],
          active: false,
        },
        // Effect lane.
        "effect:5:u_intensity": {
          keyframes: [
            { time: 0.4, value: 0 },
            { time: 0.6, value: 1 },
          ],
          segments: [{ type: "linear" }],
        },
        // Visibility automation: becomes u_opacity steps.
        __visibility: {
          keyframes: [
            { time: 0.25, value: 1 },
            { time: 0.75, value: 0 },
          ],
          segments: [{ type: "flat" }],
        },
      },
    },
    {
      pattern: "Disc",
      id: 2,
      params: { u_radius: 3 },
      effects: [],
      visible: false,
      expanded: true,
      automatedParams: [],
      automation: {},
    },
  ],
};

const experience = migrateLegacySave(legacy, SONG_SECONDS);
const layers = (experience.data as { layers: any[] }).layers;

expect("version is 2", experience.version === 2);
expect("one layer", layers.length === 1);
const blocks = Object.values(layers[0].blockMap) as any[];
expect("two blocks", blocks.length === 2);

const [nebula, disc] = blocks;
expect("block spans song", approx(nebula.duration, SONG_SECONDS));
expect("block starts at zero", nebula.startTime === 0);
expect("map key equals block id", layers[0].blockMap[nebula.id] === nebula);

const tiles = (uniform: string) => nebula.parameterVariations[uniform] ?? [];
const total = (regions: any[]) =>
  regions.reduce((sum: number, r: any) => sum + r.duration, 0);

// Un-automated param: one full-block constant curve.
expect("untouched is one region", tiles("u_untouched").length === 1);
expect("untouched is a curve", tiles("u_untouched")[0].type === "curve");
expect(
  "untouched holds its value",
  tiles("u_untouched")[0].nodes.every((n: any) => approx(n.value, 0.7)),
);

// Every lane exactly tiles the block.
for (const uniform of Object.keys(nebula.parameterVariations))
  expect(
    `${uniform} tiles the block`,
    approx(total(tiles(uniform)), SONG_SECONDS, 1e-3),
  );

// The ramp lane fitted into curve region(s) that hit the endpoints.
const ramp = tiles("u_number");
expect(
  "ramp regions are curves",
  ramp.every((r: any) => r.type === "curve"),
);

// Wave lane: contains one periodic region with converted units.
const wave = tiles("u_wave").find((r: any) => r.type === "periodic");
expect("wave becomes periodic", Boolean(wave));
expect("wave period seconds", approx(wave.period, (0.5 * SONG_SECONDS) / 4));
expect("wave offset from left keyframe", approx(wave.offset, 0.5));

// Audio lane: live audio region with smoothing persisted.
const audio = tiles("u_audio").find((r: any) => r.type === "audio");
expect("audio survives live", Boolean(audio));
expect("audio offset is left value", approx(audio.offset, 0.3));
expect("audio smoothing persisted", approx(audio.smoothing, 0.05));

// Stacked pair: the step lands on a region boundary at 50s.
const stepped = tiles("u_stepped");
expect("step splits regions", stepped.length >= 2);
expect("step boundary at half", approx(stepped[0].duration, 50, 1e-3));

// Deactivated curve: a single constant at the manual value.
const inactive = tiles("u_inactive");
expect("inactive is one region", inactive.length === 1);
expect(
  "inactive holds manual value",
  inactive[0].nodes.every((n: any) => approx(n.value, 0.9)),
);

// Colors: constant linear4 with from == to.
const color = tiles("u_color");
expect("color is linear4", color[0].type === "linear4");
expect(
  "color from equals to",
  JSON.stringify(color[0].from) === JSON.stringify(color[0].to),
);

// Visibility automation became u_opacity steps.
const opacity = tiles("u_opacity");
expect("opacity lane exists", opacity.length >= 2);

// Effect lane landed on the effect block.
const effect = nebula.effectBlocks[0];
expect("effect block exists", Boolean(effect));
expect(
  "effect lane migrated",
  (effect.parameterVariations.u_intensity ?? []).length >= 1,
);
expect(
  "effect lane tiles the block",
  approx(total(effect.parameterVariations.u_intensity), SONG_SECONDS, 1e-3),
);

// Hidden entry: constant zero opacity.
const discOpacity = disc.parameterVariations.u_opacity;
expect("hidden eye is constant 0", discOpacity?.length === 1);
expect(
  "hidden eye zero-valued",
  discOpacity[0].nodes.every((n: any) => approx(n.value, 0)),
);

// No-song fallback basis.
const noSong = migrateLegacySave({ ...legacy, entries: [] });
expect(
  "no-song empty migrates",
  (noSong.data as { layers: any[] }).layers.length === 1,
);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("migrate-legacy: all assertions passed");
