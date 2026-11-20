
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { labVariantOverride } from "../lab-gate";

const src = readFileSync(join(__dirname, "../../generic-dispatcher.ts"), "utf-8");

describe("variants lab wiring in generic-dispatcher", () => {
  it("all three makeDispatchTool funnels get variants_lab", () => {
    const sites = src.match(
      /makeDispatchTool\(\{\s*\n\s*draft_mode: ctx\.draft_mode,\s*\n\s*variants_lab: ctx\.variants_lab,/g,
    );
    expect(sites).toHaveLength(3);
    expect(src.match(/makeDispatchTool\(\{/g)).toHaveLength(3);
  });

  it("the SDK PreToolUse hook ctx gets variants_lab", () => {
    expect(src).toMatch(/preview_dry: ctx\.preview_dry,[\s\S]{0,120}variants_lab: ctx\.variants_lab,/);
  });

  it("the legacy loop denies lab tools before its only callMcpTool", () => {
    const gate = src.indexOf("const labDenied = ctx.variants_lab === true && isLabDeniedTool(fullName);");
    const call = src.indexOf("await callMcpTool(");
    expect(gate).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(gate);
    expect(src.match(/await callMcpTool\(/g)).toHaveLength(1);
  });

  it("the lab override wins over the tenant assignment only through labVariantOverride; bench still forces DEFAULT", () => {
    expect(src).toMatch(
      /isBench\s*\n\s*\? Promise\.resolve\(DEFAULT_VARIANT\)\s*\n\s*: labVariantOverride\(ctx\)\s*\n\s*\? Promise\.resolve\(labVariantOverride\(ctx\)!\)/,
    );
    expect(src.match(/ctx\.variant_override/g) ?? []).toHaveLength(0);
  });

  it("labVariantOverride: ignored without variants_lab, honoured with it", () => {
    const v = { slug: "v1", config: { effort: "low" as const } };
    expect(labVariantOverride({ variant_override: v })).toBeUndefined();
    expect(labVariantOverride({ variants_lab: false, variant_override: v })).toBeUndefined();
    expect(labVariantOverride({ variants_lab: true, variant_override: v })).toBe(v);
    expect(labVariantOverride({ variants_lab: true })).toBeUndefined();
  });

  it("pasted lab images reach the user turn only on a lab run", () => {
    expect(src).toMatch(/ctx\.variants_lab === true &&\s*\n\s*Array\.isArray\(ctx\.lab_user_images\)/);
  });

  it("tools.disable filters the resolved list the legacy loop and funnel use", () => {
    expect(src).toMatch(
      /carriesRedo,\s*\n\s*\)\.filter\(\(t\) => !isVariantDisabledTool\(t\.name, variant\.config\.tools\?\.disable\)\);/,
    );
    expect(src).toMatch(/disabled_tools: variant\.config\.tools\?\.disable,/);
  });

  it("stashes the final variant on ctx for behaviour sites, after the agent_file fallback", () => {
    const stash = src.indexOf("ctx.resolved_variant = variant;");
    expect(stash).toBeGreaterThan(src.indexOf("variant = DEFAULT_VARIANT;\n      agentBody = ctx.agent.body_markdown;"));
    expect(src.match(/ctx\.resolved_variant = /g)).toHaveLength(1);
  });
});
