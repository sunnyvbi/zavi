
import { describe, expect, it, vi, beforeEach } from "vitest";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "99999999-9999-9999-9999-999999999999";
const ORDER = "22222222-2222-2222-2222-222222222222";
const PACKAGE = "44444444-4444-4444-4444-444444444444";
const APPLICATION = "55555555-5555-5555-5555-555555555555";

const { requireAuthMock, authState } = vi.hoisted(() => {
  const s = { tenant_id: "11111111-1111-1111-1111-111111111111", user_id: "u1", authed: true };
  return {
    authState: s,
    requireAuthMock: vi.fn(async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      if (!s.authed) {
        res.status(401).json({ error: { code: "unauthenticated", message: "no" } });
        return null;
      }
      return { user_id: s.user_id, tenant_id: s.tenant_id, access_token: "tok" };
    }),
  };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: requireAuthMock }));

const { calls, behaviour } = vi.hoisted(() => ({
  calls: { list: [] as { fn: string; tenant_id: string; args: unknown }[] },
  behaviour: {
    quoteThrows: null as { code: string; message: string } | null,
    jobFound: true,
    actionResult: null as { ok: false; code: string; message: string } | null,
  },
}));

vi.mock("@/services/creators/booking", async () => {
  const real = await vi.importActual<typeof import("@/services/creators/booking")>(
    "@/services/creators/booking",
  );
  return {
    ...real,
    quoteCreatorBooking: vi.fn(async (a: { tenant_id: string }) => {
      calls.list.push({ fn: "quote", tenant_id: a.tenant_id, args: a });
      if (behaviour.quoteThrows) {
        const { ExpectedToolError } = await import("@/services/tools/types");
        throw new ExpectedToolError(behaviour.quoteThrows.code, behaviour.quoteThrows.message);
      }
      return { money: { business_total_cents: 16_500 }, blocked: null };
    }),
    startCreatorCheckout: vi.fn(async (a: { tenant_id: string }) => {
      calls.list.push({ fn: "create", tenant_id: a.tenant_id, args: a });
      if (behaviour.quoteThrows) {
        const { ExpectedToolError } = await import("@/services/tools/types");
        throw new ExpectedToolError(behaviour.quoteThrows.code, behaviour.quoteThrows.message);
      }
      return {
        order_id: ORDER,
        checkout_url: "https://checkout.stripe.test/x",
        checkout_session_id: "cs_1",
        quote: { money: { business_total_cents: 16_500 } },
        reused_existing: false,
      };
    }),
  };
});

vi.mock("@/services/creators/checkout-fulfil", () => ({
  fulfilCreatorCheckout: vi.fn(async (a: { tenant_id: string; order_id: string }) => {
    calls.list.push({ fn: "fulfil", tenant_id: a.tenant_id, args: a });
    if (!behaviour.jobFound) {
      const { ExpectedToolError } = await import("@/services/tools/types");
      throw new ExpectedToolError("creator_order_not_found", "not here");
    }
    return { state: "fulfilled", order_id: a.order_id, status: "awaiting_acceptance" };
  }),
}));

vi.mock("@/services/creators/jobs-views", () => ({
  listBusinessJobs: vi.fn(async (tenant_id: string) => {
    calls.list.push({ fn: "list", tenant_id, args: null });
    return { jobs: [] };
  }),
  getBusinessJob: vi.fn(async (tenant_id: string, order_id: string) => {
    calls.list.push({ fn: "detail", tenant_id, args: order_id });
    return behaviour.jobFound ? { job: { id: order_id }, actions: [] } : null;
  }),
}));

vi.mock("@/services/creators/business-actions", async () => {
  const real = await vi.importActual<typeof import("@/services/creators/business-actions")>(
    "@/services/creators/business-actions",
  );
  return {
    ...real,
    runBusinessAction: vi.fn(async (a: { tenant_id: string; action: string }) => {
      calls.list.push({ fn: "action", tenant_id: a.tenant_id, args: a });
      return (
        behaviour.actionResult ?? {
          ok: true,
          from: "submitted",
          to: "completed",
          needs_staff_review: false,
          payout_waiting: false,
          library_asset_created: true,
        }
      );
    }),
  };
});

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

const { checkoutOrders, resumeMock } = vi.hoisted(() => ({
  checkoutOrders: new Map<string, { tenant_id: string; agent_run_id: string | null }>(),
  resumeMock: vi.fn(async (a: { tenant_id: string; order_id: string }) => ({ order_id: a.order_id, checkout_url: "https://checkout.stripe.test/resumed" })),
}));
vi.mock("@/services/creators/booking-db", async () => {
  const real = await vi.importActual<typeof import("@/services/creators/booking-db")>("@/services/creators/booking-db");
  return {
    ...real,
    loadOrderForCheckout: vi.fn(async (tenant_id: string, order_id: string) => {
      const o = checkoutOrders.get(order_id);
      return o && o.tenant_id === tenant_id ? { id: order_id, tenant_id, agent_run_id: o.agent_run_id } : null;
    }),
  };
});
vi.mock("@/services/creators/checkout-resume", () => ({ resumeOrderCheckout: resumeMock }));

import {
  getCreatorOrder,
  getCreatorOrders,
  postCreatorOrder,
  postCreatorOrderAction,
  postCreatorOrderCheckout,
  postCreatorOrderFulfil,
  postCreatorOrderQuote,
} from "../orders";

type Res = {
  statusCode: number;
  body: unknown;
  status: (n: number) => Res;
  json: (b: unknown) => Res;
};

function mkRes(): Res {
  const r: Res = {
    statusCode: 200,
    body: null,
    status(n) {
      r.statusCode = n;
      return r;
    },
    json(b) {
      r.body = b;
      return r;
    },
  };
  return r;
}

function mkReq(over: { params?: Record<string, string>; body?: unknown } = {}) {
  return { params: over.params ?? {}, body: over.body ?? {}, headers: {} } as never;
}

beforeEach(() => {
  calls.list = [];
  behaviour.quoteThrows = null;
  behaviour.jobFound = true;
  behaviour.actionResult = null;
  authState.tenant_id = TENANT_A;
  authState.user_id = "u1";
  authState.authed = true;
});

type Handler = (req: never, res: never) => Promise<void>;

const ROUTES: {
  name: string;
  handler: Handler;
  req: never;
}[] = [
  {
    name: "POST /orders/quote",
    handler: postCreatorOrderQuote as Handler,
    req: mkReq({ body: { target: { package_id: PACKAGE } } }),
  },
  {
    name: "POST /orders",
    handler: postCreatorOrder as Handler,
    req: mkReq({ body: { target: { package_id: PACKAGE } } }),
  },
  {
    name: "POST /orders/:id/fulfil",
    handler: postCreatorOrderFulfil as Handler,
    req: mkReq({ params: { orderId: ORDER } }),
  },
  { name: "GET /orders", handler: getCreatorOrders as Handler, req: mkReq() },
  {
    name: "GET /orders/:id",
    handler: getCreatorOrder as Handler,
    req: mkReq({ params: { orderId: ORDER } }),
  },
  {
    name: "POST /orders/:id/actions",
    handler: postCreatorOrderAction as Handler,
    req: mkReq({ params: { orderId: ORDER }, body: { action: "approve" } }),
  },
];

async function run(r: (typeof ROUTES)[number]): Promise<Res> {
  const res = mkRes();
  await r.handler(r.req, res as never);
  return res;
}

describe("every route is authed", () => {
  it("answers 401 and touches no service when the caller is not signed in", async () => {
    for (const r of ROUTES) {
      calls.list = [];
      authState.authed = false;
      const res = await run(r);
      expect(res.statusCode, r.name).toBe(401);
      expect(calls.list, r.name).toEqual([]);
      authState.authed = true;
    }
  });
});

describe("cross-tenant isolation", () => {
  it("scopes EVERY route on the authed tenant, never on the request", async () => {
    for (const r of ROUTES) {
      calls.list = [];
      authState.tenant_id = TENANT_A;
      await run(r);
      expect(calls.list.length, r.name).toBeGreaterThan(0);
      expect(new Set(calls.list.map((c) => c.tenant_id)), r.name).toEqual(new Set([TENANT_A]));
    }
  });

  it("follows the authed tenant when it changes, with identical request ids", async () => {
    for (const r of ROUTES) {
      calls.list = [];
      authState.tenant_id = TENANT_B;
      await run(r);
      expect(calls.list.length, r.name).toBeGreaterThan(0);
      expect(new Set(calls.list.map((c) => c.tenant_id)), r.name).toEqual(new Set([TENANT_B]));
      expect(calls.list.some((c) => c.tenant_id === TENANT_A), r.name).toBe(false);
    }
  });

  it("answers 404, not 403, for an order that belongs to another workspace", async () => {
    behaviour.jobFound = false;
    const res = mkRes();
    await getCreatorOrder(mkReq({ params: { orderId: ORDER } }), res as never);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "creator_order_not_found" } });

    const res2 = mkRes();
    await postCreatorOrderFulfil(mkReq({ params: { orderId: ORDER } }), res2 as never);
    expect(res2.statusCode).toBe(404);
  });

  it("rejects a malformed order id before any service call", async () => {
    for (const handler of [getCreatorOrder, postCreatorOrderFulfil, postCreatorOrderAction]) {
      calls.list = [];
      const res = mkRes();
      await handler(
        mkReq({ params: { orderId: "../../etc/passwd" }, body: { action: "approve" } }),
        res as never,
      );
      expect(res.statusCode).toBe(400);
      expect(calls.list).toEqual([]);
    }
  });
});

describe("spec item 29: no role gate", () => {
  it("lets an owner, an admin and a plain member all book and approve", async () => {
    for (const user of ["owner-1", "admin-1", "member-1"]) {
      calls.list = [];
      authState.user_id = user;
      const res = mkRes();
      await postCreatorOrder(mkReq({ body: { target: { package_id: PACKAGE } } }), res as never);
      expect(res.statusCode, user).toBe(200);

      const res2 = mkRes();
      await postCreatorOrderAction(
        mkReq({ params: { orderId: ORDER }, body: { action: "approve" } }),
        res2 as never,
      );
      expect(res2.statusCode, user).toBe(200);
    }
  });
});

describe("error translation", () => {
  it("surfaces the $500 refusal as a 409 with its own code", async () => {
    behaviour.quoteThrows = {
      code: "large_amount_confirm_required",
      message: "This job comes to $1000.00, which is over $500.",
    };
    const res = mkRes();
    await postCreatorOrder(mkReq({ body: { target: { package_id: PACKAGE } } }), res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      error: { code: "large_amount_confirm_required" },
    });
  });

  it("surfaces an unbookable creator as a 409 with a sentence", async () => {
    behaviour.quoteThrows = {
      code: "creator_payout_country_unsupported",
      message: "Zavi cannot pay creators in this country yet.",
    };
    const res = mkRes();
    await postCreatorOrder(mkReq({ body: { target: { package_id: PACKAGE } } }), res as never);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { message: string } }).error.message).toContain("cannot pay");
  });

  it("passes the $500 confirm through when the caller gives it", async () => {
    const res = mkRes();
    await postCreatorOrder(
      mkReq({
        body: { target: { package_id: PACKAGE }, large_amount_confirmed: true },
      }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const call = calls.list.find((c) => c.fn === "create");
    expect(call?.args).toMatchObject({ large_amount_confirmed: true });
  });

  it("refuses an illegal action with S3's reason and a 409", async () => {
    behaviour.actionResult = {
      ok: false,
      code: "illegal_transition",
      message: "'approve' cannot run on an order that is in_progress.",
    };
    const res = mkRes();
    await postCreatorOrderAction(
      mkReq({ params: { orderId: ORDER }, body: { action: "approve" } }),
      res as never,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { message: string } }).error.message).toContain(
      "cannot run on an order",
    );
  });

  it("refuses an action name that is not in the map", async () => {
    calls.list = [];
    const res = mkRes();
    await postCreatorOrderAction(
      mkReq({ params: { orderId: ORDER }, body: { action: "creator_accept" } }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(calls.list).toEqual([]);
  });

  it("refuses a booking that names two doors at once", async () => {
    calls.list = [];
    const res = mkRes();
    await postCreatorOrder(
      mkReq({ body: { target: { package_id: PACKAGE, application_id: APPLICATION } } }),
      res as never,
    );
    expect(calls.list.length).toBeLessThanOrEqual(1);
    if (calls.list.length === 1) {
      const t = (calls.list[0].args as { target: Record<string, string> }).target;
      expect(Object.keys(t).filter((k) => k.endsWith("_id"))).toHaveLength(1);
    }
  });
});

describe("the brief a business may type at checkout", () => {
  it("sends null when no brief was typed, and the order still goes through", async () => {
    const res = mkRes();
    await postCreatorOrder(mkReq({ body: { target: { package_id: PACKAGE } } }), res as never);
    expect(res.statusCode).toBe(200);
    const args = calls.list.find((c) => c.fn === "create")?.args as {
      brief_snapshot_override: unknown;
    };
    expect(args.brief_snapshot_override).toBeNull();
  });

  it("sends null for a blank brief, and the order still goes through", async () => {
    const res = mkRes();
    await postCreatorOrder(
      mkReq({ body: { target: { package_id: PACKAGE }, brief_title: "  ", brief: "\n" } }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const args = calls.list.find((c) => c.fn === "create")?.args as {
      brief_snapshot_override: unknown;
    };
    expect(args.brief_snapshot_override).toBeNull();
  });

  it("passes a typed brief through as a plain object", async () => {
    const res = mkRes();
    await postCreatorOrder(
      mkReq({
        body: {
          target: { package_id: PACKAGE },
          brief_title: "Beach launch",
          brief: "Film the unboxing outdoors.",
        },
      }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const args = calls.list.find((c) => c.fn === "create")?.args as {
      brief_snapshot_override: unknown;
    };
    expect(args.brief_snapshot_override).toEqual({
      title: "Beach launch",
      brief: "Film the unboxing outdoors.",
    });
  });

  it("does NOT let a typed brief reach the applicant door", async () => {
    const res = mkRes();
    await postCreatorOrder(
      mkReq({
        body: {
          target: { application_id: APPLICATION },
          brief_title: "Not this",
          brief: "Nor this",
        },
      }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const args = calls.list.find((c) => c.fn === "create")?.args as Record<string, unknown>;
    expect(args.brief_snapshot_override).toBeUndefined();
  });

  it("refuses an over-long brief at the door, touching no service", async () => {
    calls.list = [];
    const res = mkRes();
    await postCreatorOrder(
      mkReq({ body: { target: { package_id: PACKAGE }, brief: "b".repeat(4001) } }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(calls.list).toEqual([]);
  });
});

describe("the return URL Stripe is given", () => {
  it("is built from our own origin, never from the caller", async () => {
    process.env.WEB_ORIGIN = "https://www.zaviagent.com";
    const res = mkRes();
    await postCreatorOrder(
      mkReq({
        body: {
          target: { package_id: PACKAGE },
          return_path: "https://evil.test/steal",
        },
      }),
      res as never,
    );
    const args = calls.list.find((c) => c.fn === "create")?.args as {
      success_url: string;
      cancel_url: string;
    };
    expect(args.success_url.startsWith("https://www.zaviagent.com/humans/jobs/")).toBe(true);
    expect(args.success_url).not.toContain("evil.test");
    expect(args.cancel_url).not.toContain("evil.test");
  });

  it("accepts a safe relative path", async () => {
    process.env.WEB_ORIGIN = "https://www.zaviagent.com";
    const res = mkRes();
    await postCreatorOrder(
      mkReq({ body: { target: { package_id: PACKAGE }, return_path: "/humans/jobs" } }),
      res as never,
    );
    const args = calls.list.find((c) => c.fn === "create")?.args as { success_url: string };
    expect(args.success_url).toBe("https://www.zaviagent.com/humans/jobs/{ORDER_ID}?paid=1");
  });

  it("returns a UGC hub booking to its job drawer, paid or left", async () => {
    process.env.WEB_ORIGIN = "https://www.zaviagent.com";
    const res = mkRes();
    await postCreatorOrder(mkReq({ body: { target: { package_id: PACKAGE }, return_path: "ugc" } }), res as never);
    const args = calls.list.find((c) => c.fn === "create")?.args as { success_url: string; cancel_url: string };
    expect(args.success_url).toBe(
      "https://www.zaviagent.com/workspace?tab=channels&channel=ugc&drawer=job&job={ORDER_ID}&paid=1",
    );
    expect(args.cancel_url).toBe("https://www.zaviagent.com/workspace?tab=channels&channel=ugc&drawer=job&job={ORDER_ID}&cancelled=1");
  });
});

describe("reopening Checkout for an agent hire (M2)", () => {
  beforeEach(() => {
    checkoutOrders.clear();
    resumeMock.mockClear();
  });

  it("an order stamped with an agent run answers 409 with the hire card copy, and Checkout is never reopened", async () => {
    checkoutOrders.set(ORDER, { tenant_id: TENANT_A, agent_run_id: "run-1" });
    const res = mkRes();
    await postCreatorOrderCheckout(mkReq({ params: { orderId: ORDER } }) as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: { code: "creator_hire_awaiting_approval", message: "This hire is waiting for the founder's approval on its hire card." },
    });
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("a person's own unpaid order still reopens Checkout", async () => {
    checkoutOrders.set(ORDER, { tenant_id: TENANT_A, agent_run_id: null });
    const res = mkRes();
    await postCreatorOrderCheckout(mkReq({ params: { orderId: ORDER } }) as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(resumeMock).toHaveBeenCalledWith({ tenant_id: TENANT_A, order_id: ORDER });
  });

  it("another workspace's agent order is not read as this workspace's: the tenant scope decides", async () => {
    checkoutOrders.set(ORDER, { tenant_id: TENANT_B, agent_run_id: "run-1" });
    const res = mkRes();
    await postCreatorOrderCheckout(mkReq({ params: { orderId: ORDER } }) as never, res as never);
    expect(resumeMock).toHaveBeenCalledWith({ tenant_id: TENANT_A, order_id: ORDER });
  });
});
