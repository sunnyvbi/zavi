
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueWorkItem = vi.fn();
const reserveSlackAnswerBarrier = vi.fn();
vi.mock("@/services/agents/work-queue", () => ({
  enqueueWorkItem: (...a: unknown[]) => enqueueWorkItem(...a),
}));
vi.mock("@/services/slack/outbox", () => ({
  reserveSlackAnswerBarrier: (...a: unknown[]) => reserveSlackAnswerBarrier(...a),
}));

import {
  applySlackMessageLifecycle,
  isSlackReplySuppressed,
} from "../source-message-lifecycle";

type Op = {
  table: string;
  verb: "select" | "update" | "rpc";
  eqs: Record<string, unknown>;
  neqs: Record<string, unknown>;
  inList: { col: string; vals: unknown[] } | null;
  patch: Record<string, unknown> | null;
  rpcName?: string;
  rpcParams?: Record<string, unknown>;
};

function fakeClient(handler: (op: Op) => { data: unknown; error: unknown }) {
  const ops: Op[] = [];
  const client = {
    rpc(name: string, params: Record<string, unknown>) {
      const op: Op = {
        table: `rpc:${name}`, verb: "rpc", eqs: {}, neqs: {}, inList: null, patch: null,
        rpcName: name, rpcParams: params,
      };
      ops.push(op);
      return Promise.resolve(handler(op));
    },
    from(table: string) {
      const op: Op = { table, verb: "select", eqs: {}, neqs: {}, inList: null, patch: null };
      const settle = () => Promise.resolve(handler(op));
      const chain: Record<string, unknown> = {
        select() { return chain; },
        update(p: Record<string, unknown>) { op.verb = "update"; op.patch = p; return chain; },
        eq(col: string, val: unknown) { op.eqs[col] = val; return chain; },
        neq(col: string, val: unknown) { op.neqs[col] = val; return chain; },
        in(col: string, vals: unknown[]) { op.inList = { col, vals }; return chain; },
        maybeSingle() { ops.push(op); return settle(); },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          ops.push(op); return settle().then(onF, onR);
        },
      };
      return chain;
    },
  };
  return { client: client as never, ops };
}

const KEY = { tenant_id: "t1", team_id: "T1", channel_id: "C1", source_ts: "50.0001" };

beforeEach(() => {
  enqueueWorkItem.mockReset();
  enqueueWorkItem.mockResolvedValue({ work_item_id: "wi_refire" });
  reserveSlackAnswerBarrier.mockReset();
  reserveSlackAnswerBarrier.mockResolvedValue(undefined);
});

describe("isSlackReplySuppressed (event_id gate)", () => {
  it("no row → not suppressed", async () => {
    const { client } = fakeClient(() => ({ data: null, error: null }));
    expect(await isSlackReplySuppressed({ sc: client, ...KEY, run_event_id: "EvOrig" } as never))
      .toEqual({ suppressed: false });
  });

  it("tombstoned → suppressed regardless of event_id", async () => {
    const { client } = fakeClient(() => ({
      data: { tombstoned: true, latest_edit_ts: null, latest_refire_event_id: null }, error: null,
    }));
    expect(await isSlackReplySuppressed({ sc: client, ...KEY, run_event_id: "EvOrig" } as never))
      .toEqual({ suppressed: true, reason: "tombstoned" });
  });

  it("edited + this run is NOT the winner event → suppressed (original run)", async () => {
    const { client } = fakeClient(() => ({
      data: { tombstoned: false, latest_edit_ts: "100.2", latest_refire_event_id: "EvEdit" }, error: null,
    }));
    expect(await isSlackReplySuppressed({ sc: client, ...KEY, run_event_id: "EvOrig" } as never))
      .toEqual({ suppressed: true, reason: "superseded" });
  });

  it("edited + this run IS the winner event → allowed (the re-fire + its handoff child)", async () => {
    const { client } = fakeClient(() => ({
      data: { tombstoned: false, latest_edit_ts: "100.2", latest_refire_event_id: "EvEdit" }, error: null,
    }));
    expect(await isSlackReplySuppressed({ sc: client, ...KEY, run_event_id: "EvEdit" } as never))
      .toEqual({ suppressed: false });
  });

  it("fails OPEN on read error", async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: "boom" } }));
    expect(await isSlackReplySuppressed({ sc: client, ...KEY, run_event_id: "EvOrig" } as never))
      .toEqual({ suppressed: false });
  });

  it("missing identity fields → not suppressed, no lookup", async () => {
    const { client, ops } = fakeClient(() => ({ data: null, error: null }));
    expect(await isSlackReplySuppressed({
      sc: client, tenant_id: "t1", team_id: "", channel_id: "C1", source_ts: "1.1", run_event_id: "E",
    } as never)).toEqual({ suppressed: false });
    expect(ops).toHaveLength(0);
  });
});

const DELETE_EVENT = { type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: "50.0001" };
const EDIT_EVENT = {
  type: "message", subtype: "message_changed", channel: "C1",
  message: { ts: "50.0001", text: "edited text", user: "U9", edited: { ts: "100.0002", user: "U9" } },
};

describe("applySlackMessageLifecycle (slice 3 re-fire)", () => {
  it("delete → RPC tombstone, stops ALL runs, drops ALL items, no re-fire", async () => {
    const { client, ops } = fakeClient((op) => {
      if (op.verb === "rpc") return { data: [{ tombstoned: true, latest_edit_ts: null, latest_refire_event_id: null }], error: null };
      if (op.table === "agent_runs" && op.verb === "select") return { data: [{ id: "run1" }], error: null };
      if (op.table === "agent_runs" && op.verb === "update") return op.eqs.status === "queued" ? { data: [{ id: "run1" }], error: null } : { data: [], error: null };
      if (op.table === "agent_work_items") return { data: [{ id: "wi1" }], error: null };
      return { data: null, error: null };
    });
    const res = await applySlackMessageLifecycle({ sc: client, tenant_id: "t1", team_id: "T1", edit_event_id: "EvDel", event: DELETE_EVENT } as never);
    expect(res).toMatchObject({ handled: true, kind: "deleted", runs_stopped: 1, pending_items_dropped: 1, refired: false });
    const rpc = ops.find((o) => o.verb === "rpc");
    expect(rpc?.rpcName).toBe("mark_slack_source_lifecycle");
    expect(rpc?.rpcParams).toMatchObject({ p_tombstone: true, p_edit_ts: null });
    const runSel = ops.find((o) => o.table === "agent_runs" && o.verb === "select");
    expect(runSel?.neqs).toEqual({});
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("non-user message_changed (no edited.ts) → skipped, no RPC, no re-fire", async () => {
    const { client, ops } = fakeClient(() => ({ data: null, error: null }));
    const unfurl = { type: "message", subtype: "message_changed", channel: "C1", message: { ts: "50.0001", text: "x" } };
    const res = await applySlackMessageLifecycle({ sc: client, tenant_id: "t1", team_id: "T1", edit_event_id: "EvU", event: unfurl } as never);
    expect(res).toEqual({ handled: false, reason: "not_user_edit" });
    expect(ops).toHaveLength(0);
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("bot-authored edit → skipped", async () => {
    const { client } = fakeClient(() => ({ data: null, error: null }));
    const botEdit = { type: "message", subtype: "message_changed", channel: "C1", message: { ts: "50.0001", text: "x", bot_id: "B1", edited: { ts: "100.1" } } };
    const res = await applySlackMessageLifecycle({ sc: client, tenant_id: "t1", team_id: "T1", edit_event_id: "EvB", event: botEdit } as never);
    expect(res).toEqual({ handled: false, reason: "not_user_edit" });
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("edit WINNER → stops only stale runs (neq winner), enqueues re-fire, reserves barrier", async () => {
    const { client, ops } = fakeClient((op) => {
      if (op.verb === "rpc") return { data: [{ tombstoned: false, latest_edit_ts: "100.0002", latest_refire_event_id: "EvEdit" }], error: null };
      if (op.table === "agent_runs" && op.verb === "select") return { data: [{ id: "orig" }], error: null };
      if (op.table === "agent_runs" && op.verb === "update") return op.eqs.status === "queued" ? { data: [{ id: "orig" }], error: null } : { data: [], error: null };
      if (op.table === "agent_work_items") return { data: [], error: null };
      return { data: null, error: null };
    });
    const res = await applySlackMessageLifecycle({ sc: client, tenant_id: "t1", team_id: "T1", edit_event_id: "EvEdit", event: EDIT_EVENT } as never);
    expect(res).toMatchObject({ handled: true, kind: "changed", refired: true, runs_stopped: 1 });
    const runSel = ops.find((o) => o.table === "agent_runs" && o.verb === "select");
    expect(runSel?.neqs).toMatchObject({ "payload->slack->>event_id": "EvEdit" });
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    const arg = (enqueueWorkItem.mock.calls[0] as unknown[])[0] as { agent_slug: string; source: string; dedupe_key: string; payload: { slack: Record<string, unknown> } };
    expect(arg).toMatchObject({ agent_slug: "operator", source: "webhook_slack", dedupe_key: "slack:EvEdit" });
    expect(arg.payload.slack).toMatchObject({ channel_id: "C1", original_ts: "50.0001", event_id: "EvEdit", text: "edited text", user: "U9", team_id: "T1" });
    expect(reserveSlackAnswerBarrier).toHaveBeenCalledTimes(1);
  });

  it("edit LOSER (a newer edit already won) → no stop, no re-fire", async () => {
    const { client, ops } = fakeClient((op) => {
      if (op.verb === "rpc") return { data: [{ tombstoned: false, latest_edit_ts: "999.9", latest_refire_event_id: "EvNewer" }], error: null };
      return { data: null, error: null };
    });
    const res = await applySlackMessageLifecycle({ sc: client, tenant_id: "t1", team_id: "T1", edit_event_id: "EvEdit", event: EDIT_EVENT } as never);
    expect(res).toMatchObject({ handled: true, kind: "changed", refired: false, runs_stopped: 0 });
    expect(ops.filter((o) => o.table === "agent_runs")).toHaveLength(0);
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("edit but source tombstoned meanwhile → stops all, no re-fire", async () => {
    const { client, ops } = fakeClient((op) => {
      if (op.verb === "rpc") return { data: [{ tombstoned: true, latest_edit_ts: "100.0002", latest_refire_event_id: "EvEdit" }], error: null };
      if (op.table === "agent_runs" && op.verb === "select") return { data: [], error: null };
      return { data: null, error: null };
    });
    const res = await applySlackMessageLifecycle({ sc: client, tenant_id: "t1", team_id: "T1", edit_event_id: "EvEdit", event: EDIT_EVENT } as never);
    expect(res).toMatchObject({ handled: true, refired: false });
    const runSel = ops.find((o) => o.table === "agent_runs" && o.verb === "select");
    expect(runSel?.neqs).toEqual({});
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });
});
