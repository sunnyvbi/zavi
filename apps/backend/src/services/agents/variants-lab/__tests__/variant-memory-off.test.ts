
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VariantConfigSchema } from "../../engine/variant-config";
import { stripMemoryToolsIfOff } from "../../memory-mode";

const src = readFileSync(join(__dirname, "../../generic-dispatcher.ts"), "utf-8");
const at = (needle: string) => {
  const i = src.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe("variant memory lever", () => {
  it("schema: accepts memory off, rejects anything else", () => {
    expect(VariantConfigSchema.safeParse({ memory: "off" }).success).toBe(true);
    expect(VariantConfigSchema.safeParse({ memory: "on" }).success).toBe(false);
    expect(VariantConfigSchema.safeParse({ memory: true }).success).toBe(false);
  });

  it("flips ctx.memory_mode after the variant (incl. agent_file fallback) is final", () => {
    const flip = at('if (variant.config.memory === "off" && !memoryOff(ctx)) {');
    expect(flip).toBeGreaterThan(at("let variant = resolvedVariant;"));
    expect(flip).toBeGreaterThan(at("variant = DEFAULT_VARIANT;\n      agentBody = ctx.agent.body_markdown;"));
    const block = src.slice(flip, src.indexOf("\n  }\n", flip));
    expect(block).toContain('ctx.memory_mode = "off";');
    expect(block).toContain('ctx.episodic = "";');
    expect(block).toMatch(/ctx\.memory = \{ company: "", ops: "", policies: "", disputes: "", support: "" \}/);
    expect(block).toMatch(/connectorBlocks = await loadTenantConnectorBlocks\(\s*ctx\.tenant_id,\s*true,/);
    expect(block).toMatch(/wrappedMemory = \{/);
  });

  it("every memory consumer reads ctx after the flip", () => {
    const flip = at('if (variant.config.memory === "off" && !memoryOff(ctx)) {');
    for (const consumer of [
      "memory: wrappedMemory,",
      "coreBlocks + connectorBlocks + skillIndexBlock + agentBody",
      "if (!memoryOff(ctx) && ctx.episodic && ctx.episodic.length > 0) {",
      'const recentRunsRaw = ctx.memory_mode === "off" ? [] : await ctx.scanRecentRuns(24);',
      "stripMemoryToolsIfOff(discovery.tools, ctx)",
      "memory_mode: ctx.memory_mode,",
    ]) {
      expect(at(consumer), consumer).toBeGreaterThan(flip);
    }
    const before = src.slice(0, flip).match(/memoryOff\(ctx\)/g) ?? [];
    expect(before).toHaveLength(1);
  });

  it("memory tools are stripped once memory_mode is off", () => {
    const tools = [{ name: "memory__search" }, { name: "github__read_file" }, { name: "brain__retire_note" }];
    expect(stripMemoryToolsIfOff(tools, { memory_mode: "off" }).map((t) => t.name)).toEqual(["github__read_file"]);
  });
});
