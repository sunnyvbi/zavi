import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isBuildRepo,
  enabled,
  decideSandboxReap,
  decideOrphanSandbox,
  decideInfraReap,
  decidePreviewIdleReap,
  mergeTeardownRef,
  PREVIEW_IDLE_MIN,
  type SandboxReapRow,
  type InfraResourceRow,
} from "../infra-reaper";
import type { ListedSandbox } from "@/services/sandbox/e2b-client";

const NOW = Date.parse("2026-05-31T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const stale = new Date(NOW - 10 * DAY).toISOString();
const fresh = new Date(NOW - 1 * DAY).toISOString();

function sboxRow(over: Partial<SandboxReapRow>): SandboxReapRow {
  return {
    id: "row-1",
    tenant_id: "tenant-1",
    repo_full_name: "praxis-built/acme-abc12345",
    e2b_sandbox_id: "sbx-1",
    status: "paused",
    updated_at: stale,
    ...over,
  };
}

function infraRow(over: Partial<InfraResourceRow>): InfraResourceRow {
  return {
    tenant_id: "tenant-1",
    resource_kind: "hosting",
    mode: "provisioned",
    status: "failed",
    external_ref: { render_service_id: "srv-1" },
    ...over,
  };
}

describe("enabled() — reaper is ON by default with a kill-switch", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.INFRA_REAPER_ENABLED;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.INFRA_REAPER_ENABLED;
    else process.env.INFRA_REAPER_ENABLED = prev;
  });

  it("is ENABLED by default when the flag is unset (Ravi-authorized default-on)", () => {
    delete process.env.INFRA_REAPER_ENABLED;
    expect(enabled()).toBe(true);
  });

  it("stays ENABLED for the legacy '1' opt-in value", () => {
    process.env.INFRA_REAPER_ENABLED = "1";
    expect(enabled()).toBe(true);
  });

  it("stays ENABLED for any non-'0' value (e.g. 'true', whitespace)", () => {
    process.env.INFRA_REAPER_ENABLED = "true";
    expect(enabled()).toBe(true);
  });

  it("KILL-SWITCH: INFRA_REAPER_ENABLED='0' forces DRY-RUN (disabled)", () => {
    process.env.INFRA_REAPER_ENABLED = "0";
    expect(enabled()).toBe(false);
  });

  it("KILL-SWITCH: INFRA_REAPER_ENABLED='false' (any case) forces DRY-RUN too", () => {
    process.env.INFRA_REAPER_ENABLED = "false";
    expect(enabled()).toBe(false);
    process.env.INFRA_REAPER_ENABLED = " False ";
    expect(enabled()).toBe(false);
  });
});

describe("isBuildRepo", () => {
  it("matches the umbrella build org (case-insensitive)", () => {
    expect(isBuildRepo("praxis-built/acme")).toBe(true);
    expect(isBuildRepo("Praxis-build/acme")).toBe(true);
  });
  it("rejects a customer's connected repo + junk", () => {
    expect(isBuildRepo("acme-corp/their-app")).toBe(false);
    expect(isBuildRepo("")).toBe(false);
    expect(isBuildRepo(null)).toBe(false);
  });
});

describe("decideSandboxReap", () => {
  it("REAPS a stale paused build sandbox owned by a dead tenant", () => {
    const d = decideSandboxReap(sboxRow({ status: "paused" }), false, null, NOW);
    expect(d.reap).toBe(true);
    expect(d.reason).toContain("stale_paused");
  });

  it("REAPS a stale failed build sandbox of a throwaway tenant", () => {
    const d = decideSandboxReap(sboxRow({ status: "failed" }), true, "bv3-human-x", NOW);
    expect(d.reap).toBe(true);
    expect(d.reason).toContain("throwaway_tenant");
  });

  it("does NOT reap a LIVE non-throwaway customer's sandbox even if stale+paused (guard)", () => {
    const d = decideSandboxReap(sboxRow({ status: "paused" }), true, "upcar-ai", NOW);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("protected_live_customer");
  });

  it("does NOT reap a fresh paused sandbox (not stale enough)", () => {
    const d = decideSandboxReap(sboxRow({ status: "paused", updated_at: fresh }), false, null, NOW);
    expect(d.reap).toBe(false);
    expect(d.reason).toContain("not_stale");
  });

  it("does NOT reap an active/creating sandbox (run may be in flight)", () => {
    expect(decideSandboxReap(sboxRow({ status: "active" }), false, null, NOW).reap).toBe(false);
    expect(decideSandboxReap(sboxRow({ status: "creating" }), false, null, NOW).reap).toBe(false);
  });

  it("does NOT reap a non-build (customer-connected) repo sandbox", () => {
    const d = decideSandboxReap(sboxRow({ repo_full_name: "acme/app", status: "paused" }), false, null, NOW);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("not_a_build_repo");
  });

  it("best-effort kills a destroyed row that still has a lingering e2b id", () => {
    const d = decideSandboxReap(sboxRow({ status: "destroyed", e2b_sandbox_id: "sbx-leak" }), false, null, NOW);
    expect(d.reap).toBe(true);
    expect(d.reason).toContain("destroyed_row");
  });
});

describe("decideOrphanSandbox", () => {
  function listed(over: Partial<ListedSandbox>): ListedSandbox {
    return {
      sandbox_id: "sbx-orphan",
      state: "paused",
      started_at: new Date(NOW - 5 * DAY),
      metadata: { product: "praxis", repo: "praxis-built/acme-abc" },
      ...over,
    };
  }

  it("REAPS a leaked site-gate runner sandbox only once it is older than any gate run", () => {
    const meta = { product: "praxis", repo: "site-gate:site-1" };
    expect(decideOrphanSandbox(listed({ metadata: meta, started_at: new Date(NOW - 60 * 60 * 1000) }), new Set(), NOW)).toMatchObject({ reap: true, reason: "orphan_site_gate" });
    expect(decideOrphanSandbox(listed({ metadata: meta, started_at: new Date(NOW - 2 * 60 * 1000) }), new Set(), NOW)).toMatchObject({ reap: false, reason: "site_gate_in_flight" });
  });

  it("REAPS a build sandbox with no DB row (the 60-leaked-sandbox case)", () => {
    const d = decideOrphanSandbox(listed({}), new Set<string>());
    expect(d.reap).toBe(true);
    expect(d.reason).toBe("orphan_no_db_row");
  });

  it("REAPS a bare sandbox with no repo metadata (created but never got a row)", () => {
    const d = decideOrphanSandbox(listed({ metadata: { product: "praxis" } }), new Set<string>());
    expect(d.reap).toBe(true);
  });

  it("does NOT reap a sandbox the DB still tracks", () => {
    const d = decideOrphanSandbox(listed({ sandbox_id: "sbx-tracked" }), new Set(["sbx-tracked"]));
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("tracked_by_db");
  });

  it("does NOT reap a sandbox tagged with a customer's connected repo", () => {
    const d = decideOrphanSandbox(listed({ metadata: { product: "praxis", repo: "acme/their-app" } }), new Set<string>());
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("connected_repo");
  });
});

describe("decideInfraReap", () => {
  it("REAPS failed-build infra (Render service of a failed build) — dead tenant", () => {
    const d = decideInfraReap(infraRow({ status: "failed" }), false, null, true);
    expect(d.reap).toBe(true);
    expect(d.reason).toContain("failed");
  });

  it("REAPS failed-build infra on a throwaway tenant", () => {
    const d = decideInfraReap(infraRow({ status: "failed" }), true, "bv3-x", true);
    expect(d.reap).toBe(true);
  });

  it("does NOT tear down a READY resource owned by a LIVE non-throwaway customer (guard)", () => {
    const d = decideInfraReap(infraRow({ status: "ready" }), true, "upcar-ai", false);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("protected_live_customer");
  });

  it("does NOT tear down a live customer's resource even if their tenant is quiet (abandoned but alive+real)", () => {
    const d = decideInfraReap(infraRow({ status: "ready" }), true, "upcar-ai", true);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("protected_live_customer");
  });

  it("REAPS any standing resource of a hard-deleted tenant regardless of status", () => {
    const d = decideInfraReap(infraRow({ status: "ready" }), false, null, true);
    expect(d.reap).toBe(true);
    expect(d.reason).toBe("tenant_deleted");
  });

  it("REAPS an orphaned (no-tenant) provisioned resource", () => {
    const d = decideInfraReap(infraRow({ tenant_id: null, status: "ready" }), false, null, true);
    expect(d.reap).toBe(true);
    expect(d.reason).toBe("orphaned_no_tenant");
  });

  it("tears down a throwaway tenant's READY resource only once it's abandoned", () => {
    expect(decideInfraReap(infraRow({ status: "ready" }), true, "qa-foo", true).reap).toBe(true);
    expect(decideInfraReap(infraRow({ status: "ready" }), true, "qa-foo", false).reap).toBe(false);
  });

  it("is idempotent — already torn_down → no-op", () => {
    const d = decideInfraReap(infraRow({ status: "torn_down" }), false, null, true);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("already_torn_down");
  });

  it("never touches connected-mode resources (customer's own account)", () => {
    const d = decideInfraReap(infraRow({ mode: "connected", status: "failed" }), false, null, true);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("connected_mode");
  });
});

describe("ownership guard holds under default-on (flag changes nothing about eligibility)", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.INFRA_REAPER_ENABLED;
    delete process.env.INFRA_REAPER_ENABLED;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.INFRA_REAPER_ENABLED;
    else process.env.INFRA_REAPER_ENABLED = prev;
  });

  it("default-on, yet a LIVE non-throwaway customer's stale sandbox is STILL protected", () => {
    expect(enabled()).toBe(true);
    const d = decideSandboxReap(sboxRow({ status: "paused" }), true, "upcar-ai", NOW);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("protected_live_customer");
  });

  it("default-on, yet a LIVE customer's READY provisioned resource is STILL protected", () => {
    expect(enabled()).toBe(true);
    const d = decideInfraReap(infraRow({ status: "ready" }), true, "upcar-ai", false);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("protected_live_customer");
  });

  it("default-on, yet a LIVE customer's quiet (abandoned-but-alive+real) resource is STILL protected", () => {
    expect(enabled()).toBe(true);
    const d = decideInfraReap(infraRow({ status: "ready" }), true, "upcar-ai", true);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("protected_live_customer");
  });
});

describe("mergeTeardownRef", () => {
  it("merges sibling refs (hosting service id) so domain teardown has its dep, row ref wins on conflict", () => {
    const row = infraRow({ resource_kind: "domain", external_ref: { custom_domain_id: "cd-1" } });
    const merged = mergeTeardownRef(row, { render_service_id: "srv-9" });
    expect(merged).toEqual({ render_service_id: "srv-9", custom_domain_id: "cd-1" });
  });
});

describe("decidePreviewIdleReap", () => {
  const MIN = 60 * 1000;
  const idle = new Date(NOW - (PREVIEW_IDLE_MIN + 1) * MIN).toISOString();
  const recent = new Date(NOW - 2 * MIN).toISOString();

  it("reaps a live preview not viewed for > 15 min", () => {
    const d = decidePreviewIdleReap(
      sboxRow({ status: "active", preview_status: "live", preview_last_viewed_at: idle }),
      NOW,
    );
    expect(d.reap).toBe(true);
    expect(d.reason).toMatch(/preview_idle_15min/);
  });

  it("KEEPS a live preview viewed 2 min ago (still being watched)", () => {
    const d = decidePreviewIdleReap(
      sboxRow({ status: "active", preview_status: "live", preview_last_viewed_at: recent }),
      NOW,
    );
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("preview_viewed_recently");
  });

  it("NEVER reaps a non-preview active sandbox (a live run, preview_status null)", () => {
    const d = decidePreviewIdleReap(
      sboxRow({ status: "active", preview_status: null, preview_last_viewed_at: null, updated_at: idle }),
      NOW,
    );
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("not_a_live_preview");
  });

  it("does not reap a 'starting' (not-yet-live) preview", () => {
    const d = decidePreviewIdleReap(
      sboxRow({ status: "active", preview_status: "starting", preview_last_viewed_at: idle }),
      NOW,
    );
    expect(d.reap).toBe(false);
  });

  it("falls back to updated_at when last_viewed_at is null (idle anchor floor)", () => {
    const d = decidePreviewIdleReap(
      sboxRow({ status: "active", preview_status: "live", preview_last_viewed_at: null, updated_at: idle }),
      NOW,
    );
    expect(d.reap).toBe(true);
  });
});

describe("infra-reaper registration", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = "test-key";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = prev;
  });

  it("infraReaperFn is exported in the inngest functions array", async () => {
    const { inngestFunctions } = await import("../index");
    const { infraReaperFn } = await import("../infra-reaper");
    expect(inngestFunctions).toContain(infraReaperFn);
  }, 30_000);
});
