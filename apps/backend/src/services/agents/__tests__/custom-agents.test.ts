
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>> }));

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const run = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(res, rej),
  };
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: string) => query(t), rpc: vi.fn(async () => ({ data: null, error: null })) }),
  serverClientFromBearer: () => ({ rpc: vi.fn() }),
}));
vi.mock("@/agents/index", () => ({ dispatchers: {} }));
vi.mock("@/services/agents/visibility", () => ({
  getEffectiveVisibility: async () => ({ visible: true, reason: "default_enabled" }),
}));

import {
  customAgentDraftSchema,
  customAgentNameNorm,
  customAgentReservedNames,
  customDeliverSchema,
  customAgentFrontmatter,
  customAgentToDefinition,
  customRowAdmitsRun,
  isCustomAgentRun,
  isReservedCustomAgentName,
  effectiveTriggerDeliver,
  type CustomAgentRow,
} from "../custom-agents";
import { AgentMetadataSchema } from "../types";
import { loadAgentDefinition, listGlobalAgentSlugs } from "../registry";
import { createTierGate } from "../entitlement";
import { ensureAgentRunnable } from "../ensure-runnable";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const SLUG = "c-abc123def0";
const RUN = "33333333-3333-4333-8333-333333333333";

function agentRow(over: Partial<CustomAgentRow> = {}): CustomAgentRow {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    tenant_id: TENANT_A,
    slug: SLUG,
    name: "Standup bot",
    role: "Daily standup of what Zavi did",
    instructions: "Every morning, call praxis_corpus__query_recent_runs and summarize.",
    tools: ["praxis_corpus__query_recent_runs"],
    default_deliver: null,
    status: "active",
    paused_reason: null,
    version: 3,
    test_run_id: null,
    created_at: "2026-09-25T00:00:00Z",
    updated_at: "2026-09-25T00:00:00Z",
    ...over,
  };
}

function setTier(tenant_id: string, tier: "free" | "starter" | "growth" | "pro") {
  db.tables.tenant_subscriptions = [
    ...(db.tables.tenant_subscriptions ?? []).filter((r) => r.tenant_id !== tenant_id),
    { tenant_id, tier, status: "active", comp_expires_at: null },
  ];
}

beforeEach(() => {
  db.tables = { system_config: [{ id: 1, blob: { tier_gate_enforced: false } }], tenant_subscriptions: [] };
});

describe("custom agent names", () => {
  const reserved = customAgentReservedNames(listGlobalAgentSlugs());

  it.each(["operator", "Operator ", "OPERATOR", "growth-lead", "Growth Lead", "growth_lead", "Head of Growth", "Zavi", "Meta Ads"])(
    "rejects %j (normalizes to a built-in)",
    (name) => {
      expect(isReservedCustomAgentName(name, reserved)).toBe(true);
    },
  );

  it("accepts a fresh name", () => {
    expect(isReservedCustomAgentName("Standup bot", reserved)).toBe(false);
  });

  it("normalizer matches the SQL one's contract", () => {
    expect(customAgentNameNorm("  Growth-Lead  ")).toBe("growth lead");
    expect(customAgentNameNorm("SEO & AI Search")).toBe("seo ai search");
  });
});

describe("customDeliverSchema", () => {
  const ok = [
    { kind: "chat_thread", thread_id: "55555555-5555-4555-8555-555555555555" },
    { kind: "slack_thread", channel_id: "C0123ABC", thread_ts: "1700000000.0001" },
    { kind: "slack_channel", channel_id: "C0123ABC" },
    { kind: "slack_dm", slack_user_id: "U0123ABC" },
    { kind: "whatsapp", wa_id: "15551234567", phone_number_id: "1234" },
    { kind: "email" },
    { kind: "telegram", chat_id: 1 },
    { kind: "discord", channel_id: "D1", guild_id: "G1" },
  ];
  it.each(ok)("accepts %j", (d) => {
    expect(customDeliverSchema.safeParse(d).success).toBe(true);
  });

  it.each([
    { kind: "slack_channel", channel_id: "#exec-private" },
    { kind: "email", to: "attacker@example.com" },
    { kind: "chat_thread", thread_id: "55555555-5555-4555-8555-555555555555", channel_id: "C0999" },
    { kind: "telegram", chat_id: 1, bot_token: "x" },
    { kind: "discord", channel_id: "D1" },
    { kind: "webhook", url: "https://evil.example" },
  ])("rejects a model-supplied arbitrary target %j", (d) => {
    expect(customDeliverSchema.safeParse(d).success).toBe(false);
  });
});

describe("registry: custom agent definitions", () => {
  it("synthesizes a definition that passes AgentMetadataSchema, manual_only + custom", () => {
    expect(() => AgentMetadataSchema.parse(customAgentFrontmatter(agentRow()))).not.toThrow();
    const def = customAgentToDefinition(agentRow());
    expect(def.metadata_praxis.manual_only).toBe(true);
    expect(def.metadata_praxis.custom).toBe(true);
    expect(def.slug).toBe(SLUG);
    expect(def.body_markdown).toContain("praxis_corpus__query_recent_runs");
  });

  it("loads the tenant's own row by `c-` slug", async () => {
    db.tables.custom_agents = [agentRow()];
    const def = await loadAgentDefinition(SLUG, TENANT_A);
    expect(def?.metadata_praxis.custom).toBe(true);
  });

  it("the prefix alone grants nothing: no row → not found", async () => {
    db.tables.custom_agents = [];
    expect(await loadAgentDefinition(SLUG, TENANT_A)).toBeNull();
    expect(await loadAgentDefinition("c-zzzzzzzzzz", TENANT_A)).toBeNull();
    expect(await loadAgentDefinition(SLUG)).toBeNull();
  });

  it("another tenant's slug is not found", async () => {
    db.tables.custom_agents = [agentRow()];
    expect(await loadAgentDefinition(SLUG, TENANT_B)).toBeNull();
  });

  it("an archived row is not found", async () => {
    db.tables.custom_agents = [agentRow({ status: "archived" })];
    expect(await loadAgentDefinition(SLUG, TENANT_A)).toBeNull();
  });
});

describe("isCustomAgentRun", () => {
  it("active row of this tenant → true; other tenant / no row → false", async () => {
    db.tables.custom_agents = [agentRow()];
    expect(await isCustomAgentRun(TENANT_A, SLUG)).toBe(true);
    expect(await isCustomAgentRun(TENANT_B, SLUG)).toBe(false);
    db.tables.custom_agents = [];
    expect(await isCustomAgentRun(TENANT_A, SLUG)).toBe(false);
  });

  it("paused / archived → false", async () => {
    db.tables.custom_agents = [agentRow({ status: "paused" })];
    expect(await isCustomAgentRun(TENANT_A, SLUG)).toBe(false);
    db.tables.custom_agents = [agentRow({ status: "archived" })];
    expect(await isCustomAgentRun(TENANT_A, SLUG)).toBe(false);
  });

  it("a draft only as its own Test run (by run id, or by the token in its dedupe key)", () => {
    const draft = { status: "draft", test_run_id: RUN };
    expect(customRowAdmitsRun(draft)).toBe(false);
    expect(customRowAdmitsRun(draft, { runId: RUN })).toBe(true);
    expect(customRowAdmitsRun(draft, { cronDedupeKey: `custom-test:${RUN}` })).toBe(true);
    expect(customRowAdmitsRun(draft, { runId: "66666666-6666-4666-8666-666666666666" })).toBe(false);
    expect(customRowAdmitsRun({ status: "draft", test_run_id: null }, { runId: RUN })).toBe(false);
  });
});

describe("tier gate: custom agents are Starter, whatever tier_gate_enforced says", () => {
  it("Free tenant → refused with required Starter", async () => {
    db.tables.custom_agents = [agentRow()];
    setTier(TENANT_A, "free");
    const d = await createTierGate().decide(TENANT_A, SLUG);
    expect(d).toMatchObject({ enforced: true, allowed: false, required_tier: "starter", tier: "free" });
  });

  it("Starter tenant → allowed", async () => {
    db.tables.custom_agents = [agentRow()];
    setTier(TENANT_A, "starter");
    const d = await createTierGate().decide(TENANT_A, SLUG);
    expect(d).toMatchObject({ allowed: true, required_tier: "starter" });
  });

  it("an unverified `c-` slug needs Pro (deny-by-default), even for Starter", async () => {
    db.tables.custom_agents = [];
    setTier(TENANT_A, "starter");
    const d = await createTierGate().decide(TENANT_A, SLUG);
    expect(d).toMatchObject({ allowed: false, required_tier: "pro" });
  });

  it("built-in slugs decide exactly as before (snapshot, gate off, Free)", async () => {
    setTier(TENANT_A, "free");
    const gate = createTierGate();
    const out: Record<string, unknown> = {};
    for (const slug of ["operator", "research", "engineer", "meta_ads", "seo", "unknown-agent"]) {
      out[slug] = await gate.decide(TENANT_A, slug);
    }
    expect(out).toEqual({
      operator: { enforced: false, tier: "free", required_tier: "free", allowed: true },
      research: { enforced: false, tier: "free", required_tier: "free", allowed: true },
      engineer: { enforced: true, tier: "free", required_tier: "pro", allowed: false },
      meta_ads: { enforced: true, tier: "free", required_tier: "pro", allowed: false },
      seo: { enforced: true, tier: "free", required_tier: "starter", allowed: false },
      "unknown-agent": { enforced: false, tier: "free", required_tier: "pro", allowed: true },
    });
  });
});

describe("ensureAgentRunnable for custom agents", () => {
  it("no row → not_found", async () => {
    db.tables.custom_agents = [];
    setTier(TENANT_A, "pro");
    const r = await ensureAgentRunnable(TENANT_A, SLUG);
    expect(r).toMatchObject({ runnable: false, reason: "not_found" });
  });

  it("paused row → not runnable, even for Pro", async () => {
    db.tables.custom_agents = [agentRow({ status: "paused" })];
    setTier(TENANT_A, "pro");
    expect((await ensureAgentRunnable(TENANT_A, SLUG)).runnable).toBe(false);
  });

  it("draft: only its own Test run is runnable", async () => {
    db.tables.custom_agents = [agentRow({ status: "draft", test_run_id: RUN })];
    setTier(TENANT_A, "starter");
    expect((await ensureAgentRunnable(TENANT_A, SLUG)).runnable).toBe(false);
    const run = { trigger: "manual", enqueuedByUser: true, payload: {}, cronDedupeKey: `custom-test:${RUN}` };
    expect((await ensureAgentRunnable(TENANT_A, SLUG, { run })).runnable).toBe(true);
  });

  it("active row, Free tenant → plan_upgrade_required (Starter)", async () => {
    db.tables.custom_agents = [agentRow()];
    setTier(TENANT_A, "free");
    const r = await ensureAgentRunnable(TENANT_A, SLUG);
    expect(r).toMatchObject({ runnable: false, reason: "plan_upgrade_required", required_tier: "starter" });
  });
});

describe("customAgentDraftSchema", () => {
  it("carries no credit estimate, so the model is never handed one to repeat", () => {
    const d = customAgentDraftSchema.parse({
      name: "Standup",
      instructions: "Send a standup.",
      triggers: [{ kind: "schedule", cron: "0 9 * * 1-5" }],
      deliver: null,
      est_daily_credits: 243,
    });
    expect(d).not.toHaveProperty("est_daily_credits");
    expect(Object.keys(customAgentDraftSchema.shape)).not.toContain("est_daily_credits");
  });
});

describe("migration 20260926120000_custom_agents.sql", () => {
  const migDir = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations");
  const sql = readFileSync(join(migDir, "20260926120000_custom_agents.sql"), "utf8");
  const fnBody = (src: string, name: string) => {
    const i = src.indexOf(`create or replace function ${name}(`);
    return src.slice(i, src.indexOf("$$;", i));
  };

  it("is the newest definition of both credit triggers before 20261006090000", () => {
    const newest = (name: string) =>
      readdirSync(migDir)
        .filter((f) => f.endsWith(".sql") && readFileSync(join(migDir, f), "utf8").includes(`create or replace function ${name}(`))
        .filter((f) => f < "20261006090000")
        .sort()
        .at(-1);
    expect(newest("_trg_reserve_run_credits")).toBe("20260926120000_custom_agents.sql");
    expect(newest("_trg_rereserve_run_credits")).toBe("20260926120000_custom_agents.sql");
  });

  it.each(["_trg_reserve_run_credits", "_trg_rereserve_run_credits"])(
    "%s is an exact superset of its prior body (20260923140000)",
    (name) => {
      const prior = readFileSync(join(migDir, "20260923140000_signup_preview_runs.sql"), "utf8");
      const next = fnBody(sql, name);
      const replaced = "                         else _tier_required(NEW.agent_slug) end;";
      for (const line of fnBody(prior, name).split("\n")) {
        if (line === replaced) continue;
        expect(next).toContain(line);
      }
      expect(next).toContain("_tier_required_for_run(NEW.tenant_id, NEW.agent_slug,");
      expect(next).toContain("if not v_gated and _is_custom_agent_slug(NEW.agent_slug) then");
    },
  );

  it("update can clear the destination explicitly", () => {
    expect(fnBody(sql, "update_custom_agent")).toContain("case when coalesce(p_clear_deliver, false) then null");
  });

  it("create and activate check the paid line before writing", () => {
    const create = fnBody(sql, "create_custom_agent");
    expect(create.indexOf("_custom_agent_require_paid(p_tenant_id)")).toBeGreaterThan(-1);
    expect(create.indexOf("_custom_agent_require_paid(p_tenant_id)")).toBeLessThan(create.indexOf("insert into custom_agents"));
    expect(fnBody(sql, "set_custom_agent_status")).toMatch(/if p_status = 'active' then\s+perform _custom_agent_require_paid/);
    expect(fnBody(sql, "_custom_agent_require_paid")).toContain("raise exception 'plan_upgrade_required'");
  });

  it("every security-definer function pins search_path with pg_temp", () => {
    const defs = sql.match(/create or replace function[\s\S]*?\$(?:function)?\$/gi) ?? [];
    expect(defs.length).toBeGreaterThan(10);
    for (const d of defs) {
      if (/security definer/i.test(d)) expect(d).toMatch(/search_path (=|TO) '?public'?, '?pg_temp'?/i);
    }
  });

  const chatFns: Array<[string, string, number]> = [
    ["send_agent_chat_turn(", "20260714061029_sweep_rpc_tenant_resolution_per_session.sql", 0],
    ["send_agent_chat_turn_v2(", "20260714061029_sweep_rpc_tenant_resolution_per_session.sql", 0],
    ["send_agent_chat_turn_v3(", "20260714061029_sweep_rpc_tenant_resolution_per_session.sql", 0],
    ["send_agent_chat_turn_v3(", "20260714061029_sweep_rpc_tenant_resolution_per_session.sql", 1],
    ["submit_clarification_response(", "20260916235000_fix_clarify_submit_ambiguous_columns.sql", 0],
  ];
  const nthBody = (src: string, head: string, n: number): string => {
    const re = new RegExp(`create or replace function (?:public\\.)?${head.replace(/[()]/g, "\\$&")}`, "gi");
    const starts = [...src.matchAll(re)].map((m) => m.index!);
    const i = starts[n];
    expect(i, `${head} #${n}`).toBeDefined();
    const endA = src.indexOf("end $$;", i);
    const endB = src.indexOf("end $function$", i);
    const end = [endA, endB].filter((x) => x >= 0).sort((a, b) => a - b)[0];
    return src.slice(i, end);
  };

  it.each(chatFns)("%s (#%i in its source) is an exact superset of %s", (head, src, n) => {
    const prior = nthBody(readFileSync(join(migDir, src), "utf8"), head, n);
    const next = nthBody(sql, head, n);
    const priorLines = prior.split("\n");
    const nextLines = next.split("\n");
    const added = nextLines.filter((l) => !priorLines.includes(l));
    expect(added).toHaveLength(2);
    expect(added[0]).toMatch(/^\s+-- custom agents \(decision 18\)/);
    expect(added[1]).toMatch(/^\s+\) and not _custom_agent_member_allowed\(v_tenant_id, (p_agent_slug|v_slug), array\[/);
    const removed = priorLines.filter((l) => !nextLines.includes(l));
    expect(removed.every((l) => l.trim() === ") then")).toBe(true);
    expect(sql).toContain(`copied from ${src}`);
  });

  it("no migration after this one's sources redefines the chat RPCs (except this file and the role ladder)", () => {
    const later = readdirSync(migDir).filter(
      (f) =>
        f.endsWith(".sql") &&
        f > "20260916235000_fix_clarify_submit_ambiguous_columns.sql" &&
        f !== "20260926120000_custom_agents.sql" &&
        f !== "20260926210000_workspace_role_ladder.sql",
    );
    for (const f of later) {
      expect(readFileSync(join(migDir, f), "utf8"), f).not.toMatch(
        /create\s+or\s+replace\s+function\s+(public\.)?(send_agent_chat_turn|submit_clarification_response)/i,
      );
    }
  });

  it("member-callable RPCs revoke public/anon; internal helpers revoke authenticated too", () => {
    for (const fn of ["create_custom_agent", "update_custom_agent", "set_custom_agent_status", "set_custom_agent_test_token"]) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${fn}\\([^)]*\\)\\s+from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\)\\s+to authenticated, service_role;`));
    }
    for (const fn of ["_is_custom_agent_run", "_tier_required_for_run", "_custom_agent_authorize", "stamp_custom_agent_run"]) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${fn}\\([^)]*\\)\\s+from public, anon, authenticated;`));
    }
  });
});

describe("trigger delivery falls back to the agent's CURRENT default", () => {
  const email = { kind: "email" };
  const thread = { kind: "chat_thread", thread_id: "55555555-5555-4555-8555-555555555555" };

  it("a trigger with no destination follows the agent, so a PATCH of deliver applies", () => {
    expect(effectiveTriggerDeliver({ deliver: null }, { default_deliver: thread })).toEqual(thread);
    expect(effectiveTriggerDeliver({ deliver: null }, { default_deliver: email })).toEqual(email);
    expect(effectiveTriggerDeliver({ deliver: null }, { default_deliver: null })).toBeNull();
  });

  it("a trigger's own destination wins; a malformed one is nowhere, never the default", () => {
    expect(effectiveTriggerDeliver({ deliver: email }, { default_deliver: thread })).toEqual(email);
    expect(effectiveTriggerDeliver({ deliver: { kind: "webhook" } }, { default_deliver: thread })).toBeNull();
  });

  it("the migration stores trigger deliver NULL", () => {
    const sql = readFileSync(
      join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations", "20260926120000_custom_agents.sql"),
      "utf8",
    );
    expect(sql).not.toMatch(/_custom_agent_insert_triggers\(p_tenant_id, [^)]*default_deliver/);
    expect(sql).toMatch(/case when t->>'kind' = 'watch' then t->>'condition' end,\n\s+null,/);
  });
});

describe("reserved names are owned by the database, not the caller (C3)", () => {
  const sql = readFileSync(
    join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations", "20260926120000_custom_agents.sql"),
    "utf8",
  );
  const migrationsDir = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations");
  const seeded = new Set(
    readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
      .flatMap((s) => [...s.matchAll(/^insert into custom_agent_reserved_names \(name_norm\) values\n([^;]*);/gm)])
      .flatMap((stmt) => [...stmt[1].matchAll(/^  \('([a-z0-9 ]+)'\),?$/gm)].map((m) => m[1])),
  );

  it("the seed covers every built-in slug and display name the backend reserves", () => {
    for (const n of customAgentReservedNames(listGlobalAgentSlugs())) {
      expect(seeded.has(customAgentNameNorm(n)), n).toBe(true);
    }
  });

  it("an EMPTY caller list still rejects 'Operator': the check reads the table too", () => {
    expect(seeded.has(customAgentNameNorm("Operator"))).toBe(true);
    const i = sql.indexOf("create or replace function _custom_agent_check_name(");
    const body = sql.slice(i, sql.indexOf("$$;", i));
    expect(body).toMatch(/or exists \(\s+select 1 from custom_agent_reserved_names where name_norm = p_name_norm/);
  });

  it("no client role can read or write the table", () => {
    expect(sql).toMatch(/alter table custom_agent_reserved_names enable row level security;/);
    expect(sql).toMatch(/revoke all on custom_agent_reserved_names from public, anon, authenticated;/);
  });
});
