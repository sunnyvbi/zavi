
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260911200000_creator_network_s1.sql";
const raw = readFileSync(join(MIG_DIR, FILE), "utf-8");

const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const EXISTING_TABLES_TOUCHED = ["human_members", "human_member_pii", "creator_briefs"] as const;

const TENANT_TABLES = [
  "creator_threads",
  "creator_thread_messages",
  "creator_offers",
  "creator_orders",
  "creator_submissions",
  "creator_disputes",
  "creator_money_events",
  "creator_reviews",
  "creator_library_assets",
] as const;
const GLOBAL_TABLES = ["creator_packages", "creator_payout_accounts"] as const;
const NEW_TABLES = [...TENANT_TABLES, "creator_notifications", ...GLOBAL_TABLES];

const SERVICE_ROLE_FUNCTIONS = [
  "search_creators",
  "creator_claim_due_order_deadlines",
  "creator_claim_order_deadline",
  "creator_release_order_deadline_lease",
  "creator_claim_order_transfer",
  "creator_mark_order_transferred",
  "creator_release_order_transfer_claim",
] as const;

function fnBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function ${name}\\(`, "i"));
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  return sql.slice(open + 2, close);
}

function tableDdl(t: string): string {
  const start = sql.search(new RegExp(`create table if not exists ${t} \\(`, "i"));
  expect(start, `${t} must be created`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("\n);", start) + 3);
}

describe(`${FILE} — add-only guard`, () => {
  it("contains no DROP, RENAME, TRUNCATE or top-level DELETE", () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|constraint|index|function|policy|trigger|view|type|schema)\b/i);
    expect(sql).not.toMatch(/\brename\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/^\s*delete\s+from\b/im);
  });

  it("never alters an existing column or constraint, and adds no NOT NULL to one", () => {
    expect(sql).not.toMatch(/\balter\s+column\b/i);
    expect(sql).not.toMatch(/\b(alter|drop|validate)\s+constraint\b/i);
    expect(sql).not.toMatch(/\badd\s+constraint\b/i);
    expect(sql).not.toMatch(/\bset\s+not\s+null\b/i);
    expect(sql).not.toMatch(/\bset\s+data\s+type\b/i);
  });

  it("touches existing tables ONLY with ADD COLUMN IF NOT EXISTS of a nullable column", () => {
    for (const t of EXISTING_TABLES_TOUCHED) {
      const stmts = [...sql.matchAll(new RegExp(`alter table ${t}\\b[^;]*;`, "gi"))].map((m) => m[0]);
      expect(stmts.length, `${t} gains columns`).toBeGreaterThan(0);
      for (const s of stmts) {
        expect(s, s).toMatch(new RegExp(`^alter table ${t}\\s+add column if not exists [a-z_]+ [a-z]`, "i"));
        expect(s, `${s} must stay nullable`).not.toMatch(/\bnot null\b/i);
        expect(s, `${s} must be a single column`).not.toMatch(/,\s*add column/i);
      }
      expect(sql).not.toMatch(new RegExp(`create policy [a-z_]+ on ${t}\\b`, "i"));
      expect(sql).not.toMatch(new RegExp(`(grant|revoke) [a-z, ]+ on ${t}\\b`, "i"));
    }
  });

  it("adds exactly the planned columns", () => {
    const added = (t: string) =>
      [...sql.matchAll(new RegExp(`alter table ${t}\\s+add column if not exists ([a-z_]+)`, "gi"))]
        .map((m) => m[1])
        .sort();
    expect(added("human_members")).toEqual(
      ["city", "country_code", "intro_video_path", "lanes", "missed_deadline_count", "sample_video_paths", "slug"].sort(),
    );
    expect(added("human_member_pii")).toEqual(["date_of_birth"]);
    expect(added("creator_briefs")).toEqual(
      ["answer_by", "applicant_cap", "closed_at", "decline_note", "delivery_days", "filters", "lane", "posted_at"].sort(),
    );
  });

  it("creates only NEW functions (never replaces one an earlier migration defined)", () => {
    const mine = [...sql.matchAll(/create or replace function ([a-z_]+)\(/gi)].map((m) => m[1].toLowerCase());
    expect(mine.length).toBeGreaterThanOrEqual(10);
    const earlier = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql") && f < FILE)
      .map((f) => readFileSync(join(MIG_DIR, f), "utf-8").toLowerCase());
    for (const fn of mine) {
      const clash = earlier.some((s) => new RegExp(`function\\s+(public\\.)?${fn}\\s*\\(`).test(s));
      expect(clash, `${fn} already exists in an earlier migration`).toBe(false);
    }
  });

  it("creates only NEW tables, every create guarded", () => {
    const created = [...sql.matchAll(/create table if not exists ([a-z_]+) \(/gi)].map((m) => m[1]).sort();
    expect(created).toEqual([...NEW_TABLES].sort());
    const creates = sql.match(/^create (table|index|unique index)\b.*/gim) ?? [];
    for (const line of creates) expect(line, line).toMatch(/if not exists/i);
    expect(sql).not.toMatch(/drop policy/i);
    expect((sql.match(/if not exists \(select 1 from pg_policies/gi) ?? []).length).toBe(3);
  });

  it("buckets insert with ON CONFLICT DO NOTHING (never mutates an existing bucket)", () => {
    const inserts = sql.match(/insert into storage\.buckets[\s\S]*?;/gi) ?? [];
    expect(inserts.length).toBe(2);
    for (const s of inserts) expect(s).toMatch(/on conflict \(id\) do nothing;$/i);
  });

  it("is one transaction, header comment first", () => {
    expect(raw.trimStart()).toMatch(/^--/);
    expect((raw.match(/^begin;$/gim) ?? []).length).toBe(1);
    expect((raw.match(/^commit;$/gim) ?? []).length).toBe(1);
  });
});

describe(`${FILE} — RLS isolation`, () => {
  it("enables RLS on every new table", () => {
    for (const t of NEW_TABLES) {
      expect(sql, t).toMatch(new RegExp(`alter table ${t}\\s+enable row level security`, "i"));
    }
  });

  it("tenant tables: tenant_id NOT NULL, FK to tenants, cascade", () => {
    for (const t of TENANT_TABLES) {
      expect(tableDdl(t), t).toMatch(/tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i);
    }
  });

  it("tenant A cannot read tenant B: the ONLY select policy is tenant_users membership via auth.uid()", () => {
    const loop = sql.slice(sql.indexOf("foreach t in array array["), sql.indexOf("] loop"));
    const looped = [...loop.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(looped).toEqual([...TENANT_TABLES].sort());
    expect(sql).toMatch(
      /'create policy %I on %I for select to authenticated using \(\s*exists \(select 1 from tenant_users tu\s+where tu\.tenant_id = %I\.tenant_id and tu\.user_id = auth\.uid\(\)\)\)'/i,
    );
    const policies = sql.match(/create policy\s+[^\s]+/gi) ?? [];
    expect(policies.map((p) => p.replace(/\s+/g, " ").toLowerCase()).sort()).toEqual(
      ["create policy %i", "create policy creator_buckets_deny_client_roles", "create policy creator_notifications_member_select"].sort(),
    );
    expect(sql).not.toMatch(/for (insert|update|delete|all) to authenticated using \(\s*exists/i);
  });

  it("creator A cannot read creator B: no policy keys on creator identity, so creators match nothing", () => {
    const policyText = [...sql.matchAll(/create policy[\s\S]*?\);/gi)].map((m) => m[0]).join("\n");
    const templateText = sql.slice(sql.indexOf("'create policy %I"), sql.indexOf("t || '_member_select', t, t);"));
    for (const text of [policyText, templateText]) {
      expect(text).not.toMatch(/human_member_id|auth_user_id|human_members/i);
    }
  });

  it("the global plane has zero policies and no grants", () => {
    for (const t of GLOBAL_TABLES) {
      expect(sql, t).not.toMatch(new RegExp(`create policy [a-z_]+ on ${t}\\b`, "i"));
      expect(sql, t).toMatch(new RegExp(`revoke all on ${t}\\s+from anon, authenticated;`, "i"));
      expect(sql, t).not.toMatch(new RegExp(`grant [a-z, ]+ on ${t}\\b`, "i"));
      expect(tableDdl(t), `${t} carries no tenant_id`).not.toMatch(/\btenant_id\b/i);
    }
  });

  it("the browser writes nothing: every table revokes all, authenticated gets SELECT only", () => {
    for (const t of [...TENANT_TABLES, "creator_notifications"]) {
      expect(sql, t).toMatch(new RegExp(`revoke all on ${t}\\s+from anon, authenticated;`, "i"));
      expect(sql, t).toMatch(new RegExp(`grant select on ${t}\\s+to authenticated;`, "i"));
    }
    expect(sql).not.toMatch(/grant\s+(all|insert|update|delete)[^;]*to\s+(anon|authenticated)/i);
    expect(sql).not.toMatch(/grant\s+select[^;]*to\s+anon/i);
  });

  it("notifications: tenant policy requires recipient_kind='tenant' and creator rows cannot carry a tenant_id", () => {
    expect(sql).toMatch(
      /create policy creator_notifications_member_select on creator_notifications\s+for select to authenticated using \(\s*recipient_kind = 'tenant'\s+and exists \(select 1 from tenant_users tu\s+where tu\.tenant_id = creator_notifications\.tenant_id and tu\.user_id = auth\.uid\(\)\)/i,
    );
    expect(tableDdl("creator_notifications")).toMatch(
      /\(recipient_kind = 'creator' and human_member_id is not null and tenant_id is null\)/i,
    );
  });

  it("children reference parents by (tenant_id, id) so no row can point at another tenant's parent", () => {
    const composite: Array<[string, string]> = [
      ["creator_thread_messages", "creator_threads"],
      ["creator_offers", "creator_threads"],
      ["creator_orders", "creator_threads"],
      ["creator_orders", "creator_offers"],
      ["creator_submissions", "creator_orders"],
      ["creator_disputes", "creator_orders"],
      ["creator_money_events", "creator_orders"],
      ["creator_reviews", "creator_orders"],
      ["creator_library_assets", "creator_orders"],
      ["creator_library_assets", "creator_submissions"],
      ["creator_notifications", "creator_orders"],
    ];
    for (const [child, parent] of composite) {
      expect(tableDdl(child), `${child} -> ${parent}`).toMatch(
        new RegExp(`foreign key \\(tenant_id, [a-z_]+\\)\\s+references ${parent}\\s+\\(tenant_id, id\\)`, "i"),
      );
    }
    expect(tableDdl("creator_submissions")).toMatch(
      /check \(storage_path like tenant_id::text \|\| '\/' \|\| order_id::text \|\| '\/%'\)/i,
    );
  });

  it("every security-definer function pins search_path to public, pg_temp", () => {
    const headers = [...sql.matchAll(/create or replace function ([a-z_]+)\([\s\S]*?\$\$/gi)];
    for (const [header, name] of headers) {
      if (!/security definer/i.test(header)) continue;
      expect(header, name).toMatch(/set search_path = public, pg_temp/i);
    }
  });

  it("claims, transfers and search are service_role only", () => {
    for (const fn of SERVICE_ROLE_FUNCTIONS) {
      expect(sql, fn).toMatch(new RegExp(`revoke execute on function ${fn}\\([^)]*\\)\\s+from public, anon, authenticated;`, "i"));
      expect(sql, fn).toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\)\\s+to service_role;`, "i"));
      expect(sql, fn).not.toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\)\\s+to [^;]*(anon|authenticated)`, "i"));
    }
  });

  it("public storefront: anon-callable, explicit allowlist, never reads PII, handles or ids", () => {
    expect(sql).toMatch(/grant\s+execute on function get_creator_storefront\(text\) to anon, authenticated, service_role;/i);
    const body = fnBody("get_creator_storefront");
    for (const forbidden of [
      /human_member_pii/i,
      /\bemail\b/i,
      /legal_name/i,
      /date_of_birth/i,
      /auth_user_id/i,
      /h\.handle\b/i,
      /rejected_reason/i,
      /\brate_usd\b/i,
      /select\s+\*\s+from\s+human_members/i,
    ]) {
      expect(body, String(forbidden)).not.toMatch(forbidden);
    }
    expect(body).toMatch(/m\.vetting_state = 'approved'/);
    const returns = sql.slice(
      sql.indexOf("create or replace function get_creator_storefront"),
      sql.indexOf("language sql", sql.indexOf("create or replace function get_creator_storefront")),
    );
    expect(returns).not.toMatch(/\bhuman_member_id\b|\bemail\b|\bhandles?\b\s+(jsonb|text)/i);
    expect(returns).toMatch(/self_reported_metrics\s+jsonb/i);
  });

  it("storage: creator-media public, creator-deliverables private, one restrictive client deny", () => {
    expect(sql).toMatch(/values \('creator-media', 'creator-media', true,/i);
    expect(sql).toMatch(/values \('creator-deliverables', 'creator-deliverables', false,/i);
    expect(sql).toMatch(
      /create policy creator_buckets_deny_client_roles on storage\.objects\s+as restrictive\s+for all\s+to anon, authenticated\s+using \(bucket_id not in \('creator-media', 'creator-deliverables'\)\)\s+with check \(bucket_id not in \('creator-media', 'creator-deliverables'\)\);/i,
    );
  });
});

describe(`${FILE} — money path`, () => {
  it("money ledger: unique idempotency key, livemode, integer cents, append-only trigger", () => {
    const ddl = tableDdl("creator_money_events");
    expect(ddl).toMatch(/idempotency_key\s+text not null unique/i);
    expect(ddl).toMatch(/livemode\s+boolean not null/i);
    expect(ddl).toMatch(/amount_cents\s+bigint not null check \(amount_cents >= 0\)/i);
    expect(ddl).toMatch(/kind in \('hold', 'capture', 'cancel', 'refund', 'transfer', 'transfer_reversal', 'fee'\)/i);
    expect(sql).toMatch(/before update or delete on creator_money_events\s+for each row execute function creator_money_events_guard\(\)/i);
    const guard = fnBody("creator_money_events_guard");
    expect(guard).toMatch(/if tg_op = 'UPDATE' then\s+raise exception/i);
    expect(guard).toMatch(/if tg_op = 'DELETE' and old\.livemode then\s+raise exception/i);
  });

  it("orders: integer cents, generated totals, payout never above the creator's share", () => {
    const ddl = tableDdl("creator_orders");
    expect(ddl).toMatch(/business_total_cents\s+integer generated always as \(price_cents \+ business_fee_cents\) stored/i);
    expect(ddl).toMatch(/creator_payout_cents\s+integer generated always as \(price_cents - creator_fee_cents\) stored/i);
    expect(ddl).toMatch(/payout_amount_cents <= price_cents - creator_fee_cents/i);
    expect(ddl).toMatch(/livemode\s+boolean not null/i);
    expect(ddl).not.toMatch(/numeric/i);
  });

  it("transfer claim mirrors held funds: atomic ready -> transferring, blocked by an open dispute", () => {
    const claim = fnBody("creator_claim_order_transfer");
    expect(claim).toMatch(/set payout_status = 'transferring'/i);
    expect(claim).toMatch(/o\.payout_status = 'ready'/i);
    expect(claim).toMatch(/o\.payout_ready_at <= now\(\)/i);
    expect(claim).toMatch(/not exists \(select 1 from creator_disputes d where d\.order_id = o\.id and d\.status = 'open'\)/i);
    const mark = fnBody("creator_mark_order_transferred");
    expect(mark).toMatch(/where id = p_order_id and payout_status = 'transferring'/i);
    expect(mark).toMatch(/insert into creator_money_events[\s\S]*on conflict \(idempotency_key\) do nothing/i);
    expect(fnBody("creator_release_order_transfer_claim")).toMatch(
      /set payout_status = 'ready'[\s\S]*where id = p_order_id and payout_status = 'transferring'/i,
    );
    expect(sql).toMatch(/create unique index if not exists creator_disputes_one_open_per_order\s+on creator_disputes \(order_id\) where status = 'open'/i);
  });

  it("deadline claim mirrors claim_due_reminders: lease + skip locked, terminal orders excluded", () => {
    for (const fn of ["creator_claim_due_order_deadlines", "creator_claim_order_deadline"]) {
      const body = fnBody(fn);
      expect(body, fn).toMatch(/set lease_until = now\(\) \+ interval '2 minutes'/i);
      expect(body, fn).toMatch(/next_deadline_at <= now\(\)/i);
      expect(body, fn).toMatch(/\(lease_until is null or lease_until < now\(\)\)/i);
      expect(body, fn).toMatch(/for update skip locked/i);
      expect(body, fn).toMatch(/status not in \('completed', 'cancelled'\)/i);
    }
  });
});

describe(`${FILE} — search_creators neutral order (invariant 4)`, () => {
  const body = fnBody("search_creators");
  const orderBy = body.slice(body.search(/\border by\s*\n\s*case when p_order/i), body.search(/\blimit least/i));

  it("isolates the result ORDER BY", () => {
    expect(orderBy.length).toBeGreaterThan(20);
  });

  it("orders ONLY by joined date, display name, and a stable id tiebreak", () => {
    expect(orderBy).toMatch(/case when p_order = 'newest' then m\.created_at end desc/i);
    expect(orderBy).toMatch(/case when p_order = 'a_to_z' then lower\(m\.display_name\) end asc/i);
    expect(orderBy).toMatch(/m\.id asc/i);
    const columns = [...orderBy.matchAll(/\bm\.([a-z_]+)/gi)].map((m) => m[1]).sort();
    expect([...new Set(columns)]).toEqual(["created_at", "display_name", "id"]);
  });

  it("never orders by price, fit, rating, audience or match strength", () => {
    for (const banned of [
      /price/i,
      /\bfit\b/i,
      /score/i,
      /rating|review|satisf/i,
      /metric|follower|audience/i,
      /cardinality|skills|intersect|&&/i,
      /\bp\./i,
      /random\(\)/i,
    ]) {
      expect(orderBy, String(banned)).not.toMatch(banned);
    }
  });

  it("accepts only 'newest' and 'a_to_z' and echoes the order it applied", () => {
    expect(body).toMatch(/if p_order is null or p_order not in \('newest', 'a_to_z'\) then\s+raise exception/i);
    expect(sql).toMatch(/order_applied\s+text/i);
    expect(body).toMatch(/m\.created_at,\s*p_order\s*from human_members m/i);
  });

  it("price is a filter, never a sort key, and only approved storefronts are listed", () => {
    expect(body).toMatch(/p_max_price_cents is null or exists/i);
    expect(body).toMatch(/where m\.vetting_state = 'approved'\s+and m\.slug is not null/i);
    expect(body).not.toMatch(/human_member_pii|\bemail\b|legal_name|date_of_birth|h\.handle\b/i);
  });
});
