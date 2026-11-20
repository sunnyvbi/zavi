import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PG_URL = process.env.ZAVI_TEST_PG_URL;
const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const files = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const noComments = (s: string) => s.replace(/--[^\n]*/g, "");
const noFks = (s: string) =>
  s
    .replace(/references\s+[a-z_.]+\s*(\([^)]*\))?(\s+on delete (cascade|set null|restrict))?/gi, "")
    .replace(/,\s*(constraint\s+\w+\s+)?foreign key\s*\([^)]*\)[^,)]*/gi, "");

function tableDdl(table: string): string[] {
  let create: string | null = null;
  const alters: string[] = [];
  for (const f of files()) {
    const s = noComments(read(f));
    const m = create === null ? new RegExp(`create table (if not exists )?(public\\.)?${table}\\s*\\(`).exec(s) : null;
    if (m) {
      let depth = 0;
      let j = m.index + m[0].length - 1;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      create = s.slice(m.index, j + 1);
    }
    for (const a of s.matchAll(new RegExp(`alter table (if exists )?(public\\.)?${table}\\b([\\s\\S]*?);`, "g"))) {
      if (/add column|add constraint|drop constraint|alter column/.test(a[3]) && !/%I|foreign key/i.test(a[3])) {
        alters.push(`alter table ${table} ${a[3].trim()};`);
      }
    }
  }
  if (!create) throw new Error(`${table}: no create table in migrations`);
  return [noFks(create), ...alters.map(noFks)].map((s) => s.replace(/\bpublic\./g, ""));
}

const SCHEMA = `zz_hypq_${Math.random().toString(36).slice(2, 10)}`;
function latestFunction(name: string): string {
  const hit = files().filter((f) => read(f).includes(`create or replace function ${name}(`)).pop();
  if (!hit) throw new Error(`${name} defined in no migration`);
  const sql = read(hit);
  const s = sql.indexOf(`create or replace function ${name}(`);
  const a = sql.indexOf("$$", s);
  const b = sql.indexOf("$$", a + 2);
  return sql.slice(s, sql.indexOf(";", b) + 1).replace(/search_path = public, pg_temp/, `search_path = ${SCHEMA}, pg_temp`);
}

function grants(name: string): string[] {
  const hit = files().filter((f) => read(f).includes(`create or replace function ${name}(`)).pop()!;
  return read(hit)
    .split("\n")
    .filter((l) => /^(revoke|grant) /.test(l) && l.includes(`on function ${name}(`));
}

const T = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const G = "00000000-0000-4000-8000-0000000000d1";
const H = "00000000-0000-4000-8000-0000000000e1";
const Q = "00000000-0000-4000-8000-0000000000f1";
const CLAIM = "Most hosts cancel bookings renters already paid for";

describe.skipIf(!PG_URL)("the founder's answer about a hypothesis (live SQL)", () => {
  const db = new Client({ connectionString: PG_URL });

  beforeAll(async () => {
    await db.connect();
    await db.query("begin");
    await db.query(`create schema ${SCHEMA}`);
    await db.query(`set local search_path = ${SCHEMA}, public`);
    for (const r of ["anon", "authenticated", "service_role"]) {
      await db.query(`do $$ begin create role ${r}; exception when others then null; end $$;`);
    }
    for (const t of ["cgo_hypotheses", "cgo_questions"]) {
      for (const stmt of tableDdl(t)) {
        await db.query("savepoint ddl");
        try {
          await db.query(stmt);
        } catch (e) {
          if (!["42P07", "42710", "42701"].includes((e as { code?: string }).code ?? "")) throw e;
          await db.query("rollback to savepoint ddl");
        }
      }
    }
    const mig = read(files().filter((f) => read(f).includes("cgo_questions_one_open_hypothesis")).pop()!);
    const at = mig.indexOf("create unique index if not exists cgo_questions_one_open_hypothesis");
    await db.query(mig.slice(at, mig.indexOf(";", at) + 1));
    for (const fn of ["answer_hypothesis_question", "undo_hypothesis_answer"]) {
      await db.query(latestFunction(fn));
      for (const g of grants(fn)) await db.query(g);
    }
  });
  afterAll(async () => {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  });

  beforeEach(async () => {
    await db.query("delete from cgo_questions; delete from cgo_hypotheses;");
    await db.query(
      `insert into cgo_hypotheses (id, tenant_id, goal_id, problem, claim, status, evidence, evidence_version, status_at)
       values ($1, $2, $3, 'retention', $4, 'testing', $5, 3, '2026-10-01T00:00:00Z')`,
      [H, T, G, CLAIM, JSON.stringify([{ at: "2026-10-01T00:00:00Z", kind: "cgo_read", ref: "r1", excerpt: "12 cancellations last week" }])],
    );
    await db.query(
      `insert into cgo_questions (id, tenant_id, topic_key, ask, status, asked_at, expires_at, on_yes)
       values ($1, $2, $3, $4, 'open', now(), now() + interval '3 days', $5)`,
      [Q, T, `hyp:${H}`, `Is this true for your business: ${CLAIM}?`, JSON.stringify({ kind: "hypothesis_check", hypothesis_id: H, goal_id: G, claim: CLAIM })],
    );
  });

  const answer = async (kind: string, ans: string, words: string | null = null, tenant = T) =>
    (await db.query(`select answer_hypothesis_question($1, $2, $3, $4, $5, 'web', null) r`, [tenant, Q, kind, ans, words])).rows[0].r as Record<string, unknown>;
  const hyp = async () => (await db.query(`select status, evidence, evidence_version, status_at from cgo_hypotheses where id = $1`, [H])).rows[0];
  const question = async () => (await db.query(`select status, answer, applied_line, on_yes from cgo_questions where id = $1`, [Q])).rows[0];

  it("a one-tap yes confirms the hypothesis and answers the question together", async () => {
    expect(await answer("yes", "yes")).toMatchObject({ outcome: "applied", status: "confirmed", prior_status: "testing" });
    const h = await hyp();
    expect(h.status).toBe("confirmed");
    expect(h.evidence_version).toBe(4);
    expect(new Date(h.status_at).getTime()).toBeGreaterThan(new Date("2026-10-02").getTime());
    expect(h.evidence.at(-1)).toMatchObject({ kind: "founder", ref: Q, verdict: "confirmed", checker: "founder" });
    const q = await question();
    expect(q).toMatchObject({ status: "answered", answer: "yes" });
    expect(q.applied_line).toContain(CLAIM);
    expect(q.on_yes).toMatchObject({ prior_status: "testing", written_version: 4 });
  });

  it("a one-tap no rules it out; own words add unjudged evidence and leave the status", async () => {
    expect(await answer("no", "no")).toMatchObject({ outcome: "applied", status: "ruled_out" });
    expect((await hyp()).status).toBe("ruled_out");

    await db.query("update cgo_hypotheses set status = 'testing' where id = $1", [H]);
    await db.query("update cgo_questions set status = 'open' where id = $1", [Q]);
    expect(await answer("words", "My words: only on weekends", "only on   weekends")).toMatchObject({ outcome: "applied", status: "testing" });
    const last = (await hyp()).evidence.at(-1);
    expect(last).toMatchObject({ kind: "founder", excerpt: "The founder wrote: only on weekends" });
    expect(last.verdict).toBeUndefined();
    expect((await question()).applied_line).toContain("Saved your words");
  });

  it("a hypothesis re-worded, closed or gone since the ask: nothing moves, the question is withdrawn", async () => {
    await db.query("update cgo_hypotheses set claim = 'Hosts cancel on weekends' where id = $1", [H]);
    expect(await answer("yes", "yes")).toEqual({ outcome: "stale", reason: "reworded" });
    expect((await hyp()).status).toBe("testing");
    expect((await question()).status).toBe("withdrawn");

    await db.query("update cgo_hypotheses set claim = $2, status = 'ruled_out' where id = $1", [H, CLAIM]);
    await db.query("update cgo_questions set status = 'open' where id = $1", [Q]);
    expect(await answer("yes", "yes")).toEqual({ outcome: "stale", reason: "ruled_out" });
    expect((await hyp()).status).toBe("ruled_out");

    await db.query("delete from cgo_hypotheses");
    await db.query("update cgo_questions set status = 'open' where id = $1", [Q]);
    expect(await answer("yes", "yes")).toEqual({ outcome: "stale", reason: "gone" });
  });

  it("only the tenant's own open question: another tenant, or a second answer, changes nothing", async () => {
    expect(await answer("yes", "yes", null, OTHER)).toEqual({ outcome: "not_open" });
    expect((await hyp()).status).toBe("testing");
    await answer("no", "no");
    expect(await answer("yes", "yes")).toEqual({ outcome: "not_open" });
    expect((await hyp()).status).toBe("ruled_out");
  });

  it("the newest 40 evidence entries are kept, and undo puts back the one the answer pushed out", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ at: "2026-10-01T00:00:00Z", kind: "cgo_read", ref: `r${i}`, excerpt: `e${i}` }));
    await db.query("update cgo_hypotheses set evidence = $2 where id = $1", [H, JSON.stringify(many)]);
    await answer("yes", "yes");
    const ev = (await hyp()).evidence;
    expect(ev).toHaveLength(40);
    expect(ev[0].ref).toBe("r1");
    expect(ev.at(-1).kind).toBe("founder");
    await db.query(`select undo_hypothesis_answer($1, $2)`, [T, Q]);
    expect((await hyp()).evidence).toEqual(many);
  });

  it("the cap never drops an earlier founder answer, and undo puts the evicted entry back in its place", async () => {
    const older = { at: "2026-09-01T00:00:00Z", kind: "founder", ref: "q-old", excerpt: "The founder wrote: weekends only" };
    const many = [older, ...Array.from({ length: 39 }, (_, i) => ({ at: "2026-10-01T00:00:00Z", kind: "cgo_read", ref: `r${i}`, excerpt: `e${i}` }))];
    await db.query("update cgo_hypotheses set evidence = $2 where id = $1", [H, JSON.stringify(many)]);
    await answer("yes", "yes");
    const ev = (await hyp()).evidence;
    expect(ev).toHaveLength(40);
    expect(ev[0]).toEqual(older);
    expect(ev.some((e: { ref: string }) => e.ref === "r0")).toBe(false);
    await db.query(`select undo_hypothesis_answer($1, $2)`, [T, Q]);
    expect((await hyp()).evidence).toEqual(many);
  });

  it("a malformed question is closed as stale, never left open by a thrown cast", async () => {
    await db.query("update cgo_questions set on_yes = jsonb_set(on_yes, '{hypothesis_id}', '\"not-a-uuid\"') where id = $1", [Q]);
    expect(await answer("yes", "yes")).toEqual({ outcome: "stale", reason: "gone" });
    expect((await question()).status).toBe("withdrawn");
  });

  it("only one hypothesis question is open per tenant (the losing insert is a duplicate)", async () => {
    const insert = (id: string, tenant = T) =>
      db.query(
        `insert into cgo_questions (id, tenant_id, topic_key, ask, status, asked_at, expires_at, on_yes) values ($1, $2, $3, 'Is this true?', 'open', now(), now() + interval '3 days', '{"kind":"hypothesis_check"}')`,
        [id, tenant, `hyp:${id}`],
      );
    await db.query("savepoint dup");
    const err = (await insert("00000000-0000-4000-8000-0000000000f2").then(
      () => null,
      (e: unknown) => e as { code?: string },
    ));
    await db.query("rollback to savepoint dup");
    expect(err?.code).toBe("23505");
    await insert("00000000-0000-4000-8000-0000000000f3", OTHER);
  });

  it("undo restores the prior status and drops that answer, only at the version the answer wrote", async () => {
    await answer("yes", "yes");
    const undo = async () => (await db.query(`select undo_hypothesis_answer($1, $2) r`, [T, Q])).rows[0].r as Record<string, unknown>;
    expect(await undo()).toEqual({ outcome: "undone", claim: CLAIM });
    const h = await hyp();
    expect(h.status).toBe("testing");
    expect(h.evidence.some((e: { kind: string }) => e.kind === "founder")).toBe(false);
    expect(await question()).toMatchObject({ status: "withdrawn", applied_line: null });
    expect(await undo()).toEqual({ outcome: "nothing" });

    await db.query("update cgo_questions set status = 'open', on_yes = on_yes - 'undone_at' - 'written_version' where id = $1", [Q]);
    await answer("no", "no");
    await db.query("update cgo_hypotheses set evidence_version = evidence_version + 1 where id = $1", [H]);
    expect(await undo()).toEqual({ outcome: "changed" });
    expect((await hyp()).status).toBe("ruled_out");
  });

  it("the functions are the service role's only", async () => {
    const r = await db.query(
      `select has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proname in ('answer_hypothesis_question', 'undo_hypothesis_answer')`,
      [SCHEMA],
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row).toEqual({ auth: false, svc: true });
  });
});
