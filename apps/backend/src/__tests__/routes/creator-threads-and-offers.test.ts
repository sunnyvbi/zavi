
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const CREATOR_USER = "11111111-0000-4000-8000-000000000011";
const OTHER_CREATOR_USER = "22222222-0000-4000-8000-000000000022";
const TENANT_A_USER = "33333333-0000-4000-8000-000000000033";
const TENANT_B_USER = "44444444-0000-4000-8000-000000000044";
const CREATOR_ID = "55555555-0000-4000-8000-000000000055";
const OTHER_CREATOR_ID = "66666666-0000-4000-8000-000000000066";
const PENDING_CREATOR_ID = "77777777-0000-4000-8000-000000000077";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let idSeq = 0;
const nextId = () => `f0000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`;

function resetDb(): void {
  idSeq = 0;
  db.human_members = [
    { id: CREATOR_ID, auth_user_id: CREATOR_USER, display_name: "Approved Creator", vetting_state: "approved" },
    { id: OTHER_CREATOR_ID, auth_user_id: OTHER_CREATOR_USER, display_name: "Other Creator", vetting_state: "approved" },
    { id: PENDING_CREATOR_ID, auth_user_id: null, display_name: "Pending Creator", vetting_state: "pending" },
  ];
  db.tenant_users = [
    { tenant_id: TENANT_A, user_id: TENANT_A_USER, role: "owner" },
    { tenant_id: TENANT_B, user_id: TENANT_B_USER, role: "owner" },
  ];
  db.creator_threads = [];
  db.creator_thread_messages = [];
  db.creator_offers = [];
  db.creator_orders = [];
}

type Op = "select" | "insert" | "update";

function makeQuery(table: string, tid: string, op: Op, payload?: Row) {
  const filters: Array<[string, unknown]> = [];
  let single = false;
  let orderKey: string | null = null;
  let asc = true;

  const scoped = () => (db[table] ?? []).filter((r) => r.tenant_id === tid);
  const matched = () => {
    let rows = scoped().filter((r) => filters.every(([k, v]) => r[k] === v));
    if (orderKey) {
      const key = orderKey;
      rows = [...rows].sort((a, b) => {
        const x = String(a[key] ?? "");
        const y = String(b[key] ?? "");
        return asc ? x.localeCompare(y) : y.localeCompare(x);
      });
    }
    return rows;
  };

  function run(): { data: unknown; error: unknown } {
    if (op === "select") {
      const rows = matched();
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }
    if (op === "insert") {
      const row = payload ?? {};
      if (row.tenant_id !== undefined && row.tenant_id !== tid) {
        return { data: null, error: new Error("cross-tenant write attempt") };
      }
      const now = new Date(Date.now() + idSeq).toISOString();
      const created: Row = { created_at: now, updated_at: now, ...row, id: nextId(), tenant_id: tid };
      (db[table] ??= []).push(created);
      return { data: single ? created : [created], error: null };
    }
    const hits = matched();
    for (const r of hits) Object.assign(r, payload ?? {});
    return { data: single ? (hits[0] ?? null) : hits, error: null };
  }

  const q: Record<string, unknown> = {};
  Object.assign(q, {
    eq(k: string, v: unknown) {
      filters.push([k, v]);
      return q;
    },
    order(k: string, o?: { ascending?: boolean }) {
      orderKey = k;
      asc = o?.ascending !== false;
      return q;
    },
    limit() {
      return q;
    },
    select() {
      return q;
    },
    maybeSingle() {
      single = true;
      return q;
    },
    then(onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
      return Promise.resolve(run()).then(onF as never, onR as never);
    },
  });
  return q;
}

function scopedTable(table: string, tid: string) {
  return {
    select: () => makeQuery(table, tid, "select"),
    insert: (row: Row) => makeQuery(table, tid, "insert", row),
    update: (values: Row) => makeQuery(table, tid, "update", values),
  };
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: (tid: string) => ({ from: (table: string) => scopedTable(table, tid) }),
  globalClient: () => ({
    from: (table: string) => {
      if (table !== "human_members") throw new Error(`globalClient: '${table}' is not global`);
      const filters: Array<[string, unknown]> = [];
      let single = false;
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        then(onF?: (v: unknown) => unknown) {
          const rows = db.human_members.filter((r) => filters.every(([k, v]) => r[k] === v));
          return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(
            onF as never,
          );
        },
      });
      return q;
    },
  }),
  preTenantRpc: (name: string, args: Record<string, unknown>) => {
    if (name === "creator_resolve_thread") {
      const rows = db.creator_threads
        .filter((t) => t.id === args.p_thread_id)
        .map((t) => ({
          tenant_id: t.tenant_id,
          human_member_id: t.human_member_id,
          started_by: t.started_by,
        }));
      return Promise.resolve({ data: rows, error: null });
    }
    if (name === "creator_resolve_offer") {
      const rows = db.creator_offers
        .filter((o) => o.id === args.p_offer_id)
        .map((o) => ({
          tenant_id: o.tenant_id,
          human_member_id: o.human_member_id,
          thread_id: o.thread_id,
          proposed_by: o.proposed_by,
          status: o.status,
          expires_at: o.expires_at,
        }));
      return Promise.resolve({ data: rows, error: null });
    }
    throw new Error(`preTenantRpc: '${name}' is not in the pre-tenant RPC allowlist`);
  },
}));

let _bearerUser: string | null = CREATOR_USER;
vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: vi.fn(async () =>
    _bearerUser ? { user_id: _bearerUser, access_token: "tok", email: null, session_id: "s" } : null,
  ),
}));

let _authTenant: string | null = TENANT_A;
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!_bearerUser || !_authTenant) {
      res.status(401).json({ error: { code: "unauthenticated", message: "no" } });
      return null;
    }
    return { user_id: _bearerUser, tenant_id: _authTenant, access_token: "tok" };
  }),
}));

vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRoleFor: vi.fn(async (user_id: string, tenant_id: string) => {
    const row = db.tenant_users.find((r) => r.user_id === user_id && r.tenant_id === tenant_id);
    return (row?.role as string | undefined) ?? null;
  }),
}));

const notifyCalls: Array<Record<string, unknown>> = [];
vi.mock("@/services/creators/notify", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/creators/notify")>();
  return {
    ...real,
    notify: vi.fn(async (input: Record<string, unknown>) => {
      notifyCalls.push(input);
      return { written: true, emailed: true, notification_id: "n1", dedupe_key: String(input.dedupe_key ?? "") };
    }),
  };
});

const logEventMock = vi.fn(async (_input?: { code?: string; message?: string }) => undefined);
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (input: { code?: string; message?: string }) => logEventMock(input),
}));

import { computeCreatorFees } from "@/services/creators/order-fees";
import { scrubContact, CONTACT_REDACTION } from "@/services/creators/contact-scrub";
import {
  __setCreatorMoneyPortForTest,
  resolveCreatorMoneyPort,
  type PlaceHoldForOfferInput,
} from "@/services/creators/money-port";
import {
  acceptCreatorOffer,
  createCreatorOffer,
  isOfferExpired,
  offerExpiresAt,
  OFFER_TTL_HOURS,
} from "@/services/creators/offers";
import { ensureCreatorThread } from "@/services/creators/thread";
import {
  getCreatorThreadMessages,
  openCreatorThread,
  postCreatorThreadMessageRoute,
} from "@/routes/creators/threads";
import {
  acceptCreatorOfferRoute,
  getCreatorOffer,
  postStorefrontOffer,
  postThreadOffer,
} from "@/routes/creators/offers";

type FakeRes = Response & { statusCode: number; body: unknown };
function mkRes(): FakeRes {
  const r = { statusCode: 200, body: undefined } as unknown as FakeRes;
  r.status = ((code: number) => {
    r.statusCode = code;
    return r;
  }) as never;
  r.json = ((payload: unknown) => {
    r.body = payload;
    return r;
  }) as never;
  return r;
}

function mkReq(params: Record<string, string>, body?: unknown): Request {
  return { params, body, headers: {} } as unknown as Request;
}

let portCalls: PlaceHoldForOfferInput[] = [];
function installFakePort(): void {
  portCalls = [];
  __setCreatorMoneyPortForTest({
    async placeHoldForOffer(input) {
      portCalls.push(input);
      const existing = db.creator_orders.find((o) => o.offer_id === input.offer_id);
      if (existing) {
        return { order_id: existing.id as string, status: "awaiting_acceptance", already_existed: true };
      }
      const row: Row = {
        id: nextId(),
        tenant_id: input.tenant_id,
        offer_id: input.offer_id,
        thread_id: input.thread_id,
        status: "awaiting_acceptance",
      };
      db.creator_orders.push(row);
      return { order_id: row.id as string, status: "awaiting_acceptance", already_existed: false };
    },
  });
}

const TERMS = { video_count: 2, video_length_seconds: 30, ad_rights_days: 90 };

async function seedThread(): Promise<string> {
  const t = await ensureCreatorThread({
    tenant_id: TENANT_A,
    human_member_id: CREATOR_ID,
    started_by: "tenant",
    started_by_user_id: TENANT_A_USER,
  });
  return t.id;
}

beforeEach(() => {
  resetDb();
  notifyCalls.length = 0;
  installFakePort();
  logEventMock.mockClear();
  _bearerUser = CREATOR_USER;
  _authTenant = TENANT_A;
});

describe("S8 — pre-booking thread is reused, never duplicated", () => {
  it("opening a thread twice from a storefront returns the SAME thread", async () => {
    _bearerUser = TENANT_A_USER;
    const res1 = mkRes();
    await openCreatorThread(mkReq({ human_member_id: CREATOR_ID }, { body: "Hi, are you free?" }), res1);
    const res2 = mkRes();
    await openCreatorThread(mkReq({ human_member_id: CREATOR_ID }, { body: "Following up." }), res2);

    const first = (res1.body as { thread: { id: string } }).thread;
    const second = (res2.body as { thread: { id: string } }).thread;
    expect(second.id).toBe(first.id);
    expect(db.creator_threads).toHaveLength(1);
    expect(db.creator_thread_messages).toHaveLength(2);
  });

  it("that same thread becomes the job thread: the order carries its id", async () => {
    const threadId = await seedThread();
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
    });

    const result = await acceptCreatorOffer({
      access: { tenant_id: TENANT_A, sender_kind: "tenant", human_member_id: CREATOR_ID },
      offer_id: offer.id,
    });

    expect(result.ok).toBe(true);
    expect(portCalls[0]?.thread_id).toBe(threadId);
    expect(db.creator_threads).toHaveLength(1);
  });

  it("an offer sent straight from a storefront attaches to the pair's existing thread", async () => {
    const threadId = await seedThread();
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "tenant",
      proposed_by_user_id: TENANT_A_USER,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
    });
    expect(offer.thread_id).toBe(threadId);
    expect(db.creator_threads).toHaveLength(1);
  });
});

describe("S8 — sender_kind cannot be spoofed", () => {
  it("a creator posting sender_kind:'tenant' is still stored as 'creator'", async () => {
    const threadId = await seedThread();
    _bearerUser = CREATOR_USER;

    const res = mkRes();
    await postCreatorThreadMessageRoute(
      mkReq({ thread_id: threadId }, { body: "On it.", sender_kind: "tenant" }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.body as { message: { sender_kind: string } }).message.sender_kind).toBe("creator");
    expect(db.creator_thread_messages[0].sender_kind).toBe("creator");
  });

  it("a tenant member posting sender_kind:'creator' is still stored as 'tenant'", async () => {
    const threadId = await seedThread();
    _bearerUser = TENANT_A_USER;

    const res = mkRes();
    await postCreatorThreadMessageRoute(
      mkReq({ thread_id: threadId }, { body: "Great, thanks.", sender_kind: "creator" }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(db.creator_thread_messages[0].sender_kind).toBe("tenant");
  });
});

describe("S8 — only the two parties to a thread can read or write it", () => {
  it("another tenant's owner gets a 404 with no data", async () => {
    const threadId = await seedThread();
    _bearerUser = TENANT_B_USER;

    const res = mkRes();
    await getCreatorThreadMessages(mkReq({ thread_id: threadId }), res);

    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(TENANT_A);
    expect(res.body).not.toHaveProperty("messages");
  });

  it("another creator gets a 404 with no data", async () => {
    const threadId = await seedThread();
    _bearerUser = OTHER_CREATOR_USER;

    const res = mkRes();
    await getCreatorThreadMessages(mkReq({ thread_id: threadId }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toHaveProperty("messages");
  });

  it("another tenant's owner cannot WRITE into the thread either", async () => {
    const threadId = await seedThread();
    _bearerUser = TENANT_B_USER;

    const res = mkRes();
    await postCreatorThreadMessageRoute(mkReq({ thread_id: threadId }, { body: "hello" }), res);

    expect(res.statusCode).toBe(404);
    expect(db.creator_thread_messages).toHaveLength(0);
  });

  it("a missing thread and someone else's thread are the same 404", async () => {
    const threadId = await seedThread();
    _bearerUser = TENANT_B_USER;
    const denied = mkRes();
    await getCreatorThreadMessages(mkReq({ thread_id: threadId }), denied);

    const missing = mkRes();
    await getCreatorThreadMessages(
      mkReq({ thread_id: "99999999-0000-4000-8000-000000000099" }),
      missing,
    );

    expect(missing.statusCode).toBe(denied.statusCode);
    expect(missing.body).toEqual(denied.body);
  });

  it("a business cannot open a thread with a creator who is not approved", async () => {
    _bearerUser = TENANT_A_USER;
    const res = mkRes();
    await openCreatorThread(mkReq({ human_member_id: PENDING_CREATOR_ID }, { body: "hi" }), res);
    expect(res.statusCode).toBe(404);
    expect(db.creator_threads).toHaveLength(0);
  });

  it("a cross-tenant accept is refused before the money port is reached", async () => {
    const threadId = await seedThread();
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
    });

    _bearerUser = TENANT_B_USER;
    const res = mkRes();
    await acceptCreatorOfferRoute(mkReq({ offer_id: offer.id }), res);

    expect(res.statusCode).toBe(404);
    expect(portCalls).toHaveLength(0);
    expect(db.creator_orders).toHaveLength(0);
  });
});

describe("S8 — contact details stay on Zavi", () => {
  it("removes email, phone, off-platform links and street addresses", () => {
    expect(scrubContact("email me at jane.doe@example.com").body).toBe(
      `email me at ${CONTACT_REDACTION}`,
    );
    expect(scrubContact("call me on +1 (415) 555-0199").removed).toContain("phone");
    expect(scrubContact("ping me on wa.me/14155550199").removed).toContain("link");
    expect(scrubContact("ship it to 789 Mission Street").removed).toContain("address");
  });

  it("leaves ordinary package talk alone", () => {
    const body = "The 3 videos will be ready in 5 days for $150.";
    const out = scrubContact(body);
    expect(out.body).toBe(body);
    expect(out.removed).toHaveLength(0);
  });

  it("the STORED message body is the scrubbed one, not the raw one", async () => {
    const threadId = await seedThread();
    _bearerUser = CREATOR_USER;

    const res = mkRes();
    await postCreatorThreadMessageRoute(
      mkReq({ thread_id: threadId }, { body: "reach me at jane.doe@example.com instead" }),
      res,
    );

    const stored = String(db.creator_thread_messages[0].body);
    expect(stored).not.toContain("jane.doe@example.com");
    expect(stored).toContain(CONTACT_REDACTION);
    expect((res.body as { message: { body: string } }).message.body).toBe(stored);

    await new Promise((r) => setTimeout(r, 0));
    const sent = notifyCalls.filter((c) => c.event === "thread_message");
    const vars = sent[sent.length - 1].vars as Record<string, unknown>;
    expect(vars.message_body).toBe(stored);
    expect(JSON.stringify(sent)).not.toContain("jane.doe@example.com");
  });
});

describe("custom offers keep contact details on Zavi before anyone pays", () => {
  const RAW_NOTE = "dm me maya@gmail.com or 555 123 4567";
  const RAW_TERMS = {
    video_count: 2,
    due_date: "2026-10-20",
    deliverable_notes: "3 videos for $150, ship the product to 789 Mission Street",
    extras: ["ping me on wa.me/15551234567", "30 second hook"],
    contact: { handle: "text 415-555-0199 anytime", rush: true },
  };
  const R = CONTACT_REDACTION;

  function expectScrubbed(offer: Record<string, unknown>) {
    expect(offer.note).toBe(`dm me ${R} or ${R}`);
    expect(offer.terms).toEqual({
      video_count: 2,
      due_date: "2026-10-20",
      deliverable_notes: `3 videos for $150, ship the product to ${R}`,
      extras: [`ping me on ${R}`, "30 second hook"],
      contact: { handle: `text ${R} anytime`, rush: true },
    });
    const text = JSON.stringify(offer);
    for (const raw of ["maya@gmail.com", "4567", "Mission", "wa.me", "0199"]) {
      expect(text).not.toContain(raw);
    }
  }

  it("a creator's thread offer is stored, returned and re-read with the note and terms redacted", async () => {
    const threadId = await seedThread();
    _bearerUser = CREATOR_USER;
    const res = mkRes();
    await postThreadOffer(
      mkReq(
        { thread_id: threadId },
        { kind: "ugc_video", terms: RAW_TERMS, price_cents: 15000, delivery_days: 7, note: RAW_NOTE },
      ),
      res,
    );
    expect(res.statusCode).toBe(200);
    const returned = (res.body as { offer: Record<string, unknown> }).offer;
    expectScrubbed(returned);
    expect(db.creator_offers).toHaveLength(1);
    expectScrubbed(db.creator_offers[0]);

    _bearerUser = TENANT_A_USER;
    const read = mkRes();
    await getCreatorOffer(mkReq({ offer_id: String(returned.id) }), read);
    expect(read.statusCode).toBe(200);
    expectScrubbed((read.body as { offer: Record<string, unknown> }).offer);

    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.stringify(notifyCalls)).not.toContain("maya@gmail.com");
    const logged = logEventMock.mock.calls.map((c) => c[0]).filter((e) => e?.code === "creator.contact_scrubbed");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.message).toBe("contact details removed from a creator offer (email, link, phone, address)");
    expect(JSON.stringify(logEventMock.mock.calls)).not.toContain("maya@gmail.com");
  });

  it("a business's storefront offer is scrubbed the same way", async () => {
    _bearerUser = TENANT_A_USER;
    _authTenant = TENANT_A;
    const res = mkRes();
    await postStorefrontOffer(
      mkReq(
        { human_member_id: CREATOR_ID },
        { kind: "ugc_video", terms: RAW_TERMS, price_cents: 15000, delivery_days: 7, note: RAW_NOTE },
      ),
      res,
    );
    expect(res.statusCode).toBe(200);
    expectScrubbed((res.body as { offer: Record<string, unknown> }).offer);
    expectScrubbed(db.creator_offers[0]);
    const logged = logEventMock.mock.calls.map((c) => c[0]).filter((e) => e?.code === "creator.contact_scrubbed");
    expect(logged[0]?.message).toBe("contact details removed from a tenant offer (email, link, phone, address)");
  });

  it("a clean offer is stored exactly as sent and logs no scrub", async () => {
    const threadId = await seedThread();
    const clean = { video_count: 3, due_date: "2026-10-20", deliverable_notes: "3 videos for $150 in 5 days, on its way by Friday" };
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: clean,
      price_cents: 15000,
      delivery_days: 7,
      note: "Happy to add a 15 second cut.",
    });
    expect(offer.terms).toEqual(clean);
    expect(offer.note).toBe("Happy to add a 15 second cut.");
    expect(logEventMock.mock.calls.some((c) => c[0]?.code === "creator.contact_scrubbed")).toBe(false);
  });
});

describe("custom offers: the audience post lane is gone", () => {
  const AUDIENCE_TERMS = { platform: "instagram", post_type: "Reel", stays_up_days: 30, post_count: 3, ad_label_required: true };

  it("refuses an audience_post offer from either side and writes nothing", async () => {
    const threadId = await seedThread();
    const threadsBefore = db.creator_threads.length;

    for (const user of [CREATOR_USER, TENANT_A_USER]) {
      _bearerUser = user;
      const res = mkRes();
      await postThreadOffer(
        mkReq({ thread_id: threadId }, { kind: "audience_post", terms: AUDIENCE_TERMS, price_cents: 15000, delivery_days: 7 }),
        res,
      );
      expect(res.statusCode, user).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe("bad_request");
    }

    _bearerUser = TENANT_B_USER;
    _authTenant = TENANT_B;
    const storefront = mkRes();
    await postStorefrontOffer(
      mkReq({ human_member_id: CREATOR_ID }, { kind: "audience_post", terms: { ...TERMS, ...AUDIENCE_TERMS }, price_cents: 15000, delivery_days: 7 }),
      storefront,
    );
    expect(storefront.statusCode).toBe(400);

    await new Promise((r) => setTimeout(r, 0));
    expect(db.creator_offers).toHaveLength(0);
    expect(db.creator_threads).toHaveLength(threadsBefore);
    expect(db.creator_threads.some((t) => t.tenant_id === TENANT_B)).toBe(false);
    expect(notifyCalls).toHaveLength(0);
  });

  it("the same body as ugc_video is accepted, so the refusal is about the lane alone", async () => {
    const threadId = await seedThread();
    _bearerUser = CREATOR_USER;
    const res = mkRes();
    await postThreadOffer(mkReq({ thread_id: threadId }, { kind: "ugc_video", terms: TERMS, price_cents: 15000, delivery_days: 7 }), res);
    expect(res.statusCode).toBe(200);
    expect(db.creator_offers.map((o) => o.kind)).toEqual(["ugc_video"]);
  });

  it("an open audience_post offer left over from before the lane closed cannot be accepted or charged", async () => {
    const threadId = await seedThread();
    const now = new Date();
    db.creator_offers.push({
      id: "f0000000-0000-4000-8000-0000000000aa",
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      thread_id: threadId,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      kind: "audience_post",
      terms: AUDIENCE_TERMS,
      price_cents: 15000,
      currency: "usd",
      delivery_days: 7,
      note: null,
      status: "open",
      expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      responded_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      product_needed: false,
    });
    _bearerUser = TENANT_A_USER;

    const res = mkRes();
    await acceptCreatorOfferRoute(mkReq({ offer_id: "f0000000-0000-4000-8000-0000000000aa" }), res);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("offer_not_open");
    expect(portCalls).toHaveLength(0);
    expect(db.creator_orders).toHaveLength(0);
    expect(db.creator_offers[0].status).toBe("open");
  });
});

describe("S8 — custom offers expire after 72 hours", () => {
  const T0 = new Date("2026-09-11T12:00:00.000Z");
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;

  it("the window is exactly the spec's 72 hours", () => {
    expect(OFFER_TTL_HOURS).toBe(72);
    expect(offerExpiresAt(T0).toISOString()).toBe(at(72 * HOUR).toISOString());
  });

  it("71h59m is still live, 72h01m is not", () => {
    const offer = { expires_at: offerExpiresAt(T0).toISOString() };
    expect(isOfferExpired(offer, at(71 * HOUR + 59 * MINUTE))).toBe(false);
    expect(isOfferExpired(offer, at(72 * HOUR + 1 * MINUTE))).toBe(true);
  });

  it("accept at 71h59m places the hold; accept at 72h01m does not", async () => {
    const threadId = await seedThread();
    const live = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
      now: T0,
    });
    const stale = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
      now: T0,
    });

    const ok = await acceptCreatorOffer({
      access: { tenant_id: TENANT_A, sender_kind: "tenant", human_member_id: CREATOR_ID },
      offer_id: live.id,
      now: at(71 * HOUR + 59 * MINUTE),
    });
    expect(ok.ok).toBe(true);
    expect(portCalls).toHaveLength(1);

    const late = await acceptCreatorOffer({
      access: { tenant_id: TENANT_A, sender_kind: "tenant", human_member_id: CREATOR_ID },
      offer_id: stale.id,
      now: at(72 * HOUR + 1 * MINUTE),
    });
    expect(late).toEqual({ ok: false, code: "offer_expired" });
    expect(portCalls).toHaveLength(1);
    expect(db.creator_offers.find((o) => o.id === stale.id)?.status).toBe("expired");
  });
});

describe("S8 — invariant 8: the fee shown is the shared fee function", () => {
  it("an offer's fee lines equal computeCreatorFees(price_cents)", async () => {
    const threadId = await seedThread();
    for (const price of [15000, 1, 999, 12345, 10_000_000]) {
      const offer = await createCreatorOffer({
        tenant_id: TENANT_A,
        human_member_id: CREATOR_ID,
        proposed_by: "tenant",
        proposed_by_user_id: TENANT_A_USER,
        thread_id: threadId,
        kind: "ugc_video",
        terms: TERMS,
        price_cents: price,
        delivery_days: 7,
      });
      expect(offer.fees).toEqual(computeCreatorFees(price));
    }
  });

  it("matches the spec's worked example: $150 -> business $165, creator $127.50", () => {
    expect(computeCreatorFees(15000)).toEqual({
      price_cents: 15000,
      business_fee_cents: 1500,
      creator_fee_cents: 2250,
      business_total_cents: 16500,
      creator_payout_cents: 12750,
      zavi_gross_cents: 3750,
      currency: "usd",
    });
  });

  it("the fees handed to the money port are the same ones the offer showed", async () => {
    const threadId = await seedThread();
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 12345,
      delivery_days: 7,
    });
    await acceptCreatorOffer({
      access: { tenant_id: TENANT_A, sender_kind: "tenant", human_member_id: CREATOR_ID },
      offer_id: offer.id,
    });
    expect(portCalls[0]).toMatchObject({
      price_cents: offer.fees.price_cents,
      business_fee_cents: offer.fees.business_fee_cents,
      creator_fee_cents: offer.fees.creator_fee_cents,
    });
  });
});

describe("S8 — accepting calls the money port exactly once", () => {
  async function seedCreatorProposedOffer(): Promise<string> {
    const threadId = await seedThread();
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
    });
    return offer.id;
  }

  it("a creator-proposed offer accepted by the BUSINESS holds once", async () => {
    const offerId = await seedCreatorProposedOffer();
    _bearerUser = TENANT_A_USER;

    const res = mkRes();
    await acceptCreatorOfferRoute(mkReq({ offer_id: offerId }), res);

    expect(res.statusCode).toBe(200);
    expect(portCalls).toHaveLength(1);
    expect(portCalls[0]).toMatchObject({ proposed_by: "creator", accepted_by: "tenant" });
    expect(db.creator_orders).toHaveLength(1);
  });

  it("a business-proposed offer accepted by the CREATOR holds once, same rule", async () => {
    const threadId = await seedThread();
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "tenant",
      proposed_by_user_id: TENANT_A_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
    });
    _bearerUser = CREATOR_USER;

    const res = mkRes();
    await acceptCreatorOfferRoute(mkReq({ offer_id: offer.id }), res);

    expect(res.statusCode).toBe(200);
    expect(portCalls).toHaveLength(1);
    expect(portCalls[0]).toMatchObject({ proposed_by: "tenant", accepted_by: "creator" });
  });

  it("a replayed accept returns the SAME order and does not charge again", async () => {
    const offerId = await seedCreatorProposedOffer();
    _bearerUser = TENANT_A_USER;

    const first = mkRes();
    await acceptCreatorOfferRoute(mkReq({ offer_id: offerId }), first);
    const second = mkRes();
    await acceptCreatorOfferRoute(mkReq({ offer_id: offerId }), second);

    const a = (first.body as { order: { order_id: string } }).order;
    const b = (second.body as { order: { order_id: string; already_existed: boolean } }).order;
    expect(second.statusCode).toBe(200);
    expect(b.order_id).toBe(a.order_id);
    expect(b.already_existed).toBe(true);
    expect(portCalls).toHaveLength(1);
    expect(db.creator_orders).toHaveLength(1);
  });

  it("two concurrent accepts produce one order and one port call", async () => {
    const offerId = await seedCreatorProposedOffer();
    const accept = () =>
      acceptCreatorOffer({
        access: { tenant_id: TENANT_A, sender_kind: "tenant", human_member_id: CREATOR_ID },
        offer_id: offerId,
      });
    const [a, b] = await Promise.all([accept(), accept()]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(portCalls).toHaveLength(1);
    expect(db.creator_orders).toHaveLength(1);
  });

  it("the side that proposed cannot accept its own offer", async () => {
    const offerId = await seedCreatorProposedOffer();
    _bearerUser = CREATOR_USER;

    const res = mkRes();
    await acceptCreatorOfferRoute(mkReq({ offer_id: offerId }), res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("cannot_accept_own_offer");
    expect(portCalls).toHaveLength(0);
  });

  it("a failing money port leaves the offer open rather than accepted-with-no-hold", async () => {
    const offerId = await seedCreatorProposedOffer();
    __setCreatorMoneyPortForTest({
      async placeHoldForOffer() {
        throw new Error("card declined");
      },
    });

    await expect(
      acceptCreatorOffer({
        access: { tenant_id: TENANT_A, sender_kind: "tenant", human_member_id: CREATOR_ID },
        offer_id: offerId,
      }),
    ).rejects.toThrow("card declined");

    expect(db.creator_offers.find((o) => o.id === offerId)?.status).toBe("open");
    expect(db.creator_orders).toHaveLength(0);
  });
});

describe("S8 — the money port is fail-closed until S2/S3 register one", () => {
  it("resolving with no registered port throws and names the owing slice", () => {
    __setCreatorMoneyPortForTest(null);
    expect(() => resolveCreatorMoneyPort()).toThrow(/S2\/S3/);
  });
});

describe("S4 — thread and offer emails", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("a posted message emails the OTHER side, throttled per thread per 15 minutes", async () => {
    const threadId = await seedThread();
    _bearerUser = CREATOR_USER;
    await postCreatorThreadMessageRoute(mkReq({ thread_id: threadId }, { body: "hello" }), mkRes());
    await postCreatorThreadMessageRoute(mkReq({ thread_id: threadId }, { body: "again" }), mkRes());
    await settle();
    const sent = notifyCalls.filter((c) => c.event === "thread_message");
    expect(sent).toHaveLength(2);
    expect(sent[0].recipient).toEqual({ kind: "tenant", tenant_id: TENANT_A });
    expect(String(sent[0].dedupe_key)).toMatch(new RegExp(`^thread:${threadId}:thread_message:\\d+:tenant:${TENANT_A}$`));
    expect(sent[1].dedupe_key).toBe(sent[0].dedupe_key);
    expect((sent[0].vars as Record<string, unknown>).link_path).toBe(
      `/workspace?tab=channels&channel=ugc&drawer=thread&creator=${CREATOR_ID}`,
    );
  });

  it("sending a custom offer emails the side that can accept it (custom_offer_received)", async () => {
    const threadId = await seedThread();
    await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: { title: "Unboxing" },
      price_cents: 15000,
      delivery_days: 7,
      product_needed: true,
    });
    const sent = notifyCalls.filter((c) => c.event === "custom_offer_received");
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toEqual({ kind: "tenant", tenant_id: TENANT_A });
    expect((sent[0].vars as Record<string, unknown>).business_total_cents).toBe(16500);
    expect(db.creator_offers[0].product_needed).toBe(true);
    const offerId = String(db.creator_offers[0].id);
    expect((sent[0].vars as Record<string, unknown>).link_path).toBe(`/workspace?tab=channels&channel=ugc&drawer=hire&offer=${offerId}`);
    expect(sent[0].scope_id).toBe(offerId);
    expect(sent[0].dedupe_key).toBeUndefined();

    await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: { title: "Unboxing v2" },
      price_cents: 12000,
      delivery_days: 7,
    });
    const both = notifyCalls.filter((c) => c.event === "custom_offer_received");
    expect(both).toHaveLength(2);
    expect(both[1].scope_id).not.toBe(both[0].scope_id);
  });

  it("a creator accepting the BUSINESS's offer emails custom_offer_accepted with the pay link", async () => {
    const threadId = await seedThread();
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "tenant",
      proposed_by_user_id: TENANT_A_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
    });
    __setCreatorMoneyPortForTest({
      async placeHoldForOffer(input) {
        portCalls.push(input);
        return {
          order_id: "o-1",
          status: "checkout_pending",
          already_existed: false,
          checkout_url: "https://checkout.stripe.com/c/pay/cs_1",
        };
      },
    });
    _bearerUser = CREATOR_USER;
    const res = mkRes();
    await acceptCreatorOfferRoute(mkReq({ offer_id: offer.id }), res);
    expect(res.statusCode).toBe(200);
    const sent = notifyCalls.filter((c) => c.event === "custom_offer_accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      recipient: { kind: "tenant", tenant_id: TENANT_A },
      order_id: "o-1",
      email_cta_url: "https://checkout.stripe.com/c/pay/cs_1",
    });
    expect((sent[0].vars as Record<string, unknown>).link_path).toBe(
      "/workspace?tab=channels&channel=ugc&drawer=job&job=o-1",
    );
  });

  it("the business accepting the creator's offer sends no accepted email (it is paying right now)", async () => {
    const threadId = await seedThread();
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
    });
    _bearerUser = TENANT_A_USER;
    await acceptCreatorOfferRoute(mkReq({ offer_id: offer.id }), mkRes());
    expect(notifyCalls.filter((c) => c.event === "custom_offer_accepted")).toHaveLength(0);
  });

  it("an email failure never fails the offer", async () => {
    const { notify } = await import("@/services/creators/notify");
    vi.mocked(notify).mockRejectedValueOnce(new Error("sendgrid down"));
    const threadId = await seedThread();
    const offer = await createCreatorOffer({
      tenant_id: TENANT_A,
      human_member_id: CREATOR_ID,
      proposed_by: "creator",
      proposed_by_user_id: CREATOR_USER,
      thread_id: threadId,
      kind: "ugc_video",
      terms: TERMS,
      price_cents: 15000,
      delivery_days: 7,
    });
    expect(offer.status).toBe("open");
  });
});
