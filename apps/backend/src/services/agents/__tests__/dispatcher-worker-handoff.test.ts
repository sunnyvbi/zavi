import { describe, it, expect } from "vitest";
import { fastSiteBuildInputs, workerResolvedRepo } from "@/services/agents/generic-dispatcher";

const T1 = "11111111-1111-4111-8111-111111111111";

describe("workerResolvedRepo — the dispatcher reuses the repo the worker resolved for this run", () => {
  const ctx = { worker_sandbox: { repo_full_name: "praxis-built/acme-site", e2b_sandbox_id: "sbx-1" } };

  it("reuses it when the run's repo_hint is that same repo", () => {
    expect(workerResolvedRepo(ctx, "praxis-built/acme-site")).toBe("praxis-built/acme-site");
    expect(workerResolvedRepo(ctx, "  praxis-built/acme-site ")).toBe("praxis-built/acme-site");
  });

  it("falls back to resolving when the hint names another repo, is missing, or the worker set nothing", () => {
    expect(workerResolvedRepo(ctx, "someone/else")).toBeUndefined();
    expect(workerResolvedRepo(ctx, undefined)).toBeUndefined();
    expect(workerResolvedRepo(ctx, 42)).toBeUndefined();
    expect(workerResolvedRepo({}, "praxis-built/acme-site")).toBeUndefined();
    expect(workerResolvedRepo({ worker_sandbox: { repo_full_name: "", e2b_sandbox_id: "x" } }, "")).toBeUndefined();
  });

  it("a forged payload cannot supply the repo: only the server-set ctx field is read", () => {
    const forged = { worker_sandbox: undefined, repo_full_name: "victim/repo" } as unknown as Parameters<typeof workerResolvedRepo>[0];
    expect(workerResolvedRepo(forged, "victim/repo")).toBeUndefined();
  });
});

describe("fastSiteBuildInputs — founder name and quality rules are read together", () => {
  it("starts both reads before either answers, for this run's tenant only", async () => {
    const started: string[] = [];
    let releaseName!: (v: string | null) => void;
    const name = new Promise<string | null>((r) => { releaseName = r; });
    const done = fastSiteBuildInputs(T1, {
      founderName: (async (t: string) => { started.push(`name:${t}`); return name; }) as never,
      quality: (async (t: string) => { started.push(`quality:${t}`); return { rules: ["r1"] }; }) as never,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual([`name:${T1}`, `quality:${T1}`]);
    releaseName("RideNow");
    expect(await done).toEqual({ founderName: "RideNow", quality: { rules: ["r1"] } });
  });

  it("a failing quality read still fails the prompt build (no silent default)", async () => {
    await expect(
      fastSiteBuildInputs(T1, {
        founderName: (async () => null) as never,
        quality: (async () => { throw new Error("settings down"); }) as never,
      }),
    ).rejects.toThrow(/settings down/);
  });
});
