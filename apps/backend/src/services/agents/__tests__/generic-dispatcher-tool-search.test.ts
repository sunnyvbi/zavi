import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf-8");

describe("tool search — dispatcher wiring", () => {
  it("`resolved` is still the plain post-strip discovery list", () => {
    expect(src).toMatch(
      /const resolved: ResolvedTool\[\] = stripProposeToolsOnRedo\(\s*stripMemoryToolsIfOff\(discovery\.tools, ctx\),\s*carriesRedo,\s*\)\.filter\(/,
    );
    expect(src).not.toMatch(/\bresolved\.(splice|length\s*=)/);
    expect(src).not.toMatch(/resolved\.(slice|filter)\([^)]*(search|loaded|START_CAP)/i);
  });

  it("the Anthropic engine spec still maps the whole `resolved` list", () => {
    expect(src).toMatch(/const engineTools: EngineToolSpec\[\] = resolved\.map\(\(t\) => \(\{/);
  });

  it("toolSearch hints appear exactly once, on the OpenAI spec, from copies", () => {
    const occurrences = src.match(/toolSearch: \{/g) ?? [];
    expect(occurrences).toHaveLength(1);
    const at = src.indexOf("toolSearch: {");
    const openAiSpecAt = src.lastIndexOf("const openAiSpec: AgentEngineRunSpec = {", at);
    const sdkSpecAt = src.lastIndexOf("tools: engineTools,", at);
    expect(openAiSpecAt).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(openAiSpecAt);
    expect(src.indexOf("const openAiEngine = pickEngine(providerForRun);", openAiSpecAt)).toBeGreaterThan(at);
    expect(sdkSpecAt).toBeGreaterThan(openAiSpecAt);
    const block = src.slice(at, src.indexOf("},", at));
    expect(block).toContain("declaredTools: canonicalizeDeclaredForSearch(declared)");
    expect(block).toContain("engineTools.map((t) => t.name).filter(isInjectedRunTool)");
    expect(block).toContain("record: isBench");
  });
});
