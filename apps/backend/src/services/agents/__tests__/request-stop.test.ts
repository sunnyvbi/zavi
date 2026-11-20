
import { describe, it, expect, vi } from "vitest";
import { requestStopForRun } from "../request-stop";

function mockClient(results: Record<string, { data: unknown; error: unknown }>) {
  const calls: Array<{ status: string; patch: Record<string, unknown> }> = [];
  const client = {
    from: () => {
      let patch: Record<string, unknown> = {};
      let status = "";
      const chain: Record<string, unknown> = {
        update: (p: Record<string, unknown>) => {
          patch = p;
          return chain;
        },
        eq: (col: string, val: string) => {
          if (col === "status") status = val;
          return chain;
        },
        select: () => {
          calls.push({ status, patch });
          return Promise.resolve(results[status] ?? { data: [], error: null });
        },
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}

describe("requestStopForRun", () => {
  it("cancels a queued run terminally (queued guard matches)", async () => {
    const { client, calls } = mockClient({ queued: { data: [{ id: "r1" }], error: null } });
    const res = await requestStopForRun(client, "t1", "r1");
    expect(res).toEqual({ ok: true, cancelling: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].patch).toMatchObject({ status: "cancelled", stop_requested: true });
  });

  it("sets stop_requested for a running run (queued guard misses, running matches)", async () => {
    const { client, calls } = mockClient({
      queued: { data: [], error: null },
      running: { data: [{ id: "r1" }], error: null },
    });
    const res = await requestStopForRun(client, "t1", "r1");
    expect(res).toEqual({ ok: true, cancelling: true });
    expect(calls).toHaveLength(2);
    expect(calls[1].status).toBe("running");
    expect(calls[1].patch).toEqual({ stop_requested: true });
  });

  it("is an idempotent no-op when the run already went terminal (both guards miss)", async () => {
    const { client } = mockClient({
      queued: { data: [], error: null },
      running: { data: [], error: null },
    });
    const res = await requestStopForRun(client, "t1", "r1");
    expect(res).toEqual({ ok: true, already_terminal: true });
  });

  it("surfaces a DB error from the queued write", async () => {
    const { client } = mockClient({ queued: { data: null, error: { message: "boom" } } });
    const res = await requestStopForRun(client, "t1", "r1");
    expect(res).toEqual({ ok: false, error: "boom" });
  });

  it("rejects missing ids without touching the DB", async () => {
    const { client, calls } = mockClient({});
    expect(await requestStopForRun(client, "", "r1")).toMatchObject({ ok: false });
    expect(await requestStopForRun(client, "t1", "")).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});
