
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  stableBodyKey,
  snapshotForStage,
  revalidateStaged,
  blockReasonLabel,
  applyOrder,
  stateFromPost,
  resolveTerminalFromReload,
  type FreshProposal,
  type StagedSnapshot,
} from "../triageStage";

function fresh(over: Partial<FreshProposal>): FreshProposal {
  return {
    id: "d1",
    status: "proposed",
    emitted_at: "2026-06-20T00:00:00Z",
    body: { daily_budget_usd: 100 },
    revisionActive: false,
    ...over,
  };
}

describe("stableBodyKey — order-insensitive", () => {
  it("same content, different key order → same key", () => {
    expect(stableBodyKey({ a: 1, b: 2 })).toBe(stableBodyKey({ b: 2, a: 1 }));
  });
  it("different content → different key", () => {
    expect(stableBodyKey({ a: 1 })).not.toBe(stableBodyKey({ a: 2 }));
  });
});

describe("revalidateStaged — stale-stage guard", () => {
  const snap = snapshotForStage("d1", "approve", {
    emitted_at: "2026-06-20T00:00:00Z",
    body: { daily_budget_usd: 100 },
  });

  it("unchanged + proposed + no revision → ok", () => {
    const map = new Map([["d1", fresh({})]]);
    expect(revalidateStaged(snap, map)).toEqual({ ok: true });
  });

  it("vanished → blocked: missing", () => {
    expect(revalidateStaged(snap, new Map())).toEqual({ ok: false, reason: "missing" });
  });

  it("no longer proposed → blocked: not_proposed", () => {
    const map = new Map([["d1", fresh({ status: "approved" })]]);
    expect(revalidateStaged(snap, map)).toEqual({ ok: false, reason: "not_proposed" });
  });

  it("revision now active → blocked: revision_active", () => {
    const map = new Map([["d1", fresh({ revisionActive: true })]]);
    expect(revalidateStaged(snap, map)).toEqual({ ok: false, reason: "revision_active" });
  });

  it("body changed since staged → blocked: changed", () => {
    const map = new Map([["d1", fresh({ body: { daily_budget_usd: 200 } })]]);
    expect(revalidateStaged(snap, map)).toEqual({ ok: false, reason: "changed" });
  });

  it("emitted_at changed since staged → blocked: changed", () => {
    const map = new Map([["d1", fresh({ emitted_at: "2026-06-21T00:00:00Z" })]]);
    expect(revalidateStaged(snap, map)).toEqual({ ok: false, reason: "changed" });
  });

  it("every reason has human copy", () => {
    for (const r of ["missing", "not_proposed", "changed", "revision_active"] as const) {
      expect(blockReasonLabel(r).length).toBeGreaterThan(0);
    }
  });
});

describe("applyOrder — staged items in visible order", () => {
  it("preserves the visible sequence, drops unstaged", () => {
    const staged = new Map<string, StagedSnapshot>([
      ["c", snapshotForStage("c", "approve", { emitted_at: "t", body: {} })],
      ["a", snapshotForStage("a", "reject", { emitted_at: "t", body: {} })],
    ]);
    const order = applyOrder(staged, ["a", "b", "c"]);
    expect(order.map((s) => s.id)).toEqual(["a", "c"]);
  });
});

describe("stateFromPost / resolveTerminalFromReload — POST 200 ≠ success", () => {
  it("2xx → dispatch_pending (NOT acted)", () => {
    expect(stateFromPost(true)).toBe("dispatch_pending");
  });
  it("non-2xx → dispatch_failed", () => {
    expect(stateFromPost(false)).toBe("dispatch_failed");
  });

  it("reload: gone from pending → acted", () => {
    expect(resolveTerminalFromReload(undefined)).toBe("acted");
  });
  it("reload: dispatch_error → dispatch_failed", () => {
    expect(resolveTerminalFromReload({ status: "proposed", dispatch_error: "cap exceeded" })).toBe(
      "dispatch_failed",
    );
  });
  it("reload: approved/rejected, no error → acted", () => {
    expect(resolveTerminalFromReload({ status: "approved", dispatch_error: null })).toBe("acted");
    expect(resolveTerminalFromReload({ status: "rejected", dispatch_error: null })).toBe("acted");
  });
  it("reload: still proposed, no error → still pending (unconfirmed)", () => {
    expect(resolveTerminalFromReload({ status: "proposed", dispatch_error: null })).toBe(
      "dispatch_pending",
    );
  });
});

describe("apply contract — sequential per-id, no batch, stale-guard", () => {
  async function driveApply(
    staged: Map<string, StagedSnapshot>,
    visibleOrder: string[],
    freshById: Map<string, FreshProposal>,
    post: (id: string, action: "approve" | "reject") => Promise<{ ok: boolean }>,
  ) {
    const fired: Array<{ id: string; action: string }> = [];
    const blocked: string[] = [];
    for (const snap of applyOrder(staged, visibleOrder)) {
      const check = revalidateStaged(snap, freshById);
      if (!check.ok) {
        blocked.push(snap.id);
        continue;
      }
      await post(snap.id, snap.action);
      fired.push({ id: snap.id, action: snap.action });
    }
    return { fired, blocked };
  }

  it("fires each staged endpoint exactly once, in order; never batches; skips changed", async () => {
    const staged = new Map<string, StagedSnapshot>([
      ["a", snapshotForStage("a", "approve", { emitted_at: "t", body: { x: 1 } })],
      ["b", snapshotForStage("b", "reject", { emitted_at: "t", body: { x: 2 } })],
      ["c", snapshotForStage("c", "approve", { emitted_at: "t", body: { x: 3 } })],
    ]);
    const freshById = new Map<string, FreshProposal>([
      ["a", fresh({ id: "a", emitted_at: "t", body: { x: 1 } })],
      ["b", fresh({ id: "b", emitted_at: "t", body: { x: 999 } })],
      ["c", fresh({ id: "c", emitted_at: "t", body: { x: 3 } })],
    ]);
    const post = vi.fn(async () => ({ ok: true }));

    const { fired, blocked } = await driveApply(staged, ["a", "b", "c"], freshById, post);

    expect(fired).toEqual([
      { id: "a", action: "approve" },
      { id: "c", action: "approve" },
    ]);
    expect(blocked).toEqual(["b"]);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(1, "a", "approve");
    expect(post).toHaveBeenNthCalledWith(2, "c", "approve");
  });

  it("an unstaged item dispatches nothing", async () => {
    const staged = new Map<string, StagedSnapshot>();
    const post = vi.fn(async () => ({ ok: true }));
    const { fired } = await driveApply(staged, ["a"], new Map([["a", fresh({ id: "a" })]]), post);
    expect(fired).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it("the triage apply path never references the approve-batch route + uses per-id POST", () => {
    const reviewer = readFileSync(
      fileURLToPath(new URL("../../workspace/agent/TriageReviewer.tsx", import.meta.url)),
      "utf8",
    );
    const parent = readFileSync(
      fileURLToPath(new URL("../../workspace/agent/PerfMarketerAgentState.tsx", import.meta.url)),
      "utf8",
    );
    expect(reviewer).not.toContain("approve-batch");
    expect(parent).not.toContain("approve-batch");
    expect(reviewer).not.toContain("reject-batch");
    expect(parent).not.toContain("reject-batch");
    expect(parent).toContain("/api/approvals/${id}/${action}");
  });
});
