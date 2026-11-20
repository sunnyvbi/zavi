import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../../..");
const ALLOWED = ["src/services/team-notes", "src/routes/team-notes", "workers/functions/team-note-judge.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("team note text stays out of prompts and memory", () => {
  it("only the team-notes modules mention team_note_draft", () => {
    const offenders = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "workers"))]
      .map((p) => p.slice(ROOT.length + 1))
      .filter((rel) => !ALLOWED.some((a) => rel.startsWith(a)))
      .filter((rel) => readFileSync(join(ROOT, rel), "utf8").includes("team_note_draft"));
    expect(offenders).toEqual([]);
  });

  it("no team-notes module writes memory", () => {
    for (const rel of ["src/services/team-notes", "src/routes/team-notes"]) {
      for (const p of walk(join(ROOT, rel))) {
        expect(readFileSync(p, "utf8"), p).not.toMatch(/memory_note|memory_write|proposeMemory|writeMemorySignal/);
      }
    }
  });
});
