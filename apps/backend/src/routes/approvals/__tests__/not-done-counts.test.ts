import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  countByRun,
  decisionRunsByCount,
  mergeNotDoneCounts,
  DECLINED_DECISIONS_VIEW,
  DEFERRED_DECISIONS_VIEW,
  DEFERRED_CHANNEL_ACTIONS_VIEW,
} from "../not-done-counts";

type Row = { agent_run_id: string | null; origin_run_id: string | null };
const runIdOf = (r: Row) => r.origin_run_id || r.agent_run_id;

describe("countByRun", () => {
  it("tallies a run's deferred actions", () => {
    expect(countByRun(["run-1", "run-1", "run-2"])).toEqual({
      "run-1": 2,
      "run-2": 1,
    });
  });

  it("is empty when nothing is deferred, rather than zero-filled", () => {
    expect(countByRun([])).toEqual({});
  });

  it("drops a row with no run — it is nobody's progress line", () => {
    expect(countByRun([null, "run-1", null])).toEqual({ "run-1": 1 });
  });
});

describe("decisionRunsByCount", () => {
  it("books a not-done decision against its own run", () => {
    expect(
      decisionRunsByCount([{ agent_run_id: "run-1", origin_run_id: null }], runIdOf),
    ).toEqual({ "run-1": 1 });
  });

  it("books a redo against the run it replaced an action in", () => {
    expect(
      decisionRunsByCount([{ agent_run_id: "redo-run", origin_run_id: "run-1" }], runIdOf),
    ).toEqual({ "run-1": 1 });
  });
});

describe("mergeNotDoneCounts", () => {
  it("adds the two stores, the way the pending counts do", () => {
    expect(mergeNotDoneCounts({ "run-1": 1 }, { "run-2": 2 })).toEqual({
      "run-1": 1,
      "run-2": 2,
    });
  });

  it("sums a run that has both a deferral and a decline", () => {
    expect(mergeNotDoneCounts({ "run-1": 1 }, { "run-1": 1 })).toEqual({ "run-1": 2 });
  });
});

describe("the deferred reader reads views, never the base tables", () => {
  const src = readFileSync(join(__dirname, "../not-done-counts.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");

  it("names every complement view", () => {
    expect(DEFERRED_DECISIONS_VIEW).toBe("customer_visible_deferred_decisions");
    expect(DEFERRED_CHANNEL_ACTIONS_VIEW).toBe("customer_visible_deferred_channel_actions");
    expect(DECLINED_DECISIONS_VIEW).toBe("customer_visible_declined_decisions");
  });

  it("never selects from `decisions` or `channel_actions`", () => {
    expect(code).not.toMatch(/from\(\s*["']decisions["']/);
    expect(code).not.toMatch(/from\(\s*["']channel_actions["']/);
  });

  it("re-inlines neither half of the predicate the views own", () => {
    expect(code).not.toMatch(/\.eq\(\s*["']status["']/);
    expect(code).not.toMatch(/snoozed_until/);
  });
});

describe("20260919220000 — the deferred views", () => {
  const sql = readFileSync(
    join(__dirname, "../../../../../../supabase/migrations/20260919220000_deferred_action_views.sql"),
    "utf8",
  );

  it("runs under the caller's own RLS, like the views it complements", () => {
    expect(sql.match(/security_invoker = true/g) ?? []).toHaveLength(2);
  });

  it("matches a FUTURE date only, so a lapsed snooze is open rather than deferred", () => {
    expect(sql.match(/snoozed_until > now\(\)/g) ?? []).toHaveLength(2);
    expect(sql).not.toMatch(/snoozed_until\s+is\s+null/i);
    expect(sql).not.toMatch(/snoozed_until\s*<=?\s*now\(\)/);
  });

  it("complements each store with that store's own open predicate", () => {
    expect(sql).toMatch(/d\.status = 'proposed'/);
    expect(sql).toMatch(/a\.status = 'snoozed'/);
  });
});

describe("20260919230000 — archive says archived", () => {
  const sql = readFileSync(
    join(
      __dirname,
      "../../../../../../supabase/migrations/20260919230000_archive_decision_says_archived.sql",
    ),
    "utf8",
  );
  const code = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  it("closes a declined decision as archived, never as acted", () => {
    expect(code).toMatch(/set status = 'archived', archived_at = now\(\)/);
    expect(code).not.toMatch(/set status = 'acted'/);
  });

  it("still refuses to stamp dispatched_at", () => {
    expect(code).not.toMatch(/dispatched_at\s*=/);
  });

  it("keeps the founder_managed gate and the cross-tenant raise", () => {
    expect(code).toMatch(/dc\.founder_managed is true/);
    expect(code).toMatch(/belongs to tenant/);
  });

  it("repairs old rows by archived_at, the one exact discriminator", () => {
    expect(code).toMatch(/update public\.decisions\s+set status = 'archived'\s+where status = 'acted'\s+and archived_at is not null;/);
  });

  it("does not touch the approve path, which still means done", () => {
    expect(code).not.toMatch(/approve/i);
    expect(code).not.toMatch(/ACCEPT_STATUSES/);
  });
});

describe("a genuine 'Did it' still means done", () => {
  const statusSrc = readFileSync(
    join(__dirname, "../../../services/decisions/status.ts"),
    "utf8",
  );
  const aggregateSrc = readFileSync(
    join(__dirname, "../../../services/memory/outcome-aggregate.ts"),
    "utf8",
  );

  it("'acted' is still the accept signal", () => {
    expect(statusSrc).toMatch(/DECISION_STATUS_ACTED = "acted"/);
    expect(statusSrc).toMatch(/ACCEPT_DECISION_STATUSES[\s\S]{0,120}DECISION_STATUS_ACTED/);
    expect(aggregateSrc).toMatch(/ACCEPT_STATUSES = new Set\(\["acted"\]\)/);
  });

  it("'archived' was not smuggled into the accept or reject sets", () => {
    expect(aggregateSrc).not.toMatch(/ACCEPT_STATUSES[\s\S]{0,80}archived/);
    expect(aggregateSrc).not.toMatch(/REJECT_STATUSES[\s\S]{0,80}archived/);
  });
});
