import { beforeEach, describe, expect, it, vi } from "vitest";

const row = { value: null as Record<string, unknown> | null };

vi.mock("@/services/auth/middleware", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireAuth: async () => ({ tenant_id: "t1", user_id: "u1", access_token: "tok" }),
}));
vi.mock("@/services/supabase", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  serverClientFromBearer: () => ({
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: row.value, error: null }),
      };
      return chain;
    },
  }),
}));
const copied: unknown[] = [];
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  asTenantId: (s: string) => s,
  tenantStorage: () => ({
    from: () => ({
      download: async () => {
        copied.push("download");
        return { data: new Blob(["x"]), error: null };
      },
    }),
  }),
}));

import { attachRunArtifact } from "../attach-artifact";

function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  return r;
}

describe("attach-artifact: tab-task step screenshots", () => {
  beforeEach(() => {
    copied.length = 0;
  });

  it("refuses an agent-chat-images artifact as unavailable and copies nothing", async () => {
    row.value = {
      id: "a1",
      tenant_id: "t1",
      bucket: "agent-chat-images",
      storage_path: "t1/r1/x.jpg",
      filename: "tab-task-abc.jpg",
      mime: "image/jpeg",
      bytes: 10,
    };
    const r = res();
    await attachRunArtifact({ body: { artifact_id: "11111111-1111-4111-8111-111111111111" } } as any, r);
    expect(r.statusCode).toBe(404);
    expect(copied).toHaveLength(0);
  });
});
