
import { describe, it, expect, vi, beforeEach } from "vitest";
import { APP_SETTINGS } from "../registry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockTable = Record<string, any> & { _resolve: { data: unknown; error: unknown } };
const tables: Record<string, MockTable> = {};
function table(name: string): MockTable {
  if (!tables[name]) {
    const t = {} as MockTable;
    t._resolve = { data: null, error: null };
    t.select = vi.fn(() => t);
    t.eq = vi.fn(() => t);
    t.maybeSingle = vi.fn(() => Promise.resolve(t._resolve));
    tables[name] = t;
  }
  return tables[name];
}
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({ from: vi.fn((n: string) => table(n)) })),
}));

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("fast build registry entries", () => {
  it("the old/new build switch and the pooled kill switch no longer exist (one pipeline, pooled for every site)", () => {
    expect("build_flow" in APP_SETTINGS).toBe(false);
    expect("site_backend_pooled" in APP_SETTINGS).toBe(false);
  });
  it("fast_build_turn_cap = 60 and fast_build_repair_attempts = 1 (numbers)", () => {
    expect(APP_SETTINGS.fast_build_turn_cap).toMatchObject({ type: "number", defaultValue: 60 });
    expect(APP_SETTINGS.fast_build_repair_attempts).toMatchObject({ type: "number", defaultValue: 1 });
  });
});

describe("getStringSettingStrict", () => {
  it("tenant override wins, then global, then the default", async () => {
    const { getStringSettingStrict } = await import("../index");
    table("tenant_app_setting")._resolve = { data: { value: "tenant-value" }, error: null };
    table("app_setting")._resolve = { data: { value: "global-value" }, error: null };
    expect(await getStringSettingStrict("build_app_intent", "t1")).toBe("tenant-value");
    table("tenant_app_setting")._resolve = { data: null, error: null };
    expect(await getStringSettingStrict("build_app_intent", "t1")).toBe("global-value");
    table("app_setting")._resolve = { data: null, error: null };
    expect(await getStringSettingStrict("build_app_intent", "t1")).toBe(APP_SETTINGS.build_app_intent.defaultValue);
  });

  it("throws on a read error instead of returning the default", async () => {
    const { getStringSettingStrict } = await import("../index");
    table("tenant_app_setting")._resolve = { data: null, error: { message: "db down" } };
    await expect(getStringSettingStrict("build_app_intent", "t1")).rejects.toThrow(/db down/);
    table("tenant_app_setting")._resolve = { data: null, error: null };
    table("app_setting")._resolve = { data: null, error: { message: "db down 2" } };
    await expect(getStringSettingStrict("build_app_intent", "t1")).rejects.toThrow(/db down 2/);
  });

  it("throws on a non-string stored value", async () => {
    const { getStringSettingStrict } = await import("../index");
    table("tenant_app_setting")._resolve = { data: { value: 42 }, error: null };
    await expect(getStringSettingStrict("build_app_intent", "t1")).rejects.toThrow(/not a string/);
  });
});
