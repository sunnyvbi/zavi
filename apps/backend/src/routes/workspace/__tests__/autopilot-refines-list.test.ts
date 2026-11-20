
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  conductorList: vi.fn(),
  agentRunsList: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        const scoped: Record<string, unknown> = { order: () => ({ limit: mocks.conductorList }) };
        scoped.is = () => scoped;
        return { select: () => ({ eq: () => scoped }) };
      }
      if (table === "agent_runs") {
        return {
          select: () => ({
            eq: () => ({
              in: mocks.agentRunsList,
            }),
          }),
        };
      }
      throw new Error(`unexpected table in mock: ${table}`);
    },
  }),
  serviceClient: () => ({}),
}));

import { getAutopilotRefines } from "../autopilot";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function refineRow(opts: {
  id: string;
  objective: string;
  status: string;
  child_run_id?: string | null;
  refine_mode?: boolean;
  created_at?: string;
  preview_url?: string;
}) {
  const goal_graph: Array<Record<string, unknown>> = [
    {
      status: opts.status,
      child_run_id: opts.child_run_id ?? null,
      finished_at: null,
      payload: {
        stage: "build",
        refine_mode: opts.refine_mode ?? true,
        idea: opts.objective,
      },
    },
  ];
  if (opts.preview_url !== undefined) {
    goal_graph.push({
      status: "success",
      child_run_id: null,
      finished_at: null,
      payload: { stage: "refine_gate", preview_url: opts.preview_url },
    });
  }
  return {
    id: opts.id,
    objective: opts.objective,
    status: opts.status,
    goal_graph,
    spend_usd: 0.5,
    max_usd: 5,
    created_at: opts.created_at ?? "2026-05-30T00:00:00Z",
    updated_at: opts.created_at ?? "2026-05-30T00:00:00Z",
  };
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.conductorList.mockReset();
  mocks.agentRunsList.mockReset();
  mocks.requireAuth.mockResolvedValue({
    tenant_id: "tnt-1",
    user_id: "user-1",
    access_token: "tok",
  });
});

describe("getAutopilotRefines", () => {
  it("returns early when requireAuth fails (no DB calls)", async () => {
    mocks.requireAuth.mockResolvedValueOnce(null);
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    expect(mocks.conductorList).not.toHaveBeenCalled();
    expect(mocks.agentRunsList).not.toHaveBeenCalled();
  });

  it("returns empty refines:[] when no rows exist", async () => {
    mocks.conductorList.mockResolvedValueOnce({ data: [], error: null });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ refines: [] });
    expect(mocks.agentRunsList).not.toHaveBeenCalled();
  });

  it("filters conductor_runs to refine_mode=true (skips full builds)", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({ id: "cr_build", objective: "build foo", status: "success", refine_mode: false }),
        refineRow({ id: "cr_refine", objective: "[refine] make header sticky", status: "success" }),
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { refines: Array<{ id: string }> };
    expect(body.refines).toHaveLength(1);
    expect(body.refines[0].id).toBe("cr_refine");
  });

  it("strips the [refine] objective prefix from message text", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [refineRow({ id: "cr1", objective: "[refine] add a delete button", status: "active" })],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    const body = res.body as { refines: Array<{ message: string }> };
    expect(body.refines[0].message).toBe("add a delete button");
  });

  it("joins to agent_runs and extracts <pr_proposal> summary + pr_url", async () => {
    const envelope = `<pr_proposal>${JSON.stringify({
      summary: "Made the header sticky in app/layout.tsx",
      pr_url: "https://github.com/praxis-built/acme/commit/abc123",
    })}</pr_proposal>`;
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({
          id: "cr1",
          objective: "[refine] make header sticky",
          status: "success",
          child_run_id: "ar_1",
        }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: [
        {
          id: "ar_1",
          status: "success",
          finished_at: "2026-05-30T00:05:00Z",
          output_text: envelope,
        },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      refines: Array<{
        message: string;
        summary: string | null;
        pr_url: string | null;
        finished_at: string | null;
      }>;
    };
    expect(body.refines[0].summary).toBe("Made the header sticky in app/layout.tsx");
    expect(body.refines[0].pr_url).toBe(
      "https://github.com/praxis-built/acme/commit/abc123",
    );
    expect(body.refines[0].finished_at).toBe("2026-05-30T00:05:00Z");
  });

  it("DEL-686: surfaces the engineer's no-ship deliverable on a halted refine", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({
          id: "cr_halt",
          objective: "[refine] update the signin label",
          status: "halted",
          child_run_id: "ar_halt",
        }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: [
        {
          id: "ar_halt",
          status: "parse_failed",
          finished_at: "2026-07-07T04:57:32Z",
          output_text:
            "I prepared the change in the sandbox but couldn't push the review branch. This is a platform-side issue worth reporting; nothing shipped.",
          parsed: null,
          outcome: {
            deliverable:
              "I prepared the change in the sandbox but couldn't push the review branch. This is a platform-side issue worth reporting; nothing shipped.",
            side_effect: { kind: "refused", reason: "defer_pr_push_failed" },
          },
        },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      refines: Array<{ failure_message: string | null; no_ship_reason: string | null }>;
    };
    expect(body.refines[0].failure_message).toMatch(/couldn't push the review branch/);
    expect(body.refines[0].no_ship_reason).toBe("defer_pr_push_failed");
  });

  it("DEL-686: no failure_message on a shipped ('done') refine", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({
          id: "cr_done",
          objective: "[refine] make header sticky",
          status: "done",
          child_run_id: "ar_done",
        }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: [
        {
          id: "ar_done",
          status: "success",
          finished_at: "2026-05-30T00:05:00Z",
          output_text: `<pr_proposal>${JSON.stringify({ summary: "did it" })}</pr_proposal>`,
          parsed: null,
          outcome: { deliverable: "Made the header sticky.", side_effect: { kind: "shipped" } },
        },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    const body = res.body as { refines: Array<{ failure_message: string | null }> };
    expect(body.refines[0].failure_message).toBeNull();
  });

  it("clamps limit query to [1, 25] (default 5)", async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      refineRow({
        id: `cr_${i}`,
        objective: `[refine] turn ${i}`,
        status: "success",
      }),
    );
    mocks.conductorList.mockResolvedValueOnce({ data: rows, error: null });
    const res = mockRes();
    await getAutopilotRefines({ query: { limit: "100" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { refines: unknown[] };
    expect(body.refines.length).toBeLessThanOrEqual(25);
  });

  it("500s when conductor_runs read errors", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: null,
      error: { message: "boom" },
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "refines_list_failed",
    );
  });

  it("tolerates a missing <pr_proposal> envelope (summary=null, pr_url=null)", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({
          id: "cr1",
          objective: "[refine] do stuff",
          status: "active",
          child_run_id: "ar_1",
        }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: [
        {
          id: "ar_1",
          status: "active",
          finished_at: null,
          output_text: null,
        },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      refines: Array<{ summary: string | null; pr_url: string | null }>;
    };
    expect(body.refines[0].summary).toBeNull();
    expect(body.refines[0].pr_url).toBeNull();
  });

  it("extracts the changed-file list (path + action) from <pr_proposal> (Gap #2)", async () => {
    const envelope = `<pr_proposal>${JSON.stringify({
      summary: "Added a contact field to the signup form",
      files: [
        { path: "app/signup/page.tsx", action: "modify", content: "…", diff: "@@" },
        { path: "app/lib/contact.ts", action: "create", content: "…" },
        { path: "app/old.ts", action: "delete" },
        { path: "", action: "modify" },
        { action: "modify" },
      ],
    })}</pr_proposal>`;
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({
          id: "cr1",
          objective: "[refine] add a contact field",
          status: "success",
          child_run_id: "ar_1",
        }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: [
        {
          id: "ar_1",
          status: "success",
          finished_at: "2026-05-30T00:05:00Z",
          output_text: envelope,
        },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      refines: Array<{ files: Array<{ path: string; action: string }> }>;
    };
    expect(body.refines[0].files).toEqual([
      { path: "app/signup/page.tsx", action: "modify" },
      { path: "app/lib/contact.ts", action: "create" },
      { path: "app/old.ts", action: "delete" },
    ]);
  });

  it("C4 — surfaces + normalizes parsed.gate_evidence (build/test/preview + verdict)", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({
          id: "cr1",
          objective: "[refine] make header sticky",
          status: "success",
          child_run_id: "ar_1",
        }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: [
        {
          id: "ar_1",
          status: "success",
          finished_at: "2026-05-30T00:05:00Z",
          output_text: null,
          parsed: {
            pr_url: "https://github.com/praxis-built/acme/pull/9",
            gate_evidence: {
              build_ok: true,
              tests: { passed: 7, failed: 0 },
              typecheck_ok: true,
              preview_smoke: { verdict: "pass", evidence_md: "looks good" },
              gate_verdict: "pass",
            },
          },
        },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      refines: Array<{ gate_evidence: Record<string, unknown> | null }>;
    };
    expect(body.refines[0].gate_evidence).toEqual({
      build_ok: true,
      tests: { passed: 7, failed: 0 },
      typecheck_ok: true,
      preview_smoke: { verdict: "pass", evidence_md: "looks good" },
      gate_verdict: "pass",
    });
  });

  it("C4 — surfaces a protected-path gate hold from parsed.gate_evidence", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({
          id: "cr1",
          objective: "[refine] edit auth",
          status: "success",
          child_run_id: "ar_1",
        }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: [
        {
          id: "ar_1",
          status: "success",
          finished_at: null,
          output_text: null,
          parsed: {
            gate_evidence: {
              build_ok: true,
              tests: { passed: 2, failed: 0 },
              typecheck_ok: true,
              preview_smoke: { verdict: "skipped", evidence_md: "" },
              gate_verdict: "fail",
              protected_paths: [
                { path: "apps/backend/src/auth/x.ts", glob: "**/auth/**" },
                { path: "", glob: "bad" },
              ],
            },
          },
        },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    const body = res.body as {
      refines: Array<{ gate_evidence: { gate_verdict: string; protected_paths?: unknown[] } | null }>;
    };
    expect(body.refines[0].gate_evidence?.gate_verdict).toBe("fail");
    expect(body.refines[0].gate_evidence?.protected_paths).toEqual([
      { path: "apps/backend/src/auth/x.ts", glob: "**/auth/**" },
    ]);
  });

  it("C4 — gate_evidence is null when parsed is absent or malformed (defensive)", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({ id: "cr1", objective: "[refine] a", status: "success", child_run_id: "ar_1" }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: [
        {
          id: "ar_1",
          status: "success",
          finished_at: null,
          output_text: null,
          parsed: { gate_evidence: { gate_verdict: "maybe", build_ok: true } },
        },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    const body = res.body as { refines: Array<{ gate_evidence: unknown }> };
    expect(body.refines[0].gate_evidence).toBeNull();
  });

  it("C4 — surfaces preview_url from the refine_gate node payload (else null)", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({
          id: "cr_with",
          objective: "[refine] with preview",
          status: "success",
          preview_url: "https://preview.example.dev/branch-abc",
        }),
        refineRow({
          id: "cr_without",
          objective: "[refine] no preview",
          status: "success",
        }),
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    const body = res.body as {
      refines: Array<{ id: string; preview_url: string | null }>;
    };
    const withPrev = body.refines.find((r) => r.id === "cr_with");
    const without = body.refines.find((r) => r.id === "cr_without");
    expect(withPrev?.preview_url).toBe("https://preview.example.dev/branch-abc");
    expect(without?.preview_url).toBeNull();
  });

  it("exposes the engineer agent run id so the web can poll that run's sandbox preview", async () => {
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({ id: "cr_run", objective: "[refine] add cart", status: "active", child_run_id: "ar_engineer" }),
        refineRow({ id: "cr_queued", objective: "[refine] queued", status: "active" }),
        refineRow({ id: "cr_gate_only", objective: "[refine] gated", status: "success", preview_url: "https://p.example.dev/x" }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValue({ data: [], error: null });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    const byId = new Map(
      (res.body as { refines: Array<{ id: string; engineer_run_id: string | null }> }).refines.map((r) => [
        r.id,
        r.engineer_run_id,
      ]),
    );
    expect(byId.get("cr_run")).toBe("ar_engineer");
    expect(byId.get("cr_queued")).toBeNull();
    expect(byId.get("cr_gate_only")).toBeNull();
  });

  it("returns files:[] when the envelope has no files (no parse, no crash)", async () => {
    const envelope = `<pr_proposal>${JSON.stringify({
      summary: "Tweaked copy",
    })}</pr_proposal>`;
    mocks.conductorList.mockResolvedValueOnce({
      data: [
        refineRow({
          id: "cr1",
          objective: "[refine] tweak copy",
          status: "success",
          child_run_id: "ar_1",
        }),
      ],
      error: null,
    });
    mocks.agentRunsList.mockResolvedValueOnce({
      data: [
        { id: "ar_1", status: "success", finished_at: null, output_text: envelope },
      ],
      error: null,
    });
    const res = mockRes();
    await getAutopilotRefines({ query: {} } as never, res as never);
    const body = res.body as { refines: Array<{ files: unknown[] }> };
    expect(body.refines[0].files).toEqual([]);
  });
});
