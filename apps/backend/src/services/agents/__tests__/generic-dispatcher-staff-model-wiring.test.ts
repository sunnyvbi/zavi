import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readStaffModelOverride } from "../engine/staff-model-override";
import { variantSdkOptions, DEFAULT_VARIANT } from "../engine/variant-config";
import { sdkRunModelFor } from "../engineer-cost-v2";

const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf-8");
const code = src
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

describe("generic-dispatcher staff ?model= wiring", () => {
  it("reads the pick from the run payload, and NOT on shadow / bench / variants-lab runs", () => {
    expect(code).toMatch(
      /const staffPick =\s*\n?\s*isShadowRun \|\| isBench \|\| ctx\.variants_lab === true \? null : readStaffModelOverride\(payload\);/,
    );
  });

  it("Claude variant: overlays {model, effort} on the variant BEFORE it is stashed and used by the SDK query", () => {
    const overlay = code.indexOf("config: { ...variant.config, model: staffClaude.model_id, effort: staffClaude.effort }");
    expect(overlay).toBeGreaterThan(-1);
    expect(overlay).toBeLessThan(code.indexOf("ctx.resolved_variant = variant;"));
    expect(overlay).toBeGreaterThan(code.indexOf("variant = DEFAULT_VARIANT;\n      agentBody = ctx.agent.body_markdown;"));
    const q = code.indexOf("const sdkRunModel = sdkRunModelFor(variant.config.model, ctx.agent.metadata_praxis.model);");
    expect(q).toBeGreaterThan(overlay);
    expect(code.indexOf("variantOptions: variantSdkOptions(variant.config)")).toBeGreaterThan(overlay);
  });

  it("OpenRouter pick: routes the funnel and the model, and asserts the provider/model pair", () => {
    expect(code).toMatch(/staffModel: !!staffModel,/);
    expect(code).toMatch(/: staffModel\s*\n\s*\? staffModel\.model_id\s*\n\s*: effectiveModel;/);
    expect(code).toMatch(/if \(staffModel\) assertModelMatchesProvider\("openrouter", staffModel\.model_id\);/);
  });

  it("operator gate on the alt funnel: wired (precheck + settle + turn latch), fail closed, BEFORE the engine is picked", () => {
    expect(code).not.toMatch(/staff_model_operator_gate_unwired/);
    const wire = code.indexOf("const altOperatorGate = wireAltFunnelOperatorGate({");
    expect(wire).toBeGreaterThan(-1);
    expect(code.slice(wire, wire + 400)).toMatch(/gateRequired: liveFunnel\?\.operatorGateOnAltFunnel === true,/);
    expect(code.slice(wire, wire + 400)).toMatch(/engineHonorsTurnHook: providerForRun === "openrouter",/);
    expect(code.slice(wire, wire + 400)).toMatch(/state: sdkOperatorState,\s*\n\s*operatorPreCheck,\s*\n\s*operatorSettle,/);
    const funnel = code.indexOf("const openAiDispatchTool = makeDispatchTool({");
    expect(funnel).toBeGreaterThan(wire);
    const funnelEnd = code.indexOf("onEvent: onEventWithText,\n    });", funnel);
    const funnelSrc = code.slice(funnel, funnelEnd);
    expect(funnelSrc).toMatch(/operatorPreCheck: altOperatorGate\.operatorPreCheck,/);
    expect(funnelSrc).toMatch(/operatorSettle: altOperatorGate\.operatorSettle,/);
    const spec = code.indexOf("const openAiSpec: AgentEngineRunSpec = {");
    const pick = code.indexOf("const openAiEngine = pickEngine(providerForRun);");
    const specSrc = code.slice(spec, pick);
    expect(specSrc).toMatch(/onAssistantTurn: altOperatorGate\.onAssistantTurn/);
    expect(specSrc).toMatch(/openRouterUpstream: staffModel\.upstream/);
    expect(wire).toBeLessThan(pick);
    expect(code).toMatch(/const operatorSettle: MakeDispatchToolDeps\["operatorSettle"\] = sdkOperatorState/);
    expect(code).toMatch(/operatorPreCheck,\n\s*operatorSettle,\n\s*killed: killedRef,/);
  });

  it("live sandbox: staff OpenRouter engineer/product-builder get a LIVE executor built from the SAME mcpSandbox ctx", () => {
    expect(code).toMatch(/const liveSandboxCtx: SandboxToolCtx = \{/);
    expect(code).toMatch(
      /sandbox = await mcpSandbox\(liveSandboxCtx\);\n\s*if \(staffModel\) \{\n\s*liveSandboxDeps = buildSandboxToolDeps\(liveSandboxCtx\);\n\s*liveSandboxHooks = buildLiveSandboxHooks\(liveSandboxCtx, liveSandboxDeps\);\n\s*liveSiteImages = liveSandboxCtx\.site_images === true;\n\s*\}/,
    );
    const exec = code.indexOf("const liveSandboxExecutor =");
    expect(code.slice(exec, exec + 300)).toMatch(
      /staffModel &&\s*\n\s*liveSandboxDeps &&\s*\n\s*!isShadowRun &&\s*\n\s*\(ctx\.agent\.slug === "engineer" \|\| ctx\.agent\.slug === "product-builder"\)\s*\n\s*\? makeSandboxExecutor\(liveSandboxDeps, "live", liveSandboxHooks\)/,
    );
    expect(code).toMatch(/sandboxExecutor: shadowSandboxExecutor \?\? liveSandboxExecutor,/);
    expect(code).toMatch(/sandboxMode: shadowSandboxExecutor \? "shadow" : liveSandboxExecutor \? "live" : undefined,/);
    expect(code).toMatch(/if \(liveSandboxExecutor\) \{[\s\S]{0,300}synthesizeSandboxEngineTools\(declaredSandboxVerbs, "live", \{ siteImages: liveSiteImages \}\)/);
  });
});

describe("Claude variant overlay → SDK options (behavioural)", () => {
  it("opus-xhigh resolves to claude-opus-5-5 with effort xhigh on the SDK call", () => {
    const pick = readStaffModelOverride({ staff_model: { key: "opus-xhigh" } });
    if (pick?.kind !== "claude") throw new Error("expected a claude pick");
    const variant = { slug: DEFAULT_VARIANT.slug, config: { ...DEFAULT_VARIANT.config, model: pick.model_id, effort: pick.effort } };
    expect(sdkRunModelFor(variant.config.model, "claude-sonnet-5-5")).toBe("claude-opus-5-5");
    expect(variantSdkOptions(variant.config)).toMatchObject({ effort: "xhigh" });
  });
});
