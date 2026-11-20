import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRenderHostingProvisioner } from "@/services/provisioning/render-hosting";

vi.mock("@/services/secrets/vault", () => ({
  getSecret: vi.fn(async () => null),
}));
vi.mock("@/services/provisioning/secret", () => ({
  setResourceSecret: vi.fn(async (_t: string, _k: string, key: string) => key),
}));

type Call = { url: string; method: string; body: string | undefined };

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

const ctxDb = { context: { repo_url: "https://github.com/praxis-built/acme", neon_project_id: "proj-1" } };
const DB_URL = "postgres://u:p@ep-x.neon.tech/neondb?sslmode=require";
const SECRET = "s".repeat(43);

function renderWorld(opts: {
  existing: boolean;
  envPut: (key: string, attempt: number) => number | "throw";
}) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (method === "GET" && url.includes("/v1/services?name=")) {
      return opts.existing
        ? res(200, [{ service: { id: "srv_1", serviceDetails: { url: "https://acme.onrender.com" } } }])
        : res(200, []);
    }
    if (method === "POST" && url.endsWith("/v1/services")) {
      return res(201, { id: "srv_1", serviceDetails: { url: "https://acme.onrender.com" } });
    }
    const m = url.match(/\/env-vars\/([^/]+)$/);
    if (method === "PUT" && m) {
      const key = decodeURIComponent(m[1]);
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      const out = opts.envPut(key, n);
      if (out === "throw") throw new Error("socket hang up");
      return res(out, {});
    }
    if (method === "POST" && url.endsWith("/deploys")) return res(201, { id: "dep_1" });
    return res(404, {});
  });
  const provisioner = createRenderHostingProvisioner({
    token: () => "tok",
    ownerId: () => "own",
    fetchFn: fetchFn as never,
    dbUrl: async () => DB_URL,
    sessionSecret: async () => ({ value: SECRET, created: true }),
  });
  const deploys = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/deploys"));
  const puts = (key: string) => calls.filter((c) => c.method === "PUT" && c.url.endsWith(`/env-vars/${key}`));
  return { provisioner, calls, deploys, puts };
}

describe("render hosting env-var writes must land before a deploy (finding #10)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined) as ReturnType<typeof vi.spyOn>;
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("fresh service: DATABASE_URL PUT keeps failing, so ensure rejects and no redeploy is triggered", async () => {
    const w = renderWorld({ existing: false, envPut: (key) => (key === "DATABASE_URL" ? 500 : 200) });
    const err = await w.provisioner.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/DATABASE_URL/);
    expect(err!.message).not.toMatch(/SESSION_SECRET/);
    expect(err!.message).not.toContain(DB_URL);
    expect(err!.message).not.toContain(SECRET);
    expect(w.puts("DATABASE_URL").length).toBe(3);
    expect(w.puts("SESSION_SECRET").length).toBe(1);
    expect(w.deploys()).toHaveLength(0);
  });

  it("existing service heal: SESSION_SECRET PUT throws every time, so ensure rejects instead of reporting hosting ready, and does not redeploy", async () => {
    const w = renderWorld({ existing: true, envPut: (key) => (key === "SESSION_SECRET" ? "throw" : 204) });
    const err = await w.provisioner.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/could not set SESSION_SECRET on srv_1/);
    expect(err!.message).not.toContain(SECRET);
    expect(err!.message).not.toContain(DB_URL);
    expect(w.puts("SESSION_SECRET").length).toBe(3);
    expect(w.puts("DATABASE_URL").length).toBe(1);
    expect(w.deploys()).toHaveLength(0);
    expect(w.calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/services"))).toBe(false);
  });

  it("existing service heal during a full Render env-var outage rejects naming both keys", async () => {
    const w = renderWorld({ existing: true, envPut: () => 503 });
    const err = await w.provisioner.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toMatch(/could not set DATABASE_URL, SESSION_SECRET on srv_1/);
    expect(w.puts("DATABASE_URL").length).toBe(3);
    expect(w.puts("SESSION_SECRET").length).toBe(3);
    expect(w.deploys()).toHaveLength(0);
  });

  it("a create that failed its DATABASE_URL write cannot be turned into success by the retry finding the service (DEL-1323 B2)", async () => {
    const w = renderWorld({ existing: false, envPut: (key) => (key === "DATABASE_URL" ? 500 : 200) });
    const first = await w.provisioner.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb }).then(
      () => null,
      (e: Error) => e,
    );
    expect(first!.message).toMatch(/DATABASE_URL/);
    expect(w.calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/services"))).toBe(true);
    const retry = renderWorld({ existing: true, envPut: (key) => (key === "DATABASE_URL" ? 500 : 200) });
    const second = await retry.provisioner.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb }).then(
      () => null,
      (e: Error) => e,
    );
    expect(second).toBeInstanceOf(Error);
    expect(second!.message).toMatch(/could not set DATABASE_URL on srv_1/);
    expect(retry.deploys()).toHaveLength(0);
  });

  it("existing service heal that lands both keys resolves and redeploys once", async () => {
    const w = renderWorld({ existing: true, envPut: (_key, n) => (n === 1 ? 502 : 204) });
    const r = await w.provisioner.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });
    expect(r.external_ref).toEqual({ render_service_id: "srv_1", url: "https://acme.onrender.com" });
    expect(w.puts("DATABASE_URL").length).toBe(2);
    expect(w.puts("SESSION_SECRET").length).toBe(2);
    expect(w.deploys()).toHaveLength(1);
  });

  it("a transient PUT failure is retried and the provision succeeds with one redeploy", async () => {
    const w = renderWorld({
      existing: false,
      envPut: (key, n) => (key === "DATABASE_URL" && n === 1 ? 429 : key === "SESSION_SECRET" && n === 1 ? "throw" : 200),
    });
    const r = await w.provisioner.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });
    expect(r.external_ref.render_service_id).toBe("srv_1");
    expect(w.puts("DATABASE_URL").length).toBe(2);
    expect(w.puts("SESSION_SECRET").length).toBe(2);
    expect(w.deploys()).toHaveLength(1);
    const lastDbPut = w.puts("DATABASE_URL").at(-1)!;
    expect(JSON.parse(lastDbPut.body!)).toEqual({ value: DB_URL });
  });

  it("a static app with no env vars never fails on env writes", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "GET") return res(200, []);
      if (url.endsWith("/v1/services")) return res(201, { id: "srv_s", serviceDetails: { url: "https://s.onrender.com" } });
      return res(500, {});
    });
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => null,
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Static", context: { repo_url: "https://github.com/x/y" } });
    expect(r.external_ref.render_service_id).toBe("srv_s");
    expect(calls.some((c) => c.includes("/env-vars/"))).toBe(false);
  });
});
