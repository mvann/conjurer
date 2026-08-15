/**
 * Regenerate the demo's starter experience in the CURRENT data model.
 *
 * The demo used to ship the old save format and migrate it in the browser on
 * every first visit, which meant the demo exercised the migration path rather
 * than the model it is demonstrating. This runs that same migration once, at
 * build time, and writes the result out. Run with:
 *
 *   yarn build:demo <legacy.json>
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Store } from "@/src/types/Store";
import {
  migrateLegacySave,
  LegacySave,
} from "@/src/components/EditorV2/migrateLegacySave";

const stubStore = {
  userStore: { me: { id: 1, username: "Gandalf" } },
  audioStore: {
    getSmoothedPeakAtTime: () => 0,
  },
} as unknown as Store;

const source = process.argv[2];
if (!source) {
  console.error("usage: yarn build:demo <legacy.json>");
  process.exit(1);
}

const legacy = JSON.parse(readFileSync(source, "utf-8")) as LegacySave;
const migrated = migrateLegacySave(legacy, {
  name: "demo",
  store: stubStore,
});

const out = join(
  __dirname,
  "..",
  "components",
  "EditorV2",
  "demoExperience.json",
);
writeFileSync(out, JSON.stringify(migrated, null, 2) + "\n");
console.log(`wrote ${out}`);
