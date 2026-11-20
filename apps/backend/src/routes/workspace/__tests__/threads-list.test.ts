
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  threadRows: vi.fn(),
  messageRow: vi.fn(),
  seenMarkers: vi.fn(),
  assistantMsgs: vi.fn(),
  threadFeed: vi.fn(),
  liveRuns: vi.fn(),
  loadAgentDefinition: vi.fn(),
  messageQueries: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: mocks.requireAuth,
}));
vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: mocks.loadAgentDefinition,
}));

function chain(terminal: () => unknown, record?: Record<string, unknown>) {
  const api: Record<string, unknown> = {};
  const note =
    (name: string) =>
    (...args: unknown[]) => {
      if (record) record[`${name}:${String(args[0])}`] = args[1] ?? true;
      return api;
    };
  for (const m of ["select", "eq", "in", "is", "not", "order"])
    api[m] = note(m);
  api.limit = (...args: unknown[]) => {
    if (record) record.limit = args[0];
    return api;
  };
  api.maybeSingle = () => terminal();
  api.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(terminal()).then(res, rej);
  return api;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    rpc: mocks.threadFeed,
    from: (table: string) => {
      if (table === "agent_threads") return chain(mocks.threadRows);
      if (table === "agent_thread_seen_marker") return chain(mocks.seenMarkers);
      if (table === "agent_runs") return chain(mocks.liveRuns);
      const record: Record<string, unknown> = {};
      mocks.messageQueries.push(record);
      return chain(() => {
        record.resolved = true;
        return mocks.messageRow();
      }, record);
    },
  }),
}));

import { workspaceListThreads, parseThreadLimit } from "../threads";

function res() {
  const out = { code: 0, body: undefined as unknown };
  return {
    status(c: number) {
      out.code = c;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
    out,
  };
}

const thread = (id: string, agent_slug: string, title: string | null) => ({
  id,
  agent_slug,
  title,
  last_message_at: "2026-09-11T10:00:00Z",
  created_at: "2026-09-11T09:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messageQueries.length = 0;
  mocks.requireAuth.mockResolvedValue({
    user_id: "u1",
    tenant_id: "t1",
    access_token: "tok",
  });
  mocks.seenMarkers.mockReturnValue({ data: [] });
  mocks.messageRow.mockReturnValue({ data: null });
  mocks.threadFeed.mockResolvedValue({ data: [], error: null });
  mocks.liveRuns.mockReturnValue({ data: [] });
  mocks.loadAgentDefinition.mockImplementation(async (slug: string) => {
    if (slug === "content-seo") return { slug: "content-design" };
    if (slug === "operator" || slug === "content-design") return { slug };
    return null;
  });
});

describe("GET /api/workspace/threads", () => {
  it("drops threads whose agent no longer resolves", async () => {
    mocks.threadRows.mockReturnValue({
      data: [
        thread("t-live", "operator", "Still here"),
        thread(
          "t-dead",
          "cohort-analytics",
          "Agent was deleted in the fleet cut",
        ),
      ],
    });
    const r = res();
    await workspaceListThreads({ query: {} } as never, r as never);
    const { threads } = r.out.body as { threads: Array<{ id: string }> };
    expect(threads.map((t) => t.id)).toEqual(["t-live"]);
  });

  it("emits the canonical slug for a renamed agent", async () => {
    mocks.threadRows.mockReturnValue({
      data: [thread("t-old", "content-seo", "Written before the rename")],
    });
    const r = res();
    await workspaceListThreads({ query: {} } as never, r as never);
    const { threads } = r.out.body as {
      threads: Array<{ agent_slug: string }>;
    };
    expect(threads[0]?.agent_slug).toBe("content-design");
  });

  it("resolves each distinct agent once, not once per row", async () => {
    mocks.threadRows.mockReturnValue({
      data: [
        thread("a", "operator", "one"),
        thread("b", "operator", "two"),
        thread("c", "operator", "three"),
      ],
    });
    await workspaceListThreads({ query: {} } as never, res() as never);
    expect(mocks.loadAgentDefinition).toHaveBeenCalledTimes(1);
  });

  it("looks up a preview per untitled thread, one row each", async () => {
    mocks.threadRows.mockReturnValue({
      data: [
        thread("titled", "operator", "Has a title"),
        thread("bare-1", "operator", null),
        thread("bare-2", "operator", "   "),
      ],
    });
    await workspaceListThreads({ query: {} } as never, res() as never);
    const previewReads = mocks.messageQueries.filter((q) => q.limit === 1);
    expect(previewReads).toHaveLength(2);
    expect(previewReads.every((q) => q["eq:thread_id"] !== undefined)).toBe(
      true,
    );
  });

  it("emits the latest run display state for each Recent row", async () => {
    mocks.threadRows.mockReturnValue({
      data: [
        thread("t-running", "operator", "Still working"),
        thread("t-done", "operator", "Shipped"),
        thread("t-error", "operator", "Could not finish"),
      ],
    });
    mocks.threadFeed.mockResolvedValue({
      data: [
        { id: "t-running", run_status: "running", run_outcome: null },
        { id: "t-done", run_status: "success", run_outcome: null },
        { id: "t-error", run_status: "parse_failed", run_outcome: null },
      ],
      error: null,
    });

    const r = res();
    await workspaceListThreads({ query: {} } as never, r as never);
    const { threads } = r.out.body as {
      threads: Array<{ id: string; presentation_status: string }>;
    };
    expect(threads.map((t) => [t.id, t.presentation_status])).toEqual([
      ["t-running", "running"],
      ["t-done", "answered"],
      ["t-error", "failed"],
    ]);
    expect(mocks.threadFeed).toHaveBeenCalledWith("list_agent_threads_feed", {
      p_agent_slug: "operator",
      p_limit: 50,
      p_before: null,
    });
  });

  it("shows a run that is still in flight as running, even though no message links to it yet", async () => {
    mocks.threadRows.mockReturnValue({
      data: [
        thread("t-live", "operator", "Working on it"),
        thread("t-done", "operator", "Shipped"),
      ],
    });
    mocks.threadFeed.mockResolvedValue({
      data: [
        { id: "t-live", run_status: "success", run_outcome: null },
        { id: "t-done", run_status: "success", run_outcome: null },
      ],
      error: null,
    });
    mocks.liveRuns.mockReturnValue({
      data: [{ thread_id: "t-live", status: "running" }],
    });

    const r = res();
    await workspaceListThreads({ query: {} } as never, r as never);
    const { threads } = r.out.body as {
      threads: Array<{ id: string; run_status: string | null; presentation_status: string }>;
    };
    expect(threads.map((t) => [t.id, t.run_status, t.presentation_status])).toEqual([
      ["t-live", "running", "running"],
      ["t-done", "success", "answered"],
    ]);
  });

  it("shows a turn waiting behind another (blocked) as running, not failed", async () => {
    mocks.threadRows.mockReturnValue({
      data: [thread("t-feed", "operator", "Queued"), thread("t-live", "operator", "Queued too")],
    });
    mocks.threadFeed.mockResolvedValue({
      data: [{ id: "t-feed", run_status: "blocked", run_outcome: null }],
      error: null,
    });
    mocks.liveRuns.mockReturnValue({
      data: [{ thread_id: "t-live", status: "blocked" }],
    });

    const r = res();
    await workspaceListThreads({ query: {} } as never, r as never);
    const { threads } = r.out.body as {
      threads: Array<{ id: string; presentation_status: string }>;
    };
    expect(threads.map((t) => [t.id, t.presentation_status])).toEqual([
      ["t-feed", "running"],
      ["t-live", "running"],
    ]);
  });

  it("surfaces a query failure instead of rendering an empty History", async () => {
    mocks.threadRows.mockReturnValue({
      data: null,
      error: { message: "boom" },
    });
    const r = res();
    await workspaceListThreads({ query: {} } as never, r as never);
    expect(r.out.code).toBe(500);
    expect((r.out.body as { error: { code: string } }).error.code).toBe(
      "query_failed",
    );
  });
});

describe("parseThreadLimit", () => {
  it("is the only thing that reaches the query's limit", () => {
    expect(parseThreadLimit("10")).toBe(10);
    expect(parseThreadLimit("99999")).toBe(200);
  });
});
