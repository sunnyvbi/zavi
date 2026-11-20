
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called in this test");
  },
}));

import {
  tryOperatorSlackResume,
  INFRA_RETRY_CAP,
  type InfraRetryRow,
} from "@/services/agents/infra-retry";

type Resp = { data: unknown; error: { message: string } | null };

function makeSvc(responses: {
  decisions?: Resp;
  events?: Resp;
  cas?: Resp;
}) {
  const updates: Array<Record<string, unknown>> = [];
  function from(table: string) {
    const trace: Record<string, unknown> = { table, update: null };
    let resp: Resp;
    if (table === "decisions") resp = responses.decisions ?? { data: [], error: null };
    else if (table === "agent_run_events") resp = responses.events ?? { data: [], error: null };
    else if (table === "agent_runs") resp = responses.cas ?? { data: [{ id: "run-1" }], error: null };
    else resp = { data: null, error: null };
    const b: Record<string, unknown> = {
      update(p: Record<string, unknown>) {
        trace.update = p;
        updates.push(trace);
        return b;
      },
      select() {
        return b;
      },
      eq() {
        return b;
      },
      in() {
        return b;
      },
      limit() {
        return b;
      },
      then(resolve: (r: Resp) => void) {
        resolve(resp);
      },
    };
    return b;
  }
  return { svc: { from } as never, updates };
}

const row = (over: Partial<InfraRetryRow> = {}): InfraRetryRow => ({
  id: "run-1",
  tenant_id: "t1",
  agent_slug: "operator",
  status: "running",
  error: "boot_reap: orphaned by container restart (worker died mid-run)",
  infra_retry_count: 0,
  last_progress_at: "2026-07-03T16:45:30Z",
  trigger: "slack",
  ...over,
});

const evt = (tool_name: string, stage = "tool_use_completed") => ({
  stage,
  meta: { tool_name },
});

describe("tryOperatorSlackResume — resume path (zero real tool calls only)", () => {
  it("only assistant_turn events (pure thinking) + no decision → RESUMED (park queued, count+1, no send)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, updates } = makeSvc({
      events: {
        data: [evt("assistant_turn"), evt("assistant_turn"), evt("assistant_turn")],
        error: null,
      },
    });
    const ok = await tryOperatorSlackResume(svc, { send } as never, row());
    expect(ok).toBe(true);
    expect(updates.length).toBe(1);
    expect((updates[0].update as Record<string, unknown>).status).toBe("queued");
    expect((updates[0].update as Record<string, unknown>).infra_retry_count).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("NO tool events at all (pure greeting) → RESUMED", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ events: { data: [], error: null } });
    const ok = await tryOperatorSlackResume(svc, { send } as never, row());
    expect(ok).toBe(true);
  });
});

describe("tryOperatorSlackResume — fail-closed (falls through to re-send note)", () => {
  it("a MUTATING tool ran → NOT resumed", async () => {
    const send = vi.fn();
    const { svc, updates } = makeSvc({
      events: { data: [evt("assistant_turn"), evt("slack_send_message")], error: null },
    });
    const ok = await tryOperatorSlackResume(svc, { send } as never, row());
    expect(ok).toBe(false);
    expect(updates.length).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a READ-ONLY real tool (ToolSearch / web_fetch) ran → NOT resumed (zero-real-tool gate)", async () => {
    for (const tool of ["ToolSearch", "mcp__server__web_fetch__fetch"]) {
      const { svc } = makeSvc({
        events: { data: [evt("assistant_turn"), evt(tool)], error: null },
      });
      expect(await tryOperatorSlackResume(svc, { send: vi.fn() } as never, row())).toBe(false);
    }
  });

  it("a tool whose name merely CONTAINS a read-only token (web_fetch_and_post) → NOT resumed (exact match)", async () => {
    const { svc } = makeSvc({
      events: { data: [evt("web_fetch_and_post")], error: null },
    });
    expect(await tryOperatorSlackResume(svc, { send: vi.fn() } as never, row())).toBe(false);
  });

  it("a decision was emitted → NOT resumed", async () => {
    const { svc } = makeSvc({ decisions: { data: [{ id: "d1" }], error: null } });
    expect(await tryOperatorSlackResume(svc, { send: vi.fn() } as never, row())).toBe(false);
  });

  it("decisions read error → NOT resumed (fail-closed)", async () => {
    const { svc } = makeSvc({ decisions: { data: null, error: { message: "boom" } } });
    expect(await tryOperatorSlackResume(svc, { send: vi.fn() } as never, row())).toBe(false);
  });

  it("agent_run_events read error → NOT resumed (fail-closed)", async () => {
    const { svc } = makeSvc({ events: { data: null, error: { message: "boom" } } });
    expect(await tryOperatorSlackResume(svc, { send: vi.fn() } as never, row())).toBe(false);
  });
});

describe("tryOperatorSlackResume — scope guards", () => {
  it("non-slack trigger is NOT resumed by this path (chat/cron/a2a/manual)", async () => {
    for (const trigger of ["chat", "cron", "a2a", "manual", null] as const) {
      const { svc } = makeSvc({});
      expect(
        await tryOperatorSlackResume(svc, { send: vi.fn() } as never, row({ trigger })),
      ).toBe(false);
    }
  });

  it("non-operator slug is NOT resumed by this path", async () => {
    const { svc } = makeSvc({});
    expect(
      await tryOperatorSlackResume(svc, { send: vi.fn() } as never, row({ agent_slug: "pm" })),
    ).toBe(false);
  });

  it("money-path slug is NOT resumed (E3 firewall, belt)", async () => {
    const { svc } = makeSvc({});
    expect(
      await tryOperatorSlackResume(
        svc,
        { send: vi.fn() } as never,
        row({ agent_slug: "performance-marketer" }),
      ),
    ).toBe(false);
  });

  it("status !== running is NOT resumed (only pre-terminal orphans)", async () => {
    const { svc } = makeSvc({});
    expect(
      await tryOperatorSlackResume(svc, { send: vi.fn() } as never, row({ status: "failed" })),
    ).toBe(false);
  });

  it("at the retry cap is NOT resumed (poison-loop bound)", async () => {
    const { svc } = makeSvc({});
    expect(
      await tryOperatorSlackResume(
        svc,
        { send: vi.fn() } as never,
        row({ infra_retry_count: INFRA_RETRY_CAP }),
      ),
    ).toBe(false);
  });
});
