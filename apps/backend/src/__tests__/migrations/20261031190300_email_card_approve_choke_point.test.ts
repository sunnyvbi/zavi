import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const NEW = read("20261031190300_email_card_approve_choke_point.sql");

function body(sql: string, name: string): string[] {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("end $$;", start);
  return sql.slice(start, end + "end $$;".length).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
}

function missingLines(prior: string[], next: string[], allowedChanges: string[] = []): string[] {
  const missing: string[] = [];
  let i = 0;
  for (const line of prior) {
    const at = next.indexOf(line, i);
    if (at === -1) {
      if (!allowedChanges.includes(line.trim())) missing.push(line);
      continue;
    }
    i = at + 1;
  }
  return missing;
}

describe("20261031190300 rebuilds are clean supersets", () => {
  it("approve_channel_action keeps all of 20261009100050", () => {
    const prior = body(read("20261009100050_approve_channel_action_refuse_blocked.sql"), "approve_channel_action");
    expect(missingLines(prior, body(NEW, "approve_channel_action"))).toEqual([]);
  });

  it("approve_email_campaign_send_as_cgo keeps all of 20261022090100 (the direct return becomes a flagged call)", () => {
    const prior = body(read("20261022090100_email_campaign_tool_send.sql"), "approve_email_campaign_send_as_cgo");
    expect(
      missingLines(prior, body(NEW, "approve_email_campaign_send_as_cgo"), [
        "return approve_channel_action(p_tenant_id, p_action_id, p_event_key, p_actor_user_id, 'cgo');",
      ]),
    ).toEqual([]);
    expect(NEW).toContain("v_out := approve_channel_action(p_tenant_id, p_action_id, p_event_key, p_actor_user_id, 'cgo');");
  });

  it("grants stay service_role only", () => {
    expect(NEW).not.toMatch(/grant execute on function \S+ to (anon|authenticated)/);
  });
});
