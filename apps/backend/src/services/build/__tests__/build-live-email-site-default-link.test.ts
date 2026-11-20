
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSb } from "@/services/agents/__tests__/fake-sb";
import { fakeSiteStore, siteRow, T1 } from "@/services/sites/__tests__/fake-site-store";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  send: vi.fn(async (_a: { ownerLogin?: { email: string; mint: () => Promise<string> } | null }) => ({ sent: true })),
  mint: vi.fn(async () => "https://ref.supabase.co/verify?token=fresh"),
  wired: true,
  store: null as unknown,
}));
vi.mock("@/services/tenant-client", () => ({ tenantClient: () => fakeSb(h.tables), asTenantId: (t: string) => t }));
vi.mock("@/email/sendAuthEmail", () => ({ sendBuildLiveEmail: h.send }));
vi.mock("@/services/web-base", () => ({ webBaseUrl: () => "https://www.zaviagent.com" }));
vi.mock("@/services/sites/store", () => ({ siteStore: () => h.store }));
vi.mock("@/services/sites/wiring", () => ({ siteOwnerMagicLink: () => (h.wired ? h.mint : null) }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async (key: string) => key === "build_auto_site_owner") }));

import { maybeSendBuildLiveEmail } from "../build-live-email";

const A = "aaaaaaaa-0000-4000-8000-000000000001";

describe("site live email, worker call with no deps", () => {
  beforeEach(() => {
    h.send.mockClear();
    h.mint.mockClear();
    h.wired = true;
    h.tables = {
      conductor_runs: [
        {
          id: "run-a", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Alpha — x",
          goal_graph: [{ id: "d", status: "done", hosting_verified_at: "2026-09-30T01:00:00Z", payload: { stage: "deploy", site_id: A } }],
        },
      ],
    };
    h.store = fakeSiteStore([
      siteRow({ id: A, label: "alpha", root_conductor_run_id: "run-a", status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com" }),
    ]).store;
  });

  it("includes the sign-in line, minted by the wired provisioner at send time", async () => {
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" })).toEqual({ sent: true });
    const login = h.send.mock.calls[0][0].ownerLogin!;
    expect(login.email).toBe("owner@example.test");
    expect(h.mint).not.toHaveBeenCalled();
    expect(await login.mint()).toBe("https://ref.supabase.co/verify?token=fresh");
    expect(h.mint).toHaveBeenCalledWith({
      tenant_id: T1,
      site_id: A,
      owner_email: "owner@example.test",
      redirect_to: "https://alpha.zaviagent.com/admin",
    });
  });

  it("with no provisioner wired the mail still goes, without a sign-in line", async () => {
    h.wired = false;
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0].ownerLogin).toBeUndefined();
  });
});
