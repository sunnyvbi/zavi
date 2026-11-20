
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(),
}));

import { serviceClient } from "@/services/supabase";
import { resolveTargetSlackWorkspace } from "../resolve-target-workspace";

const mockedServiceClient = serviceClient as unknown as ReturnType<typeof vi.fn>;
const TENANT = "00000000-0000-0000-0000-0000000000aa";

type Row = { team_id: string; label: string; is_primary?: boolean };

function clientReturning(resolver: (filters: Record<string, string>) => Row | null) {
  return {
    from: vi.fn(() => {
      const filters: Record<string, string> = {};
      const builder: Record<string, unknown> = {};
      builder.select = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => builder);
      builder.eq = vi.fn((col: string, val: string) => {
        filters[col] = val;
        return builder;
      });
      builder.maybeSingle = vi.fn(async () => ({
        data: resolver(filters),
        error: null,
      }));
      return builder;
    }),
  };
}

beforeEach(() => {
  mockedServiceClient.mockReset();
});

describe("resolveTargetSlackWorkspace", () => {
  it("(1) inbound: returns the SOURCE workspace when it belongs to the tenant", async () => {
    mockedServiceClient.mockReturnValue(
      clientReturning((f) =>
        f.team_id === "TSOURCE" ? { team_id: "TSOURCE", label: "Support" } : null,
      ),
    );
    const r = await resolveTargetSlackWorkspace(TENANT, "engineer", "TSOURCE");
    expect(r).toEqual({ team_id: "TSOURCE", label: "Support", reason: "source" });
  });

  it("(2a) proactive: returns the workspace whose default_agent_slug == this agent", async () => {
    mockedServiceClient.mockReturnValue(
      clientReturning((f) =>
        f.default_agent_slug === "support-lead"
          ? { team_id: "TDEV", label: "Dev" }
          : null,
      ),
    );
    const r = await resolveTargetSlackWorkspace(TENANT, "support-lead", undefined);
    expect(r).toMatchObject({ team_id: "TDEV", reason: "agent_default" });
  });

  it("(2b) proactive: falls back to primary/oldest when no agent-default workspace", async () => {
    mockedServiceClient.mockReturnValue(
      clientReturning((f) => {
        if (f.default_agent_slug) return null;
        return { team_id: "TPRIMARY", label: "Main", is_primary: true };
      }),
    );
    const r = await resolveTargetSlackWorkspace(TENANT, "engineer", undefined);
    expect(r).toMatchObject({ team_id: "TPRIMARY", reason: "primary" });
  });

  it("FAILS CLOSED (null) when an inbound source does NOT belong to the tenant — never re-routes to a different workspace", async () => {
    mockedServiceClient.mockReturnValue(
      clientReturning((f) => {
        if (f.team_id === "TFOREIGN") return null;
        if (f.default_agent_slug) return null;
        return { team_id: "TPRIMARY", label: "Main", is_primary: true };
      }),
    );
    const r = await resolveTargetSlackWorkspace(TENANT, "engineer", "TFOREIGN");
    expect(r).toBeNull();
  });

  it("returns null when the tenant has no Slack workspace at all", async () => {
    mockedServiceClient.mockReturnValue(clientReturning(() => null));
    const r = await resolveTargetSlackWorkspace(TENANT, "engineer", undefined);
    expect(r).toBeNull();
  });
});
