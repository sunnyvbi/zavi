import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  from: vi.fn(),
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  data: {} as Record<string, unknown[]>,
  failed: "",
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: h.auth }));
vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({ from: h.from }),
}));
vi.mock("@/services/tenants/new-tenant-alert", () => ({
  DOGFOOD_SLUGS: new Set(["upcar-ai", "upcar-private", "apna-tutor-dogfood"]),
}));
vi.mock("@/services/memory", () => ({ listNotes: vi.fn() }));
import { staffSignupCreditCosts } from "../signup-credit-costs";
const response = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  vi.clearAllMocks();
  h.calls = [];
  h.failed = "";
  h.data = {
    tenants: [
      {
        id: "real",
        kind: "real",
        slug: "customer",
        created_at: "2026-11-01T00:00:00Z",
      },
      {
        id: "test",
        kind: "test",
        slug: "qa",
        created_at: "2026-11-01T00:00:00Z",
      },
      {
        id: "internal",
        kind: "real",
        slug: "upcar-ai",
        created_at: "2026-11-01T00:00:00Z",
      },
      {
        id: "shell",
        kind: "launch_video_shell",
        slug: "lv-shell",
        created_at: "2026-11-01T00:00:00Z",
      },
    ],
    tenant_app_setting: [
      { tenant_id: "real", value: { from: "filter-coffee" } },
    ],
    agent_runs: [],
    agent_feedback: [],
  };
  h.from.mockImplementation((table: string) => {
    const filters: Array<(row: Record<string, any>) => boolean> = [];
    const chain: Record<string, (...args: any[]) => any> = {};
    for (const op of ["select", "gte", "lt", "order", "eq", "not", "in"])
      chain[op] = (...args: unknown[]) => {
        h.calls.push({ table, op, args });
        const column = args[0] as string;
        if (op === "eq") filters.push((row) => row[column] === args[1]);
        if (op === "in")
          filters.push((row) => (args[1] as string[]).includes(row[column]));
        if (op === "gte")
          filters.push((row) => row[column] >= (args[1] as string));
        if (op === "lt")
          filters.push((row) => row[column] < (args[1] as string));
        return chain;
      };
    chain.range = async (from: number, to: number) => {
      h.calls.push({ table, op: "range", args: [from, to] });
      let rows = h.data[table] ?? [];
      rows = rows.filter((r) =>
        filters.every((filter) => filter(r as Record<string, any>)),
      );
      return {
        data: rows.slice(from, to + 1),
        error: h.failed === table ? { message: "unavailable" } : null,
      };
    };
    return chain;
  });
});
afterEach(() => {
  vi.useRealTimers();
});

it("preserves the staff gate before any database reads", async () => {
  h.auth.mockImplementationOnce(() => {
    throw Error("forbidden");
  });
  await expect(
    staffSignupCreditCosts(
      { query: {} } as Request,
      response() as unknown as Response,
    ),
  ).rejects.toThrow("forbidden");
  expect(h.from).not.toHaveBeenCalled();
});
it("bounds all child reads to the eligible tenants and keeps the 14 UTC calendar days", async () => {
  const res = response();
  await staffSignupCreditCosts(
    { query: {} } as Request,
    res as unknown as Response,
  );
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      since: "2026-10-22T00:00:00.000Z",
      until: "2026-11-04T12:00:00.000Z",
      excluded: 3,
      credits: 0,
    }),
  );
  for (const table of [
    "agent_runs",
    "tenant_app_setting",
    "setup_draft_refunds",
    "conductor_runs",
  ])
    expect(h.calls).toContainEqual({
      table,
      op: "in",
      args: ["tenant_id", ["real"]],
    });
  expect(h.calls).toContainEqual({
    table: "conductor_runs",
    op: "eq",
    args: ["credits_waived", true],
  });
});
it("does not publish partial totals when subsidy evidence is unavailable", async () => {
  h.failed = "setup_draft_refunds";
  const res = response();
  await staffSignupCreditCosts(
    { query: {} } as Request,
    res as unknown as Response,
  );
  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({
    error: {
      code: "signup_credit_costs_read_failed",
      message: expect.any(String),
    },
  });
});
it("uses a shell claim date and reads older claimed tenants with a bounded id filter", async () => {
  h.data.tenants = [
    {
      id: "old",
      created_at: "2026-09-01T00:00:00Z",
      kind: "real",
      product_url: { marketing: "https://customer.zaviagent.com" },
    },
  ];
  h.data.launch_video_public_jobs = [
    { tenant_id: "old", claimed_at: "2026-11-01T00:00:00Z" },
  ];
  h.data.agent_runs = [
    {
      id: "r",
      tenant_id: "old",
      agent_slug: "seo",
      trigger: "channel_recipe",
      enqueued_by: null,
      cron_dedupe_key: "first-run-preview:old:seo",
      status: "success",
      enqueued_at: "2026-11-02T00:00:00Z",
      finished_at: "2026-11-02T00:01:00Z",
      cost_usd: 1,
      build_id: null,
    },
  ];
  const res = response();
  await staffSignupCreditCosts(
    { query: {} } as Request,
    res as unknown as Response,
  );
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ workspaces: 1, credits: 400 }),
  );
  expect(h.calls).toContainEqual({
    table: "tenants",
    op: "in",
    args: ["id", ["old"]],
  });
});
it("paginates rather than silently truncating the signup cohort", async () => {
  h.data.tenants = Array.from({ length: 501 }, (_, i) => ({
    id: `t${i}`,
    kind: "real",
    created_at: "2026-11-01T00:00:00Z",
  }));
  const res = response();
  await staffSignupCreditCosts(
    { query: {} } as Request,
    res as unknown as Response,
  );
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ workspaces: 501 }),
  );
  expect(h.calls).toContainEqual({
    table: "tenants",
    op: "range",
    args: [500, 999],
  });
});
