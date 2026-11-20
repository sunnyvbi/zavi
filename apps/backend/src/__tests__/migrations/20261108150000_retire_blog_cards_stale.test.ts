import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261108150000_retire_blog_cards_stale.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf8");
const live = sql.replace(/^\s*--.*$/gm, "");

describe(FILE, () => {
  it("is the latest migration version", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all[all.length - 1]).toBe(FILE);
  });
  it("closes only open blog cards as stale", () => {
    expect(live).toMatch(/channel_slug\s*=\s*'blog'/);
    expect(live).toMatch(/status\s+in\s*\(\s*'pending'\s*,\s*'snoozed'\s*\)/);
    expect(live).toMatch(/set\s+status\s*=\s*'stale'/);
    expect(live).not.toMatch(/\bdelete\b/i);
    expect(live).not.toMatch(/'rejected'/);
  });
  it("leaves an executing card alone and is idempotent", () => {
    expect(live).toMatch(/exec_status is distinct from 'queued'/);
    expect(live).toMatch(/exec_status is distinct from 'dispatching'/);
    expect(live).toMatch(/on conflict \(action_id, event_key\) do nothing/);
  });
});
