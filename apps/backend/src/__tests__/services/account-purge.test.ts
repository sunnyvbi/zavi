
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AccountPurgeError,
  RUN_BATCH,
  STORAGE_REMOVE_CHUNK,
  StoragePendingError,
  finishPurgedStorage,
  listDueAccountDeletions,
  listStoragePendingDeletions,
  listDeletionMismatches,
  listStuckPendingDeletions,
  purgeAccountDeletion,
  recordPurgeFailure,
} from "@/services/account/purge-account";

const SUMMARY = {
  status: "purged",
  deletion_id: "d1",
  workspaces: 1,
  delete: { "agent_runs.tenant_id": 2 },
  clear: {},
  keep: { "tenant_credit_ledger.tenant_id": 4 },
  cross_tenant_links: {},
  storage_objects: 0,
  batched_agent_runs: 0,
  auth_user: { present: true, cascade: {}, clear: {}, blockers: {} },
};

type Call = { op: string; args: unknown[] };

function fakeClient(opts: {
  storagePages?: Array<Array<{ bucket_id: string; name: string }>>;
  runBatches?: number[];
  runError?: string;
  storageListError?: string;
  removeError?: string;
  purgeError?: string;
  planError?: string;
  purgeData?: unknown;
  doneError?: string;
  doneAt?: string | null;
}) {
  const calls: Call[] = [];
  const pages = [...(opts.storagePages ?? [])];
  const batches = [...(opts.runBatches ?? [])];
  const sb = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ op: `rpc:${name}`, args: [args] });
      if (name === "account_purge_storage_objects") {
        if (opts.storageListError) return { data: null, error: { message: opts.storageListError } };
        return { data: pages.shift() ?? [], error: null };
      }
      if (name === "account_purge_storage_done") {
        if (opts.doneError) return { data: null, error: { message: opts.doneError } };
        return { data: opts.doneAt === undefined ? "2026-10-28T10:40:09Z" : opts.doneAt, error: null };
      }
      if (name === "account_purge_delete_runs") {
        if (opts.runError) return { data: null, error: { message: opts.runError } };
        return { data: batches.shift() ?? 0, error: null };
      }
      if (name === "purge_account_deletion") {
        if (!args.p_execute && opts.planError) return { data: null, error: { message: opts.planError } };
        if (args.p_execute && opts.purgeError) return { data: null, error: { message: opts.purgeError } };
        return { data: opts.purgeData ?? { ...SUMMARY, status: args.p_execute ? "purged" : "dry_run" }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    }),
    storage: {
      from: (bucket: string) => ({
        remove: vi.fn(async (paths: string[]) => {
          calls.push({ op: `remove:${bucket}`, args: [paths] });
          return opts.removeError ? { data: null, error: { message: opts.removeError } } : { data: [], error: null };
        }),
      }),
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

describe("purgeAccountDeletion", () => {
  it("dry run asks for counts only and never touches storage", async () => {
    const { sb, calls } = fakeClient({ storagePages: [[{ bucket_id: "b", name: "t/x" }]] });
    const out = await purgeAccountDeletion(sb, "d1", "dry_run");
    expect(out.status).toBe("dry_run");
    expect(out.storage_removed).toBe(0);
    expect(calls).toEqual([{ op: "rpc:purge_account_deletion", args: [{ p_deletion_id: "d1", p_execute: false }] }]);
  });

  it("execute runs the batches, then the database purge, and only then removes files, bucket by bucket in chunks", async () => {
    const big = Array.from({ length: STORAGE_REMOVE_CHUNK + 20 }, (_, i) => ({ bucket_id: "agent-chat-images", name: `t1/${i}.jpg` }));
    const { sb, calls } = fakeClient({
      storagePages: [[...big, { bucket_id: "tenant-documents", name: "t1/doc.pdf" }], []],
      runBatches: [RUN_BATCH, 7, 0],
    });
    const out = await purgeAccountDeletion(sb, "d1", "execute");
    expect(out.status).toBe("purged");
    expect(out.storage_pending).toBe(false);
    expect(out.storage_removed).toBe(STORAGE_REMOVE_CHUNK + 21);
    expect(out.runs_deleted).toBe(RUN_BATCH + 7);
    const ops = calls.map((c) => c.op);
    expect(ops).toEqual([
      "rpc:purge_account_deletion",
      "rpc:account_purge_delete_runs",
      "rpc:account_purge_delete_runs",
      "rpc:account_purge_delete_runs",
      "rpc:purge_account_deletion",
      "rpc:account_purge_storage_objects",
      "remove:agent-chat-images",
      "remove:agent-chat-images",
      "remove:tenant-documents",
      "rpc:account_purge_storage_objects",
      "rpc:account_purge_storage_done",
    ]);
    expect(calls[0].args[0]).toEqual({ p_deletion_id: "d1", p_execute: false });
    expect(calls[1].args[0]).toEqual({ p_deletion_id: "d1", p_limit: RUN_BATCH });
    expect(calls[4].args[0]).toEqual({ p_deletion_id: "d1", p_execute: true });
    expect((calls[6].args[0] as string[]).length).toBe(STORAGE_REMOVE_CHUNK);
  });

  it("never removes a file when the database purge refused (nothing is listed or removed)", async () => {
    const { sb, calls } = fakeClient({
      purgeError: "account_purge: cross_tenant_rows (...)",
      storagePages: [[{ bucket_id: "b", name: "t1/x" }]],
    });
    (sb as unknown as { from: unknown }).from = () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { purged_at: null, purge_summary: null } }) }) }),
    });
    await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/cross_tenant_rows/);
    expect(calls.some((c) => c.op === "rpc:account_purge_storage_objects" || c.op.startsWith("remove:"))).toBe(false);
  });

  it("refuses before touching runs or files when the plan reaches rows of another workspace", async () => {
    const plan = { ...SUMMARY, status: "dry_run", cross_tenant_links: { "agent_run_events.agent_run_id <- agent_runs": 1 } };
    const { sb, calls } = fakeClient({ purgeData: plan, storagePages: [[{ bucket_id: "b", name: "t1/x" }]] });
    await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/cross_tenant_rows/);
    expect(calls.map((c) => c.op)).toEqual(["rpc:purge_account_deletion"]);
  });

  it("a failed run batch stops before the database purge", async () => {
    const { sb, calls } = fakeClient({ runError: "account_purge: kept_rows_changed (before {}, after {})" });
    await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/kept_rows_changed/);
    expect(calls.filter((c) => c.op === "rpc:purge_account_deletion").map((c) => c.args[0])).toEqual([
      { p_deletion_id: "d1", p_execute: false },
    ]);
  });

  it("refuses before touching files or runs when the person has rows in another workspace", async () => {
    const blocked = { ...SUMMARY, status: "dry_run", auth_user: { ...SUMMARY.auth_user, blockers: { "agent_threads.user_id (other workspaces)": 2 } } };
    const { sb, calls } = fakeClient({ purgeData: blocked, storagePages: [[{ bucket_id: "b", name: "t1/x" }]] });
    await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/user_rows_outside/);
    expect(calls.map((c) => c.op)).toEqual(["rpc:purge_account_deletion"]);
  });

  it("a storage failure after the database purge says the request is purged with files pending", async () => {
    const { sb, calls } = fakeClient({ storagePages: [[{ bucket_id: "b", name: "t1/x" }]], removeError: "denied" });
    const err = await purgeAccountDeletion(sb, "d1", "execute").catch((e) => e);
    expect(err).toBeInstanceOf(StoragePendingError);
    expect(err).toBeInstanceOf(AccountPurgeError);
    expect(err.message).toMatch(/purged, files pending: .*denied/);
    expect(err.result.status).toBe("purged");
    expect(calls.filter((c) => c.op === "rpc:purge_account_deletion").map((c) => c.args[0])).toEqual([
      { p_deletion_id: "d1", p_execute: false },
      { p_deletion_id: "d1", p_execute: true },
    ]);
    expect(calls.some((c) => c.op === "rpc:account_purge_storage_done")).toBe(false);
  });

  it("finishPurgedStorage removes what is listed and confirms done; a refusal to confirm is an error", async () => {
    const { sb, calls } = fakeClient({ storagePages: [[{ bucket_id: "b", name: "t1/x" }], []] });
    expect(await finishPurgedStorage(sb, "d1")).toEqual({ removed: 1, done: true });
    expect(calls.map((c) => c.op)).toEqual([
      "rpc:account_purge_storage_objects",
      "remove:b",
      "rpc:account_purge_storage_objects",
      "rpc:account_purge_storage_done",
    ]);
    const { sb: sb2 } = fakeClient({ storagePages: [[]], doneError: "account_purge: storage_not_empty (1 objects left)" });
    await expect(finishPurgedStorage(sb2, "d1")).rejects.toThrow(/storage_not_empty/);
    const { sb: sb3 } = fakeClient({ storagePages: [[]], doneAt: null });
    expect(await finishPurgedStorage(sb3, "d1")).toEqual({ removed: 0, done: false });
    const { sb: sb4 } = fakeClient({ storagePages: [[]], doneAt: null });
    expect((await purgeAccountDeletion(sb4, "d1", "execute")).storage_pending).toBe(true);
  });

  it("a purge that committed but lost its response is reported as purged, not failed", async () => {
    const { sb } = fakeClient({ purgeError: "fetch failed" });
    (sb as unknown as { from: unknown }).from = () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { purged_at: "2026-10-28T10:40:05Z", purge_summary: { ...SUMMARY } } }),
        }),
      }),
    });
    const out = await purgeAccountDeletion(sb, "d1", "execute");
    expect(out.status).toBe("purged");
    expect(out.purged_at).toBe("2026-10-28T10:40:05Z");
  });

  it("a failed purge whose row is still unpurged stays a failure", async () => {
    const { sb } = fakeClient({ purgeError: "fetch failed" });
    (sb as unknown as { from: unknown }).from = () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { purged_at: null, purge_summary: null } }) }) }),
    });
    await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/fetch failed/);
  });

  it("a lost purge response whose row cannot be read back is reported as outcome unknown", async () => {
    const { sb } = fakeClient({ purgeError: "fetch failed" });
    (sb as unknown as { from: unknown }).from = () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "db down" } }) }) }),
    });
    await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/outcome unknown/);
  });

  it("refuses a run-batch, storage or plan reply it cannot read instead of treating it as done", async () => {
    const plan = { ...SUMMARY, status: "dry_run" };
    const { sb, calls } = fakeClient({});
    const reply = (storage: unknown, runs: unknown, p: unknown = plan) =>
      ((sb as unknown as { rpc: (n: string) => Promise<unknown> }).rpc = async (n: string) => {
        calls.push({ op: `rpc:${n}`, args: [] });
        if (n === "purge_account_deletion") return { data: p, error: null };
        return { data: n === "account_purge_storage_objects" ? storage : runs, error: null };
      });
    for (const bad of ["abc", null, "", " ", false, []]) {
      reply([], bad);
      await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/no count/);
    }
    reply(null, 0);
    await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/no list/);
    const noCross = { ...plan } as Record<string, unknown>;
    delete noCross.cross_tenant_links;
    for (const badPlan of [null, {}, { auth_user: {} }, { auth_user: { blockers: [] } }, noCross, { ...plan, cross_tenant_links: [] }]) {
      calls.length = 0;
      reply([], 0, badPlan);
      await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/plan unreadable/);
      expect(calls.map((c) => c.op)).toEqual(["rpc:purge_account_deletion"]);
    }
  });

  it("a refused request (not due, not safe) surfaces the database's reason", async () => {
    const { sb, calls } = fakeClient({ planError: "account_purge: not_due (due 2026-11-25)" });
    await expect(purgeAccountDeletion(sb, "d1", "execute")).rejects.toThrow(/not_due/);
    expect(calls.map((c) => c.op)).toEqual(["rpc:purge_account_deletion"]);
    const { sb: sb2 } = fakeClient({ planError: "account_purge: kept_rows_changed (before {}, after {})" });
    await expect(purgeAccountDeletion(sb2, "d1", "dry_run")).rejects.toThrow(/kept_rows_changed/);
  });
});

describe("listDueAccountDeletions", () => {
  it("asks only for unpurged soft_deleted requests whose 30 days are up, oldest first", async () => {
    const filters: unknown[][] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "is", "eq", "lte", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        filters.push([m, ...args]);
        return m === "limit" ? Promise.resolve({ data: [{ id: "a" }, { id: "b" }], error: null }) : builder;
      };
    }
    const sb = { from: (t: string) => (filters.push(["from", t]), builder) } as unknown as SupabaseClient;
    const now = new Date("2026-10-27T23:00:00Z");
    expect(await listDueAccountDeletions(sb, now, 10)).toEqual(["a", "b"]);
    expect(filters).toEqual([
      ["from", "account_deletions"],
      ["select", "id"],
      ["is", "purged_at", null],
      ["eq", "status", "soft_deleted"],
      ["lte", "purge_after", now.toISOString()],
      ["order", "purge_after", { ascending: true }],
      ["limit", 10],
    ]);
  });
});

describe("listStoragePendingDeletions", () => {
  it("asks only for purged requests whose files are not confirmed gone, oldest first", async () => {
    const filters: unknown[][] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "is", "eq", "not", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        filters.push([m, ...args]);
        return m === "limit" ? Promise.resolve({ data: [{ id: "p" }], error: null }) : builder;
      };
    }
    const sb = { from: (t: string) => (filters.push(["from", t]), builder) } as unknown as SupabaseClient;
    expect(await listStoragePendingDeletions(sb, 5)).toEqual(["p"]);
    expect(filters).toEqual([
      ["from", "account_deletions"],
      ["select", "id"],
      ["eq", "status", "purged"],
      ["not", "purged_at", "is", null],
      ["is", "storage_purged_at", null],
      ["order", "purged_at", { ascending: true }],
      ["limit", 5],
    ]);
  });
});

describe("listStuckPendingDeletions", () => {
  it("asks for requests still pending an hour after they were written", async () => {
    const filters: unknown[][] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lte", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        filters.push([m, ...args]);
        return m === "limit" ? Promise.resolve({ data: [{ id: "s" }], error: null }) : builder;
      };
    }
    const sb = { from: (t: string) => (filters.push(["from", t]), builder) } as unknown as SupabaseClient;
    const now = new Date("2026-10-28T10:40:00Z");
    expect(await listStuckPendingDeletions(sb, now, 7)).toEqual(["s"]);
    expect(filters).toEqual([
      ["from", "account_deletions"],
      ["select", "id"],
      ["eq", "status", "pending"],
      ["lte", "requested_at", "2026-10-28T09:40:00.000Z"],
      ["order", "requested_at", { ascending: true }],
      ["limit", 7],
    ]);
  });
});

describe("listDeletionMismatches", () => {
  it("names each mismatch killed:<id> and refuses an unreadable answer", async () => {
    const calls: unknown[] = [];
    const sb = { rpc: async (n: string, a: unknown) => (calls.push([n, a]), { data: [{ id: "k1", kind: "killed_after_fail" }], error: null }) } as unknown as SupabaseClient;
    expect(await listDeletionMismatches(sb, 9)).toEqual(["killed:k1"]);
    expect(calls).toEqual([["account_deletion_mismatches", { p_limit: 9 }]]);
    const bad = { rpc: async () => ({ data: null, error: null }) } as unknown as SupabaseClient;
    await expect(listDeletionMismatches(bad)).rejects.toThrow(/no list/);
  });
});

describe("recordPurgeFailure", () => {
  it("bumps the attempt count on an unpurged request and never throws", async () => {
    const updates: unknown[] = [];
    const guards: unknown[] = [];
    const sb = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { purge_attempts: 2 } }) }) }),
        update: (row: unknown) => {
          updates.push(row);
          return { eq: () => ({ is: async (col: string, v: unknown) => (guards.push([col, v]), { error: null }) }) };
        },
      }),
    } as unknown as SupabaseClient;
    await recordPurgeFailure(sb, "d1", "x".repeat(900), new Date("2026-10-27T00:00:00Z"));
    expect(updates).toEqual([
      { purge_last_error: "x".repeat(500), purge_attempts: 3, purge_last_attempt_at: "2026-10-27T00:00:00.000Z" },
    ]);
    await recordPurgeFailure(sb, "d1", "files", new Date("2026-10-27T00:00:00Z"), { purged: true });
    expect(guards).toEqual([
      ["purged_at", null],
      ["storage_purged_at", null],
    ]);
    const broken = { from: () => { throw new Error("db down"); } } as unknown as SupabaseClient;
    await expect(recordPurgeFailure(broken, "d1", "m", new Date())).resolves.toBe(false);
    const refused = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { purge_attempts: 0 } }) }) }),
        update: () => ({ eq: () => ({ is: async () => ({ error: { message: "permission denied" } }) }) }),
      }),
    } as unknown as SupabaseClient;
    await expect(recordPurgeFailure(refused, "d1", "m", new Date())).resolves.toBe(false);
    await expect(recordPurgeFailure(sb, "d1", "m", new Date())).resolves.toBe(true);
  });
});
