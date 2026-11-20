import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { ConnectorHeartbeat } from "@zavi/shared/db-guard";
import { ZaviClient, backoffMs, retryAfterMs, type FetchLike } from "../client";
import { ConnectorRuntime, REVOKED_MESSAGE } from "../runtime";
import { Store } from "../store";
import { resolveKey } from "../keys";
import { RulesFile } from "../rules";
import { ActivityLog } from "../activity";
import { DatabaseManager } from "../db";
import type { Driver, Introspection } from "../db/types";

const TOKEN = "zconn_" + "b".repeat(64);
const CODE = "zpair_" + "A".repeat(26);
const ID = "11111111-1111-4111-8111-111111111111";
const ET = "22222222-2222-4222-8222-222222222222";

const intro: Introspection = {
  dialect: "postgres",
  database: null,
  tables: [{ name: "users", rowEstimate: 3, columns: [{ name: "id", type: "integer", nullable: false }, { name: "plan", type: "text", nullable: true }] }],
  skippedUnsafeNames: 0,
  namesSeenTotal: 1,
  deadlineHit: false,
  listingTruncated: false,
};

type Scripted = { status: number; body?: unknown; headers?: Record<string, string> } | ((url: string, init: RequestInit) => Promise<Response> | Response);

function setup(opts: { token?: string | null; pair?: string | null; script?: Record<string, Scripted[]>; sql?: Driver["sql"]; withDb?: boolean; intro?: Introspection } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zc-rt-"));
  const store = Store.open(dir, resolveKey({ secretFile: join(dir, "none"), envKey: null, dataDir: dir }));
  if (opts.token !== null) store.update((s) => ({ ...s, token: opts.token ?? TOKEN }));
  const driver: Driver = {
    dialect: "postgres",
    database: null,
    test: async () => undefined,
    introspect: async () => opts.intro ?? intro,
    sql: opts.sql ?? (async () => ({ columns: ["id", "plan"], rows: [{ id: 1, plan: "pro" }], truncated: false })),
    mongo: () => {
      throw new Error("x");
    },
    transport: () => "plaintext",
    close: async () => undefined,
  };
  const db = new DatabaseManager(store, () => driver);
  if (opts.withDb !== false) store.update((s) => ({ ...s, database: { dialect: "postgres", connection_string: "postgres://ro:pw@localhost/app", saved_at: "x" } }));
  const rules = new RulesFile(dir);
  const activity = new ActivityLog(dir);
  const calls: { path: string; init: RequestInit }[] = [];
  const queues = new Map(Object.entries(opts.script ?? {}).map(([k, v]) => [k, [...v]]));
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const key = path.startsWith("/api/connector/requests/") && path.endsWith("/result") ? "result" : path.replace("/api/connector/", "");
    const q = queues.get(key);
    const next = q?.shift();
    if (!next) {
      if (key === "requests/next") {
        await new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
      return new Response(null, { status: key === "result" ? 204 : 200 });
    }
    if (typeof next === "function") return next(url, init);
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.headers });
  };
  const sleeps: number[] = [];
  const logs: string[] = [];
  const rt = new ConnectorRuntime({
    cfg: { pairCode: opts.pair ?? null, machine: "box-1", version: "1.0.0", concurrency: 2, maxStatementMs: 30_000 },
    store,
    rules,
    db,
    activity,
    client: new ZaviClient("https://api.test", "1.0.0", () => store.read().token, fetchImpl),
    log: (_l, m) => void logs.push(m),
    rand: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((r) => setTimeout(r, 1));
    },
  });
  return { rt, store, rules, activity, calls, sleeps, logs, dir };
}

const until = async (fn: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("backoff and Retry-After", () => {
  it("full jitter, exponential, capped", () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(30, () => 1)).toBe(60000);
    expect(backoffMs(5, () => 0)).toBe(250);
  });
  it("Retry-After seconds or date, clamped", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("0")).toBe(1000);
    expect(retryAfterMs("99999")).toBe(300000);
    expect(retryAfterMs(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
    expect(retryAfterMs("soon")).toBeNull();
  });
});

describe("pairing on boot", () => {
  it("a rejected code: no token stored, status explains, nothing polls", async () => {
    const t = setup({ token: null, pair: CODE, script: { pair: [{ status: 401, body: { error: { code: "unauthorized" } } }] } });
    await t.rt.start();
    expect(t.rt.status.kind).toBe("pair_failed");
    expect(t.store.read().token).toBeNull();
    expect(t.calls.map((c) => c.path)).toEqual(["/api/connector/pair"]);
  });
  it("429 and network errors retry (Retry-After honoured), then pairing stores the token encrypted", async () => {
    const t = setup({
      token: null,
      pair: CODE,
      script: {
        pair: [
          { status: 429, headers: { "Retry-After": "7" } },
          () => Promise.reject(new TypeError("fetch failed")),
          { status: 200, body: { token: TOKEN } },
        ],
      },
    });
    await t.rt.start();
    expect(t.store.read().token).toBe(TOKEN);
    expect(t.sleeps[0]).toBe(7000);
    expect(t.sleeps.length).toBe(2);
    const body = JSON.parse(String(t.calls[0]!.init.body));
    expect(body).toEqual({ code: CODE, machine: "box-1", version: "1.0.0" });
    expect(readFileSync(join(t.dir, "state.enc")).includes(Buffer.from(TOKEN))).toBe(false);
    await t.rt.stop(50);
  });
  it("a token from the same code is not re-paired", async () => {
    const t = setup({ token: null, pair: CODE, script: { pair: [{ status: 200, body: { token: TOKEN } }] } });
    await t.rt.start();
    await t.rt.stop(50);
    const again = new ConnectorRuntime({ ...(t.rt as unknown as { d: ConstructorParameters<typeof ConnectorRuntime>[0] }).d });
    await again.start();
    expect(t.calls.filter((c) => c.path === "/api/connector/pair")).toHaveLength(1);
    await again.stop(50);
  });
  it("a garbage token from the API is not stored", async () => {
    const t = setup({ token: null, pair: CODE, script: { pair: [{ status: 200, body: { token: "nope" } }, { status: 401 }] } });
    await t.rt.start();
    expect(t.store.read().token).toBeNull();
  });
});

describe("polling", () => {
  it("honours 429 Retry-After with jitter, then runs a request and posts the result with its execution token", async () => {
    const t = setup({
      script: {
        "requests/next": [
          { status: 429, headers: { "Retry-After": "3" } },
          { status: 200, body: { id: ID, execution_token: ET, generation: 7, op: { op: "sql", text: "SELECT id, plan FROM users", max_rows: 10 } } },
          { status: 204 },
        ],
      },
    });
    t.rules.save({ allowed: ["users"], blocked: [], what_can_leave: "rows_without_blocked_columns", max_rows: 10 }, { database: null, unit: "table" });
    await t.rt.start();
    await until(() => t.activity.list().length === 1);
    await t.rt.stop(100);
    expect(t.sleeps[0]).toBeGreaterThanOrEqual(3000);
    expect(t.sleeps[0]).toBeLessThanOrEqual(3600);
    const post = t.calls.find((c) => c.path === `/api/connector/requests/${ID}/result`)!;
    const sent = JSON.parse(String(post.init.body));
    expect(sent.execution_token).toBe(ET);
    expect(sent.status).toBe("done");
    expect(sent.generation).toBe(7);
    expect(sent.source_instance_id === null || /^[0-9a-f]{32}$/.test(sent.source_instance_id)).toBe(true);
    expect(sent.data.rows).toEqual([[1, "pro"]]);
    expect((post.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("a refused request is logged locally with the byte-identical payload that was posted", async () => {
    const t = setup({ script: { "requests/next": [{ status: 200, body: { id: ID, execution_token: ET, generation: 7, op: { op: "sql", text: "SELECT id FROM users", max_rows: 10 } } }, { status: 204 }] } });
    await t.rt.start();
    await until(() => t.activity.list().length === 1);
    await t.rt.stop(100);
    const post = t.calls.find((c) => c.path.endsWith("/result"))!;
    const row = t.activity.list()[0]!;
    expect(row.decision).toBe("refused");
    expect(t.activity.get(row.id)!.sent).toBe(String(post.init.body));
    expect(row.bytes).toBe(Buffer.byteLength(String(post.init.body)));
    expect(JSON.parse(String(post.init.body))).toMatchObject({ status: "refused", reason: expect.stringMatching(/No tables are allowed/) });
  });

  describe("refusals sent to Zavi never name blocked fields or tables", () => {
    const wide: Introspection = {
      ...intro,
      tables: [
        { name: "users", rowEstimate: 3, columns: [{ name: "id", type: "integer", nullable: false }, { name: "plan", type: "text", nullable: true }, { name: "ssn", type: "text", nullable: true }] },
        { name: "payroll_secret", rowEstimate: 3, columns: [{ name: "id", type: "integer", nullable: false }] },
      ],
    };
    async function run(text: string, sql?: Driver["sql"]) {
      const t = setup({ intro: wide, sql, script: { "requests/next": [{ status: 200, body: { id: ID, execution_token: ET, generation: 7, op: { op: "sql", text, max_rows: 10 } } }, { status: 204 }] } });
      t.rules.save({ allowed: ["users"], blocked: ["users.ssn"], what_can_leave: "rows_without_blocked_columns", max_rows: 10 }, { database: null, unit: "table" });
      await t.rt.start();
      await until(() => t.activity.list().length === 1);
      await t.rt.stop(100);
      const sent = String(t.calls.find((c) => c.path.endsWith("/result"))!.init.body);
      const row = t.activity.list()[0]!;
      return { sent, parsed: JSON.parse(sent) as { status: string; reason: string }, row, full: t.activity.get(row.id)! };
    }
    it("a blocked field: generic text to Zavi, the detail in the local log", async () => {
      const r = await run("SELECT ssn FROM users");
      expect(r.parsed).toMatchObject({ status: "refused", reason: "The query uses a field blocked by your connector's rules." });
      expect(r.sent).not.toMatch(/ssn/i);
      expect(r.row.reason).toMatch(/ssn/);
      expect(r.full.sent).toBe(r.sent);
    });
    it("a table the rules do not allow: generic text to Zavi", async () => {
      const r = await run("SELECT id FROM payroll_secret");
      expect(r.parsed).toMatchObject({ status: "refused", reason: "The query reads a table your connector doesn't allow." });
      expect(r.sent).not.toContain("payroll_secret");
      expect(r.row.reason).toContain("payroll_secret");
    });
    it("a database error is not forwarded", async () => {
      const r = await run("SELECT id, plan FROM users", async () => {
        throw new Error('column "payroll_secret.salary" does not exist near ssn');
      });
      expect(r.parsed).toMatchObject({ status: "failed", reason: "The database returned an error." });
      expect(r.sent).not.toMatch(/payroll|ssn|salary/);
      expect(r.row.reason).toMatch(/salary/);
    });
  });

  it("a request it cannot parse is refused back to Zavi, not run", async () => {
    const t = setup({ script: { "requests/next": [{ status: 200, body: { id: ID, execution_token: ET, op: { op: "drop_everything" } } }, { status: 204 }] } });
    await t.rt.start();
    await until(() => t.calls.some((c) => c.path.endsWith("/result")));
    await t.rt.stop(100);
    expect(JSON.parse(String(t.calls.find((c) => c.path.endsWith("/result"))!.init.body))).toMatchObject({ execution_token: ET, status: "refused" });
  });

  it("network errors back off with growing waits instead of spinning", async () => {
    const fail = () => Promise.reject(new TypeError("fetch failed"));
    const t = setup({ script: { "requests/next": [fail, fail, fail, { status: 204 }] } });
    await t.rt.start();
    await until(() => t.sleeps.length >= 3);
    await t.rt.stop(50);
    expect(t.sleeps.slice(0, 3)).toEqual([500, 1000, 2000]);
  });

  it("401 confirmed twice: stops, clears the token, says the pairing was revoked", async () => {
    let now = 1_000_000;
    const t = setup({ script: { "requests/next": [{ status: 401 }, { status: 401 }, { status: 401 }], heartbeat: [{ status: 401 }, { status: 401 }] } });
    (t.rt as unknown as { now: () => number }).now = () => (now += 3_000);
    await t.rt.start();
    await until(() => t.rt.status.kind === "revoked");
    expect(t.rt.lastError).toBe(REVOKED_MESSAGE);
    expect(t.store.read().token).toBeNull();
    await t.rt.stop(50);
  });
});

describe("heartbeat", () => {
  it("carries machine, version, dialect, the rules summary and its hash; a rules save sends one right away", async () => {
    const t = setup({ script: { heartbeat: [{ status: 200, body: { ok: true } }], "requests/next": [] } });
    await t.rt.start();
    await until(() => t.calls.some((c) => c.path === "/api/connector/heartbeat"));
    const first = JSON.parse(String(t.calls.find((c) => c.path === "/api/connector/heartbeat")!.init.body));
    expect(ConnectorHeartbeat.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({ machine: "box-1", version: "1.0.0", dialect: "postgres", rules: { allowed_tables: [], what_can_leave: "totals_and_counts_only" } });
    t.rules.save({ allowed: ["users"], blocked: [], what_can_leave: "totals_and_counts_only", max_rows: 200 }, { database: null, unit: "table" });
    await until(() => t.calls.filter((c) => c.path === "/api/connector/heartbeat").length >= 2);
    const second = JSON.parse(String(t.calls.filter((c) => c.path === "/api/connector/heartbeat")[1]!.init.body));
    expect(second.rules.allowed_tables).toEqual(["users"]);
    expect(second.rules_hash).not.toBe(first.rules_hash);
    await t.rt.stop(50);
  });
  it("a save that changes only allowed_columns sends a heartbeat with a new rules_hash", async () => {
    const t = setup({ script: { heartbeat: [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }], "requests/next": [] } });
    const rules = { allowed: ["users"], blocked: [], what_can_leave: "totals_and_counts_only" as const, max_rows: 200 };
    t.rules.save(rules, { database: null, unit: "table" });
    await t.rt.start();
    const hbs = () => t.calls.filter((c) => c.path === "/api/connector/heartbeat").map((c) => JSON.parse(String(c.init.body)));
    await until(() => hbs().length >= 1);
    const n = hbs().length;
    const first = hbs()[n - 1]!;
    t.rules.save({ ...rules, allowed_columns: ["users.who"] }, { database: null, unit: "table" });
    await until(() => hbs().length > n);
    const second = hbs()[hbs().length - 1]!;
    expect(ConnectorHeartbeat.safeParse(second).success).toBe(true);
    expect(second.rules.allowed_tables).toEqual(first.rules.allowed_tables);
    expect(second.rules.allowed_columns).toEqual(["users.who"]);
    expect(second.rules_hash).not.toBe(first.rules_hash);
    await t.rt.stop(50);
  });
});

describe("shutdown", () => {
  it("a read that cannot finish in the grace period is reported failed to Zavi, not left to time out", async () => {
    let release!: () => void;
    const t = setup({
      sql: () => new Promise((r) => (release = () => r({ columns: ["id"], rows: [], truncated: false }))),
      script: { "requests/next": [{ status: 200, body: { id: ID, execution_token: ET, generation: 7, op: { op: "sql", text: "SELECT id FROM users", max_rows: 10 } } }, { status: 204 }] },
    });
    t.rules.save({ allowed: ["users"], blocked: [], what_can_leave: "rows_without_blocked_columns", max_rows: 10 }, { database: null, unit: "table" });
    await t.rt.start();
    await until(() => typeof release === "function");
    await t.rt.stop(30);
    const posts = t.calls.filter((c) => c.path.endsWith("/result")).map((c) => JSON.parse(String(c.init.body)));
    expect(posts[0]).toMatchObject({ execution_token: ET, status: "failed", reason: expect.stringMatching(/shutting down/) });
    release();
  });
});

describe("source instance (final review finding 3)", () => {
  it("the saved database gets a random id; a new save or a removal changes it, and the heartbeat carries it", async () => {
    const t = setup({ script: {} });
    const first = t.rt.heartbeatBody().source_instance_id;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(t.rt.heartbeatBody().source_instance_id).toBe(first);
    const db = new DatabaseManager(t.store, () => ({ dialect: "postgres", database: null, test: async () => undefined, introspect: async () => intro, sql: async () => ({ columns: [], rows: [], truncated: false }), mongo: () => { throw new Error("x"); }, transport: () => "plaintext", close: async () => undefined }) as Driver);
    expect((await db.testAndSave("postgres", "postgres://ro:pw@localhost/app")).ok).toBe(true);
    const second = t.rt.heartbeatBody().source_instance_id;
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    db.remove();
    expect(t.rt.heartbeatBody().source_instance_id).toBeNull();
  });
  it("a database replaced while a read runs: nothing from it is sent (failed source_changed)", async () => {
    let store: Store | null = null;
    const t = setup({
      sql: async () => {
        store!.update((s) => ({ ...s, database: s.database ? { ...s.database, source_instance_id: "f".repeat(32) } : null }));
        return { columns: ["id", "plan"], rows: [{ id: 1, plan: "pro" }], truncated: false };
      },
      script: { "requests/next": [{ status: 200, body: { id: ID, execution_token: ET, generation: 7, op: { op: "sql", text: "SELECT id, plan FROM users", max_rows: 10 } } }, { status: 204 }] },
    });
    store = t.store;
    t.rules.save({ allowed: ["users"], blocked: [], what_can_leave: "rows_without_blocked_columns", max_rows: 10 }, { database: null, unit: "table" });
    await t.rt.start();
    await until(() => t.activity.list().length === 1);
    await t.rt.stop(100);
    const sent = JSON.parse(String(t.calls.find((c) => c.path.endsWith("/result"))!.init.body));
    expect(sent).toMatchObject({ status: "failed", reason: "source_changed", generation: 7 });
    expect(JSON.stringify(sent)).not.toContain("pro");
  });
});
