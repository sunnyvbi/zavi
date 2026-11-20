
import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockTable = Record<string, any> & { _resolve: { data: unknown; error: unknown } };
function newMockTable(): MockTable {
  const t = {} as MockTable;
  t._resolve = { data: null, error: null };
  t.select = vi.fn(() => t);
  t.eq = vi.fn(() => t);
  t.maybeSingle = vi.fn(() => Promise.resolve(t._resolve));
  t.upsert = vi.fn(() => Promise.resolve({ error: null }));
  t.delete = vi.fn(() => t);
  t.then = (r: (v: { data: unknown; error: unknown }) => void) => r(t._resolve);
  return t;
}
const tables: Record<string, MockTable> = {};
function table(name: string): MockTable {
  if (!tables[name]) tables[name] = newMockTable();
  return tables[name];
}
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({ from: vi.fn((n: string) => table(n)) })),
}));

function prime(tenantVal: unknown | undefined, globalVal: unknown | undefined): void {
  table("tenant_app_setting")._resolve = {
    data: tenantVal === undefined ? null : { value: tenantVal },
    error: null,
  };
  table("app_setting")._resolve = {
    data: globalVal === undefined ? null : { value: globalVal },
    error: null,
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("coerceSettingValue", () => {
  it("boolean: accepts bool + string true/false, rejects junk", async () => {
    const { coerceSettingValue } = await import("../index");
    const def = { type: "boolean", scope: "global", description: "", defaultValue: false } as const;
    expect(coerceSettingValue(def, true)).toBe(true);
    expect(coerceSettingValue(def, "true")).toBe(true);
    expect(coerceSettingValue(def, "FALSE")).toBe(false);
    expect(() => coerceSettingValue(def, "maybe")).toThrow();
    expect(() => coerceSettingValue(def, 1)).toThrow();
  });

  it("number: coerces + enforces min/max", async () => {
    const { coerceSettingValue } = await import("../index");
    const def = { type: "number", scope: "global", description: "", defaultValue: 5, min: 1, max: 10 } as const;
    expect(coerceSettingValue(def, "7")).toBe(7);
    expect(() => coerceSettingValue(def, 0)).toThrow();
    expect(() => coerceSettingValue(def, 11)).toThrow();
    expect(() => coerceSettingValue(def, "x")).toThrow();
  });
});

describe("getSetting resolution order", () => {
  it("per-tenant override wins over global", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(true, false);
    expect(await getBoolSetting("screenshot_artifact_render_enabled", "t-1")).toBe(true);
  });

  it("per-tenant false overrides global true", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(false, true);
    expect(await getBoolSetting("screenshot_artifact_render_enabled", "t-1")).toBe(false);
  });

  it("no tenant override → global value", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, true);
    expect(await getBoolSetting("screenshot_artifact_render_enabled", "t-1")).toBe(true);
  });

  it("neither tenant nor global → registry default (reranker default true)", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, undefined);
    expect(await getBoolSetting("memory_reranker_enabled", "t-1")).toBe(true);
    expect(await getBoolSetting("screenshot_artifact_render_enabled", "t-1")).toBe(false);
  });

  it("CONSENT key NEVER falls back to global (codex E3 — a global seed can't allowlist the fleet)", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, true);
    expect(await getBoolSetting("screenshot_artifact_render_enabled", "t-1")).toBe(true);
    _resetSettingsCache();
    prime(undefined, true);
    expect(await getBoolSetting("local_lane_side_effects_allowlist", "t-1")).toBe(false);
    _resetSettingsCache();
    prime(true, undefined);
    expect(await getBoolSetting("local_lane_side_effects_allowlist", "t-1")).toBe(true);
  });

  it("memory_agentic_read_enabled + memory_llm_entity_extract_enabled + memory_skill_distill_enabled + memory_heartbeat_enabled NEVER fall back to global (codex 2026-06-27; default ON 2026-06-27 / skill+heartbeat 2026-06-30)", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    for (const key of [
      "memory_agentic_read_enabled",
      "memory_llm_entity_extract_enabled",
      "memory_skill_distill_enabled",
      "memory_heartbeat_enabled",
    ] as const) {
      _resetSettingsCache();
      prime(undefined, false);
      expect(await getBoolSetting(key, "t-1")).toBe(true);
      _resetSettingsCache();
      prime(false, true);
      expect(await getBoolSetting(key, "t-1")).toBe(false);
    }
  });

  it("memory_conflict_resolution_enabled defaults OFF (2026-07-13) and still ignores the global row", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    const key = "memory_conflict_resolution_enabled" as const;

    _resetSettingsCache();
    prime(undefined, true);
    expect(await getBoolSetting(key, "t-1")).toBe(false);

    _resetSettingsCache();
    prime(true, false);
    expect(await getBoolSetting(key, "t-1")).toBe(true);
  });

  it("competitor_intel_custom_brands NEVER falls back to a global list (tenant isolation, codex 2026-06-16)", async () => {
    const { getSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, ["GlobalBrandLeak"]);
    expect(await getSetting("competitor_intel_custom_brands", "t-1")).toEqual([]);
    _resetSettingsCache();
    prime(["TenantOwnedBrand"], ["GlobalBrandLeak"]);
    expect(await getSetting("competitor_intel_custom_brands", "t-1")).toEqual([
      "TenantOwnedBrand",
    ]);
  });

  it("global-only key ignores any tenant override row", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(true, false);
    expect(await getBoolSetting("brain_gap_distill", "t-1")).toBe(false);
  });

  it("DB error → registry default (never throws)", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    table("tenant_app_setting")._resolve = { data: null, error: { message: "boom" } };
    table("app_setting").maybeSingle = vi.fn(() => Promise.reject(new Error("boom")));
    expect(await getBoolSetting("memory_reranker_enabled", "t-1")).toBe(true);
  });
});

describe("website edit fixes ship default ON", () => {
  it.each(["live_edit_publish_clears_inline_edits", "website_chat_confirm_copy_by_path", "website_edit_plain_instruction"] as const)(
    "%s defaults ON with no rows and a tenant can still turn it off",
    async (key) => {
      const { getBoolSetting, _resetSettingsCache } = await import("../index");
      _resetSettingsCache();
      prime(undefined, undefined);
      expect(await getBoolSetting(key, "t-1")).toBe(true);
      _resetSettingsCache();
      prime(false, undefined);
      expect(await getBoolSetting(key, "t-1")).toBe(false);
    },
  );
});

describe("competitor_intel_weekly_enabled default (ON — autopilot+quiet-week gated, restored 2026-06-21)", () => {
  it("defaults ON (no row → true) and respects explicit tenant overrides", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, undefined);
    expect(await getBoolSetting("competitor_intel_weekly_enabled", "t-1")).toBe(true);

    _resetSettingsCache();
    prime(true, false);
    expect(await getBoolSetting("competitor_intel_weekly_enabled", "t-1")).toBe(true);

    _resetSettingsCache();
    prime(false, true);
    expect(await getBoolSetting("competitor_intel_weekly_enabled", "t-1")).toBe(false);
  });

  it("can be enabled globally from the staff settings surface", async () => {
    const { setGlobalSetting } = await import("../index");
    await expect(
      setGlobalSetting("competitor_intel_weekly_enabled", true, "staff@x.com"),
    ).resolves.toBeUndefined();
  });
});

describe("cross_customer_learning_consent (Bundle H item H-3)", () => {
  it("defaults OFF (false) absent any DB row", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, undefined);
    expect(await getBoolSetting("cross_customer_learning_consent", "t-1")).toBe(false);
  });

  it("setGlobalSetting rejects a consent-key global enable (the P1 fix)", async () => {
    const { setGlobalSetting, CONSENT_GLOBAL_WRITE_ERROR } = await import("../index");
    await expect(
      setGlobalSetting("cross_customer_learning_consent", true, "staff@x.com"),
    ).rejects.toThrow(CONSENT_GLOBAL_WRITE_ERROR);
  });

  it("setGlobalSetting allows a consent-key global FALSE (only enable is blocked)", async () => {
    const { setGlobalSetting } = await import("../index");
    await expect(
      setGlobalSetting("cross_customer_learning_consent", false, "staff@x.com"),
    ).resolves.toBeUndefined();
  });

  it("setGlobalSetting rejects a global build replay fixture and writes no row", async () => {
    const { setGlobalSetting, CONSENT_GLOBAL_WRITE_ERROR } = await import("../index");
    await expect(
      setGlobalSetting("build_replay_fixture", "dog-grooming", "staff@x.com"),
    ).rejects.toThrow(CONSENT_GLOBAL_WRITE_ERROR);
    expect(table("app_setting").upsert).not.toHaveBeenCalled();
  });

  it("setGlobalSetting allows a global build replay 'off'", async () => {
    const { setGlobalSetting } = await import("../index");
    await expect(
      setGlobalSetting("build_replay_fixture", "off", "staff@x.com"),
    ).resolves.toBeUndefined();
  });

  it("a global build replay row never reaches a tenant without its own override", async () => {
    const { getStringSettingStrict } = await import("../index");
    prime(undefined, "dog-grooming");
    expect(await getStringSettingStrict("build_replay_fixture", "t-1")).toBe("off");
    prime("landing-page", "dog-grooming");
    expect(await getStringSettingStrict("build_replay_fixture", "t-1")).toBe("landing-page");
  });

  it("setGlobalSetting does NOT block a non-consent key set true", async () => {
    const { setGlobalSetting } = await import("../index");
    await expect(
      setGlobalSetting("brain_gap_distill", true, "staff@x.com"),
    ).resolves.toBeUndefined();
  });

  it("setTenantSetting grants consent per-tenant (the safe path)", async () => {
    const { setTenantSetting } = await import("../index");
    await expect(
      setTenantSetting("t-1", "cross_customer_learning_consent", true, "staff@x.com"),
    ).resolves.toBeUndefined();
  });
});

describe("getAppSetting — RAW resolver (preserves env/hardcoded fallback)", () => {
  it("returns the stored GLOBAL value when set", async () => {
    const { getAppSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, "glm52");
    expect(await getAppSetting("critic_family")).toBe("glm52");
  });

  it("returns undefined (NOT the registry default) when UNSET — so the caller keeps its env fallback", async () => {
    const { getAppSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, undefined);
    expect(await getAppSetting("critic_family")).toBeUndefined();
  });

  it("returns a per-tenant override, else undefined (no global-default substitution)", async () => {
    const { getAppSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(true, undefined);
    expect(await getAppSetting("memory_reranker_enabled", "t-1")).toBe(true);
    _resetSettingsCache();
    prime(undefined, undefined);
    expect(await getAppSetting("memory_reranker_enabled", "t-1")).toBeUndefined();
  });

  it("fail-OPEN: a DB error → undefined (caller keeps its env/hardcoded default)", async () => {
    const { getAppSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    table("app_setting").maybeSingle = vi.fn(() => Promise.reject(new Error("boom")));
    expect(await getAppSetting("critic_family")).toBeUndefined();
  });

  it("strict: a returned DB error THROWS (never undefined) and is never cached", async () => {
    const { getAppSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    table("app_setting")._resolve = { data: null, error: { message: "timeout" } };
    await expect(getAppSetting("product_builder_enabled", null, { strict: true })).rejects.toThrow(/timeout/);
    expect(await getAppSetting("product_builder_enabled")).toBeUndefined();
    table("app_setting")._resolve = { data: { value: false }, error: null };
    expect(await getAppSetting("product_builder_enabled", null, { strict: true })).toBe(false);
  });

  it("strict: a thrown DB error propagates", async () => {
    const { getAppSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    table("app_setting").maybeSingle = vi.fn(() => Promise.reject(new Error("boom")));
    await expect(getAppSetting("product_builder_enabled", null, { strict: true })).rejects.toThrow(/boom/);
  });

  it("a CONSENT key never reads the global row (returns undefined without an override)", async () => {
    const { getAppSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, true);
    expect(await getAppSetting("local_lane_side_effects_allowlist", "t-1")).toBeUndefined();
  });
});

describe("2026-06-29 runtime platform knobs — registry shape + defaults", () => {
  it("all 11 new keys exist with the correct (today's-default) defaultValue", async () => {
    const { APP_SETTINGS } = await import("../registry");
    const expected: Record<string, unknown> = {
      critic_family: "openai",
      model_routing_enabled: true,
      model_routing_mode: "live",
      conductor_enabled: true,
      conductor_repair_enabled: true,
      daily_budget_usd: 0,
      max_code_index_per_tenant_per_day: 5,
      product_builder_enabled: true,
      voice_enabled: false,
      onboarding_web_enrichment: false,
      pm_roadmap_enabled: true,
    };
    for (const [key, def] of Object.entries(expected)) {
      const entry = (APP_SETTINGS as Record<string, { defaultValue: unknown; scope: string }>)[key];
      expect(entry, `missing registry entry: ${key}`).toBeDefined();
      expect(entry.defaultValue, `wrong default for ${key}`).toBe(def);
      expect(entry.scope, `expected global scope for ${key}`).toBe("global");
    }
  });

  it("number knobs carry the mandated bounds (daily_budget money-path + code-index)", async () => {
    const { APP_SETTINGS } = await import("../registry");
    const reg = APP_SETTINGS as Record<string, { min?: number; max?: number; type: string }>;
    expect(reg.daily_budget_usd.type).toBe("number");
    expect(reg.daily_budget_usd.min).toBe(0);
    expect(reg.daily_budget_usd.max).toBe(100000);
    expect(reg.max_code_index_per_tenant_per_day.min).toBe(0);
    expect(reg.max_code_index_per_tenant_per_day.max).toBe(1000);
  });

  it("dropdown knobs carry their option sets", async () => {
    const { APP_SETTINGS } = await import("../registry");
    const reg = APP_SETTINGS as Record<string, { options?: readonly string[] }>;
    expect(reg.critic_family.options).toEqual(["openai", "glm52"]);
    expect(reg.model_routing_mode.options).toEqual(["shadow", "live"]);
  });

  it("daily_budget_usd coercion enforces the money-path bounds", async () => {
    const { coerceSettingValue } = await import("../index");
    const { APP_SETTINGS } = await import("../registry");
    const def = (APP_SETTINGS as Record<string, import("../registry").SettingDef>).daily_budget_usd;
    expect(coerceSettingValue(def, 0)).toBe(0);
    expect(coerceSettingValue(def, "250")).toBe(250);
    expect(() => coerceSettingValue(def, -1)).toThrow();
    expect(() => coerceSettingValue(def, 100001)).toThrow();
  });
});

describe("connector_skill_compounding_enabled (DEFAULT-ON fleet-wide, 2026-06-29)", () => {
  it("defaults ON (true) for any tenant with no override + no global row", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, undefined);
    expect(await getBoolSetting("connector_skill_compounding_enabled", "t-1")).toBe(true);
  });

  it("honors an explicit per-tenant FALSE opt-out", async () => {
    const { getBoolSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(false, undefined);
    expect(await getBoolSetting("connector_skill_compounding_enabled", "t-1")).toBe(false);
  });

  it("is NO LONGER a consent key — a global enable is allowed (not rejected)", async () => {
    const { setGlobalSetting } = await import("../index");
    await expect(
      setGlobalSetting("connector_skill_compounding_enabled", true, "staff@x.com"),
    ).resolves.toBeUndefined();
  });
});

describe("sandbox_enabled_agents (DEFAULT-ON fleet-wide via ['*'] wildcard, 2026-06-29)", () => {
  it("registry default is ['*'] and it is NOT in the consent set", async () => {
    const { APP_SETTINGS, CONSENT_KEYS_PER_TENANT_ONLY } = await import("../registry");
    expect(APP_SETTINGS.sandbox_enabled_agents.defaultValue).toEqual(["*"]);
    expect(APP_SETTINGS.sandbox_enabled_agents.scope).toBe("per-tenant");
    expect(CONSENT_KEYS_PER_TENANT_ONLY.has("sandbox_enabled_agents")).toBe(false);
  });

  it("resolves to ['*'] for any tenant with no override + no global row", async () => {
    const { getSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(undefined, undefined);
    expect(await getSetting("sandbox_enabled_agents", "t-1")).toEqual(["*"]);
  });

  it("honors an explicit per-tenant opt-out ([])", async () => {
    const { getSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime([], undefined);
    expect(await getSetting("sandbox_enabled_agents", "t-1")).toEqual([]);
  });

  it("honors an explicit per-tenant pinned list", async () => {
    const { getSetting, _resetSettingsCache } = await import("../index");
    _resetSettingsCache();
    prime(["pm", "qa"], undefined);
    expect(await getSetting("sandbox_enabled_agents", "t-1")).toEqual(["pm", "qa"]);
  });

  it("is NO LONGER a consent key — a global write of ['*'] is allowed (not rejected)", async () => {
    const { setGlobalSetting } = await import("../index");
    await expect(
      setGlobalSetting("sandbox_enabled_agents", ["*"], "staff@x.com"),
    ).resolves.toBeUndefined();
  });
});

describe("getBoolSettingStrictResolved (kill switches on write paths)", () => {
  it("global OFF with no tenant override resolves OFF", async () => {
    prime(undefined, false);
    const { getBoolSettingStrictResolved } = await import("../index");
    expect(await getBoolSettingStrictResolved("welcome_setup_enabled", "t1")).toBe(false);
  });
  it("a tenant ON overrides a global OFF (same precedence as getBoolSetting)", async () => {
    prime(true, false);
    const { getBoolSettingStrictResolved, getBoolSetting } = await import("../index");
    expect(await getBoolSettingStrictResolved("welcome_setup_enabled", "t1")).toBe(true);
    expect(await getBoolSetting("welcome_setup_enabled", "t1")).toBe(true);
  });
  it("no rows: the registry default", async () => {
    prime(undefined, undefined);
    const { getBoolSettingStrictResolved } = await import("../index");
    expect(await getBoolSettingStrictResolved("welcome_setup_enabled", "t1")).toBe(true);
  });
  it("Autopilot is per-tenant only: a global ON never turns it on for a tenant that did not choose it", async () => {
    prime(undefined, true);
    const { getBoolSettingStrictResolved } = await import("../index");
    expect(await getBoolSettingStrictResolved("cgo_autopilot_enabled", "t1")).toBe(false);
    prime(true, false);
    expect(await getBoolSettingStrictResolved("cgo_autopilot_enabled", "t1")).toBe(true);
  });
  it.each(["tenant_app_setting", "app_setting"])("THROWS on a read error from %s (never the default)", async (t) => {
    prime(undefined, undefined);
    table(t)._resolve = { data: null, error: { message: "db down" } };
    const { getBoolSettingStrictResolved } = await import("../index");
    await expect(getBoolSettingStrictResolved("welcome_setup_enabled", "t1")).rejects.toThrow(/strict setting read failed/);
  });
});
