import { describe, it, expect, vi } from "vitest";

const requestStop = vi.fn().mockResolvedValue({ ok: true, cancelling: true });
vi.mock("../request-stop", () => ({
  requestStopForRun: (...args: unknown[]) => requestStop(...args),
}));

import { supersedeEditedMessage } from "../supersede-edited-message";

type Row = Record<string, unknown>;

function mockClient(opts: {
  original: Row | null;
  replies?: Row[];
  run?: Row | null;
  later?: Row[];
  linkedRuns?: Row[];
}) {
  const updates: Array<{ table: string; patch: Row; id?: string }> = [];
  const client = {
    from: (table: string) => {
      let patch: Row | null = null;
      let id: string | undefined;
      let role: string | undefined;
      let sweep = false;
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Row) => {
          patch = p;
          return chain;
        },
        eq: (col: string, val: string) => {
          if (col === "id") id = val;
          if (col === "sender_role") role = val;
          return chain;
        },
        gt: () => {
          sweep = true;
          return chain;
        },
        lt: () => chain,
        in: () => chain,
        filter: () => chain,
        order: () => chain,
        limit: () =>
          Promise.resolve({
            data: opts.run ? [opts.run] : [],
            error: null,
          }),
        maybeSingle: () =>
          Promise.resolve({
            data: id === "m2" ? { created_at: "2026-09-29T11:00:00Z" } : opts.original,
            error: null,
          }),
        then: (resolve: (v: unknown) => unknown) => {
          if (patch) updates.push({ table, patch, id });
          return Promise.resolve(
            patch
              ? { data: null, error: null }
              : {
                  data: table === "agent_runs"
                    ? (opts.linkedRuns ?? [])
                    : sweep
                    ? (opts.later ?? [])
                    : role === "assistant"
                      ? (opts.replies ?? [])
                      : [],
                  error: null,
                },
          ).then(resolve);
        },
      };
      return chain;
    },
  };
  return { client: client as never, updates };
}

const base = {
  tenant_id: "t1",
  thread_id: "th1",
  original_message_id: "m1",
  new_message_id: "m2",
};

describe("supersedeEditedMessage", () => {
  it("stamps the original with superseded_by and keeps its existing meta", async () => {
    const { client, updates } = mockClient({
      original: {
        id: "m1",
        sender_role: "user",
        thread_id: "th1",
        meta: { source: "web" },
      },
    });
    const out = await supersedeEditedMessage(client, base);
    expect(out.superseded).toBe(true);
    const patch = updates[0].patch.meta as Row;
    expect(patch.superseded_by).toBe("m2");
    expect(patch.source).toBe("web");
  });

  it("refuses to supersede an assistant row", async () => {
    const { client, updates } = mockClient({
      original: {
        id: "m1",
        sender_role: "assistant",
        thread_id: "th1",
        meta: {},
      },
    });
    expect((await supersedeEditedMessage(client, base)).superseded).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("no-ops when the message isn't found under this tenant/thread", async () => {
    const { client, updates } = mockClient({ original: null });
    expect((await supersedeEditedMessage(client, base)).superseded).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("no-ops on a self-edit (would hide the only copy)", async () => {
    const { client, updates } = mockClient({
      original: { id: "m1", sender_role: "user", thread_id: "th1", meta: {} },
    });
    const out = await supersedeEditedMessage(client, {
      ...base,
      new_message_id: "m1",
    });
    expect(out.superseded).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("is idempotent — an already-superseded row is not rewritten", async () => {
    const { client, updates } = mockClient({
      original: {
        id: "m1",
        sender_role: "user",
        thread_id: "th1",
        meta: { superseded_by: "m2" },
      },
    });
    expect((await supersedeEditedMessage(client, base)).superseded).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it("supersedes every later message in the thread, like a ChatGPT edit", async () => {
    const { client, updates } = mockClient({
      original: { id: "m1", sender_role: "user", thread_id: "th1", meta: {}, created_at: "2026-09-29T10:00:00Z" },
      later: [
        { id: "a1", sender_role: "assistant", meta: {}, agent_run_id: "run1" },
        { id: "u2", sender_role: "user", meta: { source: "web" }, agent_run_id: "run2" },
        { id: "a2", sender_role: "assistant", meta: {}, agent_run_id: "run2" },
      ],
    });
    expect((await supersedeEditedMessage(client, base)).superseded).toBe(true);
    const stamped = updates.filter((u) => (u.patch.meta as Row).superseded_by === "m2").map((u) => u.id);
    expect(stamped).toEqual(["m1", "a1", "u2", "a2"]);
    expect((updates.find((u) => u.id === "u2")!.patch.meta as Row).source).toBe("web");
  });

  it("stops a run still answering a later message", async () => {
    requestStop.mockClear();
    const { client } = mockClient({
      original: { id: "m1", sender_role: "user", thread_id: "th1", meta: {}, created_at: "2026-09-29T10:00:00Z" },
      later: [{ id: "u2", sender_role: "user", meta: {}, agent_run_id: "run2" }],
    });
    await supersedeEditedMessage(client, base);
    expect(requestStop).toHaveBeenCalledWith(expect.anything(), "t1", "run2");
  });

  it("stops a follow-up run linked to a later message only by payload", async () => {
    requestStop.mockClear();
    const { client } = mockClient({
      original: { id: "m1", sender_role: "user", thread_id: "th1", meta: {}, created_at: "2026-09-29T10:00:00Z" },
      later: [{ id: "u2", sender_role: "user", meta: {}, agent_run_id: null }],
      linkedRuns: [{ id: "run-followup" }, { id: "run-batch-child" }],
    });
    await supersedeEditedMessage(client, base);
    expect(requestStop).toHaveBeenCalledWith(expect.anything(), "t1", "run-followup");
    expect(requestStop).toHaveBeenCalledWith(expect.anything(), "t1", "run-batch-child");
  });

  it("stops the run still answering the original", async () => {
    requestStop.mockClear();
    const { client } = mockClient({
      original: { id: "m1", sender_role: "user", thread_id: "th1", meta: {} },
      run: { id: "run1", status: "running" },
    });
    const out = await supersedeEditedMessage(client, base);
    expect(out.stopped_run_id).toBe("run1");
    expect(requestStop).toHaveBeenCalledWith(expect.anything(), "t1", "run1");
  });
});
