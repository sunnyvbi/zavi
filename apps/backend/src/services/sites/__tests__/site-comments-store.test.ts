import { describe, expect, it, vi } from "vitest";

type Row = { id: string; site_id: string; created_at: string };

const h = vi.hoisted(() => {
  const rows: Row[] = [];
  const tenantClient = async () => ({
    from: () => {
      let list: Row[] = [];
      const q = {
        select: () => q,
        eq: (col: keyof Row, val: string) => {
          list = rows.filter((r) => r[col] === val);
          return q;
        },
        order: (col: keyof Row, opts: { ascending: boolean }) => {
          list = [...list].sort((a, b) => (opts.ascending ? 1 : -1) * a[col].localeCompare(b[col]));
          return q;
        },
        limit: (n: number) => Promise.resolve({ data: list.slice(0, n), error: null }),
      };
      return q;
    },
  });
  return { rows, tenantClient };
});

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: h.tenantClient }));

import { MAX_THREADS_PER_SITE, realSiteCommentStore } from "../site-comments";

function at(i: number): string {
  return new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
}

describe("site comment threads on a busy site", () => {
  it("lists the newest threads when a site has more than the cap, oldest first", async () => {
    h.rows.length = 0;
    const total = MAX_THREADS_PER_SITE + 5;
    for (let i = 0; i < total; i++) h.rows.push({ id: `t${i}`, site_id: "s1", created_at: at(i) });
    h.rows.push({ id: "other", site_id: "s2", created_at: at(total + 1) });

    const listed = await realSiteCommentStore().listThreads("tenant-a" as never, "s1");

    expect(listed).toHaveLength(MAX_THREADS_PER_SITE);
    expect(listed[listed.length - 1]!.id).toBe(`t${total - 1}`);
    expect(listed[0]!.id).toBe("t5");
    expect(listed.map((r) => r.id)).not.toContain("other");
    const times = listed.map((r) => r.created_at);
    expect([...times].sort()).toEqual(times);
  });
});
