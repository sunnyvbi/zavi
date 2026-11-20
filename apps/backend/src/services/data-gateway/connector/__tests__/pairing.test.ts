import { describe, it, expect, vi, beforeEach } from "vitest";
import { PAIR_CODE_PATTERN } from "@zavi/shared/db-guard";
import { CROCKFORD, generatePairCode, normalizePairCode, sha256Hex, generateConnectorToken, isConnectorToken } from "../token";
import { redeemPairCode, createPairCode } from "../pairing";
import { ipScope, ipPepper, PEPPER_LABEL, reservePairAttempt, subnetOf } from "../rate-limit";

const TOKEN = "zconn_" + "ab".repeat(32);

function limiter(opts: { fail?: boolean } = {}) {
  const counts = new Map<string, number>();
  let total = 0;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (opts.fail) return { data: null, error: { message: "down" } };
    const ip = String(args.p_ip_scope);
    const net = String(args.p_net_scope);
    if (name === "db_connector_pair_reserve") {
      if ((counts.get(ip) ?? 0) >= 10 || (counts.get(net) ?? 0) >= 30) return { data: [{ allowed: false, global_attempts: 0 }], error: null };
      counts.set(ip, (counts.get(ip) ?? 0) + 1);
      counts.set(net, (counts.get(net) ?? 0) + 1);
      total += 1;
      return { data: [{ allowed: true, global_attempts: total }], error: null };
    }
    if (name === "db_connector_pair_refund") {
      counts.set(ip, Math.max(0, (counts.get(ip) ?? 0) - 1));
      counts.set(net, Math.max(0, (counts.get(net) ?? 0) - 1));
      total = Math.max(0, total - 1);
      return { data: null, error: null };
    }
    throw new Error(name);
  });
  return { rpc: rpc as never, raw: rpc, env: { SUPABASE_SERVICE_ROLE_KEY: "test-service-role-secret-0123" } as NodeJS.ProcessEnv };
}

function deps(over: { resolve?: unknown; redeem?: unknown; limits?: ReturnType<typeof limiter> } = {}) {
  const limits = over.limits ?? limiter();
  const preTenantRpc = vi.fn(async () => ({ data: over.resolve ?? [], error: null }));
  const tenantRpc = vi.fn(async () => ({ data: "redeem" in over ? over.redeem : "conn-1", error: null }));
  const log = vi.fn(async () => undefined);
  const alert = vi.fn(async () => undefined);
  const revoke = vi.fn(async () => undefined);
  return { d: { preTenantRpc: preTenantRpc as never, tenantRpc: tenantRpc as never, limits, log, alert, newToken: () => TOKEN, revoke }, preTenantRpc, tenantRpc, log, alert, limits, revoke };
}

describe("pairing codes and tokens", () => {
  it("code is zpair_ + 26 Crockford characters (130 bits) and matches the shared pattern", () => {
    for (let i = 0; i < 50; i++) {
      const c = generatePairCode();
      expect(c).toMatch(PAIR_CODE_PATTERN);
      expect(c.slice(6)).toHaveLength(26);
      for (const ch of c.slice(6)) expect(CROCKFORD).toContain(ch);
    }
    expect(26 * Math.log2(CROCKFORD.length)).toBeGreaterThanOrEqual(130);
  });
  it("every symbol is reachable (low 5 bits of each byte)", () => {
    const c = generatePairCode((n) => Buffer.from(Array.from({ length: n }, (_, i) => i + 6)));
    expect(c.slice(6)).toBe(CROCKFORD.slice(6, 32));
  });
  it("normalizes case and look-alikes, refuses anything else", () => {
    const c = generatePairCode();
    expect(normalizePairCode(`  ${c.toLowerCase()} `)).toBe(c);
    expect(normalizePairCode("ZPAIR_" + "O".repeat(26))).toBe("zpair_" + "0".repeat(26));
    expect(normalizePairCode("zpair_short")).toBeNull();
    expect(normalizePairCode("zpair_" + "U".repeat(26))).toBeNull();
    expect(normalizePairCode(42)).toBeNull();
  });
  it("token is zconn_ + 64 hex", () => {
    expect(isConnectorToken(generateConnectorToken())).toBe(true);
    expect(isConnectorToken("zconn_nope")).toBe(false);
  });
  it("the IP is never stored, only an HMAC scope keyed by a derived pepper", () => {
    const env = { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-0123456789" } as NodeJS.ProcessEnv;
    expect(ipScope("1.2.3.4", env)).toMatch(/^ip:[0-9a-f]{64}$/);
    expect(ipScope("1.2.3.4", env)).not.toContain("1.2.3.4");
    const pepper = ipPepper(env)!;
    expect(pepper).toMatch(/^[0-9a-f]{64}$/);
    expect(pepper).not.toBe(PEPPER_LABEL);
    expect(pepper).not.toBe(env.SUPABASE_SERVICE_ROLE_KEY);
    expect(ipScope("1.2.3.4", { SUPABASE_SERVICE_ROLE_KEY: "another-secret-0123456789" } as NodeJS.ProcessEnv)).not.toBe(ipScope("1.2.3.4", env));
  });
  it("subnets: /24 for IPv4 (and IPv4-mapped IPv6), /64 for IPv6", () => {
    expect(subnetOf("203.0.113.77")).toBe("203.0.113.0/24");
    expect(subnetOf("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
    expect(subnetOf("2001:db8:abcd:12:1::5")).toBe("2001:db8:abcd:12::/64");
    expect(subnetOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(subnetOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(subnetOf(undefined)).toBe("unknown");
  });
  it("no secret -> no pepper, no scope (never a literal fallback)", () => {
    expect(ipPepper({} as NodeJS.ProcessEnv)).toBeNull();
    expect(ipScope("1.2.3.4", {} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("createPairCode", () => {
  it("sends only the code's hash, on the founder's own RPC", async () => {
    const rpc = vi.fn(async () => ({ data: [{ code_id: "code-1", issued_at: "2026-10-12T10:00:00Z", expires_at: "2026-10-12T10:30:00Z" }], error: null }));
    const out = await createPairCode(rpc, "t1");
    expect(out).toMatchObject({ pairing_id: "code-1", issued_at: "2026-10-12T10:00:00Z", expires_in_seconds: 1800 });
    expect(rpc).toHaveBeenCalledWith("create_db_connector_pair_code", { p_tenant_id: "t1", p_code_hash: sha256Hex(out.code) });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(out.code);
    expect(out.command).toContain(`ZAVI_PAIR=${out.code}`);
    expect(out.command).toContain("-p 127.0.0.1:7801:7801");
    expect(out.command).toContain("ghcr.io/rravi149/zavi-connector:1.0.1");
  });
  it("throws with the RPC error code (403 mapping)", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501" } }));
    await expect(createPairCode(rpc, "t1")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("redeemPairCode", () => {
  const code = generatePairCode();
  it("unknown code -> 401, the tenant RPC is never called", async () => {
    const { d, tenantRpc } = deps({ resolve: [] });
    expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "1.1.1.1" }, d)).toEqual({ ok: false, status: 401, reason: "invalid_code" });
    expect(tenantRpc).not.toHaveBeenCalled();
  });
  it("success passes only hashes, with the tenant the code resolved to", async () => {
    const { d, tenantRpc, preTenantRpc, log } = deps({ resolve: [{ tenant_id: "tenant-A", code_id: "code-1" }] });
    const out = await redeemPairCode({ code, machine: "mac", version: "1.0", ip: "1.1.1.1" }, d);
    expect(out).toEqual({ ok: true, token: TOKEN, tenant_id: "tenant-A", connector_id: "conn-1" });
    expect(preTenantRpc).toHaveBeenCalledWith("db_connector_resolve_pair_code", { p_code_hash: sha256Hex(code) });
    expect(tenantRpc).toHaveBeenCalledWith("tenant-A", "redeem_db_connector_pair_code", {
      p_code_id: "code-1",
      p_code_hash: sha256Hex(code),
      p_token_hash: sha256Hex(TOKEN),
      p_machine: "mac",
      p_version: "1.0",
    });
    const everything = JSON.stringify([tenantRpc.mock.calls, preTenantRpc.mock.calls, log.mock.calls]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(code);
  });
  it("a raced redemption (RPC returns null) -> 401", async () => {
    const { d } = deps({ resolve: [{ tenant_id: "t", code_id: "c" }], redeem: null });
    expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "1.1.1.1" }, d)).toMatchObject({ status: 401 });
  });
  it("11th failure from one IP -> 429 before any code lookup", async () => {
    const limits = limiter();
    const { d, preTenantRpc } = deps({ resolve: [], limits });
    for (let i = 0; i < 10; i++) expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "9.9.9.9" }, d)).toMatchObject({ status: 401 });
    preTenantRpc.mockClear();
    expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "9.9.9.9" }, d)).toMatchObject({ status: 429 });
    expect(preTenantRpc).not.toHaveBeenCalled();
    expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "8.8.8.8" }, d)).toMatchObject({ status: 401 });
  });
  it("1,000 failures from other IPs never block a valid redeem; the global rate only alerts", async () => {
    const limits = limiter();
    const bad = deps({ resolve: [], limits });
    for (let i = 0; i < 1000; i++) {
      await redeemPairCode({ code, machine: "m", version: "1", ip: `10.${Math.floor(i / 250)}.${Math.floor(i / 5) % 50}.${i % 5}` }, bad.d);
    }
    expect(bad.alert).toHaveBeenCalledWith(expect.objectContaining({ code: "pair_global_failure_rate" }));
    const good = deps({ resolve: [{ tenant_id: "t", code_id: "c" }], limits });
    expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "203.0.113.7" }, good.d)).toMatchObject({ ok: true });
  });
  it("a malformed code never touches the limiter or the database", async () => {
    const limits = limiter();
    const { d, preTenantRpc } = deps({ limits });
    for (let i = 0; i < 50; i++) expect(await redeemPairCode({ code: "zpair_junk", machine: "m", version: "1", ip: "1.1.1.1" }, d)).toMatchObject({ status: 401 });
    expect(limits.raw).not.toHaveBeenCalled();
    expect(preTenantRpc).not.toHaveBeenCalled();
  });
  it("a re-pair broadcasts a revoke so every instance drops the old token", async () => {
    const { d, revoke } = deps({ resolve: [{ tenant_id: "tenant-A", code_id: "c" }] });
    await redeemPairCode({ code, machine: "m", version: "1", ip: "1.1.1.1" }, d);
    expect(revoke).toHaveBeenCalledWith("tenant-A");
  });
  it("addresses spread over one /24 hit the subnet limit (30) even though each IP stays under 10", async () => {
    const limits = limiter();
    const { d } = deps({ resolve: [], limits });
    for (let i = 0; i < 30; i++) expect(await redeemPairCode({ code, machine: "m", version: "1", ip: `198.51.100.${i}` }, d)).toMatchObject({ status: 401 });
    expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "198.51.100.200" }, d)).toMatchObject({ status: 429 });
    expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "198.51.101.1" }, d)).toMatchObject({ status: 401 });
  });
  it("successes do not count against the limit", async () => {
    const limits = limiter();
    const { d } = deps({ resolve: [{ tenant_id: "t", code_id: "c" }], limits });
    for (let i = 0; i < 25; i++) expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "5.5.5.5" }, d)).toMatchObject({ ok: true });
  });
  it("limiter unreachable -> logged error, the redemption still needs a valid code", async () => {
    const bad = deps({ resolve: [], limits: limiter({ fail: true }) });
    expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "1.1.1.1" }, bad.d)).toMatchObject({ status: 401 });
    expect(bad.log).toHaveBeenCalledWith(expect.objectContaining({ code: "pair_limiter_unavailable", level: "error" }));
    const good = deps({ resolve: [{ tenant_id: "t", code_id: "c" }], limits: limiter({ fail: true }) });
    expect(await redeemPairCode({ code, machine: "m", version: "1", ip: "1.1.1.1" }, good.d)).toMatchObject({ ok: true });
  });
  it("missing secret -> the limiter is unavailable and never called", async () => {
    const rpc = vi.fn();
    expect(await reservePairAttempt("1.1.1.1", { rpc: rpc as never, env: {} as NodeJS.ProcessEnv })).toEqual({ kind: "unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
