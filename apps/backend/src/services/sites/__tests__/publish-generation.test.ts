import { describe, expect, it, vi } from "vitest";
import { createPublishGenerations } from "../publish-generation";

const T = "11111111-1111-4111-8111-111111111111";
const S = "aaaaaaaa-0000-4000-8000-000000000001";
const TOKEN = "cccccccc-0000-4000-8000-000000000003";

function rpcReturning(data: unknown, error: { message: string; code?: string } | null = null) {
  return vi.fn(async (_tid: string, _name: string, _args: Record<string, unknown>) => ({ data, error }));
}

describe("publish generations (site_publish_begin / lease / release)", () => {
  it("begin calls the tenant RPC with the site and commit, and returns the new generation", async () => {
    const rpc = rpcReturning(7);
    expect(await createPublishGenerations({ rpc } as never).begin(T, S, "abcdef1")).toBe(7);
    expect(rpc).toHaveBeenCalledWith(T, "site_publish_begin", { p_site_id: S, p_sha: "abcdef1" });
  });

  it("0 = another generation holds the commit lease: busy", async () => {
    expect(await createPublishGenerations({ rpc: rpcReturning(0) } as never).begin(T, S, "abcdef1")).toBe("busy");
  });

  it("a begin without a generation, or an RPC error, throws (the deploy step retries)", async () => {
    await expect(createPublishGenerations({ rpc: rpcReturning(null) } as never).begin(T, S, "abcdef1")).rejects.toThrow(/no generation/);
    await expect(createPublishGenerations({ rpc: rpcReturning(null, { message: "boom", code: "P0002" }) } as never).begin(T, S, "abcdef1")).rejects.toThrow(/site_publish_begin failed \(P0002\)/);
  });

  it("lease maps the RPC outcome; a gone site reads as superseded; anything else throws", async () => {
    for (const out of ["leased", "busy", "superseded"]) {
      expect(await createPublishGenerations({ rpc: rpcReturning(out) } as never).lease(T, S, 3, 300, TOKEN)).toBe(out);
    }
    expect(await createPublishGenerations({ rpc: rpcReturning("not_found") } as never).lease(T, S, 3, 300, TOKEN)).toBe("superseded");
    await expect(createPublishGenerations({ rpc: rpcReturning("weird") } as never).lease(T, S, 3, 300, TOKEN)).rejects.toThrow(/returned weird/);
    const rpc = rpcReturning("leased");
    await createPublishGenerations({ rpc } as never).lease(T, S, 3, 300, TOKEN);
    expect(rpc).toHaveBeenCalledWith(T, "site_publish_lease", { p_site_id: S, p_generation: 3, p_ttl_seconds: 300, p_token: TOKEN });
  });

  it("release passes the generation (the RPC drops only that generation's own lease)", async () => {
    const rpc = rpcReturning(null);
    await createPublishGenerations({ rpc } as never).release(T, S, 3, TOKEN);
    expect(rpc).toHaveBeenCalledWith(T, "site_publish_release", { p_site_id: S, p_generation: 3, p_token: TOKEN });
  });
});
