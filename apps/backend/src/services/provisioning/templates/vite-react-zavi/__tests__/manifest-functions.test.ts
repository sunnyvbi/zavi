import { describe, expect, it } from "vitest";
import {
  cronIssue,
  declaredFunctions,
  functionFileIssues,
  principalMatch,
  validateManifest,
  type Manifest,
} from "../manifest";

const orders = (extra: Record<string, unknown> = {}) => ({
  rules: { create: ["signed_in"], get: ["owner", "admin", "fn:create-checkout", "fn:stripe-webhook"], list: ["owner", "admin"], update: ["fn:create-checkout", "fn:stripe-webhook"] },
  schema: {
    type: "object",
    required: ["product_id"],
    properties: {
      product_id: { type: "string", maxLength: 36, format: "uuid" },
      amount_cents: { type: "integer", minimum: 0 },
      status: { type: "string", maxLength: 20, enum: ["pending", "paid"] },
    },
  },
  fields: { amount_cents: { write: ["fn:create-checkout"] }, status: { write: ["fn:stripe-webhook"] } },
  ...extra,
});

const fnBlock = () => ({
  endpoints: {
    "stripe-webhook": { type: "webhook" },
    "create-checkout": { type: "http", principals: ["signed_in", "anyone"] },
  },
  schedules: { "nightly-report": { cron: "0  3 * * *" } },
  secrets: ["STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY"],
  allowedHosts: ["api.stripe.com"],
});

const issues = (doc: unknown) => {
  const r = validateManifest(doc);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
};

describe("functions block", () => {
  it("validates and canonicalizes (sorted names, principals, secrets; cron whitespace)", () => {
    const r = validateManifest({ schemaVersion: 1, collections: { orders: orders() }, functions: fnBlock() });
    expect(r.ok).toBe(true);
    const m = (r as { value: Manifest }).value;
    expect(Object.keys(m.functions!.endpoints)).toEqual(["create-checkout", "stripe-webhook"]);
    expect(m.functions!.endpoints["create-checkout"]).toEqual({ type: "http", principals: ["anyone", "signed_in"] });
    expect(m.functions!.schedules["nightly-report"]).toEqual({ cron: "0 3 * * *" });
    expect(m.functions!.secrets).toEqual(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
    expect(declaredFunctions(m.functions).map((d) => `${d.name}:${d.kind}`)).toEqual(["create-checkout:http", "nightly-report:schedule", "stripe-webhook:webhook"]);
  });

  it("a manifest without functions keeps its hash (no functions key in the canonical form)", () => {
    const doc = { schemaVersion: 1, collections: { m: { rules: { create: ["anyone"] }, schema: { type: "object", properties: { a: { type: "string", maxLength: 5 } } } } } };
    const r = validateManifest(doc) as { ok: true; value: Manifest; hash: string };
    expect(r.ok).toBe(true);
    expect("functions" in r.value).toBe(false);
  });

  it("fn:<name> must name a declared function; undeclared is refused", () => {
    expect(issues({ schemaVersion: 1, collections: { orders: orders() } })).toContain("collections.orders.rules.get[2]:undeclared_function");
    const ok = validateManifest({ schemaVersion: 1, collections: { orders: orders() }, functions: fnBlock() });
    expect(ok.ok).toBe(true);
  });

  it("fn principals cannot run aggregates", () => {
    const doc = {
      schemaVersion: 2,
      collections: { orders: orders() },
      aggregates: { total: { collection: "orders", fn: "count", principals: ["fn:create-checkout"] } },
      functions: fnBlock(),
    };
    expect(issues(doc).some((i) => i.includes("principal_not_allowed"))).toBe(true);
  });

  it("refuses bad shapes with a precise code", () => {
    const bad = (f: unknown) => issues({ schemaVersion: 1, collections: {}, functions: f });
    expect(bad({ endpoints: { "Bad_Name": { type: "http", principals: ["anyone"] } } })).toContain("functions.endpoints.Bad_Name:invalid_function_name");
    expect(bad({ endpoints: { hook: { type: "webhook", principals: ["anyone"] } } })).toContain("functions.endpoints.hook.principals:principals_not_allowed");
    expect(bad({ endpoints: { a: { type: "http" } } })).toContain("functions.endpoints.a.principals:invalid_principals");
    expect(bad({ endpoints: { a: { type: "http", principals: ["owner"] } } })).toContain("functions.endpoints.a.principals[0]:unknown_principal");
    expect(bad({ endpoints: { a: { type: "http", principals: ["role:staff"] } } })).toContain("functions.endpoints.a.principals[0]:undeclared_role");
    expect(bad({ endpoints: { a: { type: "cron" } } })).toContain("functions.endpoints.a.type:invalid_endpoint_type");
    expect(bad({ endpoints: { a: { type: "webhook" } }, schedules: { a: { cron: "0 * * * *" } } })).toContain("functions.schedules.a:duplicate_function");
    expect(bad({ endpoints: { a: { type: "webhook" } }, secrets: ["sk_test_123"] })).toContain("functions.secrets[0]:invalid_secret_name");
    expect(bad({ endpoints: { a: { type: "webhook" } }, secrets: ["ZAVI_TOKEN"] })).toContain("functions.secrets[0]:reserved_secret_name");
    expect(bad({ endpoints: { a: { type: "webhook" } }, allowedHosts: ["https://api.stripe.com"] })).toContain("functions.allowedHosts[0]:invalid_host");
    expect(bad({ endpoints: { a: { type: "webhook" } }, allowedHosts: ["10.0.0.1"] })).toContain("functions.allowedHosts[0]:invalid_host");
    expect(bad({ endpoints: { a: { type: "webhook" } }, allowedHosts: ["api.zaviagent.com"] })).toContain("functions.allowedHosts[0]:host_not_allowed");
    expect(bad({ endpoints: { a: { type: "webhook" } }, allowedHosts: ["metadata.google.internal"] })).toContain("functions.allowedHosts[0]:host_not_allowed");
    expect(bad({ endpoints: { a: { type: "webhook" } }, allowedHosts: ["printer.local"] })).toContain("functions.allowedHosts[0]:host_not_allowed");
    expect(bad({ endpoints: { a: { type: "webhook", asAdmin: "yes" } } })).toContain("functions.endpoints.a.asAdmin:invalid_as_admin");
    expect(bad({})).toContain("functions:no_functions");
    expect(bad([])).toContain("functions:invalid_functions");
    expect(bad({ endpoints: { a: { type: "webhook" } }, extra: 1 })).toContain("functions.extra:unknown_key");
  });

  it("cron: 5 fields, valid ranges, at most every 5 minutes", () => {
    expect(cronIssue("0 3 * * *")).toBeNull();
    expect(cronIssue("*/5 * * * *")).toBeNull();
    expect(cronIssue("0,30 9-17 * * 1-5")).toBeNull();
    expect(cronIssue("* * * * *")).toMatch(/every 5 minutes/);
    expect(cronIssue("*/2 * * * *")).toMatch(/every 5 minutes/);
    expect(cronIssue("0,58 * * * *")).toMatch(/every 5 minutes/);
    expect(cronIssue("0,59 0-22 * * *")).toMatch(/every 5 minutes/);
    expect(cronIssue("58 23 * * *")).toBeNull();
    expect(cronIssue("0,58 23 * * *")).toBeNull();
    expect(cronIssue("0 3 * *")).toMatch(/5 fields/);
    expect(cronIssue("61 3 * * *")).toMatch(/minute/);
    expect(cronIssue("0 3 * * 7")).toMatch(/day of week/);
    expect(cronIssue(5)).toMatch(/5-field/);
  });
});

describe("function files", () => {
  const m = (validateManifest({ schemaVersion: 1, collections: { orders: orders() }, functions: fnBlock() }) as { value: Manifest }).value;
  it("every declared function needs functions/<name>.ts, and every functions/*.ts must be declared", () => {
    const got = functionFileIssues(m.functions, ["functions/create-checkout.ts", "./functions/stripe-webhook.ts", "functions/stray.ts", "functions/lib/payments.ts", "src/App.tsx"]);
    expect(got.map((i) => `${i.path}:${i.code}`).sort()).toEqual(["functions/nightly-report.ts:function_file_missing", "functions/stray.ts:function_not_declared"]);
  });
  it("a site without functions may not ship function files", () => {
    expect(functionFileIssues(undefined, ["functions/x.ts"]).map((i) => i.code)).toEqual(["function_not_declared"]);
  });
});

describe("principalMatch for a function caller", () => {
  it("matches only its own fn:<name>, never members' principals, and admin only with asAdmin", () => {
    const me = { fn: "stripe-webhook", asAdmin: false };
    expect(principalMatch(["fn:stripe-webhook"], null, null, null, me)).toBe(true);
    expect(principalMatch(["fn:create-checkout"], null, null, null, me)).toBe(false);
    expect(principalMatch(["admin", "signed_in", "owner"], null, null, null, me)).toBe(false);
    expect(principalMatch(["anyone"], null, null, null, me)).toBe(false);
    expect(principalMatch(["admin"], null, null, null, { fn: "x", asAdmin: true })).toBe(true);
    expect(principalMatch(["fn:stripe-webhook"], { userId: "u", role: "admin" }, "u")).toBe(false);
  });
});

describe("the Stripe recipe's manifest (FUNCTIONS.md) validates", () => {
  it("orders state machine with fn: transitions, products, payment_events ledger", () => {
    const doc = {
      schemaVersion: 2,
      collections: {
        products: {
          rules: { list: ["anyone"], get: ["anyone", "fn:create-checkout"], create: ["admin"], update: ["admin"], delete: ["admin"] },
          schema: { type: "object", required: ["name", "price_cents"], properties: { name: { type: "string", maxLength: 120 }, price_cents: { type: "integer", minimum: 1 } } },
        },
        orders: {
          rules: { create: ["signed_in"], get: ["owner", "admin", "fn:create-checkout", "fn:stripe-webhook"], list: ["owner", "admin"], update: ["fn:create-checkout"], delete: ["admin"] },
          schema: {
            type: "object",
            required: ["product_id", "status"],
            properties: {
              product_id: { type: "string", maxLength: 36, format: "uuid" },
              quantity: { type: "integer", minimum: 1, maximum: 100 },
              amount_cents: { type: "integer", minimum: 0 },
              checkout_session_id: { type: "string", maxLength: 255 },
              checkout_started_at: { type: "string", maxLength: 40, format: "date-time" },
              status: { type: "string", maxLength: 20, enum: ["pending", "checkout_starting", "checkout_open", "paid"] },
            },
          },
          fields: { amount_cents: { write: ["fn:create-checkout"] }, checkout_session_id: { write: ["fn:create-checkout"] }, checkout_started_at: { write: ["fn:create-checkout"] } },
          states: {
            field: "status", values: ["pending", "checkout_starting", "checkout_open", "paid"], initial: "pending",
            transitions: [
              { from: "pending", to: "checkout_starting", principals: ["fn:create-checkout"] },
              { from: "checkout_starting", to: "checkout_open", principals: ["fn:create-checkout"] },
              { from: "checkout_starting", to: "pending", principals: ["fn:create-checkout"] },
              { from: "checkout_open", to: "pending", principals: ["fn:create-checkout", "fn:stripe-webhook"] },
              { from: "checkout_open", to: "paid", principals: ["fn:stripe-webhook"] },
            ],
          },
        },
        payment_events: {
          rules: { create: ["fn:stripe-webhook"], get: ["fn:stripe-webhook", "admin"], list: ["admin"], update: ["fn:stripe-webhook"] },
          schema: {
            type: "object",
            required: ["event_id"],
            properties: {
              event_id: { type: "string", maxLength: 255 },
              type: { type: "string", maxLength: 100 },
              order_id: { type: "string", maxLength: 36, format: "uuid" },
              state: { type: "string", maxLength: 10, enum: ["claimed", "done"] },
              outcome: { type: "string", maxLength: 40 },
            },
          },
        },
      },
      functions: {
        endpoints: { "create-checkout": { type: "http", principals: ["signed_in"] }, "stripe-webhook": { type: "webhook" } },
        secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
        allowedHosts: ["api.stripe.com"],
      },
    };
    expect(issues(doc)).toEqual([]);
  });
});
