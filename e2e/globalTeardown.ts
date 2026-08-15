import { createClient } from "@libsql/client";

/**
 * Delete the experiences the suite created.
 *
 * Every test opens its own uniquely named experience so tests cannot inherit
 * each other's songs and patterns, and saving writes a real row. Those rows
 * outlive the run, so they piled up in the local database a run at a time and
 * turned up in the editor's Open menu, where they are pure noise: eighty four
 * of them by the time anyone looked.
 *
 * Only `e2e-` names are touched, which is the prefix `gotoEditorClean` uses.
 */
export default async function globalTeardown() {
  try {
    const client = createClient({ url: "file:local.db" });
    const result = await client.execute(
      "delete from experiences where name like 'e2e-%'",
    );
    if (result.rowsAffected > 0)
      console.log(`\ncleaned up ${result.rowsAffected} e2e experience rows`);
    client.close();
  } catch (error) {
    // A missing or locked database must never fail an otherwise green run.
    console.warn("could not clean up e2e experiences:", error);
  }
}
