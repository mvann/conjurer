/**
 * Tests for the legacy-save migration (yarn test:migrate).
 *
 * The migration's output is only useful if it is a blob upstream would have
 * written itself, so what is asserted is shape and vocabulary rather than
 * pixels:
 *
 * - Every stack entry becomes one full-song block in a single layer
 *   (decisions 24 and the one-layer shape).
 * - Un-automated params become a lone constant region — the manual value has
 *   no other home in the blob (decision 7).
 * - Automated params become the projected region list, in the scalar
 *   vocabulary upstream's loader will not rewrite.
 * - Effects become nested effectBlocks and their `effect:<id>:<uniform>` lane
 *   keys disappear, the automation having moved onto the effect block's own
 *   params (decision 20).
 * - Visibility: a visible entry writes NO u_opacity (staying "auto"), a hidden
 *   one writes a flat 0 (decisions 5 and 25).
 * - Colours and palettes survive as linear4 / palette regions.
 * - A save with no song still migrates, on the nominal 60s basis.
 */
import type { Store } from "@/src/types/Store";
import {
  migrateLegacySave,
  LegacySave,
  NO_SONG_DURATION_SECONDS,
} from "@/src/components/EditorV2/migrateLegacySave";

let failures = 0;
const fail = (message: string) => {
  failures++;
  console.error(`  FAIL: ${message}`);
};
const check = (condition: boolean, message: string) => {
  if (!condition) fail(message);
};

const stubStore = {
  userStore: { me: { id: 7, username: "mvann" } },
  audioStore: {
    getSmoothedPeakAtTime: (t: number) => 0.5 + 0.5 * Math.sin(t),
  },
} as unknown as Store;

const song = {
  id: 2,
  name: "shiny_2",
  artist: "no homework",
  filename: "no homework - shiny_2.mp3",
  createdAt: "",
  updatedAt: "",
  duration: 100,
} as never;

const save: LegacySave = {
  savedAt: 1,
  song,
  entries: [
    {
      pattern: "Nebula",
      id: 1,
      params: {
        u_intensity: 0.75,
        u_color: [1, 0.5, 0.25, 1],
      },
      visible: true,
      expanded: true,
      automatedParams: ["u_intensity"],
      automation: {
        u_intensity: {
          keyframes: [
            { time: 0, value: 0.1 },
            { time: 0.5, value: 0.9 },
            { time: 1, value: 0.2 },
          ],
          segments: [{ type: "linear" }, { type: "linear" }],
        },
      },
    },
    {
      pattern: "Disc",
      id: 2,
      params: { u_radius: 4 },
      effects: [{ id: 9, pattern: "ColorRemap", params: { u_hue: 0.3 } }],
      visible: false,
      expanded: false,
      automatedParams: ["effect:9:u_hue"],
      automation: {
        "effect:9:u_hue": {
          keyframes: [
            { time: 0, value: 0 },
            { time: 1, value: 1 },
          ],
          segments: [{ type: "linear" }],
        },
      },
    },
  ],
};

console.log("legacy save migration\n");

const experience = migrateLegacySave(save, {
  name: "migrated",
  store: stubStore,
});

// ---- overall shape
check(experience.version === 2, "version must be 2 for upstream's loader");
check(experience.name === "migrated", "name carried through");
check(
  experience.user?.username === "mvann",
  "author taken from the store's user",
);
const layers = experience.data?.layers;
check(Array.isArray(layers) && layers.length === 1, "exactly one layer");

const blocks = Object.values(layers[0].blockMap) as any[];
check(blocks.length === 2, `two blocks, got ${blocks.length}`);
check(
  Object.keys(layers[0].blockMap).every((id) => id === (layers[0].blockMap[id] as any).id),
  "block map key must equal block.id — both are written and both are trusted",
);

// ---- full-song blocks (decision 24)
for (const block of blocks) {
  check(block.startTime === 0, `${block.pattern.name}: startTime 0`);
  check(
    block.duration === 100,
    `${block.pattern.name}: duration is the song length, got ${block.duration}`,
  );
}

const nebula = blocks.find((b) => b.pattern.name === "Nebula");
const disc = blocks.find((b) => b.pattern.name === "Disc");
check(!!nebula && !!disc, "both patterns present by name");

// ---- automated scalar param
const intensity = nebula.parameterVariations.u_intensity;
check(Array.isArray(intensity) && intensity.length > 0, "u_intensity has regions");
check(
  intensity.every((region: any) =>
    ["curve", "periodic", "audio"].includes(region.type),
  ),
  `u_intensity must stay in the scalar vocabulary, got ${intensity
    .map((r: any) => r.type)
    .join(", ")}`,
);
const intensityTotal = intensity.reduce(
  (sum: number, r: any) => sum + r.duration,
  0,
);
check(
  Math.abs(intensityTotal - 100) < 1e-6,
  `u_intensity regions must tile the block, got ${intensityTotal}`,
);

// ---- un-automated params become a lone constant region (decision 7)
const radius = disc.parameterVariations.u_radius;
check(
  Array.isArray(radius) && radius.length === 1 && radius[0].type === "curve",
  "an un-automated number becomes one constant curve region",
);
check(
  Math.abs(radius[0].duration - 100) < 1e-6,
  "the constant region spans the block",
);

const color = nebula.parameterVariations.u_color;
check(
  Array.isArray(color) && color.length === 1 && color[0].type === "linear4",
  `an un-automated colour becomes one linear4 region, got ${color?.[0]?.type}`,
);

// ---- visibility (decisions 5, 25)
check(
  nebula.parameterVariations.u_opacity === undefined,
  "a visible entry writes no u_opacity, leaving opacity on auto",
);
const discOpacity = disc.parameterVariations.u_opacity;
check(
  Array.isArray(discOpacity) && discOpacity.length === 1,
  "a hidden entry writes an opacity region",
);

// ---- effects (decision 20)
check(
  Array.isArray(disc.effectBlocks) && disc.effectBlocks.length === 1,
  "the effect became a nested block",
);
const effect = disc.effectBlocks[0];
check(effect.pattern.name === "ColorRemap", "effect keeps its pattern name");
check(
  Array.isArray(effect.parameterVariations.u_hue) &&
    effect.parameterVariations.u_hue.length > 0,
  "the effect's lane moved onto the effect block's own params",
);
check(
  !Object.keys(disc.parameterVariations).some((key) => key.startsWith("effect:")),
  "no effect:<id>:<uniform> lane key may survive into the blob",
);

// ---- no song still migrates
const noSongExperience = migrateLegacySave(
  { savedAt: 1, song: null, entries: [save.entries[0]] },
  { name: "nosong", store: stubStore },
);
const noSongBlock = Object.values(
  noSongExperience.data.layers[0].blockMap,
)[0] as any;
check(
  noSongBlock.duration === NO_SONG_DURATION_SECONDS,
  `a songless save migrates on the nominal ${NO_SONG_DURATION_SECONDS}s basis, got ${noSongBlock.duration}`,
);

// ---- an empty save is still a valid experience
const emptyExperience = migrateLegacySave(
  { savedAt: 1, song, entries: [] },
  { name: "empty", store: stubStore },
);
check(
  Object.keys(emptyExperience.data.layers[0].blockMap).length === 0,
  "an empty stack migrates to one empty layer",
);

if (failures === 0) {
  console.log(`  ${blocks.length} blocks in 1 layer, full-song spans`);
  console.log(
    `  Nebula: u_intensity -> ${intensity.length} ${intensity
      .map((r: any) => r.type)
      .join("/")} region(s), u_color -> linear4, opacity auto`,
  );
  console.log(
    `  Disc: u_radius -> constant curve, hidden -> flat opacity, effect ColorRemap nested with its own u_hue lane`,
  );
}

console.log("");
if (failures > 0) {
  console.error(`FAIL: ${failures} migration failure(s)`);
  process.exit(1);
}
console.log("PASS: legacy saves migrate to an upstream-shaped blob");
