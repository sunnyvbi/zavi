import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
it("deduplicates terminal inserts without deleting history or suppressing repeated tool progress", async () => {
  const db = new PGlite();
  try {
    await db.exec("create type agent_run_event_stage as enum ('persisted','completed','tool_use_completed'); create table agent_run_events (agent_run_id uuid, stage agent_run_event_stage, meta jsonb default '{}'::jsonb);");
    const migration = readFileSync(resolve(process.cwd(), "../../supabase/migrations/20261019151348_channel_chat_terminal_events_once.sql"), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    const id = "00000000-0000-4000-8000-000000000001";
    await db.query("insert into agent_run_events values ($1,'completed',$2)", [id, { code: "ship_gate_block_tests" }]);
    await db.query("insert into agent_run_events values ($1,'completed',$2)", [id, { code: "engineer_html_preview" }]);
    for (let i = 0; i < 5; i++) for (const [stage, meta] of [["persisted", {}], ["completed", { code: i % 2 ? "parse_failed" : "success" }], ["tool_use_completed", {}]] as const) {
      await db.query("insert into agent_run_events values ($1,$2,$3)", [id, stage, meta]);
    }
    expect((await db.query("select stage::text as stage, coalesce(meta->>'code','') as code, count(*)::int as n from agent_run_events group by 1,2 order by 1,2")).rows).toEqual([
      { stage: "completed", code: "engineer_html_preview", n: 1 },
      { stage: "completed", code: "ship_gate_block_tests", n: 1 },
      { stage: "completed", code: "success", n: 1 },
      { stage: "persisted", code: "", n: 1 },
      { stage: "tool_use_completed", code: "", n: 5 },
    ]);
  } finally { await db.close(); }
});
