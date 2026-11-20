
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const AUTH_TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "user-a";

let _authResult: { tenant_id: string; user_id: string } | null = {
  tenant_id: AUTH_TENANT,
  user_id: USER_ID,
};
let _runRow: { id: string; tenant_id: string } | null = {
  id: RUN_ID,
  tenant_id: AUTH_TENANT,
};
let _memberAllowed = true;
let _capturesData: Array<{ retrieved_note_ids: string[] | null; created_at: string }> = [];
let _notesData: Array<{ id: string; title: string | null; source: string | null }> = [];

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => _authResult),
}));

vi.mock("@/services/agents/runner", () => ({
  getAgentRunById: vi.fn(async (tid: string, run_id: string) =>
    _runRow && _runRow.id === run_id && _runRow.tenant_id === tid ? _runRow : null,
  ),
}));

vi.mock("@/services/auth/members", () => ({
  canUserAccessAgentRun: vi.fn(async () => _memberAllowed),
}));

vi.mock("@/services/supabase", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables: Record<string, any> = {};
  const builder = (tableName: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      _filters: [] as Array<[string, string]>,
      select: vi.fn(() => b),
      eq: vi.fn((col: string, val: string) => {
        b._filters.push([col, val]);
        return b;
      }),
      in: vi.fn(() => b),
      order: vi.fn(() => b),
      limit: vi.fn(() => {
        if (tableName === "eval_candidates") {
          return Promise.resolve({ data: _capturesData, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        if (tableName === "memory_note") {
          return resolve({ data: _notesData, error: null });
        }
        return resolve({ data: null, error: null });
      },
    };
    tables[tableName] = b;
    return b;
  };
  return {
    serviceClient: vi.fn(() => ({
      from: vi.fn((name: string) => builder(name)),
    })),
  };
});

function mockRes(): Response {
  let status = 200;
  let body: unknown = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = {
    status: vi.fn((c: number) => {
      status = c;
      return r;
    }),
    json: vi.fn((b: unknown) => {
      body = b;
      return r;
    }),
    _inspect: () => ({ status, body }),
  };
  return r as Response;
}

function mockReq(run_id: string): Request {
  return { params: { run_id } } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  _authResult = { tenant_id: AUTH_TENANT, user_id: USER_ID };
  _runRow = { id: RUN_ID, tenant_id: AUTH_TENANT };
  _memberAllowed = true;
  _capturesData = [];
  _notesData = [];
});

describe("agentRunBrainAnchors — auth + tenant isolation", () => {
  it("unauthenticated → requireAuth handles response (no body set here)", async () => {
    _authResult = null;
    const { agentRunBrainAnchors } = await import("../../routes/agents/brain-anchors");
    const req = mockReq(RUN_ID);
    const res = mockRes();
    await agentRunBrainAnchors(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.body).toBeNull();
  });

  it("run from different tenant → 404 not_found (no tenant leak)", async () => {
    _runRow = { id: RUN_ID, tenant_id: OTHER_TENANT };
    const { agentRunBrainAnchors } = await import("../../routes/agents/brain-anchors");
    const req = mockReq(RUN_ID);
    const res = mockRes();
    await agentRunBrainAnchors(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.status).toBe(404);
    expect((r.body as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("member not allowed → 404 (not 403, don't reveal existence)", async () => {
    _memberAllowed = false;
    const { agentRunBrainAnchors } = await import("../../routes/agents/brain-anchors");
    const req = mockReq(RUN_ID);
    const res = mockRes();
    await agentRunBrainAnchors(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.status).toBe(404);
  });

  it("missing run_id param → 400", async () => {
    const { agentRunBrainAnchors } = await import("../../routes/agents/brain-anchors");
    const req = { params: {} } as unknown as Request;
    const res = mockRes();
    await agentRunBrainAnchors(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.status).toBe(400);
  });
});

describe("agentRunBrainAnchors — empty state", () => {
  it("no captures for run → {anchors:[], capture_count:0, capture_enabled:false}", async () => {
    _capturesData = [];
    const { agentRunBrainAnchors } = await import("../../routes/agents/brain-anchors");
    const req = mockReq(RUN_ID);
    const res = mockRes();
    await agentRunBrainAnchors(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.body).toEqual({
      anchors: [],
      capture_count: 0,
      capture_enabled: false,
    });
  });

  it("captures exist but all empty arrays → capture_count>0, capture_enabled:true, anchors empty", async () => {
    _capturesData = [
      { retrieved_note_ids: [], created_at: "2026-05-18T00:00:00Z" },
      { retrieved_note_ids: null, created_at: "2026-05-18T00:01:00Z" },
    ];
    const { agentRunBrainAnchors } = await import("../../routes/agents/brain-anchors");
    const req = mockReq(RUN_ID);
    const res = mockRes();
    await agentRunBrainAnchors(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.body).toMatchObject({
      anchors: [],
      capture_count: 2,
      capture_enabled: true,
    });
  });
});

describe("agentRunBrainAnchors — top-3 frequency ordering", () => {
  it("ranks by hit_count desc, caps at 3, hydrates titles", async () => {
    _capturesData = [
      { retrieved_note_ids: ["n1", "n2", "n3"], created_at: "2026-05-18T00:00:00Z" },
      { retrieved_note_ids: ["n1", "n4"], created_at: "2026-05-18T00:01:00Z" },
      { retrieved_note_ids: ["n1", "n2"], created_at: "2026-05-18T00:02:00Z" },
    ];
    _notesData = [
      { id: "n1", title: "Note One", source: "human" },
      { id: "n2", title: "Note Two", source: "agent_run" },
      { id: "n3", title: "Note Three", source: "human" },
      { id: "n4", title: "Note Four", source: "human" },
    ];
    const { agentRunBrainAnchors } = await import("../../routes/agents/brain-anchors");
    const req = mockReq(RUN_ID);
    const res = mockRes();
    await agentRunBrainAnchors(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    const body = r.body as {
      anchors: Array<{ note_id: string; title: string; hit_count: number }>;
      capture_count: number;
      capture_enabled: boolean;
    };
    expect(body.capture_enabled).toBe(true);
    expect(body.capture_count).toBe(3);
    expect(body.anchors.length).toBeLessThanOrEqual(3);
    expect(body.anchors[0].note_id).toBe("n1");
    expect(body.anchors[0].title).toBe("Note One");
    expect(body.anchors[0].hit_count).toBe(3);
    expect(body.anchors[1].note_id).toBe("n2");
    expect(body.anchors[1].hit_count).toBe(2);
  });

  it("hydrates '(untitled)' when memory_note.title is null/empty", async () => {
    _capturesData = [
      { retrieved_note_ids: ["nA"], created_at: "2026-05-18T00:00:00Z" },
    ];
    _notesData = [{ id: "nA", title: null, source: "human" }];
    const { agentRunBrainAnchors } = await import("../../routes/agents/brain-anchors");
    const req = mockReq(RUN_ID);
    const res = mockRes();
    await agentRunBrainAnchors(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    const body = r.body as { anchors: Array<{ title: string }> };
    expect(body.anchors[0].title).toBe("(untitled)");
  });
});
