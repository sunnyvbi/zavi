import { describe, expect, it } from "vitest";
import { createShardRegistry, shardEnv } from "../registry";
import { NoShardCapacity } from "../contract";
import { intLit, jsonLit, nameLit, textLit, uuidLit } from "../sql";

const T = "aaaaaaaa-0000-4000-8000-00000000000a";
const S = "11111111-1111-4111-8111-111111111111";

describe("ShardRegistry", () => {
  it("site calls go through tenantRpc with the scope tenant, never a caller-supplied one", async () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const reg = createShardRegistry({
      shardRpc: async () => ({ data: null, error: null }),
      tenantRpc: async (tid, name, args) => {
        calls.push([tid, name, args]);
        return { data: [{ shard_id: "33333333-3333-4333-8333-333333333333", project_ref: "refrefrefref", url: "https://refrefrefref.supabase.co", placed: true }], error: null };
      },
    });
    const r = await reg.place(T, S, "dev");
    expect(r.placed).toBe(true);
    expect(calls).toEqual([[T, "site_backend_place", { p_site_id: S, p_env: "dev" }]]);
    expect(calls[0][2]).not.toHaveProperty("p_tenant_id");
  });

  it("maps SQLSTATE 53400 to NoShardCapacity and refuses non-uuid ids before any call", async () => {
    let n = 0;
    const reg = createShardRegistry({
      shardRpc: async () => ({ data: null, error: null }),
      tenantRpc: async () => (n++, { data: null, error: { code: "53400", message: "site_backend_place: no shard capacity in dev" } }),
    });
    await expect(reg.place(T, S, "dev")).rejects.toBeInstanceOf(NoShardCapacity);
    await expect(reg.place(T, "x' or 1=1 --", "dev")).rejects.toThrow(/uuids/);
    await expect(reg.place("not-a-tenant", S, "dev")).rejects.toThrow(/uuids/);
    expect(n).toBe(1);
  });

  it("only registers zavi-shard-<env>-<n> names and only patches whitelisted keys", async () => {
    const reg = createShardRegistry({ shardRpc: async () => ({ data: null, error: null }), tenantRpc: async () => ({ data: null, error: null }) });
    await expect(reg.register({ env: "dev", name: "zavi-shard-prod-1", region: "us-west-1" })).rejects.toThrow();
    await expect(reg.register({ env: "dev", name: "evil", region: "us-west-1" })).rejects.toThrow();
    await expect(reg.update(S, { site_count: 0 } as never)).rejects.toThrow(/not patchable/);
  });

  it("prod shards only from the prod backend; nothing can force prod elsewhere", () => {
    expect(shardEnv({ SUPABASE_URL: "https://wmycgyjsenvgtczlupoe.supabase.co" })).toBe("prod");
    expect(shardEnv({ SUPABASE_URL: "https://wmycgyjsenvgtczlupoe.supabase.co", SITE_SHARD_ENV: "dev" })).toBe("dev");
    expect(shardEnv({ SUPABASE_URL: "https://dgzgwclslzzzrjopbobp.supabase.co", SITE_SHARD_ENV: "prod" })).toBe("dev");
    expect(shardEnv({})).toBe("dev");
  });
});

describe("SQL literals (the Management API takes no bind parameters)", () => {
  it("escapes quotes, refuses NUL, checks shapes", () => {
    expect(textLit("o'brien")).toBe("'o''brien'");
    expect(textLit("a\\'; drop table x; --")).toBe("'a\\''; drop table x; --'");
    expect(() => textLit("a\u0000b")).toThrow();
    expect(jsonLit({ q: "it's" })).toBe(`'{"q":"it''s"}'::jsonb`);
    expect(() => uuidLit("1' or '1'='1")).toThrow();
    expect(() => nameLit("bookings; drop")).toThrow();
    expect(() => nameLit("Bookings")).toThrow();
    expect(nameLit("bookings_2")).toBe("'bookings_2'");
    expect(() => intLit(1.5)).toThrow();
  });
});
