import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

type Row = {
  code_hash: string;
  user_id: string;
  expires_at: string;
  used_at: string | null;
};

const state = vi.hoisted(() => ({
  authed: { user_id: "user-1", tenant_id: "t-1", access_token: "tok" } as
    | { user_id: string; tenant_id: string; access_token: string }
    | null,
  rows: [] as Row[],
  insertErr: null as { message: string } | null,
  updateErr: null as { message: string } | null,
  inserts: [] as Record<string, unknown>[],
  authUser: { id: "user-1", email: "owner@acme.com" } as
    | { id: string; email: string | null }
    | null,
  getUserErr: null as { message: string } | null,
  generateLink: {
    data: { properties: { hashed_token: "HASH_abc" } as { hashed_token: string } | null },
    error: null as { message: string } | null,
  },
  generateLinkArgs: null as Record<string, unknown> | null,
  verify: {
    data: {
      session: {
        access_token: "ACCESS_tok",
        refresh_token: "REFRESH_tok",
        expires_at: 9999,
        user: { id: "user-1" },
      } as Record<string, unknown> | null,
    },
    error: null as { message: string } | null,
  },
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (_req: Request, res: Response) => {
    if (!state.authed) {
      res.status(401).json({ error: { code: "unauthorized", message: "no" } });
      return null;
    }
    return state.authed;
  },
}));

vi.mock("@/services/tenant-client", () => {
  class UpdateChain {
    private patch: Record<string, unknown>;
    private codeHash: string | null = null;
    private requireUnused = false;
    private notBefore: string | null = null;
    constructor(patch: Record<string, unknown>) {
      this.patch = patch;
    }
    eq(col: string, val: string) {
      if (col === "code_hash") this.codeHash = val;
      return this;
    }
    is(col: string, val: null) {
      if (col === "used_at" && val === null) this.requireUnused = true;
      return this;
    }
    gt(col: string, val: string) {
      if (col === "expires_at") this.notBefore = val;
      return this;
    }
    select() {
      return this;
    }
    async maybeSingle() {
      if (state.updateErr) return { data: null, error: state.updateErr };
      const row = state.rows.find(
        (r) =>
          r.code_hash === this.codeHash &&
          (!this.requireUnused || r.used_at === null) &&
          (this.notBefore === null || r.expires_at > this.notBefore),
      );
      if (!row) return { data: null, error: null };
      Object.assign(row, this.patch);
      return { data: { user_id: row.user_id }, error: null };
    }
  }
  const sb = {
    from: () => ({
      insert: async (values: Record<string, unknown>) => {
        if (state.insertErr) return { data: null, error: state.insertErr };
        state.inserts.push(values);
        state.rows.push({
          code_hash: String(values.code_hash),
          user_id: String(values.user_id),
          expires_at: String(values.expires_at),
          used_at: null,
        });
        return { data: null, error: null };
      },
      update: (patch: Record<string, unknown>) => new UpdateChain(patch),
    }),
    auth: {
      admin: {
        getUserById: async () => ({
          data: state.authUser ? { user: state.authUser } : null,
          error: state.getUserErr,
        }),
        generateLink: async (args: Record<string, unknown>) => {
          state.generateLinkArgs = args;
          return state.generateLink;
        },
      },
    },
  };
  return { extensionAuthCodeClient: () => sb };
});

vi.mock("@/services/supabase", () => ({
  anonClient: () => ({ auth: { verifyOtp: async () => state.verify } }),
}));

import { extensionConnectStart, hashCode, CODE_TTL_MS } from "@/routes/extension/connect-start";
import { extensionConnectRedeem } from "@/routes/extension/connect-redeem";

function mockReqRes(body: unknown) {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return { req: { body } as unknown as Request, res: res as unknown as Response, res_: res };
}

async function start(body: unknown = {}) {
  const m = mockReqRes(body);
  await extensionConnectStart(m.req, m.res);
  return m.res_;
}

async function redeem(body: unknown) {
  const m = mockReqRes(body);
  await extensionConnectRedeem(m.req, m.res);
  return m.res_;
}

beforeEach(() => {
  state.authed = { user_id: "user-1", tenant_id: "t-1", access_token: "tok" };
  state.rows = [];
  state.inserts = [];
  state.insertErr = null;
  state.updateErr = null;
  state.authUser = { id: "user-1", email: "owner@acme.com" };
  state.getUserErr = null;
  state.generateLink = { data: { properties: { hashed_token: "HASH_abc" } }, error: null };
  state.generateLinkArgs = null;
  state.verify = {
    data: {
      session: {
        access_token: "ACCESS_tok",
        refresh_token: "REFRESH_tok",
        expires_at: 9999,
        user: { id: "user-1" },
      },
    },
    error: null,
  };
  delete process.env.EXTENSION_REDIRECT_URI;
  vi.useRealTimers();
});

describe("T1 happy path", () => {
  it("start mints a code, redeem exchanges it for a session, and the row is consumed", async () => {
    const s = await start();
    const { code, redirect_uri } = s.body as { code: string; redirect_uri: string };
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirect_uri).toBe(
      "https://kfgbahfijacgiigdnlaoaemdfbolabia.chromiumapp.org/callback",
    );

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].code_hash).toBe(hashCode(code));
    expect(state.rows[0].code_hash).not.toBe(code);
    expect(JSON.stringify(state.rows[0])).not.toContain(code);

    const r = await redeem({ code });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({
      access_token: "ACCESS_tok",
      refresh_token: "REFRESH_tok",
      expires_at: 9999,
    });
    expect(state.rows[0].used_at).not.toBeNull();
  });

  it("stores a 60s expiry", async () => {
    const before = Date.now();
    const s = await start();
    expect(s.statusCode).toBe(200);
    const exp = new Date(state.rows[0].expires_at).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + CODE_TTL_MS - 50);
    expect(exp).toBeLessThanOrEqual(Date.now() + CODE_TTL_MS + 50);
  });
});

describe("T2 reuse", () => {
  it("a second redeem of the same code is refused", async () => {
    const { code } = (await start()).body as { code: string };
    expect((await redeem({ code })).statusCode).toBe(200);

    const again = await redeem({ code });
    expect(again.statusCode).toBe(400);
    expect(again.body).toEqual({
      error: { code: "code_invalid", message: "That sign-in link is no longer valid." },
    });
  });
});

describe("T3 expiry", () => {
  it("a code past its expiry is refused", async () => {
    const { code } = (await start()).body as { code: string };
    state.rows[0].expires_at = new Date(Date.now() - 1_000).toISOString();

    const r = await redeem({ code });
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({
      error: { code: "code_invalid", message: "That sign-in link is no longer valid." },
    });
    expect(state.generateLinkArgs).toBeNull();
  });
});

describe("T4 /start ignores the body", () => {
  it("honours no redirect_uri, no challenge and no user_id from the body", async () => {
    const s = await start({
      redirect_uri: "https://evil.example.com/steal",
      challenge: "attacker-challenge",
      user_id: "victim-user",
      email: "victim@acme.com",
    });
    const body = s.body as { code: string; redirect_uri: string };
    expect(body.redirect_uri).toBe(
      "https://kfgbahfijacgiigdnlaoaemdfbolabia.chromiumapp.org/callback",
    );
    expect(state.rows[0].user_id).toBe("user-1");
    expect(JSON.stringify(state.inserts)).not.toContain("evil.example.com");
    expect(JSON.stringify(state.inserts)).not.toContain("attacker-challenge");
  });
});

describe("T5 server-pinned callback", () => {
  it("comes from the env override when set, never from a client", async () => {
    process.env.EXTENSION_REDIRECT_URI = "https://abcdef.chromiumapp.org/callback";
    const s = await start({ redirect_uri: "https://evil.example.com/steal" });
    expect((s.body as { redirect_uri: string }).redirect_uri).toBe(
      "https://abcdef.chromiumapp.org/callback",
    );
  });

  it("a code minted for the pinned callback still only redeems by CODE, so a tampered callback round-trips nothing", async () => {
    const { code } = (await start()).body as { code: string };
    const r = await redeem({ code: code.slice(0, -1) + (code.endsWith("A") ? "B" : "A") });
    expect(r.statusCode).toBe(400);
    expect((await redeem({ code })).statusCode).toBe(200);
  });
});

describe("T6 /start requires a session", () => {
  it("401s and writes NO row", async () => {
    state.authed = null;
    const s = await start();
    expect(s.statusCode).toBe(401);
    expect(state.rows).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });
});

describe("T7 /redeem cannot name a user or an email", () => {
  it("mints for the STORED user id, ignoring a body that claims otherwise", async () => {
    const { code } = (await start()).body as { code: string };
    const r = await redeem({
      code,
      user_id: "victim-user",
      email: "victim@acme.com",
      token_hash: "attacker-hash",
    });
    expect(r.statusCode).toBe(200);
    expect(state.generateLinkArgs).toEqual({ type: "magiclink", email: "owner@acme.com" });
  });

  it("refuses a body with no code at all, with the same shape as a bad code", async () => {
    const r = await redeem({ user_id: "victim-user" });
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({
      error: { code: "code_invalid", message: "That sign-in link is no longer valid." },
    });
  });
});

describe("T9 concurrent redeem", () => {
  it("exactly one of two simultaneous redeems wins", async () => {
    const { code } = (await start()).body as { code: string };
    const [a, b] = await Promise.all([redeem({ code }), redeem({ code })]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 400]);
  });
});

describe("T10 a user with no email", () => {
  it("is refused generically AND the code is still consumed", async () => {
    const { code } = (await start()).body as { code: string };
    state.authUser = { id: "user-1", email: null };

    const r = await redeem({ code });
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({
      error: { code: "connect_failed", message: "Sign-in didn't complete. Try again." },
    });
    expect(state.rows[0].used_at).not.toBeNull();
    expect((await redeem({ code })).statusCode).toBe(400);
  });
});

describe("T12 the minted session is asserted back to the stored user", () => {
  it("refuses when GoTrue returns a session for a different user", async () => {
    const { code } = (await start()).body as { code: string };
    (state.verify.data!.session as { user: { id: string } }).user = { id: "someone-else" };

    const r = await redeem({ code });
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({
      error: { code: "connect_failed", message: "Sign-in didn't complete. Try again." },
    });
    expect(JSON.stringify(r.body)).not.toContain("ACCESS_tok");
    expect(state.rows[0].used_at).not.toBeNull();
  });

  it("refuses when the session carries no user at all", async () => {
    const { code } = (await start()).body as { code: string };
    delete (state.verify.data!.session as Record<string, unknown>).user;
    expect((await redeem({ code })).statusCode).toBe(502);
  });
});

describe("every post-consume failure answers identically", () => {
  const GENERIC = {
    error: { code: "connect_failed", message: "Sign-in didn't complete. Try again." },
  };

  it("no email / generateLink error / verifyOtp error / identity mismatch are indistinguishable", async () => {
    const answers: unknown[] = [];

    for (const mutate of [
      () => {
        state.authUser = { id: "user-1", email: null };
      },
      () => {
        state.generateLink = { data: { properties: null }, error: { message: "boom" } };
      },
      () => {
        state.verify = { data: { session: null }, error: { message: "bad token" } };
      },
      () => {
        (state.verify.data!.session as { user: { id: string } }).user = { id: "other" };
      },
    ]) {
      state.rows = [];
      state.authUser = { id: "user-1", email: "owner@acme.com" };
      state.generateLink = { data: { properties: { hashed_token: "HASH_abc" } }, error: null };
      state.verify = {
        data: {
          session: {
            access_token: "ACCESS_tok",
            refresh_token: "REFRESH_tok",
            expires_at: 9999,
            user: { id: "user-1" },
          },
        },
        error: null,
      };
      const { code } = (await start()).body as { code: string };
      mutate();
      const r = await redeem({ code });
      expect(r.statusCode).toBe(502);
      answers.push(r.body);
    }

    for (const a of answers) expect(a).toEqual(GENERIC);
  });
});

describe("hashCode", () => {
  it("is sha256 hex and is not the code", () => {
    const h = hashCode("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
