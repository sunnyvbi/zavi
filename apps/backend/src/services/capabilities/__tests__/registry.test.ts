
import { describe, it, expect, vi, beforeEach } from "vitest";

const supabaseMock = vi.fn();
vi.mock("@/services/supabase", () => ({
  serviceClient: () => supabaseMock(),
}));

import { isToolAllowed } from "../registry";

const TENANT = "11111111-1111-1111-1111-111111111111";

function mkSelect(rows: Array<{ agent_slug: string; reason: string | null }>) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            in: () => ({
              limit: async () => ({ data: rows, error: null }),
            }),
          }),
        }),
      }),
    }),
  };
}

function mkError(message: string) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            in: () => ({
              limit: async () => ({ data: null, error: { message } }),
            }),
          }),
        }),
      }),
    }),
  };
}

describe("isToolAllowed", () => {
  beforeEach(() => {
    supabaseMock.mockReset();
  });

  it("returns allowed:true when no deny row matches (default-allow)", async () => {
    supabaseMock.mockReturnValue(mkSelect([]));
    const out = await isToolAllowed(TENANT, "chief-of-staff", "web_search__search");
    expect(out).toEqual({ allowed: true });
  });

  it("returns allowed:false with reason when an agent-specific deny matches", async () => {
    supabaseMock.mockReturnValue(
      mkSelect([{ agent_slug: "chief-of-staff", reason: "compliance hold" }]),
    );
    const out = await isToolAllowed(TENANT, "chief-of-staff", "web_search__search");
    expect(out.allowed).toBe(false);
    if (!out.allowed) {
      expect(out.reason).toMatch(/compliance hold/);
      expect(out.reason).toMatch(/chief-of-staff/);
    }
  });

  it("returns allowed:false when a tenant-wide deny (agent_slug='') matches", async () => {
    supabaseMock.mockReturnValue(
      mkSelect([{ agent_slug: "", reason: "tenant in audit mode" }]),
    );
    const out = await isToolAllowed(TENANT, "chief-of-staff", "web_search__search");
    expect(out.allowed).toBe(false);
    if (!out.allowed) {
      expect(out.reason).toMatch(/audit mode/);
      expect(out.reason).toMatch(/tenant-wide/);
    }
  });

  it("synthesizes a generic reason when row.reason is null", async () => {
    supabaseMock.mockReturnValue(
      mkSelect([{ agent_slug: "chief-of-staff", reason: null }]),
    );
    const out = await isToolAllowed(TENANT, "chief-of-staff", "web_search__search");
    expect(out.allowed).toBe(false);
    if (!out.allowed) {
      expect(out.reason).toMatch(/denied by tenant policy/);
    }
  });

  it("fails open on a DB error (allowed:true, logs warning)", async () => {
    supabaseMock.mockReturnValue(mkError("connection reset"));
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await isToolAllowed(TENANT, "chief-of-staff", "web_search__search");
    expect(out).toEqual({ allowed: true });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("returns allowed:true when tenant_id or tool_name is missing (defensive)", async () => {
    const a = await isToolAllowed("", "chief-of-staff", "web_search__search");
    const b = await isToolAllowed(TENANT, "chief-of-staff", "");
    expect(a).toEqual({ allowed: true });
    expect(b).toEqual({ allowed: true });
    expect(supabaseMock).not.toHaveBeenCalled();
  });
});
