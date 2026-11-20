import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ opsRpc: vi.fn(), tenantRpc: vi.fn(), asTenantId: (t: string) => t }));
vi.mock("../runs", () => ({ listRecent: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

import { opsRpc, tenantRpc } from "@/services/tenant-client";
import { listRecent } from "../runs";
import { PAGE_SIZE, listFailedOpen, planRow, type StampResult, previewExecFailureSort, resumeCursor, runExecFailureSort, sortConfirmPhrase, stampVerdict, type FailedOpenRow } from "../exec-failures-sort";
import { getScript } from "../registry";
import type { StoredVerdict } from "@/services/channels/exec-failure";

const REFUSAL = `Google Ads googleAds:mutate failed: 400 {"error":{"status":"INVALID_ARGUMENT","details":[{"errors":[{"errorCode":{"mutateError":"MUTATE_NOT_ALLOWED"}}]}]}}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const page1: FailedOpenRow[] = [
  { id: id(1), tenant_id: "t1", channel_slug: "youtube_ads", exec_class: "google_ads.create_campaign", exec_result: { error: REFUSAL } },
  { id: id(2), tenant_id: "t1", channel_slug: "meta_ads", exec_class: "meta_ads.update_ad_set_budget", exec_result: { error: "socket hang up" } },
  { id: id(3), tenant_id: "t2", channel_slug: "meta_ads", exec_class: "meta_ads.update_ad_set_budget", exec_result: { error: "socket hang up", bucket: "temporary", fix: null, platform_code: null } },
  { id: id(4), tenant_id: "t2", channel_slug: "google_ads", exec_class: "google_ads.create_campaign", exec_result: { error: REFUSAL, bucket: "temporary", fix: null, platform_code: null } },
  { id: id(5), tenant_id: "t2", channel_slug: "meta_ads", exec_class: "meta_ads.set_status", exec_result: { error: "held", held_for_founder: true } },
];
const noLog = vi.fn();
type Stamp = (tenantId: string, actionId: string, verdict: StoredVerdict, force: boolean) => Promise<StampResult>;
const stampFn = (impl: (actionId: string) => StampResult | Promise<StampResult>) => vi.fn<Parameters<Stamp>, ReturnType<Stamp>>(async (_t, actionId) => impl(actionId));

describe("planRow", () => {
  it("unstamped → stamp; stamped and current → skip; stamped and changed → restamp; a founder hold → skip", () => {
    expect(planRow(page1[0]).action).toBe("stamp");
    expect(planRow(page1[2]).action).toBe("skip");
    expect(planRow(page1[3])).toMatchObject({ action: "restamp", verdict: { bucket: "blocked_on_us" } });
    expect(planRow(page1[4])).toEqual({ verdict: null, action: "skip" });
  });
});

describe("runExecFailureSort", () => {
  it("pages by cursor, stamps unstamped rows once, leaves differing rows alone without reclassify, persists progress", async () => {
    const list = vi.fn().mockResolvedValueOnce(page1);
    const stamp = stampFn((rowId) => (rowId === id(1) ? { ok: true, closed: true } : { ok: true, replayed: false }));
    const progress = vi.fn(async () => {});
    const out = await runExecFailureSort({ cursor: null }, { list, stamp, progress, log: noLog });
    expect(list.mock.calls.map((c) => c[0])).toEqual([null]);
    expect(stamp.mock.calls.map((c) => [c[1], c[3]])).toEqual([[id(1), false], [id(2), false]]);
    expect(stamp.mock.calls[0][2]).toMatchObject({ bucket: "blocked_on_us", note: "Google Ads refused this change, so Zavi closed the card. We've been alerted; nothing for you to do." });
    expect(out).toMatchObject({ cursor: id(5), processed: 5, stamped: 2, closed: 1, skipped: 3, differing: 1, failed_count: 0 });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: id(5) }));
  });

  it("with reclassify, re-stamps the differing row with force", async () => {
    const list = vi.fn().mockResolvedValueOnce(page1);
    const stamp = stampFn(() => ({ ok: true, closed: false }));
    await runExecFailureSort({ cursor: null, reclassify: true }, { list, stamp, progress: vi.fn(async () => {}), log: noLog });
    expect(stamp.mock.calls.map((c) => [c[1], c[3]])).toEqual([[id(1), false], [id(2), false], [id(4), true]]);
  });

  it("reads the next page after a full one", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ ...page1[2], id: id(100 + i) }));
    const list = vi.fn().mockResolvedValueOnce(full).mockResolvedValueOnce([]);
    const out = await runExecFailureSort({ cursor: null }, { list, stamp: vi.fn(), progress: vi.fn(async () => {}), log: noLog });
    expect(list.mock.calls.map((c) => c[0])).toEqual([null, id(100 + PAGE_SIZE - 1)]);
    expect(out.processed).toBe(PAGE_SIZE);
  });

  it("resumes from a cursor and records row errors (and refusals) without stopping", async () => {
    const list = vi.fn().mockResolvedValueOnce(page1.slice(1));
    const stamp = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const out = await runExecFailureSort({ cursor: id(1) }, { list, stamp, progress: vi.fn(async () => {}), log: noLog });
    expect(list.mock.calls[0][0]).toBe(id(1));
    expect(out.failed_count).toBe(1);
    expect(out.errors).toEqual([{ id: id(2), code: "boom" }]);
    const refused = await runExecFailureSort({ cursor: null }, { list: vi.fn().mockResolvedValueOnce([page1[0]]), stamp: vi.fn(async () => ({ ok: false, code: "not_failed" })), progress: vi.fn(async () => {}), log: noLog });
    expect(refused.errors).toEqual([{ id: id(1), code: "not_failed" }]);
  });

  it("stops after 20 failures in a row, keeping its progress for a resume", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ ...page1[1], id: id(200 + i) }));
    const progress = vi.fn(async () => {});
    await expect(
      runExecFailureSort({ cursor: null }, { list: vi.fn().mockResolvedValueOnce(rows), stamp: vi.fn(async () => { throw new Error("db"); }), progress, log: noLog }),
    ).rejects.toThrow(/20 failed rows in a row/);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: id(219), failed_count: 20 }));
  });

  it("a list error throws", async () => {
    await expect(runExecFailureSort({ cursor: null }, { list: vi.fn().mockRejectedValue(new Error("rpc down")), stamp: vi.fn(), progress: vi.fn(), log: noLog })).rejects.toThrow("rpc down");
  });
});

describe("previewExecFailureSort (dry run)", () => {
  it("counts the completion gate, the differing rows, and fingerprints what an apply would touch", async () => {
    const a = await previewExecFailureSort({ reclassify: false }, vi.fn().mockResolvedValueOnce(page1));
    expect(a).toMatchObject({ remaining: 2, differing: 1, by_bucket: { blocked_on_us: 1, temporary: 1 } });
    expect(a.sample.map((s) => s.id)).toEqual([id(1), id(2)]);
    expect(sortConfirmPhrase(a, false)).toBe("SORT 2");
    const b = await previewExecFailureSort({ reclassify: true }, vi.fn().mockResolvedValueOnce(page1));
    expect(sortConfirmPhrase(b, true)).toBe("SORT 3");
    expect(b.preview_token).not.toBe(a.preview_token);
    const again = await previewExecFailureSort({ reclassify: false }, vi.fn().mockResolvedValueOnce(page1));
    expect(again.preview_token).toBe(a.preview_token);
  });
});

describe("doors", () => {
  it("stamps through the tenant facade without the note", async () => {
    (tenantRpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { ok: true, closed: true }, error: null });
    const out = await stampVerdict("t1", id(1), { bucket: "blocked_on_us", fix: null, platform_code: "X", note: "n" }, true);
    expect(out).toEqual({ ok: true, closed: true });
    expect((tenantRpc as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["t1", "stamp_channel_action_exec_verdict", { p_action_id: id(1), p_verdict: { bucket: "blocked_on_us", fix: null, platform_code: "X" }, p_force: true }]);
  });

  it("resumes only from a latest run that failed", async () => {
    const recent = listRecent as unknown as ReturnType<typeof vi.fn>;
    recent.mockResolvedValueOnce([{ status: "failed", progress: { cursor: id(7) } }]);
    expect(await resumeCursor()).toBe(id(7));
    recent.mockResolvedValueOnce([{ status: "done", progress: { cursor: id(7) } }]);
    expect(await resumeCursor()).toBeNull();
    recent.mockResolvedValueOnce([{ status: "failed", progress: { cursor: "'; drop" } }]);
    expect(await resumeCursor()).toBeNull();
    recent.mockResolvedValueOnce([]);
    expect(await resumeCursor()).toBeNull();
  });

  it("is registered as a long-running, single-lock, confirmed apply", () => {
    const s = getScript("channel-exec-failures-sort");
    expect(s).toMatchObject({ group: "Channel cards", applies: true, longRunning: true, confirmHint: "SORT <count>" });
    expect(s!.lockKey({ reclassify: true, resume: false })).toBe("*");
  });

  it("pages through the ops RPC escape and throws on its error", async () => {
    const rpc = opsRpc as unknown as ReturnType<typeof vi.fn>;
    rpc.mockResolvedValueOnce({ data: page1, error: null });
    expect(await listFailedOpen(id(1), 200)).toEqual(page1);
    expect(rpc.mock.calls[0]).toEqual(["list_failed_open_channel_actions", { p_after: id(1), p_limit: 200 }]);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(listFailedOpen(null, 200)).rejects.toThrow(/boom/);
  });
});
