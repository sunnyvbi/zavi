import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  tenant_id: string;
  kind: string;
  status: string;
  objective: string;
  goal_graph: Array<{ id?: string; status?: string; child_run_id?: string | null; payload?: Record<string, unknown> }>;
  created_at: string;
};

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  seq: 0,
  clock: 0,
  failNextUpdate: null as string | null,
}));

function claimKey(r: Row): string | null {
  const p = r.goal_graph?.[0]?.payload ?? {};
  if (r.kind !== "undo" || !["proposed", "done"].includes(r.status) || p.undo_claim !== true) return null;
  return `${r.tenant_id}|${String(p.parent_conductor_run_id)}`;
}

function uniqueViolation(): boolean {
  const seen = new Set<string>();
  for (const r of db.rows) {
    const k = claimKey(r);
    if (!k) continue;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "agent_runs") {
        const api: Record<string, unknown> = {};
        api.select = () => api;
        api.eq = () => api;
        api.maybeSingle = async () => ({ data: { output_text: null, parsed: { commit_sha: "a".repeat(40) } }, error: null });
        return api;
      }
      if (table !== "conductor_runs") throw new Error(`unexpected table ${table}`);
      const filters: Array<[string, unknown]> = [];
      const before: Array<[string, string]> = [];
      let op: "select" | "insert" | "update" = "select";
      let payload: Record<string, unknown> = {};
      const match = (r: Row) =>
        filters.every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v) &&
        before.every(([k, v]) => String((r as unknown as Record<string, unknown>)[k]) < v);
      const api: Record<string, unknown> = {};
      api.select = () => api;
      api.eq = (k: string, v: unknown) => {
        filters.push([k, v]);
        return api;
      };
      api.lt = (k: string, v: string) => {
        before.push([k, v]);
        return api;
      };
      api.order = () => api;
      api.limit = async () => ({
        data: db.rows
          .filter(match)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((r) => ({ id: r.id, status: r.status, goal_graph: r.goal_graph })),
        error: null,
      });
      api.insert = (row: Record<string, unknown>) => {
        op = "insert";
        payload = row;
        return api;
      };
      api.single = async () => {
        if (op !== "insert") throw new Error("single only used on insert");
        const row = {
          ...(payload as unknown as Row),
          id: `cr-${++db.seq}`,
          created_at: new Date(Date.now() + db.clock++ * 1000).toISOString(),
        };
        db.rows.push(row);
        if (uniqueViolation()) {
          db.rows.pop();
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"conductor_runs_undo_claim_uq\"" } };
        }
        return { data: { id: row.id }, error: null };
      };
      api.update = (patch: Record<string, unknown>) => {
        op = "update";
        payload = patch;
        return api;
      };
      api.then = (resolve: (v: unknown) => void) => {
        if (op !== "update") return resolve({ data: null, error: null });
        if (db.failNextUpdate) {
          const message = db.failNextUpdate;
          db.failNextUpdate = null;
          return resolve({ data: null, error: { message } });
        }
        for (const r of db.rows.filter(match)) Object.assign(r, payload);
        resolve({ data: null, error: null });
      };
      return api;
    },
  }),
}));

import { realRefineUndoDeps, UndoBlocked, UNDO_CLAIM_STALE_MS, type UndoClaimParams } from "@/services/agents/refine-undo";

const T = "tnt-yoga";
const OTHER = "tnt-other";

function claimFor(tenant_id: string, parent = "edit-colour"): UndoClaimParams {
  return {
    tenant_id,
    objective: "[undo] revert aaaaaaa",
    parent_conductor_run_id: parent,
    reverted_commit_sha: "a".repeat(40),
    branch: "main",
  };
}

function refineRow(id: string, tenant_id = T): Row {
  const row: Row = {
    id,
    tenant_id,
    kind: "build_app",
    status: "done",
    objective: "[refine] colour",
    goal_graph: [{ child_run_id: `ar-${id}`, payload: { stage: "build", refine_mode: true } }],
    created_at: new Date(Date.now() - 3_600_000 + db.clock++ * 1000).toISOString(),
  };
  db.rows.push(row);
  return row;
}

beforeEach(() => {
  db.rows = [];
  db.seq = 0;
  db.clock = 0;
  db.failNextUpdate = null;
});

describe("DEL-1323 B29 M2: the undo claim is one conditional insert", () => {
  it("writes a pending undo row that already blocks another undo of the same edit", async () => {
    refineRow("edit-colour");
    const id = await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    const row = db.rows.find((r) => r.id === id)!;
    expect(row).toMatchObject({ tenant_id: T, kind: "undo", status: "proposed" });
    expect(row.goal_graph[0].payload).toMatchObject({
      stage: "undo",
      undo_claim: true,
      parent_conductor_run_id: "edit-colour",
      new_commit_sha: null,
    });
    expect(await realRefineUndoDeps.loadLatestShippedRefine(T)).toBeNull();
  });

  it("a second claim for the same edit maps the unique violation to undo_in_progress", async () => {
    await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    const second = realRefineUndoDeps.claimUndoRun!(claimFor(T));
    await expect(second).rejects.toBeInstanceOf(UndoBlocked);
    await expect(realRefineUndoDeps.claimUndoRun!(claimFor(T))).rejects.toMatchObject({ reason: "undo_in_progress" });
    expect(db.rows.filter((r) => r.kind === "undo")).toHaveLength(1);
  });

  it("another tenant's claim on an edit with the same id never blocks this tenant", async () => {
    await realRefineUndoDeps.claimUndoRun!(claimFor(OTHER));
    await expect(realRefineUndoDeps.claimUndoRun!(claimFor(T))).resolves.toMatch(/^cr-/);
  });

  it("releasing marks the claim failed, which frees a retry and no longer hides the edit", async () => {
    refineRow("edit-colour");
    const id = await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    await realRefineUndoDeps.releaseUndoRun!({ tenant_id: T, id });
    expect(db.rows.find((r) => r.id === id)!.status).toBe("failed");
    expect((await realRefineUndoDeps.loadLatestShippedRefine(T))?.conductor_run_id).toBe("edit-colour");
    await expect(realRefineUndoDeps.claimUndoRun!(claimFor(T))).resolves.toMatch(/^cr-/);
  });

  it("settling marks the claim done with the revert commit, and keeps blocking a second undo", async () => {
    const id = await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    await realRefineUndoDeps.settleUndoRun!({ ...claimFor(T), id, new_commit_sha: "b".repeat(40) });
    const row = db.rows.find((r) => r.id === id)!;
    expect(row.status).toBe("done");
    expect(row.goal_graph[0].payload).toMatchObject({ undo_claim: true, new_commit_sha: "b".repeat(40), stage: "undo" });
    await expect(realRefineUndoDeps.claimUndoRun!(claimFor(T))).rejects.toMatchObject({ reason: "undo_in_progress" });
  });

  it("settle and release are tenant scoped: another tenant's id does not move this tenant's claim", async () => {
    const id = await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    await realRefineUndoDeps.releaseUndoRun!({ tenant_id: OTHER, id });
    await realRefineUndoDeps.settleUndoRun!({ ...claimFor(OTHER), id, new_commit_sha: "c".repeat(40) });
    expect(db.rows.find((r) => r.id === id)!.status).toBe("proposed");
  });

  it("a settled claim is not re-released by a late failure path", async () => {
    const id = await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    await realRefineUndoDeps.settleUndoRun!({ ...claimFor(T), id, new_commit_sha: "b".repeat(40) });
    await realRefineUndoDeps.releaseUndoRun!({ tenant_id: T, id });
    expect(db.rows.find((r) => r.id === id)!.status).toBe("done");
  });

  it("a claim stuck pending past the stale window no longer blocks: it is marked failed and a new claim lands", async () => {
    refineRow("edit-colour");
    const stuck = await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    db.rows.find((r) => r.id === stuck)!.created_at = new Date(Date.now() - UNDO_CLAIM_STALE_MS - 60_000).toISOString();
    const fresh = await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    expect(fresh).not.toBe(stuck);
    expect(db.rows.find((r) => r.id === stuck)!.status).toBe("failed");
    expect(db.rows.find((r) => r.id === fresh)!.status).toBe("proposed");
    await expect(realRefineUndoDeps.claimUndoRun!(claimFor(T))).rejects.toMatchObject({ reason: "undo_in_progress" });
  });

  it("a pending claim inside the stale window still blocks", async () => {
    const recent = await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    db.rows.find((r) => r.id === recent)!.created_at = new Date(Date.now() - UNDO_CLAIM_STALE_MS + 60_000).toISOString();
    await expect(realRefineUndoDeps.claimUndoRun!(claimFor(T))).rejects.toMatchObject({ reason: "undo_in_progress" });
    expect(db.rows.find((r) => r.id === recent)!.status).toBe("proposed");
  });

  it("stale cleanup never touches another tenant's claim or a settled undo", async () => {
    const theirs = await realRefineUndoDeps.claimUndoRun!(claimFor(OTHER));
    const settled = await realRefineUndoDeps.claimUndoRun!(claimFor(T, "edit-older"));
    await realRefineUndoDeps.settleUndoRun!({ ...claimFor(T, "edit-older"), id: settled, new_commit_sha: "b".repeat(40) });
    const old = new Date(Date.now() - UNDO_CLAIM_STALE_MS * 3).toISOString();
    db.rows.find((r) => r.id === theirs)!.created_at = old;
    db.rows.find((r) => r.id === settled)!.created_at = old;
    await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    expect(db.rows.find((r) => r.id === theirs)!.status).toBe("proposed");
    expect(db.rows.find((r) => r.id === settled)!.status).toBe("done");
  });

  it("a settle write error surfaces instead of being swallowed", async () => {
    const id = await realRefineUndoDeps.claimUndoRun!(claimFor(T));
    db.failNextUpdate = "timeout";
    await expect(
      realRefineUndoDeps.settleUndoRun!({ ...claimFor(T), id, new_commit_sha: "b".repeat(40) }),
    ).rejects.toThrow("timeout");
  });
});

describe("a build slot held for a preview-only undo is retired, not left as a failed build", () => {
  function heldSlot(id: string, tenant_id = T, status = "provisioning"): Row {
    const row: Row = {
      id,
      tenant_id,
      kind: "build_app",
      status,
      objective: "[refine] republish alpha.zaviagent.com",
      goal_graph: [],
      created_at: new Date(Date.now() + db.clock++ * 1000).toISOString(),
    };
    db.rows.push(row);
    return row;
  }

  it("turns the held row into a failed undo row, which no build list, daily count or undo claim reads", async () => {
    const row = heldSlot("slot-1");
    await realRefineUndoDeps.discardHeldSlot!({ tenant_id: T, conductor_run_id: "slot-1" });
    expect(row).toMatchObject({ kind: "undo", status: "failed" });
    expect(db.rows.filter((r) => r.kind === "build_app")).toEqual([]);
    expect(claimKey(row)).toBeNull();
    await expect(realRefineUndoDeps.claimUndoRun!(claimFor(T))).resolves.toMatch(/^cr-/);
  });

  it("touches only this tenant's row, and only while it is still the held slot", async () => {
    const foreign = heldSlot("slot-1", OTHER);
    const started = heldSlot("slot-2", T, "active");
    const finished = heldSlot("slot-3", T, "done");
    for (const id of ["slot-1", "slot-2", "slot-3"]) {
      await realRefineUndoDeps.discardHeldSlot!({ tenant_id: T, conductor_run_id: id });
    }
    expect(foreign).toMatchObject({ kind: "build_app", status: "provisioning" });
    expect(started).toMatchObject({ kind: "build_app", status: "active" });
    expect(finished).toMatchObject({ kind: "build_app", status: "done" });
  });

  it("a failed write throws, so the caller falls back to releasing the slot", async () => {
    const row = heldSlot("slot-1");
    db.failNextUpdate = "connection reset";
    await expect(realRefineUndoDeps.discardHeldSlot!({ tenant_id: T, conductor_run_id: "slot-1" })).rejects.toThrow(/held slot discard failed: connection reset/);
    expect(row).toMatchObject({ kind: "build_app", status: "provisioning" });
  });
});
