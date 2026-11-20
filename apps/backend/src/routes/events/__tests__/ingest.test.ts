import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("@/services/supabase", () => {
  const rpc = vi.fn();
  return {
    serviceClient: () => ({ rpc }),
    __rpc: rpc,
  };
});

import { eventsIngest } from "../ingest";
import * as supa from "@/services/supabase";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (supa as any).__rpc as ReturnType<typeof vi.fn>;

function mockReq(opts: {
  headers?: Record<string, string>;
  body?: unknown;
}): Request {
  const headers = opts.headers ?? {};
  return {
    header: (name: string) => headers[name.toLowerCase()],
    ip: "127.0.0.1",
    body: opts.body ?? {},
  } as unknown as Request;
}

function mockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(payload: unknown) {
      this._json = payload;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

describe("eventsIngest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 when no ingest key is presented", async () => {
    const res = mockRes();
    await eventsIngest(mockReq({ body: { event_name: "signup" } }), res);
    expect(res._status).toBe(401);
    expect((res._json as { error: { code: string } }).error.code).toBe("no_ingest_key");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("400 on invalid event body", async () => {
    const res = mockRes();
    await eventsIngest(
      mockReq({ headers: { "x-praxis-ingest-key": "k_live_abc" }, body: { source: "telepathy" } }),
      res,
    );
    expect(res._status).toBe(400);
    expect((res._json as { error: { code: string } }).error.code).toBe("bad_event");
  });

  it("401 when the key resolves to no tenant (unknown/revoked)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    const res = mockRes();
    await eventsIngest(
      mockReq({ headers: { "x-praxis-ingest-key": "k_live_bad" }, body: { event_name: "signup" } }),
      res,
    );
    expect(res._status).toBe(401);
    expect((res._json as { error: { code: string } }).error.code).toBe("invalid_ingest_key");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("writes via ingest_tenant_event using the SERVER-DERIVED tenant_id and returns 202", async () => {
    rpc
      .mockResolvedValueOnce({ data: "tenant-A", error: null })
      .mockResolvedValueOnce({ data: 42, error: null });
    const res = mockRes();
    await eventsIngest(
      mockReq({
        headers: { "x-praxis-ingest-key": "k_live_good" },
        body: { event_name: "purchase", distinct_id: "u1", tenant_id: "tenant-B", source: "web" },
      }),
      res,
    );
    expect(res._status).toBe(202);
    expect((res._json as { ok: boolean; event_id: number }).event_id).toBe(42);

    const writeCall = rpc.mock.calls[1];
    expect(writeCall[0]).toBe("ingest_tenant_event");
    expect(writeCall[1].p_tenant_id).toBe("tenant-A");
    expect(writeCall[1].p_event_name).toBe("purchase");
    expect(writeCall[1].p_source).toBe("web");
  });

  it("accepts the key via Authorization: Bearer too", async () => {
    rpc
      .mockResolvedValueOnce({ data: "tenant-A", error: null })
      .mockResolvedValueOnce({ data: 1, error: null });
    const res = mockRes();
    await eventsIngest(
      mockReq({ headers: { authorization: "Bearer k_live_good" }, body: { event_name: "signup" } }),
      res,
    );
    expect(res._status).toBe(202);
  });
});
