import { describe, it, expect, vi } from "vitest";
import { LAB_LANE_LIMIT, LAB_READ_RETRY, labSharedRead, newLabReadCache, withLabReadCache } from "../lab-read-cache";

LAB_READ_RETRY.ms = 0;

const ok = (content: string) => ({ ok: true, is_error: false, content, ms: 5 });

describe("lab read cache: one case's columns share external reads", () => {
  it("is a no-op outside the lab (no store)", async () => {
    const call = vi.fn(async () => ok("x"));
    await labSharedRead("t", "meta_ads", "list_campaigns", {}, call);
    await labSharedRead("t", "meta_ads", "list_campaigns", {}, call);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("makes one call for identical concurrent reads across columns", async () => {
    const cache = newLabReadCache();
    const call = vi.fn(async () => ok("campaigns"));
    const col = () => withLabReadCache(cache, () => labSharedRead("t", "meta_ads", "list_campaigns", { b: 1, a: 2 }, call));
    const colReordered = () => withLabReadCache(cache, () => labSharedRead("t", "meta_ads", "list_campaigns", { a: 2, b: 1 }, call));
    const out = await Promise.all([col(), col(), colReordered()]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r.content)).toEqual(["campaigns", "campaigns", "campaigns"]);
  });

  it("never shares per-run tools (growth, skill, memory)", async () => {
    const cache = newLabReadCache();
    const call = vi.fn(async () => ok("m"));
    for (const server of ["growth", "skill", "memory", "praxis"]) {
      await withLabReadCache(cache, () => labSharedRead("t", server, "x", {}, call));
      await withLabReadCache(cache, () => labSharedRead("t", server, "x", {}, call));
    }
    expect(call).toHaveBeenCalledTimes(8);
  });

  it("retries a failed read once inside the shared call", async () => {
    const cache = newLabReadCache();
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, is_error: true, content: "User request limit reached", ms: 1 })
      .mockResolvedValueOnce(ok("fresh"));
    const r = await withLabReadCache(cache, () => labSharedRead("t", "meta_ads", "list_ad_sets", {}, call));
    expect(call).toHaveBeenCalledTimes(2);
    expect(r.content).toBe("fresh");
  });

  it("does not keep a read that failed twice, so a later ask tries again", async () => {
    const cache = newLabReadCache();
    const limit = { ok: false, is_error: true, content: "User request limit reached", ms: 1 };
    const call = vi.fn().mockResolvedValueOnce(limit).mockResolvedValueOnce(limit).mockResolvedValueOnce(ok("fresh"));
    const first = await withLabReadCache(cache, () => labSharedRead("t", "meta_ads", "list_ad_sets", {}, call));
    expect(first.content).toBe("User request limit reached");
    const later = await withLabReadCache(cache, () => labSharedRead("t", "meta_ads", "list_ad_sets", {}, call));
    expect(later.content).toBe("fresh");
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("keys by tenant and input, so different reads are not merged", async () => {
    const cache = newLabReadCache();
    const call = vi.fn(async () => ok("x"));
    await withLabReadCache(cache, () => labSharedRead("t1", "operator_db", "query", { q: 1 }, call));
    await withLabReadCache(cache, () => labSharedRead("t2", "operator_db", "query", { q: 1 }, call));
    await withLabReadCache(cache, () => labSharedRead("t1", "operator_db", "query", { q: 2 }, call));
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("every column waiting on one read gets the same final answer, whoever asked first", async () => {
    const cache = newLabReadCache();
    let n = 0;
    const call = vi.fn(async () => {
      n++;
      await new Promise((r) => setTimeout(r, 5));
      return n === 1 ? { ok: false, is_error: true, content: "User request limit reached", ms: 1 } : ok("fresh");
    });
    const col = () => withLabReadCache(cache, () => labSharedRead("t", "meta_ads", "list_ad_sets", {}, call));
    const out = await Promise.all([col(), col(), col()]);
    expect(out.map((r) => r.content)).toEqual(["fresh", "fresh", "fresh"]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("different reads of one connector run one at a time, not all at once", async () => {
    const cache = newLabReadCache();
    let active = 0;
    let peak = 0;
    const call = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return ok("x");
    };
    await Promise.all(
      [1, 2, 3, 4].map((i) => withLabReadCache(cache, () => labSharedRead("t", "meta_ads", "list_ad_sets", { campaign: i }, call))),
    );
    expect(peak).toBe(1);
  });

  it("a read that never answers gives up its lane, so later reads of that connector still run", async () => {
    const cache = newLabReadCache();
    const before = LAB_LANE_LIMIT.ms;
    LAB_LANE_LIMIT.ms = 20;
    try {
      const stuck = withLabReadCache(cache, () => labSharedRead("t9", "operator_db", "query", { q: "hangs" }, () => new Promise(() => {})));
      const later = withLabReadCache(cache, () => labSharedRead("t9", "operator_db", "query", { q: "fine" }, async () => ok("rows")));
      expect((await later).content).toBe("rows");
      expect(JSON.parse((await stuck).content).error).toBe("lab_read_timeout");
    } finally {
      LAB_LANE_LIMIT.ms = before;
    }
  });
});
