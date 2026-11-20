import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  row: { tenant_id: "t", id: "a", channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_status: "dispatching", exec_claim_id: "claim", exec_progress: null as unknown },
  unavailable: false,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: () => ({
  update: (values: Record<string, unknown>) => {
    const filters: Array<[string, unknown]> = [];
    const q = {
      eq: (k: string, v: unknown) => { filters.push([k, k === "exec_progress" && typeof v === "string" ? JSON.parse(v) : v]); return q; },
      is: (k: string, v: unknown) => { filters.push([k, v]); return q; },
      select: async () => {
        const matches = filters.every(([k, v]) => JSON.stringify(m.row[k as keyof typeof m.row]) === JSON.stringify(v));
        if (m.unavailable) return { data: null, error: { message: "offline" } };
        if (!matches) return { data: [], error: null };
        Object.assign(m.row, structuredClone(values));
        return { data: [{ id: "a" }], error: null };
      },
    };
    return q;
  },
}) }) }));
import { creationJournal } from "../creation-progress";
beforeEach(() => {
  m.row.tenant_id = "t"; m.row.exec_claim_id = "claim"; m.row.exec_status = "dispatching";
  m.row.exec_progress = null; m.unavailable = false;
});
it("persists the in-flight marker and confirmed ID across claims", async () => {
  const journal = creationJournal("t", "a", "claim", { approved: "payload" }, null);
  await journal.save({ ...journal.state, in_flight: "group_id" });
  expect(journal.retryable).toBe(false);
  await journal.save({ ...journal.state, group_id: "600", in_flight: null });
  m.row.exec_claim_id = "claim-2";
  const resumed = creationJournal("t", "a", "claim-2", { approved: "payload" }, m.row.exec_progress);
  expect(resumed.state.group_id).toBe("600");
  expect(resumed.retryable).toBe(true);
});
it.each(["tenant", "claim", "settled", "concurrent"])("refuses a checkpoint after %s drift", async (drift) => {
  const journal = creationJournal("t", "a", "claim", {}, null);
  if (drift === "tenant") m.row.tenant_id = "other";
  if (drift === "claim") m.row.exec_claim_id = "new-claim";
  if (drift === "settled") m.row.exec_status = "executed";
  if (drift === "concurrent") m.row.exec_progress = { other: "worker" };
  await expect(journal.save({ ...journal.state, in_flight: "group_id" })).rejects.toMatchObject({ code: "exec_partial" });
  expect(journal.retryable).toBe(false);
});
it("does not treat a lost checkpoint response as safe to retry", async () => {
  const journal = creationJournal("t", "a", "claim", {}, null);
  m.unavailable = true;
  await expect(journal.save(journal.state)).rejects.toMatchObject({ code: "exec_partial" });
  expect(journal.retryable).toBe(false);
});
it("refuses changed approvals and unrecognized legacy progress", async () => {
  const journal = creationJournal("t", "a", "claim", { account: "first" }, null);
  await journal.save(journal.state);
  expect(() => creationJournal("t", "a", "claim", { account: "other" }, m.row.exec_progress)).toThrow("does not match");
  expect(() => creationJournal("t", "a", "claim", {}, { campaign_id: "700" })).toThrow("could not be read");
});
it("keeps the archived mark on a refused post's setup, and only on a setup that has a campaign", async () => {
  const journal = creationJournal("t", "a", "claim", { approved: "payload" }, null);
  await journal.save({ ...journal.state, group_id: "600", campaign_id: "700", group_paused: true, archived: true });
  const resumed = creationJournal("t", "a", "claim", { approved: "payload" }, m.row.exec_progress);
  expect(resumed.state).toMatchObject({ campaign_id: "700", archived: true });
  await expect(resumed.save({ ...resumed.state, campaign_id: null, group_id: "600" })).rejects.toThrow();
});
