
import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockTable = Record<string, any> & { _resolve: { data: unknown; error: unknown } };
function newMockTable(): MockTable {
  const t = {} as MockTable;
  t._resolve = { data: [], error: null };
  t.select = vi.fn(() => t);
  t.eq = vi.fn(() => t);
  t.maybeSingle = vi.fn(() => Promise.resolve(t._resolve));
  t.then = (r: (v: { data: unknown; error: unknown }) => void) => r(t._resolve);
  return t;
}
const tables: Record<string, MockTable> = {};
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn((n: string) => (tables[n] ??= newMockTable())),
  })),
}));

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("listSettings — secret redaction", () => {
  it("redacts a stored credential value but still reports it as configured", async () => {
    const { listSettings, REDACTED_SETTING_VALUE } = await import("../index");
    (tables["app_setting"] ??= newMockTable())._resolve = {
      data: [{ key: "anthropic_oauth_token_pool", value: "oat-real-secret-1,oat-real-secret-2" }],
      error: null,
    };
    (tables["tenant_app_setting"] ??= newMockTable())._resolve = { data: [], error: null };

    const rows = await listSettings();
    const row = rows.find((r) => r.key === "anthropic_oauth_token_pool");
    expect(row).toBeDefined();
    expect(row!.globalValue).toBe(REDACTED_SETTING_VALUE);
    expect(JSON.stringify(rows)).not.toContain("oat-real-secret");
  });

  it("an unset credential stays empty so the UI can show 'not configured'", async () => {
    const { listSettings } = await import("../index");
    (tables["app_setting"] ??= newMockTable())._resolve = { data: [], error: null };
    (tables["tenant_app_setting"] ??= newMockTable())._resolve = { data: [], error: null };

    const rows = await listSettings();
    expect(rows.find((r) => r.key === "anthropic_oauth_token_pool")!.globalValue).toBe("");
  });

  it("non-secret settings are unaffected", async () => {
    const { listSettings } = await import("../index");
    (tables["app_setting"] ??= newMockTable())._resolve = {
      data: [{ key: "memory_reranker_enabled", value: false }],
      error: null,
    };
    (tables["tenant_app_setting"] ??= newMockTable())._resolve = { data: [], error: null };

    const rows = await listSettings();
    expect(rows.find((r) => r.key === "memory_reranker_enabled")!.globalValue).toBe(false);
  });
});
