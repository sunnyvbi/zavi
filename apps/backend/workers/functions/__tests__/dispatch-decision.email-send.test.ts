
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  emailSendMock: vi.fn(),
  serviceClientMock: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }),
      }),
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  })),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

vi.mock("@/services/tools/email/_client", () => ({
  emailSend: mocks.emailSendMock,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/email-cards/pause", () => ({ emailSendPaused: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/tools/meta-ads/write/_decision-bodies", () => ({ updateAdSetBudgetBodySchema: {}, setStatusBodySchema: {}, createAdSetBodySchema: {} }));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: vi.fn(), getAdAccountCurrency: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_helpers", () => ({ toBudgetMinorUnits: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/_cap-evaluator", async (importOriginal) => ({ ...(await importOriginal<object>()), evaluateBudgetCap: vi.fn() }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: vi.fn() }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(),
  HANDLER_LABELS: {},
}));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";

const mockSend = mocks.emailSendMock;

const baseDecision = {
  id: "d-1",
  tenant_id: "t-1",
  agent_run_id: null,
  decision_class: "generic.email-send",
  body: {
    to: "user@example.com",
    subject: "hi",
    body_text: "body text",
  },
  status: "approved",
  handler: "email.send",
};

beforeEach(() => {
  mockSend.mockReset();
  mocks.serviceClientMock.mockReset();
  mocks.serviceClientMock.mockImplementation(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }),
      }),
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }));
});

function withServiceClient(impl: () => unknown) {
  (mocks.serviceClientMock.mockImplementationOnce as unknown as (i: () => unknown) => unknown)(impl);
}

describe("email.send dispatch handler — core", () => {
  it("golden success → ok + notice", async () => {
    mockSend.mockResolvedValueOnce({ ok: true, messageId: "m-1", statusCode: 202 });
    const h = HANDLERS["email.send"];
    const res = await h(baseDecision);
    expect(res.ok).toBe(true);
    expect(res.notice).toContain("user@example.com");
    expect(mockSend).toHaveBeenCalledWith("t-1", expect.objectContaining({ to: "user@example.com" }));
  });

  it("zod failure on missing `to` → ok:false + body invalid", async () => {
    const h = HANDLERS["email.send"];
    const res = await h({ ...baseDecision, body: { subject: "s", body_text: "b" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/body invalid/i);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("zod failure on malformed `to` → ok:false", async () => {
    const h = HANDLERS["email.send"];
    const res = await h({ ...baseDecision, body: { ...baseDecision.body, to: "not-an-email" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/body invalid/i);
  });

  it("emailSend throws ExpectedToolError → ok:false + error surfaced", async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("SendGrid rejected: 421"), { code: "email_send_failed" }),
    );
    const h = HANDLERS["email.send"];
    const res = await h(baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("SendGrid rejected");
  });

  it("email_not_connected → ok:false + actionable error", async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("Email is not connected for this workspace."), {
        code: "email_not_connected",
      }),
    );
    const h = HANDLERS["email.send"];
    const res = await h(baseDecision);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not connected/i);
  });

  it("legacy gmail.send key routes to same handler", async () => {
    mockSend.mockResolvedValueOnce({ ok: true, messageId: "m-legacy", statusCode: 202 });
    const h = HANDLERS["gmail.send"];
    expect(h).toBe(HANDLERS["email.send"]);
    const res = await h(baseDecision);
    expect(res.ok).toBe(true);
  });
});

describe("email.send dispatch handler — attachments", () => {
  it("attachment success — fetches bytes + threads as base64", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    withServiceClient(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "art-1",
                  tenant_id: "t-1",
                  run_id: null,
                  storage_path: "t-1/run-1/report.pdf",
                  filename: "report.pdf",
                  mime: "application/pdf",
                  bytes: 4,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
      storage: { from: () => ({ download: async () => ({ data: new Blob([bytes]), error: null }) }) },
      rpc: vi.fn(async () => ({ data: null, error: null })),
    }));
    mockSend.mockResolvedValueOnce({ ok: true, messageId: "m-att", statusCode: 202 });
    const res = await HANDLERS["email.send"]({
      ...baseDecision,
      body: { ...baseDecision.body, artifact_id: "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.ok).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      "t-1",
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: "report.pdf",
            type: "application/pdf",
            content: Buffer.from(bytes).toString("base64"),
          }),
        ],
      }),
    );
  });

  it("attachment cross-tenant → refuse (artifact_not_found via .eq tenant_id filter)", async () => {
    withServiceClient(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
      storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) },
      rpc: vi.fn(),
    }));
    const res = await HANDLERS["email.send"]({
      ...baseDecision,
      body: { ...baseDecision.body, artifact_id: "00000000-0000-4000-8000-000000000002" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/artifact_not_found/);
  });

  it("attachment storage_path doesn't start with tenant_id → refuse", async () => {
    withServiceClient(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "art-2b", tenant_id: "t-1", run_id: null, storage_path: "WRONG/file.pdf", filename: "f.pdf", mime: "application/pdf", bytes: 1 },
                error: null,
              }),
            }),
          }),
        }),
      }),
      storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) },
      rpc: vi.fn(),
    }));
    const res = await HANDLERS["email.send"]({
      ...baseDecision,
      body: { ...baseDecision.body, artifact_id: "00000000-0000-4000-8000-000000000002" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/artifact_storage_path_mismatch/);
  });

  it("attachment run_id mismatch (when decision has agent_run_id) → refuse", async () => {
    withServiceClient(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "art-2c", tenant_id: "t-1", run_id: "OTHER-RUN", storage_path: "t-1/OTHER-RUN/x.pdf", filename: "x.pdf", mime: "application/pdf", bytes: 1 },
                error: null,
              }),
            }),
          }),
        }),
      }),
      storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) },
      rpc: vi.fn(),
    }));
    const res = await HANDLERS["email.send"]({
      ...baseDecision,
      agent_run_id: "r-1",
      body: { ...baseDecision.body, artifact_id: "00000000-0000-4000-8000-000000000002" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/artifact_run_id_mismatch/);
  });

  it("attachment MIME not PDF → refuse (v1 PDF-only)", async () => {
    withServiceClient(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "art-2d", tenant_id: "t-1", run_id: null, storage_path: "t-1/run-1/data.csv", filename: "data.csv", mime: "text/csv", bytes: 100 },
                error: null,
              }),
            }),
          }),
        }),
      }),
      storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) },
      rpc: vi.fn(),
    }));
    const res = await HANDLERS["email.send"]({
      ...baseDecision,
      body: { ...baseDecision.body, artifact_id: "00000000-0000-4000-8000-000000000002" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/artifact_mime_not_allowed/);
  });

  it("attachment too large → refuse before download (18 MB raw cap)", async () => {
    withServiceClient(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "art-3", tenant_id: "t-1", run_id: null, storage_path: "t-1/run-1/big.pdf", filename: "big.pdf", mime: "application/pdf", bytes: 20 * 1024 * 1024 },
                error: null,
              }),
            }),
          }),
        }),
      }),
      storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) },
      rpc: vi.fn(),
    }));
    const res = await HANDLERS["email.send"]({
      ...baseDecision,
      body: { ...baseDecision.body, artifact_id: "00000000-0000-4000-8000-000000000003" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/artifact_too_large/);
  });

  it("artifact_id present but row missing → refuse", async () => {
    withServiceClient(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
      storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) },
      rpc: vi.fn(),
    }));
    const res = await HANDLERS["email.send"]({
      ...baseDecision,
      body: { ...baseDecision.body, artifact_id: "00000000-0000-4000-8000-000000000004" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/artifact_not_found/);
  });

  it("attachment download error → refuse with artifact_download_failed", async () => {
    withServiceClient(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "art-5", tenant_id: "t-1", run_id: null, storage_path: "t-1/run-1/report.pdf", filename: "report.pdf", mime: "application/pdf", bytes: 4 },
                error: null,
              }),
            }),
          }),
        }),
      }),
      storage: { from: () => ({ download: async () => ({ data: null, error: { message: "storage temp fail" } }) }) },
      rpc: vi.fn(),
    }));
    const res = await HANDLERS["email.send"]({
      ...baseDecision,
      body: { ...baseDecision.body, artifact_id: "00000000-0000-4000-8000-000000000005" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/artifact_download_failed/);
  });

  it("attachment filename with control chars + path traversal → normalized before SendGrid", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    withServiceClient(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "art-6", tenant_id: "t-1", run_id: null,
                  storage_path: "t-1/run-1/r.pdf",
                  filename: "../../etc/passwd\nbad\rname.pdf",
                  mime: "application/pdf", bytes: 4,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
      storage: { from: () => ({ download: async () => ({ data: new Blob([bytes]), error: null }) }) },
      rpc: vi.fn(),
    }));
    mockSend.mockResolvedValueOnce({ ok: true, messageId: "m-clean", statusCode: 202 });
    const res = await HANDLERS["email.send"]({
      ...baseDecision,
      body: { ...baseDecision.body, artifact_id: "00000000-0000-4000-8000-000000000006" },
    });
    expect(res.ok).toBe(true);
    expect(mockSend).toHaveBeenCalledWith("t-1", expect.objectContaining({
      attachments: [expect.objectContaining({ filename: "passwdbadname.pdf" })],
    }));
  });
});
