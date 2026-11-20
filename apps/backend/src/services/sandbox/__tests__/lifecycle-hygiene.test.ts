
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const probeFreeKb = vi.fn();
const gcSandboxDisk = vi.fn();
const destroySandbox = vi.fn();

vi.mock("@/services/sandbox/disk-hygiene", async () => {
  const actual = await vi.importActual<typeof import("../disk-hygiene")>("../disk-hygiene");
  return {
    ...actual,
    probeFreeKb: (...a: unknown[]) => probeFreeKb(...a),
    gcSandboxDisk: (...a: unknown[]) => gcSandboxDisk(...a),
  };
});
vi.mock("../e2b-client", () => ({
  createSandbox: vi.fn(),
  cloneRepo: vi.fn(),
  destroySandbox: (...a: unknown[]) => destroySandbox(...a),
  execCommand: vi.fn(),
  pauseSandbox: vi.fn(),
  resetToMain: vi.fn(),
  resumeSandbox: vi.fn(),
  setEnv: vi.fn(),
  wipeEnv: vi.fn(),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import {
  enforceSandboxHygiene,
  isSiteSandboxTemplate,
  recycleDriftedTemplate,
  templateDrifted,
  type SandboxRow,
} from "../lifecycle";

type SbArg = Parameters<typeof enforceSandboxHygiene>[0];

const GB_KB = 1024 * 1024;

function row(over: Partial<SandboxRow> = {}): SandboxRow {
  return {
    id: "row-1",
    tenant_id: "tenant-A",
    repo_full_name: "acme/app",
    e2b_sandbox_id: "sbx-1",
    status: "active",
    last_resumed_at: null,
    last_error: null,
    measured_tree_kb: null,
    e2b_template: null,
    needs_recreate_reason: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

function fakeSb(
  opts: { leaseGranted?: boolean; destroyAffected?: number; runningSharers?: number; repoSharers?: number } = {},
) {
  const { leaseGranted = true, destroyAffected = 1, runningSharers = 0, repoSharers = 0 } = opts;
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rows = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ id: `other-${i}` })), error: null });
  const sb = {
    calls,
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "try_lease_sandbox") return { data: leaseGranted, error: null };
      if (fn === "destroy_sandbox_row_cas") return { data: destroyAffected, error: null };
      return { data: null, error: null };
    }),
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({ limit: async () => rows(runningSharers) }),
            or: (filter: string) => {
              calls.push({ fn: "sharer.or", args: { filter } });
              return { neq: () => ({ limit: async () => rows(repoSharers) }) };
            },
          }),
        }),
      }),
    })),
  };
  return sb as unknown as SbArg & { calls: typeof calls };
}

const args = { tenant_id: "tenant-A", repo_full_name: "acme/app", run_id: "run-self" };
const didCall = (sb: { calls: Array<{ fn: string }> }, fn: string) =>
  sb.calls.some((c) => c.fn === fn);

const ENV = { ...process.env };
beforeEach(() => {
  probeFreeKb.mockReset();
  gcSandboxDisk.mockReset();
  destroySandbox.mockReset();
  gcSandboxDisk.mockResolvedValue({ freedKb: 0, steps: [] });
  process.env.SANDBOX_DISK_HYGIENE = "recreate";
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("enforceSandboxHygiene — fail-open (every agent's hot path)", () => {
  it("feature OFF → does nothing at all (no probe, no rpc)", async () => {
    process.env.SANDBOX_DISK_HYGIENE = "off";
    const sb = fakeSb();
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("disabled");
    expect(probeFreeKb).not.toHaveBeenCalled();
    expect(sb.calls).toHaveLength(0);
  });

  it("no run_id → cannot hold a lease → skips (never mutates unleased)", async () => {
    const sb = fakeSb();
    const out = await enforceSandboxHygiene(sb, row(), {
      tenant_id: "tenant-A",
      repo_full_name: "acme/app",
    });
    expect(out).toBe("disabled");
    expect(sb.calls).toHaveLength(0);
  });

  it("probe fails (unreachable box) → FAIL OPEN, proceeds, mutates nothing", async () => {
    probeFreeKb.mockResolvedValue(null);
    const sb = fakeSb();
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("probe_failed");
    expect(didCall(sb, "try_lease_sandbox")).toBe(false);
    expect(gcSandboxDisk).not.toHaveBeenCalled();
  });

  it("healthy box → one df, zero mutation (the hot path stays cheap)", async () => {
    probeFreeKb.mockResolvedValue(9 * GB_KB);
    const sb = fakeSb();
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("healthy");
    expect(sb.calls).toHaveLength(0);
    expect(gcSandboxDisk).not.toHaveBeenCalled();
  });

  it("probe_only mode → measures, never mutates", async () => {
    process.env.SANDBOX_DISK_HYGIENE = "probe_only";
    probeFreeKb.mockResolvedValue(100);
    const sb = fakeSb();
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("healthy");
    expect(gcSandboxDisk).not.toHaveBeenCalled();
    expect(sb.calls).toHaveLength(0);
  });
});

describe("enforceSandboxHygiene — exclusivity (never mutate a box someone else is using)", () => {
  it("LIVE SHARER → no GC, no destroy (a sibling mid-`yarn install` must not be corrupted)", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb({ runningSharers: 1 });
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("live_sharer");
    expect(gcSandboxDisk).not.toHaveBeenCalled();
    expect(didCall(sb, "destroy_sandbox_row_cas")).toBe(false);
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("the sharer check runs INSIDE the lease, not before it (TOCTOU)", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb({ runningSharers: 1 });
    await enforceSandboxHygiene(sb, row(), args);
    expect(sb.calls[0].fn).toBe("try_lease_sandbox");
    expect(sb.from).toHaveBeenCalled();
  });

  it("LEASE DENIED (another run holds it) → no mutation, and no spin", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb({ leaseGranted: false });
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("no_lease");
    expect(gcSandboxDisk).not.toHaveBeenCalled();
    expect(didCall(sb, "destroy_sandbox_row_cas")).toBe(false);
  });

  it("releases the lease even when it bails out mid-way", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb({ runningSharers: 1 });
    await enforceSandboxHygiene(sb, row(), args);
    expect(didCall(sb, "release_sandbox_lease")).toBe(true);
  });
});

describe("enforceSandboxHygiene — GC then recreate", () => {
  it("GC frees enough → SAME sandbox reused, nothing destroyed", async () => {
    probeFreeKb
      .mockResolvedValueOnce(100_000)
      .mockResolvedValueOnce(6 * GB_KB);
    gcSandboxDisk.mockResolvedValue({ freedKb: 6 * GB_KB, steps: ["yarn"] });
    const sb = fakeSb();
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("gc_ok");
    expect(didCall(sb, "destroy_sandbox_row_cas")).toBe(false);
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("GC insufficient + mode=gc_only → does NOT destroy", async () => {
    process.env.SANDBOX_DISK_HYGIENE = "gc_only";
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb();
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("gc_insufficient");
    expect(didCall(sb, "destroy_sandbox_row_cas")).toBe(false);
  });

  it("GC insufficient + mode=recreate → destroys under CAS and kills the e2b box", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb({ destroyAffected: 1 });
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("recreate");
    const cas = sb.calls.find((c) => c.fn === "destroy_sandbox_row_cas");
    expect(cas?.args).toMatchObject({
      p_id: "row-1",
      p_tenant_id: "tenant-A",
      p_e2b_sandbox_id: "sbx-1",
    });
    expect(destroySandbox).toHaveBeenCalledWith("sbx-1");
  });

  it("a pending recreate INTENT is honoured even when df now reads healthy", async () => {
    probeFreeKb.mockResolvedValue(9 * GB_KB);
    const sb = fakeSb();
    const out = await enforceSandboxHygiene(
      sb,
      row({ needs_recreate_reason: "insufficient_disk" }),
      args,
    );
    expect(out).toBe("recreate");
  });
});

describe("PROVISIONED sandboxes hold a customer's half-built app — GC yes, destroy NEVER", () => {
  it("recreate mode + full disk + provisioned → GCs, but does NOT destroy", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb();
    const out = await enforceSandboxHygiene(sb, row(), { ...args, provisioned: true });
    expect(out).toBe("provisioned_no_destroy");
    expect(gcSandboxDisk).toHaveBeenCalled();
    expect(didCall(sb, "destroy_sandbox_row_cas")).toBe(false);
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("a pending recreate INTENT does not override the provisioned refusal", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb();
    const out = await enforceSandboxHygiene(
      sb,
      row({ needs_recreate_reason: "insufficient_disk" }),
      { ...args, provisioned: true },
    );
    expect(out).toBe("provisioned_no_destroy");
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("template reconcile also refuses to recycle a provisioned box", () => {
    process.env.SANDBOX_TEMPLATE_RECONCILE = "1";
    expect(
      templateDrifted(row({ e2b_template: null }), {
        ...args,
        template: "praxis-xl",
        provisioned: true,
      }),
    ).toBe(false);
    expect(
      templateDrifted(row({ e2b_template: null }), { ...args, template: "praxis-xl" }),
    ).toBe(true);
  });

  it("a NON-provisioned box still recreates normally (the guard is scoped, not a blanket off)", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb();
    expect(await enforceSandboxHygiene(sb, row(), { ...args, provisioned: false })).toBe(
      "recreate",
    );
    expect(destroySandbox).toHaveBeenCalledWith("sbx-1");
  });
});

describe("multi-tenant safety (E3) — a mis-targeted destroy would kill a paying customer's box", () => {
  it("CAS affects 0 rows (world moved under us) → ABORT, do not kill the e2b sandbox", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb({ destroyAffected: 0 });
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("gc_insufficient");
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("CAS affects >1 row (impossible unless we mis-scoped) → ABORT", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb({ destroyAffected: 2 });
    expect(await enforceSandboxHygiene(sb, row(), args)).toBe("gc_insufficient");
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("every lease + destroy call is tenant-scoped", async () => {
    probeFreeKb.mockResolvedValue(100_000);
    const sb = fakeSb();
    await enforceSandboxHygiene(sb, row(), args);
    for (const c of sb.calls) {
      expect(c.args.p_tenant_id).toBe("tenant-A");
    }
  });
});

describe("site images reconcile for correctness (pooled vs dedicated starter)", () => {
  const ZAVI = "zavi-vite-pooled-starter";
  const VITE = "zavi-vite-starter";

  it("a site box on the other starter's image drifts even provisioned and with the sizing switch off", () => {
    delete process.env.SANDBOX_TEMPLATE_RECONCILE;
    expect(isSiteSandboxTemplate(ZAVI)).toBe(true);
    expect(isSiteSandboxTemplate(VITE)).toBe(true);
    expect(isSiteSandboxTemplate("praxis-xl")).toBe(false);
    expect(templateDrifted(row({ e2b_template: VITE }), { ...args, template: ZAVI, provisioned: true })).toBe(true);
    expect(templateDrifted(row({ e2b_template: null }), { ...args, template: ZAVI, provisioned: true })).toBe(true);
    expect(templateDrifted(row({ e2b_template: ZAVI }), { ...args, template: ZAVI, provisioned: true })).toBe(false);
    expect(templateDrifted(row({ e2b_template: null }), { ...args, template: "praxis-xl" })).toBe(false);
  });

  it("a running agent elsewhere in the workspace does not pin a site box; a live run on the same repo does", async () => {
    const elsewhere = fakeSb({ runningSharers: 3, repoSharers: 0 });
    expect(await recycleDriftedTemplate(elsewhere, row({ e2b_template: VITE }), { ...args, template: ZAVI, provisioned: true })).toBe(true);
    expect(elsewhere.calls.find((c) => c.fn === "sharer.or")?.args.filter).toBe(
      "payload->>repo_hint.eq.acme/app,payload->target->>github_full_name.eq.acme/app," +
        "and(payload->>repo_hint.is.null,payload->target->>github_full_name.is.null,agent_slug.in.(engineer,qa,product-builder))",
    );
    destroySandbox.mockReset();
    const same = fakeSb({ repoSharers: 1 });
    expect(await recycleDriftedTemplate(same, row({ e2b_template: VITE }), { ...args, template: ZAVI, provisioned: true })).toBe(false);
    expect(destroySandbox).not.toHaveBeenCalled();
  });
});

describe("recycleDriftedTemplate — same exclusivity contract", () => {
  it("live sharer → does NOT destroy a drifted box", async () => {
    const sb = fakeSb({ runningSharers: 1 });
    expect(await recycleDriftedTemplate(sb, row(), { ...args, template: "praxis-xl" })).toBe(false);
    expect(destroySandbox).not.toHaveBeenCalled();
  });

  it("no lease → does NOT destroy", async () => {
    const sb = fakeSb({ leaseGranted: false });
    expect(await recycleDriftedTemplate(sb, row(), { ...args, template: "praxis-xl" })).toBe(false);
    expect(didCall(sb, "destroy_sandbox_row_cas")).toBe(false);
  });

  it("alone + leased → CAS destroy, returns true so the caller rebuilds on the right template", async () => {
    const sb = fakeSb();
    expect(await recycleDriftedTemplate(sb, row(), { ...args, template: "praxis-xl" })).toBe(true);
    expect(destroySandbox).toHaveBeenCalledWith("sbx-1");
  });

  it("CAS mismatch → abort, no e2b kill", async () => {
    const sb = fakeSb({ destroyAffected: 0 });
    expect(await recycleDriftedTemplate(sb, row(), { ...args, template: "praxis-xl" })).toBe(false);
    expect(destroySandbox).not.toHaveBeenCalled();
  });
});
