import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));
vi.mock("@/services/data-gateway/connector/wakeup", () => ({
  ensureWakeupSubscription: () => undefined,
  waitForWake: async () => "timeout",
  publishWake: async () => undefined,
  publishRevoke: async () => undefined,
  onRevoke: () => () => undefined,
}));

import { connectorRouter, type ConnectorRouteDeps } from "../handlers";
import { _resetAuthLogSampling } from "../auth";
import { redeemPairCode } from "@/services/data-gateway/connector/pairing";
import { generatePairCode } from "@/services/data-gateway/connector/token";

const GOOD = "zconn_" + "a".repeat(64);
const OTHER = "zconn_" + "b".repeat(64);
const REQ = "11111111-2222-4333-8444-555555555555";
const TOKEN_UUID = "99999999-8888-4777-8666-555555555555";

let server: Server;
let base: string;
let deps: Partial<ConnectorRouteDeps>;

function resolveDeps() {
  return {
    preTenantRpc: vi.fn(async (_n: string, args: Record<string, unknown>) => {
      const { createHash } = await import("node:crypto");
      const hash = (s: string) => createHash("sha256").update(s).digest("hex");
      if (args.p_token_hash === hash(GOOD)) return { data: [{ tenant_id: "tenant-A", connector_id: "conn-A" }], error: null };
      return { data: [], error: null };
    }) as never,
  };
}

function rpcFake(over: Record<string, unknown> = {}) {
  return vi.fn(async (_t: string, name: string) => {
    if (name in over) return { data: over[name], error: null };
    if (name === "acquire_db_connector_poll") return { data: [{ acquired: true, retry_after: 0 }], error: null };
    if (name === "release_db_connector_poll") return { data: null, error: null };
    if (name === "touch_db_connector") return { data: [{ is_active: true, was_offline: false, offline_seconds: 0, rules_changed: false, discovery_generation: null }], error: null };
    if (name === "set_db_connector_dialect") return { data: null, error: null };
    return { data: null, error: null };
  });
}

async function start(over: Partial<ConnectorRouteDeps>) {
  let clock = 0;
  deps = {
    claimNext: vi.fn(async () => null),
    complete: vi.fn(async () => "accepted" as const),
    rpc: rpcFake() as never,
    sendDiscovery: vi.fn(async () => true),
    waitForWake: vi.fn(async (_t: string, ms: number) => {
      clock += ms;
      return "timeout" as const;
    }),
    subscribe: vi.fn(),
    now: () => clock,
    longPollMs: 25_000,
    resolve: resolveDeps(),
    ...over,
  };
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/connector", connectorRouter(deps));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connector`;
}

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) },
  });

beforeEach(() => _resetAuthLogSampling());
afterEach(async () => {
  await new Promise((r) => server.close(r));
});

describe("token auth", () => {
  it("missing, garbage, unknown or revoked token -> generic 401 on every route", async () => {
    await start({});
    for (const token of [undefined, "garbage", "zconn_nope", OTHER]) {
      expect((await call("/requests/next", { token })).status).toBe(401);
      expect((await call(`/requests/${REQ}/result`, { method: "POST", token, body: "{}" })).status).toBe(401);
      expect((await call("/heartbeat", { method: "POST", token, body: "{}" })).status).toBe(401);
    }
    expect(deps.claimNext).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });
  it("the tenant always comes from the token: ?tenant_id and body tenant_id are ignored", async () => {
    await start({});
    await call("/requests/next?tenant_id=tenant-B", { token: GOOD });
    expect(deps.claimNext).toHaveBeenCalledWith("tenant-A", "conn-A");
    await call(`/requests/${REQ}/result?tenant_id=tenant-B`, {
      method: "POST",
      token: GOOD,
      body: JSON.stringify({ tenant_id: "tenant-B", connector_id: "conn-B", execution_token: TOKEN_UUID, status: "refused", reason: "no" }),
    });
    expect(deps.complete).toHaveBeenCalledWith("tenant-A", "conn-A", REQ, TOKEN_UUID, "refused", null, "no", { generation: null, source_instance_id: null });
  });
});

describe("long-poll", () => {
  it("idle: a claim on connect, one per 5s safety re-check, one final, then 204; the lease is taken and released", async () => {
    await start({});
    expect((await call("/requests/next", { token: GOOD })).status).toBe(204);
    expect((deps.claimNext as ReturnType<typeof vi.fn>).mock.calls.length).toBe(7);
    const rpcNames = (deps.rpc as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(rpcNames[0]).toBe("acquire_db_connector_poll");
    expect(rpcNames.at(-1)).toBe("release_db_connector_poll");
    expect(deps.subscribe).toHaveBeenCalled();
  });
  it("a wakeup claims at once and delivers", async () => {
    let n = 0;
    await start({
      claimNext: vi.fn(async () => (++n === 2 ? { id: REQ, execution_token: TOKEN_UUID, op: { op: "describe" }, generation: 3 } : null)),
      waitForWake: vi.fn(async () => "wake" as const),
    });
    const r = await call("/requests/next", { token: GOOD });
    expect(r.status).toBe(200);
    expect(n).toBe(2);
  });
  it("another poll holds this connector's lease (any instance) -> 429 with Retry-After, nothing claimed", async () => {
    await start({ rpc: rpcFake({ acquire_db_connector_poll: [{ acquired: false, retry_after: 12 }] }) as never });
    const r = await call("/requests/next", { token: GOOD });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("12");
    expect(deps.claimNext).not.toHaveBeenCalled();
  });
  it("a queued read -> 200 with id, execution token and the op", async () => {
    await start({ claimNext: vi.fn(async () => ({ id: REQ, execution_token: TOKEN_UUID, op: { op: "describe" }, generation: 3 })) });
    const r = await call("/requests/next", { token: GOOD });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: REQ, execution_token: TOKEN_UUID, op: { op: "describe" }, generation: 3 });
  });
  it("an op the protocol does not allow is never delivered; it is failed so the waiter stops", async () => {
    let n = 0;
    await start({ claimNext: vi.fn(async () => (++n === 1 ? { id: REQ, execution_token: TOKEN_UUID, op: { op: "drop_table" }, generation: 3 } : null)) });
    expect((await call("/requests/next", { token: GOOD })).status).toBe(204);
    expect(deps.complete).toHaveBeenCalledWith("tenant-A", "conn-A", REQ, TOKEN_UUID, "failed", null, expect.any(String), { generation: 3, source_instance_id: null });
  });
});

describe("results", () => {
  const SRC = "0123456789abcdef0123456789abcdef";
  const done = { execution_token: TOKEN_UUID, generation: 3, source_instance_id: SRC, status: "done", data: { kind: "count", count: 3 } };
  it("valid -> 204, with the echoed generation and source instance as the fence", async () => {
    await start({});
    expect((await call(`/requests/${REQ}/result`, { method: "POST", token: GOOD, body: JSON.stringify(done) })).status).toBe(204);
    expect(deps.complete).toHaveBeenCalledWith("tenant-A", "conn-A", REQ, TOKEN_UUID, "done", { status: "done", data: { kind: "count", count: 3 } }, null, { generation: 3, source_instance_id: SRC });
  });
  it("a data result without the fences -> 400, never stored", async () => {
    await start({});
    const { generation: _g, source_instance_id: _s, ...bare } = done;
    expect((await call(`/requests/${REQ}/result`, { method: "POST", token: GOOD, body: JSON.stringify(bare) })).status).toBe(400);
    expect(deps.complete).not.toHaveBeenCalled();
  });
  it("a result from another source or generation -> 409 source_changed", async () => {
    await start({ complete: vi.fn(async () => "source_changed" as const) });
    const r = await call(`/requests/${REQ}/result`, { method: "POST", token: GOOD, body: JSON.stringify(done) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "source_changed" } });
  });
  it("stale execution token / another tenant's request -> 409", async () => {
    await start({ complete: vi.fn(async () => "stale" as const) });
    expect((await call(`/requests/${REQ}/result`, { method: "POST", token: GOOD, body: JSON.stringify(done) })).status).toBe(409);
  });
  it("a retried POST of the same delivery is accepted again without overwriting (duplicate -> 204)", async () => {
    await start({ complete: vi.fn(async () => "duplicate" as const) });
    expect((await call(`/requests/${REQ}/result`, { method: "POST", token: GOOD, body: JSON.stringify(done) })).status).toBe(204);
  });
  it("invalid or oversized result -> 400 and complete is never called", async () => {
    await start({});
    const bad = [
      { ...done, execution_token: "nope" },
      { execution_token: TOKEN_UUID, status: "done", data: { kind: "rows", columns: ["a"], rows: [["x".repeat(5000)]], truncated: false, removed_columns: [], rule: "rows_without_blocked_columns" } },
      { execution_token: TOKEN_UUID, status: "maybe" },
    ];
    for (const b of bad) expect((await call(`/requests/${REQ}/result`, { method: "POST", token: GOOD, body: JSON.stringify(b) })).status).toBe(400);
    expect((await call(`/requests/not-a-uuid/result`, { method: "POST", token: GOOD, body: JSON.stringify(done) })).status).toBe(400);
    expect(deps.complete).not.toHaveBeenCalled();
  });
});

describe("heartbeat", () => {
  it("a new dialect: discovery generation from the same transaction is sent for the token's tenant", async () => {
    const rpc = rpcFake({ set_db_connector_dialect: 3 });
    await start({ rpc: rpc as never });
    const r = await call("/heartbeat", { method: "POST", token: GOOD, body: JSON.stringify({ source_instance_id: null, machine: "mac-1", version: "1.0.0", dialect: "postgres", tenant_id: "tenant-B" }) });
    expect(r.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("tenant-A", "set_db_connector_dialect", { p_connector_id: "conn-A", p_dialect: "postgres" });
    expect(deps.sendDiscovery).toHaveBeenCalledWith("tenant-A", 3);
  });
  it("changed rules (with their hash) start discovery; the rules travel only as the connector reports them", async () => {
    const rpc = rpcFake({ touch_db_connector: [{ is_active: true, was_offline: false, rules_changed: true, discovery_generation: 7 }] });
    await start({ rpc: rpc as never });
    const rules = { allowed_tables: ["bookings"], blocked_fields: ["users.email"], what_can_leave: "rows_without_blocked_columns", max_rows: 200 };
    await call("/heartbeat", { method: "POST", token: GOOD, body: JSON.stringify({ source_instance_id: null, machine: "m", version: "1", rules, rules_hash: "c".repeat(64) }) });
    expect(rpc.mock.calls[0]).toEqual(["tenant-A", "touch_db_connector", { p_connector_id: "conn-A", p_machine: "m", p_version: "1", p_rules: rules, p_rules_hash: "c".repeat(64), p_source_instance_id: null }]);
    expect(deps.sendDiscovery).toHaveBeenCalledWith("tenant-A", 7);
  });
  it("the database's source instance reaches touch_db_connector; a heartbeat without one is refused", async () => {
    const rpc = rpcFake({ touch_db_connector: [{ is_active: true, was_offline: false, rules_changed: false, discovery_generation: 9, source_changed: true }] });
    await start({ rpc: rpc as never });
    const src = "0123456789abcdef0123456789abcdef";
    expect((await call("/heartbeat", { method: "POST", token: GOOD, body: JSON.stringify({ machine: "m", version: "1", dialect: "postgres", source_instance_id: src }) })).status).toBe(200);
    expect((rpc.mock.calls[0] as unknown[])[2]).toMatchObject({ p_source_instance_id: src });
    expect(deps.sendDiscovery).toHaveBeenCalledWith("tenant-A", 9);
    expect((await call("/heartbeat", { method: "POST", token: GOOD, body: JSON.stringify({ machine: "m", version: "1" }) })).status).toBe(400);
  });
  it("rules without a hash are refused (a change would go unnoticed)", async () => {
    await start({});
    const rules = { allowed_tables: [], blocked_fields: [], what_can_leave: "totals_and_counts_only", max_rows: 10 };
    expect((await call("/heartbeat", { method: "POST", token: GOOD, body: JSON.stringify({ source_instance_id: null, machine: "m", version: "1", rules }) })).status).toBe(400);
  });
  it("nothing changed -> no discovery", async () => {
    await start({});
    await call("/heartbeat", { method: "POST", token: GOOD, body: JSON.stringify({ source_instance_id: null, machine: "m", version: "1", dialect: "postgres" }) });
    expect(deps.sendDiscovery).not.toHaveBeenCalled();
  });
  it("a connector revoked between auth and touch -> 401", async () => {
    await start({ rpc: rpcFake({ touch_db_connector: [{ is_active: false }] }) as never });
    expect((await call("/heartbeat", { method: "POST", token: GOOD, body: JSON.stringify({ source_instance_id: null, machine: "m", version: "1" }) })).status).toBe(401);
  });
  it("bad body -> 400", async () => {
    await start({});
    expect((await call("/heartbeat", { method: "POST", token: GOOD, body: JSON.stringify({ source_instance_id: null, machine: "", version: "1" }) })).status).toBe(400);
  });
});

describe("token cache", () => {
  it("a resolved token is cached (no DB per reconnect) for at most the TTL", async () => {
    const auth = await import("../auth");
    const pre = vi.fn(async () => ({ data: [{ tenant_id: "tenant-A", connector_id: "conn-A" }], error: null }));
    let t = 0;
    const d = { preTenantRpc: pre as never, now: () => t };
    expect(await auth.resolveConnectorToken(GOOD, d)).toEqual({ tenant_id: "tenant-A", connector_id: "conn-A" });
    await auth.resolveConnectorToken(GOOD, d);
    expect(pre).toHaveBeenCalledTimes(1);
    t += auth.TOKEN_CACHE_TTL_MS + 1;
    await auth.resolveConnectorToken(GOOD, d);
    expect(pre).toHaveBeenCalledTimes(2);
  });
});

describe("secret-bearing responses", () => {
  it("/pair is never cached", async () => {
    await start({ redeem: vi.fn(async () => ({ ok: true as const, token: GOOD, tenant_id: "t", connector_id: "c" })) });
    const r = await call("/pair", { method: "POST", body: JSON.stringify({ code: "zpair_" + "A".repeat(26), machine: "m", version: "1" }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("pair: client IP and limits", () => {
  function realRedeem() {
    const counts = new Map<string, number>();
    const limits = {
      env: { SUPABASE_SERVICE_ROLE_KEY: "test-service-role-secret-0123" } as NodeJS.ProcessEnv,
      rpc: (async (name: string, args: Record<string, unknown>) => {
        const s = String(args.p_ip_scope);
        if (name === "db_connector_pair_reserve") {
          if ((counts.get(s) ?? 0) >= 10) return { data: [{ allowed: false, global_attempts: 0 }], error: null };
          counts.set(s, (counts.get(s) ?? 0) + 1);
          return { data: [{ allowed: true, global_attempts: 1 }], error: null };
        }
        return { data: null, error: null };
      }) as never,
    };
    const ips: unknown[] = [];
    const redeem: typeof redeemPairCode = async (input) => {
      ips.push(input.ip);
      return redeemPairCode(input, {
        limits,
        preTenantRpc: (async () => ({ data: [], error: null })) as never,
        tenantRpc: (async () => ({ data: null, error: null })) as never,
        log: async () => undefined,
        alert: async () => undefined,
      });
    };
    return { redeem, ips };
  }
  const code = generatePairCode();
  const pair = (xff: string) => call("/pair", { method: "POST", headers: { "x-forwarded-for": xff }, body: JSON.stringify({ code, machine: "m", version: "1" }) });

  it("uses the address nginx appended, never a spoofed left-most X-Forwarded-For", async () => {
    const { redeem, ips } = realRedeem();
    await start({ redeem });
    await pair("6.6.6.6, 203.0.113.9");
    expect(ips).toEqual(["203.0.113.9"]);
  });
  it("rotating spoofed entries cannot bypass the per-IP limit", async () => {
    const { redeem } = realRedeem();
    await start({ redeem });
    for (let i = 0; i < 10; i++) expect((await pair(`1.2.3.${i}, 203.0.113.9`)).status).toBe(401);
    expect((await pair("8.8.8.8, 203.0.113.9")).status).toBe(429);
  });
  it("spoofing another client's IP cannot frame it", async () => {
    const { redeem } = realRedeem();
    await start({ redeem });
    for (let i = 0; i < 10; i++) await pair("198.51.100.1, 203.0.113.9");
    expect((await pair("10.0.0.1, 198.51.100.1")).status).toBe(401);
  });
  it("bad body -> 400", async () => {
    await start({});
    expect((await call("/pair", { method: "POST", body: JSON.stringify({ code: 1 }) })).status).toBe(400);
  });
});
