
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  mode: "enforce",
  autonomy: {
    send_email: "approval",
    "github.merge_pr_direct": "forbidden",
    "slack.teammate_message": "auto",
    "stripe.create_payment": "approval",
  } as Record<string, string>,
  trigger: "cron" as string | null,
  stopped: false,
  failReceiptInsert: false,
  failReadOn: null as string | null,
};

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { agent_runs: [], custom_agents: [], custom_agent_write_receipts: [] };
const tenantReads: string[] = [];

vi.mock("@/services/settings", () => ({
  getStringSetting: async () => state.mode,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (_fn: string, p: { p_decision_class: string }) => ({
      data: state.autonomy[p.p_decision_class] ?? "approval",
      error: null,
    }),
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { trigger: state.trigger }, error: null }) }),
      }),
    }),
  }),
}));

vi.mock("@/services/tenant-client", () => {
  const tenantClient = (tid: string) => ({
    from: (table: string) => {
      tenantReads.push(table);
      return {
        select: () => {
          const filters: Array<[string, unknown]> = [["tenant_id", tid]];
          const rows = () => (db[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
          const b = {
            eq: (k: string, v: unknown) => {
              filters.push([k, v]);
              return b;
            },
            maybeSingle: async () =>
              state.failReadOn === table
                ? { data: null, error: { message: "read failed" } }
                : { data: rows()[0] ?? null, error: null },
          };
          return b;
        },
        insert: (row: Row) => ({
          select: () => ({
            single: async () => {
              if (state.failReceiptInsert) return { data: null, error: { message: "boom" } };
              const r = { ...row, tenant_id: tid, id: `rcpt-${db[table].length + 1}` };
              db[table].push(r);
              return { data: { id: r.id }, error: null };
            },
          }),
        }),
        update: (values: Row) => ({
          eq: async (k: string, v: unknown) => {
            for (const r of db[table]) if (r.tenant_id === tid && r[k] === v) Object.assign(r, values);
            return { error: null };
          },
        }),
      };
    },
  });
  return { tenantClient, asTenantId: (s: string) => s };
});

vi.mock("@/services/agents/run-stop", () => ({ isRunStopRequested: async () => state.stopped }));
vi.mock("@/services/agents/kill-switch", () => ({ isAgentKilled: async () => false }));
vi.mock("../streamable-client", () => ({ advertisedReadToolNames: () => undefined }));
vi.mock("@/services/provisioning/provisioned-repo-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/provisioning/provisioned-repo-gate")>()),
  assertProvisionedRepoTarget: async () => ({ ok: false, reason: "customer-repo" }),
}));

import { governActionOrBlock } from "../governance-enforce";
import { runCustomWrite, settleAround } from "@/services/agents/custom-agent-writes";
import { runWithToolEffectGuard } from "../tool-effect-ledger";

type Ctx = Parameters<typeof governActionOrBlock>[0];
const okResult = () => ({ ok: true, is_error: false, content: "{}", ms: 1 });
const blockedResult = (code: string, message: string) => ({
  ok: false,
  is_error: true,
  content: JSON.stringify({ error: code, message }),
  ms: 0,
});
async function fire(ctx: Ctx, server: string, tool: string, args: unknown = {}) {
  const gate = await governActionOrBlock(ctx, server, tool, args);
  if (gate.block || !gate.customWrite) return gate;
  await runCustomWrite(gate.customWrite, async () => okResult(), blockedResult);
  return gate;
}

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const SLUG = "c-abcd1234";

function seedCustom(status: string, opts: { tenant?: string; test_run_id?: string | null } = {}) {
  db.custom_agents.push({
    id: "agent-1",
    tenant_id: opts.tenant ?? A,
    slug: SLUG,
    status,
    test_run_id: opts.test_run_id ?? null,
  });
}
function seedRun(id: string, slug: string, opts: { tenant?: string; key?: string | null } = {}) {
  db.agent_runs.push({ id, tenant_id: opts.tenant ?? A, agent_slug: slug, cron_dedupe_key: opts.key ?? null });
}
const receipts = () => db.custom_agent_write_receipts;
const errCode = (g: Awaited<ReturnType<typeof governActionOrBlock>>) =>
  g.block ? (JSON.parse(g.result.content as string).error as string) : null;

beforeEach(() => {
  state.mode = "enforce";
  state.trigger = "cron";
  state.stopped = false;
  state.failReceiptInsert = false;
  state.failReadOn = null;
  db.agent_runs = [];
  db.custom_agents = [];
  db.custom_agent_write_receipts = [];
  tenantReads.length = 0;
});

describe("S3 — a verified custom agent writes with no approval", () => {
  const ctx = { tenant_id: A, run_id: "run-c", agent_slug: SLUG };

  it.each([
    ["an 'approval' class (email send)", "email", "send", "send_email"],
    ["a tenant-'forbidden' class (github squash_merge)", "github", "squash_merge", "github.merge_pr_direct"],
    ["an unmapped external write (remote MCP)", "acme_remote", "create_thing", null],
    ["money: stripe create_payment", "stripe", "create_payment", "stripe.create_payment"],
    ["a non-governed internal write (tiktok create_post)", "tiktok", "create_post", null],
    ["an allowlisted write (higgsfield generate_video)", "higgsfield", "generate_video", null],
    ["a memory write", "memory", "write", null],
  ])("%s → auto, with an attempted receipt", async (_l, server, tool, cls) => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    const gate = await fire(ctx, server, tool);
    expect(gate.block).toBe(false);
    expect(!gate.block && gate.customWrite).toBeTruthy();
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]).toMatchObject({
      tenant_id: A,
      run_id: "run-c",
      agent_id: "agent-1",
      tool_name: `${server}__${tool}`,
      decision_class: cls,
      outcome: "succeeded",
    });
  });

  it("a read is not a write: no receipt, normal path", async () => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    const gate = await fire(ctx, "praxis", "query_recent_runs");
    expect(gate).toEqual({ block: false });
    expect(receipts()).toHaveLength(0);
  });

  it("praxis__action is a receipted write labelled with its operator class", async () => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    const gate = await fire(ctx, "praxis", "action", { verb: "post-slack-message" });
    expect(gate.block).toBe(false);
    expect(receipts()[0]).toMatchObject({ tool_name: "praxis__action", decision_class: "operator.post-slack-message" });
  });

  it("a Stop still wins over a custom write (no receipt, not sent)", async () => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    state.stopped = true;
    const gate = await governActionOrBlock(ctx, "email", "send", {});
    expect(errCode(gate)).toBe("run_cancelled");
    expect(receipts()).toHaveLength(0);
  });

  it("if the receipt cannot be written, the write does not fire", async () => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    state.failReceiptInsert = true;
    const gate = await governActionOrBlock(ctx, "email", "send", {});
    expect(gate.block).toBe(false);
    const dispatch = vi.fn(async () => okResult());
    const r = await runCustomWrite(!gate.block && gate.customWrite ? gate.customWrite : (null as never), dispatch, blockedResult);
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(r.content).error).toBe("custom_agent_receipt_failed");
  });

  it.each(["agent_runs", "custom_agents"])("a failed %s lookup blocks the write (fail closed)", async (table) => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    state.failReadOn = table;
    const gate = await governActionOrBlock(ctx, "tiktok", "create_post", {});
    expect(errCode(gate)).toBe("custom_agent_check_failed");
    expect(receipts()).toHaveLength(0);
  });

  it("a replay answered by the tool-effect ledger adds no receipt", async () => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    const gate = await governActionOrBlock(ctx, "tiktok", "create_post", {});
    const intent = !gate.block && gate.customWrite ? gate.customWrite : (null as never);
    const committed = new Map<string, ReturnType<typeof okResult>>();
    const deps = {
      lookupCommitted: async (_r: string, t: string) => committed.get(t) ?? null,
      claimPending: async () => {},
      commit: async (_r: string, t: string, res: ReturnType<typeof okResult>) => void committed.set(t, res),
    } as never;
    const dispatch = vi.fn(async () => okResult());
    const call = () =>
      runWithToolEffectGuard({ tenant_id: A, run_id: "run-c", tool_use_id: "tu-1" } as never, "create_post", {}, () =>
        runCustomWrite(intent, dispatch, blockedResult), deps);
    await call();
    await call();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]).toMatchObject({ outcome: "succeeded" });
  });
});

describe("S3 — reads the side-effect classifier over-counts stay reads", () => {
  const ctx = { tenant_id: A, run_id: "run-c", agent_slug: SLUG };
  it.each([
    ["memory", "read"],
    ["operator_db", "query_user"],
    ["operator_db", "catalog"],
    ["operator_db", "codeact"],
  ])("%s__%s: active agent gets no receipt; paused agent can still read", async (server, tool) => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    expect(await fire(ctx, server, tool)).toEqual({ block: false });
    expect(receipts()).toHaveLength(0);
    db.custom_agents[0].status = "paused";
    expect(await fire(ctx, server, tool)).toEqual({ block: false });
    expect(receipts()).toHaveLength(0);
  });
});

describe("S3 — paused / archived / draft", () => {
  const ctx = { tenant_id: A, run_id: "run-c", agent_slug: SLUG };

  it.each(["paused", "archived"])("%s agent → blocked with a blocked_paused receipt", async (status) => {
    seedCustom(status);
    seedRun("run-c", SLUG);
    const gate = await governActionOrBlock(ctx, "slack", "post_message", {});
    expect(errCode(gate)).toBe("custom_agent_paused");
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]).toMatchObject({ outcome: "blocked_paused", tool_name: "slack__post_message", error: status });
  });

  it.each([
    ["tiktok", "create_post"],
    ["higgsfield", "generate_video"],
  ])("paused agent is blocked on the non-governed write %s__%s", async (server, tool) => {
    seedCustom("paused");
    seedRun("run-c", SLUG);
    const gate = await governActionOrBlock(ctx, server, tool, {});
    expect(errCode(gate)).toBe("custom_agent_paused");
    expect(receipts()[0]).toMatchObject({ outcome: "blocked_paused", tool_name: `${server}__${tool}` });
  });

  it("status is re-read per write: pause between two writes bites on the second", async () => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    expect((await governActionOrBlock(ctx, "email", "send", {})).block).toBe(false);
    db.custom_agents[0].status = "paused";
    expect(errCode(await governActionOrBlock(ctx, "email", "send", {}))).toBe("custom_agent_paused");
  });

  it("a draft writes only inside its own stamped Test run", async () => {
    seedCustom("draft", { test_run_id: "tok-1" });
    seedRun("run-test", SLUG, { key: "custom-test:tok-1" });
    seedRun("run-other", SLUG);
    const own = await governActionOrBlock({ tenant_id: A, run_id: "run-test", agent_slug: SLUG }, "email", "send", {});
    expect(own.block).toBe(false);
    const other = await governActionOrBlock({ tenant_id: A, run_id: "run-other", agent_slug: SLUG }, "email", "send", {});
    expect(errCode(other)).toBe("custom_agent_paused");
  });
});

describe("S3 — governed_chokepoint='off'", () => {
  it("still writes receipts for an active custom agent", async () => {
    state.mode = "off";
    seedCustom("active");
    seedRun("run-c", SLUG);
    const gate = await fire({ tenant_id: A, run_id: "run-c", agent_slug: SLUG }, "email", "send");
    expect(gate.block).toBe(false);
    expect(receipts()[0]).toMatchObject({ outcome: "succeeded" });
  });

  it("still blocks a paused custom agent", async () => {
    state.mode = "off";
    seedCustom("paused");
    seedRun("run-c", SLUG);
    const gate = await governActionOrBlock({ tenant_id: A, run_id: "run-c", agent_slug: SLUG }, "email", "send", {});
    expect(errCode(gate)).toBe("custom_agent_paused");
    expect(receipts()[0]).toMatchObject({ outcome: "blocked_paused" });
  });

  it("built-in agent under 'off' → unchanged (proceeds, no receipt, no custom read)", async () => {
    state.mode = "off";
    const gate = await governActionOrBlock(
      { tenant_id: A, run_id: "run-b", agent_slug: "performance-marketer" },
      "email",
      "send",
      {},
    );
    expect(gate).toEqual({ block: false });
    expect(tenantReads).toHaveLength(0);
  });
});

describe("S3 — identity: a c- slug is never custom by itself (fail closed)", () => {
  it("run of tenant A with a slug only tenant B owns → blocked, unverified", async () => {
    seedCustom("active", { tenant: B });
    seedRun("run-x", SLUG, { tenant: A });
    const gate = await governActionOrBlock({ tenant_id: A, run_id: "run-x", agent_slug: SLUG }, "email", "send", {});
    expect(errCode(gate)).toBe("custom_agent_unverified");
    expect(receipts()).toHaveLength(0);
  });

  it("ctx claims tenant A but the run row belongs to B → blocked", async () => {
    seedCustom("active", { tenant: B });
    seedRun("run-y", SLUG, { tenant: B });
    const gate = await governActionOrBlock({ tenant_id: A, run_id: "run-y", agent_slug: SLUG }, "email", "send", {});
    expect(errCode(gate)).toBe("custom_agent_unverified");
    expect(receipts()).toHaveLength(0);
  });

  it("forged slug: ctx says agent A's slug, the run belongs to custom agent B → blocked", async () => {
    seedCustom("active");
    db.custom_agents.push({ id: "agent-2", tenant_id: A, slug: "c-zzzz9999", status: "active", test_run_id: null });
    seedRun("run-b2", "c-zzzz9999");
    const gate = await governActionOrBlock({ tenant_id: A, run_id: "run-b2", agent_slug: SLUG }, "email", "send", {});
    expect(errCode(gate)).toBe("custom_agent_unverified");
  });

  it("no run_id with a c- slug on ctx → blocked", async () => {
    seedCustom("active");
    const gate = await governActionOrBlock({ tenant_id: A, agent_slug: SLUG }, "email", "send", {});
    expect(errCode(gate)).toBe("custom_agent_unverified");
  });

  it("ctx slug says custom but the run row is a built-in → blocked", async () => {
    seedCustom("active");
    seedRun("run-z", "performance-marketer");
    const gate = await governActionOrBlock({ tenant_id: A, run_id: "run-z", agent_slug: SLUG }, "email", "send", {});
    expect(errCode(gate)).toBe("custom_agent_unverified");
    expect(receipts()).toHaveLength(0);
  });

  it("no slug on ctx → unchanged path, no DB read (even for a custom run row)", async () => {
    seedCustom("active");
    seedRun("run-c", SLUG);
    const gate = await governActionOrBlock({ tenant_id: A, run_id: "run-c" }, "email", "send", {});
    expect(errCode(gate)).toBe("approval_channel_unavailable");
    expect(tenantReads).toHaveLength(0);
  });
});

describe("S3 — built-in agents are byte-unchanged (performance-marketer, cron)", () => {
  const ctx = { tenant_id: A, run_id: "run-b", agent_slug: "performance-marketer" };
  const snapshot = async () =>
    Promise.all([
      governActionOrBlock(ctx, "email", "send", {}),
      governActionOrBlock(ctx, "github", "squash_merge", {}),
      governActionOrBlock(ctx, "acme_remote", "create_thing", {}),
      governActionOrBlock(ctx, "stripe", "create_payment", {}),
      governActionOrBlock(ctx, "slack", "post_message", {}),
      governActionOrBlock(ctx, "tiktok", "create_post", {}),
      governActionOrBlock(ctx, "higgsfield", "generate_video", {}),
    ]);

  it("approval / forbidden / unmapped / money / auto resolve exactly as before, no receipts", async () => {
    seedRun("run-b", "performance-marketer");
    const gates = await snapshot();
    expect(gates.map(errCode)).toEqual([
      "approval_channel_unavailable",
      "action_forbidden",
      "approval_channel_unavailable",
      "approval_channel_unavailable",
      null,
      null,
      "approval_channel_unavailable",
    ]);
    for (const g of gates.slice(4, 6)) expect(g).toEqual({ block: false });
    expect(receipts()).toHaveLength(0);
    expect(tenantReads).toHaveLength(0);
  });

  it("with an emit_decision channel: approval still queues a decision", async () => {
    seedRun("run-b", "performance-marketer");
    const emit = vi.fn(async () => "dec-1");
    const email = { to: "a@b.co", subject: "Hi", body_text: "Hello" };
    const gate = await governActionOrBlock({ ...ctx, emit_decision: emit }, "email", "send", email);
    expect(errCode(gate)).toBe("pending_approval");
    expect(emit).toHaveBeenCalledWith("send_email", expect.objectContaining(email));
  });
});

describe("S3 — receipts settle after the write", () => {
  const receipt = { tenant_id: A, id: "rcpt-1" };
  beforeEach(() => {
    db.custom_agent_write_receipts = [{ id: "rcpt-1", tenant_id: A, outcome: "attempted", error: null }];
  });

  it("attempted → succeeded", async () => {
    const r = await settleAround(receipt, async () => ({ ok: true, is_error: false, content: "{}", ms: 1 }));
    expect(r.ok).toBe(true);
    expect(receipts()[0]).toMatchObject({ outcome: "succeeded", error: null });
  });

  it("attempted → failed on an error result (code only, no tool output)", async () => {
    await settleAround(receipt, async () => ({
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: "slack_api_error", message: "secret customer text" }),
      ms: 1,
    }));
    expect(receipts()[0]).toMatchObject({ outcome: "failed", error: "slack_api_error" });
  });

  it("attempted → failed on throw, and the throw propagates", async () => {
    await expect(
      settleAround(receipt, async () => {
        throw new Error("socket hang up: POST body={\"to\":\"jane@acme.com\"}");
      }),
    ).rejects.toThrow("socket hang up");
    expect(receipts()[0]).toMatchObject({ outcome: "failed", error: "threw" });
    expect(JSON.stringify(receipts())).not.toContain("jane@acme.com");
  });

  it("praxis__action that did not execute → failed with its status", async () => {
    await settleAround(receipt, async () => ({
      ok: true,
      is_error: false,
      content: JSON.stringify({ ok: true, status: "pending_approval", dispatch_error: null }),
      ms: 1,
    }));
    expect(receipts()[0]).toMatchObject({ outcome: "failed", error: "pending_approval" });
  });

  it("receipts of another tenant are never touched", async () => {
    await settleAround({ tenant_id: B, id: "rcpt-1" }, async () => ({ ok: true, is_error: false, content: "{}", ms: 1 }));
    expect(receipts()[0]).toMatchObject({ outcome: "attempted" });
  });
});
