
import { describe, it, expect, vi, beforeEach } from "vitest";
import { effectivePolicy } from "@zavi/shared/db-guard";
import { fakeSession } from "@/services/data-gateway/__tests__/fake-session";
import type { ReadSession } from "@/services/data-gateway/session";
import type { DbAccess } from "@/services/data-gateway/resolve";

const h = vi.hoisted(() => ({
  access: null as unknown,
  session: null as unknown,
  reserve: vi.fn(async () => "log-1"),
}));

vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: h.reserve,
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));
vi.mock("@/services/data-gateway/resolve", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  loadDbAccess: async () => h.access,
}));
vi.mock("@/services/data-gateway/direct/mongo", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openMongoSession: async () => h.session,
}));
vi.mock("@/services/data-gateway/direct/sql", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openSqlSession: async () => h.session,
}));
vi.mock("@/services/data-gateway/direct/dynamo", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  openDynamoSession: async () => h.session,
}));

import { queryUserTool, queryListingTool, queryRecentTransactionsTool } from "../tools";
import { redactingDriver, redactRecords } from "../redact-result";
import { redactComputed, redactValue } from "../discovery/redact";
import type { OperatorDbDriver } from "../types";

const CREATED = new Date("2026-10-01T12:00:00.000Z");

function userDoc(dialect?: string): Record<string, unknown> {
  return {
    _id: "64f1a2b3c4d5e6f7a8b9c0d1",
    status: "active",
    role: "guest",
    city: "Austin",
    createdAt: dialect === "dynamodb" ? CREATED.toISOString() : CREATED,
    totalAmount: 1234.5,
    tripCount: 7,
    isDriverVerified: true,
    dlStatus: "verified",
    licensePlate: "8ABC123",
    password: "$2b$10$abcdefghijklmnopqrstuv",
    passwordHash: "$2b$10$zyxwvutsrqponmlkjihgfe",
    hash: "5f4dcc3b5aa765d61d8327deb882cf99",
    salt: "a1b2c3",
    tokens: ["tok-1", "tok-2"],
    jwt: "opaque-session-value",
    sessions: [{ token: "sess-abc", device: "ios" }],
    notifTokens: ["fcm-xyz"],
    phone: "+1 (415) 555-0100",
    phoneNumber: "4155550100",
    email: "rider@example.com",
    dlNumber: "D1234567",
    licenseNumber: "D7654321",
    drivingLicense: { number: "D1112223", state: "CA" },
    address: { street: "1 Main St", zip: "94105" },
    profile: { contact: { email: "x@y.com" }, bio: "call me at 415-555-0199" },
    registrationIp: "10.1.2.3",
    isMobileVerified: true,
    hostLocations: [{ city: "Austin", coordinates: [-97.7431, 30.2672] }],
  };
}

const MASKED = [
  "password",
  "passwordHash",
  "hash",
  "salt",
  "tokens",
  "jwt",
  "notifTokens",
  "phone",
  "phoneNumber",
  "email",
  "dlNumber",
  "licenseNumber",
  "drivingLicense",
  "address",
  "registrationIp",
];

const isMasked = (v: unknown) =>
  v === undefined || (typeof v === "string" && v.startsWith("‹redacted")) ||
  (Array.isArray(v) && v.every((e) => typeof e === "string" && e.startsWith("‹redacted")));

function expectRedactedUser(rec: Record<string, unknown>) {
  for (const k of MASKED) expect(isMasked(rec[k]), `${k} must be masked, got ${JSON.stringify(rec[k])}`).toBe(true);
  expect(isMasked(rec.sessions)).toBe(true);
  const profile = rec.profile as Record<string, unknown>;
  expect(profile.contact).toBe("‹redacted›");
  expect(profile.bio).toBe("call me at ‹redacted:phone›");
  expect(rec).toMatchObject({
    _id: "64f1a2b3c4d5e6f7a8b9c0d1",
    status: "active",
    role: "guest",
    city: "Austin",
    totalAmount: 1234.5,
    tripCount: 7,
    isDriverVerified: true,
    dlStatus: "verified",
    licensePlate: "8ABC123",
  });
  expect(rec.hostLocations).toEqual([{ city: "Austin", coordinates: "‹redacted›" }]);
  expect([CREATED.getTime(), CREATED.toISOString()]).toContainEqual(
    rec.createdAt instanceof Date ? rec.createdAt.getTime() : rec.createdAt,
  );
  const text = JSON.stringify(rec);
  for (const raw of ["$2b$", "5f4dcc3b", "a1b2c3", "tok-1", "opaque-session", "sess-abc", "fcm-xyz", "555", "4155550100", "rider@", "D1234567", "D7654321", "D1112223", "1 Main", "x@y.com", "10.1.2.3", "30.2672"]) {
    expect(text, `raw value ${raw} leaked`).not.toContain(raw);
  }
}

const CATALOG = {
  tables: ["users", "listings", "transactions"].map((name) => ({
    name,
    columns: Object.keys(userDoc()).map((c) => ({ name: c, type: "text", nullable: true })),
  })),
};

function setup(dialect: DbAccess["dialect"]) {
  const policy = effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, CATALOG, dialect);
  h.access = {
    tenant_id: "t1",
    mode: "direct",
    dialect,
    config: {
      type: dialect,
      connection_secret_key: "k",
      schema_map: {
        users: { table: "users", id_field: "id" },
        listings: { table: "listings", id_field: "id" },
        transactions: { table: "transactions", id_field: "id" },
      },
    },
    catalog: { dialect, catalog: CATALOG, hints: {}, catalog_hash: "h", coverage: null, discovery_error: null, updated_at: null },
    policy,
    connectionString: "x://y/app",
    database: "app",
    generation: 0,
  } as unknown as DbAccess;
  const fake = fakeSession({ dialect, rows: [userDoc()], docs: [userDoc()] });
  if (dialect === "dynamodb") {
    const session: ReadSession = { ...fake.session, dynamo: () => ({ query: async () => [userDoc(dialect)], scan: async () => [userDoc(dialect)] }) };
    h.session = session;
  } else {
    h.session = fake.session;
  }
  return fake;
}

const ctx = (tool: string) =>
  ({
    tenant_id: "t1",
    log: () => undefined,
    gateway: { tenant_id: "t1", caller: { kind: "agent", agent_slug: "cgo", run_id: null, tool_name: tool } },
  }) as never;

beforeEach(() => {
  h.reserve.mockClear();
});

describe.each(["mongodb", "postgres", "mysql", "dynamodb"] as const)("operator_db named reads on %s", (dialect) => {
  it("query_user masks credentials and PII, keeps ids, timestamps, statuses and amounts", async () => {
    setup(dialect);
    const r = (await queryUserTool.execute(ctx("operator_db__query_user"), { user_id: "u1" })) as { ok: boolean; data: Record<string, unknown> };
    expect(r.ok).toBe(true);
    expectRedactedUser(r.data);
  });

  it("query_listing masks the record the same way", async () => {
    setup(dialect);
    const r = (await queryListingTool.execute(ctx("operator_db__query_listing"), { listing_id: "l1" })) as { data: Record<string, unknown> };
    expectRedactedUser(r.data);
  });

  it("query_recent_transactions masks every row", async () => {
    setup(dialect);
    const r = (await queryRecentTransactionsTool.execute(ctx("operator_db__query_recent_transactions"), {
      user_id: "u1",
      since_unix: 0,
    })) as { data: Record<string, unknown>[] };
    expect(r.data.length).toBeGreaterThan(0);
    for (const row of r.data) expectRedactedUser(row);
  });
});

describe("mongo named reads leave secret-named fields out at the query", () => {
  it("passes an exclusion projection built from the catalog", async () => {
    const fake = setup("mongodb");
    await queryUserTool.execute(ctx("operator_db__query_user"), { user_id: "u1" });
    const call = fake.calls.mongo.find((c) => c.op === "findOne")!;
    const projection = (call.args[2] as { projection?: Record<string, number> } | undefined)?.projection;
    expect(projection).toMatchObject({ password: 0, passwordHash: 0, tokens: 0, notifTokens: 0 });
    expect(projection).not.toHaveProperty("status");
  });
});

describe("redactingDriver", () => {
  it("passes typed aggregates through untouched (contact_n is a count, not a contact)", async () => {
    const rows = [{ city: "Austin", category: "suv", week_start: "2026-09-28", search_n: 9, view_n: 5, contact_n: 3, book_n: 1 }];
    const base = { query_funnel_by_geo_category: async () => ({ ok: true as const, data: { rows, truncated: false, total_segments_seen: 1 } }) };
    const d = redactingDriver(base as unknown as OperatorDbDriver);
    const r = await d.query_funnel_by_geo_category({ lookback_weeks: 4, top_n: 10 }, {} as never);
    expect(r.data!.rows[0]).toEqual(rows[0]);
  });

  it("redacts any method not on the aggregate list, including one added later", async () => {
    const base = { query_something_new: async () => ({ ok: true as const, data: [{ id: 1, email: "a@b.com" }] }) };
    const d = redactingDriver(base as unknown as OperatorDbDriver) as unknown as typeof base;
    expect((await d.query_something_new()).data).toEqual([{ id: 1, email: "‹redacted›" }]);
  });

  it("keeps a boolean under a PII-named key (a flag is not PII)", () => {
    expect(redactRecords({ isMobileVerified: true, emailVerify: false, phone: "4155550100" })).toEqual({
      isMobileVerified: true,
      emailVerify: false,
      phone: "‹redacted›",
    });
  });

  it("redacts a { rows } page per row, keeping the page's own fields", () => {
    const out = redactRecords({ collection: "users", row_count: 1, truncated: false, rows: [{ id: 1, phone: "4155550100" }] });
    expect(out).toEqual({ collection: "users", row_count: 1, truncated: false, rows: [{ id: 1, phone: "‹redacted›" }] });
  });
});

describe("redactComputed (CodeAct result)", () => {
  it("masks PII strings and identifiers but keeps counts under PII-named keys", () => {
    const out = redactComputed({
      emails_sent: 1200,
      contact_rate: 0.42,
      rows: [{ id: 7, phone: "4155550100", phone_num: 4155550100, name: "Ann Lee", bookings: 3, note: "mail a@b.com" }],
      by_city: { Austin: 12 },
    });
    expect(out).toEqual({
      emails_sent: 1200,
      contact_rate: 0.42,
      rows: [{ id: 7, phone: "‹redacted›", phone_num: "‹redacted›", name: "‹redacted›", bookings: 3, note: "mail ‹redacted:email›" }],
      by_city: { Austin: 12 },
    });
  });
});

describe("denylist additions", () => {
  const isRedacted = (col: string) => redactValue(col, "v") === "‹redacted›";
  it("redacts credential and identity-document fields", () => {
    for (const col of ["hash", "passwordHash", "hashedPassword", "salt", "jwt", "otp", "otpCode", "fcmToken", "apnsId", "authKey", "auth_code", "credentials", "encryptedData", "iv", "registrationIp", "ip", "deviceFingerprint", "dlNumber", "dl_number", "licenseNumber", "license", "driverLicense", "drivinglicense", "passportNo", "selfieStorageKey", "mvrDetails", "criminalDetails", "middleName", "sessionCookie"]) {
      expect(isRedacted(col), `${col} must be redacted`).toBe(true);
    }
  });
  it("leaves verification outcomes, the plate and look-alike names alone", () => {
    for (const col of ["licensePlate", "licensePlateState", "dlStatus", "isDriverVerified", "hashtag", "shipper", "tripId", "status", "download", "saltwater"]) {
      expect(isRedacted(col), `${col} must NOT be redacted`).toBe(false);
    }
  });
});

describe("secrets under neutral keys and odd key spellings (SEC-1..3)", () => {
  const BCRYPT = "$2b$10$" + "N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
  const ARGON = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const B64 = "dGhpc0lzQVNlY3JldFRva2VuVmFsdWUxMjM0NTY3ODkwQUJDREVGRw";

  it("masks password hashes and JWTs under a neutral key; long hex / base64 ids stay", () => {
    expect(redactValue("meta", HEX)).toBe(HEX);
    expect(redactValue("utm_campaign", "SummerSaleCampaign2026NorthAmericaVariant1")).toBe("SummerSaleCampaign2026NorthAmericaVariant1");
    expect(redactValue("meta", B64)).toBe(B64);
    for (const v of [BCRYPT, ARGON, JWT]) {
      expect(redactValue("meta", v), v.slice(0, 12)).toMatch(/^‹redacted/);
      expect(String(redactValue("data", `x ${v} y`)), v.slice(0, 12)).not.toContain(v.slice(8, 30));
    }
    expect(redactRecords({ meta: { data: [BCRYPT, JWT] } })).toEqual({ meta: { data: ["‹redacted:secret›", "‹redacted:secret›"] } });
  });

  it("keeps ids, UUIDs, slugs, URLs and timestamps", () => {
    for (const v of [
      "64f1a2b3c4d5e6f7a8b9c0d1",
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400e29b41d4a716446655440000",
      "cus_NffrFeUfNV2Hib",
      "how-to-rent-a-car-in-austin-for-the-weekend-cheaply",
      "https://cdn.example.com/users/64f1a2b3c4d5e6f7a8b9c0d1/ProfilePhoto1.jpg",
      "2026-10-01T12:00:00.000Z",
    ]) {
      expect(redactValue("meta", v)).toBe(v);
    }
  });

  it("matches secret key names across case, separators and acronyms", () => {
    for (const col of ["userAuthTokens", "pwd_hash", "pwd", "x-api-key", "X_API_KEY", "PASSWORD_HASH", "DLNumber", "userIPAddr", "Auth.Token", "SESSION_COOKIE"]) {
      expect(redactValue(col, "v"), col).toBe("‹redacted›");
    }
  });
});

describe("values the walker cannot look inside fail closed (SEC-4)", () => {
  it("masks Map, Set, Buffer, typed arrays, class instances, BSON Binary and toJSON hooks", async () => {
    const { ObjectId, Decimal128, Long, Binary, UUID } = await import("mongodb");
    const uuid = new UUID("550e8400-e29b-41d4-a716-446655440000");
    class Profile {
      constructor(public phone = "4155550100") {}
    }
    const id = new ObjectId("64f1a2b3c4d5e6f7a8b9c0d1");
    const at = new Date("2026-10-01T00:00:00Z");
    const rec = redactRecords({
      _id: id,
      createdAt: at,
      amount: Decimal128.fromString("12.50"),
      count: Long.fromNumber(42),
      ref: uuid,
      m: new Map([["phone", "4155550100"]]),
      s: new Set(["a@b.com"]),
      buf: Buffer.from("password=hunter2"),
      u8: new Uint8Array([104, 105]),
      inst: new Profile(),
      bin: new Binary(Buffer.from("secret")),
      hook: { toJSON: () => ({ phone: "4155550100" }) },
      [Symbol("phone")]: "4155550100",
    }) as Record<string, unknown>;
    expect(rec._id).toBe(id);
    expect(rec.createdAt).toBe(at);
    expect(String(rec.amount)).toBe("12.50");
    expect(String(rec.count)).toBe("42");
    expect(rec.ref).toBe(uuid);
    for (const k of ["m", "s", "buf", "u8", "inst", "bin"]) expect(rec[k], k).toBe("‹redacted›");
    expect(rec.hook).toEqual({ toJSON: "‹redacted›" });
    const text = JSON.stringify(rec);
    expect(text).not.toContain("4155550100");
    expect(text).not.toContain("hunter2");
    expect(Object.getOwnPropertySymbols(rec)).toHaveLength(0);
  });

  it("the CodeAct walker masks the same opaque values", () => {
    expect(redactComputed({ m: new Map([["a", 1]]), d: new Date(0), f: () => 1 })).toEqual({ m: "‹redacted›", d: new Date(0), f: "‹redacted›" });
  });

  it("a cap returns a marker, never the raw remainder", () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 30; i++) cur = (cur.next = {}) as Record<string, unknown>;
    cur.phone_note = "call 415-555-0100";
    expect(JSON.stringify(redactRecords(deep))).not.toContain("555-0100");
  });
});

describe("value patterns stay linear on hostile input (SEC-5)", () => {
  const N = 100_000;
  const rep = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const inputs: Record<string, string> = {
    b64Run: rep("aB3"),
    b64RunThenBang: rep("aB3") + "!",
    hexThenG: rep("a1") + "g",
    dots: rep("."),
    dotsAndLetters: "x@" + rep("a."),
    dollars: rep("$"),
    dollarHash: rep("$2b$"),
    eqDollarHash: rep("=$2"),
    equals: rep("="),
    jwtPrefixes: rep("eyJ"),
    emailNoAt: rep("a.b-c_d"),
    phoneRun: rep("1 2-3."),
    skRuns: rep("sk-"),
  };
  for (const [name, input] of Object.entries(inputs)) {
    it(`${name} (100KB) redacts in under 50ms`, () => {
      redactValue("meta", input);
      const t0 = performance.now();
      redactValue("meta", input);
      expect(performance.now() - t0).toBeLessThan(50);
    });
  }

  it("a 100KB upper-case key name is checked in under 50ms", () => {
    const key = "A".repeat(N);
    const t0 = performance.now();
    redactValue(key, "v");
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("still finds the PII the old patterns found", () => {
    expect(redactValue("n", "mail a@b.com.")).toBe("mail ‹redacted:email›.");
    expect(redactValue("n", "a@b.com123 x")).toBe("‹redacted:email›123 x");
    expect(redactValue("n", "call (415) 555-0100 now")).toBe("call (‹redacted:phone› now");
    expect(redactValue("n", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123")).toBe("Bearer ‹redacted:secret›");
    expect(redactValue("n", "key sk-abcdefghij12 ok")).toBe("key ‹redacted:secret› ok");
    expect(redactValue("n", "pw=$2b$10$N9qo8uLOickgx2ZMRZoMye end")).toBe("pw=‹redacted:secret› end");
    expect(redactValue("n", "on 2026-10-01 at 12:00")).toBe("on 2026-10-01 at 12:00");
  });
});

describe("no fail-open truncation, no parser differential (SEC-6..8)", () => {
  it("masks the value of a key longer than 256 chars instead of checking part of it", () => {
    const key = "x".repeat(300) + "Password";
    expect(redactRecords({ [key]: "hunter2" })).toEqual({ [key]: "‹redacted›" });
  });

  it("masks a password hash run in full, however long", () => {
    const hash = "$argon2id$v=19$m=65536,t=3,p=4$" + "A1b2".repeat(200);
    const out = String(redactValue("meta", `pw=${hash} end`));
    expect(out).toBe("pw=‹redacted:secret› end");
  });

  it("checks the key exactly as the result carries it: aliases, dotted, quoted, look-alikes", () => {
    for (const key of ["u.password", "users.phone_number", '"PhoneNumber"', "`api_key`", "ｐａｓｓｗｏｒｄ", "pa​ssword", "émail"]) {
      expect(redactRecords({ [key]: "v" }), key).toEqual({ [key]: "‹redacted›" });
    }
  });

  it("redacts inside JSON stored as a string and masks JSON that does not parse", () => {
    const out = redactRecords({
      meta: JSON.stringify({ phone: "4155550100", status: "ok", nested: [{ token: "abc" }] }),
      broken: '{"phone": "4155550100"',
      looksLike: "[unclosed {\"phone\":\"4155550100\"}]",
    }) as Record<string, string>;
    expect(JSON.parse(out.meta)).toEqual({ phone: "‹redacted›", status: "ok", nested: [{ token: "‹redacted›" }] });
    expect(out.broken).not.toContain("4155550100");
    expect(out.looksLike).toBe("‹redacted›");
    expect(redactComputed({ payload: '{"email":"a@b.com","n":3}' })).toEqual({ payload: '{"email":"‹redacted›","n":3}' });
  });
});

const MAIN_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAIN_SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const MAIN_CARD = /\b(?:\d[ -]?){13,16}\b/g;
const MAIN_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const MAIN_APIKEY = /\bsk-[A-Za-z0-9-]{10,}\b/g;
const MAIN_PHONE = /(?:\+?\d[\d ().-]{8,}\d)/g;
const mainDigits = (s: string) => s.replace(/\D/g, "");

function mainSpans(v: string): string[] {
  const spans: string[] = [];
  for (const re of [MAIN_EMAIL, MAIN_SSN, MAIN_CARD, MAIN_JWT, MAIN_APIKEY]) for (const m of v.matchAll(re)) spans.push(m[0]);
  for (const m of v.matchAll(MAIN_PHONE)) if (mainDigits(m[0]).length >= 10) spans.push(m[0]);
  return spans;
}

describe("parity with main's redaction (SEC-9..11)", () => {
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fw";
  const corpus = [
    "a@b.co", "first.last+tag@mail.sub.example.co.uk", "x".repeat(60) + "@example.com",
    "<ann_lee@example.org>", "mail:bob@ex.com,", "(c.d@e.io).", "user@xn--bcher-kva.example",
    "a@b.com123 trailing", "two a@b.com and c@d.org here", "name@host.museum!",
    "+1 (415) 555-0100", "415.555.0100", "4155550100", "+44 20 7946 0958", "+91-98765-43210",
    "415-555-0100 ext 23", "(415)555-0100x12", "call:4155550100,", "tel(415) 555 0100)",
    "1+4155550100", "id 12 (415) 555-0100 now", "+33 1 23 45 67 89", "0044 20 7946 0958.",
    "4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "card:4111111111111111.",
    "123-45-6789", "ssn=123-45-6789;", "(123-45-6789)",
    "sk-abcdefghijklmnop", "x-sk-abcdefghijklmnop", "key=sk-abc-defghijklm", "sk-abcdefghij-k_x",
    "Bearer " + JWT, "a-" + JWT, "(" + JWT + ")", "token=" + JWT + "&x=1", "eyJabc-sk-abcdefghijkl",
    `"${JWT}",4155550100;a@b.com`, "contact: a@b.com / +1 415 555 0100 / 4111 1111 1111 1111",
  ];

  for (const v of corpus) {
    it(`masks every span main masked: ${v.slice(0, 40)}`, () => {
      const out = String(redactValue("note", v));
      for (const span of mainSpans(v)) expect(out, `main masked "${span}"`).not.toContain(span);
      if (mainSpans(v).length > 0) expect(out).toContain("‹redacted");
    });
  }

  it("deliberate exception: a UUID id is no longer read as a phone", () => {
    expect(mainSpans("550e8400-e29b-41d4-a716-446655440000").length).toBeGreaterThan(0);
    expect(redactValue("ref", "550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});

describe("Lane A review fixes", () => {
  it("aggregates keep keys and numbers but value-scan their string dimensions", async () => {
    const rows = [{ utm_campaign: "promo a@b.com", utm_source: "4155550100", verified_bookings: 3, net_gmv: 1234567, cancellations: 0 }];
    const base = { query_verified_bookings_by_campaign: async () => ({ ok: true as const, data: { available: true, window_days: 30, total_verified: 9, matched_verified: 3, rows } }) };
    const d = redactingDriver(base as unknown as OperatorDbDriver);
    const r = await d.query_verified_bookings_by_campaign({ window_days: 30 }, {} as never);
    expect(r.data!.rows[0]).toEqual({ utm_campaign: "promo ‹redacted:email›", utm_source: "‹redacted:phone›", verified_bookings: 3, net_gmv: 1234567, cancellations: 0 });
    expect(r.data!.total_verified).toBe(9);
  });

  it("one huge string cannot pass the byte cap whole", () => {
    const big = "x".repeat(300 * 1024);
    expect(redactRecords({ note: big })).toEqual({ note: "‹redacted:capped›" });
  });

  it("a page past its total budget is capped from that row on", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ i, note: "y".repeat(200 * 1024) }));
    const out = redactRecords(rows) as unknown[];
    expect(out[0]).toMatchObject({ i: 0 });
    expect(out[39]).toBe("‹redacted:capped›");
  });

  it("CodeAct keeps measures under PII-named keys at any size", () => {
    expect(redactComputed({ emails_sent: 1_000_000, contact_count: 2_500_000, phone: 4155550100 })).toEqual({
      emails_sent: 1_000_000,
      contact_count: 2_500_000,
      phone: "‹redacted›",
    });
  });

  it("business columns that only measure a sensitive thing stay; id columns keep long ids", () => {
    for (const col of ["software_license_count", "hash_rate", "ip_count"]) expect(redactValue(col, 42), col).toBe(42);
    expect(redactValue("dlStatus", "verified")).toBe("verified");
    const hexId = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    expect(redactValue("id", hexId)).toBe(hexId);
    expect(redactValue("token", hexId)).toBe("‹redacted›");
  });
});

describe("mongo aggregate drops secret fields before the caller's stages", () => {
  it("a stage cannot copy a secret field out under another name", async () => {
    const { mongoDriver } = await import("../drivers/mongo");
    const { attachSession } = await import("../session-attach");
    const fake = fakeSession({ dialect: "mongodb", docs: [{ x: "copied" }] });
    const cfg = attachSession({ users: { table: "users", id_field: "_id" } } as never, fake.session);
    await mongoDriver().aggregate!("users", [{ $project: { x: "$password" } }], { secretFieldExclusions: ["password"] }, cfg, new Set(["users"]));
    const pipeline = fake.calls.mongo.find((c) => c.op === "aggregate")!.args[1] as Record<string, unknown>[];
    expect(pipeline[0]).toEqual({ $unset: ["password"] });
    expect(pipeline[1]).toEqual({ $project: { x: "$password" } });
  });
});

describe("bypasses of the over-masking exemptions (SEC-12/13)", () => {
  it("a count/status-named column still masks a string value", () => {
    for (const [col, v] of [["ssn_status", "123-45-6789"], ["ip_count", "10.1.2.3"], ["cardType", "4111111111111111"], ["dl_total", "D1234567"]] as const) {
      expect(redactValue(col, v), col).toBe("‹redacted›");
    }
  });

  it("a session / auth / reset 'id' is scanned as a secret", () => {
    const tok = "dGhpc0lzQVNlY3JldFRva2VuVmFsdWUxMjM0NTY3ODkwQUJDREVGRw";
    for (const col of ["session_id", "sessionId", "auth_ref", "reset_id", "api_key_id", "device_push_id"]) {
      expect(String(redactValue(col, tok)), col).not.toContain(tok);
    }
  });
});

describe("second review round: one secret list, JSON, session ids, over-masking", () => {
  it("the Mongo $unset list comes from the redactor's own secret list", async () => {
    const { buildProjection } = await import("../drivers/mongo");
    expect(buildProjection(undefined, ["pwd", "salt", "otp", "iv", "sessionId", "password", "email", "city"])).toEqual({
      pwd: 0, salt: 0, otp: 0, iv: 0, sessionId: 0, password: 0,
    });
  });

  it("an unclosed JSON object is masked, not passed through", () => {
    expect(redactRecords({ meta: '{"password":"hunter2"' })).toEqual({ meta: "‹redacted›" });
    expect(redactRecords({ note: "[urgent] call back" })).toEqual({ note: "[urgent] call back" });
  });

  it("session / auth / reset / api ids mask under any key form, UUID-shaped included", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    for (const k of ["session_id", "sessionId", "sessionToken", "sid", "authId", "reset_code", "api_key_id", "csrf"]) {
      expect(redactValue(k, uuid), k).toBe("‹redacted›");
    }
    expect(redactValue("order_id", uuid)).toBe(uuid);
    expect(redactValue("authProvider", "google")).toBe("google");
  });

  it("measures keep their numbers; digit strings in id / amount columns stay", () => {
    expect(redactRecords({ email_count: 42, contact_n: 3, open_rate: 0.4, phone: 4155550100 })).toEqual({ email_count: 42, contact_n: 3, open_rate: 0.4, phone: "‹redacted›" });
    expect(redactValue("order_id", "123456789012")).toBe("123456789012");
    expect(redactValue("whatsapp_number", "4155550100")).toBe("‹redacted:phone›");
    expect(redactValue("total_amount", "1234567890.00")).toBe("1234567890.00");
    expect(redactValue("note", "123456789012")).toBe("‹redacted:phone›");
    expect(redactValue("phone_number", "4155550100")).toBe("‹redacted›");
    expect(redactValue("card_number", "4111111111111111")).toBe("‹redacted›");
  });
});

describe("final review round: JSON dimensions, run-together keys", () => {
  it("an aggregate dimension holding JSON is redacted inside", async () => {
    const rows = [{ utm_campaign: '{"password":"hunter2","phone":"4155550100"}', verified_bookings: 2, utm_source: null, net_gmv: 0, cancellations: 0 }];
    const base = { query_verified_bookings_by_campaign: async () => ({ ok: true as const, data: { available: true, window_days: 30, total_verified: 2, matched_verified: 2, rows } }) };
    const d = redactingDriver(base as unknown as OperatorDbDriver);
    const r = await d.query_verified_bookings_by_campaign({ window_days: 30 }, {} as never);
    expect(JSON.stringify(r.data)).not.toContain("hunter2");
    expect(JSON.stringify(r.data)).not.toContain("4155550100");
  });

  it("run-together session keys mask a UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    for (const k of ["sessionid", "authid", "resetcode", "csrftoken"]) expect(redactValue(k, uuid), k).toBe("‹redacted›");
  });
});

describe("place and document fields on a real-shaped user record", () => {
  it("masks addresses and document numbers but keeps city, state and other analytics fields", () => {
    const out = redactRecords({
      _id: "u1",
      city: "Austin",
      state: "TX",
      country: "US",
      userArea: "Downtown",
      status: "active",
      location: { city: "Austin", state: "TX", address: "1 Main St", coordinates: [-97.74, 30.27] },
      pickupLocation: "1 Main St, Austin",
      location_id: "loc_42",
      shipping: { line1: "1 Main St", line2: "Apt 4", city: "Austin", state: "TX", zip: "78701" },
      shipping_status: "shipped",
      document_number: "X1234567",
      document_type: "passport",
      lineItems: [{ sku: "A1", qty: 2 }],
      tripCount: 7,
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      _id: "u1",
      city: "Austin",
      state: "TX",
      country: "US",
      userArea: "Downtown",
      status: "active",
      location_id: "loc_42",
      shipping_status: "shipped",
      document_type: "passport",
      lineItems: [{ sku: "A1", qty: 2 }],
      tripCount: 7,
    });
    expect(out.location).toEqual({ city: "Austin", state: "TX", address: "‹redacted›", coordinates: "‹redacted›" });
    expect(out.shipping).toEqual({ line1: "‹redacted›", line2: "‹redacted›", city: "Austin", state: "TX", zip: "‹redacted›" });
    expect(out.pickupLocation).toBe("1 Main St, Austin");
    expect(redactRecords({ location: "Austin", line: "SUV" })).toEqual({ location: "Austin", line: "SUV" });
    expect(out.document_number).toBe("‹redacted›");
  });
});

describe("call-13 regressions: session measures and line dimensions stay", () => {
  it("session counts and product lines are not secrets; session ids and address lines are", async () => {
    const { isSecretField } = await import("../discovery/redact");
    for (const k of ["session_count", "sessions_total", "avg_session_length"]) expect(isSecretField(k), k).toBe(false);
    for (const k of ["session_id", "sessionToken", "sid", "sessions"]) expect(isSecretField(k), k).toBe(true);
    expect(redactRecords({ product_line: "SUV", business_line: "rentals", line1: "1 Main St", session_count: 4 })).toEqual({
      product_line: "SUV",
      business_line: "rentals",
      line1: "‹redacted›",
      session_count: 4,
    });
  });
});

const MAIN_LONG_DENY =
  /(pass(word|wd)?|secret|token|social.?security|date.?of.?birth|routing|account.?number|tax.?id|api.?key|private.?key|e?mail|phone|mobile|address|street|postal|first.?name|last.?name|full.?name|surname|given.?name|\bname\b|contact|longitude|latitude)/i;
const MAIN_SHORT_DENY = new Set(["ssn", "dob", "card", "cvv", "cvc", "bank", "iban", "fax", "zip", "lat", "lng", "geo"]);
const MAIN_SECRET_FIELD_RE =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|^body$|_body$|blob|html|encrypted|cipher)/i;
const mainTokens = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z]+/).filter(Boolean).map((t) => t.toLowerCase());
const mainDeny = (name: string) => MAIN_LONG_DENY.test(name) || mainTokens(name).some((t) => MAIN_SHORT_DENY.has(t));

function mainRedactValue(v: string): string {
  const d = (x: string) => x.replace(/\D/g, "");
  const t = v.trim();
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(t)) return "‹redacted:email›";
  if (/^\d{3}-\d{2}-\d{4}$/.test(t)) return "‹redacted:ssn›";
  if (/^(?:\d[ -]?){13,16}$/.test(t) && d(t).length >= 13 && d(t).length <= 16) return "‹redacted:card›";
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) return "‹redacted:secret›";
  if (/^sk-[A-Za-z0-9-]{10,}$/.test(t)) return "‹redacted:secret›";
  if (/^\+?[\d ().-]{10,}$/.test(t) && d(t).length >= 10 && d(t).length <= 15) return "‹redacted:phone›";
  return v
    .replace(MAIN_EMAIL, "‹redacted:email›")
    .replace(MAIN_SSN, "‹redacted:ssn›")
    .replace(MAIN_CARD, "‹redacted:card›")
    .replace(MAIN_JWT, "‹redacted:secret›")
    .replace(MAIN_APIKEY, "‹redacted:secret›")
    .replace(MAIN_PHONE, (m) => (d(m).length >= 10 ? "‹redacted:phone›" : m));
}

describe("parity with origin/main: names", () => {
  const NAMES = [
    "session_token", "sessionToken", "auth_token", "refresh_token", "product_line", "address_line1", "contact_email",
    "zip_code", "zip", "line1", "session_count", "email", "user_email", "emailAddress", "phone", "phone_number", "mobile",
    "contactNumber", "address", "street", "postal_code", "first_name", "lastName", "full_name", "surname", "given_name",
    "name", "owner name", "contact", "longitude", "latitude", "lat", "lng", "geo_point", "ssn", "dob", "card_number",
    "cardType", "giftCardBalance", "cvv", "cvc", "bank_account", "iban", "fax", "password", "passwd", "passwordHash",
    "secret", "client_secret", "token", "api_key", "apiKey", "private_key", "routing_number", "account_number", "tax_id",
    "date_of_birth", "social_security_number", "email_count", "contacted_at", "hostname", "username", "licensePlate",
    "carDailyMileage", "platform", "status", "city", "state", "amount", "session_id", "document_number", "location",
  ];

  it("every name main's LONG_DENY / SHORT_DENY masks, the PR masks too (string values)", () => {
    for (const n of NAMES) {
      if (!mainDeny(n)) continue;
      expect(redactValue(n, "some text value"), n).toBe("‹redacted›");
      expect(redactRecords({ [n]: "some text value" }), n).toEqual({ [n]: "‹redacted›" });
    }
  });

  it("every name main's SECRET_FIELD_RE excludes at the query, isSecretField excludes too", async () => {
    const { isSecretField } = await import("../discovery/redact");
    for (const n of [...NAMES, "html_body", "body", "blob_data", "encrypted_ssn", "cipher_text", "access_key", "credentials"]) {
      if (MAIN_SECRET_FIELD_RE.test(n)) expect(isSecretField(n), n).toBe(true);
    }
  });

  it("the only names main masked that the PR keeps are the listed intentional keeps", () => {
    expect(mainDeny("email_count")).toBe(true);
    expect(redactValue("email_count", 42)).toBe(42);
    expect(redactValue("email_count", "42 people")).toBe("‹redacted›");
  });
});

describe("parity with origin/main: values", () => {
  const VALUES = [
    "a@b.co", "a+b@c.co", "a@a@b.com", "x@y@z.org", "user@@b.com", "@b.com", "a@b", "a@b.c", "a@-b.com", "a@b.com123",
    "a@b.com.", "first.last+tag@mail.sub.example.co.uk", "mail: a@b.com, c@d.org", "<ann@x.io>", "a@b.co.uk@c",
    "4155550100", "+1 (415) 555-0100", "415.555.0100", "+44 20 7946 0958", "+91-98765-43210", "415-555-0100 ext 23",
    "call 4155550100 now", "(415)555-0100x12", "12345678901234", "1 2 3 4 5 6 7 8 9 0",
    "4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "card:4111111111111111.", "378282246310005",
    "123-45-6789", "ssn=123-45-6789;", "x123-45-6789",
    "sk-abcdefghijklmnop", "x-sk-abcdefghijklmnop", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_DEF-123",
  ];

  it("every value main masks, the PR masks too (whole value and every span)", () => {
    for (const v of VALUES) {
      const main = mainRedactValue(v);
      if (main === v) continue;
      const mine = String(redactValue("note", v));
      if (main.startsWith("‹redacted") && !main.slice(1).includes(" ")) {
        expect(mine.includes("‹redacted"), `${v}: main masked it whole`).toBe(true);
      }
      for (const span of mainSpans(v)) expect(mine, `${v}: main masked "${span}"`).not.toContain(span);
    }
  });
});
