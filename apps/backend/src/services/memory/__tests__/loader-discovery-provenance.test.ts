import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("loader canonical-brain provenance guard", () => {
  it("loadMemoryDocs excludes agent_discovery_inferred drafts", () => {
    const src = readFileSync(join(__dirname, "..", "loader.ts"), "utf8");
    const start = src.indexOf("export async function loadMemoryDocs");
    const end = src.indexOf("export async function loadAgentEpisodic");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain('.neq("source", "agent_discovery_inferred")');
  });
});
