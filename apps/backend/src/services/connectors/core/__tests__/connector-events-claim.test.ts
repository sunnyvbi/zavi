import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ updates: [] as unknown[], filters: [] as unknown[][] }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q: any = {
        update: (v: unknown) => { m.updates.push(v); return q; },
        eq: (...a: unknown[]) => { m.filters.push(["eq", ...a]); return q; },
        is: (...a: unknown[]) => { m.filters.push(["is", ...a]); return q; },
        gte: async (...a: unknown[]) => { m.filters.push(["gte", ...a]); return { error: null }; },
      };
      return q;
    },
  }),
}));
import { disconnectActorMiddleware } from "../connector-events";

function run(path: string, status: number, auth?: { user_id: string; tenant_id: string }) {
  let finish: () => void = () => undefined;
  const req = { method: "POST", path, auth: undefined as typeof auth };
  const res = { statusCode: status, on: (_e: "finish", cb: () => void) => { finish = cb; } };
  const next = vi.fn();
  disconnectActorMiddleware(req, res, next);
  req.auth = auth;
  finish();
  return next;
}

beforeEach(() => { m.updates = []; m.filters = []; });

describe("disconnectActorMiddleware", () => {
  it("a successful service-role disconnect (Telegram) gets its caller as the actor on this tenant's new rows", async () => {
    const next = run("/api/connectors/telegram/disconnect", 200, { user_id: "U1", tenant_id: "T1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(next).toHaveBeenCalled();
    expect(m.updates).toEqual([{ actor_user_id: "U1" }]);
    expect(m.filters).toEqual(expect.arrayContaining([["eq", "tenant_id", "T1"], ["eq", "action", "disconnect"], ["is", "actor_user_id", null]]));
  });

  it("a failed disconnect, an unauthed call, or another route claims nothing", async () => {
    run("/api/connectors/telegram/disconnect", 403, { user_id: "U1", tenant_id: "T1" });
    run("/api/connectors/telegram/disconnect", 200);
    run("/api/connectors/telegram/bind", 200, { user_id: "U1", tenant_id: "T1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.updates).toEqual([]);
  });
});
