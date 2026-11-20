import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({
  row: null as unknown,
  readError: null as { message: string } | null,
  tenants: [] as string[],
  ids: [] as string[],
  auth: { tenant_id: "tenant-a", user_id: "user-a" } as unknown,
  sign: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => m.auth }));
vi.mock("@/services/channels/action-media", () => ({ signActionMedia: m.sign }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: (t: string) => {
    m.tenants.push(t);
    return {
      from: () => ({
        select: () => ({
          eq: (_c: string, id: string) => {
            m.ids.push(id);
            return { maybeSingle: async () => ({ data: m.row, error: m.readError }) };
          },
        }),
      }),
    };
  },
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn(), InsufficientCreditsError: class extends Error {} }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));

import { channelVideoCardRead } from "../actions";

const ID = "11111111-1111-4111-8111-111111111111";
const video = { id: ID, channel_slug: "generated_video", exec_class: "generated_video.render.v1", title: "t", body: { media: { storage_path: "p" } }, status: "pending", note: null, exec_status: null };

async function read(id = ID) {
  const out = { status: 200, body: null as unknown };
  const res = {
    status(c: number) {
      out.status = c;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  };
  await channelVideoCardRead({ params: { id } } as unknown as Request, res as unknown as Response);
  return out;
}

beforeEach(() => {
  m.row = video;
  m.readError = null;
  m.tenants.length = 0;
  m.ids.length = 0;
  m.auth = { tenant_id: "tenant-a", user_id: "user-a" };
  m.sign.mockReset().mockImplementation(async (_t: string, rows: unknown[]) => rows.map((r) => ({ ...(r as object), body: { media: { kind: "video", url: "https://signed" } } })));
});

describe("GET /api/channel-actions/:id/video-card", () => {
  it("reads through the authed tenant and returns the signed card, never the storage path", async () => {
    const out = await read();
    expect(out.status).toBe(200);
    expect(m.tenants).toEqual(["tenant-a"]);
    expect(m.ids).toEqual([ID]);
    expect(m.sign).toHaveBeenCalledWith("tenant-a", [expect.objectContaining(video)]);
    expect(JSON.stringify(out.body)).toContain("https://signed");
    expect(JSON.stringify(out.body)).not.toContain("storage_path");
  });

  it("a missing row, another channel's card and a non-render card on this channel all answer 404", async () => {
    for (const row of [null, { ...video, channel_slug: "google_ads" }, { ...video, exec_class: null }]) {
      m.row = row;
      expect((await read()).status).toBe(404);
    }
    expect(m.sign).not.toHaveBeenCalled();
  });

  it("a failed render reports its code and bucket so Try again and Top up can show, and never leaks the raw result", async () => {
    m.row = { ...video, exec_status: "failed", proposed_at: "2026-11-02T10:00:00Z", exec_result: { code: "insufficient_credits", vendor_secret: "raw" } };
    const out = await read();
    const seen = m.sign.mock.calls[0][1][0] as Record<string, unknown>;
    expect(seen.exec_code).toBe("insufficient_credits");
    expect(seen.exec_bucket).toBeTruthy();
    expect(seen.proposed_at).toBe("2026-11-02T10:00:00Z");
    expect(JSON.stringify(out.body)).not.toContain("vendor_secret");
    expect(seen).not.toHaveProperty("exec_result");
  });

  it("a bad id is a 400 and never reaches the database", async () => {
    expect((await read("not-a-uuid")).status).toBe(400);
    expect(m.tenants).toEqual([]);
  });

  it("a read or signing outage is a 503, so the card keeps polling instead of reading as not found", async () => {
    m.readError = { message: "db down" };
    expect((await read()).status).toBe(503);
    m.readError = null;
    m.sign.mockRejectedValue(new Error("storage down"));
    expect((await read()).status).toBe(503);
  });
});
