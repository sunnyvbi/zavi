import { describe, expect, it } from "vitest";
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import { EMAIL_PROVIDERS, urlParam, type ProviderCall } from "../providers";
import { sendgridHttpCall } from "../providers-sendgrid";
import { fakeKlaviyo } from "./fake-tools";

const ok = (data: unknown): ComposioExecResult => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });

describe("list pages", () => {
  it("Mailchimp: offset paging until total_items", async () => {
    const seen: unknown[] = [];
    const call: ProviderCall = async (_s, args) => {
      seen.push(args.offset);
      const offset = Number(args.offset);
      const n = Math.min(200, 250 - offset);
      return ok({ data: { total_items: 250, lists: Array.from({ length: n }, (_, i) => ({ id: `L${offset + i}`, name: "x", stats: { member_count: 1 } })) } });
    };
    const p1 = await EMAIL_PROVIDERS.mailchimp.listAudiencesPage(call, null);
    expect(p1.next).toBe("200");
    const p2 = await EMAIL_PROVIDERS.mailchimp.listAudiencesPage(call, p1.next);
    expect([p2.lists.length, p2.next]).toEqual([50, null]);
    expect(seen).toEqual([0, 200]);
  });

  it("Klaviyo: the cursor from links.next", async () => {
    const args: unknown[] = [];
    const call: ProviderCall = async (_s, a) => {
      args.push(a);
      return a.page_cursor
        ? ok({ data: { data: [{ id: "K3", attributes: { name: "c" } }], links: { next: null } } })
        : ok({ data: { data: [{ id: "K1", attributes: { name: "a" } }], links: { next: "https://a.klaviyo.com/api/lists/?page%5Bcursor%5D=abc123" } } });
    };
    const p1 = await EMAIL_PROVIDERS.klaviyo.listAudiencesPage(call, null);
    expect(p1.next).toBe("abc123");
    const p2 = await EMAIL_PROVIDERS.klaviyo.listAudiencesPage(call, p1.next);
    expect(p2).toMatchObject({ next: null, lists: [{ id: "K3" }] });
    expect(args[1]).toMatchObject({ page_cursor: "abc123" });
  });

  it("Klaviyo: a list page and the full list read only the lists, never one call per list", async () => {
    const tool = fakeKlaviyo([
      { id: "L1", name: "Customers", members: 412 },
      { id: "L2", name: "VIP", members: 0 },
      { id: "L3", name: "Leads", members: 9031 },
    ]);
    const call: ProviderCall = (slug, args) => tool.exec({ tool_slug: slug, user_id: "u", connected_account_id: "ca", arguments: args });
    const page = await EMAIL_PROVIDERS.klaviyo.listAudiencesPage(call, null);
    const all = await EMAIL_PROVIDERS.klaviyo.listAudiences(call);
    expect(page.lists.map((l) => l.id)).toEqual(["L1", "L2", "L3"]);
    expect(all.map((l) => l.id)).toEqual(["L1", "L2", "L3"]);
    expect(tool.calls.map((c) => c.tool_slug)).toEqual(["KLAVIYO_GET_LISTS", "KLAVIYO_GET_LISTS"]);
  });

  const lists = (ids: string[]) => ids.map((id) => ({ id, name: id, member_count: null }));
  const roomy = () => ({ maxCalls: 10, deadline: Date.now() + 60_000, now: Date.now });
  const sizeOk = (id: unknown, n = 3) => ok({ data: { type: "list", id, attributes: { profile_count: n } } });

  it("Klaviyo sizing: a list whose size read fails stays size-unknown and the rest still come back", async () => {
    const sizeArgs: Record<string, unknown>[] = [];
    const call: ProviderCall = async (_slug, a) => {
      sizeArgs.push(a);
      if (a.id === "B") return { ok: false, status: 500, data: null, error: "boom", outcome_unknown: false };
      if (a.id === "C") throw new Error("transport");
      return sizeOk(a.id, 7);
    };
    const sized = await EMAIL_PROVIDERS.klaviyo.sizeAudiences!(call, lists(["A", "B", "C", "D"]), roomy());
    expect(sized.map((l) => l.member_count)).toEqual([7, null, null, 7]);
    expect(sizeArgs).toEqual(["A", "B", "C", "D"].map((id) => ({ id, additional__fields__list: ["profile_count"] })));
  });

  it.each([
    ["a 429", { ok: false, status: 429, data: null, error: null, outcome_unknown: false }],
    ["a Composio-wrapped rate limit", { ok: false, status: 200, data: null, error: "Rate limit exceeded for this account", outcome_unknown: false }],
    ["a Composio-wrapped Klaviyo throttle body", { ok: false, status: 200, data: null, error: { errors: [{ status: 429, code: "throttled", title: "Request was throttled." }] }, outcome_unknown: false }],
    ["a wrapped too-many-requests error", { ok: false, status: 400, data: null, error: "Too Many Requests", outcome_unknown: false }],
  ] as Array<[string, ComposioExecResult]>)("Klaviyo sizing stops at %s and leaves the rest unknown", async (_name, limited) => {
    const sized: string[] = [];
    const call: ProviderCall = async (_slug, a) => {
      sized.push(String(a.id));
      return a.id === "K1" ? limited : sizeOk(a.id);
    };
    const out = await EMAIL_PROVIDERS.klaviyo.sizeAudiences!(call, lists(["K0", "K1", "K2", "K3"]), roomy());
    expect(sized).toEqual(["K0", "K1"]);
    expect(out.map((l) => l.member_count)).toEqual([3, null, null, null]);
  });

  it("Klaviyo sizing: a thrown rate-limit error stops it too", async () => {
    const sized: string[] = [];
    const call: ProviderCall = async (_slug, a) => {
      sized.push(String(a.id));
      if (a.id === "K0") throw new Error("composio execute HTTP 429");
      return sizeOk(a.id);
    };
    await EMAIL_PROVIDERS.klaviyo.sizeAudiences!(call, lists(["K0", "K1"]), roomy());
    expect(sized).toEqual(["K0"]);
  });

  it("Klaviyo sizing: the call cap bounds the calls and lists already sized are skipped", async () => {
    const sized: string[] = [];
    const call: ProviderCall = async (_slug, a) => (sized.push(String(a.id)), sizeOk(a.id));
    const input = [{ id: "S", name: "S", member_count: 5 }, ...lists(Array.from({ length: 14 }, (_, i) => `K${i}`))];
    const out = await EMAIL_PROVIDERS.klaviyo.sizeAudiences!(call, input, { ...roomy(), maxCalls: 4 });
    expect(sized).toEqual(["K0", "K1", "K2", "K3"]);
    expect(out).toHaveLength(15);
    expect(out[0].member_count).toBe(5);
  });

  it("Klaviyo sizing: no call starts past the deadline", async () => {
    let t = 0;
    const starts: number[] = [];
    const call: ProviderCall = async (_slug, a) => {
      starts.push(t);
      t += 1_000;
      return sizeOk(a.id);
    };
    const out = await EMAIL_PROVIDERS.klaviyo.sizeAudiences!(call, lists(Array.from({ length: 10 }, (_, i) => `K${i}`)), { maxCalls: 10, deadline: 3_000, now: () => t });
    expect(starts).toEqual([0, 1_000, 2_000]);
    expect(out.filter((l) => l.member_count !== null)).toHaveLength(3);
  });

  it("Klaviyo sizing: a size call that never answers is cut off at the deadline", async () => {
    const calls: string[] = [];
    const call: ProviderCall = (_slug, a) => (calls.push(String(a.id)), new Promise(() => undefined));
    const at = Date.now();
    const out = await EMAIL_PROVIDERS.klaviyo.sizeAudiences!(call, lists(["K0", "K1", "K2"]), { maxCalls: 10, deadline: at + 40, now: Date.now });
    expect(Date.now() - at).toBeLessThan(1_000);
    expect(calls).toEqual(["K0"]);
    expect(out.map((l) => l.member_count)).toEqual([null, null, null]);
  });

  it("SendGrid: page_token from _metadata.next", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const body = url.includes("page_token=t2")
        ? { result: [{ id: "s2", name: "b", contact_count: 3 }], _metadata: {} }
        : { result: [{ id: "s1", name: "a", contact_count: 2 }], _metadata: { next: "https://api.sendgrid.com/v3/marketing/lists?page_size=1000&page_token=t2" } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const call = sendgridHttpCall("SG.k", fetchImpl);
    const p1 = await EMAIL_PROVIDERS.sendgrid.listAudiencesPage(call, null);
    expect(p1.next).toBe("t2");
    const p2 = await EMAIL_PROVIDERS.sendgrid.listAudiencesPage(call, "t2");
    expect(p2).toEqual({ lists: [{ id: "s2", name: "b", member_count: 3 }], next: null });
  });

  it("no next link is the last page; a next link Zavi cannot follow is an error, never the last page", async () => {
    expect(urlParam(null, "x")).toBeNull();
    expect(() => urlParam("not a url", "x")).toThrow();
    expect(() => urlParam(`https://a.test/?x=${"y".repeat(600)}`, "x")).toThrow();
    expect(() => urlParam("https://a.test/?other=1", "x")).toThrow();
    const klaviyoBad: ProviderCall = async () => ok({ data: { data: [], links: { next: "https://a.klaviyo.com/api/lists/?nothing=here" } } });
    await expect(EMAIL_PROVIDERS.klaviyo.listAudiencesPage(klaviyoBad, null)).rejects.toThrow();
    const sgBad = sendgridHttpCall("SG.k", (async () => new Response(JSON.stringify({ result: [], _metadata: { next: "::bad::" } }), { status: 200 })) as unknown as typeof fetch);
    await expect(EMAIL_PROVIDERS.sendgrid.listAudiencesPage(sgBad, null)).rejects.toThrow();
    const sgMalformed = sendgridHttpCall("SG.k", (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch);
    await expect(EMAIL_PROVIDERS.sendgrid.listAudiencesPage(sgMalformed, null)).rejects.toThrow();
  });
});
