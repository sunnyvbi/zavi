import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => { throw new Error("no db in this test"); } }));
vi.mock("@/services/agents/conductor-driver", () => ({ tenantHasDatabase: vi.fn() }));
vi.mock("@/services/sandbox/e2b-client", () => ({ resumeSandbox: vi.fn(), pauseSandbox: vi.fn() }));

import { handleBuildStaticPublish, type BuildStaticPublishDeps } from "../build-static-publish";
import {
  ensureStaticRouting,
  isStaticEligible,
  readStaticState,
  rollbackStaticHosting,
  writeStaticState,
  type SandboxExec,
  type StaticStateStore,
} from "@/services/hosting/static-publish";
import { FULL_ENV, FakeCloudflare } from "@/services/hosting/__tests__/static-fakes";

const TENANT = "a7ec7367-acc8-4abc-995b-7da60a572de3";
const RUN = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";
const HOST = "acme-1234abcd.zaviagent.com";
const OLD = "e".repeat(40);
const NEW = "f".repeat(40);
const sandbox = { run: vi.fn(), readFile: vi.fn() } as unknown as SandboxExec;
const original = { id: "dnsR", name: HOST, type: "CNAME", content: "acme.onrender.com", proxied: false, ttl: 300 };

function jsonStore(): StaticStateStore & { refs: Map<string, string> } {
  const refs = new Map<string, string>();
  return {
    refs,
    load: async (t) => (refs.has(t) ? (JSON.parse(refs.get(t)!) as Record<string, unknown>) : null),
    save: async (t, ref) => {
      refs.set(t, JSON.stringify(ref));
    },
  };
}

describe("static host goes back to Render when the app stops being static", () => {
  let cf: FakeCloudflare;
  let store: ReturnType<typeof jsonStore>;

  beforeEach(async () => {
    cf = new FakeCloudflare();
    cf.dns = [{ ...original }];
    store = jsonStore();
    store.refs.set(TENANT, JSON.stringify({ render_service_id: "srv-a", url: "https://a.onrender.com" }));
    const routed = await ensureStaticRouting(HOST, { env: FULL_ENV, fetchFn: cf.fetch });
    if (!routed.ok) throw new Error(routed.error);
    await writeStaticState(
      TENANT,
      { status: "live", sha: OLD, deploy_id: "d1", at: "t", hostname: HOST, routing_previous: routed.previous },
      store,
    );
    expect(cf.dns[0]).toMatchObject({ proxied: true });
    expect(cf.routes).toHaveLength(1);
  });

  function deps(eligible: { flag: boolean; hasDatabase: boolean }): BuildStaticPublishDeps {
    const never = vi.fn(async () => {
      throw new Error("must not run");
    });
    return {
      runTenant: vi.fn(async () => TENANT),
      resolveTarget: vi.fn(async () => ({ hostname: HOST, repo_full_name: "Praxis-build/acme", sandbox })),
      checkEligible: (tenant_id) =>
        isStaticEligible(
          { tenant_id, hasDatabase: eligible.hasDatabase, files: ["app/page.tsx"] },
          { env: FULL_ENV, flagEnabled: async () => eligible.flag },
        ),
      publishStatic: never as unknown as BuildStaticPublishDeps["publishStatic"],
      ensureStaticRouting: never as unknown as BuildStaticPublishDeps["ensureStaticRouting"],
      restoreRenderRouting: never as unknown as BuildStaticPublishDeps["restoreRenderRouting"],
      restoreStaticKv: never as unknown as BuildStaticPublishDeps["restoreStaticKv"],
      verifyStaticHost: never as unknown as BuildStaticPublishDeps["verifyStaticHost"],
      readStaticState: (t) => readStaticState(t, store),
      writeStaticState: (t, s) => writeStaticState(t, s, store),
      rollback: (t) => rollbackStaticHosting(t, { env: FULL_ENV, fetchFn: cf.fetch, store }),
      kick: vi.fn(async () => undefined),
      now: () => new Date("2026-09-29T12:00:00.000Z"),
    };
  }

  it.each([
    ["a database was added", { flag: true, hasDatabase: true }, "ineligible: has_database"],
    ["the flag was turned off", { flag: false, hasDatabase: false }, "ineligible: flag_off"],
  ])("%s: the next change rolls the host back to Render and keeps the rollback record", async (_label, eligible, error) => {
    const out = await handleBuildStaticPublish({ tenant_id: TENANT, conductor_run_id: RUN, sha: NEW, hostname: HOST }, deps(eligible));
    expect(out).toEqual({ failed: true, error, rolled_back: true });
    expect(cf.dns).toEqual([original]);
    expect(cf.routes).toEqual([]);
    const after = await readStaticState(TENANT, store);
    expect(after).toMatchObject({ status: "rolled_back", sha: NEW, hostname: HOST, error });
    expect(after?.routing_previous).toBeTruthy();
    expect(JSON.parse(store.refs.get(TENANT)!)).toMatchObject({ render_service_id: "srv-a" });
  });

  it("a live edit publish on the rolled back host is refused and Cloudflare is not touched again", async () => {
    await handleBuildStaticPublish(
      { tenant_id: TENANT, conductor_run_id: RUN, sha: NEW, hostname: HOST },
      deps({ flag: true, hasDatabase: true }),
    );
    const calls = cf.calls.length;
    const out = await handleBuildStaticPublish(
      { tenant_id: TENANT, sha: NEW, hostname: HOST, reason: "live_edit_publish" },
      deps({ flag: true, hasDatabase: false }),
    );
    expect(out).toEqual({ skipped: true, reason: "not_static" });
    expect(cf.calls.length).toBe(calls);
  });
});
