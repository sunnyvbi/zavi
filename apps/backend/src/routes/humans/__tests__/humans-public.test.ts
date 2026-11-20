
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const USER_A = "auth-user-a";
const USER_B = "auth-user-b";
const MEMBER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const MEMBER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const { verifyBearerMock } = vi.hoisted(() => ({
  verifyBearerMock: vi.fn(async () => ({
    user_id: USER_A,
    access_token: "tok",
    session_id: null,
    claim_tenant_id: null,
  })),
}));
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: verifyBearerMock }));

type Result = { data: unknown; error: { code?: string; message?: string } | null; count?: number };
type Call = { table: string; ops: Array<{ op: string; args: unknown[] }> };

const { globalClientMock, state, calls, reset } = vi.hoisted(() => {
  const c: { list: Call[] } = { list: [] };
  const s: { queues: Record<string, Result[] | ((call: Call) => Result)> } = { queues: {} };
  const CHAIN = [
    "select", "eq", "neq", "ilike", "like", "in", "not", "order", "range", "limit",
    "insert", "update", "delete", "upsert",
  ];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      c.list.push(call);
      const result = (): Result => {
        const q = s.queues[table];
        if (typeof q === "function") return q(call);
        if (!q?.length) return { data: null, error: null };
        return q.length > 1 ? q.shift()! : q[0];
      };
      const b: Record<string, unknown> = {};
      for (const op of CHAIN) {
        b[op] = (...args: unknown[]) => {
          call.ops.push({ op, args });
          return b;
        };
      }
      b.maybeSingle = () => Promise.resolve(result());
      b.single = () => Promise.resolve(result());
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return b;
    },
  };
  return {
    globalClientMock: vi.fn(() => client),
    state: s,
    calls: c,
    reset: () => {
      c.list = [];
      s.queues = {};
      verifyBearerMock.mockReset();
      verifyBearerMock.mockResolvedValue({
        user_id: USER_A,
        access_token: "tok",
        session_id: null,
        claim_tenant_id: null,
      });
    },
  };
});
vi.mock("@/services/tenant-client", () => ({ globalClient: globalClientMock }));

import { humanMe } from "../me";
import { normalizeHandle, normalizeEmail, hashSecret } from "@/services/humans/contract";

function mockRes() {
  const res = {
    statusCode: 200,
    payload: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
  return res as any;
}
const reqWith = (body: unknown, query: Record<string, unknown> = {}) =>
  ({ body, query, params: {}, headers: {} }) as any;

const MEMBER_A_ROW = {
  id: MEMBER_A,
  auth_user_id: USER_A,
  display_name: "Nina R",
  discipline: "ugc_creator",
  skills: ["hooks"],
  rate_usd: 450,
  rate_unit: "per_deliverable",
  public_metrics: null,
  profile: { portfolio_urls: ["https://example.com/reel"], screenshots: [] },
  vetting_state: "pending",
  rejected_reason: null,
  handle_verified_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: null,
};

beforeEach(reset);

describe("auth shape — the two sides of the human seam must not be confused", () => {
  const HUMAN_DIR = join(__dirname, "..");

  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  const APPLICANT_ROUTES = [
    "applications.ts",
    "creator-signup.ts",
    "me.ts",
    "messages.ts",
    "open-briefs.ts",
  ];
  const TENANT_ROUTES = [
    "creator-hub.ts",
    "creators.ts",
    "notifications.ts",
    "orders.ts",
    "posted-briefs.ts",
    "publications.ts",
    "reviews.ts",
    "tenant.ts",
  ];
  const PUBLIC_ROUTES: string[] = [];

  const read = (f: string) => stripComments(readFileSync(join(HUMAN_DIR, f), "utf8"));

  it("every route file is classified as one side or the other", () => {
    const files = readdirSync(HUMAN_DIR).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const classified = new Set([...APPLICANT_ROUTES, ...TENANT_ROUTES, ...PUBLIC_ROUTES]);
    const unclassified = files.filter((f) => !classified.has(f));
    expect(
      unclassified,
      "new human route(s) — add each to APPLICANT_ROUTES or TENANT_ROUTES with its gate",
    ).toEqual([]);
    const onDisk = new Set(files);
    expect([...classified].filter((f) => !onDisk.has(f))).toEqual([]);
  });

  it("applicant routes verify the bearer themselves and NEVER use requireAuth", () => {
    for (const f of APPLICANT_ROUTES) {
      const src = read(f);
      expect(src, `${f} must not use requireAuth (a human member has no tenant)`).not.toMatch(
        /\brequireAuth\b/,
      );
      expect(src, `${f} must not use authMiddleware`).not.toMatch(/\bauthMiddleware\b/);
      expect(src, `${f} must verify the bearer itself`).toMatch(/\bverifyBearer\b/);
    }
  });

  it("tenant-side routes require tenant membership and NEVER use verifyBearer", () => {
    for (const f of TENANT_ROUTES) {
      const src = read(f);
      expect(src, `${f} must use requireAuth (it reads tenant business data)`).toMatch(
        /\brequireAuth\b/,
      );
      expect(
        src,
        `${f} must not use verifyBearer — it authenticates without establishing tenant membership`,
      ).not.toMatch(/\bverifyBearer\b/);
    }
  });

  it("public routes carry NEITHER gate, and read only approved creators", () => {
    for (const f of PUBLIC_ROUTES) {
      const src = read(f);
      expect(src, `${f} is public — requireAuth would 403 the visitor it is for`).not.toMatch(
        /\brequireAuth\b/,
      );
      expect(src, `${f} is public — verifyBearer would 401 the visitor it is for`).not.toMatch(
        /\bverifyBearer\b/,
      );
      expect(src, `${f} must not mount auth middleware either`).not.toMatch(/\bauthMiddleware\b/);
      expect(src, `${f} must serve approved creators only`).toMatch(/vetting_state/);
    }
  });

  it("every /api/human mount is registered with the handler alone (no auth middleware arg)", () => {
    const src = readFileSync(join(HUMAN_DIR, "..", "index.ts"), "utf8");
    const mounts = [...src.matchAll(/app\.(get|post|patch|put|delete)\(\s*"(\/api\/human[^"]*)"([^)]*)\)/g)];
    const declared = [...src.matchAll(/app\.(?:get|post|patch|put|delete)\(\s*"\/api\/human/g)];
    expect(declared.length).toBeGreaterThan(0);
    expect(mounts.length, "every /api/human mount must parse as handler-only").toBe(declared.length);
    const AUTH_MIDDLEWARE = /\b(requireAuth|authMiddleware|requireStaff|staffMiddleware|assertStaff|gateRaise)\b/;
    const ALLOWED_MIDDLEWARE = new Set(["proofUpload", "proofUploadErrorHandler"]);
    for (const m of mounts) {
      const args = m[3].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      expect(args.length, `${m[2]} must name a handler`).toBeGreaterThanOrEqual(1);
      expect(m[3], `${m[2]} must not wire an auth middleware — human verifies the bearer itself`)
        .not.toMatch(AUTH_MIDDLEWARE);
      for (const mw of args.slice(0, -1)) {
        expect(
          ALLOWED_MIDDLEWARE.has(mw),
          `${m[2]} wires undeclared middleware "${mw}" — add it to ALLOWED_MIDDLEWARE with a reason, or drop it`,
        ).toBe(true);
      }
    }
  });

});

describe("legacy signup API is gone (2026-09-25)", () => {
  it("mounts none of /api/humans/apply, /reapply, /application", () => {
    const src = readFileSync(join(__dirname, "..", "..", "index.ts"), "utf8");
    expect(src).not.toMatch(/"\/api\/humans\/(apply|reapply|application)"/);
  });
});

describe("normalizers", () => {
  it("normalizes handle case + leading @ to one comparison key", () => {
    expect(normalizeHandle("@ZaviCreator")).toBe("zavicreator");
    expect(normalizeHandle("  zavicreator ")).toBe("zavicreator");
  });

  it("normalizes gmail dot/plus aliases", () => {
    expect(normalizeEmail("Ni.na+zavi@Gmail.com")).toBe("nina@gmail.com");
    expect(normalizeEmail("nina@example.com")).toBe("nina@example.com");
  });

  it("hashes a TIN identically regardless of separators/case", () => {
    expect(hashSecret("12-3456789")).toBe(hashSecret(" 123456789 "));
  });
});

describe("GET /api/humans/me — one member can never read another's record", () => {
  it("resolves the row ONLY by the bearer-verified auth_user_id", async () => {
    state.queues.human_members = () => ({ data: MEMBER_A_ROW, error: null });
    state.queues.human_member_handles = () => ({ data: [], error: null });
    state.queues.human_member_pii = () => ({ data: null, error: null });

    const res = mockRes();
    const req = {
      body: { human_member_id: MEMBER_B, auth_user_id: USER_B },
      query: { human_member_id: MEMBER_B, id: MEMBER_B },
      params: { id: MEMBER_B },
      headers: {},
    } as any;
    await humanMe(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.member.human_member_id).toBe(MEMBER_A);

    const memberRead = calls.list.find((c) => c.table === "human_members")!;
    const eqOps = memberRead.ops.filter((o) => o.op === "eq");
    expect(eqOps).toHaveLength(1);
    expect(eqOps[0].args).toEqual(["auth_user_id", USER_A]);
    expect(JSON.stringify(calls.list.map((c) => c.ops))).not.toContain(MEMBER_B);
  });

  it("reports applied:false for a signed-in stranger rather than leaking anything", async () => {
    state.queues.human_members = () => ({ data: null, error: null });
    const res = mockRes();
    await humanMe(reqWith({}), res);
    expect(res.payload).toEqual({ applied: false, member: null });
  });

  it("never selects the hash columns", async () => {
    state.queues.human_members = () => ({ data: MEMBER_A_ROW, error: null });
    state.queues.human_member_handles = () => ({ data: [], error: null });
    state.queues.human_member_pii = () => ({ data: { human_member_id: MEMBER_A, legal_name: "Nina Rao", email: "nina@example.com" }, error: null });
    const res = mockRes();
    await humanMe(reqWith({}), res);
    const selects = calls.list.flatMap((c) => c.ops.filter((o) => o.op === "select").map((o) => String(o.args[0])));
    expect(selects.join(" ")).not.toMatch(/tin_sha256|payout_ref_hash/);
    expect(JSON.stringify(res.payload)).not.toMatch(/tin_sha256|payout_ref_hash/);
  });
});
