import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261101130000_reddit_one_open_authorize_card.sql";
const code = readFileSync(join(MIGRATIONS, FILE), "utf-8").replace(/--[^\n]*/g, "");

describe(FILE, () => {
  it("sorts after the Reddit execution migration, reuses no version", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261025120000_reddit_ads_execution.sql"));
    expect(all.filter((f) => f.startsWith("20261101130000_"))).toEqual([FILE]);
  });
  it("one open (pending or snoozed: both approvable) authorize card per tenant and ad account; nothing else", () => {
    expect(code).toMatch(/create unique index if not exists channel_actions_one_open_reddit_authorize\s+on public\.channel_actions \(tenant_id, \(exec_payload->>'ad_account_id'\)\)\s+where exec_class = 'reddit_ads\.authorize_account' and status in \('pending', 'snoozed'\);/);
    expect(code).not.toMatch(/create (or replace )?function|create policy|\bdrop\s|alter table|update |delete /i);
  });
});
