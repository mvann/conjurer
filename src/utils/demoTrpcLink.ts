import { TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "@/src/server/routers/_app";
import { DEMO_SONGS } from "@/src/utils/demo";
import type { Experience } from "@/src/types/Experience";

// The demo seam (decision 17): on the static GitHub Pages build there
// is no server, so the tRPC pipeline terminates here instead — a link
// that resolves the procedures the spell crafter uses against
// localStorage, under the demo's one resident user.

const GANDALF = {
  id: 1,
  username: "Gandalf",
  isAdmin: false,
  createdAt: "2026-07-27 00:00:00",
  updatedAt: "2026-07-27 00:00:00",
};

const ROWS_KEY = "spellcrafter:demoExperiences";

type DemoRow = Experience & { updatedAt: string };

const readRows = (): Record<string, DemoRow> => {
  try {
    return JSON.parse(localStorage.getItem(ROWS_KEY) ?? "{}");
  } catch {
    return {};
  }
};

const writeRows = (rows: Record<string, DemoRow>) => {
  localStorage.setItem(ROWS_KEY, JSON.stringify(rows));
};

const handlers: Record<string, (input: any) => unknown> = {
  "user.listUsers": () => [GANDALF],
  "user.getUser": () => GANDALF,
  "user.createUser": () => GANDALF,
  "song.listSongs": () => DEMO_SONGS,
  "experience.listExperiences": () => Object.values(readRows()),
  "experience.listExperiencesForUser": () => Object.values(readRows()),
  "experience.getExperience": (input: { experienceName: string }) =>
    readRows()[input.experienceName] ?? null,
  "experience.getExperienceById": (input: { experienceId: number }) =>
    Object.values(readRows()).find((row) => row.id === input.experienceId) ??
    null,
  "experience.saveExperience": (input: any) => {
    const rows = readRows();
    const id =
      input.id ??
      Math.max(0, ...Object.values(rows).map((row) => row.id ?? 0)) + 1;
    rows[input.name] = {
      ...input,
      id,
      user: GANDALF,
      updatedAt: new Date().toISOString(),
    };
    writeRows(rows);
    return id;
  },
};

export const demoTrpcLink: TRPCLink<AppRouter> =
  () =>
  ({ op }) =>
    observable((observer) => {
      const handler = handlers[op.path];
      if (!handler) {
        observer.error(
          new Error(`The demo has no server for ${op.path}`) as never,
        );
        return;
      }
      try {
        const data = handler(op.input);
        observer.next({ result: { data } } as never);
        observer.complete();
      } catch (error) {
        observer.error(error as never);
      }
    });
