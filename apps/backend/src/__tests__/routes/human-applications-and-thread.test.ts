
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const BRIEF_A = "cccccccc-0000-4000-8000-000000000003";
const MEMBER_USER = "11111111-0000-4000-8000-000000000011";
const OTHER_MEMBER_USER = "22222222-0000-4000-8000-000000000022";
const TENANT_A_USER = "33333333-0000-4000-8000-000000000033";
const TENANT_B_USER = "44444444-0000-4000-8000-000000000044";
const MEMBER_ID = "55555555-0000-4000-8000-000000000055";
const OTHER_MEMBER_ID = "66666666-0000-4000-8000-000000000066";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let idSeq = 0;
const nextId = () => `f0000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`;

function resetDb(): void {
  idSeq = 0;
  db.human_members = [
    {
      id: MEMBER_ID,
      auth_user_id: MEMBER_USER,
      display_name: "Approved Member",
      discipline: "ugc_creator",
      vetting_state: "approved",
      lanes: ["ugc_video"],
      country_code: "US",
    },
    {
      id: OTHER_MEMBER_ID,
      auth_user_id: OTHER_MEMBER_USER,
      display_name: "Other Member",
      discipline: "ugc_creator",
      vetting_state: "approved",
      lanes: ["ugc_video"],
      country_code: "US",
    },
  ];
  db.creator_briefs = [
    {
      id: BRIEF_A,
      tenant_id: TENANT_A,
      utm_campaign: "zavi-brief-abc123def456",
      status: "sent",
      title: "3 ad videos",
      angle: "a",
      hook: "h",
      format: "9:16",
      deliverables: 3,
      budget_usd: 450,
      lane: "ugc_video",
      delivery_days: 7,
      posted_at: "2026-09-11T00:00:00.000Z",
      answer_by: "2999-01-01T00:00:00.000Z",
      applicant_cap: 20,
      closed_at: null,
      ad_rights_days: null,
    },
  ];
  db.tenant_users = [
    { tenant_id: TENANT_A, user_id: TENANT_A_USER, role: "owner" },
    { tenant_id: TENANT_B, user_id: TENANT_B_USER, role: "owner" },
  ];
  db.brief_applications = [];
  db.engagements = [];
  db.engagement_messages = [];
  db.decisions = [];
}

class PgError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function enforceUnique(table: string, row: Row): void {
  if (table === "brief_applications") {
    const dupe = db.brief_applications.some(
      (r) =>
        r.tenant_id === row.tenant_id &&
        r.brief_kind === row.brief_kind &&
        r.brief_id === row.brief_id &&
        r.human_member_id === row.human_member_id,
    );
    if (dupe) {
      throw new PgError(
        "23505",
        'duplicate key value violates unique constraint "brief_applications_tenant_id_brief_kind_brief_id_human_memb_key"',
      );
    }
  }
  if (table === "engagements" && row.application_id) {
    const dupe = db.engagements.some((r) => r.application_id === row.application_id);
    if (dupe) {
      throw new PgError(
        "23505",
        'duplicate key value violates unique constraint "engagements_application_id_key"',
      );
    }
  }
}

type Thenable = {
  eq: (k: string, v: unknown) => Thenable;
  order: () => Thenable;
  limit: () => Thenable;
  select: () => Thenable;
  maybeSingle: () => Thenable;
  then: (resolve: (v: { data: unknown; error: unknown }) => void) => void;
};

function query(rowsFor: () => Row[]): Thenable {
  const filters: Array<[string, unknown]> = [];
  let single = false;
  const q: Thenable = {
    eq(k, v) {
      filters.push([k, v]);
      return q;
    },
    order: () => q,
    limit: () => q,
    select: () => q,
    maybeSingle() {
      single = true;
      return q;
    },
    then(resolve) {
      const rows = rowsFor().filter((r) => filters.every(([k, v]) => r[k] === v));
      resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
    },
  };
  return q;
}

function writeResult(data: unknown, error: unknown): Thenable {
  const q: Thenable = {
    eq: () => q,
    order: () => q,
    limit: () => q,
    select: () => q,
    maybeSingle: () => q,
    then: (resolve) => resolve({ data, error }),
  };
  return q;
}

function scopedTable(table: string, tid: string) {
  return {
    select: () => query(() => (db[table] ?? []).filter((r) => r.tenant_id === tid)),
    insert(row: Row) {
      if (row.tenant_id !== undefined && row.tenant_id !== tid) {
        return writeResult(null, new Error("cross-tenant write attempt"));
      }
      const created: Row = { id: nextId(), ...row, tenant_id: tid };
      try {
        enforceUnique(table, created);
      } catch (e) {
        return writeResult(null, e);
      }
      (db[table] ??= []).push(created);
      return writeResult(created, null);
    },
    update(values: Row) {
      const filters: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      const q = {
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return q;
        },
        in(k: string, vs: unknown[]) {
          ins.push([k, vs]);
          return q;
        },
        then(resolve: (v: { data: unknown; error: unknown }) => void) {
          for (const r of db[table] ?? []) {
            if (r.tenant_id !== tid) continue;
            if (!filters.every(([k, v]) => r[k] === v)) continue;
            if (!ins.every(([k, vs]) => vs.includes(r[k]))) continue;
            Object.assign(r, values);
          }
          resolve({ data: null, error: null });
        },
      };
      return q;
    },
    delete() {
      const filters: Array<[string, unknown]> = [];
      const q = {
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return q;
        },
        then(resolve: (v: { data: unknown; error: unknown }) => void) {
          db[table] = (db[table] ?? []).filter(
            (r) => !(r.tenant_id === tid && filters.every(([k, v]) => r[k] === v)),
          );
          resolve({ data: null, error: null });
        },
      };
      return q;
    },
  };
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (tid: string) => ({ from: (table: string) => scopedTable(table, tid) }),
  globalClient: () => ({
    from: (table: string) => {
      if (table !== "human_members") throw new Error(`globalClient: '${table}' is not global`);
      return query(() => db.human_members);
    },
  }),
  preTenantRpc: (name: string, args: Record<string, unknown>) => {
    if (name === "human_resolve_brief") {
      const rows =
        args.p_brief_kind === "creative"
          ? db.creator_briefs
              .filter((b) => b.id === args.p_brief_id)
              .map((b) => ({ tenant_id: b.tenant_id, utm_campaign: b.utm_campaign, status: b.status }))
          : [];
      return Promise.resolve({ data: rows, error: null });
    }
    if (name === "human_resolve_application") {
      const rows = db.brief_applications
        .filter((a) => a.id === args.p_application_id)
        .map((a) => ({
          tenant_id: a.tenant_id,
          brief_kind: a.brief_kind,
          brief_id: a.brief_id,
          human_member_id: a.human_member_id,
          status: a.status,
        }));
      return Promise.resolve({ data: rows, error: null });
    }
    throw new Error(`preTenantRpc: '${name}' is not in the pre-tenant RPC allowlist`);
  },
  tenantRpc: (tid: string, name: string, args: Record<string, unknown>) => {
    if (name !== "emit_decision") throw new Error(`unexpected rpc ${name}`);
    const id = nextId();
    db.decisions.push({
      id,
      tenant_id: tid,
      decision_class: args.p_decision_class,
      body: args.p_body,
      status: "proposed",
    });
    return Promise.resolve({ data: id, error: null });
  },
}));

let _bearerUser: string | null = MEMBER_USER;
vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: vi.fn(async () =>
    _bearerUser ? { user_id: _bearerUser, session_id: "s", active_tenant_id: null } : null,
  ),
}));

vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRoleFor: vi.fn(async (user_id: string, tenant_id: string) => {
    const row = db.tenant_users.find((r) => r.user_id === user_id && r.tenant_id === tenant_id);
    return (row?.role as string | undefined) ?? null;
  }),
}));

const logEventMock = vi.fn(async () => undefined);
vi.mock("@/services/logging/logEvent", () => ({ logEvent: () => logEventMock() }));

const notifyMock = vi.fn(async () => ({ written: true, emailed: true }));
vi.mock("@/services/creators/notify", () => ({ notify: (...a: unknown[]) => notifyMock(...(a as [])) }));

const closeBriefMock = vi.fn(async () => null);
vi.mock("@/services/creators/briefs-db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/creators/briefs-db")>();
  const boardRow = (b: Row) => ({
    id: b.id,
    title: b.title,
    angle: b.angle,
    hook: b.hook,
    format: b.format,
    deliverables: b.deliverables,
    budget_usd: b.budget_usd,
    lane: b.lane,
    delivery_days: b.delivery_days,
    posted_at: b.posted_at,
    answer_by: b.answer_by,
    applicant_cap: b.applicant_cap,
    closed_at: b.closed_at,
    ad_rights_days: b.ad_rights_days,
  });
  return {
    ...real,
    loadBoardMemberByAuthUser: async (auth_user_id: string) => {
      const m = db.human_members.find((r) => r.auth_user_id === auth_user_id);
      return m
        ? { id: m.id, display_name: m.display_name, vetting_state: m.vetting_state, lanes: m.lanes ?? null, country_code: m.country_code ?? null }
        : null;
    },
    loadBoardBrief: async (id: string) => {
      const b = db.creator_briefs.find((r) => r.id === id && r.posted_at);
      return b ? boardRow(b) : null;
    },
    resolveBriefTenant: async (id: string) => {
      const b = db.creator_briefs.find((r) => r.id === id);
      return b ? { tenant_id: b.tenant_id as string, status: b.status as string } : null;
    },
    countBriefApplications: async (tid: string, brief_id: string) =>
      db.brief_applications.filter((a) => a.tenant_id === tid && a.brief_id === brief_id).length,
    insertBriefApplication: async (a: { tenant_id: string; brief_id: string; human_member_id: string; pitch: string | null; quoted_rate_usd: number }) => {
      const res = await new Promise<{ data: unknown; error: unknown }>((resolve) =>
        scopedTable("brief_applications", a.tenant_id)
          .insert({
            brief_kind: "creative",
            brief_id: a.brief_id,
            human_member_id: a.human_member_id,
            status: "applied",
            pitch: a.pitch,
            quoted_rate_usd: a.quoted_rate_usd,
          })
          .then(resolve),
      );
      if (res.error) return { ok: false as const, duplicate: true as const };
      return { ok: true as const, application_id: (res.data as Row).id as string };
    },
    resolveBusinessName: async () => "Northwind Coffee",
    closeTenantBrief: (...a: unknown[]) => closeBriefMock(...(a as [])),
  };
});

import {
  settleHumanApplicationDecision,
  HUMAN_APPLICATION_REVIEW_CLASS,
} from "@/services/humans/applications";
import { postHumanApplication } from "../../routes/humans/applications";
import {
  getHumanApplicationMessages,
  postHumanApplicationMessage,
} from "../../routes/humans/messages";

function mockResponse(): Response & { _inspect: () => { statusCode: number; body: any } } {
  let statusCode = 200;
  let body: unknown = null;
  const res: Partial<Response> = {
    status: vi.fn((c: number) => {
      statusCode = c;
      return res as Response;
    }),
    json: vi.fn((obj: unknown) => {
      body = obj;
      return res as Response;
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any)._inspect = () => ({ statusCode, body });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res as any;
}

const req = (body: unknown, params: Record<string, string> = {}) =>
  ({ body, params, headers: {} }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  resetDb();
  _bearerUser = MEMBER_USER;
});

async function applyOnce(overrides: Record<string, unknown> = {}) {
  const res = mockResponse();
  await postHumanApplication(
    req({ brief_kind: "creative", brief_id: BRIEF_A, pitch: "I shoot UGC", quoted_rate_usd: 150, ...overrides }),
    res,
  );
  return res._inspect();
}

function decisionFor(application_id: string): string {
  const d = db.decisions.find(
    (r) =>
      r.decision_class === HUMAN_APPLICATION_REVIEW_CLASS &&
      (r.body as Row).application_id === application_id,
  );
  if (!d) throw new Error("no review decision emitted");
  return d.id as string;
}

describe("legacy apply route goes through the real brief apply guards", () => {
  it("writes the application under the BRIEF's tenant and emits no review card", async () => {
    const r = await applyOnce({ tenant_id: TENANT_B });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, application_id: db.brief_applications[0].id, status: "applied" });
    expect(db.brief_applications).toHaveLength(1);
    expect(db.brief_applications[0].tenant_id).toBe(TENANT_A);
    expect(db.brief_applications[0].human_member_id).toBe(MEMBER_ID);
    expect(db.brief_applications[0].quoted_rate_usd).toBe(150);
    expect(db.decisions).toEqual([]);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  const refused: Array<[string, () => void, Record<string, unknown>, number, string]> = [
    ["a brief closed by a hire while its status still reads sent", () => {
      db.creator_briefs[0].closed_at = "2026-09-12T00:00:00.000Z";
    }, {}, 409, "brief_closed"],
    ["a brief past its answer-by date", () => {
      db.creator_briefs[0].answer_by = "2026-09-12T00:00:00.000Z";
    }, {}, 409, "brief_closed"],
    ["a draft that was never posted", () => {
      db.creator_briefs[0].posted_at = null;
      db.creator_briefs[0].status = "draft";
    }, {}, 404, "brief_not_found"],
    ["a brief at its applicant cap", () => {
      db.creator_briefs[0].applicant_cap = 1;
      db.brief_applications.push({ id: "f9999999-0000-4000-8000-000000000999", tenant_id: TENANT_A, brief_kind: "creative", brief_id: BRIEF_A, human_member_id: OTHER_MEMBER_ID, status: "applied" });
    }, {}, 409, "cap_reached"],
    ["a creator Zavi cannot pay", () => {
      db.human_members[0].country_code = "NG";
    }, {}, 403, "payout_country_unsupported"],
    ["a quote of zero", () => {}, { quoted_rate_usd: 0 }, 400, "invalid_quote"],
    ["no quote at all", () => {}, { quoted_rate_usd: undefined }, 400, "invalid_quote"],
    ["a quote below the smallest amount Stripe can charge", () => {}, { quoted_rate_usd: 0.1 }, 400, "quote_below_minimum"],
    ["a creator whose lanes do not include the brief's lane", () => {
      db.human_members[0].lanes = ["audience_post"];
    }, {}, 403, "lane_mismatch"],
    ["a member still in vetting", () => {
      db.human_members[0].vetting_state = "pending";
    }, {}, 403, "not_approved"],
  ];
  for (const [what, arrange, body, status, code] of refused) {
    it(`refuses ${what}, writing nothing and emitting no card`, async () => {
      arrange();
      const before = db.brief_applications.length;
      const r = await applyOnce(body);
      expect(r.statusCode).toBe(status);
      expect(r.body.error.code).toBe(code);
      expect(db.brief_applications).toHaveLength(before);
      expect(db.decisions).toHaveLength(0);
      expect(notifyMock).not.toHaveBeenCalled();
    });
  }

  it("a user who is not a creator at all cannot apply", async () => {
    _bearerUser = TENANT_A_USER;
    const r = await applyOnce();
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("not_a_creator");
    expect(db.brief_applications).toHaveLength(0);
  });

  it("401 without a bearer", async () => {
    _bearerUser = null;
    const r = await applyOnce();
    expect(r.statusCode).toBe(401);
  });

  it("scrubs contact details out of the pitch before the business can read it", async () => {
    const r = await applyOnce({ pitch: "text me on 555 123 4567 or maya@gmail.com, I shoot handovers" });
    expect(r.statusCode).toBe(200);
    const stored = String(db.brief_applications[0].pitch);
    expect(stored).not.toContain("maya@gmail.com");
    expect(stored).not.toContain("4567");
    expect(stored).toContain("I shoot handovers");
  });

  it("a second apply is a CLEAN TYPED error, not a unique-violation dump", async () => {
    const first = await applyOnce();
    expect(first.statusCode).toBe(200);

    const second = await applyOnce();
    expect(second.statusCode).toBe(409);
    expect(second.body.error.code).toBe("already_applied");
    const text = JSON.stringify(second.body);
    expect(text).not.toMatch(/23505/);
    expect(text).not.toMatch(/duplicate key value/i);
    expect(text).not.toMatch(/constraint/i);
    expect(db.brief_applications).toHaveLength(1);
    expect(db.decisions).toHaveLength(0);
  });
});

function seedLegacyCard(): string {
  const application_id = nextId();
  db.brief_applications.push({
    id: application_id,
    tenant_id: TENANT_A,
    brief_kind: "creative",
    brief_id: BRIEF_A,
    human_member_id: MEMBER_ID,
    status: "applied",
    pitch: "I shoot UGC",
    quoted_rate_usd: 150,
  });
  db.decisions.push({
    id: nextId(),
    tenant_id: TENANT_A,
    decision_class: HUMAN_APPLICATION_REVIEW_CLASS,
    body: { application_id },
    status: "proposed",
  });
  return application_id;
}

describe("S6 legacy review card — approve never marks an application hired without an order", () => {
  it("approving an old card leaves the application applied, creates nothing, and does not throw", async () => {
    const application_id = seedLegacyCard();
    const decision_id = decisionFor(application_id);
    const ordersBefore = JSON.stringify(db.creator_orders ?? []);

    const first = await settleHumanApplicationDecision({ decision_id, tenant_id: TENANT_A, action: "approve" });
    const second = await settleHumanApplicationDecision({ decision_id, tenant_id: TENANT_A, action: "approve" });

    for (const out of [first, second]) {
      expect(out).toEqual({ handled: true, application_id, engagement_id: null });
    }
    expect(db.brief_applications[0].status).toBe("applied");
    expect(db.brief_applications[0].updated_at).toBeUndefined();
    expect(db.engagements).toHaveLength(0);
    expect(JSON.stringify(db.creator_orders ?? [])).toBe(ordersBefore);
  });

  it("approving an old card leaves a shortlisted application shortlisted", async () => {
    const application_id = seedLegacyCard();
    db.brief_applications[0].status = "shortlisted";
    await settleHumanApplicationDecision({
      decision_id: decisionFor(application_id),
      tenant_id: TENANT_A,
      action: "approve",
    });
    expect(db.brief_applications[0].status).toBe("shortlisted");
    expect(db.engagements).toHaveLength(0);
  });

  it("rejecting an old card after the creator was hired through Checkout leaves the hire alone", async () => {
    const application_id = seedLegacyCard();
    db.brief_applications[0].status = "approved";
    const out = await settleHumanApplicationDecision({
      decision_id: decisionFor(application_id),
      tenant_id: TENANT_A,
      action: "reject",
    });
    expect(out).toEqual({ handled: true, application_id, engagement_id: null });
    expect(db.brief_applications[0].status).toBe("approved");
  });

  it("reject flips the application and creates NO engagement", async () => {
    const application_id = seedLegacyCard();
    const out = await settleHumanApplicationDecision({
      decision_id: decisionFor(application_id),
      tenant_id: TENANT_A,
      action: "reject",
    });
    expect(out.handled).toBe(true);
    expect(db.brief_applications[0].status).toBe("rejected");
    expect(db.engagements).toHaveLength(0);
  });

  it("no-ops for a decision of any OTHER class (the route calls it unconditionally)", async () => {
    db.decisions.push({
      id: "d0000000-0000-4000-8000-000000000099",
      tenant_id: TENANT_A,
      decision_class: "send_email",
      body: {},
      status: "proposed",
    });
    const out = await settleHumanApplicationDecision({
      decision_id: "d0000000-0000-4000-8000-000000000099",
      tenant_id: TENANT_A,
      action: "approve",
    });
    expect(out.handled).toBe(false);
    expect(db.engagements).toHaveLength(0);
  });

  it("a THIRD-PARTY tenant cannot settle another tenant's human decision", async () => {
    const decision_id = decisionFor(seedLegacyCard());
    const out = await settleHumanApplicationDecision({
      decision_id,
      tenant_id: TENANT_B,
      action: "approve",
    });
    expect(out.handled).toBe(false);
    expect(db.engagements).toHaveLength(0);
    expect(db.brief_applications[0].status).toBe("applied");
  });
});

describe("S7 thread — both sides in, everyone else out", () => {
  async function seedApplication(): Promise<string> {
    await applyOnce();
    return db.brief_applications[0].id as string;
  }

  it("the human member who applied can read and write", async () => {
    const application_id = await seedApplication();
    _bearerUser = MEMBER_USER;

    const post = mockResponse();
    await postHumanApplicationMessage(req({ body: "Can I use vertical 9:16?" }, { application_id }), post);
    expect(post._inspect().statusCode).toBe(200);

    const get = mockResponse();
    await getHumanApplicationMessages(req({}, { application_id }), get);
    const g = get._inspect();
    expect(g.statusCode).toBe(200);
    expect(g.body.messages).toHaveLength(1);
    expect(g.body.sender_kind).toBe("human_member");
  });

  it("a member of the OWNING tenant can read and write, as 'tenant'", async () => {
    const application_id = await seedApplication();
    _bearerUser = TENANT_A_USER;

    const post = mockResponse();
    await postHumanApplicationMessage(req({ body: "Yes, 9:16." }, { application_id }), post);
    expect(post._inspect().statusCode).toBe(200);
    expect(post._inspect().body.message.sender_kind).toBe("tenant");

    const get = mockResponse();
    await getHumanApplicationMessages(req({}, { application_id }), get);
    expect(get._inspect().body.sender_kind).toBe("tenant");
  });

  it("a THIRD-PARTY tenant cannot read the thread (404, no content leak)", async () => {
    const application_id = await seedApplication();
    _bearerUser = MEMBER_USER;
    await postHumanApplicationMessage(
      req({ body: "secret rate negotiation" }, { application_id }),
      mockResponse(),
    );

    _bearerUser = TENANT_B_USER;
    const get = mockResponse();
    await getHumanApplicationMessages(req({}, { application_id }), get);
    const g = get._inspect();
    expect(g.statusCode).toBe(404);
    expect(JSON.stringify(g.body)).not.toMatch(/secret rate negotiation/);
    expect(g.body.error.code).toBe("not_found");
  });

  it("a THIRD-PARTY tenant cannot WRITE into the thread", async () => {
    const application_id = await seedApplication();
    _bearerUser = TENANT_B_USER;
    const post = mockResponse();
    await postHumanApplicationMessage(req({ body: "hello" }, { application_id }), post);
    expect(post._inspect().statusCode).toBe(404);
    expect(db.engagement_messages).toHaveLength(0);
  });

  it("a DIFFERENT human member cannot read the thread", async () => {
    const application_id = await seedApplication();
    _bearerUser = OTHER_MEMBER_USER;
    const get = mockResponse();
    await getHumanApplicationMessages(req({}, { application_id }), get);
    expect(get._inspect().statusCode).toBe(404);
  });

  it("a DIFFERENT human member cannot write into the thread", async () => {
    const application_id = await seedApplication();
    _bearerUser = OTHER_MEMBER_USER;
    const post = mockResponse();
    await postHumanApplicationMessage(req({ body: "hi" }, { application_id }), post);
    expect(post._inspect().statusCode).toBe(404);
    expect(db.engagement_messages).toHaveLength(0);
  });

  it("sender_kind CANNOT be spoofed from the request body", async () => {
    const application_id = await seedApplication();
    _bearerUser = MEMBER_USER;
    const post = mockResponse();
    await postHumanApplicationMessage(
      req({ body: "posting as the customer", sender_kind: "tenant" }, { application_id }),
      post,
    );
    expect(post._inspect().statusCode).toBe(200);
    expect(post._inspect().body.message.sender_kind).toBe("human_member");
    expect(db.engagement_messages[0].sender_kind).toBe("human_member");
  });

  it("sender_user_id is the bearer subject, not a body field", async () => {
    const application_id = await seedApplication();
    _bearerUser = MEMBER_USER;
    await postHumanApplicationMessage(
      req({ body: "hi", sender_user_id: TENANT_A_USER }, { application_id }),
      mockResponse(),
    );
    expect(db.engagement_messages[0].sender_user_id).toBe(MEMBER_USER);
  });

  it("rejects an empty or over-long body", async () => {
    const application_id = await seedApplication();
    _bearerUser = MEMBER_USER;

    const empty = mockResponse();
    await postHumanApplicationMessage(req({ body: "   " }, { application_id }), empty);
    expect(empty._inspect().statusCode).toBe(400);

    const long = mockResponse();
    await postHumanApplicationMessage(req({ body: "x".repeat(4001) }, { application_id }), long);
    expect(long._inspect().statusCode).toBe(400);

    expect(db.engagement_messages).toHaveLength(0);
  });

  it("401 without a bearer, before any application lookup", async () => {
    const application_id = await seedApplication();
    _bearerUser = null;
    const get = mockResponse();
    await getHumanApplicationMessages(req({}, { application_id }), get);
    expect(get._inspect().statusCode).toBe(401);
  });

  it("stores, returns and re-reads a message with contact details removed, on both sides", async () => {
    const application_id = await seedApplication();
    const R = "[contact removed, keep it on Zavi]";

    _bearerUser = MEMBER_USER;
    const post = mockResponse();
    await postHumanApplicationMessage(
      req({ body: "dm me maya@gmail.com or 555 123 4567, 3 videos for $150 in 5 days" }, { application_id }),
      post,
    );
    expect(post._inspect().statusCode).toBe(200);
    expect(post._inspect().body.message.body).toBe(`dm me ${R} or ${R}, 3 videos for $150 in 5 days`);

    _bearerUser = TENANT_A_USER;
    const reply = mockResponse();
    await postHumanApplicationMessage(
      req({ body: "book on calendly.com/acme or ship to 789 Mission Street" }, { application_id }),
      reply,
    );
    expect(reply._inspect().body.message.body).toBe(`book on ${R} or ship to ${R}`);

    expect(db.engagement_messages.map((m) => m.body)).toEqual([
      `dm me ${R} or ${R}, 3 videos for $150 in 5 days`,
      `book on ${R} or ship to ${R}`,
    ]);

    const get = mockResponse();
    await getHumanApplicationMessages(req({}, { application_id }), get);
    const text = JSON.stringify(get._inspect().body);
    for (const raw of ["maya@gmail.com", "4567", "calendly", "Mission"]) {
      expect(text).not.toContain(raw);
    }
    expect(JSON.stringify(db.engagement_messages)).not.toContain("maya@gmail.com");
    expect(logEventMock).toHaveBeenCalledTimes(2);
  });

  it("logs a contact-exchange counter when contact details are shared", async () => {
    const application_id = await seedApplication();
    _bearerUser = MEMBER_USER;
    await postHumanApplicationMessage(
      req({ body: "email me at hire@example.com" }, { application_id }),
      mockResponse(),
    );
    expect(logEventMock).toHaveBeenCalled();

    logEventMock.mockClear();
    await postHumanApplicationMessage(
      req({ body: "sounds good, starting today" }, { application_id }),
      mockResponse(),
    );
    expect(logEventMock).not.toHaveBeenCalled();
  });
});
