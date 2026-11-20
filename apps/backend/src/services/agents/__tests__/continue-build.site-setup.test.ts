
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClient: vi.fn(), retrySiteSetup: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));
vi.mock("../start-product-build", () => ({ retrySiteSetup: mocks.retrySiteSetup }));

import { continueBuild, continueRefusal } from "../continue-build";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const setupGraph = (retryable: boolean) => [
  {
    id: "acme-provision",
    status: "failed",
    target_agent_slug: "company-founder",
    payload: {
      stage: "provision",
      site_id: "00000000-0000-4000-8000-0000000000aa",
      site_setup: { v: 1, retryable, company_name: "Acme", idea: "A site", max_usd: 50 },
    },
  },
  { id: "acme-spec", status: "pending", target_agent_slug: "pm", payload: { stage: "spec" } },
];

const row = (retryable: boolean) => ({
  id: "run-1",
  tenant_id: "t1",
  kind: "build_app",
  status: "failed",
  created_at: iso(NOW - 3_600_000),
  updated_at: iso(NOW - 60_000),
  paused_at: null,
  failure_class: "provision_failed",
  goal_graph: setupGraph(retryable),
});

function client(r: Record<string, unknown>, rpc = vi.fn()) {
  return {
    rpc,
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      for (const m of ["eq", "neq", "gt"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: r, error: null });
      q.then = (res: (v: { data: unknown; error: null }) => unknown) => res({ data: [], error: null });
      return q;
    },
  };
}

beforeEach(() => {
  mocks.serviceClient.mockReset();
  mocks.retrySiteSetup.mockReset();
});

describe("continueBuild — a failed site setup", () => {
  it("a retryable setup failure is resumable and goes to retrySiteSetup with the run row, never continue_paused_build", async () => {
    const rpc = vi.fn();
    const r = row(true);
    mocks.serviceClient.mockReturnValue(client(r, rpc));
    mocks.retrySiteSetup.mockResolvedValue({ ok: true, run_id: "run-1" });
    expect(continueRefusal(r, NOW)).toBeNull();
    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: true, run_id: "run-1" });
    expect(mocks.retrySiteSetup).toHaveBeenCalledWith("t1", expect.objectContaining({ id: "run-1", updated_at: r.updated_at }));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes a failed retry's answer through (site_setup_failed)", async () => {
    mocks.serviceClient.mockReturnValue(client(row(true)));
    mocks.retrySiteSetup.mockResolvedValue({ ok: false, code: "site_setup_failed", message: "try again" });
    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: false, code: "site_setup_failed", message: "try again" });
  });

  it("a non-retryable setup failure (dead site) stays not_resumable, so the UI starts a new build", async () => {
    const r = row(false);
    mocks.serviceClient.mockReturnValue(client(r));
    expect(continueRefusal(r, NOW)).toBe("not_resumable");
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code: "not_resumable" });
    expect(mocks.retrySiteSetup).not.toHaveBeenCalled();
  });

  it("a retryable setup failure older than the window is expired", async () => {
    const r = { ...row(true), updated_at: iso(NOW - 8 * 24 * 3_600_000) };
    expect(continueRefusal(r, NOW)).toBe("expired");
  });
});
