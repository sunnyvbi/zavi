import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GROWTH_PAGE_ONLY_CLASSES } from "@/services/approvals/growth-page-only";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const strip = (raw: string) =>
  raw
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .toLowerCase();
const sql = strip(readFileSync(join(MIGRATIONS_DIR, "20260926160000_cgo_dispatch_specialist_class.sql"), "utf8"));

describe("cgo_dispatch_specialist_class migration", () => {
  it("registers the class approval-gated on the dispatch_specialist handler", () => {
    expect(sql).toMatch(/'cgo\.dispatch-specialist',\s*'[^']+',\s*'approval',\s*'praxis\.dispatch_specialist'/);
  });

  it("can never be auto-approved", () => {
    expect(sql).toMatch(/never_auto\s*=\s*true/);
  });

  it("keys open cards and rejections on goal, goal revision and target agent", () => {
    expect(sql).toMatch(/target_key_paths\s*=\s*array\['goal_id',\s*'goal_rev',\s*'target_agent_slug'\]/);
    expect(sql).toMatch(/single_open_per_target\s*=\s*true/);
  });

  it("keeps the pending view's existing clauses and drops every growth-page-only class", () => {
    const view = sql.slice(sql.indexOf("create or replace view public.customer_visible_pending_decisions"));
    expect(view).toMatch(/with \(security_invoker = true\)/);
    expect(view).toMatch(/d\.status = 'proposed'/);
    expect(view).toMatch(/d\.autonomy_at_emit = 'approval'/);
    expect(view).toMatch(/d\.snoozed_until is null or d\.snoozed_until <= now\(\)/);
    for (const cls of GROWTH_PAGE_ONLY_CLASSES) expect(view).toContain(`'${cls}'`);
  });
});

describe("every cgo.* decision class has a handler", () => {
  it("no migration registers a cgo.* class with a null handler", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const inserts: string[] = [];
    for (const f of files) {
      const body = strip(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      for (const m of body.matchAll(/\(\s*'(cgo\.[a-z0-9_.-]+)',\s*'[^']*',\s*'[a-z]+',\s*([^)\s,]+)/g)) {
        inserts.push(m[1]);
        expect(m[2], `${m[1]} in ${f}`).not.toBe("null");
      }
    }
    expect(inserts).toContain("cgo.dispatch-specialist");
  });
});
