import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(dir, "20261101193700_email_learnings.sql"), "utf8").replace(/^(begin|commit);$/gm, "");

const BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table public.tenants (id uuid primary key, timezone text not null default 'UTC');
  create table public.tenant_users (tenant_id uuid not null, user_id uuid not null, role text not null, primary key (tenant_id, user_id));
  -- The slice of email_send_results (20261031191100) the trigger, repair and inputs read.
  create table public.email_send_results (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants(id) on delete cascade,
    route text not null default 'mailchimp',
    provider_ref text not null default 'c',
    account_ref jsonb,
    list_id text,
    list_name text,
    subject text not null default '',
    started_at timestamptz not null default now(),
    finished_at timestamptz not null default now(),
    shared_tag boolean not null default false,
    verdict text,
    d7 jsonb not null default '{}'::jsonb,
    d7_published_at timestamptz,
    d7_version int not null default 0,
    constraint email_send_results_tenant_id_id_key unique (tenant_id, id)
  );
  create table public.agent_runs (id uuid primary key, tenant_id uuid not null);
  -- An earlier draft's signatures, as a local apply of it would have left them.
  create function public.request_email_learn_seed(p_tenant_id uuid) returns boolean language sql as $$ select true $$;
  create function public.complete_email_learn_work(p_tenant_id uuid, p_ids jsonb, p_ok boolean, p_error text) returns int language sql as $$ select 0 $$;
  create function public.record_email_learn_sources(p_tenant_id uuid, p_sources jsonb, p_seeded boolean, p_current jsonb) returns void language sql as $$ select $$;
  -- Two tables as the first draft created them (E1): the migration must add
  -- every column a later round added.
  create table public.email_learn_state (tenant_id uuid primary key references public.tenants(id) on delete cascade, last_run_at timestamptz, updated_at timestamptz not null default now());
  create table public.email_learning_reads (run_id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, items jsonb not null, created_at timestamptz not null default now());
`;

const PG_URL = process.env.ZAVI_TEST_VANILLA_PG_URL;
const T = randomUUID();
const OTHER = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();
const VIEWER = randomUUID();

let fp = 0;
const topic = (over: Record<string, unknown> = {}) => ({
  split: "subject_digit",
  route: "mailchimp",
  list_id: "L1",
  list_name: "Newsletter",
  metric: "clicks",
  account_key: "mailchimp:ca-1",
  obs_window: "lifetime",
  holds: true,
  side: "a",
  fingerprint: `fp-${++fp}`,
  text: "Emails with a number in the subject got more clicks.",
  stats: { n_a: 3, n_b: 3, rate_a: 0.04, rate_b: 0.02, side: "a", lift: 1 },
  strength: "early",
  rank: 3,
  ...over,
});

describe.skipIf(!PG_URL)("20261101193700 email learnings, live", () => {
  let db: Client;
  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> => (await db.query(sql, params)).rows[0] as R;
  const r = (sql: string, params: unknown[]) => one<{ r: Record<string, unknown> }>(sql, params).then((x) => x.r);
  const set = (actor: string, action: string, id: string | null, text: string | null, version: number | null, tenant = T) =>
    r("select set_email_learning($1, $2, $3, $4, $5, $6) r", [tenant, actor, action, id, text, version]);
  const apply = (topics: unknown[], connected: string[] | null = ["mailchimp:ca-1"], tenant = T) =>
    r("select apply_email_learn_recompute($1, $2, $3) r", [tenant, JSON.stringify(topics), connected ? JSON.stringify(connected) : null]);
  const lessons = async (tenant = T) =>
    (await db.query<{ id: string; text: string; origin: string; status: string; note: string | null; version: number; cant_recheck: boolean; from_zavi: boolean; side: string | null; stats: Record<string, unknown>; miss_streak: number; hit_streak: number }>(
      "select id, text, origin, status, note, version, cant_recheck, from_zavi, side, stats, miss_streak, hit_streak from email_learnings where tenant_id = $1 order by created_at, id",
      [tenant],
    )).rows;
  const reset = () => db.query("delete from email_learnings where tenant_id = $1", [T]);

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    const exists = await one<{ t: string | null }>("select to_regclass('public.email_send_results')::text t");
    if (exists.t) throw new Error("ZAVI_TEST_VANILLA_PG_URL must be a VANILLA throwaway database");
    await db.query("begin");
    await db.query(BOOTSTRAP);
    await db.query("insert into tenants (id) values ($1), ($2)", [T, OTHER]);
    await db.query("insert into tenant_users values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'viewer')", [T, OWNER, ADMIN, MEMBER, VIEWER]);
    await db.query(SQL);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("must catch: a member only suggests (at most 20 waiting); a viewer changes nothing; an owner edits with the version", async () => {
    const s = await set(MEMBER, "add", null, "Mention free shipping", null);
    expect(s).toMatchObject({ ok: true, status: "suggested" });
    expect(await set(MEMBER, "dismiss", s.id as string, null, 1)).toEqual({ ok: false, code: "not_authorized" });
    expect(await set(VIEWER, "add", null, "A viewer's line", null)).toEqual({ ok: false, code: "not_authorized" });
    expect(await set(ADMIN, "activate", s.id as string, null, 1)).toMatchObject({ ok: true, status: "active", version: 2 });
    const a = await set(OWNER, "add", null, "  Keep   subjects short  ", null);
    expect(a).toMatchObject({ ok: true, status: "active" });
    expect(await set(OWNER, "edit", a.id as string, "Keep subjects under 40 characters", 1)).toMatchObject({ ok: true, version: 2 });
    expect(await set(OWNER, "edit", a.id as string, "Stale tab", 1)).toEqual({ ok: false, code: "card_changed" });
    expect((await lessons()).find((l) => l.id === a.id)?.text).toBe("Keep subjects under 40 characters");
    expect(await set(OWNER, "edit", a.id as string, "x", 2, OTHER)).toEqual({ ok: false, code: "not_authorized" });
    expect(await set(randomUUID(), "add", null, "x", null)).toEqual({ ok: false, code: "not_authorized" });
    for (let i = 0; i < 20; i++) await set(MEMBER, "add", null, `Suggestion ${i}`, null);
    expect(await set(MEMBER, "add", null, "One too many", null)).toEqual({ ok: false, code: "suggestions_full" });
    await reset();
  });

  it("Zavi adds a lesson that held, refreshes it, and only after 2 disagreeing recomputes marks it stale (wording kept)", async () => {
    expect(await apply([topic()])).toMatchObject({ ok: true, added: 1 });
    expect(await apply([topic({ text: "Updated numbers, same side" })])).toMatchObject({ updated: 1 });
    expect(await apply([topic({ holds: false, side: null })])).toMatchObject({ staled: 0 });
    expect((await lessons())[0].status).toBe("active");
    expect(await apply([topic({ holds: false, side: null })])).toMatchObject({ staled: 1 });
    expect((await lessons())[0]).toMatchObject({ status: "stale", note: "Newer results disagree with this.", text: "Updated numbers, same side" });
    await apply([topic()]);
    expect((await lessons())[0].status).toBe("stale");
    expect(await apply([topic()])).toMatchObject({ reactivated: 1 });
    expect((await lessons())[0]).toMatchObject({ status: "active", note: null, side: "a" });
    await reset();
  });

  it("must catch: the OTHER side holding is a disagreement, never agreement; the line is rewritten only after it comes back on the new side", async () => {
    await apply([topic()]);
    expect(await apply([topic({ side: "b", text: "Without a number did better." })])).toMatchObject({ updated: 0 });
    expect((await lessons())[0]).toMatchObject({ status: "active", miss_streak: 1, text: "Emails with a number in the subject got more clicks." });
    expect(await apply([topic({ side: "b", text: "Without a number did better." })])).toMatchObject({ staled: 1 });
    expect((await lessons())[0]).toMatchObject({ status: "stale", text: "Emails with a number in the subject got more clicks.", side: "a" });
    await apply([topic({ side: "b", text: "Without a number did better." })]);
    expect((await lessons())[0].status).toBe("stale");
    expect(await apply([topic({ side: "b", text: "Without a number did better." })])).toMatchObject({ reactivated: 1 });
    expect((await lessons())[0]).toMatchObject({ status: "active", side: "b", text: "Without a number did better.", note: "Results now point the other way; Zavi rewrote this." });
    await reset();
  });

  it("must catch: replaying the SAME evidence moves nothing (no streak advances)", async () => {
    await apply([topic({ fingerprint: "same" })]);
    for (let i = 0; i < 3; i++) await apply([topic({ holds: false, side: null, fingerprint: "same-miss" })]);
    expect((await lessons())[0]).toMatchObject({ status: "active", miss_streak: 1 });
    await reset();
  });

  it("a founder edit makes the line theirs (keeping that Zavi wrote it): never rewritten, a note on disagree, numbers always current; dismissed never returns", async () => {
    await apply([topic()]);
    const [l] = await lessons();
    expect(await set(OWNER, "edit", l.id, "My own words", l.version)).toMatchObject({ ok: true });
    expect((await lessons())[0]).toMatchObject({ origin: "founder", from_zavi: true, text: "My own words" });
    await apply([topic({ holds: false, side: null, stats: { n_a: 4, n_b: 4, side: "a" } })]);
    expect((await lessons())[0]).toMatchObject({ status: "active", text: "My own words", note: "Newer results disagree with this." });
    await apply([topic({ stats: { n_a: 9, n_b: 9, side: "a" } })]);
    expect((await lessons())[0]).toMatchObject({ note: null, stats: expect.objectContaining({ n_a: 9 }) });
    const cur = (await lessons())[0];
    expect(await set(OWNER, "dismiss", cur.id, null, cur.version)).toMatchObject({ ok: true, status: "dismissed" });
    expect(await apply([topic({ text: "Another wording of the same split" })])).toMatchObject({ added: 0 });
    expect((await lessons()).map((x) => x.status)).toEqual(["dismissed"]);
    await reset();
  });

  it("the cap: Zavi makes room only from its own weakest; kept_stronger vs full_skipped; a line staled for room counts no hit that apply", async () => {
    for (let i = 0; i < 11; i++) await set(OWNER, "add", null, `Founder line ${i}`, null);
    await apply([topic({ list_id: "W", rank: 1 })]);
    expect(await apply([topic({ list_id: "V", rank: 0.5 })])).toMatchObject({ added: 0, kept_stronger: 1, skipped_full: 0 });
    expect(await apply([topic({ list_id: "S", rank: 5 }), topic({ list_id: "W", rank: 1 })])).toMatchObject({ added: 1, reactivated: 0 });
    const rows = await lessons();
    const w = rows.find((x) => x.text.startsWith("Emails") && x.status === "stale")!;
    expect(w.note).toBe("Made room for a stronger lesson.");
    expect(w.hit_streak).toBe(0);
    expect(rows.filter((x) => x.status === "active").length).toBe(12);
    const zavi = rows.find((x) => x.origin === "zavi" && x.status === "active")!;
    expect(await set(OWNER, "dismiss", zavi.id, null, zavi.version)).toMatchObject({ ok: true });
    await set(OWNER, "add", null, "Founder line 11", null);
    expect(await set(OWNER, "add", null, "Thirteenth", null)).toEqual({ ok: false, code: "list_full" });
    expect(await apply([topic({ list_id: "X", rank: 99 })])).toMatchObject({ added: 0, skipped_full: 1, kept_stronger: 0 });
    expect(await one("select full_skipped, kept_stronger from email_learn_state where tenant_id = $1", [T])).toEqual({ full_skipped: 1, kept_stronger: 0 });
    await reset();
  });

  it("a lesson whose account is not connected now stays, marked can't re-check", async () => {
    await apply([topic()], ["mailchimp:ca-1"]);
    await apply([], ["klaviyo:other"]);
    expect((await lessons())[0]).toMatchObject({ status: "active", cant_recheck: true });
    await apply([], ["mailchimp:ca-1"]);
    expect((await lessons())[0].cant_recheck).toBe(false);
  });

  it("New is per user; someone outside the workspace reads nothing", async () => {
    const [l] = await lessons();
    const view = async (u: string) => ((await r("select list_email_learnings($1, $2) r", [T, u])).items as Array<{ id: string; is_new: boolean }>).find((x) => x.id === l.id)!.is_new;
    expect(await view(OWNER)).toBe(true);
    expect(await one("select mark_email_learnings_seen($1, $2, $3) n", [T, OWNER, JSON.stringify([{ id: l.id, version: l.version }])])).toEqual({ n: 1 });
    expect(await view(OWNER)).toBe(false);
    expect(await view(ADMIN)).toBe(true);
    await apply([topic({ text: "Reworded after new results" })]);
    expect(await view(OWNER)).toBe(true);
    expect(await r("select list_email_learnings($1, $2) r", [T, randomUUID()])).toEqual({ items: [], dismissed: 0, state: null });
    await reset();
  });

  it("must catch: a day-7 publish or bump writes ONE work row; repair fills a gap; a claim spends no attempt; a release spends none; a failure does", async () => {
    const id = (await one<{ id: string }>("insert into email_send_results (tenant_id) values ($1) returning id", [T])).id;
    await db.query("update email_send_results set d7_published_at = now(), d7_version = 1 where id = $1", [id]);
    await db.query("update email_send_results set d7_version = 2 where id = $1", [id]);
    await db.query("update email_send_results set d7_version = 2 where id = $1", [id]);
    const keys = (await db.query("select dedupe_key from email_learn_work where tenant_id = $1 order by dedupe_key", [T])).rows.map((x) => x.dedupe_key);
    expect(keys).toEqual([`result:${id}:1`, `result:${id}:2`]);
    await db.query("alter table email_send_results disable trigger email_learn_on_result");
    const old = (await one<{ id: string }>("insert into email_send_results (tenant_id, d7_published_at, d7_version) values ($1, now(), 3) returning id", [T])).id;
    await db.query("alter table email_send_results enable trigger email_learn_on_result");
    expect(await one("select repair_email_learn_work(100) n")).toEqual({ n: 1 });
    expect(await one("select repair_email_learn_work(100) n")).toEqual({ n: 0 });
    expect(await one("select request_email_learn_seed($1, 'aaaa1111') a", [T])).toEqual({ a: "queued" });
    expect(await one("select request_email_learn_seed($1, 'aaaa1111') b", [T])).toEqual({ b: "pending" });
    expect(await one("select request_email_learn_seed($1, 'bbbb2222') c", [T])).toEqual({ c: "queued" });
    expect(await one("select request_email_learn_seed($1, 'not a hash') x", [T])).toEqual({ x: "refused" });
    expect(await one("select seed_requested_at is not null s from email_learn_state where tenant_id = $1", [T])).toEqual({ s: true });
    await db.query("update email_learn_work set due_at = now() - interval '1 minute' where tenant_id = $1", [T]);
    const claimed = (await r("select claim_email_learn_work(50, 600) r", [])) as unknown as Array<{ id: string; dedupe_key: string; lease_token: string; attempts: number }>;
    expect(claimed.length).toBe(5);
    expect(claimed.every((c) => c.attempts === 0)).toBe(true);
    expect(await r("select claim_email_learn_work(50, 600) r", [])).toEqual([]);
    expect(await one("select extend_email_learn_lease($1, $2, 600) ok", [T, JSON.stringify(claimed)])).toEqual({ ok: true });
    expect(await one("select extend_email_learn_lease($1, $2, 600) ok", [OTHER, JSON.stringify(claimed)])).toEqual({ ok: false });
    const [a, b, ...rest] = claimed;
    expect(await one("select complete_email_learn_work($1, $2, 'released', null) n", [T, JSON.stringify([a])])).toEqual({ n: 1 });
    expect(await one("select complete_email_learn_work($1, $2, 'failed', 'boom') n", [T, JSON.stringify([b])])).toEqual({ n: 1 });
    expect(await one("select attempts, state from email_learn_work where id = $1", [a.id])).toEqual({ attempts: 0, state: "pending" });
    expect(await one("select attempts, state from email_learn_work where id = $1", [b.id])).toEqual({ attempts: 1, state: "pending" });
    expect(await one("select complete_email_learn_work($1, $2, 'done', null) n", [OTHER, JSON.stringify(rest)])).toEqual({ n: 0 });
    expect(await one("select complete_email_learn_work($1, $2, 'done', null) n", [T, JSON.stringify(rest)])).toEqual({ n: 3 });
    await db.query("update email_learn_work set attempts = 5, lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes' where id = $1", [b.id]);
    const tok = (await one<{ t: string }>("select lease_token::text t from email_learn_work where id = $1", [b.id])).t;
    await one("select complete_email_learn_work($1, $2, 'failed', 'boom') n", [T, JSON.stringify([{ id: b.id, lease_token: tok }])]);
    expect(await one("select state from email_learn_work where id = $1", [b.id])).toEqual({ state: "gave_up" });
  });

  it("must catch (security): opening the list never revives a failed read nor resets its attempts, for anyone", async () => {
    const h = "dddd4444";
    const key = `%:${h}`;
    expect(await one("select request_email_learn_seed($1, $2) a", [T, h])).toEqual({ a: "queued" });
    await db.query("update email_learn_work set state = 'gave_up', attempts = 6, last_error = 'x' where tenant_id = $1 and dedupe_key like $2", [T, key]);
    for (let i = 0; i < 3; i++) expect(await one("select request_email_learn_seed($1, $2) a", [T, h])).toEqual({ a: "failed_today" });
    expect(await one("select state, attempts from email_learn_work where tenant_id = $1 and dedupe_key like $2", [T, key])).toEqual({ state: "gave_up", attempts: 6 });
    await db.query("update email_learn_work set state = 'pending', attempts = 2, due_at = now() + interval '30 minutes' where tenant_id = $1 and dedupe_key like $2", [T, key]);
    expect(await one("select request_email_learn_seed($1, $2) a", [T, h])).toEqual({ a: "failed_today" });
    expect(await one("select attempts, due_at > now() later from email_learn_work where tenant_id = $1 and dedupe_key like $2", [T, key])).toEqual({ attempts: 2, later: true });
    expect(await one("select retry_email_learn_seed($1, $2, $3) a", [T, MEMBER, h])).toEqual({ a: "not_authorized" });
    expect(await one("select retry_email_learn_seed($1, $2, $3) a", [T, VIEWER, h])).toEqual({ a: "not_authorized" });
    expect(await one("select retry_email_learn_seed($1, $2, $3) a", [OTHER, OWNER, h])).toEqual({ a: "not_authorized" });
    expect(await one("select attempts from email_learn_work where tenant_id = $1 and dedupe_key like $2", [T, key])).toEqual({ attempts: 2 });
  });

  it("must catch (security): Look again (owner or admin) revives today's failed read once a day; a second the same day is refused", async () => {
    const h = "cccc3333";
    const key = `%:${h}`;
    await db.query("update email_learn_state set last_revived_at = null where tenant_id = $1", [T]);
    expect(await one("select retry_email_learn_seed($1, $2, $3) a", [T, OWNER, h])).toEqual({ a: "queued" });
    expect(await one("select last_revived_at is null n from email_learn_state where tenant_id = $1", [T])).toEqual({ n: true });
    await db.query("update email_learn_work set state = 'gave_up', attempts = 6, last_error = 'x' where tenant_id = $1 and dedupe_key like $2", [T, key]);
    expect(await one("select retry_email_learn_seed($1, $2, $3) a", [T, ADMIN, h])).toEqual({ a: "queued" });
    expect(await one("select state, attempts, due_at <= now() due, lease_token is null free from email_learn_work where tenant_id = $1 and dedupe_key like $2", [T, key])).toEqual({ state: "pending", attempts: 0, due: true, free: true });
    await db.query("update email_learn_work set state = 'gave_up', attempts = 6 where tenant_id = $1 and dedupe_key like $2", [T, key]);
    expect(await one("select retry_email_learn_seed($1, $2, $3) a", [T, OWNER, h])).toEqual({ a: "already_retried_today" });
    expect(await one("select state, attempts from email_learn_work where tenant_id = $1 and dedupe_key like $2", [T, key])).toEqual({ state: "gave_up", attempts: 6 });
    await db.query("update email_learn_state set last_revived_at = now() - interval '1 day' where tenant_id = $1", [T]);
    expect(await one("select retry_email_learn_seed($1, $2, $3) a", [T, OWNER, h])).toEqual({ a: "queued" });
    await db.query("update email_learn_work set state = 'done' where tenant_id = $1 and dedupe_key like $2", [T, key]);
    expect(await one("select retry_email_learn_seed($1, $2, $3) a", [T, OWNER, h])).toEqual({ a: "done" });
  });

  it("must catch E1: tables the first draft created get every later column", async () => {
    const cols = async (t: string) => (await db.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [t])).rows.map((r) => r.column_name);
    expect(await cols("email_learn_state")).toEqual(expect.arrayContaining(["full_skipped", "kept_stronger", "sources", "seeded_at", "seed_requested_at", "last_revived_at"]));
    expect(await cols("email_learning_reads")).toEqual(expect.arrayContaining(["status"]));
    expect(await cols("email_learnings")).toEqual(expect.arrayContaining(["side", "evidence_fp", "streak_side", "from_zavi"]));
  });

  it("stale overloads from an earlier draft are gone", async () => {
    expect(await one("select count(*)::int n from pg_proc where proname = 'request_email_learn_seed'")).toEqual({ n: 1 });
    expect(await one("select count(*)::int n from pg_proc where proname = 'complete_email_learn_work'")).toEqual({ n: 1 });
    expect(await one("select count(*)::int n from pg_proc where proname = 'record_email_learn_sources'")).toEqual({ n: 1 });
  });

  it("the sources keep only accounts connected now, and prune only when every connection was told (E2)", async () => {
    await one("select record_email_learn_sources($1, $2, false, $3, true)", [T, JSON.stringify({ "mailchimp:a": { status: "ok" }, "klaviyo:b": { status: "ok" } }), JSON.stringify(["mailchimp:a", "klaviyo:b"])]);
    await one("select record_email_learn_sources($1, '{}', false, $2, false)", [T, JSON.stringify(["klaviyo:b"])]);
    expect(await one("select sources from email_learn_state where tenant_id = $1", [T])).toEqual({ sources: { "mailchimp:a": { status: "ok" }, "klaviyo:b": { status: "ok" } } });
    await one("select record_email_learn_sources($1, '{}', true, $2, true)", [T, JSON.stringify(["klaviyo:b"])]);
    expect(await one("select sources from email_learn_state where tenant_id = $1", [T])).toEqual({ sources: { "klaviyo:b": { status: "ok" } } });
  });

  it("must catch: a stale lesson coming back on a full list follows the same rule (replaces Zavi's weakest only if stronger)", async () => {
    await apply([topic({ list_id: "R", rank: 9 })]);
    await apply([topic({ list_id: "R", holds: false, side: null })]);
    await apply([topic({ list_id: "R", holds: false, side: null })]);
    for (let i = 0; i < 10; i++) await set(OWNER, "add", null, `Founder line ${i}`, null);
    await apply([topic({ list_id: "W", rank: 1 })]);
    await set(OWNER, "add", null, "Founder line 10", null);
    expect((await lessons()).filter((x) => x.status === "active").length).toBe(12);
    await apply([topic({ list_id: "R", rank: 9, list_name: "Renamed list" })]);
    expect(await apply([topic({ list_id: "R", rank: 9, list_name: "Renamed list" })])).toMatchObject({ reactivated: 1 });
    const rows = await lessons();
    expect(rows.find((x) => x.text.startsWith("Emails") && x.status === "active" && x.stats.rank === 9)).toBeTruthy();
    expect(rows.filter((x) => x.status === "active").length).toBe(12);
    expect((await one<{ n: string }>("select list_name n from email_learnings where tenant_id = $1 and list_id = 'R'", [T])).n).toBe("Renamed list");
    await reset();
  });

  it("the recompute's inputs are capped per stratum in SQL: 30 per (route, account, list), 20 per (account, tool)", async () => {
    const t2 = OTHER;
    for (let i = 0; i < 35; i++) {
      await db.query(
        "insert into email_send_results (tenant_id, list_id, account_ref, finished_at, d7_published_at, verdict) values ($1, 'BUSY', $2, now() - make_interval(hours => $3), now(), 'beat')",
        [t2, JSON.stringify({ kind: "composio", connected_account_id: "ca", auth_config_id: "ac" }), i],
      );
    }
    for (let i = 0; i < 3; i++) {
      await db.query(
        "insert into email_send_results (tenant_id, list_id, account_ref, finished_at, d7_published_at, verdict) values ($1, 'QUIET', $2, now() - interval '100 days', now(), 'beat')",
        [t2, JSON.stringify({ kind: "composio", connected_account_id: "ca", auth_config_id: "ac" })],
      );
    }
    for (let i = 0; i < 25; i++) {
      await db.query(
        "insert into email_learn_observations (tenant_id, account_key, route, campaign_id, obs_window, list_id, sent_at, delivered, clicks) values ($1, 'mailchimp:ca:ac', 'mailchimp', $2, 'lifetime', 'L', now() - make_interval(days => $3), 100, 3)",
        [t2, `c${i}`, i],
      );
    }
    const inputs = await r("select email_learn_inputs($1) r", [t2]);
    const results = inputs.results as Array<{ list_id: string }>;
    expect(results.filter((x) => x.list_id === "BUSY").length).toBe(30);
    expect(results.filter((x) => x.list_id === "QUIET").length).toBe(3);
    expect((inputs.observations as unknown[]).length).toBe(20);
  });

  it("a run's read carries its status; another workspace reads nothing", async () => {
    const run = randomUUID();
    await db.query("insert into agent_runs values ($1, $2)", [run, T]);
    await one("select record_email_learning_read($1, $2, 'ok', $3)", [T, run, JSON.stringify([{ id: "x", text: "y" }])]);
    expect(await r("select get_email_learning_read($1, $2) r", [T, run])).toEqual({ status: "ok", items: [{ id: "x", text: "y" }] });
    expect(await r("select get_email_learning_read($1, $2) r", [OTHER, run])).toBeNull();
    const empty = randomUUID();
    await db.query("insert into agent_runs values ($1, $2)", [empty, T]);
    await one("select record_email_learning_read($1, $2, 'empty', '[]')", [T, empty]);
    expect(await r("select get_email_learning_read($1, $2) r", [T, empty])).toEqual({ status: "empty", items: [] });
    expect(await one("select record_email_learning_read($1, $2, 'made_up', '[]') ok", [T, run])).toEqual({ ok: false });
    expect(await one("select record_email_learning_read($1, $2, 'ok', '[]') ok", [OTHER, run])).toEqual({ ok: false });
    expect(await one("select record_email_learning_read($1, $2, 'ok', '[]') ok", [T, randomUUID()])).toEqual({ ok: false });
    expect(await r("select get_email_learning_read($1, $2) r", [T, run])).toEqual({ status: "ok", items: [{ id: "x", text: "y" }] });
  });

  it("service role only, on every table and RPC", async () => {
    for (const t of ["email_learnings", "email_learn_observations", "email_learning_seen", "email_learning_reads", "email_learn_work", "email_learn_state"]) {
      expect(await one("select has_table_privilege('authenticated', $1, 'select') a, has_table_privilege('anon', $1, 'select') b", [t]), t).toEqual({ a: false, b: false });
    }
    for (const f of [
      "set_email_learning(uuid,uuid,text,uuid,text,int)",
      "apply_email_learn_recompute(uuid,jsonb,jsonb)",
      "claim_email_learn_work(int,int)",
      "complete_email_learn_work(uuid,jsonb,text,text)",
      "extend_email_learn_lease(uuid,jsonb,int)",
      "request_email_learn_seed(uuid,text)",
      "email_learn_inputs(uuid)",
      "record_email_learn_sources(uuid,jsonb,boolean,jsonb,boolean)",
      "retry_email_learn_seed(uuid,uuid,text)",
      "list_email_learnings(uuid,uuid)",
    ]) {
      expect(await one("select has_function_privilege('authenticated', $1, 'execute') a, has_function_privilege('service_role', $1, 'execute') s", [f]), f).toEqual({ a: false, s: true });
    }
  });
});
