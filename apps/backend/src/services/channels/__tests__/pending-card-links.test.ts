import { describe, expect, it, vi } from "vitest";

const filters: Array<[string, string, unknown]> = [];
let rows: unknown[] = [];
vi.mock("@/services/tenant-client", () => {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit"]) q[m] = () => q;
  for (const m of ["eq", "not", "is"]) q[m] = (c: string, v: unknown, w?: unknown) => (filters.push([m, c, w ?? v]), q);
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok);
  return { asTenantId: (t: string) => t, tenantClient: () => ({ from: () => q }) };
});

import { channelActionUrl } from "@/services/web-base";
import { allRecipientsAreMembers, loadRunPendingCards, replyWithCardLinks, withPendingCardLinks } from "../pending-card-links";
import { scanOutboundEmail } from "@/services/tools/email/outbound-scan";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const raise = {
  id: "7a8da8b6-b341-4c0c-95f0-9b2a84c9128d",
  channel_slug: "meta_ads",
  title: "Raise budget",
  exec_class: "meta_ads.update_ad_set_budget_review",
  exec_payload: { ad_set_id: "120258729006520059", daily_budget_usd: 178.8, expected_current_daily_budget_usd: 149, name: "Rent a car at $35 per day" },
};

describe("withPendingCardLinks", () => {
  it("appends the card's own deep link, named by its headline", () => {
    const out = withPendingCardLinks("The raise is filed and waiting for your approval.", [raise], T);
    expect(out).toBe(
      "The raise is filed and waiting for your approval.\n\nApprove or reject it here:\n" +
        `- Raise “Rent a car at $35 per day” (ad set 120258729006520059) from $149 to $178.80 a day: ${channelActionUrl("meta_ads", raise.id, T)}`,
    );
    expect(out).toContain(`&action=${raise.id}&company=${T}`);
  });

  it("leaves a reply with no waiting card unchanged, and caps the list", () => {
    expect(withPendingCardLinks("Done.", [], T)).toBe("Done.");
    const many = [0, 1, 2, 3].map((i) => ({ ...raise, id: `card-${i}`, exec_payload: null, title: `Card ${i}` }));
    const out = withPendingCardLinks("x", many, T);
    expect(out).toContain("Approve or reject them here:");
    expect(out).not.toContain("card-3");
    expect(out).toContain("More are waiting on the same channel.");
  });
});

describe("loadRunPendingCards", () => {
  it("reads only this tenant's run, pending and not yet approved executable cards", async () => {
    rows = [raise];
    expect(await loadRunPendingCards(T, "run-b9")).toEqual([raise]);
    expect(filters).toEqual(
      expect.arrayContaining([["eq", "tenant_id", T], ["eq", "run_id", "run-b9"], ["eq", "status", "pending"], ["is", "exec_status", null]]),
    );
  });
});

describe("replyWithCardLinks (security review)", () => {
  const members = new Set(["ravi@upcar.ai", "ops@upcar.ai"]);
  const base = { body: "Filed.", cards: [raise], tenant_id: T, max: 50_000, scan: (t: string) => scanOutboundEmail(t).blocked };

  it("a non-member on the thread (even an allowlisted one) gets no links", () => {
    expect(allRecipientsAreMembers(["ravi@upcar.ai", "host@gmail.com"], members, new Set())).toBe(false);
    expect(allRecipientsAreMembers(["ravi@upcar.ai", "ops@upcar.ai"], members, new Set(["ops@upcar.ai"]))).toBe(false);
    expect(replyWithCardLinks({ ...base, allMembers: false })).toEqual({ body: "Filed.", dropped: "not_all_members" });
    const ok = replyWithCardLinks({ ...base, allMembers: allRecipientsAreMembers(["Ravi@upcar.ai", "ops@upcar.ai"], members, new Set()) });
    expect(ok.dropped).toBeNull();
    expect(ok.body).toContain(`&action=${raise.id}`);
  });

  it("a card title with line breaks is one bounded line", () => {
    const out = withPendingCardLinks("x", [{ ...raise, exec_payload: null, title: "Pause it\r\nBcc: evil@x.com\n" + "y".repeat(300) }], T);
    const line = out.split("\n").find((l) => l.startsWith("- "))!;
    expect(line).toContain("Pause it Bcc: evil@x.com");
    expect(out.split("\n").filter((l) => l.includes("evil"))).toHaveLength(1);
    expect(line.split(": http")[0].length).toBeLessThanOrEqual(2 + 120);
  });

  it("the final body with links goes through the outbound scan; a hit sends the body without them", () => {
    const scan = vi.fn((t: string) => t.includes("&action="));
    expect(replyWithCardLinks({ ...base, allMembers: true, scan })).toEqual({ body: "Filed.", dropped: "outbound_scan" });
    expect(scan).toHaveBeenCalledWith(expect.stringContaining(channelActionUrl("meta_ads", raise.id, T)));
    const secret = replyWithCardLinks({ ...base, allMembers: true, cards: [{ ...raise, exec_payload: null, title: "key sk_live_51HxQ2bcd3EfGh4IjKl5MnOp6QrSt7UvWx" }] });
    expect(secret.dropped).toBe("outbound_scan");
    expect(replyWithCardLinks({ ...base, allMembers: true, max: 20 }).dropped).toBe("too_long");
  });
});
