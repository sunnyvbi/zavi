import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  selectMaybe: vi.fn(),
  updateSingle: vi.fn(),
  getSecret: vi.fn(),
}));

vi.mock("@/services/secrets/vault", () => ({ getSecret: mocks.getSecret }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "test_cases") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ limit: mocks.list }),
              maybeSingle: mocks.selectMaybe,
            }),
          }),
          update: () => ({
            eq: () => ({ select: () => ({ single: mocks.updateSingle }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import {
  qaListActiveTests,
  qaRecordTestOutcome,
  qaGetRuntimeConfig,
  callQaEngineerTool,
} from "../qa-engineer";

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
});

const TEST_UUID = "00000000-0000-0000-0000-000000000001";

describe("qaListActiveTests", () => {
  it("filters by tenant + status='active', returns classification fields", async () => {
    mocks.list.mockResolvedValueOnce({
      data: [
        {
          id: "tc-1",
          title: "x",
          role: "guest",
          nl_spec: {},
          cached_steps_jsonb: null,
          last_status: "passed",
          consecutive_red: 0,
        },
      ],
      error: null,
    });
    const rows = await qaListActiveTests(
      { tenant_id: "tnt-1", run_id: "r-1", agent_slug: "qa-engineer-weekly" },
      { limit: 15 },
    );
    expect(rows[0].last_status).toBe("passed");
    expect(rows[0].consecutive_red).toBe(0);
  });

  it("accepts qa (Modes A+C) as caller", async () => {
    mocks.list.mockResolvedValueOnce({ data: [], error: null });
    await qaListActiveTests(
      { tenant_id: "tnt-1", run_id: "r-1", agent_slug: "qa" },
      { limit: 15 },
    );
    expect(mocks.list).toHaveBeenCalled();
  });

  it("rejects cross-family agent_slug", async () => {
    await expect(
      qaListActiveTests(
        { tenant_id: "tnt-1", run_id: "r-1", agent_slug: "engineer" },
        { limit: 15 },
      ),
    ).rejects.toThrow(/not qa family/);
  });
});

describe("qaRecordTestOutcome state machine", () => {
  const ctx = {
    tenant_id: "tnt-1",
    run_id: "r-1",
    agent_slug: "qa-engineer-weekly" as const,
  };

  it("auto-mutes at consecutive_red=3 (failed bumps 2→3)", async () => {
    mocks.selectMaybe.mockResolvedValueOnce({
      data: {
        id: "tc-1",
        status: "active",
        consecutive_red: 2,
        tenant_id: "tnt-1",
      },
      error: null,
    });
    mocks.updateSingle.mockResolvedValueOnce({
      data: {
        id: "tc-1",
        status: "muted",
        last_status: "failed",
        consecutive_red: 3,
      },
      error: null,
    });
    const out = await qaRecordTestOutcome(ctx, {
      test_case_id: TEST_UUID,
      status: "failed",
      unmute: false,
    });
    expect(out.status).toBe("muted");
    expect(out.consecutive_red).toBe(3);
  });

  it("non-active row + pass + no unmute → stays non-active", async () => {
    mocks.selectMaybe.mockResolvedValueOnce({
      data: {
        id: "tc-2",
        status: "muted",
        consecutive_red: 3,
        tenant_id: "tnt-1",
      },
      error: null,
    });
    mocks.updateSingle.mockResolvedValueOnce({
      data: {
        id: "tc-2",
        status: "muted",
        last_status: "passed",
        consecutive_red: 0,
      },
      error: null,
    });
    const out = await qaRecordTestOutcome(ctx, {
      test_case_id: TEST_UUID,
      status: "passed",
      unmute: false,
    });
    expect(out.status).toBe("muted");
    expect(out.consecutive_red).toBe(0);
  });

  it("unmute=true + pass + muted → flips to active", async () => {
    mocks.selectMaybe.mockResolvedValueOnce({
      data: {
        id: "tc-3",
        status: "muted",
        consecutive_red: 3,
        tenant_id: "tnt-1",
      },
      error: null,
    });
    mocks.updateSingle.mockResolvedValueOnce({
      data: {
        id: "tc-3",
        status: "active",
        last_status: "passed",
        consecutive_red: 0,
      },
      error: null,
    });
    const out = await qaRecordTestOutcome(ctx, {
      test_case_id: TEST_UUID,
      status: "passed",
      unmute: true,
    });
    expect(out.status).toBe("active");
  });

  it("rejects healed without cache (zod refine)", async () => {
    const r = await callQaEngineerTool(ctx, "record_test_outcome", {
      test_case_id: TEST_UUID,
      status: "healed",
    });
    expect(r.ok).toBe(false);
    expect(r.is_error).toBe(true);
  });

  it("rejects cache without healed/passed (zod refine)", async () => {
    const r = await callQaEngineerTool(ctx, "record_test_outcome", {
      test_case_id: TEST_UUID,
      status: "failed",
      new_cached_steps_jsonb: [],
    });
    expect(r.ok).toBe(false);
    expect(r.is_error).toBe(true);
  });

  it("allows cache on passed (first-run seed)", async () => {
    mocks.selectMaybe.mockResolvedValueOnce({
      data: {
        id: "tc-4",
        status: "active",
        consecutive_red: 0,
        tenant_id: "tnt-1",
      },
      error: null,
    });
    mocks.updateSingle.mockResolvedValueOnce({
      data: {
        id: "tc-4",
        status: "active",
        last_status: "passed",
        consecutive_red: 0,
      },
      error: null,
    });
    await qaRecordTestOutcome(ctx, {
      test_case_id: TEST_UUID,
      status: "passed",
      new_cached_steps_jsonb: [{ op: "nav", url: "x" }],
      unmute: false,
    });
    expect(mocks.updateSingle).toHaveBeenCalled();
  });

  it("cross-tenant guard", async () => {
    mocks.selectMaybe.mockResolvedValueOnce({
      data: {
        id: "tc-5",
        status: "active",
        consecutive_red: 0,
        tenant_id: "OTHER",
      },
      error: null,
    });
    await expect(
      qaRecordTestOutcome(ctx, {
        test_case_id: TEST_UUID,
        status: "passed",
        unmute: false,
      }),
    ).rejects.toThrow(/different tenant/);
  });
});

describe("qaGetRuntimeConfig", () => {
  const ctx = {
    tenant_id: "tnt-1",
    run_id: "r-1",
    agent_slug: "qa-engineer-weekly" as const,
  };

  it("returns staging_origin parsed from staging_url", async () => {
    mocks.getSecret.mockImplementation(async (_t: string, key: string) => {
      if (key === "qa.staging_url") return "https://staging.example.com/path";
      if (key === "qa.guest.email") return "g@example.com";
      if (key === "qa.guest.password") return "pw";
      throw new Error("missing");
    });
    const cfg = await qaGetRuntimeConfig(ctx);
    expect(cfg.staging_origin).toBe("https://staging.example.com");
    expect(cfg.has_host_creds).toBe(false);
  });

  it("flags has_host_creds when both host secrets present", async () => {
    mocks.getSecret.mockImplementation(async (_t: string, key: string) => {
      if (key === "qa.staging_url") return "https://staging.example.com";
      if (key === "qa.guest.email") return "g@example.com";
      if (key === "qa.guest.password") return "pw";
      if (key === "qa.host.email") return "h@example.com";
      if (key === "qa.host.password") return "hpw";
      throw new Error("missing");
    });
    const cfg = await qaGetRuntimeConfig(ctx);
    expect(cfg.has_host_creds).toBe(true);
    expect(cfg.host_email).toBe("h@example.com");
  });

  it("rejects cross-family agent_slug", async () => {
    await expect(
      qaGetRuntimeConfig({
        tenant_id: "t",
        run_id: "r",
        agent_slug: "engineer",
      }),
    ).rejects.toThrow(/not qa family/);
  });
});
