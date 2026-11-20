import { describe, it, expect, vi, beforeEach } from "vitest";

const strictRead = vi.fn();
vi.mock("@/services/settings", () => ({
  getAppSetting: async () => undefined,
  getSetting: async () => undefined,
  getBoolSettingStrictResolved: (...args: unknown[]) => strictRead(...args),
}));

import { resolveModelForRun, type RouterDeps } from "@/services/agents/model-router";
import {
  productBuildLane,
  type ProductBuildLane,
} from "@/services/agents/engineer-cost-v2";
import { APP_SETTINGS } from "@/services/settings/registry";
import { MODELS } from "@/services/llm/models";
import type { AgentContext } from "@/services/agents/types";
import { loadGlobalAgentDefinition } from "@/services/agents/registry";

const OPUS55 = MODELS.anthropic.opus;
const SONNET5 = MODELS.anthropic.sonnet;
const TENANT = "11111111-2222-3333-4444-555555555555";

function engCtx(thread_id?: string): AgentContext {
  const def = loadGlobalAgentDefinition("engineer");
  return { agent: structuredClone(def!), thread_id, tenant_id: TENANT } as unknown as AgentContext;
}

function lanes(on: Partial<Record<ProductBuildLane, boolean>>) {
  return vi.fn(async (lane: ProductBuildLane) => on[lane] === true);
}

function makeDeps(over: Partial<RouterDeps> = {}): RouterDeps {
  return {
    flagEnabled: () => true,
    mode: () => "live",
    classify: vi.fn(async () => {
      throw new Error("classifier must not run on a build stage");
    }),
    readThreadRouting: vi.fn(async () => ({ routed_model: null, sdk_session_id: null })),
    writeSticky: vi.fn(async () => {}),
    readChatMessage: vi.fn(async () => ""),
    readPriorClassifyTier: vi.fn(async () => null),
    costV2Enabled: () => true,
    productBuildLightEnabled: lanes({ small_edit: true, scaffold: true }),
    ...over,
  };
}

const REFINE = { stage: "build", refine_mode: true, customer_origin: true, idea: "make the header blue" };

beforeEach(() => {
  strictRead.mockReset();
});

describe("product-build routing table (real engineer policy, both lanes ON)", () => {
  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ["scaffold", { stage: "scaffold" }, SONNET5, "product_build_scaffold_light"],
    ["small refine", { ...REFINE, small_edit: true }, SONNET5, "product_build_small_edit"],
    ["full build", { stage: "build", idea: "a CRM" }, OPUS55, "floor_payload_stage"],
    ["refine without the flag", REFINE, OPUS55, "floor_payload_stage"],
    ["refine with small_edit false", { ...REFINE, small_edit: false }, OPUS55, "floor_payload_stage"],
    ["refine with small_edit as a string", { ...REFINE, small_edit: "true" }, OPUS55, "floor_payload_stage"],
    ["small_edit on a non-refine build", { stage: "build", small_edit: true }, OPUS55, "floor_payload_stage"],
    ["small_edit on a repair", { ...REFINE, small_edit: true, repair_mode: true }, OPUS55, "floor_payload_stage"],
    ["small_edit on scaffold still uses the scaffold lane", { stage: "scaffold", small_edit: true }, SONNET5, "product_build_scaffold_light"],
    ["refine_gate", { stage: "refine_gate", small_edit: true }, OPUS55, "floor_payload_stage"],
    ["deploy", { stage: "deploy" }, OPUS55, "floor_payload_stage"],
  ];
  for (const [name, payload, model, reason] of table) {
    it(name, async () => {
      const deps = makeDeps();
      const out = await resolveModelForRun(engCtx(), payload, deps);
      expect(out?.model).toBe(model);
      expect(out?.picked_model).toBe(model);
      expect(out?.reason_code).toBe(reason);
      expect(out?.effective).toBe(true);
      expect(out?.picked_depth).toBe(model === SONNET5 ? "light" : "deep");
      expect(out?.picked_tier).toBe(model === SONNET5 ? "sonnet" : "opus");
      expect(deps.classify).not.toHaveBeenCalled();
    });
  }

  it("does not read the lane settings for a run that is not a lane", async () => {
    const deps = makeDeps();
    await resolveModelForRun(engCtx(), { stage: "build", idea: "a CRM" }, deps);
    await resolveModelForRun(engCtx(), REFINE, deps);
    expect(deps.productBuildLightEnabled).not.toHaveBeenCalled();
  });

  it("reads the lane setting for the run's own tenant", async () => {
    const deps = makeDeps();
    await resolveModelForRun(engCtx(), { ...REFINE, small_edit: true }, deps);
    expect(deps.productBuildLightEnabled).toHaveBeenCalledWith("small_edit", TENANT);
  });
});

describe("product-build lane settings", () => {
  it("registry defaults: both lanes OFF until an eval proves them, both per-tenant booleans", () => {
    expect(APP_SETTINGS.product_build_small_edit_light_model).toMatchObject({
      type: "boolean",
      scope: "per-tenant",
      defaultValue: false,
    });
    expect(APP_SETTINGS.product_build_scaffold_light_model).toMatchObject({
      type: "boolean",
      scope: "per-tenant",
      defaultValue: false,
    });
  });

  it("small_edit OFF keeps small refines on the Opus floor, scaffold lane unaffected", async () => {
    const deps = makeDeps({ productBuildLightEnabled: lanes({ scaffold: true }) });
    const small = await resolveModelForRun(engCtx(), { ...REFINE, small_edit: true }, deps);
    expect(small?.model).toBe(OPUS55);
    expect(small?.reason_code).toBe("floor_payload_stage");
    const scaffold = await resolveModelForRun(engCtx(), { stage: "scaffold" }, deps);
    expect(scaffold?.model).toBe(SONNET5);
  });

  it("scaffold OFF keeps scaffold on the Opus floor, small_edit lane unaffected", async () => {
    const deps = makeDeps({ productBuildLightEnabled: lanes({ small_edit: true }) });
    const scaffold = await resolveModelForRun(engCtx(), { stage: "scaffold" }, deps);
    expect(scaffold?.model).toBe(OPUS55);
    expect(scaffold?.reason_code).toBe("floor_payload_stage");
    const small = await resolveModelForRun(engCtx(), { ...REFINE, small_edit: true }, deps);
    expect(small?.model).toBe(SONNET5);
  });

  it("a truthy non-boolean from the reader does not turn a lane on", async () => {
    const deps = makeDeps({
      productBuildLightEnabled: vi.fn(async () => "true" as unknown as boolean),
    });
    const out = await resolveModelForRun(engCtx(), { ...REFINE, small_edit: true }, deps);
    expect(out?.model).toBe(OPUS55);
  });

  it("settings read error fails closed to the Opus floor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      productBuildLightEnabled: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    for (const payload of [{ ...REFINE, small_edit: true }, { stage: "scaffold" }]) {
      const out = await resolveModelForRun(engCtx(), payload, deps);
      expect(out?.model).toBe(OPUS55);
      expect(out?.reason_code).toBe("floor_payload_stage");
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("default reader uses the strict per-tenant read with the lane's key", async () => {
    strictRead.mockResolvedValue(true);
    const deps = makeDeps({ productBuildLightEnabled: undefined });
    const small = await resolveModelForRun(engCtx(), { ...REFINE, small_edit: true }, deps);
    expect(small?.model).toBe(SONNET5);
    expect(strictRead).toHaveBeenCalledWith("product_build_small_edit_light_model", TENANT);
    await resolveModelForRun(engCtx(), { stage: "scaffold" }, deps);
    expect(strictRead).toHaveBeenCalledWith("product_build_scaffold_light_model", TENANT);
  });

  it("default reader throwing fails closed to the Opus floor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    strictRead.mockRejectedValue(new Error("strict setting read failed"));
    const out = await resolveModelForRun(
      engCtx(),
      { ...REFINE, small_edit: true },
      makeDeps({ productBuildLightEnabled: undefined }),
    );
    expect(out?.model).toBe(OPUS55);
    expect(out?.reason_code).toBe("floor_payload_stage");
    warn.mockRestore();
  });

  it("engineer cost v2 OFF ignores the lanes and keeps the pre-v2 floor", async () => {
    const deps = makeDeps({ costV2Enabled: () => false });
    const out = await resolveModelForRun(engCtx(), { ...REFINE, small_edit: true }, deps);
    expect(out?.model).toBe(MODELS.anthropic.opus);
    expect(out?.reason_code).toBe("floor_payload_stage");
    expect(deps.productBuildLightEnabled).not.toHaveBeenCalled();
  });

  it("shadow mode records Sonnet 5 but applies the declared model", async () => {
    const ctx = engCtx();
    const out = await resolveModelForRun(ctx, { ...REFINE, small_edit: true }, makeDeps({ mode: () => "shadow" }));
    expect(out?.picked_model).toBe(SONNET5);
    expect(out?.model).toBe(ctx.agent.metadata_praxis.model);
    expect(out?.effective).toBe(false);
  });

  it("a light lane never writes a sticky model; the floor still does", async () => {
    const deps = makeDeps();
    await resolveModelForRun(engCtx("th-1"), { ...REFINE, small_edit: true }, deps);
    expect(deps.writeSticky).not.toHaveBeenCalled();
    await resolveModelForRun(engCtx("th-1"), REFINE, deps);
    expect(deps.writeSticky).toHaveBeenCalledWith("th-1", OPUS55);
  });
});

