import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const created: Array<{ opts: { global?: { fetch?: unknown; headers?: Record<string, string> } } }> =
  vi.hoisted(() => []);
vi.mock("@supabase/supabase-js", () => ({
  createClient: (_u: string, _k: string, opts: { global?: { fetch?: unknown } }) => {
    created.push({ opts });
    return { opts };
  },
}));

beforeEach(() => {
  created.length = 0;
  process.env.SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "srk";
  vi.resetModules();
});

describe("supabase clients carry a bounded fetch", () => {
  it("service, bearer, anon and long clients all set global.fetch", async () => {
    const m = await import("../supabase");
    m.serviceClient();
    m.serverClientFromBearer("jwt");
    m.anonClient();
    m.serviceClientLong();
    expect(created).toHaveLength(4);
    for (const c of created) expect(typeof c.opts.global?.fetch).toBe("function");
  });

  it("the bearer client keeps its Authorization header", async () => {
    const m = await import("../supabase");
    m.serverClientFromBearer("jwt-1");
    expect(created[0]!.opts.global?.headers?.Authorization).toBe("Bearer jwt-1");
  });

  it("the long client is its own singleton", async () => {
    const m = await import("../supabase");
    expect(m.serviceClientLong()).not.toBe(m.serviceClient());
    expect(m.serviceClientLong()).toBe(m.serviceClientLong());
  });

  it("both 180s code-index RPCs use the long client", () => {
    const src = readFileSync(join(__dirname, "../code-index/build.ts"), "utf8");
    expect(src).toMatch(/serviceClientLong\(\)\s*\.rpc\("code_index_commit"/);
    expect(src).toMatch(/serviceClientLong\(\)\s*\.rpc\("code_index_insert_chunk"/);
  });
});
