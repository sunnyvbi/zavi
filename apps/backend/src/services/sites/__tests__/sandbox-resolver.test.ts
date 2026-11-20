import { describe, it, expect, vi } from "vitest";
import { createSiteSandboxResolver, recreateSiteSandbox, type SiteSandboxRecreateDeps } from "../sandbox-resolver";
import type { SiteRow } from "../contract";
import { SiteBackendUnresolved } from "../site-backend";
import { fakeSiteStore, siteRow, T1, T2 } from "./fake-site-store";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

function setup(
  rows: Record<string, { e2b_sandbox_id: string | null; status: string }>,
  recreate: ((site: SiteRow) => Promise<string>) | null = null,
) {
  const { store } = fakeSiteStore([
    siteRow({ id: A, label: "alpha" }),
    siteRow({ id: B, label: "beta" }),
    siteRow({ id: "cccccccc-0000-4000-8000-000000000003", tenant_id: T2, label: "gamma" }),
  ]);
  const loadSandboxRow = vi.fn(async (t: string, repo: string) => rows[`${t}|${repo}`] ?? null);
  const resume = vi.fn(async () => {});
  const exec = vi.fn(async (_id: string, _cmd: string, _t?: number, _o?: unknown) => ({
    stdout: "ok",
    stderr: "",
    exit_code: 0,
    ms: 1,
    timed_out: false,
  }));
  const readFileBytes = vi.fn(async () => new Uint8Array([104, 105]));
  const revokeToken = vi.fn(async (_id: string) => {});
  const quarantine = vi.fn(async (_id: string) => {});
  const destroy = vi.fn(async (_id: string) => {});
  const resolver = createSiteSandboxResolver({ store, loadSandboxRow, resume, exec, readFileBytes, recreate, revokeToken, quarantine, destroy });
  return { resolver, loadSandboxRow, resume, exec, revokeToken, quarantine, destroy };
}

const origin = (url: string) => ({ stdout: `${url}\n`, stderr: "", exit_code: 0, ms: 1, timed_out: false });

describe("SiteSandboxResolver", () => {
  it("two sites in one tenant resolve to their own sandboxes", async () => {
    const { resolver, loadSandboxRow, exec } = setup({
      [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "active" },
      [`${T1}|Praxis-build/beta`]: { e2b_sandbox_id: "sbx-b", status: "paused" },
    });
    const a = await resolver.forSite(T1, A);
    const b = await resolver.forSite(T1, B);
    await a!.run("echo a", { cwd: "/home/user/repo", env: { X: "secret-value-1" }, redact: ["r"] });
    await b!.run("echo b");
    expect(exec.mock.calls[0][0]).toBe("sbx-a");
    expect(exec.mock.calls[0][1]).toBe("cd '/home/user/repo' && echo a");
    expect(exec.mock.calls[0][3]).toEqual({ env: { X: "secret-value-1" }, redact: ["r"] });
    expect(exec.mock.calls[1][0]).toBe("sbx-b");
    expect(loadSandboxRow.mock.calls.map((c) => c[1])).toEqual(["Praxis-build/alpha", "Praxis-build/beta"]);
  });

  it("another tenant's site id resolves to nothing", async () => {
    const { resolver, loadSandboxRow } = setup({});
    expect(await resolver.forSite(T1, "cccccccc-0000-4000-8000-000000000003")).toBeNull();
    expect(loadSandboxRow).not.toHaveBeenCalled();
  });

  it("a destroyed or missing sandbox is null", async () => {
    const { resolver } = setup({ [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "destroyed" } });
    expect(await resolver.forSite(T1, A)).toBeNull();
    expect(await resolver.forSite(T1, B)).toBeNull();
  });

  it("a sandbox that cannot resume is null", async () => {
    const { resolver, resume } = setup({ [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "paused" } });
    resume.mockRejectedValueOnce(new Error("gone"));
    expect(await resolver.forSite(T1, A)).toBeNull();
  });

  it("readFile returns a Buffer", async () => {
    const { resolver } = setup({ [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "active" } });
    const sb = await resolver.forSite(T1, A);
    expect(Buffer.isBuffer(await sb!.readFile("/x"))).toBe(true);
  });
});

describe("SiteSandboxResolver — a gone sandbox is recreated", () => {
  it.each([
    ["destroyed", { e2b_sandbox_id: "sbx-old", status: "destroyed" }],
    ["failed", { e2b_sandbox_id: "sbx-old", status: "failed" }],
    ["missing", null],
  ] as const)("a %s sandbox is recreated for the site and used", async (_n, row) => {
    const recreate = vi.fn(async () => "sbx-new");
    const { resolver, exec, resume } = setup(row ? { [`${T1}|Praxis-build/alpha`]: row } : {}, recreate);
    const sb = await resolver.forSite(T1, A);
    expect(recreate).toHaveBeenCalledTimes(1);
    expect((recreate.mock.calls[0] as unknown as [SiteRow])[0]).toMatchObject({ id: A, tenant_id: T1, github_full_name: "Praxis-build/alpha" });
    expect(resume).not.toHaveBeenCalled();
    await sb!.run("git status");
    expect(exec.mock.calls[0][0]).toBe("sbx-new");
  });

  it("a sandbox that will not resume is recreated", async () => {
    const recreate = vi.fn(async () => "sbx-new");
    const { resolver, resume } = setup({ [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "paused" } }, recreate);
    resume.mockRejectedValueOnce(new Error("gone"));
    expect(await resolver.forSite(T1, A)).not.toBeNull();
    expect(recreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://x-access-token:REVOKED@github.com/Praxis-build/alpha.git",
    "https://github.com/Praxis-build/alpha.git",
    "https://github.com/praxis-build/ALPHA",
  ])("a usable sandbox wired to the site's repo (%s) is resumed as is, never recreated", async (url) => {
    const recreate = vi.fn(async () => "sbx-new");
    const { resolver, exec, revokeToken } = setup({ [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "paused" } }, recreate);
    exec.mockResolvedValueOnce(origin(url));
    const sb = await resolver.forSite(T1, A);
    expect(exec.mock.calls[0][1]).toBe("cd /home/user/repo && git remote get-url origin");
    expect(recreate).not.toHaveBeenCalled();
    expect(revokeToken).not.toHaveBeenCalled();
    await sb!.run("x");
    expect(exec.mock.calls[1][0]).toBe("sbx-a");
  });

  it("a usable sandbox whose origin still carries a live credential is scrubbed before it is used", async () => {
    const { resolver, exec, revokeToken } = setup({ [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "active" } }, vi.fn(async () => "sbx-new"));
    exec.mockResolvedValueOnce(origin("https://x-access-token:ghs_live123@github.com/Praxis-build/alpha.git"));
    expect(await resolver.forSite(T1, A)).not.toBeNull();
    expect(revokeToken).toHaveBeenCalledWith("sbx-a");
  });

  it("a credential that cannot be scrubbed from a usable sandbox fails the tick (never handed to the deploy)", async () => {
    const { resolver, exec, revokeToken } = setup({ [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "active" } }, vi.fn(async () => "sbx-new"));
    exec.mockResolvedValueOnce(origin("https://x-access-token:ghs_live123@github.com/Praxis-build/alpha.git"));
    revokeToken.mockRejectedValueOnce(new Error("scrub failed"));
    await expect(resolver.forSite(T1, A)).rejects.toThrow("scrub failed");
  });

  it.each([false, true])("a failed scrub of a resumed sandbox force-pauses it, and destroys it when the pause fails (#3474) [pause fails: %s]", async (pauseFails) => {
    const { resolver, exec, revokeToken, quarantine, destroy } = setup({ [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "active" } }, vi.fn(async () => "sbx-new"));
    exec.mockResolvedValueOnce(origin("https://x-access-token:ghs_live123@github.com/Praxis-build/alpha.git"));
    revokeToken.mockRejectedValueOnce(new Error("scrub failed"));
    if (pauseFails) quarantine.mockRejectedValueOnce(new Error("pause failed"));
    await expect(resolver.forSite(T1, A)).rejects.toThrow("scrub failed");
    expect(quarantine).toHaveBeenCalledWith("sbx-a");
    if (pauseFails) expect(destroy).toHaveBeenCalledWith("sbx-a");
    else expect(destroy).not.toHaveBeenCalled();
  });

  it.each([
    ["another repo", "https://github.com/zavi/vite-starter.git"],
    ["a look-alike repo", "https://github.com/Praxis-build/alpha-evil.git"],
    ["no origin", null],
  ])("a usable sandbox wired to %s (left half set up) is set up again", async (_n, url) => {
    const recreate = vi.fn(async () => "sbx-a");
    const { resolver, exec } = setup({ [`${T1}|Praxis-build/alpha`]: { e2b_sandbox_id: "sbx-a", status: "active" } }, recreate);
    exec.mockResolvedValueOnce(url ? origin(url) : { stdout: "", stderr: "error: No such remote 'origin'", exit_code: 2, ms: 1, timed_out: false });
    await resolver.forSite(T1, A);
    expect(recreate).toHaveBeenCalledTimes(1);
  });

  it("a failed recreate throws (the conductor retries the step), never resolves to a wrong box", async () => {
    const recreate = vi.fn(async () => {
      throw new Error("e2b down");
    });
    const { resolver } = setup({}, recreate);
    await expect(resolver.forSite(T1, A)).rejects.toThrow("e2b down");
  });

  it("another tenant's site is never recreated", async () => {
    const recreate = vi.fn(async () => "sbx-new");
    const { resolver } = setup({}, recreate);
    expect(await resolver.forSite(T1, "cccccccc-0000-4000-8000-000000000003")).toBeNull();
    expect(recreate).not.toHaveBeenCalled();
  });
});

describe("recreateSiteSandbox — the normal setup path", () => {
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  function rdeps(over: Partial<SiteSandboxRecreateDeps> = {}) {
    const calls: string[] = [];
    const d: SiteSandboxRecreateDeps = {
      token: () => "ghs_token",
      resolve: vi.fn(async () => (calls.push("resolve"), { row_id: "row-1", e2b_sandbox_id: "sbx-new" })),
      injectSecrets: vi.fn(async () => void calls.push("inject")),
      revokeToken: vi.fn(async () => void calls.push("revoke")),
      headOf: vi.fn(async () => HEAD),
      resetRepo: vi.fn(async () => void calls.push("reset")),
      markFailed: vi.fn(async () => void calls.push("markFailed")),
      template: (_id, backend) => (backend === "pooled" ? "zavi-img" : "vite-img"),
      log: () => {},
      alert: vi.fn(async () => {}),
      ...over,
    };
    return { d, calls };
  }
  const site = (over: Partial<SiteRow> = {}) => siteRow({ id: A, label: "alpha", backend_mode: "pooled", ...over });

  it("creates on the site's backend image, injects the credential, resets to main HEAD, then scrubs it (env + origin)", async () => {
    const { d, calls } = rdeps();
    expect(await recreateSiteSandbox(site(), d)).toBe("sbx-new");
    expect(d.resolve).toHaveBeenCalledWith({
      tenant_id: T1,
      repo_full_name: "Praxis-build/alpha",
      installation_token: "ghs_token",
      template: "zavi-img",
      provisioned: true,
      run_id: A,
    });
    expect(d.injectSecrets).toHaveBeenCalledWith("sbx-new", { GITHUB_TOKEN: "ghs_token" });
    expect(d.resetRepo).toHaveBeenCalledWith("sbx-new", "https://github.com/Praxis-build/alpha.git", HEAD);
    expect(d.revokeToken).toHaveBeenCalledWith("sbx-new");
    expect(calls).toEqual(["resolve", "inject", "reset", "revoke"]);
  });

  it("a credential that cannot be scrubbed fails closed: the box is marked failed and never returned", async () => {
    let n = 0;
    const { d } = rdeps({
      revokeToken: vi.fn(async () => {
        n++;
        throw new Error("scrub failed");
      }),
    });
    await expect(recreateSiteSandbox(site(), d)).rejects.toThrow("scrub failed");
    expect(n).toBe(2);
    expect(d.markFailed).toHaveBeenCalledWith("row-1", expect.stringContaining("scrub failed"));
  });

  it("a mark-failed error does not mask the setup error", async () => {
    const { d } = rdeps({
      resetRepo: vi.fn(async () => { throw new Error("HEAD mismatch"); }),
      markFailed: vi.fn(async () => { throw new Error("db down"); }),
    });
    await expect(recreateSiteSandbox(site(), d)).rejects.toThrow("HEAD mismatch");
  });

  it("a dedicated site gets the dedicated image; a kernel site the pooled one", async () => {
    const a = rdeps();
    await recreateSiteSandbox(site({ backend_mode: "dedicated" }), a.d);
    expect((a.d.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0].template).toBe("vite-img");
    const b = rdeps();
    await recreateSiteSandbox(site({ backend_mode: "dedicated", kernel_shard_id: "k1" }), b.d);
    expect((b.d.resolve as ReturnType<typeof vi.fn>).mock.calls[0][0].template).toBe("zavi-img");
  });

  it("falls back to the site's desired commit when HEAD cannot be read", async () => {
    const { d } = rdeps({ headOf: async () => null });
    await recreateSiteSandbox(site({ desired_sha: "fedcba9" }), d);
    expect(d.resetRepo).toHaveBeenCalledWith("sbx-new", "https://github.com/Praxis-build/alpha.git", "fedcba9");
  });

  it("a commit the caller already read is the one set up, with no second head read to fall back from", async () => {
    const { d } = rdeps({ headOf: vi.fn(async () => null) });
    await recreateSiteSandbox(site({ desired_sha: "fedcba9" }), d, { fresh: false, sha: HEAD });
    expect(d.headOf).not.toHaveBeenCalled();
    expect(d.resetRepo).toHaveBeenCalledWith("sbx-new", "https://github.com/Praxis-build/alpha.git", HEAD);
  });

  it("retries the resolve once (a resume that failed marks the row failed, the second call creates)", async () => {
    let n = 0;
    const { d } = rdeps({
      resolve: vi.fn(async () => {
        if (n++ === 0) throw new Error("resume failed");
        return { row_id: "row-1", e2b_sandbox_id: "sbx-new" };
      }),
    });
    expect(await recreateSiteSandbox(site(), d)).toBe("sbx-new");
    expect(d.resolve).toHaveBeenCalledTimes(2);
  });

  it("a setup failure scrubs the credential, marks the box failed (so a retry recreates it), alerts and throws", async () => {
    const { d, calls } = rdeps({ resetRepo: vi.fn(async () => { throw new Error("HEAD mismatch"); }) });
    await expect(recreateSiteSandbox(site(), d)).rejects.toThrow("HEAD mismatch");
    expect(d.markFailed).toHaveBeenCalledWith("row-1", expect.stringContaining("HEAD mismatch"));
    expect(calls).toEqual(["resolve", "inject", "revoke", "markFailed"]);
    expect(d.alert).toHaveBeenCalledWith(expect.objectContaining({ code: "site_sandbox_recreate_failed", tenant_id: T1 }));
  });

  it("a failed scrub force-pauses the box (#3474)", async () => {
    const quarantine = vi.fn(async () => {});
    const { d } = rdeps({ revokeToken: vi.fn(async () => { throw new Error("scrub failed"); }), quarantine });
    await expect(recreateSiteSandbox(site(), d)).rejects.toThrow("scrub failed");
    expect(quarantine).toHaveBeenCalledWith("sbx-new");
  });

  it("a failed pause falls back to destroying the box; both failing raises the uncontained alert", async () => {
    const destroy = vi.fn(async () => {});
    const a = rdeps({ revokeToken: vi.fn(async () => { throw new Error("scrub failed"); }), quarantine: vi.fn(async () => { throw new Error("pause failed"); }), destroy });
    await expect(recreateSiteSandbox(site(), a.d)).rejects.toThrow("scrub failed");
    expect(destroy).toHaveBeenCalledWith("sbx-new");
    expect(a.d.alert).not.toHaveBeenCalledWith(expect.objectContaining({ code: "site_sandbox_credential_uncontained" }));
    const b = rdeps({
      revokeToken: vi.fn(async () => { throw new Error("scrub failed"); }),
      quarantine: vi.fn(async () => { throw new Error("pause failed"); }),
      destroy: vi.fn(async () => { throw new Error("kill failed"); }),
    });
    await expect(recreateSiteSandbox(site(), b.d)).rejects.toThrow("scrub failed");
    expect(b.d.alert).toHaveBeenCalledWith(expect.objectContaining({ code: "site_sandbox_credential_uncontained", tenant_id: T1 }));
  });

  it("a successful scrub after a setup failure does not pause the box", async () => {
    const quarantine = vi.fn(async () => {});
    const { d } = rdeps({ resetRepo: vi.fn(async () => { throw new Error("HEAD mismatch"); }), quarantine });
    await expect(recreateSiteSandbox(site(), d)).rejects.toThrow("HEAD mismatch");
    expect(quarantine).not.toHaveBeenCalled();
  });

  it("fresh mode retires the old box BEFORE resolve, so the credential only reaches a new box", async () => {
    const calls: string[] = [];
    const { d } = rdeps({
      retireExisting: vi.fn(async () => void calls.push("retire")),
      resolve: vi.fn(async () => (calls.push("resolve"), { row_id: "row-1", e2b_sandbox_id: "sbx-new" })),
      injectSecrets: vi.fn(async () => void calls.push("inject")),
      revokeToken: vi.fn(async () => void calls.push("revoke")),
      resetRepo: vi.fn(async () => void calls.push("reset")),
    });
    expect(await recreateSiteSandbox(site(), d, { fresh: true })).toBe("sbx-new");
    expect(calls).toEqual(["retire", "resolve", "inject", "reset", "revoke"]);
  });

  it("fresh mode fails closed: no retire hook, a failed retire, or a failed resolve never injects the credential", async () => {
    const noHook = rdeps();
    await expect(recreateSiteSandbox(site(), noHook.d, { fresh: true })).rejects.toThrow(/fresh box/);
    expect(noHook.d.resolve).not.toHaveBeenCalled();
    const badRetire = rdeps({ retireExisting: vi.fn(async () => { throw new Error("kill failed"); }) });
    await expect(recreateSiteSandbox(site(), badRetire.d, { fresh: true })).rejects.toThrow(/retire/);
    expect(badRetire.d.resolve).not.toHaveBeenCalled();
    expect(badRetire.d.injectSecrets).not.toHaveBeenCalled();
    const badResolve = rdeps({ retireExisting: vi.fn(async () => {}), resolve: vi.fn(async () => { throw new Error("create failed"); }) });
    await expect(recreateSiteSandbox(site(), badResolve.d, { fresh: true })).rejects.toThrow(/create failed/);
    expect(badResolve.d.resolve).toHaveBeenCalledTimes(1);
    expect(badResolve.d.injectSecrets).not.toHaveBeenCalled();
  });

  it("refuses without a backend (never guesses the image), a repo, or the credential", async () => {
    await expect(recreateSiteSandbox(site({ backend_mode: undefined }), rdeps().d)).rejects.toBeInstanceOf(SiteBackendUnresolved);
    await expect(recreateSiteSandbox(site({ github_full_name: "not a repo" }), rdeps().d)).rejects.toThrow(/no valid repo/);
    const none = rdeps({ token: () => null });
    await expect(recreateSiteSandbox(site(), none.d)).rejects.toThrow(/credential/);
    expect(none.d.resolve).not.toHaveBeenCalled();
  });
});
