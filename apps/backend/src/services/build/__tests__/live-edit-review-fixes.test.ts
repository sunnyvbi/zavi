import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectCalls: string[] = [];
const rowHolder: { row: Record<string, unknown> | null } = { row: null };
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    from: () => {
      const q = {
        select: (cols: string) => {
          selectCalls.push(cols);
          return q;
        },
        eq: () => q,
        maybeSingle: async () => ({ data: rowHolder.row, error: null }),
      };
      return q;
    },
  }),
}));

import {
  checkoutDraftOrThrow,
  claimLiveEditPreview,
  ensureLiveEditPreview,
  kickLiveEditPreview,
  invalidateLiveEditState,
  releaseLiveEditPreviewClaim,
  publishDraft,
  realEnsurePreviewDeps,
  realLiveEditDeps,
  type EnsurePreviewDeps,
  type LiveEditDeps,
} from "@/services/build/live-edit";
import { DEFAULT_PROTECTED_GLOBS } from "@/services/agents/pipeline-policy";
import { shouldKeepWarm } from "@/services/sandbox/lifecycle";

const T = "tenant-rf";
const TARGET = { github_full_name: "praxis-built/acme-1234", default_branch: "main" };
const HEAD = "c".repeat(40);

function deps(over: Partial<LiveEditDeps> = {}): LiveEditDeps & { [K in keyof LiveEditDeps]: ReturnType<typeof vi.fn> } {
  return {
    enabled: vi.fn().mockResolvedValue(true),
    loadTarget: vi.fn().mockResolvedValue(TARGET),
    assertProvisioned: vi.fn().mockResolvedValue(true),
    installation: vi.fn().mockResolvedValue(-1),
    compare: vi.fn().mockResolvedValue({ ahead_by: 1, behind_by: 0, commits: [{ sha: HEAD, message: "x" }] }),
    changedFiles: vi.fn().mockResolvedValue(["app/page.tsx"]),
    protectedGlobs: vi.fn().mockResolvedValue([...DEFAULT_PROTECTED_GLOBS]),
    branchSha: vi.fn().mockResolvedValue(HEAD),
    fastForward: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(true),
    hasActiveBuild: vi.fn().mockResolvedValue(false),
    loadPreviewRow: vi.fn().mockResolvedValue(null),
    clearPreview: vi.fn().mockResolvedValue(undefined),
    touchPreview: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => 1),
    ...over,
  } as never;
}

beforeEach(() => invalidateLiveEditState(T));

describe("publishDraft protected paths", () => {
  it("refuses to fast-forward main when the draft touches env, migrations or auth, and lists the paths", async () => {
    const d = deps({
      changedFiles: vi.fn().mockResolvedValue(["app/page.tsx", ".env.local", "supabase/migrations/001.sql", "src/auth/session.ts"]),
    });
    const err = await publishDraft(T, d).catch((e) => e);
    expect(err).toMatchObject({ code: "protected_paths", status: 409 });
    expect(err.message).toContain(".env.local");
    expect(err.message).toContain("supabase/migrations/001.sql");
    expect(err.message).toContain("src/auth/session.ts");
    expect(err.message).not.toContain("app/page.tsx");
    expect(err.message).toContain("It needs a review before it can go live.");
    expect(d.fastForward).not.toHaveBeenCalled();
  });

  it("checks the exact sha it would publish, not the moving branch name", async () => {
    const d = deps();
    await publishDraft(T, d);
    expect(d.changedFiles).toHaveBeenCalledWith(expect.objectContaining({ base: "main", head: HEAD }));
    expect(d.fastForward).toHaveBeenCalledWith(expect.objectContaining({ to_sha: HEAD }));
  });

  it("honours the app's own protected globs from its pipeline policy", async () => {
    const d = deps({
      changedFiles: vi.fn().mockResolvedValue(["lib/pricing/plans.ts"]),
      protectedGlobs: vi.fn().mockResolvedValue([...DEFAULT_PROTECTED_GLOBS, "lib/pricing/**"]),
    });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "protected_paths" });
    expect(d.protectedGlobs).toHaveBeenCalledWith(T);
    expect(d.fastForward).not.toHaveBeenCalled();
  });

  it("caps the listed paths at five", async () => {
    const files = Array.from({ length: 8 }, (_, i) => `billing/f${i}.ts`);
    const d = deps({ changedFiles: vi.fn().mockResolvedValue(files) });
    const err = await publishDraft(T, d).catch((e) => e);
    expect(err.message).toContain("billing/f4.ts");
    expect(err.message).not.toContain("billing/f5.ts");
    expect(err.message).toContain("3 more");
  });

  it("fails closed when the changed file list cannot be read", async () => {
    const d = deps({ changedFiles: vi.fn().mockRejectedValue(new Error("compare HTTP 502")) });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "protected_paths", status: 409 });
    expect(d.fastForward).not.toHaveBeenCalled();
  });

  it("fails closed when the protected globs cannot be loaded", async () => {
    const d = deps({ protectedGlobs: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "protected_paths" });
    expect(d.fastForward).not.toHaveBeenCalled();
  });
});

describe("real changed-files reader", () => {
  const fetchMock = vi.fn();
  const auth = { tenant_id: T, installation_id: -1, owner: "praxis-built", repo: "acme-1234", base: "main", head: HEAD };
  beforeEach(() => {
    vi.stubEnv("GITHUB_PROVISION_TOKEN", "pat-x");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("returns both sides of a rename so moving a file out of a protected dir is caught", async () => {
    fetchMock.mockResolvedValue(json({ files: [{ filename: "src/app/x.ts", previous_filename: "src/auth/x.ts" }, { filename: "a.ts" }] }));
    const out = await realLiveEditDeps.changedFiles(auth);
    expect(out).toEqual(["src/app/x.ts", "src/auth/x.ts", "a.ts"]);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/compare/main...${HEAD}`);
  });

  it("throws on a truncated 300-file list instead of trusting a partial list", async () => {
    fetchMock.mockResolvedValue(json({ files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` })) }));
    await expect(realLiveEditDeps.changedFiles(auth)).rejects.toThrow(/truncated/);
  });

  it("throws when GitHub omits the file list or errors", async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(realLiveEditDeps.changedFiles(auth)).rejects.toThrow();
    fetchMock.mockResolvedValue(json({ message: "nope" }, 404));
    await expect(realLiveEditDeps.changedFiles(auth)).rejects.toThrow(/404/);
  });

  it("a real 300-file draft is refused end to end, main never moves", async () => {
    fetchMock.mockResolvedValue(json({ files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` })) }));
    const d = deps({ changedFiles: realLiveEditDeps.changedFiles });
    await expect(publishDraft(T, d)).rejects.toMatchObject({ code: "protected_paths" });
    expect(d.fastForward).not.toHaveBeenCalled();
  });
});

describe("ensureLiveEditPreview reuse re-stamps a preview the reaper does not own", () => {
  const ROW = { id: "row1", e2b_sandbox_id: "sb1", preview_status: "live", preview_url: "https://3000-sb1.e2b.app", preview_port: 3000 };
  function pdeps(row: Record<string, unknown>) {
    return {
      loadPreviewRow: vi.fn().mockResolvedValue(row),
      exec: vi.fn().mockResolvedValue({ stdout: "200", stderr: "", exit_code: 0 }),
      setPreview: vi.fn().mockResolvedValue(undefined),
      clearPreview: vi.fn().mockResolvedValue(undefined),
      startServer: vi.fn(),
      hostFor: vi.fn(),
      countFleetPreviews: vi.fn().mockResolvedValue(0),
    } as unknown as EnsurePreviewDeps & { [K in keyof EnsurePreviewDeps]: ReturnType<typeof vi.fn> };
  }
  const input = { tenant_id: T, repo_full_name: TARGET.github_full_name, sandbox_id: "sb1", run_id: "run-7" };

  it("stamps the first-build instant preview (no run id) with the live-edit marker, keeping url and port", async () => {
    const d = pdeps({ ...ROW, preview_run_id: null, preview_port: 4321 });
    const out = await ensureLiveEditPreview(input, d);
    expect(out).toMatchObject({ url: ROW.preview_url, reason: "reused" });
    expect(d.setPreview).toHaveBeenCalledTimes(1);
    expect(d.setPreview).toHaveBeenCalledWith("row1", ROW.preview_url, 4321, "live", "live-edit:run-7");
    expect(d.startServer).not.toHaveBeenCalled();
  });

  it("stamps a preview owned by a normal engineer run", async () => {
    const d = pdeps({ ...ROW, preview_run_id: "run-engineer-1" });
    await ensureLiveEditPreview(input, d);
    expect(d.setPreview).toHaveBeenCalledWith("row1", ROW.preview_url, 3000, "live", "live-edit:run-7");
  });

  it("leaves an already live-edit-owned preview alone", async () => {
    const d = pdeps({ ...ROW, preview_run_id: "live-edit:wake" });
    await ensureLiveEditPreview(input, d);
    expect(d.setPreview).not.toHaveBeenCalled();
  });

  it("the real row loader selects preview_run_id so the check sees real data", async () => {
    rowHolder.row = { ...ROW, preview_run_id: null };
    const row = await realEnsurePreviewDeps.loadPreviewRow(T, TARGET.github_full_name);
    expect(selectCalls.at(-1)).toContain("preview_run_id");
    expect(row).toHaveProperty("preview_run_id", null);
  });
});

describe("checkoutDraftOrThrow", () => {
  it("throws on a failed checkout so an Inngest step retries it instead of memoizing the failure", async () => {
    const checkout = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "fetch" })
      .mockResolvedValueOnce({ ok: true, sha: HEAD });
    const memo = new Map<string, unknown>();
    const stepRun = async <R>(id: string, fn: () => Promise<R>): Promise<R> => {
      if (memo.has(id)) return memo.get(id) as R;
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fn();
          memo.set(id, r);
          return r;
        } catch (e) {
          if (attempt >= 3) throw e;
        }
      }
    };
    const out = await stepRun("checkout-live-edit-draft", () => checkoutDraftOrThrow("sb1", "main", checkout));
    expect(out).toEqual({ ok: true, sha: HEAD });
    expect(checkout).toHaveBeenCalledTimes(2);
    expect(memo.get("checkout-live-edit-draft")).toEqual({ ok: true, sha: HEAD });
  });

  it("names the failure reason", async () => {
    await expect(checkoutDraftOrThrow("sb1", "main", vi.fn().mockResolvedValue({ ok: false, reason: "lock" }))).rejects.toThrow(
      "live edit: draft checkout failed (lock)",
    );
  });
});

describe("a finished change holds its sandbox warm before the preview boots in the background", () => {
  const input: Parameters<typeof kickLiveEditPreview>[0] = {
    tenant_id: T,
    repo_full_name: TARGET.github_full_name,
    sandbox_id: "sb1",
    run_id: "run-9",
    install: true,
  };
  function rowStore(initial: Record<string, unknown>) {
    const store = { row: { ...initial } as Record<string, unknown> };
    const loadPreviewRow = vi.fn(async () => ({ ...store.row }) as unknown as Awaited<ReturnType<EnsurePreviewDeps["loadPreviewRow"]>>);
    const setPreview = vi.fn(async (_id: string, url: string | null, port: number, status: "starting" | "live", run: string) => {
      store.row = { ...store.row, preview_url: url, preview_port: port, preview_status: status, preview_run_id: run };
    });
    const clearPreview = vi.fn(async () => {
      store.row = { ...store.row, preview_url: null, preview_status: "none", preview_run_id: null };
    });
    return { store, loadPreviewRow, setPreview, clearPreview };
  }

  it("the run-end pause sees a live-edit boot in progress the moment the kick returns, even while the boot is still running", async () => {
    const r = rowStore({ id: "row1", e2b_sandbox_id: "sb1", preview_status: "none", preview_url: null, preview_port: null, preview_run_id: null });
    expect(shouldKeepWarm(r.store.row)).toBe(false);
    let bootStarted = false;
    await kickLiveEditPreview(input, {
      claim: (i) => claimLiveEditPreview(i, r),
      ensure: () => {
        bootStarted = true;
        return new Promise(() => undefined);
      },
    });
    expect(bootStarted).toBe(true);
    expect(r.store.row).toMatchObject({ preview_status: "starting", preview_run_id: "live-edit:run-9" });
    expect(shouldKeepWarm(r.store.row)).toBe(true);
  });

  it("leaves a live preview and another sandbox's row untouched", async () => {
    const live = rowStore({ id: "row1", e2b_sandbox_id: "sb1", preview_status: "live", preview_url: "https://3000-sb1.e2b.app", preview_port: 3000 });
    expect(await claimLiveEditPreview(input, live)).toBe(false);
    const other = rowStore({ id: "row1", e2b_sandbox_id: "sb-old", preview_status: "none", preview_url: null, preview_port: null });
    expect(await claimLiveEditPreview(input, other)).toBe(false);
    expect(live.setPreview).not.toHaveBeenCalled();
    expect(other.setPreview).not.toHaveBeenCalled();
  });

  it("a claim that loses the capacity check is released, so the box is not kept warm for nothing", async () => {
    const r = rowStore({ id: "row1", e2b_sandbox_id: "sb1", preview_status: "none", preview_url: null, preview_port: null, preview_run_id: null });
    await claimLiveEditPreview(input, r);
    const out = await ensureLiveEditPreview(input, {
      loadPreviewRow: r.loadPreviewRow,
      setPreview: r.setPreview,
      clearPreview: r.clearPreview,
      exec: vi.fn().mockResolvedValue({ stdout: "000", stderr: "", exit_code: 0 }),
      startServer: vi.fn(),
      hostFor: vi.fn(),
      countFleetPreviews: vi.fn().mockResolvedValue(10_000),
    } as unknown as EnsurePreviewDeps);
    expect(out.reason).toBe("capacity");
    expect(shouldKeepWarm(r.store.row)).toBe(false);
  });

  it("a failed claim still starts the boot", async () => {
    const ensure = vi.fn(() => new Promise<never>(() => undefined));
    await kickLiveEditPreview(input, { claim: vi.fn().mockRejectedValue(new Error("db down")), ensure });
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});

describe("a kick whose single-flight ensure comes back without a url releases its own claim (review finding 9)", () => {
  const input: Parameters<typeof kickLiveEditPreview>[0] = {
    tenant_id: T,
    repo_full_name: TARGET.github_full_name,
    sandbox_id: "sb1",
    run_id: "run-9",
    install: true,
  };
  const BLANK = { id: "row1", e2b_sandbox_id: "sb1", preview_status: "none", preview_url: null, preview_port: null, preview_run_id: null };
  function rowStore(initial: Record<string, unknown>) {
    const store = { row: { ...initial } as Record<string, unknown> };
    const loadPreviewRow = vi.fn(async () => ({ ...store.row }) as unknown as Awaited<ReturnType<EnsurePreviewDeps["loadPreviewRow"]>>);
    const setPreview = vi.fn(async (_id: string, url: string | null, port: number, status: "starting" | "live", run: string) => {
      store.row = { ...store.row, preview_url: url, preview_port: port, preview_status: status, preview_run_id: run };
    });
    const clearPreview = vi.fn(async () => {
      store.row = { ...store.row, preview_url: null, preview_status: "none", preview_run_id: null };
    });
    return { store, loadPreviewRow, setPreview, clearPreview };
  }
  async function flush() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  }

  it("joining an in-flight wake that is refused for capacity leaves no 'starting' row behind", async () => {
    const r = rowStore(BLANK);
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((res) => {
      openGate = res;
    });
    const edeps = {
      loadPreviewRow: r.loadPreviewRow,
      setPreview: r.setPreview,
      clearPreview: r.clearPreview,
      exec: vi.fn().mockResolvedValue({ stdout: "000", stderr: "", exit_code: 0 }),
      startServer: vi.fn(),
      hostFor: vi.fn(),
      countFleetPreviews: vi.fn(async () => {
        await gate;
        return 10_000;
      }),
    } as unknown as EnsurePreviewDeps;
    const wake = { tenant_id: T, repo_full_name: TARGET.github_full_name, sandbox_id: "sb1" };
    const inflight = ensureLiveEditPreview(wake, edeps);
    await flush();
    expect(edeps.countFleetPreviews).toHaveBeenCalledTimes(1);

    const ensure = vi.fn((i: typeof input) => ensureLiveEditPreview(i, edeps));
    await kickLiveEditPreview(input, {
      claim: (i) => claimLiveEditPreview(i, r),
      ensure,
      release: (i) => releaseLiveEditPreviewClaim(i, r),
    });
    expect(r.store.row).toMatchObject({ preview_status: "starting", preview_run_id: "live-edit:run-9" });

    openGate();
    expect((await inflight).reason).toBe("capacity");
    await flush();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(r.store.row).toMatchObject({ preview_status: "none", preview_run_id: null });
    expect(shouldKeepWarm(r.store.row)).toBe(false);
  });

  it("an ensure that throws also releases the claim", async () => {
    const r = rowStore(BLANK);
    await kickLiveEditPreview(input, {
      claim: (i) => claimLiveEditPreview(i, r),
      ensure: vi.fn().mockRejectedValue(new Error("boom")),
      release: (i) => releaseLiveEditPreviewClaim(i, r),
    });
    await flush();
    expect(r.store.row).toMatchObject({ preview_status: "none" });
  });

  it("a boot that went live is never cleared", async () => {
    const r = rowStore(BLANK);
    const release = vi.fn((i: typeof input) => releaseLiveEditPreviewClaim(i, r));
    await kickLiveEditPreview(input, {
      claim: (i) => claimLiveEditPreview(i, r),
      ensure: async () => {
        await r.setPreview("row1", "https://3000-sb1.e2b.app", 3000, "live", "live-edit:run-9");
        return { url: "https://3000-sb1.e2b.app", reused: false, reason: "booted" };
      },
      release,
    });
    await flush();
    expect(release).not.toHaveBeenCalled();
    expect(r.store.row).toMatchObject({ preview_status: "live", preview_url: "https://3000-sb1.e2b.app" });
  });

  it("a claim another caller has since taken over is left alone", async () => {
    const r = rowStore(BLANK);
    await kickLiveEditPreview(input, {
      claim: (i) => claimLiveEditPreview(i, r),
      ensure: async () => {
        await r.setPreview("row1", null, 3000, "starting", "live-edit:run-10");
        return { url: null, reused: false, reason: "capacity" };
      },
      release: (i) => releaseLiveEditPreviewClaim(i, r),
    });
    await flush();
    expect(r.clearPreview).not.toHaveBeenCalled();
    expect(r.store.row).toMatchObject({ preview_status: "starting", preview_run_id: "live-edit:run-10" });
  });

  it("a kick whose claim did not happen never clears someone else's row", async () => {
    const r = rowStore({ ...BLANK, preview_status: "starting", preview_run_id: "live-edit:run-9" });
    await kickLiveEditPreview(input, {
      claim: vi.fn().mockResolvedValue(false),
      ensure: async () => ({ url: null, reused: false, reason: "capacity" }),
      release: (i) => releaseLiveEditPreviewClaim(i, r),
    });
    await flush();
    expect(r.clearPreview).not.toHaveBeenCalled();
  });
});
