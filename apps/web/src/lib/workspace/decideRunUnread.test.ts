import { describe, it, expect } from "vitest";
import {
  decideRunToast,
  decideRunUnread,
  type RunEndThreadEvent,
} from "./decideRunUnread";

function row(over: Partial<RunEndThreadEvent> = {}): RunEndThreadEvent {
  return {
    id: 1,
    kind: "run_end",
    tenant_id: "t-1",
    agent_slug: "engineer",
    agent_run_id: "run-1",
    thread_id: "thread-1",
    body: { status: "success" },
    ...over,
  };
}

const ctx = (seenRunIds: Set<string> = new Set()) => ({ seenRunIds });

describe("decideRunUnread", () => {
  it("marks a success completion", () => {
    expect(decideRunUnread(row(), ctx())).toMatchObject({
      action: "mark",
      dedupeKey: "run-1",
    });
  });

  it.each(["failed", "error", "parse_failed", "dispatch_error", "boom", undefined])(
    "marks non-success status %s the same as success (a dot has no severity)",
    (status) => {
      const d = decideRunUnread(row({ body: { status: status as string } }), ctx());
      expect(d.action).toBe("mark");
    },
  );

  it("marks regardless of `answered` — it only ever picked a toast colour", () => {
    expect(decideRunUnread(row({ body: { status: "failed", answered: true } }), ctx()).action).toBe(
      "mark",
    );
    expect(decideRunUnread(row({ body: { status: "error", answered: false } }), ctx()).action).toBe(
      "mark",
    );
  });

  it("skips a cancelled run (user-initiated stop)", () => {
    expect(decideRunUnread(row({ body: { status: "cancelled" } }), ctx()).action).toBe("skip");
  });

  it("cancelled + answered:true → still skipped (cancel wins, the user stopped it)", () => {
    const d = decideRunUnread(row({ body: { status: "cancelled", answered: true } }), ctx());
    expect(d.action).toBe("skip");
  });

  it("dedupes by agent_run_id — no double mark", () => {
    expect(decideRunUnread(row(), ctx(new Set(["run-1"]))).action).toBe("skip");
  });

  it("dedupes null agent_run_id by evt:<id> (not collapsed into one)", () => {
    const a = decideRunUnread(row({ agent_run_id: null, id: 10 }), ctx());
    const b = decideRunUnread(row({ agent_run_id: null, id: 11 }), ctx());
    expect(a).toMatchObject({ action: "mark", dedupeKey: "evt:10" });
    expect(b).toMatchObject({ action: "mark", dedupeKey: "evt:11" });
    expect((a as { dedupeKey: string }).dedupeKey).not.toBe(
      (b as { dedupeKey: string }).dedupeKey,
    );
  });

  it("marks a broadcast (cron/scheduled, thread_id null)", () => {
    expect(decideRunUnread(row({ thread_id: null }), ctx()).action).toBe("mark");
  });
});

const toastRow = (body: Record<string, unknown>, over: Partial<RunEndThreadEvent> = {}) =>
  row({ thread_id: "thread-1", body: { status: "success", trigger: "chat", ...body }, ...over });

const tctx = (
  over: { seenRunIds?: Set<string>; watching?: boolean } = {},
) => ({ seenRunIds: over.seenRunIds ?? new Set<string>(), watching: over.watching ?? false });

describe("decideRunToast", () => {
  it("raises a question toast when the run ended by asking", () => {
    expect(decideRunToast(toastRow({ question: true }), tctx())).toMatchObject({
      action: "toast",
      kind: "question",
      dedupeKey: "run-1",
    });
  });

  it("raises a question even when the run produced no deliverable", () => {
    const d = decideRunToast(toastRow({ question: true, answered: false }), tctx());
    expect(d).toMatchObject({ action: "toast", kind: "question" });
  });

  it("raises an output toast for an answered run", () => {
    expect(decideRunToast(toastRow({ answered: true }), tctx())).toMatchObject({
      action: "toast",
      kind: "output",
    });
  });

  it("stays silent for a run that produced nothing to review", () => {
    expect(decideRunToast(toastRow({ status: "error" }), tctx()).action).toBe("skip");
    expect(decideRunToast(toastRow({ answered: false }), tctx()).action).toBe("skip");
  });

  it("stays silent while the operator is WATCHING the run", () => {
    expect(
      decideRunToast(toastRow({ question: true }), tctx({ watching: true })).action,
    ).toBe("skip");
    expect(
      decideRunToast(toastRow({ answered: true }), tctx({ watching: true })).action,
    ).toBe("skip");
  });

  it("stays silent for a cancelled run", () => {
    expect(
      decideRunToast(toastRow({ status: "cancelled", answered: true }), tctx()).action,
    ).toBe("skip");
  });

  it.each(["error", "failed"])(
    "a %s run raises nothing, even carrying a question (it failed after asking)",
    (status) => {
      expect(decideRunToast(toastRow({ status, question: true }), tctx()).action).toBe("skip");
    },
  );

  it("a run with no thread raises nothing — a toast would point nowhere", () => {
    expect(
      decideRunToast(toastRow({ trigger: "cron", answered: true }, { thread_id: null }), tctx()).action,
    ).toBe("skip");
  });

  it("dedupes a redelivered row", () => {
    const seen = new Set(["run-1"]);
    expect(decideRunToast(toastRow({ answered: true }), tctx({ seenRunIds: seen })).action).toBe(
      "skip",
    );
  });

  it("notifies for a web chat run", () => {
    expect(decideRunToast(toastRow({ trigger: "chat", answered: true }), tctx()).action).toBe("toast");
  });

  it.each(["slack", "whatsapp", "telegram", "discord", "teams", "email", "a2a", "handoff", "mcp", "webhook", "staff_console", "cron", "manual"])(
    "stays silent for a %s run — answered on another surface, or plumbing",
    (trigger) => {
      expect(decideRunToast(toastRow({ trigger, answered: true, question: true }), tctx()).action).toBe(
        "skip",
      );
    },
  );

  it("fails QUIET on a row with no trigger stamp (pre-2026-09-22 / reap emits)", () => {
    const d = decideRunToast(row({ body: { status: "success", answered: true } }), tctx());
    expect(d).toMatchObject({ action: "skip" });
  });
});
