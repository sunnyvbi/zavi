import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyBearer = vi.fn();
const readBearerToken = vi.fn();
vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: (...a: unknown[]) => verifyBearer(...a),
  readBearerToken: (...a: unknown[]) => readBearerToken(...a),
}));

const db = {
  row: null as Record<string, unknown> | null,
  error: null as { message: string } | null,
  upserts: 0,
  gate: null as Promise<void> | null,
};
vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.update = () => q;
      q.maybeSingle = async () => {
        const row = db.row;
        if (db.gate) {
          const g = db.gate;
          db.gate = null;
          await g;
        }
        return { data: row, error: db.error };
      };
      q.upsert = async () => {
        db.upserts += 1;
        return { error: null };
      };
      return q;
    },
  }),
}));

import {
  _resetGatekeeperCache,
  evaluateFlag,
  getFlag,
  updateFlag,
  isFeatureEnabled,
  rolloutBucket,
  type GatekeeperFlag,
} from "../index";
import { requireFeature } from "../require-feature";
import { gatekeeperCheck } from "@/routes/gatekeeper/check";

const U1 = "0335f3eb-8f08-4f72-91e1-6cd085503f13";

function flag(over: Partial<GatekeeperFlag> = {}): GatekeeperFlag {
  return {
    name: "new-thing",
    description: "",
    is_enabled: true,
    rollout_percentage: 0,
    cache_policy: "standard",
    whitelist: [],
    created_at: "",
    updated_at: "",
    updated_by: null,
    ...over,
  };
}

function mockRes() {
  const res = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  return Object.assign(res, {
    set(k: string, v: string) {
      res.headers[k] = v;
      return this;
    },
    status(c: number) {
      res.statusCode = c;
      return this;
    },
    json(b: unknown) {
      res.body = b;
      return this;
    },
  });
}

beforeEach(() => {
  _resetGatekeeperCache();
  db.row = null;
  db.error = null;
  db.upserts = 0;
  verifyBearer.mockReset();
  readBearerToken.mockReset();
});

describe("evaluateFlag", () => {
  it("missing flag is off", () => {
    expect(evaluateFlag(null, U1)).toEqual({ enabled: false, reason: "not_found" });
  });

  it("disabled beats whitelist", () => {
    expect(evaluateFlag(flag({ is_enabled: false, whitelist: [U1] }), U1).enabled).toBe(false);
  });

  it("whitelisted user is on at 0% rollout", () => {
    expect(evaluateFlag(flag({ whitelist: [U1] }), U1)).toEqual({ enabled: true, reason: "whitelisted" });
  });

  it("anonymous is on only at 100%", () => {
    expect(evaluateFlag(flag({ rollout_percentage: 99 }), null).enabled).toBe(false);
    expect(evaluateFlag(flag({ rollout_percentage: 100 }), null).enabled).toBe(true);
  });

  it("rollout uses the stable md5 bucket", () => {
    const b = rolloutBucket(U1, "new-thing");
    expect(b).toBe(rolloutBucket(U1, "new-thing"));
    expect(evaluateFlag(flag({ rollout_percentage: b + 1 }), U1).enabled).toBe(true);
    expect(evaluateFlag(flag({ rollout_percentage: b }), U1).enabled).toBe(false);
  });

  it("buckets spread roughly evenly", () => {
    let on = 0;
    for (let i = 0; i < 2000; i++) if (rolloutBucket(`user-${i}`, "x") < 30) on += 1;
    expect(on / 2000).toBeGreaterThan(0.25);
    expect(on / 2000).toBeLessThan(0.35);
  });
});

describe("isFeatureEnabled", () => {
  it("fails closed on a DB error", async () => {
    db.error = { message: "boom" };
    expect(await isFeatureEnabled("new-thing", U1)).toBe(false);
  });

  it("auto-registers a missing flag for backend callers only", async () => {
    await isFeatureEnabled("new-thing", U1);
    expect(db.upserts).toBe(1);
    _resetGatekeeperCache();
    await isFeatureEnabled("new-thing", U1, { autoRegister: false });
    expect(db.upserts).toBe(1);
  });
});

describe("cache", () => {
  it("a read that started before an edit does not re-cache the old row", async () => {
    db.row = flag({ is_enabled: true });
    let release!: () => void;
    db.gate = new Promise<void>((r) => (release = r));
    const inFlight = getFlag("new-thing");

    db.row = flag({ is_enabled: false });
    await updateFlag("new-thing", { is_enabled: false }, "staff@x");
    release();
    expect((await inFlight)?.is_enabled).toBe(true);

    expect((await getFlag("new-thing"))?.is_enabled).toBe(false);
  });
});

describe("requireFeature", () => {
  const mw = requireFeature("new-thing", "New thing");

  it("gates reads by default", async () => {
    db.row = flag();
    verifyBearer.mockResolvedValue(null);
    const res = mockRes();
    const next = vi.fn();
    await mw({ method: "GET" } as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("mutationsOnly lets reads through without checking", async () => {
    const next = vi.fn();
    await requireFeature("new-thing", "New thing", { mutationsOnly: true })({ method: "GET" } as never, mockRes() as never, next);
    expect(next).toHaveBeenCalled();
    expect(verifyBearer).not.toHaveBeenCalled();
  });

  it("403s a mutation from a user who is off", async () => {
    db.row = flag();
    verifyBearer.mockResolvedValue({ user_id: U1 });
    const res = mockRes();
    const next = vi.fn();
    await mw({ method: "POST" } as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("feature_not_enabled");
  });

  it("401s an expired token instead of evaluating the caller as anonymous", async () => {
    db.row = flag({ whitelist: [U1] });
    verifyBearer.mockResolvedValue(null);
    readBearerToken.mockReturnValue("expired.jwt.token");
    const res = mockRes();
    const next = vi.fn();
    await mw({ method: "GET" } as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("allows a whitelisted user", async () => {
    db.row = flag({ whitelist: [U1] });
    verifyBearer.mockResolvedValue({ user_id: U1 });
    const next = vi.fn();
    await mw({ method: "POST" } as never, mockRes() as never, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("GET /api/gatekeeper/check/:name", () => {
  it("evaluates against the caller's own verified id", async () => {
    db.row = flag({ whitelist: [U1] });
    verifyBearer.mockResolvedValue({ user_id: U1 });
    const res = mockRes();
    await gatekeeperCheck({ params: { name: "new-thing" } } as never, res as never);
    expect(res.body).toEqual({ name: "new-thing", enabled: true });
  });

  it("never creates a row for an unknown name", async () => {
    verifyBearer.mockResolvedValue(null);
    const res = mockRes();
    await gatekeeperCheck({ params: { name: "probe-123" } } as never, res as never);
    expect(res.body).toEqual({ name: "probe-123", enabled: false });
    expect(db.upserts).toBe(0);
  });

  it("401s a present-but-invalid token instead of treating it as anonymous", async () => {
    db.row = flag({ whitelist: [U1] });
    verifyBearer.mockResolvedValue(null);
    readBearerToken.mockReturnValue("expired.jwt.token");
    const res = mockRes();
    await gatekeeperCheck({ params: { name: "new-thing" } } as never, res as never);
    expect(res.statusCode).toBe(401);
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("rejects a malformed name without a DB read", async () => {
    const res = mockRes();
    await gatekeeperCheck({ params: { name: "../etc" } } as never, res as never);
    expect(res.body).toEqual({ name: "../etc", enabled: false });
    expect(verifyBearer).not.toHaveBeenCalled();
  });
});
