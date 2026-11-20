import { describe, it, expect, vi } from "vitest";
import { inngestSyncGuard } from "@/services/inngest-sync-guard";

function run(method: string, env: NodeJS.ProcessEnv) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  inngestSyncGuard(env)({ method } as never, res as never, next);
  return { res, next };
}

const laptop = { INNGEST_SIGNING_KEY: "signkey-prod" };

describe("inngestSyncGuard", () => {
  it("refuses PUT on a non-canonical process holding the prod signing key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res, next } = run("PUT", laptop);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "inngest_sync_refused" }));
    warn.mockRestore();
  });

  it("passes GET and POST through, so invocations still work", () => {
    expect(run("GET", laptop).next).toHaveBeenCalled();
    expect(run("POST", laptop).next).toHaveBeenCalled();
  });

  it("passes PUT on the canonical container (deploy.yml + boot self-sync)", () => {
    expect(run("PUT", { ...laptop, PRAXIS_CONTAINER_ROLE: "canonical" }).next).toHaveBeenCalled();
  });

  it("passes PUT in Inngest dev mode (the local dev server registers this way)", () => {
    expect(run("PUT", { ...laptop, INNGEST_DEV: "http://localhost:8288" }).next).toHaveBeenCalled();
  });
});
