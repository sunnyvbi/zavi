
export type StagedSnapshot = {
  id: string;
  action: "approve" | "reject";
  emitted_at: string;
  bodyKey: string;
};

export type FreshProposal = {
  id: string;
  status: string;
  emitted_at: string;
  body: Record<string, unknown>;
  revisionActive: boolean;
};

export type ItemApplyState =
  | "staged"
  | "posting"
  | "dispatch_pending"
  | "acted"
  | "dispatch_failed"
  | "blocked";

export function stableBodyKey(body: Record<string, unknown> | null | undefined): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  try {
    return JSON.stringify(sortDeep(body ?? {}));
  } catch {
    return "";
  }
}

export function snapshotForStage(
  id: string,
  action: "approve" | "reject",
  fresh: { emitted_at: string; body: Record<string, unknown> },
): StagedSnapshot {
  return { id, action, emitted_at: fresh.emitted_at, bodyKey: stableBodyKey(fresh.body) };
}

export type RevalidationResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "not_proposed" | "changed" | "revision_active" };

export function revalidateStaged(
  snap: StagedSnapshot,
  freshById: Map<string, FreshProposal>,
): RevalidationResult {
  const fresh = freshById.get(snap.id);
  if (!fresh) return { ok: false, reason: "missing" };
  if (fresh.status !== "proposed") return { ok: false, reason: "not_proposed" };
  if (fresh.revisionActive) return { ok: false, reason: "revision_active" };
  if (fresh.emitted_at !== snap.emitted_at || stableBodyKey(fresh.body) !== snap.bodyKey) {
    return { ok: false, reason: "changed" };
  }
  return { ok: true };
}

export function blockReasonLabel(reason: "missing" | "not_proposed" | "changed" | "revision_active"): string {
  switch (reason) {
    case "missing":
      return "No longer pending, skipped.";
    case "not_proposed":
      return "Already resolved elsewhere, skipped.";
    case "revision_active":
      return "A revision is in progress, skipped.";
    case "changed":
      return "Changed since you staged it. Skipped, review again.";
  }
}

export function applyOrder(
  staged: Map<string, StagedSnapshot>,
  visibleOrder: string[],
): StagedSnapshot[] {
  const out: StagedSnapshot[] = [];
  for (const id of visibleOrder) {
    const s = staged.get(id);
    if (s) out.push(s);
  }
  return out;
}

export function stateFromPost(ok: boolean): ItemApplyState {
  return ok ? "dispatch_pending" : "dispatch_failed";
}

export function resolveTerminalFromReload(fresh: {
  status: string;
  dispatch_error: string | null;
} | undefined): ItemApplyState {
  if (!fresh) return "acted";
  if (fresh.dispatch_error) return "dispatch_failed";
  if (fresh.status === "approved" || fresh.status === "rejected") return "acted";
  return "dispatch_pending";
}
