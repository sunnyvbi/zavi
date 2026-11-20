import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const T = randomUUID();
const OWNER = randomUUID();
const sha = (html: string, text: string) => createHash("sha256").update("email-r1").update("\0").update(html).update("\0").update(text).digest("hex");
const v = (n: number) => ({ content: { subject: `Subject ${n}` }, html: `<p>v${n}</p>`, text: `v${n}`, render_sha: sha(`<p>v${n}</p>`, `v${n}`) });
const listBody = (list: string) => ({ list_id: list, list_version_id: randomUUID(), variants: [v(1)], template_snapshot: { brand_color: "#2e7d32" }, renderer_version: "email-r1", chosen_variant: 1, approved_count: 3 });

describe.skipIf(!PGLITE_MODULES)("20261111110000 the released sweep names the email pause (pglite)", () => {
  let db: Db;
  const r = async (sql: string, p: unknown[] = []) => (await db.query<{ r: any }>(sql, p)).rows[0].r;
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
  const released = async (reason: string, approvedAgo: string) => {
    const list = randomUUID();
    await db.query(`select set_config('zavi.email_card_approve', 'on', false)`);
    const id = (await one(
      `insert into decisions (tenant_id, decision_class, body, status, approved_by, approved_at, dispatched_at)
       values ($1, 'bulk_outbound.send', $2, 'dispatching', $3, now() - $4::interval, now() - $4::interval) returning id`,
      [T, JSON.stringify(listBody(list)), OWNER, approvedAgo],
    )).id as string;
    await db.query(`select set_config('zavi.email_card_approve', '', false)`);
    await db.query("insert into email_send_reservations (tenant_id, list_key, card_rail, card_id, source) values ($1, $2, 'decisions', $3, null)", [T, `zavi_list:${list}`, id]);
    await db.query("update decisions set status = 'proposed', dispatch_error = $2 where id = $1", [id, reason]);
    return id;
  };
  const sweep = async () => (await r("select email_redispatch_released_sweep(200) r")) as Array<Record<string, unknown>>;
  const error = async (id: string) => (await one("select status, dispatch_error from decisions where id = $1", [id])) as { status: string; dispatch_error: string };

  beforeAll(async () => {
    db = await bootEmailPipeline(["20261108100000_email_send_pause.sql", "20261108100100_email_card_takeover_and_redispatch.sql", "20261111110000_email_released_sweep_names_pause.sql"]);
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("an approval held by the pause for over a day is dropped with a reason that names the pause, even once email is back on", async () => {
    await r("select set_email_pause($1, $2, true) r", [T, OWNER]);
    const held = await released("email_paused", "2 days");
    await r("select set_email_pause($1, $2, false) r", [T, OWNER]);
    const out = await sweep();
    expect(out.find((x) => x.decision_id === held)).toMatchObject({ action: "expired", paused: true });
    const d = await error(held);
    expect(d.status).toBe("dispatch_failed");
    expect(d.dispatch_error).toMatch(/Email was paused for this workspace, so Zavi held this send/);
    expect(d.dispatch_error).not.toMatch(/could not start this send/);
    expect(await one("select state from email_send_reservations where card_id = $1", [held])).toEqual({ state: "released" });
  });

  it("an approval released for another reason while email is paused now also says it was the pause that held it", async () => {
    const held = await released("fleet_halted", "2 days");
    await r("select set_email_pause($1, $2, true) r", [T, OWNER]);
    const out = await sweep();
    await r("select set_email_pause($1, $2, false) r", [T, OWNER]);
    expect(out.find((x) => x.decision_id === held)).toMatchObject({ action: "expired", paused: true });
    expect((await error(held)).dispatch_error).toMatch(/Email was paused/);
  });

  it("an approval that simply never started keeps the plain reason and is not called paused", async () => {
    const stale = await released("fleet_halted", "2 days");
    const out = await sweep();
    expect(out.find((x) => x.decision_id === stale)).toMatchObject({ action: "expired", paused: false });
    expect((await error(stale)).dispatch_error).toBe("Zavi could not start this send within a day of its approval, so it did not send it. Ask Zavi for a new draft.");
  });

  it("a held approval younger than a day stays held while paused and goes again once email resumes", async () => {
    await r("select set_email_pause($1, $2, true) r", [T, OWNER]);
    const young = await released("email_paused", "1 hour");
    expect((await sweep()).find((x) => x.decision_id === young)).toBeUndefined();
    expect((await error(young)).status).toBe("proposed");
    await r("select set_email_pause($1, $2, false) r", [T, OWNER]);
    expect((await sweep()).find((x) => x.decision_id === young)).toMatchObject({ action: "redispatch" });
    expect((await error(young)).status).toBe("approved");
  });
});
