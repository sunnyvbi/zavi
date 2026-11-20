import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
  inngest: { createFunction: (c: unknown, t: unknown, f: unknown) => ({ c, t, f }) },
}));
vi.mock("@/services/logging/alert", () => ({ alert: vi.fn(async () => undefined) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { MAX_PER_RUN, accountDeletionPurgeFn, failedById, purgeModeFromEnv, runAccountDeletionPurge } from "../account-deletion-purge";
import { StoragePendingError, type PurgeResult } from "@/services/account/purge-account";

const result = (status: PurgeResult["status"]): PurgeResult => ({
  status,
  deletion_id: "x",
  workspaces: 1,
  delete: { "agent_runs.tenant_id": 3, "memory_note.tenant_id": 2 },
  clear: {},
  keep: { "tenant_credit_ledger.tenant_id": 4 },
  storage_objects: 0,
  batched_agent_runs: 2,
  auth_user: { present: true, cascade: {}, clear: {}, blockers: {} },
  storage_removed: 1,
  runs_deleted: 2,
});

function deps(
  over: {
    due?: string[];
    fail?: Record<string, string>;
    storagePending?: string[];
    storageFail?: Record<string, string>;
    storageNotDone?: string[];
    stuck?: string[];
    mismatches?: string[];
  } = {},
) {
  const sb = { tag: "client" };
  const fail = over.fail ?? {};
  return {
    sb,
    now: () => new Date("2026-10-28T10:40:00Z"),
    client: () => sb as never,
    listDue: vi.fn(async (_sb: unknown, _now: Date, _limit?: number) => over.due ?? []),
    listStoragePending: vi.fn(async (_sb: unknown, _limit?: number) => over.storagePending ?? []),
    finishStorage: vi.fn(async (_sb: unknown, id: string) => {
      if (over.storageFail?.[id]) throw new Error(over.storageFail[id]);
      return { removed: 2, done: !over.storageNotDone?.includes(id) };
    }),
    listStuckPending: vi.fn(async (_sb: unknown, _now: Date, _limit?: number) => over.stuck ?? []),
    listMismatches: vi.fn(async (_sb: unknown, _limit?: number) => over.mismatches ?? []),
    purge: vi.fn(async (_sb: unknown, id: string, mode: string) => {
      if (fail[id]) throw new Error(fail[id]);
      return result(mode === "dry_run" ? "dry_run" : "purged");
    }),
    recordFailure: vi.fn(async (_sb: unknown, _id: string, _message: string, _now: Date, _opts?: { purged?: boolean }) => true),
    page: vi.fn(async (_input: unknown) => undefined),
    log: vi.fn(async (_input: unknown) => undefined),
  };
}

const runLogs = (d: ReturnType<typeof deps>) => d.log.mock.calls.slice(1).map((c) => c[0] as { level: string; code: string; message: string });

describe("account-deletion-purge", () => {
  beforeEach(() => {
    process.env.ACCOUNT_PURGE_MODE = "execute";
  });
  afterEach(() => {
    delete process.env.ACCOUNT_PURGE_MODE;
  });

  it("runs daily, one at a time, without Inngest retries", () => {
    const fn = accountDeletionPurgeFn as unknown as { c: { id: string; concurrency: { limit: number }; retries: number }; t: { cron: string } };
    expect(fn.c).toMatchObject({ id: "account-deletion-purge", concurrency: { limit: 1 }, retries: 0 });
    expect(fn.t.cron).toBe("40 10 * * *");
  });

  it("purges every due request in execute mode and pages nobody when all succeed", async () => {
    const d = deps({ due: ["a", "b"] });
    const out = await runAccountDeletionPurge(d);
    expect(out).toEqual({ mode: "execute", due: 2, purged: 2, dry_run: 0, failed: [], files_finished: 0 });
    expect(d.listDue).toHaveBeenCalledWith(d.sb, new Date("2026-10-28T10:40:00Z"), MAX_PER_RUN);
    expect(d.purge.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["a", "execute"],
      ["b", "execute"],
    ]);
    expect(d.page).not.toHaveBeenCalled();
    expect(d.recordFailure).not.toHaveBeenCalled();
    expect(runLogs(d)[0]).toMatchObject({ level: "info", code: "account_purge_done" });
    expect(runLogs(d)[0].message).toContain("rows deleted 5 (2 runs in batches), cleared 0, kept 4");
  });

  it("logs the full plan when run batches went first", async () => {
    const d = deps({ due: ["a"] });
    d.purge.mockResolvedValueOnce({ ...result("purged"), planned_delete: { "agent_runs.tenant_id": 9, "agent_run_events.tenant_id": 40 } });
    await runAccountDeletionPurge(d);
    expect(runLogs(d)[0].message).toContain("rows deleted 49 (2 runs in batches)");
  });

  it("a failed request is recorded and paged; the others still run", async () => {
    const d = deps({ due: ["a", "b", "c"], fail: { b: "account_purge: blocked (creator_threads.tenant_id)" } });
    const out = await runAccountDeletionPurge(d);
    expect(out).toMatchObject({ due: 3, purged: 2, failed: ["b"] });
    expect(d.recordFailure).toHaveBeenCalledTimes(1);
    expect(d.recordFailure.mock.calls[0].slice(1, 3)).toEqual(["b", "account_purge: blocked (creator_threads.tenant_id)"]);
    expect(d.page).toHaveBeenCalledTimes(1);
    const page = d.page.mock.calls[0][0] as { msg: string; code: string; email: { dedupeKey: string } };
    expect(page.code).toBe("account_purge_failed");
    expect(page.msg).toContain("1 account deletion(s) could not be purged, finished or confirmed (execute; 3 due)");
    expect(page.msg).toContain("b");
    expect(page.email.dedupeKey).toBe("account-purge:2026-10-28");
  });

  it("dry run purges nothing, records nothing, and still pages a request that would fail", async () => {
    process.env.ACCOUNT_PURGE_MODE = "dry_run";
    const d = deps({ due: ["a", "b"], fail: { b: "account_purge: sites_cleanup_pending (t)" } });
    const out = await runAccountDeletionPurge(d);
    expect(out).toMatchObject({ mode: "dry_run", dry_run: 1, purged: 0, failed: ["b"] });
    expect(d.purge.mock.calls.every((c) => c[2] === "dry_run")).toBe(true);
    expect(d.recordFailure).not.toHaveBeenCalled();
    expect(d.page).toHaveBeenCalledTimes(1);
  });

  it("off does nothing at all", async () => {
    process.env.ACCOUNT_PURGE_MODE = "off";
    const d = deps({ due: ["a"], storagePending: ["p"] });
    expect(await runAccountDeletionPurge(d)).toEqual({ mode: "off", due: 0, purged: 0, dry_run: 0, failed: [], files_finished: 0 });
    expect(d.listDue).not.toHaveBeenCalled();
    expect(d.listStoragePending).not.toHaveBeenCalled();
    expect(d.purge).not.toHaveBeenCalled();
  });

  it("an unset, empty, misspelt or quoted mode is OFF, and the raw value is logged", async () => {
    for (const raw of [undefined, "", "  ", "exectue", '"execute"', "'execute'", "true", "1", "yes", "execute now"]) {
      if (raw === undefined) delete process.env.ACCOUNT_PURGE_MODE;
      else process.env.ACCOUNT_PURGE_MODE = raw;
      const d = deps({ due: ["a"], storagePending: ["p"] });
      expect((await runAccountDeletionPurge(d)).mode).toBe("off");
      expect(d.listDue).not.toHaveBeenCalled();
      expect(d.purge).not.toHaveBeenCalled();
      expect(d.finishStorage).not.toHaveBeenCalled();
      const line = d.log.mock.calls[0][0] as { level: string; code: string; message: string };
      expect(line.code).toBe("account_purge_mode");
      expect(line.message).toContain(raw === undefined ? "raw=(unset)" : `raw=${JSON.stringify(raw)}`);
      expect(line.message).toMatch(/-> off$/);
      expect(line.level).toBe(raw === undefined || raw.trim() === "" ? "info" : "warn");
    }
  });

  it("executes only on the exact word execute (trimmed, any case)", () => {
    expect(purgeModeFromEnv("execute")).toBe("execute");
    expect(purgeModeFromEnv(" EXECUTE ")).toBe("execute");
    expect(purgeModeFromEnv(" DRY_RUN ")).toBe("dry_run");
    expect(purgeModeFromEnv("dry-run")).toBe("dry_run");
    for (const v of [undefined, "", "off", "false", "true", "1", "exec", "executes", '"execute"', "execute;"]) {
      expect(purgeModeFromEnv(v)).toBe("off");
    }
  });

  it("finishes the files of requests purged on an earlier run, before the due ones; a failure is recorded on the purged row", async () => {
    const d = deps({ due: ["a"], storagePending: ["p1", "p2"], storageFail: { p2: "storage remove failed in bucket b: denied" } });
    const out = await runAccountDeletionPurge(d);
    expect(out).toMatchObject({ mode: "execute", due: 1, purged: 1, files_finished: 1, failed: ["p2"] });
    expect(d.finishStorage.mock.calls.map((c) => c[1])).toEqual(["p1", "p2"]);
    expect(d.recordFailure.mock.calls.map((c) => [c[1], c[4]])).toEqual([["p2", { purged: true }]]);
    expect(d.page).toHaveBeenCalledTimes(1);
  });

  it("counts files done only when confirmed; a swept request comes back tomorrow", async () => {
    const d = deps({ storagePending: ["p1", "p2"], storageNotDone: ["p2"] });
    const out = await runAccountDeletionPurge(d);
    expect(out.files_finished).toBe(1);
    expect(runLogs(d).map((l) => l.code)).toEqual(["account_purge_files_done", "account_purge_files_swept"]);
    expect(d.page).not.toHaveBeenCalled();
  });

  it("pages requests stuck pending (the deletion stopped before confirming the login kill), touching nothing", async () => {
    const d = deps({ stuck: ["s1"] });
    const out = await runAccountDeletionPurge(d);
    expect(out.failed).toEqual(["pending:s1"]);
    expect(d.purge).not.toHaveBeenCalled();
    expect((d.page.mock.calls[0][0] as { msg: string }).msg).toContain("pending:s1");
  });

  it("pages requests stuck pending even when the purge is OFF, and touches nothing else", async () => {
    for (const raw of [undefined, "off", "dry_run"]) {
      if (raw === undefined) delete process.env.ACCOUNT_PURGE_MODE;
      else process.env.ACCOUNT_PURGE_MODE = raw;
      const d = deps({ due: ["a"], stuck: ["s1"] });
      const out = await runAccountDeletionPurge(d);
      expect(out.failed).toContain("pending:s1");
      expect(d.page).toHaveBeenCalledTimes(1);
      expect(d.finishStorage).not.toHaveBeenCalled();
      if (raw !== "dry_run") expect(d.purge).not.toHaveBeenCalled();
    }
  });

  it("pages a request settled as failed whose login was deleted after all, in every mode", async () => {
    delete process.env.ACCOUNT_PURGE_MODE;
    const d = deps({ mismatches: ["killed:k1"] });
    const out = await runAccountDeletionPurge(d);
    expect(out.failed).toEqual(["killed:k1"]);
    expect((d.page.mock.calls[0][0] as { msg: string }).msg).toContain("killed:k1");
  });

  it("lists every kind in the page, so many stuck requests never crowd out a late kill", async () => {
    delete process.env.ACCOUNT_PURGE_MODE;
    const stuck = Array.from({ length: 25 }, (_, i) => `s${i}`);
    const d = deps({ stuck, mismatches: ["killed:k1"] });
    await runAccountDeletionPurge(d);
    const msg = (d.page.mock.calls[0][0] as { msg: string }).msg;
    expect(msg).toContain("Killed after failing (1): killed:k1");
    expect(msg).toContain("Stuck pending (25): pending:s0");
    expect(failedById(["a", "pending:p", "killed:k"])).toBe(
      "Killed after failing (1): killed:k. Stuck pending (1): pending:p. Deletion ids (1): a",
    );
  });

  it("still pages when the mode log or the client fails", async () => {
    const d = deps({ stuck: ["s1"] });
    d.log.mockImplementationOnce(async () => {
      throw new Error("log sink down");
    });
    const out = await runAccountDeletionPurge(d);
    expect(out.failed).toEqual(["(run crashed)"]);
    expect(d.page).toHaveBeenCalledTimes(1);

    const d2 = deps({ due: ["a"] });
    const out2 = await runAccountDeletionPurge({
      ...d2,
      client: () => {
        throw new Error("no service key");
      },
    });
    expect(out2.failed).toEqual(["(run crashed)"]);
    expect(d2.page).toHaveBeenCalledTimes(1);
  });

  it("still pages when something in the run throws unexpectedly", async () => {
    const d = deps({ due: ["a"], fail: { a: "boom" } });
    d.log.mockImplementation(async (input: unknown) => {
      if ((input as { code?: string }).code === "account_purge_failed") throw new Error("log sink down");
    });
    const out = await runAccountDeletionPurge(d);
    expect(out.failed).toEqual(["a", "(run crashed)"]);
    expect(d.page).toHaveBeenCalledTimes(1);
  });

  it("a list that fails is paged and never stops the rest of the run", async () => {
    const d = deps({ due: ["a"], storagePending: ["p"] });
    d.listStoragePending.mockRejectedValueOnce(new Error("relation does not exist"));
    const out = await runAccountDeletionPurge(d);
    expect(out).toMatchObject({ due: 1, purged: 1, failed: ["(storage-pending list)"] });
    expect(d.page).toHaveBeenCalledTimes(1);

    const d2 = deps({ due: ["a"] });
    d2.listDue.mockRejectedValueOnce(new Error("timeout"));
    const out2 = await runAccountDeletionPurge(d2);
    expect(out2).toMatchObject({ due: 0, failed: ["(due list)"] });
    expect(d2.page).toHaveBeenCalledTimes(1);
  });

  it("logs a failure that could not be written to its row", async () => {
    const d = deps({ due: ["a"], fail: { a: "account_purge: cross_tenant_rows (x)" } });
    d.recordFailure.mockResolvedValueOnce(false as never);
    await runAccountDeletionPurge(d);
    expect(runLogs(d).map((l) => l.code)).toContain("account_purge_record_failed");
  });

  it("a dry run never touches files of purged requests", async () => {
    process.env.ACCOUNT_PURGE_MODE = "dry_run";
    const d = deps({ due: ["a"], storagePending: ["p1"] });
    await runAccountDeletionPurge(d);
    expect(d.listStoragePending).not.toHaveBeenCalled();
    expect(d.finishStorage).not.toHaveBeenCalled();
  });

  it("a file failure after the database purge is a failure (not counted as purged), recorded on the purged row, and paged", async () => {
    const d = deps({ due: ["a"] });
    d.purge.mockRejectedValueOnce(new StoragePendingError("storage remove failed in bucket b: denied", result("purged")));
    const out = await runAccountDeletionPurge(d);
    expect(out).toMatchObject({ purged: 0, failed: ["a"] });
    expect(d.recordFailure.mock.calls[0][4]).toEqual({ purged: true });
    expect(d.page).toHaveBeenCalledTimes(1);
  });
});
