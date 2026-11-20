import { describe, it, expect, vi } from "vitest";
import {
  resolveResources,
  RESOURCE_DEPENDENCIES,
  type ResolveResourcesDeps,
} from "@/services/provisioning/resolve-resources";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import type { Provisioner, ProvisionResult, ResourceKind } from "@/services/provisioning/types";

const ALL: ResourceKind[] = ["ads", "stripe", "domain", "email", "hosting", "db", "repo"];

type Gate<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function gate<T>(): Gate<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const REFS: Record<ResourceKind, Record<string, unknown>> = {
  repo: { github_full_name: "praxis-built/acme-t1", repo_url: "https://github.com/praxis-built/acme-t1" },
  db: { neon_project_id: "np_1" },
  hosting: { render_service_id: "srv_1", url: "https://acme.onrender.com" },
  email: { from_address: "acme@zaviagent.com" },
  domain: { hostname: "acme.zavi.site" },
  stripe: { stripe_account_id: "acct_1" },
  ads: { meta_ad_account_id: "act_1" },
};

function harness(over: Partial<ResolveResourcesDeps> = {}) {
  const events: string[] = [];
  const gates = new Map<ResourceKind, Gate<ProvisionResult>>();
  const seenContext = new Map<ResourceKind, Record<string, unknown>>();
  for (const k of ALL) gates.set(k, gate<ProvisionResult>());
  const provisioners = new Map<ResourceKind, Provisioner>();
  for (const k of ALL) {
    provisioners.set(k, {
      kind: k,
      provider: `${k}-prov`,
      teardown: vi.fn(),
      ensure: async (input) => {
        events.push(`start:${k}`);
        seenContext.set(k, { ...(input.context ?? {}) });
        try {
          return await gates.get(k)!.promise;
        } finally {
          events.push(`finish:${k}`);
        }
      },
    });
  }
  const setTenantResource = vi.fn().mockResolvedValue(undefined);
  const deps: ResolveResourcesDeps = {
    loadMode: vi.fn().mockResolvedValue(null),
    loadVaultKey: vi.fn().mockResolvedValue(null),
    loadExternalRef: vi.fn().mockResolvedValue(null),
    getProvisioner: (k) => provisioners.get(k) ?? null,
    setTenantResource,
    ...over,
  };
  const ok = (k: ResourceKind) => gates.get(k)!.resolve({ external_ref: REFS[k], vault_keys: {} });
  const fail = (k: ResourceKind, e: unknown) => gates.get(k)!.reject(e);
  const started = () => events.filter((e) => e.startsWith("start:")).map((e) => e.slice(6));
  return { events, gates, seenContext, deps, setTenantResource, ok, fail, started };
}

describe("resolveResources dependency-graph concurrency", () => {
  it("declares hosting after repo+db and domain after hosting; every other kind is independent", () => {
    expect(RESOURCE_DEPENDENCIES).toEqual({
      repo: [],
      db: [],
      hosting: ["repo", "db"],
      email: [],
      domain: ["hosting"],
      stripe: [],
      ads: [],
    });
  });

  it("settles repo and its hook first, then starts independent kinds together, holds dependents until every dependency finishes, and keeps canonical order", async () => {
    const h = harness();
    const hookGate = gate<void>();
    const hookCalls: Array<{ kind: ResourceKind; ctx: Record<string, unknown> }> = [];
    const done = resolveResources("t1", "Acme", ALL, h.deps, {
      afterProvision: async (kind, ctx) => {
        h.events.push(`hook:${kind}`);
        hookCalls.push({ kind, ctx: { ...ctx } });
        if (kind === "repo") await hookGate.promise;
      },
    });

    await flush();
    expect(h.started()).toEqual(["repo"]);

    h.ok("repo");
    await flush();
    expect(h.events).toContain("hook:repo");
    expect(h.started()).toEqual(["repo"]);

    hookGate.resolve();
    await flush();
    expect(h.started().sort()).toEqual(["ads", "db", "email", "repo", "stripe"]);

    h.ok("ads");
    h.ok("stripe");
    h.ok("email");
    await flush();
    expect(h.started()).not.toContain("hosting");

    h.ok("db");
    await flush();
    expect(h.started()).toContain("hosting");
    expect(h.started()).not.toContain("domain");
    expect(h.seenContext.get("hosting")).toMatchObject({ repo_url: REFS.repo.repo_url, neon_project_id: "np_1" });

    h.ok("hosting");
    await flush();
    expect(h.started()).toContain("domain");
    expect(h.seenContext.get("domain")).toMatchObject({ render_service_id: "srv_1", url: REFS.hosting.url });

    h.ok("domain");
    const r = await done;

    const idx = (e: string) => h.events.indexOf(e);
    expect(idx("start:db")).toBeGreaterThan(idx("hook:repo"));
    expect(idx("start:db")).toBeLessThan(idx("finish:email"));
    expect(idx("start:hosting")).toBeGreaterThan(idx("finish:repo"));
    expect(idx("start:hosting")).toBeGreaterThan(idx("finish:db"));
    expect(idx("start:domain")).toBeGreaterThan(idx("finish:hosting"));
    expect(hookCalls.find((c) => c.kind === "repo")?.ctx.github_full_name).toBe("praxis-built/acme-t1");

    expect(r.provisioned).toEqual(["repo", "db", "hosting", "email", "domain", "stripe", "ads"]);
    expect(r.failed).toEqual([]);
    expect(r.pending_creds).toEqual([]);
    expect(r.context).toEqual(Object.assign({}, ...Object.values(REFS)));
    expect(h.setTenantResource).toHaveBeenCalledTimes(7);
  });

  it("a failed dependency still lets its dependent run afterwards, and failures/pending keep canonical order and row writes", async () => {
    const h = harness({
      loadExternalRef: vi.fn(async (_t: string, k: ResourceKind) =>
        k === "db" ? { neon_project_id: "np_prior" } : null,
      ),
      loadVaultKey: vi.fn(async (_t: string, k: ResourceKind) => (k === "db" ? "vk_db" : null)),
    });
    const done = resolveResources("t1", "Acme", ALL, h.deps);
    await flush();
    h.ok("repo");
    await flush();

    h.fail("ads", new Error("meta 500"));
    h.fail("stripe", new CredentialNotConfigured("STRIPE_PROVISIONING_ENABLED"));
    h.ok("email");
    await flush();
    expect(h.started()).not.toContain("hosting");

    h.fail("db", new Error("neon down"));
    await flush();
    expect(h.started()).toContain("hosting");
    expect(h.seenContext.get("hosting")?.neon_project_id).toBeUndefined();

    h.fail("hosting", new Error("render requires db"));
    await flush();
    expect(h.started()).toContain("domain");
    h.fail("domain", new Error("domain requires hosting"));
    const r = await done;

    expect(r.provisioned).toEqual(["repo", "email"]);
    expect(r.pending_creds).toEqual([{ kind: "stripe", missing_key: "STRIPE_PROVISIONING_ENABLED" }]);
    expect(r.failed).toEqual([
      { kind: "db", error: "neon down" },
      { kind: "hosting", error: "render requires db" },
      { kind: "domain", error: "domain requires hosting" },
      { kind: "ads", error: "meta 500" },
    ]);

    const rows = Object.fromEntries(
      h.setTenantResource.mock.calls.map((c) => [c[1], c.slice(2)]),
    );
    expect(h.setTenantResource).toHaveBeenCalledTimes(7);
    expect(rows.db).toEqual(["provisioned", "failed", "db-prov", { neon_project_id: "np_prior", error: "neon down" }, "vk_db"]);
    expect(rows.stripe).toEqual(["provisioned", "pending", "stripe-prov", {}, null]);
    expect(rows.ads).toEqual(["provisioned", "failed", "ads-prov", { error: "meta 500" }, null]);
    expect(rows.repo).toEqual(["provisioned", "ready", "repo-prov", REFS.repo, null]);
  });

  it("a thrown row write rejects the build and never starts kinds ordered after it", async () => {
    const h = harness();
    h.setTenantResource.mockImplementation(async (_t: string, k: ResourceKind, _m: string, status: string) => {
      if (k === "db" && status === "failed") throw new Error("set_tenant_resource failed (db)");
    });
    const done = resolveResources("t1", "Acme", ALL, h.deps);
    const settled = done.then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await flush();
    h.ok("repo");
    await flush();
    h.fail("db", new Error("neon down"));
    await flush();
    h.ok("email");
    h.ok("stripe");
    h.ok("ads");
    await flush();

    expect(await settled).toBe("set_tenant_resource failed (db)");
    expect(h.started()).not.toContain("hosting");
    expect(h.started()).not.toContain("domain");
    expect(h.setTenantResource.mock.calls.map((c) => c[1]).sort()).toEqual(["ads", "db", "email", "repo", "stripe"]);
  });

  it("the earliest fatal kind in canonical order wins when several throw", async () => {
    const h = harness({
      loadMode: vi.fn(async (_t: string, k: ResourceKind) => {
        if (k === "ads") throw new Error("mode read ads");
        if (k === "db") throw new Error("mode read db");
        return null;
      }),
    });
    const settled = resolveResources("t1", "Acme", ALL, h.deps).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await flush();
    h.ok("repo");
    h.ok("email");
    h.ok("stripe");
    expect(await settled).toBe("mode read db");
    expect(h.started()).not.toContain("ads");
    expect(h.started()).not.toContain("hosting");
  });

  it("a repo whose row write throws after a slow ensure rejects the build with zero side effects on any other kind", async () => {
    const repoWrite = gate<void>();
    const h = harness();
    h.setTenantResource.mockImplementation(async (_t: string, k: ResourceKind) => {
      if (k === "repo") {
        await repoWrite.promise;
        throw new Error("set_tenant_resource failed (repo)");
      }
    });
    const afterProvision = vi.fn(async () => {});
    const settled = resolveResources("t1", "Acme", ALL, h.deps, { afterProvision }).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await flush();
    h.ok("repo");
    for (let i = 0; i < 5; i++) await flush();
    for (const k of ALL) if (k !== "repo") h.ok(k);
    expect(h.started()).toEqual(["repo"]);
    repoWrite.resolve();

    expect(await settled).toBe("set_tenant_resource failed (repo)");
    for (let i = 0; i < 5; i++) await flush();
    expect(h.started()).toEqual(["repo"]);
    expect(h.setTenantResource.mock.calls.length).toBeGreaterThan(0);
    expect(h.setTenantResource.mock.calls.every((c) => c[1] === "repo")).toBe(true);
    expect(afterProvision).not.toHaveBeenCalled();
  });

  it("a repo whose mode read throws rejects the build before any provisioner or row write runs", async () => {
    const h = harness({
      loadMode: vi.fn(async (_t: string, k: ResourceKind) => {
        if (k === "repo") throw new Error("mode read repo");
        return null;
      }),
    });
    const settled = resolveResources("t1", "Acme", ALL, h.deps).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    for (let i = 0; i < 5; i++) await flush();
    expect(await settled).toBe("mode read repo");
    expect(h.started()).toEqual([]);
    expect(h.setTenantResource).not.toHaveBeenCalled();
  });

  it("a kind still reading its binding when an earlier kind goes fatal never calls its provisioner or writes its row", async () => {
    const emailRef = gate<Record<string, unknown> | null>();
    const h = harness({
      loadExternalRef: vi.fn(async (_t: string, k: ResourceKind) => (k === "email" ? emailRef.promise : null)),
    });
    h.setTenantResource.mockImplementation(async (_t: string, k: ResourceKind) => {
      if (k === "db") throw new Error("set_tenant_resource failed (db)");
    });
    const settled = resolveResources("t1", "Acme", ALL, h.deps).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await flush();
    h.ok("repo");
    await flush();
    expect(h.started()).not.toContain("email");
    h.ok("db");
    await flush();
    emailRef.resolve(null);
    h.ok("email");
    h.ok("stripe");
    h.ok("ads");

    expect(await settled).toBe("set_tenant_resource failed (db)");
    expect(h.started()).not.toContain("email");
    expect(h.setTenantResource.mock.calls.map((c) => c[1])).not.toContain("email");
    expect(h.started()).not.toContain("hosting");
  });
});
