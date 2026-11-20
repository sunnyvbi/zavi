import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";
import { founderSendError } from "@/services/email-cards/cards";
import { RELEASED_SENDER_STOPPED_REASON } from "@/services/email-cards/recovery";

const T = randomUUID();
const OWNER = randomUUID();
const sha = (html: string, text: string) => createHash("sha256").update("email-r1").update("\0").update(html).update("\0").update(text).digest("hex");
const v = (n: number) => ({ content: { subject: `Subject ${n}` }, html: `<p>v${n}</p>`, text: `v${n}`, render_sha: sha(`<p>v${n}</p>`, `v${n}`) });
const listBody = (list: string) => ({ list_id: list, list_version_id: randomUUID(), variants: [v(1)], template_snapshot: { brand_color: "#2e7d32" }, renderer_version: "email-r1", chosen_variant: 1, approved_count: 3 });

describe.skipIf(!PGLITE_MODULES)("20261119110100 the released sweep names the stopped Zavi sender (pglite)", () => {
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
    db = await bootEmailPipeline(
      ["20261108100000_email_send_pause.sql", "20261108100100_email_card_takeover_and_redispatch.sql", "20261111110000_email_released_sweep_names_pause.sql", "20261112200000_email_bulk_resume_both_stops.sql", "20261119110100_email_released_sweep_names_sender_stop.sql"],
      async (d, f) => {
        if (f === "20261112200000_email_bulk_resume_both_stops.sql") {
          await d.exec(`create table if not exists app_setting (key text primary key, value jsonb not null);
            create table if not exists email_bulk_abuse_holds (tenant_id uuid, cleared_at timestamptz);
            insert into system_config (id, blob) values (1, '{}'::jsonb) on conflict (id) do nothing;`);
        }
      },
    );
    await db.query("insert into tenants values ($1)", [T]);
    await db.query("insert into tenant_users values ($1, $2, 'owner')", [T, OWNER]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("an approval held by the stopped Zavi sender for over a day is dropped with a reason that names the sender, and is not sent", async () => {
    const held = await released("bulk_sending_paused", "2 days");
    const out = await sweep();
    expect(out.find((x) => x.decision_id === held)).toMatchObject({ action: "expired", paused: false, sender_stopped: true });
    expect(out.filter((x) => x.decision_id === held && x.action === "redispatch")).toEqual([]);
    const d = await error(held);
    expect(d.status).toBe("dispatch_failed");
    expect(d.dispatch_error).toMatch(/Zavi's own sender was stopped for every workspace/);
    expect(d.dispatch_error).not.toMatch(/could not start this send/);
    expect(d.dispatch_error.startsWith(RELEASED_SENDER_STOPPED_REASON)).toBe(true);
    expect(founderSendError(d.dispatch_error)).toBe(d.dispatch_error);
    expect((await sweep()).find((x) => x.decision_id === held)).toBeUndefined();
  });

  it("the workspace's own email pause still wins over the stopped sender", async () => {
    await r("select set_email_pause($1, $2, true) r", [T, OWNER]);
    const held = await released("bulk_sending_paused", "2 days");
    const out = await sweep();
    await r("select set_email_pause($1, $2, false) r", [T, OWNER]);
    expect(out.find((x) => x.decision_id === held)).toMatchObject({ action: "expired", paused: true, sender_stopped: false });
    expect((await error(held)).dispatch_error).toMatch(/Email was paused for this workspace/);
  });

  it("an approval that never started for another reason keeps the plain reason", async () => {
    const stale = await released("fleet_halted", "2 days");
    expect((await sweep()).find((x) => x.decision_id === stale)).toMatchObject({ action: "expired", paused: false, sender_stopped: false });
    expect((await error(stale)).dispatch_error).toBe("Zavi could not start this send within a day of its approval, so it did not send it. Ask Zavi for a new draft.");
  });

  it("a stopped-sender hold younger than a day is offered again, not dropped", async () => {
    const young = await released("bulk_sending_paused", "1 hour");
    expect((await sweep()).find((x) => x.decision_id === young)).toMatchObject({ action: "redispatch" });
    expect((await error(young)).status).toBe("approved");
  });

  describe("while Zavi's own sender is stopped", () => {
    const stopVia = async (where: "app_setting" | "system_config", on: boolean) => {
      if (where === "app_setting") {
        await db.query("delete from app_setting where key = 'bulk_email_send_enabled'");
        if (on) await db.query("insert into app_setting (key, value) values ('bulk_email_send_enabled', 'false'::jsonb)");
      } else {
        await db.query("update system_config set blob = $1::jsonb where id = 1", [JSON.stringify(on ? { bulk_email_send_enabled: "false" } : {})]);
      }
    };
    const redispatches = (out: Array<Record<string, unknown>>, id: string) => out.filter((x) => x.decision_id === id && x.action === "redispatch");

    for (const where of ["app_setting", "system_config"] as const) {
      it(`a hold younger than a day is not offered again on any pass while the ${where} stop is on, and is offered once it lifts`, async () => {
        await stopVia(where, true);
        const young = await released("bulk_sending_paused", "1 hour");
        try {
          for (let i = 0; i < 3; i++) {
            expect(redispatches(await sweep(), young)).toEqual([]);
            expect(await error(young)).toEqual({ status: "proposed", dispatch_error: "bulk_sending_paused" });
          }
        } finally {
          await stopVia(where, false);
        }
        expect(redispatches(await sweep(), young)).toHaveLength(1);
        expect((await error(young)).status).toBe("approved");
      });
    }

    it("a hold over a day old still expires with the stopped-sender reason while the stop is on", async () => {
      await stopVia("app_setting", true);
      const held = await released("bulk_sending_paused", "2 days");
      let out: Array<Record<string, unknown>>;
      try {
        out = await sweep();
      } finally {
        await stopVia("app_setting", false);
      }
      expect(out.find((x) => x.decision_id === held)).toMatchObject({ action: "expired", paused: false, sender_stopped: true });
      expect(redispatches(out, held)).toEqual([]);
      const d = await error(held);
      expect(d.status).toBe("dispatch_failed");
      expect(d.dispatch_error.startsWith(RELEASED_SENDER_STOPPED_REASON)).toBe(true);
    });
  });
});
