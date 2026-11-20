import { describe, expect, it } from "vitest";
import {
  defineFunction,
  defineSchedule,
  defineWebhook,
  FunctionError,
  isDefinedFunction,
  type FunctionDataApi,
  type FunctionRecord,
  type FunctionUser,
  type Invocation,
  type LogFields,
  type PlatformBindings,
} from "../files/src/zavi/functions";
import {
  formEncode,
  handleStripePaid,
  stripeCheckout,
  stripeKeyMode,
  stripeSignatureHeader,
  stripeWebhook,
  verifyStripeSignature,
  type StripeEvent,
  type WebhookConfig,
} from "../files/src/zavi/functions/stripe";
import { createContext } from "../files/src/zavi/functions";

const SITE = "11111111-2222-4333-8444-555555555555";
const ORDER = "0f0e0d0c-0b0a-4908-8706-050403020100";
const PRODUCT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BUYER = "00000000-0000-4000-8000-000000000001";
const NOW_S = 1_800_000_000;
const WHSEC = "whsec_test_signing_secret_123";

type Row = FunctionRecord<Record<string, unknown>>;
const EDGES = new Set(["pending>checkout_starting", "checkout_starting>checkout_open", "checkout_starting>pending", "checkout_open>pending", "checkout_open>paid"]);

function fakeData(seed: Record<string, Row[]>) {
  const tables = new Map<string, Map<string, Row>>();
  for (const [name, rows] of Object.entries(seed)) tables.set(name, new Map(rows.map((r) => [r.id, structuredClone(r)])));
  const idem = new Map<string, string>();
  const writes: Array<{ op: string; collection: string; id: string; patch?: unknown }> = [];
  const t = (n: string) => {
    if (!tables.has(n)) tables.set(n, new Map());
    return tables.get(n)!;
  };
  const data: FunctionDataApi = {
    collection<T>(name: string) {
      const col = t(name);
      return {
        async list() {
          return { items: [...col.values()] as unknown as FunctionRecord<T>[], next_cursor: null };
        },
        async get(id: string) {
          const r = col.get(id);
          return r ? (structuredClone(r) as unknown as FunctionRecord<T>) : null;
        },
        async create(values: Partial<T>, opts?: { idempotencyKey?: string }) {
          const k = `${name}:${opts?.idempotencyKey ?? Math.random()}`;
          const prior = idem.get(k);
          if (prior) return { id: prior, replayed: true };
          const id = `${col.size + 1}`.padStart(8, "0") + "-0000-4000-8000-000000000000";
          col.set(id, { id, data: values as Record<string, unknown>, owner_id: null, created_at: "t", updated_at: "t" });
          idem.set(k, id);
          writes.push({ op: "create", collection: name, id });
          return { id, replayed: false };
        },
        async update(id: string, patch: Partial<Record<keyof T, unknown>>) {
          const r = col.get(id);
          if (!r) throw new Error("not_found");
          r.data = { ...r.data, ...(patch as Record<string, unknown>) };
          writes.push({ op: "update", collection: name, id, patch });
          return { id };
        },
        async transition(id: string, to: string, opts: { expect?: Record<string, unknown>; set?: Record<string, unknown> } = {}) {
          const r = col.get(id);
          if (!r) throw Object.assign(new Error("not_found"), { reason: "not_found" });
          const from = String(r.data.status ?? "pending");
          const conflict = () => Object.assign(new Error("transition_conflict"), { reason: "transition_conflict" });
          if (from === to || !EDGES.has(`${from}>${to}`)) throw conflict();
          for (const [k, v] of Object.entries(opts.expect ?? {})) if ((r.data[k] ?? null) !== (v ?? null)) throw conflict();
          r.data = { ...r.data, ...(opts.set ?? {}), status: to };
          writes.push({ op: "transition", collection: name, id, patch: { to, ...opts } });
          return { id, from, to, transitioned: true };
        },
        async delete(id: string) {
          col.delete(id);
        },
      };
    },
  };
  return { data, tables, writes };
}

type LogLine = { level: string; message: string; fields?: LogFields };

function platform(over: Partial<PlatformBindings> & { secretsMap?: Record<string, string>; seed?: Record<string, Row[]> } = {}) {
  const logs: LogLine[] = [];
  const stripeSessions = new Map<string, { status: string; payment_status: string; amount_total: number; currency: string | null; url: string; metadata: Record<string, string> }>();
  const stripeKeys = new Map<string, string>();
  const fetches: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const secretsMap = over.secretsMap ?? { STRIPE_SECRET_KEY: "sk_test_abc123", STRIPE_WEBHOOK_SECRET: WHSEC };
  const db = fakeData(over.seed ?? {});
  const p: PlatformBindings = {
    site_id: SITE,
    site_origin: "https://shop.example.com/",
    function_name: "fn",
    invocation_id: "inv-1",
    data: db.data,
    secrets: { get: async (n) => secretsMap[n] ?? null },
    log: {
      info: (message, fields) => logs.push({ level: "info", message, fields }),
      warn: (message, fields) => logs.push({ level: "warn", message, fields }),
      error: (message, fields) => logs.push({ level: "error", message, fields }),
    },
    fetch: async (url, init) => {
      fetches.push({ url, ...init });
      const m = /\/v1\/checkout\/sessions\/([^/]+?)(\/expire)?$/.exec(url);
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (m) {
        const sess = stripeSessions.get(m[1]);
        if (!sess) return new Response(JSON.stringify({ error: { message: "No such session" } }), { status: 404 });
        if (!m[2]) return ok({ id: m[1], ...sess });
        if (sess.status !== "open") return new Response(JSON.stringify({ error: { message: "Only open sessions can be expired" } }), { status: 400 });
        sess.status = "expired";
        return ok({ id: m[1], ...sess });
      }
      const idem = init?.headers?.["idempotency-key"];
      if (idem && stripeKeys.has(idem)) {
        const prior = stripeKeys.get(idem)!;
        return ok({ id: prior, ...stripeSessions.get(prior)! });
      }
      const form = new URLSearchParams(init?.body ?? "");
      const id = `cs_test_${stripeSessions.size + 1}`;
      if (idem) stripeKeys.set(idem, id);
      const amount = Number(form.get("line_items[0][price_data][unit_amount]")) * Number(form.get("line_items[0][quantity]"));
      const metadata: Record<string, string> = {};
      for (const [k, v] of form) {
        const mm = /^metadata\[([^\]]+)\]$/.exec(k);
        if (mm) metadata[mm[1]] = v;
      }
      const sess = { status: "open", payment_status: "unpaid", amount_total: amount, currency: form.get("line_items[0][price_data][currency]"), url: `https://checkout.stripe.com/c/pay/${id}`, metadata };
      stripeSessions.set(id, sess);
      return ok({ id, ...sess });
    },
    now: () => NOW_S * 1000,
    ...over,
  };
  return { p, logs, fetches, db, stripeSessions };
}

const post = (body: unknown, user: FunctionUser | null = null): Invocation => ({
  type: "request",
  request: new Request("https://shop.example.com/api/fn/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }),
  user,
});

async function bodyOf(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

describe("defineFunction", () => {
  it("returns the handler's value as {data}", async () => {
    const fn = defineFunction(async (input: { a: number }) => ({ doubled: input.a * 2 }));
    expect(isDefinedFunction(fn)).toBe(true);
    const { p } = platform();
    const r = await fn.invoke(post({ a: 21 }), p);
    expect(r.status).toBe(200);
    expect(await bodyOf(r)).toEqual({ data: { doubled: 42 } });
  });

  it("answers a FunctionError with its status and code, in the SDK error envelope", async () => {
    const fn = defineFunction(async () => {
      throw new FunctionError(409, "already_paid", "This order is already paid.");
    });
    const r = await fn.invoke(post({}), platform().p);
    expect(r.status).toBe(409);
    expect((await bodyOf(r)).error).toMatchObject({ code: "already_paid", message: "This order is already paid.", request_id: "inv-1" });
  });

  it("hides an unexpected error from the caller and logs it", async () => {
    const fn = defineFunction(async () => {
      throw new Error("db exploded at row 7");
    });
    const { p, logs } = platform();
    const r = await fn.invoke(post({}), p);
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("row 7");
    expect(logs.some((l) => l.level === "error" && l.message.includes("row 7"))).toBe(true);
  });

  it("refuses non-POST, bad JSON, and a schedule-style invocation", async () => {
    const fn = defineFunction(async () => 1);
    const { p } = platform();
    const get: Invocation = { type: "request", request: new Request("https://s.example.com/api/fn/x"), user: null };
    expect((await fn.invoke(get, p)).status).toBe(405);
    expect((await fn.invoke(post("{nope"), p)).status).toBe(400);
    expect((await fn.invoke({ type: "schedule", scheduled_time: "2026-10-02T00:00:00Z" }, p)).status).toBe(500);
  });

  it("masks every secret value it read in this run's log", async () => {
    const fn = defineFunction(async (_i, ctx) => {
      const key = await ctx.secrets.require("STRIPE_SECRET_KEY");
      ctx.log.info(`using ${key} now`, { key, other: "fine" });
      return "ok";
    });
    const { p, logs } = platform();
    await fn.invoke(post({}), p);
    const line = logs.find((l) => l.message.startsWith("using"))!;
    expect(line.message).toBe("using [secret] now");
    expect(line.fields).toEqual({ key: "[secret]", other: "fine" });
    expect(JSON.stringify(logs)).not.toContain("sk_test_abc123");
  });

  it("never sends a secret value back to the caller, in data or in an error", async () => {
    const leaky = defineFunction(async (_i, ctx) => ({ k: await ctx.secrets.require("STRIPE_SECRET_KEY"), ok: true }));
    const r1 = await leaky.invoke(post({}), platform().p);
    expect(await bodyOf(r1)).toEqual({ data: { k: "[secret]", ok: true } });
    const pem = "-----BEGIN KEY-----\nabc\"def\\ghi\n-----END KEY-----";
    const nested = defineFunction(async (_i, ctx) => {
      const k = await ctx.secrets.require("PEM_KEY");
      return { debug: JSON.stringify(k), twice: JSON.stringify(JSON.stringify({ k })), [k]: 1, list: [k], at: new Date(0) };
    });
    const r3 = await nested.invoke(post({}), platform({ secretsMap: { PEM_KEY: pem } }).p);
    const t3 = await r3.text();
    expect(t3).not.toContain("abc");
    expect(JSON.parse(t3).data).toMatchObject({ debug: "\"[secret]\"", "[secret]": 1, list: ["[secret]"], at: "1970-01-01T00:00:00.000Z" });
    const odd = defineFunction(async (_i, ctx) => {
      const k = await ctx.secrets.require("STRIPE_SECRET_KEY");
      let deep: unknown = { k };
      for (let i = 0; i < 100; i++) deep = { n: deep };
      return { boxed: new String(k), deep, viaToJson: { toJSON: () => ({ k }) } };
    });
    const t4 = await (await odd.invoke(post({}), platform().p)).text();
    expect(t4).not.toContain("sk_test_abc123");
    expect(JSON.parse(t4).data.boxed).toBe("[secret]");
    const cyclic = defineFunction(async () => {
      const o: Record<string, unknown> = {};
      o.self = o;
      return o;
    });
    expect((await cyclic.invoke(post({}), platform().p)).status).toBe(500);
    const quoted = defineFunction(async (_i, ctx) => {
      const k = await ctx.secrets.require("ODD_KEY");
      throw new FunctionError(400, "bad", `key was ${k}`);
    });
    const r2 = await quoted.invoke(post({}), platform({ secretsMap: { ODD_KEY: 'ab"cd\\efgh' } }).p);
    const text = await r2.text();
    expect(text).not.toContain("ab");
    expect(JSON.parse(text).error.message).toBe("key was [secret]");
  });

  it("a missing secret stops the run with a message pointing at Settings", async () => {
    const fn = defineFunction(async (_i, ctx) => ctx.secrets.require("NOPE_KEY"));
    const r = await fn.invoke(post({}), platform().p);
    expect(r.status).toBe(503);
    expect((await bodyOf(r)).error.message).toContain("Settings > Secrets");
  });

  it("refuses a body over the limit", async () => {
    const fn = defineFunction(async () => 1);
    const big = "x".repeat(1_048_577);
    expect((await fn.invoke(post(JSON.stringify(big)), platform().p)).status).toBe(413);
  });
});

describe("defineWebhook / defineSchedule", () => {
  it("a webhook without a verifier cannot be defined", () => {
    expect(() => defineWebhook({ handle: async () => 1 } as never)).toThrow(/verify/);
  });

  it("nothing reaches handle when verify throws", async () => {
    let handled = false;
    const fn = defineWebhook({
      verify: async () => {
        throw new FunctionError(401, "invalid_signature", "bad");
      },
      handle: async () => {
        handled = true;
      },
    });
    const r = await fn.invoke(post({}), platform().p);
    expect(r.status).toBe(401);
    expect(handled).toBe(false);
  });

  it("a schedule gets its scheduled time and no user", async () => {
    let seen: { t: string; user: unknown } | null = null;
    const fn = defineSchedule(async (ctx) => {
      seen = { t: ctx.scheduledTime.toISOString(), user: ctx.user };
    });
    const r = await fn.invoke({ type: "schedule", scheduled_time: "2026-10-02T03:00:00.000Z" }, platform().p);
    expect(r.status).toBe(200);
    expect(seen).toEqual({ t: "2026-10-02T03:00:00.000Z", user: null });
  });
});

describe("Stripe signatures", () => {
  it("accepts Stripe's own format and rejects tampering, staleness and a wrong secret", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "x", livemode: false, created: NOW_S, data: { object: {} } });
    const header = await stripeSignatureHeader(payload, WHSEC, NOW_S);
    await expect(verifyStripeSignature(payload, header, WHSEC, { nowSec: NOW_S })).resolves.toMatchObject({ id: "evt_1" });
    const [, good] = header.split(",");
    await expect(verifyStripeSignature(payload, `t=${NOW_S},v1=${"0".repeat(64)},${good}`, WHSEC, { nowSec: NOW_S })).resolves.toBeTruthy();
    await expect(verifyStripeSignature(payload + " ", header, WHSEC, { nowSec: NOW_S })).rejects.toMatchObject({ status: 401 });
    await expect(verifyStripeSignature(payload, header, "whsec_other", { nowSec: NOW_S })).rejects.toMatchObject({ status: 401 });
    await expect(verifyStripeSignature(payload, header, WHSEC, { nowSec: NOW_S + 301 })).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(verifyStripeSignature(payload, null, WHSEC, { nowSec: NOW_S })).rejects.toMatchObject({ status: 401 });
  });

  it("knows test keys from live ones", () => {
    expect(stripeKeyMode("sk_test_x")).toBe("test");
    expect(stripeKeyMode("rk_live_x")).toBe("live");
    expect(stripeKeyMode("pk_test_x")).toBe("unknown");
  });

  it("form-encodes nested params the way Stripe reads them", () => {
    expect(decodeURIComponent(formEncode({ a: 1, m: { k: "v" }, l: [{ q: 2, p: { c: "usd" } }], skip: undefined }))).toBe(
      "a=1&m[k]=v&l[0][q]=2&l[0][p][c]=usd",
    );
  });
});

const payments = {
  orders: "orders",
  price: { collection: "products", reference: "product_id", amount: "price_cents", name: "name" },
  quantity: "quantity",
  currency: "usd",
};

function seed(order: Partial<Row["data"]> = {}, owner: string | null = BUYER): Record<string, Row[]> {
  return {
    orders: [{ id: ORDER, owner_id: owner, created_at: "t", updated_at: "t", data: { product_id: PRODUCT, quantity: 2, status: "pending", ...order } }],
    products: [{ id: PRODUCT, owner_id: null, created_at: "t", updated_at: "t", data: { name: "Dog wash", price_cents: 2500 } }],
  };
}
const buyer = { id: BUYER, email: "b@example.com", role: null };

const moves = (db: ReturnType<typeof fakeData>) =>
  db.writes.filter((w) => w.op === "transition").map((w) => (w.patch as { to: string }).to);

describe("stripeCheckout", () => {
  it("claims the order, then talks to Stripe, then records the session (all compare-and-set)", async () => {
    const { p, fetches, db } = platform({ seed: seed() });
    const r = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), p);
    expect(r.status).toBe(200);
    expect((await bodyOf(r)).data).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1", sessionId: "cs_test_1" });
    expect(db.tables.get("orders")!.get(ORDER)!.data).toMatchObject({ status: "checkout_open", amount_cents: 5000, checkout_session_id: "cs_test_1" });
    const [claimMove, recordMove] = db.writes.filter((w) => w.op === "transition").map((w) => w.patch as { to: string; expect: Record<string, unknown>; set: Record<string, unknown> });
    expect(claimMove.to).toBe("checkout_starting");
    expect(claimMove.expect).toEqual({ product_id: PRODUCT, quantity: 2 });
    expect(claimMove.set).toMatchObject({ amount_cents: 5000, checkout_started_at: new Date(NOW_S * 1000).toISOString() });
    const claim = claimMove.set.checkout_session_id as string;
    expect(claim).toMatch(/^claim_[0-9a-f]{32}$/);
    expect(recordMove).toEqual({ to: "checkout_open", expect: { checkout_session_id: claim }, set: { checkout_session_id: "cs_test_1" } });
    expect(db.writes.filter((w) => w.op === "update")).toHaveLength(0);
    const f = fetches[0];
    expect(f.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(f.headers?.authorization).toBe("Bearer sk_test_abc123");
    expect(f.headers?.["idempotency-key"]).toBe(`zavi-checkout-${ORDER}-${claim}`);
    const form = new URLSearchParams(f.body);
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("2500");
    expect(form.get("line_items[0][quantity]")).toBe("2");
    expect(form.get("client_reference_id")).toBe(ORDER);
    expect(form.get("metadata[zavi_site]")).toBe(SITE);
    expect(form.get("metadata[zavi_snapshot]")).toBe(JSON.stringify([PRODUCT, 2]));
    expect(form.get("success_url")).toBe(`https://shop.example.com/checkout/success?order=${ORDER}`);
  });

  it("one payable session per order: a second checkout reuses the open session", async () => {
    const a = platform({ seed: seed() });
    const first = await bodyOf(await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p));
    const again = await bodyOf(await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p));
    expect(again.data).toEqual(first.data);
    expect(a.stripeSessions.size).toBe(1);
  });

  it("while another request holds a fresh claim, a checkout is refused without calling Stripe", async () => {
    const a = platform({ seed: seed({ status: "checkout_starting", checkout_session_id: "claim_" + "a".repeat(32), checkout_started_at: new Date(NOW_S * 1000 - 5_000).toISOString() }) });
    const r = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    expect(r.status).toBe(409);
    expect(a.fetches).toHaveLength(0);
  });

  it("a stale claim (crashed checkout) is reclaimed", async () => {
    const a = platform({ seed: seed({ status: "checkout_starting", checkout_session_id: "claim_" + "a".repeat(32), checkout_started_at: new Date(NOW_S * 1000 - 600_000).toISOString() }) });
    const r = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    expect(r.status).toBe(200);
    expect(moves(a.db)).toEqual(["pending", "checkout_starting", "checkout_open"]);
  });

  it("if the claim is lost while talking to Stripe, its session is expired and nothing is handed out", async () => {
    const a = platform({ seed: seed() });
    const realFetch = a.p.fetch;
    a.p.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      if (url.endsWith("/v1/checkout/sessions")) a.db.tables.get("orders")!.get(ORDER)!.data.checkout_session_id = "claim_" + "b".repeat(32);
      return res;
    };
    const r = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    expect(r.status).toBe(409);
    expect(a.stripeSessions.get("cs_test_1")!.status).toBe("expired");
  });

  it("a Stripe failure releases the claim", async () => {
    const a = platform({ seed: seed() });
    a.p.fetch = async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    const r = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    expect(r.status).toBe(502);
    expect(a.db.tables.get("orders")!.get(ORDER)!.data.status).toBe("pending");
  });

  it("an item or quantity changed between pricing and the claim loses the claim", async () => {
    const a = platform({ seed: seed() });
    const realColl = a.p.data.collection.bind(a.p.data);
    a.p.data = {
      collection: (n: string) => {
        const col = realColl(n);
        if (n !== "products") return col;
        return { ...col, get: async (id: string) => { a.db.tables.get("orders")!.get(ORDER)!.data.quantity = 9; return col.get(id); } };
      },
    } as PlatformBindings["data"];
    expect((await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p)).status).toBe(409);
    expect(a.fetches).toHaveLength(0);
  });

  it("refuses a new checkout once the current session is complete; says when payment is still processing", async () => {
    const a = platform({ seed: seed() });
    await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    Object.assign(a.stripeSessions.get("cs_test_1")!, { status: "complete", payment_status: "unpaid" });
    const r = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    expect([r.status, (await bodyOf(r)).error.code]).toEqual([409, "payment_processing"]);
    a.stripeSessions.get("cs_test_1")!.payment_status = "paid";
    const r2 = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    expect([r2.status, (await bodyOf(r2)).error.code]).toEqual([409, "already_paid"]);
    expect(a.stripeSessions.size).toBe(1);
  });

  it("a price change expires the open session, returns the order to pending, then opens a new one", async () => {
    const a = platform({ seed: seed() });
    await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    a.db.tables.get("products")!.get(PRODUCT)!.data.price_cents = 3000;
    const r = await bodyOf(await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p));
    expect(r.data.sessionId).toBe("cs_test_2");
    expect(a.stripeSessions.get("cs_test_1")!.status).toBe("expired");
    expect(a.db.tables.get("orders")!.get(ORDER)!.data).toMatchObject({ status: "checkout_open", amount_cents: 6000, checkout_session_id: "cs_test_2" });
    expect(moves(a.db)).toEqual(["checkout_starting", "checkout_open", "pending", "checkout_starting", "checkout_open"]);
  });

  it("an expired session is replaced with a NEW one (never the old one replayed by Stripe)", async () => {
    const a = platform({ seed: seed() });
    await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    a.stripeSessions.get("cs_test_1")!.status = "expired";
    const r = await bodyOf(await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p));
    expect(r.data.sessionId).toBe("cs_test_2");
    expect(a.stripeSessions.get("cs_test_2")!.status).toBe("open");
  });

  it("ignores any price the page sends", async () => {
    const { p, fetches } = platform({ seed: seed() });
    await stripeCheckout(payments).invoke(post({ orderId: ORDER, price_cents: 1, amount: 1 }, buyer), p);
    expect(new URLSearchParams(fetches[0].body).get("line_items[0][price_data][unit_amount]")).toBe("2500");
  });

  it("refuses someone else's order, a paid order and a bad id", async () => {
    const other = { id: "00000000-0000-4000-8000-000000000009", email: null, role: null };
    expect((await stripeCheckout(payments).invoke(post({ orderId: ORDER }, other), platform({ seed: seed() }).p)).status).toBe(403);
    expect((await stripeCheckout(payments).invoke(post({ orderId: ORDER }, null), platform({ seed: seed() }).p)).status).toBe(403);
    expect((await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), platform({ seed: seed({ status: "paid" }) }).p)).status).toBe(409);
    expect((await stripeCheckout(payments).invoke(post({ orderId: "nope" }, buyer), platform({ seed: seed() }).p)).status).toBe(400);
  });

  it("an order placed signed out is payable by whoever holds its id", async () => {
    const r = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, null), platform({ seed: seed({}, null) }).p);
    expect(r.status).toBe(200);
  });

  it("key mode must match the site's mode, checked before calling Stripe; the claim is released", async () => {
    const live = platform({ seed: seed(), secretsMap: { STRIPE_SECRET_KEY: ["sk", "live", "realmoney"].join("_") } });
    const r = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), live.p);
    expect(r.status).toBe(503);
    expect((await bodyOf(r)).error.code).toBe("payments_test_mode");
    expect(live.fetches).toHaveLength(0);
    expect(live.db.tables.get("orders")!.get(ORDER)!.data.status).toBe("pending");
    const testInLive = platform({ seed: seed() });
    const r2 = await stripeCheckout({ ...payments, live: true }).invoke(post({ orderId: ORDER }, buyer), testInLive.p);
    expect((await bodyOf(r2)).error.code).toBe("payments_live_mode");
    expect(testInLive.fetches).toHaveLength(0);
  });

  it("refuses bad recipe config at definition", () => {
    expect(() => stripeCheckout({ ...payments, currency: "dollars" })).toThrow();
    expect(() => stripeCheckout({ ...payments, successPath: "https://evil.example" })).toThrow();
    expect(() => stripeCheckout({ ...payments, openValue: "paid" })).toThrow();
    expect(() => stripeCheckout({ ...payments, amountField: "quantity" })).toThrow();
    expect(() => stripeCheckout({ ...payments, sessionField: "amount_cents" })).toThrow();
  });
});

const SNAP = JSON.stringify([PRODUCT, 2]);

function paidEvent(over: Partial<Record<string, unknown>> = {}, id = "evt_paid_1", livemode = false, type = "checkout.session.completed"): StripeEvent {
  return {
    id,
    type,
    livemode,
    created: NOW_S,
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        payment_status: "paid",
        client_reference_id: ORDER,
        metadata: { order_id: ORDER, zavi_site: SITE, zavi_snapshot: SNAP },
        amount_total: 5000,
        currency: "usd",
        ...over,
      },
    },
  };
}

async function deliver(event: StripeEvent, p: PlatformBindings, cfg: WebhookConfig = payments) {
  const payload = JSON.stringify(event);
  const header = await stripeSignatureHeader(payload, WHSEC, NOW_S);
  const req = new Request("https://shop.example.com/api/hooks/stripe-webhook", { method: "POST", body: payload, headers: { "stripe-signature": header } });
  const r = await stripeWebhook(cfg).invoke({ type: "request", request: req, user: null }, p);
  return { status: r.status, body: await bodyOf(r) };
}

const checkedOut = (extra: Partial<Row["data"]> = {}) => seed({ status: "checkout_open", amount_cents: 5000, checkout_session_id: "cs_test_1", ...extra });

describe("stripeWebhook (fake Stripe events)", () => {
  it("marks paid with one compare-and-set on the session and total, and finishes the event", async () => {
    const { p, db } = platform({ seed: checkedOut() });
    const r = await deliver(paidEvent(), p);
    expect(r).toEqual({ status: 200, body: { received: true, outcome: "marked_paid" } });
    expect(db.tables.get("orders")!.get(ORDER)!.data.status).toBe("paid");
    const move = db.writes.find((w) => w.op === "transition")!;
    expect(move.patch).toEqual({ to: "paid", expect: { product_id: PRODUCT, quantity: 2, checkout_session_id: "cs_test_1", amount_cents: 5000 } });
    const ledger = [...db.tables.get("payment_events")!.values()];
    expect(ledger).toHaveLength(1);
    expect(ledger[0].data).toMatchObject({ event_id: "evt_paid_1", state: "done", outcome: "marked_paid" });
  });

  it("a failed delayed payment puts the order back to pending for another try", async () => {
    const { p, db } = platform({ seed: checkedOut() });
    const r = await deliver(paidEvent({ payment_status: "unpaid" }, "evt_fail_1", false, "checkout.session.async_payment_failed"), p);
    expect(r.body.outcome).toBe("payment_failed");
    expect(db.tables.get("orders")!.get(ORDER)!.data.status).toBe("pending");
  });

  it("is idempotent on the event id: a retry, and an old event resent after the order was reset, do nothing", async () => {
    const { p, db } = platform({ seed: checkedOut() });
    expect((await deliver(paidEvent(), p)).body.outcome).toBe("marked_paid");
    expect((await deliver(paidEvent(), p)).body.outcome).toBe("duplicate_event");
    db.tables.get("orders")!.get(ORDER)!.data.status = "checkout_open";
    expect((await deliver(paidEvent(), p)).body.outcome).toBe("duplicate_event");
    expect(db.tables.get("orders")!.get(ORDER)!.data.status).toBe("checkout_open");
    expect(db.tables.get("payment_events")!.size).toBe(1);
  });

  it("a claimed but unfinished event (crash) is finished on the retry", async () => {
    const { p, db } = platform({ seed: checkedOut() });
    const orders = db.tables.get("orders")!;
    const crashing = { ...p, data: { collection: (n: string) => (n === "orders" ? { ...p.data.collection(n), transition: async () => { throw new Error("db down"); } } : p.data.collection(n)) } } as PlatformBindings;
    expect((await deliver(paidEvent(), crashing)).status).toBe(500);
    expect(orders.get(ORDER)!.data.status).toBe("checkout_open");
    expect((await deliver(paidEvent(), p)).body.outcome).toBe("marked_paid");
    expect(orders.get(ORDER)!.data.status).toBe("paid");
  });

  it("rejects an unsigned or forged delivery before touching data", async () => {
    const { p, db } = platform({ seed: checkedOut() });
    const req = new Request("https://shop.example.com/api/hooks/stripe-webhook", { method: "POST", body: JSON.stringify(paidEvent()), headers: { "stripe-signature": `t=${NOW_S},v1=${"a".repeat(64)}` } });
    const r = await stripeWebhook(payments).invoke({ type: "request", request: req, user: null }, p);
    expect(r.status).toBe(401);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a signed event whose livemode is not a boolean", async () => {
    const { p, db } = platform({ seed: checkedOut() });
    const ev = { ...paidEvent(), livemode: "false" } as unknown as StripeEvent;
    expect((await deliver(ev, p)).status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });

  it("names the reason when it cannot mark paid: amount, stale session, paid twice", async () => {
    const a = platform({ seed: checkedOut() });
    expect((await deliver(paidEvent({ amount_total: 100 }), a.p)).body.outcome).toBe("amount_mismatch");
    expect(a.db.tables.get("orders")!.get(ORDER)!.data.status).toBe("checkout_open");
    const c = platform({ seed: checkedOut({ checkout_session_id: "cs_test_other" }) });
    expect((await deliver(paidEvent(), c.p)).body.outcome).toBe("session_mismatch");
    expect(c.logs.some((l) => l.level === "error" && l.message.includes("Refund"))).toBe(true);
    const d = platform({ seed: checkedOut({ status: "paid", checkout_session_id: "cs_test_other" }) });
    expect((await deliver(paidEvent(), d.p)).body.outcome).toBe("paid_twice");
    expect(d.logs.some((l) => l.level === "error" && l.message.includes("paid twice"))).toBe(true);
    const e = platform({ seed: checkedOut({ status: "paid" }) });
    expect((await deliver(paidEvent(), e.p)).body.outcome).toBe("already_paid");
  });

  it("a data outage is a 5xx (Stripe retries), never a permanent answer", async () => {
    const { p } = platform({ seed: checkedOut() });
    const flaky = { ...p, data: { collection: (n: string) => (n === "orders" ? { ...p.data.collection(n), transition: async () => { throw new Error("timeout"); } } : p.data.collection(n)) } } as PlatformBindings;
    expect((await deliver(paidEvent(), flaky)).status).toBe(500);
  });

  it("ignores events of the other mode, other sites' or untagged sessions, mismatched ids, unpaid sessions and other types", async () => {
    const { p, db } = platform({ seed: checkedOut() });
    expect((await deliver(paidEvent({}, "evt_live", true), p)).body.outcome).toBe("wrong_mode");
    expect((await deliver(paidEvent(), p, { ...payments, live: true })).body.outcome).toBe("wrong_mode");
    expect((await deliver(paidEvent({ metadata: { order_id: ORDER, zavi_site: "another" } }), p)).body.outcome).toBe("other_site");
    expect((await deliver(paidEvent({ metadata: { order_id: ORDER } }), p)).body.outcome).toBe("other_site");
    expect((await deliver(paidEvent({ metadata: { order_id: PRODUCT, zavi_site: SITE } }), p)).body.outcome).toBe("no_order");
    expect((await deliver(paidEvent({ payment_status: "unpaid" }), p)).body.outcome).toBe("not_paid_yet");
    expect((await deliver({ ...paidEvent(), type: "charge.refunded" }, p)).body.outcome).toBe("ignored_type");
    expect(db.writes).toHaveLength(0);
  });

  it("an order whose item or quantity changed after checkout is not marked paid", async () => {
    const { p, db, logs } = platform({ seed: checkedOut({ quantity: 50 }) });
    expect((await deliver(paidEvent(), p)).body.outcome).toBe("order_changed");
    expect(db.tables.get("orders")!.get(ORDER)!.data.status).toBe("checkout_open");
    expect(logs.some((l) => l.level === "error" && l.message.includes("changed after checkout"))).toBe(true);
    const m = platform({ seed: checkedOut() });
    expect((await deliver(paidEvent({ metadata: { order_id: ORDER, zavi_site: SITE } }), m.p)).body.outcome).toBe("order_changed");
    expect(m.db.tables.get("orders")!.get(ORDER)!.data.status).toBe("checkout_open");
  });

  it("an expired session reopens the order; a stale one leaves it alone", async () => {
    const { p, db } = platform({ seed: checkedOut() });
    expect((await deliver(paidEvent({ payment_status: "unpaid" }, "evt_exp_1", false, "checkout.session.expired"), p)).body.outcome).toBe("expired");
    expect(db.tables.get("orders")!.get(ORDER)!.data.status).toBe("pending");
    const o = platform({ seed: checkedOut({ checkout_session_id: "cs_test_9" }) });
    expect((await deliver(paidEvent({ payment_status: "unpaid" }, "evt_exp_2", false, "checkout.session.expired"), o.p)).body.outcome).toBe("session_mismatch");
    expect(o.db.tables.get("orders")!.get(ORDER)!.data.status).toBe("checkout_open");
  });

  it("a failed payment retried after the order moved but the ledger write failed keeps its outcome", async () => {
    const { p, db } = platform({ seed: checkedOut() });
    let fail = true;
    const flaky = { ...p, data: { collection: (n: string) => (n === "payment_events" ? { ...p.data.collection(n), update: async (id: string, patch: Record<string, unknown>) => { if (fail) { fail = false; throw new Error("db down"); } return p.data.collection(n).update(id, patch); } } : p.data.collection(n)) } } as PlatformBindings;
    const ev = paidEvent({ payment_status: "unpaid" }, "evt_fail_9", false, "checkout.session.async_payment_failed");
    expect((await deliver(ev, flaky)).status).toBe(500);
    expect(db.tables.get("orders")!.get(ORDER)!.data.status).toBe("pending");
    expect((await deliver(ev, flaky)).body.outcome).toBe("payment_failed");
  });

  it("a reopened checkout does not reuse an open session priced for a different quantity", async () => {
    const a = platform({ seed: seed() });
    await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    const order = a.db.tables.get("orders")!.get(ORDER)!;
    a.stripeSessions.get("cs_test_1")!.metadata.zavi_snapshot = JSON.stringify([PRODUCT, 1]);
    const r = await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    expect((await bodyOf(r)).data.sessionId).toBe("cs_test_2");
    expect(a.stripeSessions.get("cs_test_1")!.status).toBe("expired");
    expect(order.data.checkout_session_id).toBe("cs_test_2");
  });

  it("checkout then webhook end to end", async () => {
    const a = platform({ seed: seed() });
    await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p);
    expect((await deliver(paidEvent(), a.p)).body.outcome).toBe("marked_paid");
    expect(a.db.tables.get("orders")!.get(ORDER)!.data.status).toBe("paid");
    expect((await stripeCheckout(payments).invoke(post({ orderId: ORDER }, buyer), a.p)).status).toBe(409);
  });
});
