/**
 * Enforces the style rules of the editor documentation copy (see docs.ts):
 * no em dashes anywhere in any entry. Run with `yarn test:docs`.
 */
import { docs } from "../components/EditorV2/docs";

const EM_DASH = "—";

const violations: string[] = [];
for (const [key, entry] of Object.entries(docs)) {
  for (const field of ["title", "short", "long"] as const) {
    if (entry[field].includes(EM_DASH)) violations.push(`${key}.${field}`);
  }
}

if (violations.length > 0) {
  console.error(
    `FAIL: em dashes found in docs entries: ${violations.join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `PASS: no em dashes in ${Object.keys(docs).length} docs entries`,
);
