import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/agents/conductor-driver", () => ({ tenantHasDatabase: vi.fn() }));
vi.mock("@/services/hosting/static-publish", () => ({
  e2bSandboxExec: vi.fn(),
  ensureStaticRouting: vi.fn(),
  isStaticEligible: vi.fn(),
  publishStatic: vi.fn(),
  readStaticState: vi.fn(),
  restoreRenderRouting: vi.fn(),
  restoreStaticKv: vi.fn(),
  rollbackStaticHosting: vi.fn(),
  STATIC_SUPERSEDED: "superseded",
  staticRoutingActive: (s: { status?: string; hostname?: string; routing_previous?: unknown } | null, h?: string) =>
    !!s && s.status !== "rolled_back" && !!s.hostname && !!s.routing_previous && (h === undefined || s.hostname === h),
  verifyStaticHost: vi.fn(),
  writeStaticState: vi.fn(),
}));

import {
  handleBuildStaticPublish,
  requestBuildStaticPublish,
  requestTenantStaticPublish,
  buildStaticPublishFn,
  BUILD_STATIC_PUBLISH_REQUESTED,
  type BuildStaticPublishDeps,
} from "../build-static-publish";
import type { SandboxExec, StaticRoutingPrevious, StaticState } from "@/services/hosting/static-publish";

const RUN = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";
const TENANT = "a7ec7367-acc8-4abc-995b-7da60a572de3";
const SHA = "c".repeat(40);
const NOW = new Date("2026-09-29T10:00:00.000Z");
const sandbox = { run: vi.fn(), readFile: vi.fn() } as unknown as SandboxExec;
const PREV: StaticRoutingPrevious = {
  dns: [{ id: "dnsR", type: "CNAME", content: "acme.onrender.com", proxied: false, ttl: 300 }],
  created_dns_id: null,
  route: null,
  created_route_id: "route-new",
};
const OLDER_PREV: StaticRoutingPrevious = { ...PREV, created_route_id: "route-first" };
const KV_PREV = JSON.stringify({ deploy_id: "dep-1", sha: "e".repeat(40) });
const HOST = "acme.zaviagent.com";

function harness(over: Partial<BuildStaticPublishDeps> = {}) {
  const log: string[] = [];
  const states: Array<Record<string, unknown>> = [];
  const deps: BuildStaticPublishDeps = {
    runTenant: vi.fn(async () => TENANT),
    resolveTarget: vi.fn(async () => ({ hostname: "acme.zaviagent.com", repo_full_name: "Praxis-build/acme", sandbox })),
    checkEligible: vi.fn(async () => ({ eligible: true })),
    publishStatic: vi.fn(async () => {
      log.push("publish");
      return { ok: true as const, deploy_id: "dep-9", file_count: 12, ms: 4000, kv_previous: KV_PREV };
    }),
    verifyStaticHost: vi.fn(async () => {
      log.push("verify");
      return { ok: true as const };
    }),
    restoreStaticKv: vi.fn(async () => {
      log.push("kv-restore");
      return { ok: true as const };
    }),
    ensureStaticRouting: vi.fn(async () => {
      log.push("routing");
      return { ok: true as const, previous: PREV, changed: true };
    }),
    restoreRenderRouting: vi.fn(async () => {
      log.push("render-restore");
      return { ok: true as const };
    }),
    readStaticState: vi.fn(async (): Promise<StaticState | null> => null),
    writeStaticState: vi.fn(async (_t: string, s: Record<string, unknown>) => {
      log.push(`state:${String(s.status)}`);
      states.push(s);
    }) as unknown as BuildStaticPublishDeps["writeStaticState"],
    rollback: vi.fn(async () => {
      log.push("rollback");
      return { ok: true as const };
    }),
    kick: vi.fn(async () => {
      log.push("kick");
    }),
    now: () => NOW,
    ...over,
  };
  return { deps, log, states };
}

const event = { tenant_id: TENANT, conductor_run_id: RUN, sha: SHA, hostname: HOST };
const liveEditEvent = { tenant_id: TENANT, sha: SHA, hostname: HOST, reason: "live_edit_publish" };
const routedLive = (routing_previous: StaticRoutingPrevious = OLDER_PREV): StaticState => ({
  status: "live",
  sha: "e".repeat(40),
  deploy_id: "dep-1",
  at: "t",
  hostname: HOST,
  routing_previous,
});

describe("build-static-publish worker", () => {
  it("happy path: publish without verify while Render serves, then switch routing, then verify through the host, then live", async () => {
    const h = harness();
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ published: true, deploy_id: "dep-9" });
    expect(h.log).toEqual(["state:publishing", "publish", "routing", "state:publishing", "verify", "state:live", "kick"]);
    expect(h.deps.publishStatic).toHaveBeenCalledWith({
      tenant_id: TENANT,
      hostname: HOST,
      repo_full_name: "Praxis-build/acme",
      sha: SHA,
      sandbox,
      verify: false,
      beforeFlip: expect.any(Function),
    });
    const at = NOW.toISOString();
    expect(h.states).toEqual([
      { status: "publishing", deploy_id: null, hostname: HOST, sha: SHA, at },
      { status: "publishing", deploy_id: "dep-9", hostname: HOST, routing_previous: PREV, sha: SHA, at },
      { status: "live", deploy_id: "dep-9", hostname: HOST, routing_previous: PREV, sha: SHA, at },
    ]);
    expect(h.deps.verifyStaticHost).toHaveBeenCalledWith(HOST, "dep-9");
    expect(h.deps.restoreRenderRouting).not.toHaveBeenCalled();
    expect(h.deps.restoreStaticKv).not.toHaveBeenCalled();
    expect(h.deps.kick).toHaveBeenCalledWith(RUN);
  });

  it("build failure never touches routing or KV, writes failed", async () => {
    const h = harness({
      publishStatic: vi.fn(async () => ({ ok: false as const, stage: "build" as const, error: "next build exited 1" })),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ failed: true, error: "build: next build exited 1" });
    expect(h.log).toEqual(["state:publishing", "state:failed", "kick"]);
    expect(h.deps.ensureStaticRouting).not.toHaveBeenCalled();
    expect(h.deps.verifyStaticHost).not.toHaveBeenCalled();
    expect(h.deps.restoreRenderRouting).not.toHaveBeenCalled();
    expect(h.deps.restoreStaticKv).not.toHaveBeenCalled();
  });

  it("a throwing publish writes failed without touching routing", async () => {
    const h = harness({
      publishStatic: vi.fn(async () => {
        throw new Error("sandbox gone");
      }),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ failed: true, error: "publish: sandbox gone" });
    expect(h.deps.ensureStaticRouting).not.toHaveBeenCalled();
    expect(h.deps.kick).toHaveBeenCalledTimes(1);
  });

  it("routing failure after the KV flip restores KV to the previous value and never verifies", async () => {
    const h = harness({ ensureStaticRouting: vi.fn(async () => ({ ok: false as const, error: "cf 403" })) });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ failed: true, error: "routing: cf 403" });
    expect(h.deps.restoreStaticKv).toHaveBeenCalledWith(HOST, KV_PREV);
    expect(h.deps.verifyStaticHost).not.toHaveBeenCalled();
    expect(h.deps.restoreRenderRouting).not.toHaveBeenCalled();
    expect(h.states.map((s) => s.status)).toEqual(["publishing", "failed"]);
  });

  it("first publish with no previous KV: routing failure deletes the key (restore with null)", async () => {
    const h = harness({
      publishStatic: vi.fn(async () => ({ ok: true as const, deploy_id: "dep-9", file_count: 1, ms: 1, kv_previous: null })),
      ensureStaticRouting: vi.fn(async () => ({ ok: false as const, error: "cf 403" })),
    });
    await handleBuildStaticPublish(event, h.deps);
    expect(h.deps.restoreStaticKv).toHaveBeenCalledWith(HOST, null);
  });

  it("verify failure on a first switch restores Render routing and KV, writes failed", async () => {
    const h = harness({ verifyStaticHost: vi.fn(async () => ({ ok: false as const, error: "GET / 404" })) });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ failed: true, error: "verify: GET / 404" });
    expect(h.deps.restoreRenderRouting).toHaveBeenCalledWith(HOST, PREV);
    expect(h.deps.restoreStaticKv).toHaveBeenCalledWith(HOST, KV_PREV);
    expect(h.states.at(-1)).toMatchObject({ status: "rolled_back", error: "verify: GET / 404", routing_previous: PREV });
    expect(h.deps.rollback).not.toHaveBeenCalled();
  });

  it("verify failure with a failed Render restore keeps routing_previous and retries through rollback", async () => {
    const h = harness({
      verifyStaticHost: vi.fn(async () => ({ ok: false as const, error: "GET / 404" })),
      restoreRenderRouting: vi.fn(async () => ({ ok: false as const, error: "cf 500" })),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({
      failed: true,
      error: "verify: GET / 404; restore: cf 500",
      rolled_back: true,
    });
    expect(h.states.at(-1)).toMatchObject({ status: "failed", hostname: HOST, routing_previous: PREV });
    expect(h.deps.rollback).toHaveBeenCalledWith(TENANT);
  });

  it("re-publish (routing already on the worker): keeps the original routing_previous and, on verify failure, rolls the host back to Render instead of leaving the old export", async () => {
    const h = harness({
      readStaticState: vi.fn(async () => ({
        status: "live" as const,
        sha: "e".repeat(40),
        deploy_id: "dep-1",
        at: "t",
        hostname: HOST,
        routing_previous: OLDER_PREV,
      })),
      ensureStaticRouting: vi.fn(async () => ({
        ok: true as const,
        previous: { dns: [], created_dns_id: null, route: null, created_route_id: null },
        changed: false,
      })),
      verifyStaticHost: vi.fn(async () => ({ ok: false as const, error: "GET / 500" })),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({
      failed: true,
      error: "verify: GET / 500",
      rolled_back: true,
    });
    expect(h.deps.restoreStaticKv).toHaveBeenCalledWith(HOST, KV_PREV);
    expect(h.deps.restoreRenderRouting).not.toHaveBeenCalled();
    expect(h.deps.rollback).toHaveBeenCalledWith(TENANT);
    expect(h.log.slice(-3)).toEqual(["state:failed", "rollback", "kick"]);
    expect(h.states.every((s) => s.routing_previous === OLDER_PREV)).toBe(true);
  });

  it("after a rollback, a new publish records the fresh routing_previous", async () => {
    const h = harness({
      readStaticState: vi.fn(async () => ({
        status: "rolled_back" as const,
        sha: "e".repeat(40),
        deploy_id: "dep-1",
        at: "t",
        hostname: HOST,
        routing_previous: OLDER_PREV,
      })),
    });
    await handleBuildStaticPublish(event, h.deps);
    expect(h.states.at(-1)).toMatchObject({ status: "live", routing_previous: PREV });
  });

  it("repo turns out ineligible in the sandbox → failed without routing or building", async () => {
    const h = harness({ checkEligible: vi.fn(async () => ({ eligible: false, reason: "server_actions" })) });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({
      failed: true,
      error: "ineligible: server_actions",
    });
    expect(h.deps.publishStatic).not.toHaveBeenCalled();
    expect(h.deps.ensureStaticRouting).not.toHaveBeenCalled();
    expect(h.states.map((s) => s.status)).toEqual(["failed"]);
    expect(h.deps.checkEligible).toHaveBeenCalledWith(TENANT, sandbox);
  });

  it("a tenant_id that does not own the run is refused before any side effect", async () => {
    const h = harness({ runTenant: vi.fn(async () => "someone-else") });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ skipped: true, reason: "run_not_found" });
    expect(h.deps.resolveTarget).not.toHaveBeenCalled();
    expect(h.deps.writeStaticState).not.toHaveBeenCalled();
    expect(h.deps.kick).not.toHaveBeenCalled();
  });

  it("bad payloads are refused", async () => {
    const h = harness();
    const noHost = { tenant_id: TENANT, conductor_run_id: RUN, sha: SHA };
    const noRunNoReason = { tenant_id: TENANT, sha: SHA, hostname: HOST };
    const badReason = { ...liveEditEvent, reason: "whatever" };
    for (const bad of [null, { ...event, sha: "not-a-sha" }, { ...event, conductor_run_id: "x" }, { ...event, tenant_id: 5 }, noHost, noRunNoReason, badReason]) {
      await expect(handleBuildStaticPublish(bad, h.deps)).resolves.toEqual({ skipped: true, reason: "bad_request" });
    }
    expect(h.deps.runTenant).not.toHaveBeenCalled();
  });

  it("no sandbox / hostname → skipped with no state written, so the gate stays on Render", async () => {
    const h = harness({ resolveTarget: vi.fn(async () => ({ skip: "no_sandbox" })) });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ skipped: true, reason: "no_sandbox" });
    expect(h.deps.writeStaticState).not.toHaveBeenCalled();
    expect(h.deps.publishStatic).not.toHaveBeenCalled();
  });

  it("a failing kick never fails the function", async () => {
    const h = harness({
      kick: vi.fn(async () => {
        throw new Error("inngest down");
      }),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ published: true, deploy_id: "dep-9" });
  });

  it("is registered on the static-publish event, one publish at a time per hostname", () => {
    expect(BUILD_STATIC_PUBLISH_REQUESTED).toBe("build/static-publish.requested");
    const o = (buildStaticPublishFn as unknown as { opts: { concurrency: unknown } }).opts;
    expect(o.concurrency).toEqual([{ limit: 1, key: "event.data.hostname" }, { limit: 3 }]);
  });

  it("ineligible re-check on a host live on static keeps hostname + routing_previous and rolls the host back", async () => {
    const h = harness({
      readStaticState: vi.fn(async () => routedLive()),
      checkEligible: vi.fn(async () => ({ eligible: false, reason: "api_routes" })),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({
      failed: true,
      error: "ineligible: api_routes",
      rolled_back: true,
    });
    expect(h.states).toEqual([
      { status: "failed", deploy_id: null, error: "ineligible: api_routes", hostname: HOST, routing_previous: OLDER_PREV, sha: SHA, at: NOW.toISOString() },
    ]);
    expect(h.log).toEqual(["state:failed", "rollback", "kick"]);
    expect(h.deps.publishStatic).not.toHaveBeenCalled();
  });

  it("a build failure on a host live on static rolls back to Render rather than serving the old export", async () => {
    const h = harness({
      readStaticState: vi.fn(async () => routedLive()),
      publishStatic: vi.fn(async () => ({ ok: false as const, stage: "build" as const, error: "next build exited 1" })),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({
      failed: true,
      error: "build: next build exited 1",
      rolled_back: true,
    });
    expect(h.states.map((x) => [x.status, x.routing_previous])).toEqual([
      ["publishing", OLDER_PREV],
      ["failed", OLDER_PREV],
    ]);
  });

  it("a failed rollback is reported in the error", async () => {
    const h = harness({
      readStaticState: vi.fn(async () => routedLive()),
      checkEligible: vi.fn(async () => ({ eligible: false, reason: "has_database" })),
      rollback: vi.fn(async () => ({ ok: false as const, error: "cf 500" })),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({
      failed: true,
      error: "ineligible: has_database; rollback: cf 500",
    });
  });

  it("no sandbox while the host is live on static → rollback, nothing published", async () => {
    const h = harness({
      readStaticState: vi.fn(async () => routedLive()),
      resolveTarget: vi.fn(async () => ({ skip: "no_sandbox" })),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({
      skipped: true,
      reason: "no_sandbox",
      rolled_back: true,
    });
    expect(h.deps.publishStatic).not.toHaveBeenCalled();
  });

  it("a throwing target lookup while live on static → rollback, never a throw", async () => {
    const h = harness({
      readStaticState: vi.fn(async () => routedLive()),
      resolveTarget: vi.fn(async () => {
        throw new Error("sandbox resume failed");
      }),
    });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toMatchObject({ skipped: true, rolled_back: true });
    expect(h.deps.rollback).toHaveBeenCalledWith(TENANT);
  });

  it("an event for a hostname that is no longer the tenant's is skipped", async () => {
    const h = harness({ resolveTarget: vi.fn(async () => ({ hostname: "other.zaviagent.com", repo_full_name: "Praxis-build/acme", sandbox })) });
    await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ skipped: true, reason: "hostname_mismatch" });
    expect(h.deps.publishStatic).not.toHaveBeenCalled();
  });

  it("live edit publish (no run): publishes on a routed host, no run lookup, no conductor kick", async () => {
    const h = harness({ readStaticState: vi.fn(async () => routedLive()) });
    await expect(handleBuildStaticPublish(liveEditEvent, h.deps)).resolves.toEqual({ published: true, deploy_id: "dep-9" });
    expect(h.deps.runTenant).not.toHaveBeenCalled();
    expect(h.deps.kick).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toMatchObject({ status: "live", sha: SHA, routing_previous: OLDER_PREV });
  });

  it("live edit publish on a tenant not routed to static is refused before any side effect", async () => {
    for (const prior of [null, { ...routedLive(), status: "rolled_back" as const }, { ...routedLive(), hostname: "other.zaviagent.com" }]) {
      const h = harness({ readStaticState: vi.fn(async () => prior) });
      await expect(handleBuildStaticPublish(liveEditEvent, h.deps)).resolves.toEqual({ skipped: true, reason: "not_static" });
      expect(h.deps.resolveTarget).not.toHaveBeenCalled();
      expect(h.deps.writeStaticState).not.toHaveBeenCalled();
    }
  });
});

describe("static publish requests", () => {
  it("conductor request carries the tenant's hostname for the concurrency key", async () => {
    const send = vi.fn(async () => undefined);
    await expect(
      requestBuildStaticPublish({ tenant_id: TENANT, conductor_run_id: RUN, sha: SHA }, { hostname: async () => HOST, send }),
    ).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith({
      id: `static-publish:${RUN}:${SHA}`,
      name: BUILD_STATIC_PUBLISH_REQUESTED,
      data: { tenant_id: TENANT, conductor_run_id: RUN, sha: SHA, hostname: HOST },
    });
  });

  it("conductor request with no hostname sends nothing", async () => {
    const send = vi.fn(async () => undefined);
    await expect(
      requestBuildStaticPublish({ tenant_id: TENANT, conductor_run_id: RUN, sha: SHA }, { hostname: async () => null, send }),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("tenant request sends only when routed, with the routed hostname", async () => {
    const send = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    await expect(
      requestTenantStaticPublish(
        { tenant_id: TENANT, sha: SHA, reason: "live_edit_publish" },
        { readStaticState: async () => routedLive(), send, rollback },
      ),
    ).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith({
      id: `static-publish:live_edit_publish:${TENANT}:${SHA}`,
      name: BUILD_STATIC_PUBLISH_REQUESTED,
      data: { tenant_id: TENANT, sha: SHA, hostname: HOST, reason: "live_edit_publish" },
    });
    send.mockClear();
    await expect(
      requestTenantStaticPublish({ tenant_id: TENANT, sha: SHA, reason: "revert" }, { readStaticState: async () => null, send, rollback }),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("tenant request that cannot be sent rolls the routed host back to Render", async () => {
    const send = vi.fn(async () => {
      throw new Error("inngest down");
    });
    const rollback = vi.fn(async () => undefined);
    await expect(
      requestTenantStaticPublish(
        { tenant_id: TENANT, sha: SHA, reason: "live_edit_publish" },
        { readStaticState: async () => routedLive(), send, rollback },
      ),
    ).rejects.toThrow("inngest down");
    expect(rollback).toHaveBeenCalledWith(TENANT);
  });

  it("tenant request whose routing state cannot be read attempts a Render rollback", async () => {
    const rollback = vi.fn(async () => undefined);
    await expect(
      requestTenantStaticPublish(
        { tenant_id: TENANT, sha: SHA, reason: "live_edit_publish" },
        {
          readStaticState: async () => { throw new Error("state read failed"); },
          send: vi.fn(async () => undefined),
          rollback,
        },
      ),
    ).rejects.toThrow("state read failed");
    expect(rollback).toHaveBeenCalledWith(TENANT);
  });

  describe("an out-of-order publish never rolls the site back to an older commit", () => {
    const NEWER = "d".repeat(40);
    const withHead = (head: string | null | (() => Promise<string | null>)) => ({
      resolveTarget: vi.fn(async () => ({
        hostname: HOST,
        repo_full_name: "Praxis-build/acme",
        sandbox,
        mainHead: typeof head === "function" ? head : async () => head,
      })),
    });

    it("skips before any write when main already moved past this commit", async () => {
      const h = harness({ ...withHead(NEWER), readStaticState: vi.fn(async () => routedLive()) });
      await expect(handleBuildStaticPublish(liveEditEvent, h.deps)).resolves.toEqual({ skipped: true, reason: "superseded" });
      expect(h.deps.publishStatic).not.toHaveBeenCalled();
      expect(h.deps.writeStaticState).not.toHaveBeenCalled();
      expect(h.deps.rollback).not.toHaveBeenCalled();
    });

    it("aborts right before the switch when main moves during the build, and restores the prior state", async () => {
      const heads = [SHA, NEWER];
      const prior = routedLive();
      const h = harness({
        ...withHead(async () => heads.shift() ?? NEWER),
        readStaticState: vi.fn(async () => prior),
        publishStatic: vi.fn(async (input: { beforeFlip?: () => Promise<boolean> }) => {
          const go = await input.beforeFlip!();
          return go
            ? { ok: true as const, deploy_id: "dep-9", file_count: 1, ms: 1, kv_previous: KV_PREV }
            : { ok: false as const, stage: "flip" as const, error: "superseded" };
        }) as unknown as BuildStaticPublishDeps["publishStatic"],
      });
      await expect(handleBuildStaticPublish(liveEditEvent, h.deps)).resolves.toEqual({ skipped: true, reason: "superseded" });
      expect(h.deps.ensureStaticRouting).not.toHaveBeenCalled();
      expect(h.deps.rollback).not.toHaveBeenCalled();
      expect(h.states.at(-1)).toEqual(prior);
    });

    it("publishes when main is still at this commit", async () => {
      const h = harness(withHead(SHA));
      await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ published: true, deploy_id: "dep-9" });
    });

    it("an unreadable head stops before any write (fails closed)", async () => {
      const h = harness({ ...withHead(null), readStaticState: vi.fn(async () => routedLive()) });
      await expect(handleBuildStaticPublish(liveEditEvent, h.deps)).resolves.toEqual({ skipped: true, reason: "superseded" });
      expect(h.deps.publishStatic).not.toHaveBeenCalled();
      expect(h.deps.writeStaticState).not.toHaveBeenCalled();
      expect(h.deps.rollback).not.toHaveBeenCalled();
    });

    it("a first publish superseded mid-build ends its publishing marker as failed, with no routing", async () => {
      const heads = [SHA, NEWER];
      const h = harness({
        ...withHead(async () => heads.shift() ?? NEWER),
        publishStatic: vi.fn(async (input: { beforeFlip?: () => Promise<boolean> }) =>
          (await input.beforeFlip!())
            ? { ok: true as const, deploy_id: "dep-9", file_count: 1, ms: 1, kv_previous: KV_PREV }
            : { ok: false as const, stage: "flip" as const, error: "superseded" },
        ) as unknown as BuildStaticPublishDeps["publishStatic"],
      });
      await expect(handleBuildStaticPublish(event, h.deps)).resolves.toEqual({ skipped: true, reason: "superseded" });
      expect(h.states.at(-1)).toMatchObject({ status: "failed", deploy_id: null, error: "superseded", sha: SHA });
      expect(h.states.at(-1)).not.toHaveProperty("routing_previous");
      expect(h.deps.rollback).not.toHaveBeenCalled();
    });
  });

  it("routing that failed and could not be undone keeps the KV pointer and records the snapshot, then rolls back", async () => {
    const h = harness({
      ensureStaticRouting: vi.fn(async () => ({ ok: false as const, error: "dns 500; restore: route 500", previous: PREV })),
    });
    const r = await handleBuildStaticPublish(event, h.deps);
    expect(r).toMatchObject({ failed: true, rolled_back: true });
    expect(h.deps.restoreStaticKv).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toMatchObject({ status: "failed", routing_previous: PREV });
    expect(h.deps.rollback).toHaveBeenCalledWith(TENANT);
  });

  it("afterPublish runs after publishStatic returns or throws (its cleanup would resume a paused box)", async () => {
    for (const outcome of ["ok", "throw"] as const) {
      const order: string[] = [];
      const h = harness({
        resolveTarget: vi.fn(async () => ({
          hostname: HOST,
          repo_full_name: "Praxis-build/acme",
          sandbox,
          afterPublish: async () => void order.push("after"),
        })),
        publishStatic: vi.fn(async () => {
          order.push("publish+cleanup");
          if (outcome === "throw") throw new Error("token scrub failed");
          return { ok: false as const, stage: "build" as const, error: "archive: token scrub failed" };
        }) as unknown as BuildStaticPublishDeps["publishStatic"],
      });
      await handleBuildStaticPublish(event, h.deps);
      expect(order).toEqual(["publish+cleanup", "after"]);
    }
  });
});
