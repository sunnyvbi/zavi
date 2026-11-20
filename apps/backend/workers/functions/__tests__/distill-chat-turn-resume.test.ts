import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Op = { table: string; op: "select" | "update"; payload?: Row; filters: Array<[string, string, unknown]> };

const H = vi.hoisted(() => ({
  tables: { agent_runs: [] as Row[], agent_thread_messages: [] as Row[], agent_run_events: [] as Row[] } as Record<string, Row[]>,
  ops: [] as Op[],
  distillCalls: [] as Array<Record<string, unknown>>,
  distillResult: { written: 1, skipped: 0, failed: 0, tokens: { input: 0, output: 0 } },
  proposalsByRun: {} as Record<string, Array<{ id: string; title: string; body: string; tags: string[] }>>,
  logs: [] as Array<{ level: string; code?: string; run_id?: string | null; meta?: Record<string, unknown> }>,
  failUpdate: null as null | ((table: string, payload: Row) => boolean),
  duringDistill: null as null | (() => void),
}));

function field(row: Row, col: string): unknown {
  if (col.startsWith("payload->>")) {
    const p = row.payload as Row | null | undefined;
    const v = p?.[col.slice("payload->>".length)];
    return v == null ? null : String(v);
  }
  return row[col];
}

function matches(row: Row, filters: Op["filters"]): boolean {
  return filters.every(([kind, col, val]) => {
    const v = field(row, col);
    switch (kind) {
      case "eq":
        return v === val;
      case "in":
        return (val as unknown[]).includes(v);
      case "is":
        return v == null;
      case "lt":
        return typeof v === "string" && v < (val as string);
      case "not_in": {
        const list = String(val).replace(/^\(|\)$/g, "").split(",");
        return !list.includes(String(v));
      }
      case "like":
        return false;
      case "or": {
        const m = /distill_claimed_at\.is\.null,distill_claimed_at\.lt\."([^"]+)"/.exec(String(val));
        if (!m) throw new Error(`unsupported or(): ${String(val)}`);
        const c = row.distill_claimed_at as string | null | undefined;
        return c == null || c < m[1];
      }
      default:
        throw new Error(`unsupported filter ${kind}`);
    }
  });
}

function project(row: Row, cols: string): Row {
  const out: Row = { ...row };
  for (const part of cols.split(",").map((c) => c.trim())) {
    const alias = /^(\w+):(payload->>\w+)$/.exec(part);
    if (alias) out[alias[1]] = field(row, alias[2]);
  }
  return out;
}

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const op: Op = { table, op: "select", filters: [] };
      let cols = "*";
      let returning = false;
      let order: { col: string; asc: boolean } | null = null;
      let limit = Infinity;
      H.ops.push(op);
      const b: Record<string, unknown> = {};
      b.select = (c?: string) => {
        if (op.op === "update") returning = true;
        else cols = c ?? "*";
        return b;
      };
      for (const kind of ["eq", "in", "is", "lt", "like"]) {
        b[kind] = (col: string, val: unknown) => {
          op.filters.push([kind, col, val]);
          return b;
        };
      }
      b.not = (col: string, opr: string, val: unknown) => {
        if (opr !== "in") throw new Error(`unsupported not(${opr})`);
        op.filters.push(["not_in", col, val]);
        return b;
      };
      b.or = (expr: string) => {
        op.filters.push(["or", "", expr]);
        return b;
      };
      b.order = (col: string, o?: { ascending?: boolean }) => {
        order = { col, asc: o?.ascending !== false };
        return b;
      };
      b.limit = (n: number) => {
        limit = n;
        return b;
      };
      b.update = (p: Row) => {
        op.op = "update";
        op.payload = p;
        return b;
      };
      const run = () => {
        const rows = H.tables[table] ?? [];
        if (op.op === "update") {
          if (H.failUpdate?.(table, op.payload!)) return { data: null, error: { message: "update boom" } };
          const hit = rows.filter((r) => matches(r, op.filters));
          for (const r of hit) Object.assign(r, op.payload);
          return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
        }
        let hit = rows.filter((r) => matches(r, op.filters)).map((r) => project(r, cols));
        if (order) {
          const { col, asc } = order;
          hit = [...hit].sort((a, c) => (String(a[col]) < String(c[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        return { data: hit.slice(0, limit), error: null };
      };
      b.maybeSingle = async () => {
        const r = run();
        if (r.error) return r;
        return { data: (r.data as Row[])[0] ?? null, error: null };
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
      return b;
    },
  }),
}));
vi.mock("@/services/memory/distill", () => ({
  CHAT_DISTILL_SYSTEM_PROMPT: "chat",
  runDistill: vi.fn(async (input: Record<string, unknown>) => {
    H.distillCalls.push(input);
    H.duringDistill?.();
    return H.distillResult;
  }),
}));
vi.mock("@/services/memory/write-path", () => ({
  loadPendingProposals: vi.fn(async (_t: string, runId: string) => H.proposalsByRun[runId] ?? []),
  MAX_PROPOSALS_PER_RUN: 10,
}));
vi.mock("@/services/memory/live-connectors", () => ({ liveConnectorsForTenant: vi.fn(async () => []) }));
vi.mock("@/services/agents/should-distill", () => ({ shouldDistillRun: vi.fn(() => ({ ok: true })) }));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async (e: { level: string; code?: string; run_id?: string | null; meta?: Record<string, unknown> }) => {
    H.logs.push(e);
  }),
}));

import { distillChatTurn, buildChatTurnTranscript } from "../distill-chat-turn";

const T = "11111111-1111-1111-1111-111111111111";
const OTHER_T = "99999999-9999-9999-9999-999999999999";
const ROOT = "ad315e2d-0000-0000-0000-000000000000";
const TIP = "312248af-0000-0000-0000-000000000000";
const TH = "thread-TH";
const M1 = "m1";

function rootRun(over: Row = {}): Row {
  return {
    id: ROOT, tenant_id: T, agent_slug: "operator", trigger: "chat", status: "success",
    enqueued_by: "user-1", distilled_at: null, tool_calls: [],
    payload: { thread_id: TH, user_message_id: M1 },
    ...over,
  };
}
function tipRun(over: Row = {}): Row {
  return {
    id: TIP, tenant_id: T, agent_slug: "operator", trigger: "chat", status: "success",
    enqueued_by: null, distilled_at: null, tool_calls: [],
    payload: { thread_id: TH, resume_of_run_id: ROOT, internal_resume_turn: "Your proposed action was approved." },
    ...over,
  };
}
function msg(over: Row): Row {
  return { tenant_id: T, thread_id: TH, distilled_at: null, distill_claimed_at: null, agent_run_id: null, ...over };
}
const userMsg = () => msg({ id: M1, sender_role: "user", body: "launch the spring promo at $40/day", created_at: "2026-10-17T10:00:00Z" });
const rootReply = () => msg({ id: "a-root", sender_role: "assistant", body: "I need your approval to launch at $40/day.", created_at: "2026-10-17T10:00:05Z", agent_run_id: ROOT });
const tipReply = () => msg({ id: "a-tip", sender_role: "assistant", body: "Launched: the spring promo is live at $40/day.", created_at: "2026-10-17T10:05:00Z", agent_run_id: TIP });

function row(table: string, id: string): Row {
  return H.tables[table].find((r) => r.id === id)!;
}
const isStamped = (table: string, id: string) => !!row(table, id).distilled_at;
const stampWrites = () => H.ops.filter((o) => o.op === "update" && o.payload && "distilled_at" in o.payload);

beforeEach(() => {
  delete process.env.PRAXIS_DISTILL_CHAT_ENABLED;
  H.tables = {
    agent_runs: [rootRun(), tipRun()],
    agent_thread_messages: [userMsg(), rootReply(), tipReply()],
    agent_run_events: [],
  };
  H.ops = [];
  H.distillCalls = [];
  H.distillResult = { written: 1, skipped: 0, failed: 0, tokens: { input: 0, output: 0 } };
  H.proposalsByRun = {};
  H.logs = [];
  H.failUpdate = null;
  H.duringDistill = null;
});

describe("A3: the continuation distills the resumed turn once", () => {
  it("walks the tip back to the root, distills the user's words with both replies, and stamps everything", async () => {
    const res = await distillChatTurn(TIP);
    expect(res).toEqual({ written: 1, skipped: 0 });
    expect(H.distillCalls).toHaveLength(1);
    const call = H.distillCalls[0];
    expect(call.operator_message).toBe("launch the spring promo at $40/day");
    expect(call.userPrompt).toContain("I need your approval to launch at $40/day.");
    expect(call.userPrompt).toContain("Launched: the spring promo is live at $40/day.");
    expect(call.userPrompt).not.toContain("Your proposed action was approved.");
    expect(call.source_ref).toBe(TIP);
    expect(call.thread_id).toBe(TH);
    expect(call.gate).toMatchObject({ run_id: TIP, thread_message_id: "a-tip", ceiling: 0 });
    for (const id of [ROOT, TIP]) expect(isStamped("agent_runs", id)).toBe(true);
    for (const id of [M1, "a-root", "a-tip"]) expect(isStamped("agent_thread_messages", id)).toBe(true);
    expect(H.logs).toContainEqual(expect.objectContaining({ code: "distill.chat_turn_resume_chain", run_id: TIP }));
  });

  it("the root's backfill re-fire afterwards is a no-op (it is stamped and deferred)", async () => {
    await distillChatTurn(TIP);
    H.distillCalls = [];
    await distillChatTurn(ROOT);
    expect(H.distillCalls).toHaveLength(0);
  });

  it("judges the proposals of every run of the turn, the tip's first", async () => {
    H.proposalsByRun[ROOT] = [{ id: "p-root", title: "", body: "Budget is $40/day.", tags: [] }];
    H.proposalsByRun[TIP] = [{ id: "p-tip", title: "", body: "Spring promo is live.", tags: [] }];
    await distillChatTurn(TIP);
    const items = (H.distillCalls[0].proposals as { items: Array<{ id: string }> }).items.map((p) => p.id);
    expect(items).toEqual(["p-tip", "p-root"]);
  });

  it("reads the read-truncation signal over the union of the turn's tool traces", async () => {
    row("agent_runs", ROOT).tool_calls = [{ name: "github__read_file", output_preview: "BUDGET EXHAUSTED: file too large" }];
    await distillChatTurn(TIP);
    expect(H.distillCalls[0].readBudgetRefused).toBe(true);
  });
});

describe("owner rule: only the chain tip distills", () => {
  it("a root whose continuation succeeded does nothing and stamps nothing", async () => {
    const res = await distillChatTurn(ROOT);
    expect(res).toEqual({ written: 0, skipped: 0 });
    expect(H.distillCalls).toHaveLength(0);
    expect(stampWrites()).toHaveLength(0);
    expect(row("agent_thread_messages", M1).distill_claimed_at).toBeNull();
    expect(H.logs).toContainEqual(expect.objectContaining({ code: "distill.chat_turn_deferred_to_tip", run_id: ROOT }));
  });

  for (const status of ["queued", "running", "paused_awaiting_approval"]) {
    it(`a root whose continuation is ${status} defers too`, async () => {
      row("agent_runs", TIP).status = status;
      await distillChatTurn(ROOT);
      expect(H.distillCalls).toHaveLength(0);
      expect(stampWrites()).toHaveLength(0);
    });
  }

  for (const status of ["failed", "cancelled"]) {
    it(`a root whose continuation ${status} distills its own turn`, async () => {
      row("agent_runs", TIP).status = status;
      await distillChatTurn(ROOT);
      expect(H.distillCalls).toHaveLength(1);
      expect(H.distillCalls[0].gate).toMatchObject({ run_id: ROOT, thread_message_id: "a-root" });
      expect(H.distillCalls[0].userPrompt).not.toContain("Launched");
      expect(isStamped("agent_runs", ROOT)).toBe(true);
      expect(isStamped("agent_thread_messages", M1)).toBe(true);
    });
  }

  it("a 'successor' on another thread does not silence the root", async () => {
    row("agent_runs", TIP).payload = { thread_id: "elsewhere", resume_of_run_id: ROOT };
    await distillChatTurn(ROOT);
    expect(H.distillCalls).toHaveLength(1);
  });
});

describe("broken chains stamp only the run asked about", () => {
  const cases: Array<[string, () => void, string]> = [
    ["root in another tenant", () => { row("agent_runs", ROOT).tenant_id = OTHER_T; }, TIP],
    ["root on another thread", () => { row("agent_runs", ROOT).payload = { thread_id: "other", user_message_id: M1 }; }, TIP],
    ["root of another agent", () => { row("agent_runs", ROOT).agent_slug = "cgo"; }, TIP],
    [
      "more than five resume hops",
      () => {
        const hops = Array.from({ length: 6 }, (_, i) =>
          tipRun({ id: `hop-${i}`, payload: { thread_id: TH, resume_of_run_id: i === 0 ? ROOT : `hop-${i - 1}` } }),
        );
        H.tables.agent_runs.push(...hops);
      },
      "hop-5",
    ],
  ];
  for (const [name, mutate, asked] of cases) {
    it(`${name}: no distill, only ${asked} stamped, a warn logged`, async () => {
      mutate();
      await distillChatTurn(asked);
      expect(H.distillCalls).toHaveLength(0);
      expect(isStamped("agent_runs", asked)).toBe(true);
      if (asked !== TIP) expect(isStamped("agent_runs", TIP)).toBe(false);
      expect(row("agent_runs", ROOT).distilled_at).toBeNull();
      expect(isStamped("agent_thread_messages", M1)).toBe(false);
      expect(H.logs).toContainEqual(expect.objectContaining({ level: "warn", code: "distill.chat_turn_chain_broken", run_id: asked }));
    });
  }
});

describe("the distill claim", () => {
  it("another worker's fresh claim: no distill, nothing stamped", async () => {
    row("agent_thread_messages", M1).distill_claimed_at = new Date().toISOString();
    const res = await distillChatTurn(TIP);
    expect(res).toEqual({ written: 0, skipped: 0 });
    expect(H.distillCalls).toHaveLength(0);
    expect(stampWrites()).toHaveLength(0);
    expect(H.logs).toContainEqual(expect.objectContaining({ code: "distill.chat_turn_claim_busy" }));
  });

  it("a claim older than 15 minutes is taken over", async () => {
    row("agent_thread_messages", M1).distill_claimed_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    await distillChatTurn(TIP);
    expect(H.distillCalls).toHaveLength(1);
    expect(isStamped("agent_thread_messages", M1)).toBe(true);
  });

  it("a user message that is not this thread's user turn: runs stamped, no distill", async () => {
    row("agent_thread_messages", M1).thread_id = "other";
    await distillChatTurn(TIP);
    expect(H.distillCalls).toHaveLength(0);
    expect(isStamped("agent_runs", ROOT)).toBe(true);
    expect(isStamped("agent_runs", TIP)).toBe(true);
  });
});

describe("already-distilled user message", () => {
  it("with nothing pending, stamps every run of the turn (the backfill loop)", async () => {
    row("agent_thread_messages", M1).distilled_at = "2026-10-17T11:00:00Z";
    await distillChatTurn(TIP);
    expect(H.distillCalls).toHaveLength(0);
    expect(isStamped("agent_runs", ROOT)).toBe(true);
    expect(isStamped("agent_runs", TIP)).toBe(true);
  });

  it("with proposals pending, judges only them at agent trust, then stamps the runs", async () => {
    row("agent_thread_messages", M1).distilled_at = "2026-10-17T11:00:00Z";
    H.proposalsByRun[ROOT] = [{ id: "p-root", title: "", body: "Budget is $40/day.", tags: [] }];
    await distillChatTurn(TIP);
    expect(H.distillCalls).toHaveLength(1);
    expect(H.distillCalls[0].gate).toMatchObject({ ceiling: 2, run_id: TIP });
    expect(H.distillCalls[0].userPrompt).not.toContain("spring promo");
    expect(isStamped("agent_runs", ROOT)).toBe(true);
    expect(isStamped("agent_runs", TIP)).toBe(true);
  });
});

describe("gate inputs over the chain", () => {
  it("captured page context on the ROOT only caps the turn at tier 2", async () => {
    row("agent_runs", ROOT).payload = { thread_id: TH, user_message_id: M1, page_context: { mode: "text", text: "page" } };
    await distillChatTurn(TIP);
    expect((H.distillCalls[0].gate as { ceiling: number }).ceiling).toBe(2);
  });

  it("truncation drops prior context first and keeps the user turn and the tip's reply", async () => {
    for (let i = 0; i < 6; i++) {
      H.tables.agent_thread_messages.push(
        msg({ id: `prior-${i}`, sender_role: i % 2 ? "assistant" : "user", body: `PRIOR${i} ` + "x".repeat(5000), created_at: `2026-10-17T09:0${i}:00Z` }),
      );
    }
    await distillChatTurn(TIP);
    const prompt = H.distillCalls[0].userPrompt as string;
    expect(prompt.length).toBeLessThanOrEqual(12_000);
    expect(prompt).toContain("launch the spring promo at $40/day");
    expect(prompt).toContain("Launched: the spring promo is live at $40/day.");
    expect(prompt).toContain("PRIOR5");
    expect(prompt).not.toContain("PRIOR0");
  });
});

describe("failures", () => {
  it("a failed message stamp throws and gives the claim back", async () => {
    H.failUpdate = (table, payload) => table === "agent_thread_messages" && "distilled_at" in payload;
    await expect(distillChatTurn(TIP)).rejects.toThrow(/thread message stamp failed/);
    expect(row("agent_thread_messages", M1).distill_claimed_at).toBeNull();
    expect(isStamped("agent_runs", TIP)).toBe(false);
  });

  it("a failed run stamp throws; the retry stamps the runs without distilling again", async () => {
    H.failUpdate = (table, payload) => table === "agent_runs" && "distilled_at" in payload;
    await expect(distillChatTurn(TIP)).rejects.toThrow(/agent_runs stamp failed/);
    expect(isStamped("agent_thread_messages", M1)).toBe(true);
    H.failUpdate = null;
    await distillChatTurn(TIP);
    expect(H.distillCalls).toHaveLength(1);
    expect(isStamped("agent_runs", ROOT)).toBe(true);
    expect(isStamped("agent_runs", TIP)).toBe(true);
  });

  it("a failed note write throws, leaves the turn unstamped and gives the claim back", async () => {
    H.distillResult = { ...H.distillResult, failed: 1 };
    await expect(distillChatTurn(TIP)).rejects.toThrow(/note write/);
    expect(isStamped("agent_runs", TIP)).toBe(false);
    expect(isStamped("agent_thread_messages", M1)).toBe(false);
    expect(row("agent_thread_messages", M1).distill_claimed_at).toBeNull();
  });

  it("the kill switch leaves everything unstamped", async () => {
    process.env.PRAXIS_DISTILL_CHAT_ENABLED = "0";
    await distillChatTurn(TIP);
    expect(H.ops).toHaveLength(0);
    expect(H.distillCalls).toHaveLength(0);
  });

  it("a missing run row is an unstamped no-op", async () => {
    await distillChatTurn("not-a-run");
    expect(stampWrites()).toHaveLength(0);
    expect(H.distillCalls).toHaveLength(0);
  });

  it("a non-chat run is left to the other distiller", async () => {
    row("agent_runs", TIP).trigger = "cron";
    await distillChatTurn(TIP);
    expect(stampWrites()).toHaveLength(0);
    expect(H.distillCalls).toHaveLength(0);
  });
});

describe("buildChatTurnTranscript", () => {
  it("cuts the user's words and the outcome to half each when the turn alone is over budget", () => {
    const out = buildChatTurnTranscript({
      prior: [{ sender_role: "user", body: "OLDTURN" }],
      userBody: "U".repeat(500),
      replies: [{ label: "a", body: "early" }, { label: "a", body: "T".repeat(500) }],
      max: 300,
    });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("**user**: UUU");
    expect(out).toContain("**a**: TTT");
    expect(out).not.toContain("OLDTURN");
    expect(out).not.toContain("early");
  });
});

describe("review fixes: forged ancestry, claim token, successor query", () => {
  it("a USER-created run naming the root as its origin does not silence the root", async () => {
    row("agent_runs", TIP).enqueued_by = "user-2";
    await distillChatTurn(ROOT);
    expect(H.distillCalls).toHaveLength(1);
    expect(H.distillCalls[0].operator_message).toBe("launch the spring promo at $40/day");
  });

  it("a USER-created run's resume_of_run_id is never followed (it is its own root)", async () => {
    row("agent_runs", TIP).enqueued_by = "user-2";
    await distillChatTurn(TIP);
    expect(H.distillCalls).toHaveLength(0);
    expect(isStamped("agent_thread_messages", M1)).toBe(false);
    expect(isStamped("agent_runs", ROOT)).toBe(false);
    expect(isStamped("agent_runs", TIP)).toBe(true);
  });

  it("a failed distill gives back only ITS claim, never one a later worker took", async () => {
    H.distillResult = { ...H.distillResult, failed: 1 };
    H.duringDistill = () => {
      row("agent_thread_messages", M1).distill_claimed_at = "2099-01-01T00:00:00.000Z";
    };
    await expect(distillChatTurn(TIP)).rejects.toThrow(/note write/);
    expect(row("agent_thread_messages", M1).distill_claimed_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("any number of FAILED server continuations never defers the root forever", async () => {
    row("agent_runs", TIP).status = "failed";
    for (let i = 0; i < 80; i++) H.tables.agent_runs.push(tipRun({ id: `failed-${i}`, status: "failed" }));
    await distillChatTurn(ROOT);
    expect(H.distillCalls).toHaveLength(1);
  });

  it("many unrelated rows naming the root cannot hide a failed real continuation", async () => {
    row("agent_runs", TIP).status = "failed";
    for (let i = 0; i < 60; i++) {
      H.tables.agent_runs.push(tipRun({ id: `noise-${i}`, status: "queued", payload: { thread_id: "other-thread", resume_of_run_id: ROOT } }));
    }
    await distillChatTurn(ROOT);
    expect(H.distillCalls).toHaveLength(1);
    const succ = H.ops.find((o) => o.table === "agent_runs" && o.filters.some(([k, c]) => k === "eq" && c === "payload->>resume_of_run_id"))!;
    expect(succ.filters).toContainEqual(["eq", "payload->>thread_id", TH]);
    expect(succ.filters).toContainEqual(["is", "enqueued_by", null]);
  });
});
