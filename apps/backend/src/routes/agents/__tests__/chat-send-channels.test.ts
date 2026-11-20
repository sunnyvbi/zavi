
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "..", "chat-send.ts"), "utf8");

const code = src
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
  .join("\n");

describe("chat-send channel tags (#15)", () => {
  it("accepts a channels array validated against the shared registry", () => {
    expect(code).toMatch(/channels:\s*z\s*\n?\s*\.array\(z\.string\(\)\.refine\(isChannelSlug/);
    expect(code).toMatch(/import \{[^}]*isChannelSlug[^}]*\} from "@zavi\/shared"/);
  });

  it("caps the array at the registry size", () => {
    expect(code).toMatch(/\.max\(CHANNELS\.length\)/);
  });

  it("KEEPS a channel-tagged turn off the barge-in path", () => {
    const gate = code.indexOf("!body.repo_hint &&");
    expect(gate).toBeGreaterThan(-1);
    const condition = code.slice(gate - 400, gate + 400);
    expect(condition).toMatch(/!\(body\.channels && body\.channels\.length > 0\)/);
  });

  it("merges the channels into the run payload without clobbering what is there", () => {
    const merge = code.indexOf("channels: pickedChannels");
    expect(merge).toBeGreaterThan(-1);
    expect(code.slice(merge - 200, merge)).toMatch(/\.\.\.chBase,/);
  });

  it("scopes the payload write to the run AND the tenant", () => {
    const merge = code.indexOf("channels: pickedChannels");
    const after = code.slice(merge, merge + 300);
    expect(after).toMatch(/\.eq\("id", run_id\)/);
    expect(after).toMatch(/\.eq\("tenant_id", auth\.tenant_id\)/);
  });

  it("does not fail the turn when only the tag write fails", () => {
    const merge = code.indexOf("channels: pickedChannels");
    const after = code.slice(merge, merge + 600);
    expect(after).toMatch(/console\.warn/);
    expect(after).not.toMatch(/res\.status\(500\)/);
  });
});
