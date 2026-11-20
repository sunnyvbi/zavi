import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const read = (name: string) => readFileSync(join(__dirname, "../../../../../supabase/migrations", name), "utf8");

it("a cap_reason never changes a decision's fingerprint; the change still does", async () => {
  const db = new PGlite();
  try {
    const prev = read("20260607225442_decisions_emit_dedup_content_fingerprint.sql");
    const s = prev.indexOf("create or replace function decision_content_fingerprint(");
    const e = prev.indexOf("$$;", prev.indexOf("$$", s) + 2) + 3;
    await db.exec(prev.slice(s, e).replace("decision_content_fingerprint(", "prev_fingerprint("));
    await db.exec(read("20261110180000_fingerprint_ignores_cap_reason.sql"));
    const fp = async (fn: string, body: unknown) =>
      (await db.query<{ f: string }>(`select ${fn}($1::jsonb) as f`, [JSON.stringify(body)])).rows[0].f;

    const cut = { campaign_id: "111", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, rationale: "move $10/day", over_cap: true };
    const withReason = { ...cut, cap_reason: "no_cap_configured" };

    expect(await fp("decision_content_fingerprint", withReason)).toBe(await fp("decision_content_fingerprint", cut));
    expect(await fp("decision_content_fingerprint", cut)).toBe(await fp("prev_fingerprint", cut));
    expect(await fp("decision_content_fingerprint", { ...cut, decision_evidence: { x: 1 } })).toBe(await fp("decision_content_fingerprint", cut));
    expect(await fp("decision_content_fingerprint", { ...withReason, daily_budget_usd: 12 })).not.toBe(await fp("decision_content_fingerprint", cut));
    expect(await fp("decision_content_fingerprint", { ...cut, over_cap: false })).not.toBe(await fp("decision_content_fingerprint", cut));
  } finally {
    await db.close();
  }
}, 20000);
