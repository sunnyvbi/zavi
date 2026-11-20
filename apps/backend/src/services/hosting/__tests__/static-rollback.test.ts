import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => { throw new Error("no db in this test"); } }));

import {
  ensureStaticRouting,
  readStaticState,
  rollbackStaticHosting,
  writeStaticState,
  type StaticStateStore,
} from "../static-publish";
import { FULL_ENV, FakeCloudflare } from "./static-fakes";

const HOST = "acme-1234abcd.zaviagent.com";
const NOW = Date.parse("2026-09-29T12:00:00.000Z");

function jsonStore(): StaticStateStore & { refs: Map<string, string>; saves: number } {
  const refs = new Map<string, string>();
  const store = {
    refs,
    saves: 0,
    load: async (t: string) => (refs.has(t) ? (JSON.parse(refs.get(t)!) as Record<string, unknown>) : null),
    save: async (t: string, ref: Record<string, unknown>) => {
      store.saves++;
      refs.set(t, JSON.stringify(ref));
    },
  };
  return store;
}

describe("rollbackStaticHosting", () => {
  let cf: FakeCloudflare;
  let store: ReturnType<typeof jsonStore>;
  const original = { id: "dnsR", name: HOST, type: "CNAME", content: "acme.onrender.com", proxied: false, ttl: 300 };

  beforeEach(() => {
    cf = new FakeCloudflare();
    cf.dns = [{ ...original }];
    store = jsonStore();
    store.refs.set("A", JSON.stringify({ render_service_id: "srv-a", url: "https://a.onrender.com" }));
  });

  it("under the zone wildcard (nothing per-site to restore) rollback also removes the host's KV pointer", async () => {
    cf.dns = [{ id: "w", name: "*.zaviagent.com", type: "A", content: "192.0.2.1", proxied: true, ttl: 1 }];
    cf.routes = [{ id: "wp", pattern: "*.zaviagent.com/*", script: "zavi-static-host" }];
    const routed = await ensureStaticRouting(HOST, { env: FULL_ENV, fetchFn: cf.fetch });
    expect(routed.ok && routed.changed).toBe(false);
    if (!routed.ok) return;
    cf.kv.set(`host:${HOST}`, "d1");
    await writeStaticState("A", { status: "live", sha: "abc1234", deploy_id: "d1", at: "t", hostname: HOST, routing_previous: routed.previous }, store);
    expect(await rollbackStaticHosting("A", { env: FULL_ENV, fetchFn: cf.fetch, store, now: () => NOW })).toEqual({ ok: true });
    expect(cf.kv.has(`host:${HOST}`)).toBe(false);
    expect((await readStaticState("A", store))?.status).toBe("rolled_back");
  });

  it("routing_previous survives the hosting row round trip and rollback restores Render DNS, then marks rolled_back", async () => {
    const routed = await ensureStaticRouting(HOST, { env: FULL_ENV, fetchFn: cf.fetch });
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(cf.dns[0]).toMatchObject({ proxied: true });
    await writeStaticState(
      "A",
      { status: "live", sha: "abc1234", deploy_id: "d1", at: "t", hostname: HOST, routing_previous: routed.previous },
      store,
    );
    expect((await readStaticState("A", store))?.routing_previous).toEqual(routed.previous);

    expect(await rollbackStaticHosting("A", { env: FULL_ENV, fetchFn: cf.fetch, store, now: () => NOW })).toEqual({ ok: true });
    expect(cf.dns).toEqual([original]);
    expect(cf.routes).toEqual([]);
    const after = await readStaticState("A", store);
    expect(after).toMatchObject({ status: "rolled_back", sha: "abc1234", hostname: HOST, at: new Date(NOW).toISOString() });
    expect(JSON.parse(store.refs.get("A")!)).toMatchObject({ render_service_id: "srv-a" });
  });

  it("nothing recorded → refuses without touching Cloudflare or the row", async () => {
    await writeStaticState("A", { status: "live", sha: "abc1234", deploy_id: "d1", at: "t" }, store);
    const saves = store.saves;
    expect(await rollbackStaticHosting("A", { env: FULL_ENV, fetchFn: cf.fetch, store })).toEqual({
      ok: false,
      error: "nothing_to_roll_back",
    });
    expect(cf.calls).toHaveLength(0);
    expect(store.saves).toBe(saves);
  });

  it("a failed restore leaves the state as it was so it can be retried", async () => {
    await writeStaticState(
      "A",
      {
        status: "live",
        sha: "abc1234",
        deploy_id: "d1",
        at: "t",
        hostname: HOST,
        routing_previous: { dns: [], created_dns_id: null, route: null, created_route_id: null },
      },
      store,
    );
    const r = await rollbackStaticHosting("A", { env: { ...FULL_ENV, CLOUDFLARE_ZONE_ID: "" }, fetchFn: cf.fetch, store });
    expect(r).toEqual({ ok: false, error: "not_configured" });
    expect((await readStaticState("A", store))?.status).toBe("live");
  });
});

describe("writeStaticState keeps the rollback record", () => {
  const PREV = { dns: [], created_dns_id: "dns-new", route: null, created_route_id: "route-new" };

  it("a write without hostname/routing_previous keeps the routed host's record, so rollback still works", async () => {
    const cf = new FakeCloudflare();
    cf.dns = [{ id: "dnsR", name: HOST, type: "CNAME", content: "acme.onrender.com", proxied: false, ttl: 300 }];
    const routed = await ensureStaticRouting(HOST, { env: FULL_ENV, fetchFn: cf.fetch });
    if (!routed.ok) throw new Error(routed.error);
    const store = jsonStore();
    store.refs.set("A", JSON.stringify({ render_service_id: "srv-a" }));
    await writeStaticState("A", { status: "live", sha: "abc1234", deploy_id: "d1", at: "t", hostname: HOST, routing_previous: routed.previous }, store);
    await writeStaticState("A", { status: "failed", sha: "def5678", deploy_id: null, error: "ineligible: api_routes", at: "t2" }, store);
    expect(await readStaticState("A", store)).toMatchObject({ status: "failed", hostname: HOST, routing_previous: routed.previous });
    expect(await rollbackStaticHosting("A", { env: FULL_ENV, fetchFn: cf.fetch, store })).toEqual({ ok: true });
    expect(cf.routes).toEqual([]);
  });

  it("a rolled back record is not carried into a new publish, and another hostname's record is not either", async () => {
    const store = jsonStore();
    store.refs.set("A", JSON.stringify({}));
    await writeStaticState("A", { status: "rolled_back", sha: "abc1234", deploy_id: "d1", at: "t", hostname: HOST, routing_previous: PREV }, store);
    await writeStaticState("A", { status: "publishing", sha: "def5678", deploy_id: null, at: "t2", hostname: HOST }, store);
    expect(await readStaticState("A", store)).not.toHaveProperty("routing_previous");
    await writeStaticState("A", { status: "live", sha: "abc1234", deploy_id: "d1", at: "t", hostname: HOST, routing_previous: PREV }, store);
    await writeStaticState("A", { status: "publishing", sha: "def5678", deploy_id: null, at: "t2", hostname: "other.zaviagent.com" }, store);
    expect(await readStaticState("A", store)).not.toHaveProperty("routing_previous");
  });
});
