import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = (f: string) => readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, "");
const loose = (s: string) => `set check_function_bodies = off;\n${s}\nset check_function_bodies = on;`;
const asShippedBeforeTheInPlaceEdit = () => sql("20261031191100_email_send_results.sql").replaceAll(", 'email_paused')", ")");

describe.skipIf(!PGLITE_MODULES)("20261111100100 a database that ran 20261031191100 before it was edited in place learns 'email_paused' (pglite)", () => {
  let db: Db;
  let before: string;
  const one = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
  const src = async (fn: string) => (await one("select prosrc s from pg_proc where proname = $1", [fn])).s as string;

  beforeAll(async () => {
    db = await bootEmailPipeline([]);
    await db.query("insert into tenants values ($1)", [T]);
    await db.exec(loose(asShippedBeforeTheInPlaceEdit()));
    before = (await src("email_results_missing")) + (await src("start_email_send_result"));
    await db.exec(sql("20261111100100_email_paused_hold_reason_forward.sql"));
  }, 120_000);
  afterAll(async () => db?.close());

  const heldSend = async (reason: string) => {
    const list = randomUUID();
    const version = randomUUID();
    await db.query("insert into email_lists (id, tenant_id, name) values ($1, $2, $3)", [list, T, `List ${list}`]);
    await db.query(
      "insert into email_list_versions (id, tenant_id, list_id, source_kind, consent_text, consent_confirmed_by, consent_confirmed_at) values ($1, $2, $3, 'csv', 'yes', $4, now())",
      [version, T, list, OWNER],
    );
    await db.query("select set_config('zavi.email_card_approve', 'on', false)");
    const decision = (await one(
      "insert into decisions (tenant_id, decision_class, body, status, approved_by) values ($1, 'bulk_outbound.send', $2, 'acted', $3) returning id",
      [T, JSON.stringify({ list_id: list, list_version_id: version }), OWNER],
    )).id as string;
    await db.query("select set_config('zavi.email_card_approve', '', false)");
    const send = (await one(
      "insert into email_bulk_sends (tenant_id, decision_id, list_id, list_version_id, subject, body_text, from_address, total, sent, status, hold_reason) values ($1, $2, $3, $4, 'S', 'Body', 'hi@example.test', 3, 2, 'held', $5) returning id",
      [T, decision, list, version, reason],
    )).id as string;
    return { decision, send };
  };
  const missing = async () => (await db.query("select card_id from email_results_missing(now() - interval '1 day', 100)")).rows.map((x) => x.card_id);
  const start = async (decision: string, send: string) =>
    (await one("select start_email_send_result($1, 'decisions', $2, $3) r", [
      T,
      decision,
      JSON.stringify({ route: "zavi_list", provider_ref: send, sent_count: 2, finished_at: new Date().toISOString() }),
    ])).r;

  it("the starting point really is the pre-edit function bodies", () => {
    expect(before).not.toContain("email_paused");
  });

  it("a send held by the workspace pause is not a missing result, cannot start one, and writes no results row", async () => {
    const { decision, send } = await heldSend("email_paused");
    expect(await missing()).not.toContain(decision);
    expect(await start(decision, send)).toMatchObject({ ok: false, code: "not_final" });
    expect((await one("select count(*)::int n from email_send_results where card_id = $1", [decision])).n).toBe(0);
  });

  it("the other resumable holds keep their meaning and a terminal hold still becomes a result", async () => {
    const resumable = await heldSend("provider_refused");
    expect(await missing()).not.toContain(resumable.decision);
    const terminal = await heldSend("list_too_big");
    expect(await missing()).toContain(terminal.decision);
  });

  it("is re-runnable", async () => {
    await db.exec(sql("20261111100100_email_paused_hold_reason_forward.sql"));
    expect(await src("email_results_missing")).toContain("email_paused");
    expect(await src("start_email_send_result")).toContain("email_paused");
  });
});
