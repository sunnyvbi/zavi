import { describe, it, expect, vi } from "vitest";
import { definitelyRejected, discoverContact, emailsInHtml, enqueueNotices, pickContact, sendNotices, usableContact, type SendDeps } from "../notices";
import { renderSeedNoticeEmail } from "@/email/templates/start-card";
import { ZAVI_POSTAL_ADDRESS } from "@/email/theme";

describe("contact discovery", () => {
  it("reads mailto and plain addresses, including simple obfuscation, and skips asset names", () => {
    const html = `<a href="mailto:Hello@Acme.io">x</a> write to team [at] acme.io or sales&#64;acme.io <img src="logo@2x.png">`;
    expect(emailsInHtml(html).sort()).toEqual(["hello@acme.io", "sales@acme.io", "team@acme.io"]);
  });
  it("only addresses at the site's own domain that could confirm a removal, never no-reply/jobs/legal/freemail", () => {
    expect(usableContact("hello@acme.io", "acme.io")).toBe(true);
    expect(usableContact("hi@mail.acme.io", "acme.io")).toBe(true);
    for (const e of ["noreply@acme.io", "jobs@acme.io", "privacy@acme.io", "hello@gmail.com", "hello@acme.io.evil.com", "hello@other.io"]) {
      expect(usableContact(e, "acme.io"), e).toBe(false);
    }
  });
  it("only a role address, never a named person's mailbox", () => {
    expect(pickContact(["jane@acme.io", "contact@acme.io", "hello@acme.io"], "acme.io")).toBe("hello@acme.io");
    expect(pickContact(["jane@acme.io"], "acme.io")).toBeNull();
    expect(pickContact(["x@gmail.com"], "acme.io")).toBeNull();
  });
  it("walks the site's pages and stops at the first role address", async () => {
    const pages: Record<string, string> = { "https://acme.io/": "<p>jane@acme.io</p>", "https://acme.io/contact": "<a href='mailto:hello@acme.io'>" };
    const fetchText = vi.fn(async (u: string) => pages[u] ?? null);
    expect(await discoverContact("www.acme.io", fetchText)).toBe("hello@acme.io");
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});

describe("enqueue", () => {
  it("one notice per domain; no contact means no notice (the card stays unlisted)", async () => {
    const insert = vi.fn(async () => "inserted" as const);
    const r = await enqueueNotices(
      "run",
      {
        doneItems: async (_r: string, after: string) =>
          after
            ? []
            : [
                { domain: "a.io", card_id: "c1", source: "yc" as const },
                { domain: "b.io", card_id: "c2", source: "yc" as const },
                { domain: "c.io", card_id: "c3", source: "yc" as const },
              ],
        hasNotice: async (d) => d === "a.io",
        discover: async (d) => (d === "b.io" ? "hello@b.io" : null),
        insertNotice: insert,
        markChecked: vi.fn(async () => undefined),
        log: () => {},
      },
      { limit: 10, pageSize: 3 },
    );
    expect(r).toEqual({ queued: 1, no_contact: 1, existing: 1 });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ domain: "b.io", card_id: "c2", email: "hello@b.io" }));
  });
});

const card = { id: "c1", public_id: "PUB123", domain: "a.io", status: "done", revoked_at: null, score: { total: 50, out_of: 100 }, parts: {} };

function deps(over: Partial<SendDeps> = {}): SendDeps {
  return {
    pending: async (n) => [{ domain: "a.io", source: "yc" as const }].slice(0, n),
    sentToday: async () => 0,
    claim: async () => ({ outcome: "claimed", email: "hello@a.io", idempotency_key: "seed-notice-k", card_id: "c1" }),
    getCard: async () => card,
    send: vi.fn(async () => ({ messageId: "m1" })),
    accepted: vi.fn(async () => "accepted"),
    markFailed: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    webBase: "https://www.zaviagent.com",
    apiBase: "https://api.zaviagent.com",
    log: () => {},
    sleep: async () => {},
    ...over,
  };
}

describe("enqueue paging and the checked mark", () => {
  it("walks every page, and an insert failure leaves the item unchecked for the next run", async () => {
    const pages = [[{ domain: "a.io", card_id: "c1", source: "yc" as const }, { domain: "b.io", card_id: "c2", source: "yc" as const }], [{ domain: "c.io", card_id: "c3", source: "yc" as const }]];
    const marked: string[] = [];
    const run = enqueueNotices(
      "run",
      {
        doneItems: async (_r, after) => (after === "" ? pages[0] : after === "b.io" ? pages[1] : []),
        hasNotice: async () => false,
        discover: async (d) => `hello@${d}`,
        insertNotice: async (row) => {
          if (row.domain === "c.io") throw new Error("db down");
          return "inserted";
        },
        markChecked: async (_r, d) => void marked.push(d),
        log: () => {},
      },
      { limit: 10, pageSize: 2 },
    );
    await expect(run).rejects.toThrow(/db down/);
    expect(marked).toEqual(["a.io", "b.io"]);
  });
});

describe("send", () => {
  it("dry run sends and claims nothing", async () => {
    const d = deps({ claim: vi.fn() as never });
    expect(await sendNotices(d, { limit: 5, perDay: 100, dryRun: true, gapMs: 0 })).toMatchObject({ dry: 1, sent: 0 });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });
  it("sends with the card and remove links, then records the provider id", async () => {
    const d = deps();
    expect(await sendNotices(d, { limit: 5, perDay: 100, dryRun: false, gapMs: 0 })).toMatchObject({ sent: 1 });
    expect(d.send).toHaveBeenCalledWith(expect.objectContaining({ email: "hello@a.io", cardUrl: "https://www.zaviagent.com/r/PUB123", removeUrl: "https://www.zaviagent.com/r/PUB123?remove=1", oneClickUrl: "https://api.zaviagent.com/api/public/seed-notice/unsubscribe?k=seed-notice-k", noticeKey: "seed-notice-k" }));
    expect(d.accepted).toHaveBeenCalledWith("a.io", "m1");
  });
  it("a claim refused (suppressed or removed) sends nothing", async () => {
    const d = deps({ claim: async () => ({ outcome: "cancelled" }) });
    expect(await sendNotices(d, { limit: 5, perDay: 100, dryRun: false, gapMs: 0 })).toMatchObject({ skipped: 1, sent: 0 });
    expect(d.send).not.toHaveBeenCalled();
  });
  it("an unclear send is 'unknown' (never retried); a 4xx is 'bounced'", async () => {
    const net = deps({ send: async () => Promise.reject(new Error("socket hang up")) });
    await sendNotices(net, { limit: 5, perDay: 100, dryRun: false, gapMs: 0 });
    expect(net.markFailed).toHaveBeenCalledWith("a.io", "unknown", "socket hang up");
    const bad = deps({ send: async () => Promise.reject(Object.assign(new Error("Bad Request"), { code: 400 })) });
    await sendNotices(bad, { limit: 5, perDay: 100, dryRun: false, gapMs: 0 });
    expect(bad.markFailed).toHaveBeenCalledWith("a.io", "bounced", "Bad Request");
    expect(definitelyRejected({ response: { statusCode: 503 } })).toBe(false);
  });
  it("a send that went out but could not be recorded still counts as sent and is not retried", async () => {
    const d = deps({ accepted: async () => Promise.reject(new Error("db down")) });
    expect(await sendNotices(d, { limit: 5, perDay: 100, dryRun: false, gapMs: 0 })).toMatchObject({ sent: 1 });
    expect(d.markFailed).not.toHaveBeenCalled();
  });
  it("a 408/429 refusal goes back to pending (nothing was sent), never 'bounced'", async () => {
    const d = deps({ send: async () => Promise.reject(Object.assign(new Error("Too Many Requests"), { code: 429 })) });
    await sendNotices(d, { limit: 5, perDay: 100, dryRun: false, gapMs: 0 });
    expect(d.release).toHaveBeenCalledWith("a.io", "Too Many Requests");
    expect(d.markFailed).not.toHaveBeenCalled();
  });
  it("the database's day cap stops the run at the claim", async () => {
    const d = deps({ claim: async () => ({ outcome: "day_cap" }) });
    expect(await sendNotices(d, { limit: 5, perDay: 100, dryRun: false, gapMs: 0 })).toMatchObject({ sent: 0, stopped: "per_day_cap" });
    expect(d.send).not.toHaveBeenCalled();
  });
  it("stops at the per-day cap", async () => {
    const d = deps({ sentToday: async () => 100 });
    expect(await sendNotices(d, { limit: 5, perDay: 100, dryRun: false, gapMs: 0 })).toMatchObject({ sent: 0, stopped: "per_day_cap" });
  });
});

describe("notice email", () => {
  it("says why they got it, links the card and removal, promises one email, no em dashes", () => {
    const r = renderSeedNoticeEmail({
      domain: "a.io",
      cardUrl: "https://www.zaviagent.com/r/PUB",
      oneClickUrl: "https://api.zaviagent.com/api/public/seed-notice/unsubscribe?k=seed-notice-x",
      source: "yc",
      card: { score: null, diagnosis: null, companyName: "Acme" },
    });
    expect(r.text).toContain("Y Combinator company directory");
    expect(r.text).toContain("Remove my site (one click): https://api.zaviagent.com/api/public/seed-notice/unsubscribe?k=seed-notice-x");
    expect(r.text).toContain("only email we will send");
    expect(r.text).toContain("one-time notice from Zavi");
    expect(r.text).toContain(ZAVI_POSTAL_ADDRESS);
    expect(r.html).toContain("seed-notice/unsubscribe?k=seed-notice-x");
    expect(r.html + r.text + r.subject).not.toMatch(/—/);
  });
});

import { guardedLookup } from "../notice-store";
describe("contact fetch dials only the address it checked", () => {
  const fake = (addrs: Array<{ address: string; family: number }>) => ((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) => cb(null, addrs)) as never;
  it("refuses a name with any private address (rebinding, mixed answers)", async () => {
    const out = await new Promise<string>((r) => guardedLookup("x.io", {}, (e) => r(e ? (e as Error).message : "ok"), fake([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }])));
    expect(out).toBe("ssrf_blocked");
  });
  it("passes a public address through, single or all", async () => {
    const one = await new Promise<unknown>((r) => guardedLookup("x.io", {}, (_e, a) => r(a), fake([{ address: "93.184.216.34", family: 4 }])));
    expect(one).toBe("93.184.216.34");
    const all = await new Promise<unknown>((r) => guardedLookup("x.io", { all: true }, (_e, a) => r(a), fake([{ address: "93.184.216.34", family: 4 }])));
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});
