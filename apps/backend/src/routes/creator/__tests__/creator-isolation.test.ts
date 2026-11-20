
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const USER_A = "auth-user-a";
const USER_B = "auth-user-b";
const USER_FOUNDER = "auth-user-founder";
const MEMBER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const MEMBER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ORDER_A = "0a0a0a0a-1111-4111-8111-0a0a0a0a0a0a";
const ORDER_B = "0b0b0b0b-2222-4222-8222-0b0b0b0b0b0b";

const { verifyBearerMock } = vi.hoisted(() => ({ verifyBearerMock: vi.fn() }));
vi.mock("@/services/auth/jwt", () => ({ verifyBearer: verifyBearerMock }));

type Result = { data: unknown; error: { message?: string } | null };
type Call = { table: string; ops: Array<{ op: string; args: unknown[] }> };

type StoredObject = { size: number; contentType: string } | null;

const { clientMock, storageMock, storage, state, calls, resetDb } = vi.hoisted(() => {
  const c: { list: Call[] } = { list: [] };
  const s: { rows: Record<string, (call: Call) => unknown> } = { rows: {} };
  const st: {
    objects: Record<string, StoredObject>;
    calls: Array<{ bucket: string; op: string; path: string }>;
    infoError: { message: string; status: number } | null;
  } = { objects: {}, calls: [], infoError: null };
  const CHAIN = [
    "select", "eq", "neq", "or", "in", "is", "not", "order", "range", "limit",
    "insert", "update", "delete", "upsert",
  ];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      c.list.push(call);
      const result = (): Result => {
        const fn = s.rows[table];
        return { data: fn ? fn(call) : null, error: null };
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
    storage: {
      from: (bucket: string) => ({
        createSignedUploadUrl: (path: string) => {
          st.calls.push({ bucket, op: "createSignedUploadUrl", path });
          return Promise.resolve({ data: { path, token: "tok", signedUrl: `https://x/${path}` }, error: null });
        },
        info: (path: string) => {
          st.calls.push({ bucket, op: "info", path });
          if (st.infoError) return Promise.resolve({ data: null, error: st.infoError });
          const obj = path in st.objects ? st.objects[path] : { size: 2048, contentType: "video/mp4" };
          if (!obj) return Promise.resolve({ data: null, error: { message: "Object not found", status: 404 } });
          return Promise.resolve({ data: { name: path, ...obj }, error: null });
        },
      }),
    },
  };
  return {
    clientMock: vi.fn(() => client),
    storageMock: vi.fn(() => client.storage),
    storage: st,
    state: s,
    calls: c,
    resetDb: () => {
      c.list = [];
      s.rows = {};
      st.objects = {};
      st.calls = [];
      st.infoError = null;
    },
  };
});

vi.mock("@/services/tenant-client", () => ({
  creatorAreaClient: clientMock,
  globalClient: clientMock,
  humanApplicantStorage: storageMock,
  tenantClient: clientMock,
  staffCrossTenantClient: clientMock,
  tenantRpc: vi.fn(),
  asTenantId: (t: string) => t,
}));

const { transitionMock } = vi.hoisted(() => ({ transitionMock: vi.fn() }));
vi.mock("@/services/creators/order-transitions", () => ({
  applyCreatorOrderTransition: transitionMock,
  realCreatorOrderDeps: {},
  DEADLINE_TRIGGER: {},
  fireCreatorOrderDeadline: vi.fn(),
  fireClaimedCreatorOrderDeadline: vi.fn(),
}));

const { ensurePayoutMock, logEventMock } = vi.hoisted(() => ({
  ensurePayoutMock: vi.fn(),
  logEventMock: vi.fn(async (_input: { code?: string; message?: string }) => {}),
}));
vi.mock("@/services/creators", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/creators")>()),
  ensureCreatorPayoutAccount: (...a: unknown[]) => ensurePayoutMock(...a),
}));
vi.mock("@/services/logging/logEvent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/logging/logEvent")>()),
  logEvent: (input: { code?: string; message?: string }) => logEventMock(input),
}));

import * as routes from "@/routes/creator";
import { wrapPlatformStripeError } from "@/services/tools/stripe/_platform-client";
import { computeCreatorFees } from "@/services/creators/order-fees";
import { deadlineCopy, orderDeadlineForRow } from "@/services/creators/deadlines";

function member(id: string, authUserId: string, vetting = "approved") {
  return {
    id,
    auth_user_id: authUserId,
    display_name: id === MEMBER_A ? "Maya" : "Priya",
    vetting_state: vetting,
    slug: id === MEMBER_A ? "maya" : "priya",
    lanes: ["ugc_video"],
    city: "Austin",
    country_code: "US",
    missed_deadline_count: 0,
    public_metrics: null,
    created_at: "2026-09-01T00:00:00.000Z",
  };
}

function order(over: Partial<Record<string, unknown>> = {}) {
  const price = 15000;
  const fees = computeCreatorFees(price);
  return {
    id: ORDER_A,
    tenant_id: TENANT_A,
    human_member_id: MEMBER_A,
    source: "booking",
    status: "awaiting_acceptance",
    closed_reason: null,
    created_at: "2026-09-10T12:00:00.000Z",
    due_at: null,
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: null,
    next_deadline_kind: null,
    responded_at: null,
    accepted_at: null,
    cancel_requested_at: null,
    closed_at: null,
    payout_status: "not_due",
    payout_ready_at: null,
    payout_amount_cents: null,
    price_cents: price,
    business_fee_cents: fees.business_fee_cents,
    creator_fee_cents: fees.creator_fee_cents,
    business_total_cents: fees.business_total_cents,
    creator_payout_cents: fees.creator_payout_cents,
    package_snapshot: { title: "One vertical video" },
    brief_snapshot: null,
    thread_id: null,
    livemode: false,
    currency: "usd",
    ...over,
  };
}

type ResDouble = {
  statusCode: number;
  body: unknown;
  status(code: number): ResDouble;
  json(payload: unknown): ResDouble;
};
type ReqDouble = {
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
};

function reqRes(
  over: Partial<{
    params: Record<string, string>;
    query: Record<string, unknown>;
    body: Record<string, unknown>;
  }> = {},
): { req: ReqDouble; res: ResDouble } {
  const res: ResDouble = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  const req: ReqDouble = {
    headers: { authorization: "Bearer tok" },
    params: {},
    query: {},
    body: {},
    ...over,
  };
  return { req, res };
}

type CreatorHandler = (req: Request, res: Response) => Promise<void>;
const call = (handler: CreatorHandler, req: ReqDouble, res: ResDouble) =>
  handler(req as unknown as Request, res as unknown as Response);

function eqsFor(table: string): [string, unknown][] {
  return calls.list
    .filter((c) => c.table === table)
    .flatMap((c) => c.ops.filter((o) => o.op === "eq").map((o) => [o.args[0], o.args[1]] as [string, unknown]));
}

beforeEach(() => {
  resetDb();
  verifyBearerMock.mockReset();
  transitionMock.mockReset();
  clientMock.mockClear();
  process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_test_fake_never_called";
  verifyBearerMock.mockResolvedValue({
    user_id: USER_A,
    access_token: "tok",
    session_id: null,
    claim_tenant_id: null,
  });
  state.rows.human_members = (call) => {
    const eq = call.ops.find((o) => o.op === "eq" && o.args[0] === "auth_user_id");
    const uid = eq?.args[1];
    if (uid === USER_A) return member(MEMBER_A, USER_A);
    if (uid === USER_B) return member(MEMBER_B, USER_B);
    return null;
  };
});

describe("creator A cannot read creator B's rows", () => {
  it("shows a creator their own reviews only, with the business name and no order or tenant ids", async () => {
    state.rows.creator_reviews = (call) => {
      const eq = call.ops.find((o) => o.op === "eq" && o.args[0] === "human_member_id");
      return eq?.args[1] === MEMBER_A
        ? [{ id: "r1", tenant_id: TENANT_A, order_id: ORDER_A, communication: 5, timeliness: 4, satisfaction: 5, body: "Great video.", created_at: "2026-10-22T07:00:00Z", updated_at: "2026-10-22T07:00:00Z" }]
        : [{ id: "r2", tenant_id: TENANT_B, order_id: ORDER_B, communication: 1, timeliness: 1, satisfaction: 1, body: "Not yours.", created_at: "2026-10-22T07:00:00Z", updated_at: "2026-10-22T07:00:00Z" }];
    };
    state.rows.creator_orders = () => [];
    state.rows.tenants = () => [{ id: TENANT_A, display_name: "UpcarAI" }];
    const { req, res } = reqRes({ query: { human_member_id: MEMBER_B } });
    await call(routes.getCreatorReviews, req, res);

    expect(res.statusCode).toBe(200);
    expect(eqsFor("creator_reviews")).toContainEqual(["human_member_id", MEMBER_A]);
    expect(eqsFor("creator_reviews")).not.toContainEqual(["human_member_id", MEMBER_B]);
    const body = res.body as { aggregates: { review_count: number; avg_overall: number }; reviews: Array<Record<string, unknown>> };
    expect(body.aggregates.review_count).toBe(1);
    expect(body.reviews).toEqual([
      { id: "r1", business_name: "UpcarAI", communication: 5, timeliness: 4, satisfaction: 5, body: "Great video.", created_at: "2026-10-22T07:00:00Z" },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(TENANT_A);
    expect(JSON.stringify(res.body)).not.toContain(ORDER_A);
  });

  it("scopes the jobs list to the caller's own member id, never a body or query id", async () => {
    state.rows.creator_orders = (call) => {
      const eq = call.ops.find((o) => o.op === "eq" && o.args[0] === "human_member_id");
      return eq?.args[1] === MEMBER_A ? [order()] : [];
    };
    const { req, res } = reqRes({
      query: { scope: "all", human_member_id: MEMBER_B },
      body: { human_member_id: MEMBER_B },
    });
    await call(routes.getCreatorJobs, req, res);

    expect(res.statusCode).toBe(200);
    const eqs = eqsFor("creator_orders");
    expect(eqs).toContainEqual(["human_member_id", MEMBER_A]);
    expect(eqs).not.toContainEqual(["human_member_id", MEMBER_B]);
    expect((res.body as { jobs: unknown[] }).jobs).toHaveLength(1);
  });

  it("answers 404, not another creator's job, when the path names creator B's order", async () => {
    state.rows.creator_orders = (call) => {
      const mem = call.ops.find((o) => o.op === "eq" && o.args[0] === "human_member_id");
      const id = call.ops.find((o) => o.op === "eq" && o.args[0] === "id");
      if (id?.args[1] === ORDER_B && mem?.args[1] === MEMBER_B) {
        return order({ id: ORDER_B, tenant_id: TENANT_B, human_member_id: MEMBER_B });
      }
      return null;
    };
    const { req, res } = reqRes({ params: { orderId: ORDER_B } });
    await call(routes.getCreatorJob, req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: { code: "not_found", message: "There is no job here. An order only becomes a job once the business has paid for it." },
    });
    expect(eqsFor("creator_orders")).toContainEqual(["human_member_id", MEMBER_A]);
  });

  it("never lets an accept reach another creator's order", async () => {
    state.rows.creator_orders = () => null;
    const { req, res } = reqRes({ params: { orderId: ORDER_B } });
    await call(routes.postCreatorAccept, req, res);

    expect(res.statusCode).toBe(404);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("scopes the inbox alerts to the caller, on the creator lane", async () => {
    state.rows.creator_orders = () => [];
    state.rows.creator_notifications = () => [];
    const { req, res } = reqRes();
    await call(routes.getCreatorInbox, req, res);

    const eqs = eqsFor("creator_notifications");
    expect(eqs).toContainEqual(["human_member_id", MEMBER_A]);
    expect(eqs).toContainEqual(["recipient_kind", "creator"]);
    expect(eqs).not.toContainEqual(["human_member_id", MEMBER_B]);
  });

  it("keeps business notices out of the creator's Updates and names the business on old rows", async () => {
    state.rows.creator_orders = (call) =>
      call.ops.some((o) => o.op === "select" && o.args[0] === "id, tenant_id")
        ? [{ id: ORDER_A, tenant_id: TENANT_A }]
        : [];
    state.rows.creator_notifications = () => [
      { id: "n1", kind: "approved", title: "The business approved your work", body: "The business accepted the delivery.", link_path: "/creator", order_id: ORDER_A, read_at: null, created_at: "2026-09-20T00:00:00Z" },
      { id: "n2", kind: "paid", title: "The business paid", body: null, link_path: "/creator", order_id: null, read_at: null, created_at: "2026-09-19T00:00:00Z" },
    ];
    state.rows.tenants = () => ({ display_name: "Acme Coffee" });
    const { req, res } = reqRes();
    await call(routes.getCreatorInbox, req, res);

    const alerts = (res.body as { alerts: Array<{ title: string; body: string | null }> }).alerts;
    expect(alerts[0]).toMatchObject({ title: "Acme Coffee approved your work", body: "Acme Coffee accepted the delivery." });
    expect(alerts[1].title).toBe("A Zavi business paid");
    const orderCall = calls.list.find((c) => c.table === "creator_orders" && c.ops.some((o) => o.op === "select" && o.args[0] === "id, tenant_id"));
    expect(orderCall?.ops).toContainEqual({ op: "eq", args: ["human_member_id", MEMBER_A] });
    const nots = calls.list.find((c) => c.table === "creator_notifications")!.ops.filter((o) => o.op === "not");
    expect(nots).toContainEqual({ op: "not", args: ["kind", "like", "reminder_review_%"] });
    expect(String(nots.find((o) => o.args[1] === "in")?.args[2])).toContain("submission_received");
  });

  it("scopes earnings to the caller", async () => {
    state.rows.creator_orders = (call) => {
      const eq = call.ops.find((o) => o.op === "eq" && o.args[0] === "human_member_id");
      return eq?.args[1] === MEMBER_A ? [order({ status: "in_progress" })] : [];
    };
    const { req, res } = reqRes();
    await call(routes.getCreatorEarnings, req, res);

    expect(eqsFor("creator_orders")).toContainEqual(["human_member_id", MEMBER_A]);
    expect(res.statusCode).toBe(200);
  });

  it("scopes submissions through the order, so they cannot be read for another creator's job", async () => {
    state.rows.creator_orders = (call) => {
      const mem = call.ops.find((o) => o.op === "eq" && o.args[0] === "human_member_id");
      return mem?.args[1] === MEMBER_A ? order({ status: "in_progress" }) : null;
    };
    state.rows.creator_submissions = () => [];
    const { req, res } = reqRes({ params: { orderId: ORDER_A } });
    await call(routes.getCreatorJob, req, res);

    expect(res.statusCode).toBe(200);
    const eqs = eqsFor("creator_submissions");
    expect(eqs).toContainEqual(["order_id", ORDER_A]);
    expect(eqs).toContainEqual(["tenant_id", TENANT_A]);
  });

  it("scopes a package edit to the caller, so another creator's package id is a 404", async () => {
    state.rows.creator_packages = (call) => {
      const mem = call.ops.find((o) => o.op === "eq" && o.args[0] === "human_member_id");
      return mem?.args[1] === MEMBER_B ? { id: "pkg-b" } : null;
    };
    const { req, res } = reqRes({ params: { packageId: "pkg-b" }, body: { price_cents: 1 } });
    await call(routes.patchCreatorPackage, req, res);

    expect(res.statusCode).toBe(404);
    expect(eqsFor("creator_packages")).toContainEqual(["human_member_id", MEMBER_A]);
  });

  it("cannot switch a leftover audience_post package back on, nor list it", async () => {
    const leftover = {
      id: "pkg-aud",
      human_member_id: MEMBER_A,
      kind: "audience_post",
      title: "One reel",
      price_cents: 40000,
      delivery_days: 5,
      platform: "instagram",
      post_type: "Reel",
      stays_up_days: 30,
      active: false,
    };
    const kindMatches = (call: Call) =>
      call.ops.filter((o) => o.op === "eq" && o.args[0] === "kind").every((o) => o.args[1] === leftover.kind);
    state.rows.creator_packages = (call) => (kindMatches(call) ? (call.ops.some((o) => o.op === "update") ? { ...leftover, active: true } : [leftover]) : call.ops.some((o) => o.op === "update") ? null : []);

    const patch = reqRes({ params: { packageId: "pkg-aud" }, body: { active: true } });
    await call(routes.patchCreatorPackage, patch.req, patch.res);
    expect(patch.res.statusCode).toBe(404);
    expect(eqsFor("creator_packages")).toContainEqual(["kind", "ugc_video"]);

    const list = reqRes();
    await call(routes.getCreatorStorefront, list.req, list.res);
    expect((list.res.body as { packages: unknown[] }).packages).toEqual([]);
  });

  it("scopes marking an alert read, so another creator's alert id is a 404", async () => {
    state.rows.creator_notifications = () => [];
    const { req, res } = reqRes({ params: { notificationId: "alert-b" } });
    await call(routes.postCreatorNotificationRead, req, res);

    expect(res.statusCode).toBe(404);
    expect(eqsFor("creator_notifications")).toContainEqual(["human_member_id", MEMBER_A]);
  });

  it("mints the upload key from the order, never from the request", async () => {
    state.rows.creator_orders = () => order({ status: "in_progress" });
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: {
        content_type: "video/mp4",
        storage_path: `${TENANT_B}/${ORDER_B}/steal.mp4`,
        path: "../../etc/passwd",
      },
    });
    await call(routes.postCreatorUploadUrl, req, res);

    const body = res.body as { path: string };
    expect(body.path.startsWith(`${TENANT_A}/${ORDER_A}/`)).toBe(true);
    expect(body.path).not.toContain(TENANT_B);
    expect(body.path).not.toContain("..");
  });
});

describe("a business token is refused by every creator route", () => {
  const HANDLERS: [string, CreatorHandler][] = [
    ["me", routes.getCreatorMe],
    ["inbox", routes.getCreatorInbox],
    ["briefs", routes.getCreatorBriefs],
    ["jobs", routes.getCreatorJobs],
    ["job", routes.getCreatorJob],
    ["accept", routes.postCreatorAccept],
    ["pass", routes.postCreatorPass],
    ["extension", routes.postCreatorExtension],
    ["message", routes.postCreatorMessage],
    ["upload-url", routes.postCreatorUploadUrl],
    ["submission", routes.postCreatorSubmission],
    ["earnings", routes.getCreatorEarnings],
    ["reviews", routes.getCreatorReviews],
    ["onboarding-link", routes.postCreatorOnboardingLink],
    ["tax-forms-link", routes.postCreatorTaxFormsLink],
    ["payout-refresh", routes.postCreatorPayoutRefresh],
    ["storefront", routes.getCreatorStorefront],
    ["package patch", routes.patchCreatorPackage],
    ["alert read", routes.postCreatorNotificationRead],
  ];

  it.each(HANDLERS)("403s a signed-in founder on %s", async (_name, handler) => {
    verifyBearerMock.mockResolvedValue({
      user_id: USER_FOUNDER,
      access_token: "tok",
      session_id: null,
      claim_tenant_id: null,
    });
    const { req, res } = reqRes({
      params: { orderId: ORDER_A, packageId: "p", notificationId: "n" },
      body: { content_type: "video/mp4", files: [{ storage_path: "x" }], requested_due_at: "2026-10-01" },
    });
    await call(handler, req, res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_a_creator");
    expect(calls.list.filter((c) => c.table !== "human_members")).toHaveLength(0);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it.each(HANDLERS)("401s an unauthenticated caller on %s", async (_name, handler) => {
    verifyBearerMock.mockResolvedValue(null);
    const { req, res } = reqRes({ params: { orderId: ORDER_A }, body: {} });
    await call(handler, req, res);
    expect(res.statusCode).toBe(401);
  });

  it("lets a pending creator in", async () => {
    state.rows.human_members = () => member(MEMBER_A, USER_A, "pending");
    const { req, res } = reqRes();
    await call(routes.getCreatorInbox, req, res);
    expect(res.statusCode).toBe(200);
  });

  it("403s a creator whose account was closed", async () => {
    state.rows.human_members = () => member(MEMBER_A, USER_A, "rejected");
    const { req, res } = reqRes();
    await call(routes.getCreatorInbox, req, res);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_approved");
  });
});

describe("a removed creator can still finish and get paid for the jobs left running", () => {
  function routed(method: string, path: string, over: Parameters<typeof reqRes>[0] = {}) {
    const rr = reqRes(over);
    Object.assign(rr.req, { method, baseUrl: "", route: { path } });
    return rr;
  }

  const closedOrders = new Map<string, string>();
  const ORDER_C = "0c0c0c0c-3333-4333-8333-0c0c0c0c0c0c";

  beforeEach(() => {
    state.rows.human_members = () => member(MEMBER_A, USER_A, "rejected");
    closedOrders.clear();
    state.rows.creator_orders = (call) => {
      const mem = call.ops.find((o) => o.op === "eq" && o.args[0] === "human_member_id");
      if (mem?.args[1] !== MEMBER_A) return null;
      const id = call.ops.find((o) => o.op === "eq" && o.args[0] === "id")?.args[1] as string | undefined;
      if (id) return closedOrders.has(id) ? order({ id, status: closedOrders.get(id) }) : null;
      return [];
    };
    state.rows.creator_submissions = () => [];
    transitionMock.mockResolvedValue({
      ok: true,
      order: order({ status: "submitted" }),
      trigger: "submit",
      from: "in_progress",
      to: "submitted",
      deadline: null,
      money: [],
      needs_staff_review: false,
      payout_waiting: false,
    });
    ensurePayoutMock.mockReset();
  });

  it("submits on an in-progress job: upload url, submission, one submit transition", async () => {
    closedOrders.set(ORDER_A, "in_progress");
    const up = routed("POST", "/api/creator/jobs/:orderId/upload-url", {
      params: { orderId: ORDER_A },
      body: { content_type: "video/mp4" },
    });
    await call(routes.postCreatorUploadUrl, up.req, up.res);
    expect(up.res.statusCode).toBe(200);
    expect((up.res.body as { path: string }).path.startsWith(`${TENANT_A}/${ORDER_A}/`)).toBe(true);

    const sub = routed("POST", "/api/creator/jobs/:orderId/submissions", {
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/x.mp4` }] },
    });
    await call(routes.postCreatorSubmission, sub.req, sub.res);
    expect(sub.res.statusCode).toBe(200);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0][0]).toMatchObject({ order_id: ORDER_A, trigger: "submit", actor: "creator" });
    expect(calls.list.some((c) => c.table === "creator_submissions" && c.ops.some((o) => o.op === "insert"))).toBe(true);
  });

  it.each(["in_progress", "submitted", "revision_requested", "in_dispute"])(
    "reads the job while it is %s",
    async (status) => {
      closedOrders.set(ORDER_A, status);
      const { req, res } = routed("GET", "/api/creator/jobs/:orderId", { params: { orderId: ORDER_A } });
      await call(routes.getCreatorJob, req, res);
      expect(res.statusCode).toBe(200);
    },
  );

  it.each(["cancelled", "completed"])("keeps a %s job closed and fires nothing", async (status) => {
    closedOrders.set(ORDER_A, status);
    for (const [method, path, handler] of [
      ["GET", "/api/creator/jobs/:orderId", routes.getCreatorJob],
      ["POST", "/api/creator/jobs/:orderId/upload-url", routes.postCreatorUploadUrl],
      ["POST", "/api/creator/jobs/:orderId/submissions", routes.postCreatorSubmission],
    ] as const) {
      const { req, res } = routed(method, path, {
        params: { orderId: ORDER_A },
        body: { content_type: "video/mp4", files: [{ storage_path: "x" }] },
      });
      await call(handler, req, res);
      expect(res.statusCode).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe("not_approved");
    }
    expect(transitionMock).not.toHaveBeenCalled();
    expect(calls.list.some((c) => c.ops.some((o) => o.op === "insert"))).toBe(false);
  });

  it("does not open another creator's or an unknown order through the allowlist", async () => {
    closedOrders.set(ORDER_A, "in_progress");
    const { req, res } = routed("POST", "/api/creator/jobs/:orderId/submissions", {
      params: { orderId: ORDER_C },
      body: { files: [{ storage_path: "x" }] },
    });
    await call(routes.postCreatorSubmission, req, res);
    expect(res.statusCode).toBe(403);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/creator/briefs", routes.getCreatorBriefs],
    ["GET", "/api/creator/inbox", routes.getCreatorInbox],
    ["GET", "/api/creator/storefront", routes.getCreatorStorefront],
    ["PATCH", "/api/creator/storefront/packages/:packageId", routes.patchCreatorPackage],
    ["POST", "/api/creator/jobs/:orderId/accept", routes.postCreatorAccept],
    ["POST", "/api/creator/jobs/:orderId/extension", routes.postCreatorExtension],
    ["POST", "/api/creator/jobs/:orderId/messages", routes.postCreatorMessage],
    ["GET", "/api/creator/jobs/:orderId/upload-url", routes.postCreatorUploadUrl],
  ] as const)("still refuses %s %s", async (method, path, handler) => {
    closedOrders.set(ORDER_A, "in_progress");
    const { req, res } = routed(method, path, {
      params: { orderId: ORDER_A, packageId: "p" },
      body: { content_type: "video/mp4", body: "hi", price_cents: 1, requested_due_at: "2026-10-30" },
    });
    await call(handler, req, res);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_approved");
    expect(calls.list.filter((c) => c.table !== "human_members")).toHaveLength(0);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("still refuses the brief apply route", async () => {
    const { postOpenBriefApply } = await import("@/routes/humans/open-briefs");
    const { req, res } = routed("POST", "/api/humans/open-briefs/:briefId/apply", {
      params: { briefId: "brief-1" },
      body: { quoted_rate_usd: 100 },
    });
    await call(postOpenBriefApply, req, res);
    expect(res.statusCode).toBe(403);
    expect(calls.list.filter((c) => c.table !== "human_members")).toHaveLength(0);
  });

  it("answers /me with the closed state so the area can show the open jobs", async () => {
    const { req, res } = routed("GET", "/api/creator/me");
    await call(routes.getCreatorMe, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ vetting_state: "rejected", creator: { id: MEMBER_A } });
  });

  it.each(["all", "active", undefined])("lists only the caller's own unfinished jobs (scope %s)", async (scope) => {
    const rows = ["in_progress", "submitted", "awaiting_acceptance", "completed", "cancelled"].map((status, i) =>
      order({ id: `0d0d0d0d-4444-4444-8444-00000000000${i}`, status }),
    );
    state.rows.creator_orders = (call) => {
      const mem = call.ops.find((o) => o.op === "eq" && o.args[0] === "human_member_id");
      if (mem?.args[1] !== MEMBER_A) return [];
      const inOp = call.ops.find((o) => o.op === "in" && o.args[0] === "status");
      const allowed = inOp?.args[1] as string[] | undefined;
      return allowed ? rows.filter((r) => allowed.includes(r.status)) : rows;
    };
    const { req, res } = routed("GET", "/api/creator/jobs", {
      query: scope ? { scope, human_member_id: MEMBER_B } : { human_member_id: MEMBER_B },
    });
    await call(routes.getCreatorJobs, req, res);
    expect(res.statusCode).toBe(200);
    const statuses = (res.body as { jobs: { status: string }[] }).jobs.map((j) => j.status).sort();
    expect(statuses).toEqual(["in_progress", "submitted"]);
    expect(eqsFor("creator_orders")).not.toContainEqual(["human_member_id", MEMBER_B]);
  });

  it("shows earnings", async () => {
    const { req, res } = routed("GET", "/api/creator/earnings");
    await call(routes.getCreatorEarnings, req, res);
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ["in_progress", "not_due"],
    ["submitted", "not_due"],
    ["completed", "ready"],
    ["completed", "awaiting_payout_account"],
  ])("starts Stripe onboarding when a %s job (payout %s) is owed", async (status, payout_status) => {
    let listed: unknown[] | undefined;
    state.rows.creator_orders = (call) => {
      const inOp = call.ops.find((o) => o.op === "in" && o.args[0] === "status");
      listed = inOp?.args[1] as unknown[];
      const row = order({ status, payout_status });
      return (inOp?.args[1] as string[]).includes(status) ? [row] : [];
    };
    ensurePayoutMock.mockRejectedValueOnce(new Error("reached stripe"));
    const { req, res } = routed("POST", "/api/creator/payouts/onboarding-link");
    await call(routes.postCreatorOnboardingLink, req, res);
    expect(listed).toEqual(expect.arrayContaining(["in_progress", "submitted", "completed"]));
    expect(eqsFor("creator_orders")).toContainEqual(["human_member_id", MEMBER_A]);
    expect(ensurePayoutMock).toHaveBeenCalledTimes(1);
    expect(ensurePayoutMock.mock.calls[0][0]).toMatchObject({ human_member_id: MEMBER_A, country: "US" });
  });

  it.each([
    ["nothing at all", []],
    ["a completed job already transferred", [{ status: "completed", payout_status: "transferred" }]],
    ["a completed job reversed", [{ status: "completed", payout_status: "reversed" }]],
    ["a cancelled job", [{ status: "cancelled", payout_status: "not_applicable" }]],
  ])("refuses Stripe onboarding when %s is owed", async (_name, rows) => {
    state.rows.creator_orders = () => rows.map((r) => order(r));
    const { req, res } = routed("POST", "/api/creator/payouts/onboarding-link");
    await call(routes.postCreatorOnboardingLink, req, res);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_approved");
    expect(ensurePayoutMock).not.toHaveBeenCalled();
  });

  it("lets payout refresh and tax forms through the gate", async () => {
    state.rows.creator_payout_accounts = () => null;
    for (const [path, handler] of [
      ["/api/creator/payouts/refresh", routes.postCreatorPayoutRefresh],
      ["/api/creator/payouts/tax-forms-link", routes.postCreatorTaxFormsLink],
    ] as const) {
      const { req, res } = routed("POST", path);
      await call(handler, req, res);
      expect(res.statusCode).toBe(409);
      expect((res.body as { error: { code: string } }).error.code).toBe("no_payout_account");
    }
  });
});

describe("accept and pass go through the state machine, exactly once", () => {
  beforeEach(() => {
    state.rows.creator_orders = () => order();
    state.rows.creator_submissions = () => [];
    transitionMock.mockResolvedValue({
      ok: true,
      order: order({ status: "in_progress" }),
      trigger: "creator_accept",
      from: "awaiting_acceptance",
      to: "in_progress",
      deadline: null,
      money: [],
      needs_staff_review: false,
      payout_waiting: false,
    });
  });

  it("accept fires one creator_accept, as the creator, on the order's own tenant", async () => {
    const { req, res } = reqRes({ params: { orderId: ORDER_A } });
    await call(routes.postCreatorAccept, req, res);

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0][0]).toMatchObject({
      tenant_id: TENANT_A,
      order_id: ORDER_A,
      trigger: "creator_accept",
      actor: "creator",
      actor_user_id: USER_A,
    });
    expect(res.statusCode).toBe(200);
  });

  it("pass fires one creator_pass and carries the optional reason", async () => {
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { reason: "Booked solid that week." },
    });
    await call(routes.postCreatorPass, req, res);

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0][0]).toMatchObject({
      trigger: "creator_pass",
      actor: "creator",
      note: "Booked solid that week.",
    });
  });

  it("pass works with no reason at all: the reason is optional", async () => {
    const { req, res } = reqRes({ params: { orderId: ORDER_A }, body: {} });
    await call(routes.postCreatorPass, req, res);

    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0][0]).toMatchObject({ trigger: "creator_pass", note: null });
    expect(res.statusCode).toBe(200);
  });

  it("never writes creator_orders.status directly from the creator area", async () => {
    const { req, res } = reqRes({ params: { orderId: ORDER_A } });
    await call(routes.postCreatorAccept, req, res);

    const writes = calls.list
      .filter((c) => c.table === "creator_orders")
      .flatMap((c) => c.ops)
      .filter((o) => o.op === "update" || o.op === "insert" || o.op === "upsert");
    expect(writes).toHaveLength(0);
  });

  it("surfaces an illegal transition as the state machine's own refusal", async () => {
    transitionMock.mockResolvedValue({
      ok: false,
      code: "illegal_transition",
      message: "You cannot accept a job that is already running.",
    });
    const { req, res } = reqRes({ params: { orderId: ORDER_A } });
    await call(routes.postCreatorAccept, req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("illegal_transition");
  });
});

describe("earnings are the fee function's creator amount for that order", () => {
  it.each([1_00, 150_00, 333_33, 1_000_00, 99_99])(
    "a $%d job pays price minus the 15% creator fee",
    async (price) => {
      const fees = computeCreatorFees(price);
      state.rows.creator_orders = () => [
        order({
          price_cents: price,
          business_fee_cents: fees.business_fee_cents,
          creator_fee_cents: fees.creator_fee_cents,
          business_total_cents: fees.business_total_cents,
          creator_payout_cents: fees.creator_payout_cents,
          status: "in_progress",
          payout_status: "not_due",
        }),
      ];
      const { req, res } = reqRes();
      await call(routes.getCreatorEarnings, req, res);

      const body = res.body as {
        held_cents: number;
        lines: { amount_cents: number; creator_fee_cents: number; price_cents: number }[];
      };
      expect(body.lines[0].amount_cents).toBe(fees.creator_payout_cents);
      expect(body.lines[0].creator_fee_cents).toBe(fees.creator_fee_cents);
      expect(body.held_cents).toBe(fees.creator_payout_cents);
      expect(body.lines[0].amount_cents).not.toBe(fees.business_total_cents);
      expect(body.lines[0].amount_cents).not.toBe(price);
    },
  );

  it("splits held, on the way and paid by payout state and never double counts", async () => {
    const fees = computeCreatorFees(15000);
    const mk = (payout_status: string, over = {}) =>
      order({
        price_cents: 15000,
        business_fee_cents: fees.business_fee_cents,
        creator_fee_cents: fees.creator_fee_cents,
        business_total_cents: fees.business_total_cents,
        creator_payout_cents: fees.creator_payout_cents,
        payout_status,
        status: "completed",
        closed_reason: "approved",
        closed_at: "2026-09-11T00:00:00.000Z",
        ...over,
      });
    state.rows.creator_orders = () => [
      mk("not_due", { status: "in_progress", closed_reason: null, closed_at: null }),
      mk("ready", { payout_ready_at: "2099-01-01T00:00:00.000Z" }),
      mk("ready", { payout_ready_at: "2020-01-01T00:00:00.000Z" }),
      mk("transferred"),
      mk("not_applicable", { status: "cancelled", closed_reason: "declined" }),
    ];
    const { req, res } = reqRes();
    await call(routes.getCreatorEarnings, req, res);

    const b = res.body as {
      held_cents: number;
      on_the_way_cents: number;
      paid_cents: number;
      lines: unknown[];
    };
    expect(b.held_cents).toBe(fees.creator_payout_cents * 2);
    expect(b.on_the_way_cents).toBe(fees.creator_payout_cents);
    expect(b.paid_cents).toBe(fees.creator_payout_cents);
    expect(b.lines).toHaveLength(4);
  });

  it("counts a payout blocked on Stripe setup as held, not as on the way", async () => {
    const fees = computeCreatorFees(15000);
    state.rows.creator_orders = () => [
      order({
        price_cents: 15000,
        business_fee_cents: fees.business_fee_cents,
        creator_fee_cents: fees.creator_fee_cents,
        business_total_cents: fees.business_total_cents,
        creator_payout_cents: fees.creator_payout_cents,
        payout_status: "awaiting_payout_account",
        status: "completed",
        closed_reason: "approved",
        closed_at: "2026-09-11T00:00:00.000Z",
      }),
    ];
    const { req, res } = reqRes();
    await call(routes.getCreatorEarnings, req, res);
    const b = res.body as {
      held_cents: number;
      on_the_way_cents: number;
      lines: { bucket: string }[];
    };
    expect(b.on_the_way_cents).toBe(0);
    expect(b.held_cents).toBe(fees.creator_payout_cents);
    expect(b.lines.map((l) => l.bucket)).toEqual(["held"]);
  });

  it("pays only the mediated part when Zavi stepped in and paid part", async () => {
    const fees = computeCreatorFees(15000);
    state.rows.creator_orders = () => [
      order({
        price_cents: 15000,
        business_fee_cents: fees.business_fee_cents,
        creator_fee_cents: fees.creator_fee_cents,
        business_total_cents: fees.business_total_cents,
        creator_payout_cents: fees.creator_payout_cents,
        payout_amount_cents: 5000,
        payout_status: "transferred",
        status: "completed",
        closed_reason: "mediation_pay_part",
        closed_at: "2026-09-11T00:00:00.000Z",
      }),
    ];
    const { req, res } = reqRes();
    await call(routes.getCreatorEarnings, req, res);

    const b = res.body as { paid_cents: number; lines: { part_paid: boolean }[] };
    expect(b.paid_cents).toBe(5000);
    expect(b.lines[0].part_paid).toBe(true);
  });

  it("refuses to show a figure for an order whose stored fees drifted from the rule", async () => {
    state.rows.creator_orders = () => [
      order({ price_cents: 15000, creator_fee_cents: 1, creator_payout_cents: 14999 }),
    ];
    const { req, res } = reqRes();
    await call(routes.getCreatorEarnings, req, res);

    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("order_fees_inconsistent");
  });

  it("shows each storefront package's fee split from the one fee function", async () => {
    state.rows.creator_packages = () => [
      {
        id: "pkg-1",
        human_member_id: MEMBER_A,
        kind: "ugc_video",
        title: "One vertical video",
        description: null,
        price_cents: 15000,
        currency: "usd",
        delivery_days: 7,
        video_count: 1,
        video_length_seconds: 30,
        ad_rights_days: 90,
        addons: [],
        active: true,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      },
    ];
    const { req, res } = reqRes();
    await call(routes.getCreatorStorefront, req, res);

    const b = res.body as { packages: { fees: Record<string, number> }[] };
    expect(b.packages[0].fees).toEqual(computeCreatorFees(15000));
  });
});

describe("the creator reads the same deadline sentence as the business", () => {
  it("returns S3's copy object verbatim when the row carries a stamped deadline", async () => {
    const at = "2026-09-14T12:00:00.000Z";
    state.rows.creator_orders = () =>
      order({ next_deadline_at: at, next_deadline_kind: "accept" });
    state.rows.creator_submissions = () => [];

    const { req, res } = reqRes({ params: { orderId: ORDER_A } });
    await call(routes.getCreatorJob, req, res);

    const creatorSide = (res.body as { job: { deadline: unknown } }).job.deadline;
    const businessSide = deadlineCopy("accept", at, { side: "business" });
    const c = creatorSide as { deadline_at: string; deadline_text: string; consequence_text: string };
    expect(c.deadline_at).toBe(businessSide.deadline_at);
    expect(c.deadline_text).toBe(businessSide.deadline_text);
    expect(c.consequence_text).toMatch(/^If you don't accept by then/);
  });

  it.each([
    ["awaiting_acceptance", "accept"],
    ["submitted", "review"],
    ["cancel_requested", "cancel_response"],
  ] as const)(
    "recomputes %s with S3's own rule, still byte-identical to the business side",
    async (status, kind) => {
      const created = "2026-09-10T12:00:00.000Z";
      const row = order({
        status,
        created_at: created,
        cancel_requested_at: status === "cancel_requested" ? created : null,
      });
      state.rows.creator_orders = () => row;
      state.rows.creator_submissions = () =>
        status === "submitted"
          ? [
              {
                id: "s1",
                order_id: ORDER_A,
                version: 1,
                position: 0,
                kind: "video",
                storage_path: `${TENANT_A}/${ORDER_A}/a.mp4`,
                mime_type: "video/mp4",
                bytes: 1,
                note: null,
                created_at: created,
              },
            ]
          : [];

      const { req, res } = reqRes({ params: { orderId: ORDER_A } });
      await call(routes.getCreatorJob, req, res);

      const creatorSide = (res.body as { job: { deadline: { kind: string; line: string; deadline_at: string; deadline_text: string } } }).job
        .deadline;
      const d = orderDeadlineForRow(
        {
          status,
          source: "booking",
          created_at: created,
          due_at: null,
          cancel_requested_at: status === "cancel_requested" ? created : null,
          last_submission_at: status === "submitted" ? created : null,
        },
        new Date(created),
      );
      expect(d).not.toBeNull();
      const businessSide = deadlineCopy(d!.kind, d!.deadline_at, { side: "business" });
      expect(creatorSide.kind).toBe(kind);
      expect(creatorSide.deadline_at).toBe(businessSide.deadline_at);
      expect(creatorSide.deadline_text).toBe(businessSide.deadline_text);
    },
  );

  it("never invents a deadline sentence of its own", async () => {
    state.rows.creator_orders = () =>
      order({
        status: "completed",
        closed_reason: "approved",
        closed_at: "2026-09-11T00:00:00.000Z",
      });
    state.rows.creator_submissions = () => [];
    const { req, res } = reqRes({ params: { orderId: ORDER_A } });
    await call(routes.getCreatorJob, req, res);
    expect((res.body as { job: { deadline: unknown } }).job.deadline).toBeNull();
  });
});

describe("a submission cannot point at another job's files", () => {
  beforeEach(() => {
    state.rows.creator_orders = () => order({ status: "in_progress" });
    state.rows.creator_submissions = () => [];
    transitionMock.mockResolvedValue({
      ok: true,
      order: order({ status: "submitted" }),
      trigger: "submit",
      from: "in_progress",
      to: "submitted",
      deadline: null,
      money: [],
      needs_staff_review: false,
      payout_waiting: false,
    });
  });

  it("refuses a storage path outside this order's prefix", async () => {
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: `${TENANT_B}/${ORDER_B}/theirs.mp4` }] },
    });
    await call(routes.postCreatorSubmission, req, res);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("bad_storage_path");
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("refuses a traversal path", async () => {
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/../../x.mp4` }] },
    });
    await call(routes.postCreatorSubmission, req, res);
    expect(res.statusCode).toBe(400);
  });

  it("accepts a path under this order and fires exactly one submit", async () => {
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: {
        files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/mine.mp4`, mime_type: "video/mp4", bytes: 10 }],
        note: "First cut.",
      },
    });
    await call(routes.postCreatorSubmission, req, res);

    expect(res.statusCode).toBe(200);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0][0]).toMatchObject({
      trigger: "submit",
      actor: "creator",
      submission_version: expect.any(Number),
    });
  });

  it("drops the just-inserted version when the submit is refused, so a retry does not burn a revision round", async () => {
    state.rows.creator_submissions = () => [{ version: 1, position: 0 }];
    transitionMock.mockResolvedValueOnce({ ok: false, code: "illegal_transition", message: "no" });
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/mine.mp4` }] },
    });
    await call(routes.postCreatorSubmission, req, res);

    expect(res.statusCode).toBe(400);
    const subCalls = calls.list.filter((c) => c.table === "creator_submissions");
    const inserted = subCalls.find((c) => c.ops.some((o) => o.op === "insert"));
    expect((inserted?.ops.find((o) => o.op === "insert")?.args[0] as { version: number }[])[0].version).toBe(2);
    const del = subCalls.find((c) => c.ops.some((o) => o.op === "delete"));
    expect(del).toBeDefined();
    expect(del!.ops).toEqual(
      expect.arrayContaining([
        { op: "eq", args: ["tenant_id", TENANT_A] },
        { op: "eq", args: ["order_id", ORDER_A] },
        { op: "eq", args: ["version", 2] },
      ]),
    );
  });

  it("stores and forwards the submission note with contact details removed, after hire as well", async () => {
    logEventMock.mockClear();
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: {
        files: [
          { kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/a.mp4` },
          { kind: "image", storage_path: `${TENANT_A}/${ORDER_A}/b.png` },
        ],
        note: "Cut 1 is up, dm me maya@gmail.com or 555 123 4567, or wa.me/15551234567 for the raw files. 3 videos for $150 done in 5 days.",
      },
    });
    await call(routes.postCreatorSubmission, req, res);

    expect(res.statusCode).toBe(200);
    const inserted = calls.list
      .filter((c) => c.table === "creator_submissions")
      .flatMap((c) => c.ops.filter((o) => o.op === "insert"))
      .flatMap((o) => o.args[0] as Array<{ note: string | null }>);
    expect(inserted).toHaveLength(2);
    const stored = inserted[0].note!;
    expect(stored).toBe(
      "Cut 1 is up, dm me [contact removed, keep it on Zavi] or [contact removed, keep it on Zavi], or [contact removed, keep it on Zavi] for the raw files. 3 videos for $150 done in 5 days.",
    );
    expect(inserted[1].note).toBeNull();

    const forwarded = transitionMock.mock.calls[0][0] as { note: string };
    expect(forwarded.note).toBe(stored);

    const everything = JSON.stringify([calls.list, transitionMock.mock.calls, logEventMock.mock.calls]);
    expect(everything).not.toContain("maya@gmail.com");
    expect(everything).not.toContain("4567");

    const scrubLog = logEventMock.mock.calls.map((c) => c[0]).find((e) => e.code === "creator.contact_scrubbed");
    expect(scrubLog?.message).toBe("contact details removed from a creator submission note (email, link, phone)");
  });

  it("leaves a clean submission note untouched and logs nothing", async () => {
    logEventMock.mockClear();
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: {
        files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/a.mp4` }],
        note: "First cut, 30 seconds, ready by 2026-10-20.",
      },
    });
    await call(routes.postCreatorSubmission, req, res);
    expect(res.statusCode).toBe(200);
    expect((transitionMock.mock.calls[0][0] as { note: string }).note).toBe("First cut, 30 seconds, ready by 2026-10-20.");
    expect(logEventMock.mock.calls.some((c) => c[0].code === "creator.contact_scrubbed")).toBe(false);
  });

  it("keeps the version when the submit lands", async () => {
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/mine.mp4` }] },
    });
    await call(routes.postCreatorSubmission, req, res);
    expect(res.statusCode).toBe(200);
    expect(
      calls.list.some((c) => c.table === "creator_submissions" && c.ops.some((o) => o.op === "delete")),
    ).toBe(false);
  });
});

describe("a creator outside the payout countries is told honestly", () => {
  it("reports payout_country_supported false rather than failing later", async () => {
    state.rows.human_members = () => ({ ...member(MEMBER_A, USER_A), country_code: "IN" });
    const { req, res } = reqRes();
    await call(routes.getCreatorMe, req, res);
    expect((res.body as { payout_country_supported: boolean }).payout_country_supported).toBe(false);
  });

  it("refuses to start Stripe onboarding for a creator who is not approved yet", async () => {
    state.rows.human_members = () => ({ ...member(MEMBER_A, USER_A, "pending"), country_code: "US" });
    const { req, res } = reqRes();
    await call(routes.postCreatorOnboardingLink, req, res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_approved");
  });

  it("never shows the creator Stripe's own refusal: a plain sentence for them, the real reason logged for Zavi", async () => {
    const STRIPE_TEXT =
      "We've temporarily restricted your ability to create this type of connected account due to suspicious activity. Please log in to the Stripe Dashboard to confirm that you intended to create this account, then try your request again.";
    state.rows.human_members = () => ({ ...member(MEMBER_A, USER_A), country_code: "US" });
    ensurePayoutMock.mockRejectedValueOnce(
      wrapPlatformStripeError({ type: "StripePermissionError", message: STRIPE_TEXT, statusCode: 403 }),
    );
    logEventMock.mockClear();
    const { req, res } = reqRes();
    await call(routes.postCreatorOnboardingLink, req, res);
    expect(res.statusCode).toBe(503);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("payout_setup_unavailable");
    expect(body.error.message).toMatch(/Your earnings are safe with Zavi/);
    expect(JSON.stringify(res.body)).not.toMatch(/suspicious|Stripe Dashboard|restricted/i);
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(logEventMock.mock.calls[0][0].code).toBe("creator_payout_setup_stripe_refused");
    expect(logEventMock.mock.calls[0][0].message).toContain("suspicious activity");
  });

  it("an unexpected failure while setting up payouts stays the generic error, not a Stripe one", async () => {
    state.rows.human_members = () => ({ ...member(MEMBER_A, USER_A), country_code: "US" });
    ensurePayoutMock.mockRejectedValueOnce(new Error("db down"));
    const { req, res } = reqRes();
    await call(routes.postCreatorOnboardingLink, req, res);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("creator_unavailable");
  });

  it("refuses to start Stripe onboarding for an unreachable country", async () => {
    state.rows.human_members = () => ({ ...member(MEMBER_A, USER_A), country_code: "IN" });
    const { req, res } = reqRes();
    await call(routes.postCreatorOnboardingLink, req, res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "creator_payout_country_unsupported",
    );
  });
});

describe("GET /api/creator/threads (D8)", () => {
  const THREAD_A = "7a7a7a7a-1111-4111-8111-7a7a7a7a7a7a";

  it("lists threads by the bearer's member id and ignores any id in the query", async () => {
    state.rows.creator_threads = () => [
      { id: THREAD_A, tenant_id: TENANT_A, last_message_at: "2026-09-24T10:00:00.000Z", created_at: "2026-09-20T10:00:00.000Z" },
    ];
    state.rows.creator_thread_messages = () => [
      { thread_id: THREAD_A, body: "Great, I sent you an offer for two.", sender_kind: "tenant", created_at: "2026-09-24T10:00:00.000Z" },
    ];
    state.rows.creator_offers = () => [
      {
        thread_id: THREAD_A,
        proposed_by: "tenant",
        kind: "ugc_video",
        terms: { title: "2 TikTok videos" },
        price_cents: 26000,
        expires_at: "2999-01-01T00:00:00.000Z",
        created_at: "2026-09-24T10:00:00.000Z",
      },
    ];
    state.rows.tenants = () => ({ display_name: "Bloom Studio" });

    const { req, res } = reqRes({ query: { human_member_id: MEMBER_B } });
    await call(routes.getCreatorThreads, req, res);

    expect(res.statusCode).toBe(200);
    expect(eqsFor("creator_threads")).toContainEqual(["human_member_id", MEMBER_A]);
    expect(JSON.stringify(eqsFor("creator_threads"))).not.toContain(MEMBER_B);
    expect(eqsFor("creator_offers")).toContainEqual(["human_member_id", MEMBER_A]);
    const body = res.body as { threads: Array<Record<string, unknown>> };
    expect(body.threads).toHaveLength(1);
    const t = body.threads[0];
    expect(t.business_name).toBe("Bloom Studio");
    expect(t).not.toHaveProperty("tenant_id");
    expect((t.open_offer as { creator_payout_cents: number }).creator_payout_cents).toBe(
      computeCreatorFees(26000).creator_payout_cents,
    );
  });

  it("drops an offer past its 72h clock even while the row still says open", async () => {
    state.rows.creator_threads = () => [
      { id: THREAD_A, tenant_id: TENANT_A, last_message_at: null, created_at: "2026-09-20T10:00:00.000Z" },
    ];
    state.rows.creator_thread_messages = () => [];
    state.rows.creator_offers = () => [
      { thread_id: THREAD_A, proposed_by: "tenant", kind: "ugc_video", terms: {}, price_cents: 1000, expires_at: "2020-01-01T00:00:00.000Z", created_at: "2019-12-29T00:00:00.000Z" },
    ];
    const { req, res } = reqRes();
    await call(routes.getCreatorThreads, req, res);
    const body = res.body as { threads: Array<{ open_offer: unknown; last_message_at: string }> };
    expect(body.threads[0].open_offer).toBeNull();
    expect(body.threads[0].last_message_at).toBe("2026-09-20T10:00:00.000Z");
  });

  it("refuses a business token", async () => {
    verifyBearerMock.mockResolvedValue({ user_id: USER_FOUNDER, access_token: "tok", session_id: null, claim_tenant_id: TENANT_B });
    const { req, res } = reqRes();
    await call(routes.getCreatorThreads, req, res);
    expect(res.statusCode).toBe(403);
    expect(calls.list.some((c) => c.table === "creator_threads")).toBe(false);
  });
});

describe("job view: business name, rounds of changes and the change note", () => {
  it("counts rounds the way the business does and returns what they asked for", async () => {
    state.rows.creator_orders = () => order({ status: "revision_requested", thread_id: null });
    state.rows.creator_submissions = () => [
      { id: "s1", order_id: ORDER_A, version: 1, position: 0, kind: "video", mime_type: "video/mp4", bytes: 1, note: null, created_at: "2026-09-12T00:00:00.000Z", storage_path: "x" },
    ];
    state.rows.creator_notifications = () => [
      { body: "Can the hook show the latte in the first second?\n\nChanges have to match what was ordered.", created_at: "2026-09-13T00:00:00.000Z" },
    ];
    state.rows.tenants = () => ({ display_name: "Acme Coffee" });
    const { req, res } = reqRes({ params: { orderId: ORDER_A } });
    await call(routes.getCreatorJob, req, res);
    expect(res.statusCode).toBe(200);
    const job = (res.body as { job: Record<string, unknown> }).job;
    expect(job.business_name).toBe("Acme Coffee");
    expect(job.revisions_used).toBe(1);
    expect(job.revisions_max).toBe(2);
    expect(job.change_request_note).toBe("Can the hook show the latte in the first second?");
    expect(eqsFor("creator_notifications")).toContainEqual(["human_member_id", MEMBER_A]);
  });

  it("does not present Zavi's fallback sentence as the business's words", async () => {
    state.rows.creator_orders = () => order({ status: "revision_requested" });
    state.rows.creator_submissions = () => [];
    state.rows.creator_notifications = () => [
      { body: "Acme Coffee asked for changes on One vertical video. The notes are in the job thread.", created_at: "x" },
    ];
    const { req, res } = reqRes({ params: { orderId: ORDER_A } });
    await call(routes.getCreatorJob, req, res);
    expect((res.body as { job: Record<string, unknown> }).job.change_request_note).toBeNull();
  });
});

describe("POST /api/creator/jobs/:orderId/dispute (Ask Zavi for help)", () => {
  it("maps to exactly one open_dispute transition on the creator's own order", async () => {
    state.rows.creator_orders = () => order({ status: "in_progress" });
    transitionMock.mockResolvedValue({ ok: true, from: "in_progress", to: "in_dispute", payout_waiting: false });
    const { req, res } = reqRes({ params: { orderId: ORDER_A }, body: { reason: "They stopped answering." } });
    await call(routes.postCreatorDispute, req, res);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0][0]).toMatchObject({
      trigger: "open_dispute",
      actor: "creator",
      note: "They stopped answering.",
      dispute: { kind: "step_in", opened_by: "creator", opened_by_user_id: USER_A, reason: "They stopped answering." },
    });
    expect(eqsFor("creator_orders")).toContainEqual(["human_member_id", MEMBER_A]);
  });

  it("needs a reason and never transitions without one", async () => {
    const { req, res } = reqRes({ params: { orderId: ORDER_A }, body: {} });
    await call(routes.postCreatorDispute, req, res);
    expect(res.statusCode).toBe(400);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("answers 404 for another creator's order", async () => {
    state.rows.creator_orders = () => null;
    const { req, res } = reqRes({ params: { orderId: ORDER_B }, body: { reason: "x" } });
    await call(routes.postCreatorDispute, req, res);
    expect(res.statusCode).toBe(404);
    expect(transitionMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/creator/jobs/:orderId/cancellation answer=dispute", () => {
  it("passes the cancel_dispute row the freeze needs, opened by the creator", async () => {
    state.rows.creator_orders = () => order({ status: "cancel_requested" });
    transitionMock.mockResolvedValue({ ok: true, from: "cancel_requested", to: "in_dispute", payout_waiting: false });
    const { req, res } = reqRes({ params: { orderId: ORDER_A }, body: { answer: "dispute", reason: "The work is done." } });
    await call(routes.postCreatorCancellationResponse, req, res);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0][0]).toMatchObject({
      trigger: "cancel_disputed",
      actor: "creator",
      dispute: { kind: "cancel_dispute", opened_by: "creator", opened_by_user_id: USER_A, reason: "The work is done." },
    });
  });

  it("agree and decline carry no dispute row", async () => {
    state.rows.creator_orders = () => order({ status: "cancel_requested" });
    transitionMock.mockResolvedValue({ ok: true, from: "cancel_requested", to: "in_progress", payout_waiting: false });
    const { req, res } = reqRes({ params: { orderId: ORDER_A }, body: { answer: "decline" } });
    await call(routes.postCreatorCancellationResponse, req, res);
    expect(transitionMock.mock.calls[0][0]).not.toHaveProperty("dispute");
  });
});

describe("job-page messages go through the one scrubbed writer (thread.ts)", () => {
  it("stores the scrubbed body, not the raw one", async () => {
    state.rows.creator_orders = () => order({ status: "in_progress", thread_id: "7a7a7a7a-1111-4111-8111-7a7a7a7a7a7a" });
    state.rows.creator_thread_messages = () => ({ id: "m1", sender_kind: "creator", body: "x", created_at: "2026-09-25T00:00:00.000Z" });
    const { req, res } = reqRes({ params: { orderId: ORDER_A }, body: { body: "Text me at 512-555-0199 or maya@example.com" } });
    await call(routes.postCreatorMessage, req, res);
    expect(res.statusCode).toBe(200);
    const insert = calls.list
      .filter((c) => c.table === "creator_thread_messages")
      .flatMap((c) => c.ops.filter((o) => o.op === "insert"))[0];
    const row = insert.args[0] as { body: string; sender_kind: string };
    expect(row.sender_kind).toBe("creator");
    expect(row.body).not.toContain("512-555-0199");
    expect(row.body).not.toContain("maya@example.com");
  });
});

describe("rounds of changes use the gate's distinct-version count", () => {
  it("versions {1, 3} after a refused submit are 2 rounds, so 1 change used on a submitted job", async () => {
    state.rows.creator_orders = () => order({ status: "submitted" });
    state.rows.creator_submissions = () => [
      { id: "s1", order_id: ORDER_A, version: 1, position: 0, kind: "video", mime_type: "video/mp4", bytes: 1, note: null, created_at: "2026-09-12T00:00:00.000Z", storage_path: "x" },
      { id: "s3", order_id: ORDER_A, version: 3, position: 0, kind: "video", mime_type: "video/mp4", bytes: 1, note: null, created_at: "2026-09-14T00:00:00.000Z", storage_path: "y" },
    ];
    const { req, res } = reqRes({ params: { orderId: ORDER_A } });
    await call(routes.getCreatorJob, req, res);
    expect((res.body as { job: { revisions_used: number } }).job.revisions_used).toBe(1);
  });
});

describe("a submission only records files that are really in the bucket", () => {
  const OK_SUBMIT = {
    ok: true,
    order: order({ status: "submitted" }),
    trigger: "submit",
    from: "in_progress",
    to: "submitted",
    deadline: null,
    money: [],
    needs_staff_review: false,
    payout_waiting: false,
  };

  beforeEach(() => {
    state.rows.creator_orders = () => order({ status: "in_progress" });
    state.rows.creator_submissions = () => [];
    transitionMock.mockResolvedValue(OK_SUBMIT);
  });

  const submissionWrites = () =>
    calls.list.filter(
      (c) => c.table === "creator_submissions" && c.ops.some((o) => ["insert", "update", "upsert"].includes(o.op)),
    );

  it("refuses a path with no object behind it, writes no rows and moves no status", async () => {
    const real = `${TENANT_A}/${ORDER_A}/real.mp4`;
    const ghost = `${TENANT_A}/${ORDER_A}/never-uploaded.mp4`;
    storage.objects[real] = { size: 5000, contentType: "video/mp4" };
    storage.objects[ghost] = null;
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: {
        files: [
          { kind: "video", storage_path: real },
          { kind: "video", storage_path: ghost, mime_type: "video/mp4", bytes: 99999999 },
        ],
      },
    });
    await call(routes.postCreatorSubmission, req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: { code: "upload_missing", message: "That file did not finish uploading. Upload it again." },
    });
    expect(submissionWrites()).toHaveLength(0);
    expect(transitionMock).not.toHaveBeenCalled();
    expect(calls.list.some((c) => c.table === "creator_orders" && c.ops.some((o) => o.op === "update"))).toBe(false);
    expect(storage.calls.filter((c) => c.op === "info")).toEqual(
      expect.arrayContaining([{ bucket: "creator-deliverables", op: "info", path: ghost }]),
    );
  });

  it("refuses an empty object as not uploaded", async () => {
    const empty = `${TENANT_A}/${ORDER_A}/empty.mp4`;
    storage.objects[empty] = { size: 0, contentType: "video/mp4" };
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: empty, bytes: 1000 }] },
    });
    await call(routes.postCreatorSubmission, req, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("upload_missing");
    expect(submissionWrites()).toHaveLength(0);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("records the stored size and type over whatever the client claimed", async () => {
    const path = `${TENANT_A}/${ORDER_A}/cut.mov`;
    storage.objects[path] = { size: 7340032, contentType: "video/quicktime" };
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: path, mime_type: "video/mp4", bytes: 1 }] },
    });
    await call(routes.postCreatorSubmission, req, res);

    expect(res.statusCode).toBe(200);
    const inserted = submissionWrites()
      .flatMap((c) => c.ops.filter((o) => o.op === "insert"))
      .flatMap((o) => o.args[0] as Array<{ storage_path: string; mime_type: string | null; bytes: number | null }>);
    expect(inserted).toEqual([
      expect.objectContaining({ storage_path: path, mime_type: "video/quicktime", bytes: 7340032 }),
    ]);
  });

  it("answers a storage outage as retryable and records nothing", async () => {
    storage.infoError = { message: "upstream timeout", status: 503 };
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/a.mp4` }] },
    });
    await call(routes.postCreatorSubmission, req, res);
    expect(res.statusCode).toBe(502);
    expect(submissionWrites()).toHaveLength(0);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("never probes the bucket for a path outside this order's prefix", async () => {
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: `${TENANT_B}/${ORDER_B}/theirs.mp4` }] },
    });
    await call(routes.postCreatorSubmission, req, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("bad_storage_path");
    expect(storage.calls).toHaveLength(0);
    expect(submissionWrites()).toHaveLength(0);
  });
});

describe("a submit whose transition throws does not burn a change round", () => {
  type SubRow = { tenant_id: string; order_id: string; version: number; position: number };
  let store: SubRow[];
  let orderStatus: string;

  const eqOf = (c: Call, col: string) => c.ops.find((o) => o.op === "eq" && o.args[0] === col)?.args[1];

  beforeEach(() => {
    store = [];
    orderStatus = "in_progress";
    state.rows.creator_orders = () => order({ status: orderStatus });
    state.rows.creator_submissions = (c) => {
      const ins = c.ops.find((o) => o.op === "insert");
      if (ins) {
        const rows = ins.args[0] as SubRow[];
        store.push(...rows);
        return rows;
      }
      if (c.ops.some((o) => o.op === "delete")) {
        store = store.filter(
          (r) =>
            !(r.tenant_id === eqOf(c, "tenant_id") && r.order_id === eqOf(c, "order_id") && r.version === eqOf(c, "version")),
        );
        return null;
      }
      return [...store];
    };
  });

  const submit = async () => {
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/cut.mp4` }] },
    });
    await call(routes.postCreatorSubmission, req, res);
    return res;
  };

  it("drops the version when the transition throws before landing, so the retry is version 1 again", async () => {
    transitionMock.mockRejectedValueOnce(new Error("connection reset"));
    const first = await submit();
    expect(first.statusCode).toBe(500);
    expect(store).toEqual([]);

    transitionMock.mockImplementationOnce(async () => {
      orderStatus = "submitted";
      return {
        ok: true,
        order: order({ status: "submitted" }),
        trigger: "submit",
        from: "in_progress",
        to: "submitted",
        deadline: null,
        money: [],
        needs_staff_review: false,
        payout_waiting: false,
      };
    });
    const retry = await submit();
    expect(retry.statusCode).toBe(200);
    expect(store.map((r) => r.version)).toEqual([1]);
    expect(transitionMock.mock.calls[1][0]).toMatchObject({ trigger: "submit", submission_version: 1 });
  });

  it("keeps the version when the transition landed and then threw", async () => {
    transitionMock.mockImplementationOnce(async () => {
      orderStatus = "submitted";
      throw new Error("notice send failed after the status write");
    });
    const res = await submit();
    expect(res.statusCode).toBe(500);
    expect(store.map((r) => r.version)).toEqual([1]);
    expect(
      calls.list.some((c) => c.table === "creator_submissions" && c.ops.some((o) => o.op === "delete")),
    ).toBe(false);
  });

  it("keeps the version when the state cannot be reloaded, rather than guessing it did not land", async () => {
    transitionMock.mockImplementationOnce(async () => {
      state.rows.creator_orders = () => {
        throw new Error("db unreachable");
      };
      throw new Error("timeout");
    });
    const res = await submit();
    expect(res.statusCode).toBe(500);
    expect(store.map((r) => r.version)).toEqual([1]);
  });
});

describe("upload and submit are only open while the job is waiting for work", () => {
  beforeEach(() => {
    state.rows.creator_submissions = () => [];
    transitionMock.mockResolvedValue({ ok: true, order: order({ status: "submitted" }), from: "in_progress", to: "submitted" });
  });

  it.each(["awaiting_acceptance", "submitted", "in_dispute"])(
    "refuses a submit while the job is %s, before any storage lookup, row or transition",
    async (status) => {
      state.rows.creator_orders = () => order({ status });
      const { req, res } = reqRes({
        params: { orderId: ORDER_A },
        body: { files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/cut.mp4` }] },
      });
      await call(routes.postCreatorSubmission, req, res);
      expect(res.statusCode).toBe(409);
      expect((res.body as { error: { code: string } }).error.code).toBe("not_open_for_delivery");
      expect(storage.calls).toHaveLength(0);
      expect(calls.list.some((c) => c.table === "creator_submissions" && c.ops.some((o) => o.op === "insert"))).toBe(false);
      expect(transitionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["awaiting_acceptance", "submitted", "in_dispute"])(
    "mints no upload url while the job is %s",
    async (status) => {
      state.rows.creator_orders = () => order({ status });
      const { req, res } = reqRes({ params: { orderId: ORDER_A }, body: { content_type: "video/mp4" } });
      await call(routes.postCreatorUploadUrl, req, res);
      expect(res.statusCode).toBe(409);
      expect((res.body as { error: { code: string } }).error.code).toBe("not_open_for_delivery");
      expect(storage.calls).toHaveLength(0);
    },
  );

  it.each(["in_progress", "revision_requested"])("lets a submit through while the job is %s", async (status) => {
    state.rows.creator_orders = () => order({ status });
    const { req, res } = reqRes({
      params: { orderId: ORDER_A },
      body: { files: [{ kind: "video", storage_path: `${TENANT_A}/${ORDER_A}/cut.mp4` }] },
    });
    await call(routes.postCreatorSubmission, req, res);
    expect(res.statusCode).toBe(200);
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });
});
