import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildStaleOrHardCapFilter,
  fetchChatBucketStuckRows,
  fetchNonChatBucketStuckRows,
  type StuckRunRow,
} from "../stuck-run-query";

type Capture = {
  table: string;
  selectCols: string;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  or: string[];
};

function makeStubClient(rows: StuckRunRow[]): {
  client: SupabaseClient;
  capture: Capture;
} {
  const capture: Capture = {
    table: "",
    selectCols: "",
    eq: [],
    in: [],
    is: [],
    or: [],
  };
  const builder: Record<string, unknown> = {
    select(cols: string) {
      capture.selectCols = cols;
      return builder;
    },
    eq(col: string, val: unknown) {
      capture.eq.push([col, val]);
      return builder;
    },
    in(col: string, val: unknown) {
      capture.in.push([col, val]);
      return builder;
    },
    is(col: string, val: unknown) {
      capture.is.push([col, val]);
      return builder;
    },
    or(filter: string) {
      capture.or.push(filter);
      return builder;
    },
    then(resolve: (v: { data: StuckRunRow[]; error: null }) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  const client = {
    from(table: string) {
      capture.table = table;
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, capture };
}

const CHAT_CUT = "2026-05-24T09:00:00.000Z";
const NONCHAT_CUT = "2026-05-24T08:30:00.000Z";
const HARD_CUT = "2026-05-24T07:00:00.000Z";

describe("buildStaleOrHardCapFilter", () => {
  it("expands COALESCE(last_progress_at, started_at) < stale into two pure-column clauses", () => {
    const f = buildStaleOrHardCapFilter(CHAT_CUT, HARD_CUT);
    expect(f).toContain(
      `and(last_progress_at.not.is.null,last_progress_at.lt.${CHAT_CUT})`,
    );
    expect(f).toContain(
      `and(last_progress_at.is.null,started_at.not.is.null,started_at.lt.${CHAT_CUT})`,
    );
  });

  it("expands COALESCE(started_at, last_progress_at) < hardcap into two pure-column clauses", () => {
    const f = buildStaleOrHardCapFilter(CHAT_CUT, HARD_CUT);
    expect(f).toContain(
      `and(started_at.not.is.null,started_at.lt.${HARD_CUT})`,
    );
    expect(f).toContain(
      `and(started_at.is.null,last_progress_at.not.is.null,last_progress_at.lt.${HARD_CUT})`,
    );
  });

  it("emits exactly four OR sub-clauses", () => {
    const f = buildStaleOrHardCapFilter(CHAT_CUT, HARD_CUT);
    const groups = f.match(/and\([^)]*\)/g) ?? [];
    expect(groups).toHaveLength(4);
  });

  it("a both-null row matches none of the clauses (mirrors old `if (!lastActivity) continue`)", () => {
    const f = buildStaleOrHardCapFilter(CHAT_CUT, HARD_CUT);
    const groups = f.match(/and\([^)]*\)/g) ?? [];
    for (const g of groups) {
      expect(g).toMatch(/(last_progress_at|started_at)\.not\.is\.null/);
    }
  });
});

describe("fetchChatBucketStuckRows (interactive bucket = chat+slack+mcp)", () => {
  it("pins status='running', trigger IN ('chat','slack','mcp'), batch_id IS NULL, and the stale-or-hardcap OR", async () => {
    const { client, capture } = makeStubClient([]);
    await fetchChatBucketStuckRows(client, CHAT_CUT, HARD_CUT);
    expect(capture.table).toBe("agent_runs");
    expect(capture.eq).toContainEqual(["status", "running"]);
    expect(capture.in).toContainEqual(["trigger", ["chat", "slack", "mcp"]]);
    expect(capture.eq).not.toContainEqual(["trigger", "chat"]);
    expect(capture.is).toContainEqual(["batch_id", null]);
    expect(capture.or).toHaveLength(1);
    expect(capture.or[0]).toBe(buildStaleOrHardCapFilter(CHAT_CUT, HARD_CUT));
  });

  it("selects all columns the reap loop consumes", async () => {
    const { client, capture } = makeStubClient([]);
    await fetchChatBucketStuckRows(client, CHAT_CUT, HARD_CUT);
    for (const col of [
      "id",
      "tenant_id",
      "agent_slug",
      "trigger",
      "started_at",
      "last_progress_at",
      "payload",
      "batch_id",
      "child_index",
    ]) {
      expect(capture.selectCols).toContain(col);
    }
  });

  it("returns the rows the client yielded", async () => {
    const row: StuckRunRow = {
      id: "r1",
      tenant_id: "t1",
      agent_slug: "engineer",
      trigger: "chat",
      started_at: "2026-05-24T08:55:00.000Z",
      last_progress_at: null,
      payload: { thread_id: "th1" },
      batch_id: null,
      child_index: null,
    };
    const { client } = makeStubClient([row]);
    const { rows } = await fetchChatBucketStuckRows(client, CHAT_CUT, HARD_CUT);
    expect(rows).toEqual([row]);
  });
});

describe("fetchNonChatBucketStuckRows (background bucket)", () => {
  it("pins status='running' and the NOT(trigger IN (chat,slack) AND batch_id null) bucket via top-level .or()", async () => {
    const { client, capture } = makeStubClient([]);
    await fetchNonChatBucketStuckRows(client, NONCHAT_CUT, HARD_CUT);
    expect(capture.eq).toContainEqual(["status", "running"]);
    expect(capture.or[0]).toBe("trigger.not.in.(chat,slack,mcp),batch_id.not.is.null");
    expect(capture.or[1]).toBe(
      buildStaleOrHardCapFilter(NONCHAT_CUT, HARD_CUT),
    );
    expect(capture.or).toHaveLength(2);
  });

  it("does NOT use batch_id IS NULL as an .is() filter (batch children belong here)", async () => {
    const { client, capture } = makeStubClient([]);
    await fetchNonChatBucketStuckRows(client, NONCHAT_CUT, HARD_CUT);
    expect(capture.is).not.toContainEqual(["batch_id", null]);
  });
});

describe("queued-stuck-scan wires SQL-side partitioning", () => {
  const src = readFileSync(
    join(__dirname, "../queued-stuck-scan.ts"),
    "utf-8",
  );
  it("imports + calls both bucket fetchers", () => {
    expect(src).toMatch(/fetchChatBucketStuckRows/);
    expect(src).toMatch(/fetchNonChatBucketStuckRows/);
  });
  it("no longer does a bare select-all-running then JS partition", () => {
    expect(src).not.toMatch(
      /\.select\(\s*\n?\s*"id, tenant_id, agent_slug, trigger, started_at, last_progress_at, payload, batch_id, child_index",\s*\n?\s*\)\s*\n?\s*\.eq\("status", "running"\);/,
    );
  });
  it("preserves the exact reason strings (hard cap + per-trigger stale)", () => {
    expect(src).toMatch(
      /running >\$\{RUNNING_HARD_CAP_HOURS\}h \(hard cap\)/,
    );
    expect(src).toMatch(/no progress for >\$\{minutes\}min \(trigger=\$\{trigger\}/);
  });
});

describe("migration — agent_runs (status, started_at) index", () => {
  const mig = readFileSync(
    join(
      __dirname,
      "../../../../../supabase/migrations/20260524090559_agent_runs_status_started_at_idx.sql",
    ),
    "utf-8",
  );
  it("creates the (status, started_at) partial index", () => {
    expect(mig).toMatch(
      /create index if not exists agent_runs_status_started_at[\s\S]*?on agent_runs \(status, started_at\)[\s\S]*?where status in \('queued', 'running'\)/i,
    );
  });
  it("is additive only — no drop / alter column / delete / update", () => {
    expect(mig).not.toMatch(/\bdrop\b/i);
    expect(mig).not.toMatch(/alter table/i);
    expect(mig).not.toMatch(/\bdelete\b/i);
    expect(mig).not.toMatch(/\bupdate\b/i);
  });
});
