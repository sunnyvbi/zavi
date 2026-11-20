import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_A = "73db45ff-457e-4541-bc8f-bdb625390204";
const TENANT_B = "e0fe9ea8-1111-4222-8333-444455556666";
const SLUG = "google_ads";
const RUN_A = "11111111-aaaa-4bbb-8ccc-dddddddddddd";
const RUN_A_OLDER = "22222222-aaaa-4bbb-8ccc-dddddddddddd";
const DECISION_A_ID = "dddddddd-1111-4222-8333-444455556666";
const DECISION_B_ID = "dddddddd-2222-4222-8333-444455556666";
const B_MARKER = "TENANT-B-PRIVATE-STEP-TITLE";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Filter = { op: "eq" | "in"; col: string; val: unknown };
  type Read = { table: string; tenant: string; columns: string; filters: Filter[]; limit: number | null; offset: number };

  const store: Record<string, Row[]> = {
    channel_runs: [],
    channel_actions: [],
    channel_action_events: [],
    decisions: [],
    email_bulk_sends: [],
    email_send_results: [],
    social_posts: [],
  };
  const reads: Read[] = [];
  const REGISTERED = new Set(Object.keys(store));
  const errors: Record<string, string | null> = {};

  function cmp(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    return a < b ? -1 : 1;
  }

  function scoped(table: string, tenant: string) {
    if (!REGISTERED.has(table)) throw new Error(`tenantClient: '${table}' is not registered`);
    const read: Read = { table, tenant, columns: "", filters: [{ op: "eq", col: "tenant_id", val: tenant }], limit: null, offset: 0 };
    const orders: Array<{ col: string; asc: boolean }> = [];

    const builder = {
      select(columns: string) {
        read.columns = columns;
        reads.push(read);
        return builder;
      },
      eq(col: string, val: unknown) {
        read.filters.push({ op: "eq", col, val });
        return builder;
      },
      in(col: string, val: unknown[]) {
        read.filters.push({ op: "in", col, val });
        return builder;
      },
      is(col: string, val: unknown) {
        read.filters.push({ op: "eq", col, val });
        return builder;
      },
      gte(col: string, val: unknown) {
        read.filters.push({ op: "in", col, val: store[table].map((r) => r[col]).filter((v) => typeof v === "string" && v >= (val as string)) });
        return builder;
      },
      lte(col: string, val: unknown) {
        read.filters.push({ op: "in", col, val: store[table].map((r) => r[col]).filter((v) => typeof v === "string" && v <= (val as string)) });
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orders.push({ col, asc: opts?.ascending !== false });
        return builder;
      },
      limit(n: number) {
        read.limit = n;
        return builder;
      },
      range(from: number, to: number) {
        read.offset = from;
        read.limit = to - from + 1;
        return builder;
      },
      then(
        resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
        reject?: (e: unknown) => unknown,
      ) {
        try {
          if (errors[table]) return resolve({ data: null, error: { message: errors[table] as string } });
          let rows = store[table].filter((r) =>
            read.filters.every((f) =>
              f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]),
            ),
          );
          for (let i = orders.length - 1; i >= 0; i -= 1) {
            const { col, asc } = orders[i];
            rows = [...rows].sort((x, y) => (asc ? cmp(x[col], y[col]) : cmp(y[col], x[col])));
          }
          if (read.limit !== null) rows = rows.slice(read.offset, read.offset + read.limit);
          const cols = read.columns.split(",").map((c) => c.trim()).filter(Boolean);
          const pick = (r: Row, c: string): [string, unknown] => {
            const m = c.match(/^(\w+):(\w+)((?:->>?\w+)+)$/);
            if (!m) return [c, r[c] ?? null];
            let v: unknown = r[m[2]];
            for (const k of m[3].split(/->>?/).filter(Boolean)) v = v && typeof v === "object" ? (v as Row)[k] : undefined;
            return [m[1], v ?? null];
          };
          return resolve({ data: rows.map((r) => Object.fromEntries(cols.map((c) => pick(r, c)))), error: null });
        } catch (e) {
          return reject ? reject(e) : Promise.reject(e);
        }
      },
    };
    return builder;
  }

  let auth: { tenant_id: string; user_id: string; access_token: string } | null = null;

  const sendStates: Array<{ facts: unknown; state: { status: string; failure_reason: string | null } }> = [];

  return {
    store,
    reads,
    errors,
    sendStates,
    tenantClient: vi.fn((tid: string) => ({ from: (table: string) => scoped(table, tid) })),
    requireAuth: vi.fn(async (_req: Request, res: Response) => {
      if (auth) return auth;
      res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
      return null;
    }),
    setAuth(tenantId: string | null) {
      auth = tenantId ? { tenant_id: tenantId, user_id: "u-1", access_token: "tok" } : null;
    },
    reset() {
      for (const k of Object.keys(store)) store[k].length = 0;
      for (const k of Object.keys(errors)) delete errors[k];
      reads.length = 0;
      sendStates.length = 0;
    },
    matchesUnpinned(runIds: string[]) {
      return store.decisions.filter(
        (d) =>
          runIds.includes(d.agent_run_id as string) &&
          d.status === "archived" &&
          d.decision_class === "channel.recipe_step",
      );
    },
  };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: h.tenantClient,
}));

vi.mock("@/services/email-cards/cards", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/email-cards/cards")>();
  return {
    ...real,
    cardSendState: vi.fn((...args: Parameters<typeof real.cardSendState>) => {
      const state = real.cardSendState(...args);
      h.sendStates.push({ facts: args[2], state });
      return state;
    }),
  };
});

import * as historyModule from "../../routes/channels/history";
import { channelHistoryGet } from "../../routes/channels/history";
import { AD_CHANGE_HEADLINE_FIELDS } from "@zavi/shared";
import { stalledSendNote } from "@/services/email-cards/recovery";
import { stopNoteOf } from "@/services/email-results/view";

function res() {
  const r = {
    _status: 200,
    _body: undefined as unknown,
    status(n: number) {
      r._status = n;
      return r;
    },
    json(b: unknown) {
      r._body = b;
      return r;
    },
  };
  return r;
}

const call = async (slug = SLUG) => {
  const r = res();
  await channelHistoryGet({ params: { slug } } as unknown as Request, r as unknown as Response);
  return r;
};

const stepBody = (title: string, position: number, of: number) => ({
  step: { title, why: "spend is up and conversions are flat", how: ["pause the ad group"], effort: "low" },
  position,
  of,
  rendered_markdown: "## what to do\n\n...",
  action_key: "9f1c2b3a4d5e6f70",
});

function seedTenantA() {
  h.store.channel_runs.push(
    {
      tenant_id: TENANT_A,
      channel_slug: SLUG,
      run_id: RUN_A,
      executor: "google_ads",
      trigger: "schedule",
      status: "succeeded",
      enqueued_at: "2026-09-18T10:00:00Z",
      started_at: "2026-09-18T10:00:05Z",
      finished_at: "2026-09-18T10:04:00Z",
      redo_of_action_id: null,
      cost_usd: 4.21,
    },
    {
      tenant_id: TENANT_A,
      channel_slug: SLUG,
      run_id: RUN_A_OLDER,
      executor: "google_ads",
      trigger: "manual",
      status: "failed",
      enqueued_at: "2026-09-10T10:00:00Z",
      started_at: "2026-09-10T10:00:05Z",
      finished_at: "2026-09-10T10:01:00Z",
      redo_of_action_id: null,
      cost_usd: 0.4,
    },
    {
      tenant_id: TENANT_A,
      channel_slug: "reddit_organic",
      run_id: "33333333-aaaa-4bbb-8ccc-dddddddddddd",
      executor: "reddit_organic",
      trigger: "schedule",
      status: "succeeded",
      enqueued_at: "2026-09-19T10:00:00Z",
      started_at: null,
      finished_at: null,
      redo_of_action_id: null,
      cost_usd: 1,
    },
  );

  h.store.decisions.push(
    {
      id: DECISION_A_ID,
      tenant_id: TENANT_A,
      agent_run_id: RUN_A,
      decision_class: "channel.recipe_step",
      status: "archived",
      emitted_at: "2026-09-18T10:03:00Z",
      archived_at: "2026-09-19T00:00:00Z",
      body: stepBody("Pause the three ad groups spending with no conversions", 1, 3),
    },
    {
      id: DECISION_B_ID,
      tenant_id: TENANT_B,
      agent_run_id: RUN_A,
      decision_class: "channel.recipe_step",
      status: "archived",
      emitted_at: "2026-09-18T10:03:00Z",
      archived_at: "2026-09-19T00:00:00Z",
      body: stepBody(B_MARKER, 1, 1),
    },
  );

  h.store.channel_actions.push(
    {
      id: "aaaaaaaa-1111-4222-8333-444455556666",
      tenant_id: TENANT_A,
      channel_slug: SLUG,
      run_id: RUN_A,
      position: 1,
      run_of: 2,
      action_type: "pause_ad_group",
      title: "Pause Brand — Exact",
      status: "acted",
      status_at: "2026-09-19T01:00:00Z",
      note: "done",
      proposed_at: "2026-09-18T10:03:00Z",
      impact: "high",
      impact_reason: "7% of spend",
      score: 82,
      body: { deliverable: "SHOULD-NOT-BE-SERVED-closed-body" },
      edited_body: { deliverable: "SHOULD-NOT-BE-SERVED-edited" },
      exec_payload: { secret: "SHOULD-NOT-BE-SERVED-exec" },
    },
    {
      id: "aaaaaaaa-2222-4222-8333-444455556666",
      tenant_id: TENANT_A,
      channel_slug: SLUG,
      run_id: RUN_A,
      position: 2,
      run_of: 2,
      action_type: "add_negative",
      title: "Add 11 negatives",
      status: "rejected",
      status_at: "2026-09-19T02:00:00Z",
      note: null,
      proposed_at: "2026-09-18T10:03:00Z",
      impact: "medium",
      impact_reason: null,
      score: 51,
      body: null,
    },
    { ...openAction("PENDING-must-not-appear", "pending", "aaaaaaaa-3333-4222-8333-444455556666") },
    { ...openAction("SNOOZED-must-not-appear", "snoozed", "aaaaaaaa-4444-4222-8333-444455556666") },
  );
}

function openAction(title: string, status: string, id: string) {
  return {
    id,
    tenant_id: TENANT_A,
    channel_slug: SLUG,
    run_id: RUN_A,
    position: 3,
    run_of: 4,
    action_type: "raise_budget",
    title,
    status,
    status_at: null,
    note: null,
    proposed_at: "2026-09-18T10:03:00Z",
    impact: "low",
    impact_reason: null,
    score: 10,
    body: null,
  };
}

const readOf = (table: string) => h.reads.filter((r) => r.table === table);

beforeEach(() => {
  h.reset();
  h.tenantClient.mockClear();
  h.requireAuth.mockClear();
  h.setAuth(TENANT_A);
});

describe("tenant pinning on BOTH sides of the pre_switch join", () => {
  it("fixture check: the unpinned predicate really does match two tenants' rows", () => {
    seedTenantA();
    const unpinned = h.matchesUnpinned([RUN_A, RUN_A_OLDER]);
    expect(unpinned).toHaveLength(2);
    expect(unpinned.map((d) => d.tenant_id).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });

  it("serves the caller's decision and NOT the other tenant's row on the same run id", async () => {
    seedTenantA();
    const r = await call();
    expect(r._status).toBe(200);
    const body = r._body as { pre_switch: Array<{ title: string | null; run_id: string | null }> };
    expect(body.pre_switch).toHaveLength(1);
    expect(body.pre_switch[0].title).toBe("Pause the three ad groups spending with no conversions");
    expect(body.pre_switch[0].run_id).toBe(RUN_A);
    expect(JSON.stringify(r._body)).not.toContain(B_MARKER);
    expect(JSON.stringify(r._body)).not.toContain(TENANT_B);
  });

  it("pins the runs read AND the decisions read to the authenticated tenant, separately", async () => {
    seedTenantA();
    await call();
    for (const tid of h.tenantClient.mock.calls.map((c) => c[0])) expect(tid).toBe(TENANT_A);
    for (const table of ["channel_runs", "channel_actions", "decisions"]) {
      const reads = readOf(table);
      expect(reads.length, `${table} was never read`).toBeGreaterThan(0);
      for (const read of reads) {
        expect(read.tenant).toBe(TENANT_A);
        expect(read.filters).toContainEqual({ op: "eq", col: "tenant_id", val: TENANT_A });
      }
    }
  });

  it("a caller from the other tenant gets its own row and never the first tenant's", async () => {
    seedTenantA();
    h.store.channel_runs.push({
      tenant_id: TENANT_B,
      channel_slug: SLUG,
      run_id: RUN_A,
      executor: "google_ads",
      trigger: "schedule",
      status: "succeeded",
      enqueued_at: "2026-09-18T09:00:00Z",
      started_at: null,
      finished_at: null,
      redo_of_action_id: null,
      cost_usd: 9,
    });
    h.setAuth(TENANT_B);
    const r = await call();
    const body = r._body as { pre_switch: Array<{ title: string | null }> };
    expect(body.pre_switch).toHaveLength(1);
    expect(body.pre_switch[0].title).toBe(B_MARKER);
    expect(JSON.stringify(r._body)).not.toContain("Pause the three ad groups");
  });
});

describe("decisions.id is never served", () => {
  it("no pre_switch row carries an id, and the decision id is nowhere in the response", async () => {
    seedTenantA();
    const r = await call();
    const body = r._body as { pre_switch: Array<Record<string, unknown>> };
    expect(body.pre_switch.length).toBeGreaterThan(0);
    for (const row of body.pre_switch) {
      expect(Object.keys(row)).not.toContain("id");
      expect(Object.keys(row)).not.toContain("decision_id");
    }
    expect(JSON.stringify(r._body)).not.toContain(DECISION_A_ID);
  });

  it("the SELECT itself never asks for it — read-only by withholding the key, not by trusting the UI", async () => {
    seedTenantA();
    await call();
    const [decisions] = readOf("decisions");
    expect(decisions).toBeDefined();
    const cols = decisions.columns.split(",").map((c) => c.trim());
    expect(cols).not.toContain("id");
    expect(cols).toContain("agent_run_id");
  });
});

describe("the pre_switch title comes from body.step.title", () => {
  it("lifts the nested title rather than a top-level body.title", async () => {
    seedTenantA();
    const row = h.store.decisions.find((d) => d.id === DECISION_A_ID) as { body: Record<string, unknown> };
    expect(row.body).not.toHaveProperty("title");
    const r = await call();
    const body = r._body as { pre_switch: Array<{ title: string | null; position: number | null; of: number | null }> };
    expect(body.pre_switch[0].title).toBe("Pause the three ad groups spending with no conversions");
    expect(body.pre_switch[0].position).toBe(1);
    expect(body.pre_switch[0].of).toBe(3);
  });

  it("degrades an unparseable body to a null title, never a 500", async () => {
    seedTenantA();
    for (const bad of [null, "not-an-object", 7, { step: "a string" }, { step: { title: 42 } }, {}]) {
      h.reset();
      h.setAuth(TENANT_A);
      seedTenantA();
      (h.store.decisions.find((d) => d.id === DECISION_A_ID) as Record<string, unknown>).body = bad;
      const r = await call();
      expect(r._status, `body=${JSON.stringify(bad)}`).toBe(200);
      const body = r._body as { pre_switch: Array<{ title: string | null; run_id: string | null }> };
      expect(body.pre_switch).toHaveLength(1);
      expect(body.pre_switch[0].title).toBeNull();
      expect(body.pre_switch[0].run_id).toBe(RUN_A);
    }
  });
});

describe("closed is the complement of open, and carries no payload", () => {
  it("filters on exactly the terminal statuses, displaced included", async () => {
    seedTenantA();
    await call();
    const [actions] = readOf("channel_actions");
    const statusIn = actions.filters.find((f) => f.op === "in" && f.col === "status");
    expect(statusIn, "channel_actions is not filtered on status at all").toBeDefined();
    expect([...(statusIn!.val as string[])].sort()).toEqual([
      "acted",
      "displaced",
      "redone",
      "rejected",
      "stale",
    ]);
    expect(statusIn!.val).not.toContain("archived");
  });

  it("shows the founder's click, not an execution error left on the card", async () => {
    seedTenantA();
    const acted = "aaaaaaaa-1111-4222-8333-444455556666";
    const row = h.store.channel_actions.find((a) => a.id === acted);
    if (row) row.note = "Google said no";
    h.store.channel_action_events.push({
      tenant_id: TENANT_A,
      action_id: acted,
      event: "acted",
      note: null,
      at: "2026-09-19T01:00:00Z",
      snoozed_until: null,
    });
    const r = await call();
    const body = r._body as { closed: Array<{ id: string; note: string | null }> };
    expect(body.closed.find((a) => a.id === acted)?.note).toBeNull();
  });

  it("returns the acted and rejected rows and neither the pending nor the snoozed one", async () => {
    seedTenantA();
    expect(h.store.channel_actions.filter((a) => a.status === "pending" || a.status === "snoozed")).toHaveLength(2);
    const r = await call();
    const body = r._body as { closed: Array<{ status: string; title: string }> };
    expect(body.closed.map((a) => a.status).sort()).toEqual(["acted", "rejected"]);
    expect(JSON.stringify(body.closed)).not.toContain("PENDING-must-not-appear");
    expect(JSON.stringify(body.closed)).not.toContain("SNOOZED-must-not-appear");
  });

  it("serves neither an action's body nor the run's cost_usd", async () => {
    seedTenantA();
    const r = await call();
    const body = r._body as { runs: Array<Record<string, unknown>>; closed: Array<Record<string, unknown>> };
    for (const row of body.closed) {
      expect(Object.keys(row)).not.toContain("body");
      expect(Object.keys(row)).not.toContain("edited_body");
      expect(Object.keys(row)).not.toContain("exec_payload");
    }
    for (const row of body.runs) expect(Object.keys(row)).not.toContain("cost_usd");
    const json = JSON.stringify(r._body);
    expect(json).not.toContain("SHOULD-NOT-BE-SERVED");
    expect(json).not.toContain("4.21");
    for (const table of ["channel_runs", "channel_actions"]) {
      for (const read of readOf(table)) {
        expect(read.columns).not.toContain("cost_usd");
        expect(read.columns).not.toContain("body");
        const cols = read.columns.split(",").map((c: string) => c.trim());
        expect(cols).not.toContain("exec_payload");
        for (const c of cols.filter((x: string) => x.includes("exec_payload"))) {
          expect(c).toMatch(/^hl_[a-z_]+:exec_payload->[a-z_]+$/);
          expect((AD_CHANGE_HEADLINE_FIELDS as readonly string[]).includes(c.split("->")[1])).toBe(true);
        }
      }
    }
  });

  it("scopes the closed read to this channel", async () => {
    seedTenantA();
    const r = await call();
    const body = r._body as { runs: Array<{ executor: string }> };
    expect(body.runs.every((run) => run.executor === "google_ads")).toBe(true);
    expect(JSON.stringify(r._body)).not.toContain("reddit_organic");
  });
});

describe("empty is not an error", () => {
  it("a channel that never ran answers 200 with three PRESENT, empty arrays", async () => {
    const r = await call();
    expect(r._status).toBe(200);
    const body = r._body as Record<string, unknown>;
    for (const key of ["runs", "closed", "pre_switch"]) {
      expect(Object.keys(body), `${key} is missing from the envelope`).toContain(key);
      expect(body[key]).toEqual([]);
    }
  });

  it("reads decisions scoped to the tenant, not narrowed to a window of recent runs", async () => {
    await call();
    const reads = readOf("decisions");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(r.tenant, "a decisions read must be tenant-scoped").toBe(TENANT_A);
      const byRunId = r.filters.some(
        (f) => JSON.stringify(f).includes("run_id") && JSON.stringify(f).includes("in"),
      );
      expect(byRunId, "pre_switch must not be gated on a recency window of runs").toBe(false);
    }
  });

  it("runs with no archived decisions still answer 200 with an empty pre_switch", async () => {
    seedTenantA();
    h.store.decisions.length = 0;
    const r = await call();
    expect(r._status).toBe(200);
    const body = r._body as { runs: unknown[]; pre_switch: unknown[] };
    expect(body.runs.length).toBeGreaterThan(0);
    expect(body.pre_switch).toEqual([]);
  });

  it("a read failure is a 500 with no store detail on the wire", async () => {
    seedTenantA();
    h.errors.channel_actions = "permission denied for relation channel_actions";
    const r = await call();
    expect(r._status).toBe(500);
    expect(r._body).toEqual({ error: { code: "read_failed", message: "Could not read history." } });
    expect(JSON.stringify(r._body)).not.toContain("permission denied");
  });
});

describe("auth, slug, and the shape of the module", () => {
  it("401s without auth and never touches the store", async () => {
    h.setAuth(null);
    const r = await call();
    expect(r._status).toBe(401);
    expect(h.tenantClient).not.toHaveBeenCalled();
    expect(h.reads).toHaveLength(0);
  });

  it("404s an unknown slug, before any read", async () => {
    const r = await call("not_a_channel");
    expect(r._status).toBe(404);
    expect(r._body).toEqual({ error: { code: "unknown_channel", message: "Unknown channel." } });
    expect(h.reads).toHaveLength(0);
  });

  it("exports exactly one handler and no write verb", () => {
    const exported = Object.keys(historyModule).sort();
    expect(exported).toEqual(["channelHistoryGet"]);
    expect(typeof historyModule.channelHistoryGet).toBe("function");
    for (const name of exported) {
      expect(name).not.toMatch(/post|put|patch|delete|set|approve|act|redo|reject|snooze|create|update/i);
    }
  });
});

describe("email sends from the decisions rail show in email_marketing history (B8)", () => {
  const EMAIL = "email_marketing";
  const SENT_ID = "eeeeeeee-1111-4222-8333-444455556666";
  const REJECTED_ID = "eeeeeeee-2222-4222-8333-444455556666";
  const IN_FLIGHT_ID = "eeeeeeee-3333-4222-8333-444455556666";
  const OTHER_TENANT_ID = "eeeeeeee-4444-4222-8333-444455556666";
  const NON_EMAIL_ID = "eeeeeeee-5555-4222-8333-444455556666";
  const ACTION_ID = "eeeeeeee-6666-4222-8333-444455556666";

  function seedEmail() {
    h.store.decisions.push(
      {
        id: SENT_ID,
        tenant_id: TENANT_A,
        agent_run_id: RUN_A,
        decision_class: "bulk_outbound.send",
        status: "acted",
        emitted_at: "2026-10-20T09:00:00Z",
        dispatched_at: "2026-10-21T09:00:00Z",
        rejected_at: null,
        archived_at: null,
        body: {
          list_id: "11111111-2222-4333-8444-555566667777",
          list_name: "Spring buyers",
          chosen_variant: 2,
          variants: [
            { content: { subject: "Version one subject", paragraphs: ["BODY-NOT-SERVED-1"] } },
            { content: { subject: "Spring sale is live", paragraphs: ["BODY-NOT-SERVED-2"] } },
          ],
        },
      },
      {
        id: REJECTED_ID,
        tenant_id: TENANT_A,
        agent_run_id: null,
        decision_class: "email_campaign.create_and_send",
        status: "rejected",
        emitted_at: "2026-10-18T09:00:00Z",
        dispatched_at: null,
        rejected_at: "2026-10-19T09:00:00Z",
        archived_at: null,
        body: { tool: "klaviyo", subject: "Tool text subject", body_text: "BODY-NOT-SERVED-3", preview_text: "p" },
      },
      {
        id: IN_FLIGHT_ID,
        tenant_id: TENANT_A,
        agent_run_id: null,
        decision_class: "bulk_outbound.send",
        status: "dispatching",
        emitted_at: "2026-10-22T09:00:00Z",
        dispatched_at: "2026-10-22T09:05:00Z",
        rejected_at: null,
        archived_at: null,
        body: { template: { subject: "IN-FLIGHT-MUST-NOT-APPEAR", body_text: "x" } },
      },
      {
        id: OTHER_TENANT_ID,
        tenant_id: TENANT_B,
        agent_run_id: null,
        decision_class: "bulk_outbound.send",
        status: "acted",
        emitted_at: "2026-10-22T09:00:00Z",
        dispatched_at: "2026-10-22T10:00:00Z",
        rejected_at: null,
        archived_at: null,
        body: { template: { subject: "TENANT-B-PRIVATE-SUBJECT", body_text: "x" } },
      },
      {
        id: NON_EMAIL_ID,
        tenant_id: TENANT_A,
        agent_run_id: null,
        decision_class: "google_ads.budget_change",
        status: "acted",
        emitted_at: "2026-10-22T09:00:00Z",
        dispatched_at: "2026-10-22T10:00:00Z",
        rejected_at: null,
        archived_at: null,
        body: { subject: "NON-EMAIL-MUST-NOT-APPEAR" },
      },
    );
    h.store.email_bulk_sends.push({
      tenant_id: TENANT_A,
      decision_id: SENT_ID,
      status: "done",
      hold_reason: null,
      total: 120,
      sent: 120,
      skipped: 0,
      failed: 0,
      unknown: 0,
      hard_bounces: 0,
      finished_at: "2026-10-21T09:30:00Z",
    });
    h.store.channel_actions.push({
      id: ACTION_ID,
      tenant_id: TENANT_A,
      channel_slug: EMAIL,
      run_id: RUN_A,
      position: 1,
      run_of: 1,
      action_type: "send_message",
      title: "Channel card email",
      status: "acted",
      status_at: "2026-10-20T12:00:00Z",
      note: null,
      proposed_at: "2026-10-20T08:00:00Z",
      impact: null,
      impact_reason: null,
      score: 40,
    });
  }

  it("serves the acted and rejected email-send decisions in closed, merged by when they closed", async () => {
    seedEmail();
    const r = await call(EMAIL);
    expect(r._status).toBe(200);
    const closed = (r._body as { closed: Array<Record<string, unknown>> }).closed;
    expect(closed.map((c) => c.id)).toEqual([SENT_ID, ACTION_ID, REJECTED_ID]);
    expect(closed[0]).toEqual({
      id: SENT_ID,
      run_id: RUN_A,
      position: null,
      run_of: null,
      action_type: "send_message",
      title: "Spring sale is live",
      status: "acted",
      status_at: "2026-10-21T09:00:00Z",
      note: null,
      proposed_at: "2026-10-20T09:00:00Z",
      impact: null,
      impact_reason: null,
      score: null,
      sent: { count: 120, list: "Spring buyers", tool: "zavi_list", at: "2026-10-21T09:30:00Z" },
      outcome: { status: "sent", sent: 120, total: 120, unknown: 0, may_have_sent: false, reason: null, pause_hold: null },
    });
    expect(closed[2]).toMatchObject({ title: "Tool text subject", status: "rejected", status_at: "2026-10-19T09:00:00Z", outcome: { status: "rejected", sent: null, may_have_sent: false } });
    expect(closed[2].sent).toBeUndefined();
  });

  it("leaves out another tenant's send, a non-email class, an in-flight send, and every body", async () => {
    seedEmail();
    const r = await call(EMAIL);
    const wire = JSON.stringify(r._body);
    for (const marker of ["TENANT-B-PRIVATE-SUBJECT", "NON-EMAIL-MUST-NOT-APPEAR", "IN-FLIGHT-MUST-NOT-APPEAR", "BODY-NOT-SERVED", OTHER_TENANT_ID, NON_EMAIL_ID, IN_FLIGHT_ID]) {
      expect(wire).not.toContain(marker);
    }
    for (const read of readOf("decisions")) {
      expect(read.tenant).toBe(TENANT_A);
      expect(read.filters).toContainEqual({ op: "eq", col: "tenant_id", val: TENANT_A });
    }
  });

  it("a caller from the other tenant sees only its own send", async () => {
    seedEmail();
    h.setAuth(TENANT_B);
    const r = await call(EMAIL);
    const closed = (r._body as { closed: Array<Record<string, unknown>> }).closed;
    expect(closed.map((c) => c.id)).toEqual([OTHER_TENANT_ID]);
    expect(closed[0].title).toBe("TENANT-B-PRIVATE-SUBJECT");
  });

  it("another channel's history is unchanged and does not read email sends", async () => {
    seedTenantA();
    const before = await call(SLUG);
    h.reads.length = 0;
    seedEmail();
    const after = await call(SLUG);
    expect(after._body).toEqual(before._body);
    expect(readOf("email_bulk_sends")).toHaveLength(0);
    expect(readOf("decisions")).toHaveLength(1);
    expect(readOf("decisions")[0].filters).toContainEqual({ op: "eq", col: "decision_class", val: "channel.recipe_step" });
  });

  const ACTED_ID = (n: number) => `eeeeeeee-7777-4222-8333-44445555${String(n).padStart(4, "0")}`;
  const SYSTEM_REJECTED_ID = "eeeeeeee-8888-4222-8333-444455556666";

  function actedBulk(n: number, bulk: Record<string, unknown> | null, cls = "bulk_outbound.send") {
    const id = ACTED_ID(n);
    h.store.decisions.push({
      id,
      tenant_id: TENANT_A,
      agent_run_id: null,
      decision_class: cls,
      status: "acted",
      emitted_at: `2026-10-22T0${n}:00:00Z`,
      dispatched_at: `2026-10-22T0${n}:10:00Z`,
      rejected_at: null,
      archived_at: null,
      dispatch_error: null,
      body: { template: { subject: `ACTED-SUBJECT-${n}`, body_text: "x" } },
    });
    if (bulk) {
      h.store.email_bulk_sends.push({
        tenant_id: TENANT_A,
        decision_id: id,
        hold_reason: null,
        total: 10,
        sent: 0,
        skipped: 0,
        failed: 0,
        unknown: 0,
        hard_bounces: 0,
        finished_at: null,
        ...bulk,
      });
    }
    return id;
  }

  const closedIds = async () => ((await call(EMAIL))._body as { closed: Array<{ id: string }> }).closed.map((c) => c.id);

  it("an acted send whose bulk send was held for a pause or an unverified sender, or failed, is not served as done", async () => {
    seedEmail();
    const paused = actedBulk(1, { status: "held", hold_reason: "email_paused" });
    const unverified = actedBulk(2, { status: "held", hold_reason: "sender_unverified" });
    const stopped = actedBulk(3, { status: "held", hold_reason: "stopped" });
    const failed = actedBulk(4, { status: "failed", hold_reason: "provider_error" });
    const sending = actedBulk(5, { status: "sending", sent: 3 });
    const ids = await closedIds();
    for (const id of [paused, unverified, stopped, failed, sending]) expect(ids).not.toContain(id);
    expect(ids).toEqual([SENT_ID, ACTION_ID, REJECTED_ID]);
  });

  it("an acted send that finished with nobody sent or an unknown outcome is not served, a partly-sent one that reached people is", async () => {
    seedEmail();
    const none = actedBulk(1, { status: "done", sent: 0, skipped: 10 });
    const unknown = actedBulk(2, { status: "done", sent: 0, unknown: 10 });
    const partial = actedBulk(3, { status: "done", sent: 6, failed: 4 });
    const partialUnknown = actedBulk(4, { status: "done", sent: 7, unknown: 3 });
    const ids = await closedIds();
    for (const id of [none, unknown]) expect(ids).not.toContain(id);
    expect(ids).toEqual([partialUnknown, partial, SENT_ID, ACTION_ID, REJECTED_ID]);
  });

  it("a send Zavi stopped for good after it reached people, with some outcomes unconfirmed, is served; one that reached nobody confirmed is not", async () => {
    seedEmail();
    const reached = actedBulk(1, { status: "held", hold_reason: "provider_error", sent: 7, unknown: 3 });
    const nobody = actedBulk(2, { status: "held", hold_reason: "provider_error", sent: 0, unknown: 10 });
    const ids = await closedIds();
    expect(ids).not.toContain(nobody);
    expect(ids).toEqual([reached, SENT_ID, ACTION_ID, REJECTED_ID]);
  });

  it("an acted send that really sent is served, and the bulk read is pinned to the caller and to the acted ids", async () => {
    seedEmail();
    const sent = actedBulk(6, { status: "done", sent: 10, finished_at: "2026-10-22T06:20:00Z" });
    const tool = actedBulk(7, null, "email_campaign.create_and_send");
    const ids = await closedIds();
    expect(ids).toEqual([tool, sent, SENT_ID, ACTION_ID, REJECTED_ID]);
    const reads = readOf("email_bulk_sends");
    expect(reads).toHaveLength(1);
    expect(reads[0].tenant).toBe(TENANT_A);
    expect(reads[0].filters).toContainEqual({ op: "eq", col: "tenant_id", val: TENANT_A });
    const inFilter = reads[0].filters.find((f) => f.op === "in" && f.col === "decision_id");
    expect([...((inFilter?.val as string[]) ?? [])].sort()).toEqual([SENT_ID, sent, tool].sort());
  });

  it("a rejected send carrying a dispatch_error is a system failure and is left out; a founder rejection stays", async () => {
    seedEmail();
    h.store.decisions.push({
      id: SYSTEM_REJECTED_ID,
      tenant_id: TENANT_A,
      agent_run_id: null,
      decision_class: "bulk_outbound.send",
      status: "rejected",
      emitted_at: "2026-10-22T09:00:00Z",
      dispatched_at: "2026-10-22T09:05:00Z",
      rejected_at: null,
      archived_at: null,
      dispatch_error: "sender_unverified",
      body: { template: { subject: "SYSTEM-REJECTED-SUBJECT", body_text: "x" } },
    });
    const r = await call(EMAIL);
    const closed = (r._body as { closed: Array<Record<string, unknown>> }).closed;
    expect(closed.map((c) => c.id)).toEqual([SENT_ID, ACTION_ID, REJECTED_ID]);
    expect(JSON.stringify(r._body)).not.toContain("SYSTEM-REJECTED-SUBJECT");
    expect(closed[2]).toMatchObject({ id: REJECTED_ID, status: "rejected", status_at: "2026-10-19T09:00:00Z" });
  });

  it("older real sends are not hidden behind 50+ newer held or failed ones: the read pages until it has enough", async () => {
    seedEmail();
    for (let i = 0; i < 120; i++) {
      const id = `eeeeeeee-9999-4222-8333-4444${String(i).padStart(8, "0")}`;
      h.store.decisions.push({
        id,
        tenant_id: TENANT_A,
        agent_run_id: null,
        decision_class: "bulk_outbound.send",
        status: "acted",
        emitted_at: `2026-10-23T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
        dispatched_at: "2026-10-23T12:00:00Z",
        rejected_at: null,
        archived_at: null,
        dispatch_error: null,
        body: { template: { subject: `HELD-${i}`, body_text: "x" } },
      });
      h.store.email_bulk_sends.push({ tenant_id: TENANT_A, decision_id: id, status: "held", hold_reason: "email_paused", total: 10, sent: 0, skipped: 0, failed: 0, unknown: 0, hard_bounces: 0, finished_at: null });
    }
    const ids = await closedIds();
    expect(ids).toEqual([SENT_ID, ACTION_ID, REJECTED_ID]);
    const reads = readOf("decisions").filter((r) => r.filters.some((f) => f.col === "decision_class" && f.op === "in"));
    expect(reads.length).toBeGreaterThan(1);
    for (const r of [...reads, ...readOf("email_bulk_sends")]) {
      expect(r.tenant).toBe(TENANT_A);
      expect(r.filters).toContainEqual({ op: "eq", col: "tenant_id", val: TENANT_A });
    }
  });

  it("the paging stops at the scan bound and never serves more than the closed list holds", async () => {
    for (let i = 0; i < 1200; i++) {
      const id = `eeeeeeee-aaaa-4222-8333-4444${String(i).padStart(8, "0")}`;
      h.store.decisions.push({
        id,
        tenant_id: TENANT_A,
        agent_run_id: null,
        decision_class: "bulk_outbound.send",
        status: "acted",
        emitted_at: `2026-10-${String(1 + Math.floor(i / 60)).padStart(2, "0")}T00:${String(i % 60).padStart(2, "0")}:00Z`,
        dispatched_at: null,
        rejected_at: null,
        archived_at: null,
        dispatch_error: null,
        body: {},
      });
      h.store.email_bulk_sends.push({ tenant_id: TENANT_A, decision_id: id, status: "held", hold_reason: "email_paused", total: 1, sent: 0, skipped: 0, failed: 0, unknown: 0, hard_bounces: 0, finished_at: null });
    }
    const r = await call(EMAIL);
    expect(r._status).toBe(200);
    const pages = readOf("decisions").filter((x) => x.filters.some((f) => f.col === "decision_class" && f.op === "in"));
    expect(pages).toHaveLength(10);
  });

  it("a send whose sender stalled after reaching some of the list is served as partly sent, with how many were not emailed (818d)", async () => {
    seedEmail();
    const stalled = actedBulk(1, { status: "held", hold_reason: "fanout_stalled", sent: 1, unknown: 0, total: 3 });
    const r = await call(EMAIL);
    expect(r._status).toBe(200);
    const closed = (r._body as { closed: Array<Record<string, unknown>> }).closed;
    expect(closed.map((c) => c.id)).toEqual([stalled, SENT_ID, ACTION_ID, REJECTED_ID]);
    expect(closed[0]).toMatchObject({ title: "ACTED-SUBJECT-1", status: "acted" });
    const seen = h.sendStates.find((x) => (x.facts as { bulk?: { hold_reason?: string } } | null)?.bulk?.hold_reason === "fanout_stalled");
    expect(seen?.state.status).toBe("partially_sent");
    expect(seen?.state.failure_reason).toBe(stalledSendNote(1, 3));
    expect(seen?.state.failure_reason).toContain("2 of the 3 people on the list were not emailed");
  });

  it("a held Zavi-list send that reached 1 of 3 serves the stop, the total and the Overview's stop note on its sent block; a done send carries none (817d)", async () => {
    seedEmail();
    const held = actedBulk(1, { status: "held", hold_reason: "fanout_stalled", sent: 1, unknown: 0, total: 3, finished_at: "2026-10-22T01:20:00Z" });
    const done = actedBulk(2, { status: "done", sent: 3, total: 3, finished_at: "2026-10-22T02:20:00Z" });
    for (const id of [held, done]) h.store.decisions.find((d) => d.id === id)!.body = { list_name: "QA tiny list", template: { subject: "New pumpkin spice cupcakes", body_text: "BODY-NOT-SERVED-817d" } };
    const r = await call(EMAIL);
    expect(r._status).toBe(200);
    const closed = (r._body as { closed: Array<Record<string, unknown>> }).closed;
    const heldRow = closed.find((c) => c.id === held)!;
    expect(heldRow.sent).toEqual({ count: 1, total: 3, stopped: true, note: stalledSendNote(1, 3), list: "QA tiny list", tool: "zavi_list", at: expect.anything() });
    expect((heldRow.sent as { note: string }).note).toContain("2 of the 3 people on the list were not emailed");
    const doneRow = closed.find((c) => c.id === done)!;
    expect(doneRow.sent).toEqual({ count: 3, list: "QA tiny list", tool: "zavi_list", at: "2026-10-22T02:20:00Z" });
    expect(doneRow.sent).not.toHaveProperty("stopped");
    expect(doneRow.sent).not.toHaveProperty("total");
    expect(JSON.stringify(r._body)).not.toContain("BODY-NOT-SERVED-817d");
    for (const read of readOf("email_bulk_sends")) expect(read.filters).toContainEqual({ op: "eq", col: "tenant_id", val: TENANT_A });
  });

  it("a Zavi-list send the founder stopped after 1 of 3 shows in Done with the stop, the total and the Overview's own stop note (81b9)", async () => {
    seedEmail();
    const stopped = actedBulk(1, { status: "held", hold_reason: "stopped", sent: 1, unknown: 0, total: 3, finished_at: "2026-10-22T01:20:00Z" });
    h.store.decisions.find((d) => d.id === stopped)!.body = { list_name: "QA tiny list", template: { subject: "New pumpkin spice cupcakes", body_text: "BODY-NOT-SERVED-81b9" } };
    const r = await call(EMAIL);
    expect(r._status).toBe(200);
    const closed = (r._body as { closed: Array<Record<string, unknown>> }).closed;
    expect(closed.map((c) => c.id)).toEqual([stopped, SENT_ID, ACTION_ID, REJECTED_ID]);
    const got = closed[0];
    expect(got).toMatchObject({ title: "New pumpkin spice cupcakes", status: "acted" });
    const note = "You stopped this send. 2 of the 3 people on the list were not emailed, and Zavi will not send it to them on its own.";
    expect(stopNoteOf({ decision_id: stopped, status: "held", hold_reason: "stopped" }, 1, 3)).toBe(note);
    expect(got.sent).toEqual({ count: 1, total: 3, stopped: true, note, list: "QA tiny list", tool: "zavi_list", at: "2026-10-22T01:20:00Z" });
    expect(JSON.stringify(r._body)).not.toContain("BODY-NOT-SERVED-81b9");
    for (const read of readOf("email_bulk_sends")) expect(read.filters).toContainEqual({ op: "eq", col: "tenant_id", val: TENANT_A });
  });

  it("a founder-stopped send that reached nobody stays out of Done, whether it was a Zavi-list or a create_and_send decision (81b9)", async () => {
    seedEmail();
    const zavi = actedBulk(1, { status: "held", hold_reason: "stopped", sent: 0, unknown: 0, total: 3 });
    const tool = actedBulk(2, { status: "held", hold_reason: "stopped", sent: 0, unknown: 0, total: 3 }, "email_campaign.create_and_send");
    const ids = await closedIds();
    expect(ids).not.toContain(zavi);
    expect(ids).not.toContain(tool);
    expect(ids).toEqual([SENT_ID, ACTION_ID, REJECTED_ID]);
  });

  it("a create_and_send decision whose Zavi-list row the founder stopped after 2 of 5 is served as a stopped Zavi-list send, never as a tool send (81b9)", async () => {
    seedEmail();
    const id = actedBulk(2, { status: "held", hold_reason: "stopped", sent: 2, unknown: 0, total: 5 }, "email_campaign.create_and_send");
    h.store.decisions.find((d) => d.id === id)!.body = { list_name: "Members", template: { subject: "s", body_text: "x" } };
    const got = ((await call(EMAIL))._body as { closed: Array<Record<string, unknown>> }).closed.find((c) => c.id === id);
    expect(got?.sent).toMatchObject({ count: 2, total: 5, stopped: true, tool: "zavi_list", list: "Members", note: "You stopped this send. 3 of the 5 people on the list were not emailed, and Zavi will not send it to them on its own." });
  });

  it("one bulk row whose state cannot be worked out is left out and logged; the rest of the history still answers 200", async () => {
    seedEmail();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const broken = actedBulk(1, { status: "held", hold_reason: "provider_error", sent: null, unknown: 0 });
      const good = actedBulk(2, { status: "done", sent: 10 });
      const r = await call(EMAIL);
      expect(r._status).toBe(200);
      const ids = (r._body as { closed: Array<{ id: string }> }).closed.map((c) => c.id);
      expect(ids).toEqual([good, SENT_ID, ACTION_ID, REJECTED_ID]);
      expect(ids).not.toContain(broken);
      expect(warn.mock.calls.some((c) => String(c[0]).startsWith(`[channel-history] email_marketing send ${broken} left out`))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("a Zavi-list send filed as a decision carries the count, the sealed list name and the tool, like a channel card (81b0)", async () => {
    const listName = `List-${Math.random().toString(36).slice(2, 8)}`;
    const id = actedBulk(1, { status: "done", total: 6, sent: 6, finished_at: "2026-10-22T01:25:00Z" });
    const row = h.store.decisions.find((d) => d.id === id)!;
    row.body = { list_id: "11111111-2222-4333-8444-555566667777", list_name: listName, template: { subject: "Our eggless chocolate truffle cake is back", body_text: "BODY-NOT-SERVED-81b0" } };
    const r = await call(EMAIL);
    expect(r._status).toBe(200);
    const closed = (r._body as { closed: Array<Record<string, unknown>> }).closed;
    const got = closed.find((c) => c.id === id)!;
    expect(got.title).toBe("Our eggless chocolate truffle cake is back");
    expect(got.sent).toEqual({ count: 6, list: listName, tool: "zavi_list", at: "2026-10-22T01:25:00Z" });
    expect(JSON.stringify(r._body)).not.toContain("BODY-NOT-SERVED-81b0");
    expect(JSON.stringify(r._body)).not.toContain("11111111-2222-4333-8444-555566667777");
  });

  it("a partly sent Zavi-list decision carries only the people it reached", async () => {
    const id = actedBulk(1, { status: "done", total: 10, sent: 6, failed: 4, finished_at: "2026-10-22T01:30:00Z" });
    h.store.decisions.find((d) => d.id === id)!.body = { list_name: "Newsletter", template: { subject: "s", body_text: "x" } };
    const got = ((await call(EMAIL))._body as { closed: Array<Record<string, unknown>> }).closed.find((c) => c.id === id)!;
    expect(got.sent).toEqual({ count: 6, list: "Newsletter", tool: "zavi_list", at: "2026-10-22T01:30:00Z" });
  });

  it("a tool send (create_and_send) filed as a decision carries its audience and tool, with no invented count (81b0)", async () => {
    const id = actedBulk(7, null, "email_campaign.create_and_send");
    h.store.decisions.find((d) => d.id === id)!.body = { tool: "klaviyo", audience_name: "VIP buyers", audience_count: 999, subject: "Tool subject", body_text: "BODY-NOT-SERVED-TOOL" };
    const r = await call(EMAIL);
    const got = (r._body as { closed: Array<Record<string, unknown>> }).closed.find((c) => c.id === id)!;
    expect(got.sent).toEqual({ count: null, list: "VIP buyers", tool: "klaviyo", at: "2026-10-22T07:10:00Z" });
    expect(JSON.stringify(r._body)).not.toContain("BODY-NOT-SERVED-TOOL");
    expect(JSON.stringify(r._body)).not.toContain("999");
  });

  const toolDecision = (n: number) => {
    const id = actedBulk(n, null, "email_campaign.create_and_send");
    h.store.decisions.find((d) => d.id === id)!.body = { tool: "mailchimp", audience_name: "Cake lovers", audience_count: 50, subject: `Tool ${n}`, body_text: "x" };
    return id;
  };
  const resultRow = (cardId: string, over: Record<string, unknown> = {}) => ({
    tenant_id: TENANT_A, rail: "decisions", card_id: cardId, route: "mailchimp", sent_count: 42,
    started_at: "2026-10-22T07:10:00Z", finished_at: "2026-10-22T07:12:00Z", h1: { opens: 3 }, list_name: "RESULT-LIST-NOT-SERVED", ...over,
  });
  const sentOf = async (id: string) => ((await call(EMAIL))._body as { closed: Array<Record<string, unknown>> }).closed.find((c) => c.id === id)?.sent;

  it("a create_and_send decision takes its real count from its results row, in one batched tenant-scoped read (81b0)", async () => {
    const a = toolDecision(7);
    const b = toolDecision(8);
    h.store.email_send_results.push(
      resultRow(a),
      resultRow(a, { sent_count: 41, finished_at: "2026-10-22T07:11:00Z" }),
      resultRow(b, { rail: "channel_actions", sent_count: 999 }),
    );
    const r = await call(EMAIL);
    expect(r._status).toBe(200);
    const byId = new Map((r._body as { closed: Array<Record<string, unknown>> }).closed.map((c) => [c.id, c]));
    expect(byId.get(a)?.sent).toMatchObject({ count: 42, list: "Cake lovers", tool: "mailchimp", at: "2026-10-22T07:10:00Z" });
    expect(byId.get(b)?.sent).toEqual({ count: null, list: "Cake lovers", tool: "mailchimp", at: "2026-10-22T08:10:00Z" });
    const wire = JSON.stringify(r._body);
    for (const marker of ["RESULT-LIST-NOT-SERVED", "999"]) expect(wire).not.toContain(marker);
    const reads = readOf("email_send_results");
    expect(reads).toHaveLength(1);
    expect(reads[0].tenant).toBe(TENANT_A);
    expect(reads[0].filters).toContainEqual({ op: "eq", col: "tenant_id", val: TENANT_A });
    expect(reads[0].filters).toContainEqual({ op: "eq", col: "rail", val: "decisions" });
    expect(reads[0].columns.split(",").map((c) => c.trim()).sort()).toEqual(["card_id", "d7", "d7_published_at", "finished_at", "h1", "note", "route", "sent_count"]);
    const inFilter = reads[0].filters.find((f) => f.op === "in" && f.col === "card_id");
    expect([...((inFilter?.val as string[]) ?? [])].sort()).toEqual([a, b].sort());
  });

  it("a tool send filed as a decision serves its 1 hour numbers from the same single read", async () => {
    const id = toolDecision(7);
    h.store.email_send_results.push(resultRow(id, { route: "sendgrid", h1: { delivered: 5, opens: 0, clicks: 1, provider_status: "ok" } }));
    expect((await sentOf(id) as Record<string, unknown>).hour_1).toMatchObject({ delivered: 5, opens: 0, clicks: 1 });
    expect(readOf("email_send_results")).toHaveLength(1);
  });

  it("another tenant's results row for the same decision id is ignored", async () => {
    const id = toolDecision(7);
    h.store.email_send_results.push(resultRow(id, { tenant_id: TENANT_B, sent_count: 777 }));
    expect(await sentOf(id)).toEqual({ count: null, list: "Cake lovers", tool: "mailchimp", at: "2026-10-22T07:10:00Z" });
  });

  it("a failing results read keeps the send with count null, logs it, and the history still answers 200", async () => {
    const id = toolDecision(7);
    h.store.email_send_results.push(resultRow(id));
    h.errors.email_send_results = "boom";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await call(EMAIL);
      expect(r._status).toBe(200);
      const got = (r._body as { closed: Array<Record<string, unknown>> }).closed.find((c) => c.id === id);
      expect(got?.sent).toEqual({ count: null, list: "Cake lovers", tool: "mailchimp", at: "2026-10-22T07:10:00Z" });
      expect(warn.mock.calls.some((c) => String(c[0]).includes("send results: boom"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("a results read that throws keeps the send with count null", async () => {
    const id = toolDecision(7);
    const original = h.tenantClient.getMockImplementation();
    h.tenantClient.mockImplementation((tid: string) => {
      const inner = original!(tid);
      return { from: (table: string) => { if (table === "email_send_results") throw new Error("kaput"); return inner.from(table); } };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await call(EMAIL);
      expect(r._status).toBe(200);
      expect((r._body as { closed: Array<Record<string, unknown>> }).closed.find((c) => c.id === id)?.sent).toMatchObject({ count: null, tool: "mailchimp" });
    } finally {
      h.tenantClient.mockImplementation(original!);
      warn.mockRestore();
    }
  });

  it("no results read is made when no create_and_send decision was sent", async () => {
    seedEmail();
    await call(EMAIL);
    expect(readOf("email_send_results")).toHaveLength(0);
  });

  it("a rejected email decision, and a channel card with no send facts, stay without sent so Done shows Marked as done", async () => {
    seedEmail();
    const r = await call(EMAIL);
    const byId = new Map((r._body as { closed: Array<Record<string, unknown>> }).closed.map((c) => [c.id, c]));
    expect(byId.get(REJECTED_ID)).toBeDefined();
    expect(byId.get(REJECTED_ID)?.sent).toBeUndefined();
    expect(byId.get(ACTION_ID)).toBeDefined();
    expect(byId.get(ACTION_ID)?.sent).toBeUndefined();
  });

  it("a Zavi-list decision with no bulk row stays in Done without a sent line, so it reads Marked as done", async () => {
    const id = actedBulk(1, null, "bulk_outbound.send");
    h.store.decisions.find((d) => d.id === id)!.body = { list_name: "Newsletter", template: { subject: "No bulk row", body_text: "x" } };
    const got = ((await call(EMAIL))._body as { closed: Array<Record<string, unknown>> }).closed.find((c) => c.id === id);
    expect(got).toBeDefined();
    expect(got!.title).toBe("No bulk row");
    expect(got!.sent).toBeUndefined();
  });

  it("a failed bulk-send read is a 500, not a history that drops or keeps sends silently", async () => {
    seedEmail();
    h.errors.email_bulk_sends = "boom";
    const r = await call(EMAIL);
    expect(r._status).toBe(500);
  });
});

describe("a sent email card on the channel_actions rail carries what was sent", () => {
  const EMAIL = "email_marketing";
  const SENT_CARD = "76bcf801-96f0-4205-931c-c0e370ede766";
  const FAILED_CARD = "76bcf801-0000-4205-931c-c0e370ede766";
  const PLAIN_CARD = "76bcf801-1111-4205-931c-c0e370ede766";
  const emailCard = (id: string, over: Record<string, unknown>) => ({
    id, tenant_id: TENANT_A, channel_slug: EMAIL, run_id: RUN_A, position: 1, run_of: 1, action_type: "send_message",
    title: "Send the cake box email", status: "acted", status_at: "2026-10-27T11:07:08.091Z", note: null,
    proposed_at: "2026-10-27T10:00:00Z", impact: null, impact_reason: null, score: 40, ...over,
  });

  function seed() {
    h.store.channel_actions.push(
      emailCard(SENT_CARD, {
        exec_class: "email_campaign.create_and_send", exec_status: "executed", executed_at: "2026-10-27T11:07:08.091Z",
        exec_result: { notice: "Sent to 2 people via Mailchimp.", receipt: { url: "https://admin.mailchimp.com/campaigns/show/?id=5833342", line: "Sent to 2 people via Mailchimp" } },
        exec_payload: { tool: "mailchimp", audience_name: "upcar.ai", variants: [{ content: { subject: "PAYLOAD-NOT-SERVED" } }] },
      }),
      emailCard(FAILED_CARD, {
        exec_class: "email_campaign.create_and_send", exec_status: "failed", executed_at: null,
        exec_result: null, exec_payload: { tool: "mailchimp", audience_name: "upcar.ai" },
      }),
      emailCard(PLAIN_CARD, { action_type: "check", exec_class: null, exec_status: null }),
    );
  }

  it("serves count, list, tool and time for the sent card, and nothing for a failed or a plain one", async () => {
    seed();
    const r = await call(EMAIL);
    expect(r._status).toBe(200);
    const closed = (r._body as { closed: Array<Record<string, unknown>> }).closed;
    const byId = new Map(closed.map((c) => [c.id, c]));
    expect(byId.get(SENT_CARD)?.sent).toEqual({ count: null, list: "upcar.ai", tool: "mailchimp", at: "2026-10-27T11:07:08.091Z" });
    expect(byId.get(FAILED_CARD)).toBeDefined();
    expect(byId.get(FAILED_CARD)?.sent).toBeUndefined();
    expect(byId.get(PLAIN_CARD)?.sent).toBeUndefined();
    expect(JSON.stringify(r._body)).not.toContain("PAYLOAD-NOT-SERVED");
    const sentRead = readOf("channel_actions").find((x) => x.columns.includes("receipt_line"));
    expect(sentRead?.tenant).toBe(TENANT_A);
    expect(sentRead?.filters).toContainEqual({ op: "in", col: "id", val: [SENT_CARD, FAILED_CARD] });
  });

  it("another channel never reads the send facts and its acted rows carry no sent", async () => {
    seedTenantA();
    const r = await call(SLUG);
    for (const row of (r._body as { closed: Array<Record<string, unknown>> }).closed) expect(row.sent).toBeUndefined();
    expect(readOf("channel_actions").some((x) => x.columns.includes("receipt_line"))).toBe(false);
  });

  const ACTION_RESULT_TOOL = "mailchimp";
  const actionResult = (over: Record<string, unknown> = {}) => ({
    tenant_id: TENANT_A, rail: "channel_actions", card_id: SENT_CARD, route: "sendgrid", sent_count: 5,
    started_at: "2026-10-27T11:07:00Z", finished_at: "2026-10-27T11:08:00Z", h1: {}, d7: {}, d7_published_at: null, ...over,
  });
  const sentOfCard = async () => ((await call(EMAIL))._body as { closed: Array<Record<string, unknown>> }).closed.find((c) => c.id === SENT_CARD)?.sent as Record<string, unknown>;

  it("serves the stored 1 hour numbers on the sent card, as the Overview words them, from one channel_actions-pinned read", async () => {
    seed();
    h.store.email_send_results.push(
      actionResult({ h1: { delivered: 5, opens: 0, clicks: 1, bounces: 0, unsubscribes: 0, provider_status: "ok" } }),
      actionResult({ rail: "decisions", h1: { delivered: 999, provider_status: "ok" } }),
      actionResult({ tenant_id: TENANT_B, h1: { delivered: 777, provider_status: "ok" } }),
    );
    const sent = await sentOfCard();
    expect(sent.hour_1).toMatchObject({ delivered: 5, opens: 0, clicks: 1 });
    expect(sent.day_7).toBeUndefined();
    expect(JSON.stringify(sent)).not.toMatch(/999|777/);
    const reads = readOf("email_send_results");
    expect(reads).toHaveLength(1);
    expect(reads[0].filters).toContainEqual({ op: "eq", col: "rail", val: "channel_actions" });
    expect(reads[0].filters).toContainEqual({ op: "eq", col: "tenant_id", val: TENANT_A });
  });

  it("a 1 hour read that failed serves the honest why and never a zero", async () => {
    seed();
    h.store.email_send_results.push(actionResult({ h1: { provider_status: "could_not_read" } }));
    const hour1 = (await sentOfCard()).hour_1 as Record<string, unknown>;
    expect(hour1.delivered).toBeNull();
    expect(hour1.opens).toBeNull();
    expect(hour1.clicks).toBeNull();
    expect(hour1.why).toEqual({ delivered: "SendGrid could not be read", opens: "SendGrid could not be read", clicks: "SendGrid could not be read" });
  });

  it("no results row yet, or an empty 1 hour read, serves no hour_1; day 7 is served only once published", async () => {
    seed();
    expect((await sentOfCard()).hour_1).toBeUndefined();
    h.store.email_send_results.push(actionResult({ h1: {}, d7: { delivered: 9, provider_status: "ok" }, d7_published_at: null }));
    const waiting = await sentOfCard();
    expect(waiting.hour_1).toBeUndefined();
    expect(waiting.day_7).toBeUndefined();
    h.store.email_send_results.length = 0;
    h.store.email_send_results.push(actionResult({ h1: { delivered: 5, provider_status: "ok" }, d7: { delivered: 9, provider_status: "ok" }, d7_published_at: "2026-11-03T00:00:00Z" }));
    const published = await sentOfCard();
    expect(published.hour_1).toMatchObject({ delivered: 5 });
    expect(published.day_7).toMatchObject({ delivered: 9 });
  });

  it("day 7 numbers carried from 1 hour reach the Done popup with their note, and a different account keeps its words", async () => {
    seed();
    const d7 = JSON.parse('{"opens":0,"clicks":0,"from_h1":["recipients","delivered","opens","clicks","unsubscribes"],"delivered":5,"recipients":5,"unsubscribes":0,"provider_status":"disconnected"}');
    const h1 = { delivered: 5, opens: 0, clicks: 0, provider_status: "ok" };
    const row = { h1, d7, d7_published_at: "2026-11-03T00:00:00Z" };
    h.store.email_send_results.push(actionResult({ ...row, note: "SendGrid is connected to a different account now; numbers stopped at 1 hour." }));
    expect((await sentOfCard()).day_7).toMatchObject({ delivered: 5, note: "SendGrid is connected to a different account now; numbers stopped at 1 hour." });
    expect(readOf("email_send_results").at(-1)?.columns).toContain("note");
    h.store.email_send_results.length = 0;
    h.store.email_send_results.push(actionResult({ ...row, note: null }));
    expect((await sentOfCard()).day_7).toMatchObject({ note: "SendGrid was disconnected; numbers stopped at 1 hour." });
    h.store.email_send_results.length = 0;
    h.store.email_send_results.push(actionResult({ ...row, d7: { delivered: 5, opens: 3, clicks: 1, provider_status: "disconnected" }, note: "SendGrid was disconnected; numbers stopped at 1 hour." }));
    const real = (await sentOfCard()).day_7 as Record<string, unknown>;
    expect(real).toMatchObject({ opens: 3 });
    expect(real).not.toHaveProperty("note");
  });

  it("a Zavi-list send never carries tool results, whatever its results row holds", async () => {
    h.store.channel_actions.push(emailCard(SENT_CARD, {
      exec_class: "bulk_outbound.send", exec_status: "executed", executed_at: "2026-10-27T11:07:08.091Z",
      exec_result: { receipt: { line: "Sent to 2 people" } }, exec_payload: { list_name: "Newsletter" },
    }));
    h.store.email_send_results.push(actionResult({ route: "zavi_list", h1: { delivered: 5, provider_status: "ok" } }));
    const sent = await sentOfCard();
    expect(sent.tool).toBe("zavi_list");
    expect(sent.hour_1).toBeUndefined();
    expect(readOf("email_send_results")).toHaveLength(0);
  });

  it("a failing or throwing results read keeps the sent card, logs it, and answers 200", async () => {
    seed();
    h.store.email_send_results.push(actionResult({ h1: { delivered: 5, provider_status: "ok" } }));
    h.errors.email_send_results = "boom";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await call(EMAIL);
      expect(r._status).toBe(200);
      const got = (r._body as { closed: Array<Record<string, unknown>> }).closed.find((c) => c.id === SENT_CARD);
      expect(got?.sent).toEqual({ count: null, list: "upcar.ai", tool: ACTION_RESULT_TOOL, at: "2026-10-27T11:07:08.091Z" });
      expect(warn.mock.calls.some((c) => String(c[0]).includes("action results: boom"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("a failed send-facts read is a 500", async () => {
    seed();
    const original = h.tenantClient.getMockImplementation();
    let n = 0;
    h.tenantClient.mockImplementation((tid: string) => {
      const inner = original!(tid);
      return { from: (table: string) => {
        const b = inner.from(table);
        if (table !== "channel_actions") return b;
        n += 1;
        if (n === 2) { const sel = b.select.bind(b); b.select = (c: string) => { h.errors.channel_actions = "boom"; return sel(c); }; }
        return b;
      } };
    });
    const r = await call(EMAIL);
    h.tenantClient.mockImplementation(original!);
    expect(r._status).toBe(500);
  });
});

describe("an approved card Zavi carried out serves who approved it and when it ran (Flow 37)", () => {
  const LI = "linkedin_ads";
  const CREATED = "89640000-f3f3-4000-8000-000000000001";
  const AUTO = "89640000-f3f3-4000-8000-000000000002";
  const MANUAL = "89640000-f3f3-4000-8000-000000000003";
  const REJECTED = "89640000-f3f3-4000-8000-000000000004";
  const card = (id: string, over: Record<string, unknown>) => ({
    id, tenant_id: TENANT_A, channel_slug: LI, run_id: RUN_A, position: 1, run_of: 1, action_type: "create_ad",
    title: "Review and create your LinkedIn campaign", status: "acted", status_at: "2026-11-03T16:00:41Z", note: null,
    proposed_at: "2026-11-03T15:58:12Z", impact: null, impact_reason: null, score: 10,
    exec_class: "linkedin_ads.create_campaign_bundle", exec_status: "executed", executed_at: "2026-11-03T16:00:40Z",
    approved_by: "u-1", approved_by_source: "web", ...over,
  });
  const ev = (action_id: string, event: string, at: string, tenant_id = TENANT_A) => ({ tenant_id, action_id, event, note: null, at, snoozed_until: null });

  function seed() {
    h.store.channel_actions.push(
      card(CREATED, {}),
      card(AUTO, { action_type: "pause_ad", approved_by: "u-1", approved_by_source: "cgo" }),
      card(MANUAL, { action_type: "setup", exec_class: null, exec_status: null, executed_at: null, approved_by: null, approved_by_source: null }),
      card(REJECTED, { status: "rejected", exec_status: "failed", executed_at: null }),
    );
    h.store.channel_action_events.push(
      ev(CREATED, "proposed", "2026-11-03T15:58:12Z"),
      ev(CREATED, "approved", "2026-11-03T15:59:00Z"),
      ev(CREATED, "exec_failed", "2026-11-03T15:59:30Z"),
      ev(CREATED, "approved", "2026-11-03T16:00:03Z"),
      ev(CREATED, "executed", "2026-11-03T16:00:40Z"),
      ev(CREATED, "approved", "2026-11-03T16:30:00Z", TENANT_B),
      ev(AUTO, "approved", "2026-11-03T16:10:00Z"),
      ev(MANUAL, "acted", "2026-11-03T16:20:00Z"),
      ev(REJECTED, "approved", "2026-11-03T16:05:00Z"),
      ev(REJECTED, "rejected", "2026-11-03T16:06:00Z"),
    );
  }

  it("the executed create card carries the latest approval as you and its run time; nothing raw leaves", async () => {
    seed();
    const r = await call(LI);
    expect(r._status).toBe(200);
    const byId = new Map((r._body as { closed: Array<Record<string, unknown>> }).closed.map((c) => [c.id, c]));
    expect(byId.get(CREATED)?.approval).toEqual({ by: "you", name: null, at: "2026-11-03T16:00:03Z" });
    expect(byId.get(CREATED)?.executed_at).toBe("2026-11-03T16:00:40Z");
    expect(byId.get(AUTO)?.approval).toEqual({ by: "autopilot", name: null, at: "2026-11-03T16:10:00Z" });
    for (const row of byId.values()) {
      expect(Object.keys(row)).not.toContain("approved_by");
      expect(Object.keys(row)).not.toContain("approved_by_source");
      expect(Object.keys(row)).not.toContain("exec_status");
    }
    expect(JSON.stringify(r._body)).not.toContain("u-1");
  });

  it("a card ticked by hand and a rejected card carry neither, so the drawer keeps Marked as done and Rejected", async () => {
    seed();
    const r = await call(LI);
    const byId = new Map((r._body as { closed: Array<Record<string, unknown>> }).closed.map((c) => [c.id, c]));
    for (const id of [MANUAL, REJECTED]) {
      expect(byId.get(id)).toBeDefined();
      expect(Object.keys(byId.get(id)!)).not.toContain("approval");
      expect(Object.keys(byId.get(id)!)).not.toContain("executed_at");
    }
  });

  it("an executed card with no approved event still serves its run time and a null approval", async () => {
    h.store.channel_actions.push(card(CREATED, { approved_by: "someone-else" }));
    const r = await call(LI);
    const row = (r._body as { closed: Array<Record<string, unknown>> }).closed[0];
    expect(row.approval).toBeNull();
    expect(row.executed_at).toBe("2026-11-03T16:00:40Z");
  });
});

describe("a LinkedIn post the founder pressed Post on carries a link to the live post", () => {
  const LI = "linkedin_organic";
  const RUN_LI = "33333333-aaaa-4bbb-8ccc-dddddddddddd";
  const TEXT = "Our first paid ads test is live.\n\nHere is what we learned.";
  const LIVE = "https://www.linkedin.com/feed/update/urn:li:share:7523360022953852928";
  const postCard = (id: string, over: Record<string, unknown> = {}) => ({
    tenant_id: TENANT_A,
    id,
    channel_slug: LI,
    run_id: RUN_LI,
    position: 1,
    run_of: 1,
    action_type: "text_post",
    title: "Review and edit your post on first paid ads tests",
    status: "acted",
    status_at: "2026-11-03T09:00:02Z",
    note: null,
    proposed_at: "2026-11-03T08:00:00Z",
    impact: null,
    impact_reason: null,
    score: 0,
    card_kind: "post",
    exec_class: null,
    exec_status: null,
    executed_at: null,
    body: { step: { title: "Review and edit your post on first paid ads tests", deliverable: { kind: "post", content: TEXT } } },
    edited_body: null,
    ...over,
  });
  const decision = { tenant_id: TENANT_A, id: "2263a370-5b46-41c7-bb9e-b42a543dc54c", agent_run_id: null, decision_class: "social.publish.v2", status: "acted", home_channel: LI, body: { channel: "linkedin", payload: { text: TEXT }, origin: "user_initiated_composer" } };
  const published = (over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: "3b136d65-d7e3-49dc-9530-cf24294132af", decision_id: decision.id, agent_run_id: null, channel: "linkedin", transport: "native", status: "published", external_url: LIVE, created_at: "2026-11-03T09:00:01Z", updated_at: "2026-11-03T09:00:40Z", ...over });
  const closedById = (body: unknown) => new Map(((body as { closed: Array<Record<string, unknown>> }).closed).map((r) => [r.id, r]));

  beforeEach(() => {
    h.reset();
    h.setAuth(TENANT_A);
  });

  it("serves the live post's link on the card for a post filed with no run id, and nothing on a hand-closed one", async () => {
    h.store.channel_actions.push(postCard("lp1"), postCard("lp2", { body: { step: { deliverable: { kind: "post", content: "A post I wrote and posted myself." } } } }));
    h.store.decisions.push(decision);
    h.store.social_posts.push(published());
    const r = await call(LI);
    expect(r._status).toBe(200);
    const rows = closedById(r._body);
    expect(rows.get("lp1")?.receipt).toEqual({ line: "Posted on LinkedIn.", url: LIVE });
    expect(rows.get("lp2")).not.toHaveProperty("receipt");
    expect(JSON.stringify(r._body)).not.toContain(decision.id);
    expect(JSON.stringify(r._body)).not.toContain("3b136d65");
  });

  it("does not link the same words posted outside the window around the card's close", async () => {
    h.store.channel_actions.push(postCard("lp1"));
    h.store.decisions.push(decision);
    h.store.social_posts.push(published({ created_at: "2026-11-03T08:30:00Z" }));
    expect(closedById((await call(LI))._body).get("lp1")).not.toHaveProperty("receipt");
  });

  it("never serves another tenant's post as this card's link", async () => {
    h.store.channel_actions.push(postCard("lp1"));
    h.store.decisions.push(decision, { ...decision, tenant_id: TENANT_B });
    h.store.social_posts.push(published({ tenant_id: TENANT_B }));
    expect(closedById((await call(LI))._body).get("lp1")).not.toHaveProperty("receipt");
  });

  it("serves the line without a link when the publish returned no URL or an off-platform one", async () => {
    h.store.channel_actions.push(postCard("lp1"));
    h.store.decisions.push(decision);
    h.store.social_posts.push(published({ external_url: "https://evil.example/x" }));
    expect(closedById((await call(LI))._body).get("lp1")?.receipt).toEqual({ line: "Posted on LinkedIn." });
  });

  it("a failed post read still answers 200 with the history, just without the link", async () => {
    h.store.channel_actions.push(postCard("lp1"));
    h.store.decisions.push(decision);
    h.store.social_posts.push(published());
    h.errors.social_posts = "boom";
    const r = await call(LI);
    expect(r._status).toBe(200);
    expect(closedById(r._body).get("lp1")).not.toHaveProperty("receipt");
  });
});
