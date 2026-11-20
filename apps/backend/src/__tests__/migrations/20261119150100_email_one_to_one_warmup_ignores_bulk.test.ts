import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootEmailPipeline, PGLITE_MODULES, type Db } from "./email-pipeline-pglite";

const MINE = [
  "20261108100000_email_send_pause.sql",
  "20261108100100_email_card_takeover_and_redispatch.sql",
  "20261108100150_email_card_tests_atomic.sql",
  "20261108100200_email_bulk_fanout_fixes.sql",
  "20261119150100_email_one_to_one_warmup_ignores_bulk.sql",
];
const DAY = "2026-11-02";
const NEXT = "2026-11-03";

describe.skipIf(!PGLITE_MODULES)("20261119150100 bulk email does not use up the one-to-one warm-up (pglite)", () => {
  let db: Db;
  const r = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0].r;
  const consume = (t: string, daily: number, warmup: number) => r("select consume_email_send_or_reject($1, $2::date, $3::int, $4::int) r", [t, DAY, daily, warmup]);
  const counters = (t: string, sent: number, bulk: number) =>
    db.query("insert into email_send_counters (tenant_id, day, sent_count, bulk_sent_count) values ($1, $2, $3, $4)", [t, DAY, sent, bulk]);
  const tenant = async () => {
    const t = randomUUID();
    await db.query("insert into tenants values ($1)", [t]);
    return t;
  };

  beforeAll(async () => {
    db = await bootEmailPipeline(MINE);
  }, 120_000);
  afterAll(async () => db?.close());

  it("120 bulk emails leave a day-0 domain's 50 one-to-one sends free", async () => {
    const t = await tenant();
    await counters(t, 120, 120);
    expect(await consume(t, 0, 50)).toBe(true);
  });

  it("the 51st one-to-one is still refused, with bulk on top", async () => {
    const t = await tenant();
    await counters(t, 170, 120);
    expect(await consume(t, 0, 50)).toBe(false);
    expect(await r("select sent_count r from email_send_counters where tenant_id = $1", [t])).toBe(170);
  });

  it("the global daily cap still counts bulk", async () => {
    const t = await tenant();
    await counters(t, 100, 100);
    expect(await consume(t, 100, 50)).toBe(false);
    expect(await consume(t, 101, 50)).toBe(true);
  });

  it("the old three-argument call still works while the backend rolls out", async () => {
    const t = await tenant();
    expect(await r("select consume_email_send_or_reject($1, $2::date, $3::int) r", [t, DAY, 5])).toBe(true);
  });

  it("peeking never moves the ramp; only a real send does", async () => {
    const t = await tenant();
    const peek = (day: string) => r("select peek_domain_warmup($1, 'X.test', $2::date) r", [t, day]);
    expect(await peek(DAY)).toBe(0);
    expect(await r("select count(*)::int r from email_domain_warmup where tenant_id = $1", [t])).toBe(0);
    await db.query("select touch_domain_warmup($1, 'x.test', $2::date)", [t, DAY]);
    expect(await peek(DAY)).toBe(0);
    expect(await peek(NEXT)).toBe(1);
    expect(await peek(NEXT)).toBe(1);
    expect(await r("select day_index r from email_domain_warmup where tenant_id = $1", [t])).toBe(0);
    expect(await r("select touch_domain_warmup($1, 'x.test', $2::date) r", [t, NEXT])).toBe(1);
  });
});
