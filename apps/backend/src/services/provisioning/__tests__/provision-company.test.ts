import { describe, it, expect, vi } from "vitest";
import { provisionCompany, ALL_RESOURCE_KINDS } from "@/services/provisioning/provision-company";
import type { ResolveSummary } from "@/services/provisioning/resolve-resources";

const emptySummary: ResolveSummary = {
  provisioned: [],
  connected: [],
  pending_creds: [],
  failed: [],
  context: {},
};

describe("provisionCompany", () => {
  it("registers builtins + runs resolveResources for the kinds, returns the summary", async () => {
    const register = vi.fn();
    const resolve = vi.fn().mockResolvedValue({
      ...emptySummary,
      provisioned: ["repo", "db"],
      pending_creds: [{ kind: "stripe", missing_key: "STRIPE_PROVISIONING_ENABLED" }],
    } satisfies ResolveSummary);
    const r = await provisionCompany("t1", "Acme", ["repo", "db", "stripe"], {
      register,
      resolve: resolve as never,
    });
    expect(register).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith("t1", "Acme", ["repo", "db", "stripe"], expect.any(Object));
    expect(r.provisioned).toEqual(["repo", "db"]);
    expect(r.pending_creds).toEqual([{ kind: "stripe", missing_key: "STRIPE_PROVISIONING_ENABLED" }]);
  });

  it("defaults to all 7 kinds when none passed", async () => {
    const resolve = vi.fn().mockResolvedValue(emptySummary);
    await provisionCompany("t1", "Acme", undefined, { register: vi.fn(), resolve: resolve as never });
    expect(resolve).toHaveBeenCalledWith("t1", "Acme", [...ALL_RESOURCE_KINDS], expect.any(Object));
  });

  describe("app database -> Operator DB hook", () => {
    const firing = (kinds: string[]) =>
      vi.fn(async (_t: string, _c: string, _k: unknown, hooks?: { afterProvision?: (k: never, ctx: never) => Promise<void> }) => {
        for (const k of kinds) await hooks?.afterProvision?.(k as never, {} as never);
        return emptySummary;
      });

    it("connects the database only after db provisions, for the server's tenant", async () => {
      const afterDb = vi.fn(async () => "connected");
      await provisionCompany("t1", "Acme", ["repo", "db"], { register: vi.fn(), resolve: firing(["repo", "db"]) as never, afterDbProvisioned: afterDb });
      expect(afterDb).toHaveBeenCalledTimes(1);
      expect(afterDb).toHaveBeenCalledWith("t1");
    });

    it("still runs the caller's own hook for every kind", async () => {
      const callerHook = vi.fn(async (_kind: string, _ctx: unknown) => undefined);
      await provisionCompany(
        "t1",
        "Acme",
        ["repo", "db"],
        { register: vi.fn(), resolve: firing(["repo", "db"]) as never, afterDbProvisioned: vi.fn(async () => "x") },
        { afterProvision: callerHook },
      );
      expect(callerHook.mock.calls.map((c) => c[0])).toEqual(["repo", "db"]);
    });

    it("a failed connect never fails provisioning", async () => {
      const afterDb = vi.fn(async () => { throw new Error("neon down"); });
      await expect(
        provisionCompany("t1", "Acme", ["db"], { register: vi.fn(), resolve: firing(["db"]) as never, afterDbProvisioned: afterDb }),
      ).resolves.toEqual(emptySummary);
    });
  });
});
