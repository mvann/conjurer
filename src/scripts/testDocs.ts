/**
 * Enforces the editor documentation copy (see docs.ts). Run with
 * `yarn test:docs`.
 *
 * Two rules:
 *
 * 1. No em dashes anywhere in any entry.
 * 2. Every `data-doc` key in the editor's components has an entry. `getDoc`
 *    falls back to the welcome text for an unknown key, so a control with no
 *    entry does not break: it quietly shows generic copy instead of its own.
 *    That is exactly how nineteen of them, the whole layer and block UI
 *    included, drifted undocumented without anyone noticing.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { docs } from "../components/EditorV2/docs";

const EM_DASH = "—";
const COMPONENT_DIR = join(__dirname, "..", "components", "EditorV2");

let failed = false;
const fail = (message: string) => {
  failed = true;
  console.error("FAIL: " + message);
};

const emDashes: string[] = [];
for (const [key, entry] of Object.entries(docs))
  for (const field of ["title", "short", "long"] as const)
    if (entry[field].includes(EM_DASH)) emDashes.push(`${key}.${field}`);
if (emDashes.length > 0)
  fail(`em dashes found in docs entries: ${emDashes.join(", ")}`);

// Keys the UI actually hands to getDoc.
const used = new Set<string>();
for (const file of readdirSync(COMPONENT_DIR)) {
  if (!file.endsWith(".tsx")) continue;
  const source = readFileSync(join(COMPONENT_DIR, file), "utf-8");
  for (const match of source.matchAll(/data-doc="([a-z0-9-]+)"/g))
    used.add(match[1]);
}

const undocumented = [...used].filter((key) => !(key in docs)).sort();
if (undocumented.length > 0)
  fail(
    `controls with no docs entry (they would show the welcome text): ${undocumented.join(", ")}`,
  );

if (failed) process.exit(1);

console.log(
  `PASS: ${Object.keys(docs).length} docs entries, no em dashes, all ${used.size} documented controls covered`,
);
