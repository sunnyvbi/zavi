import { describe, expect, it } from "vitest";
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import type { EmailTool, ProviderCall } from "@/services/connectors/email-campaign/providers";
import { looksLikeTest, readGmailSender, readTestLists, readToolLists, setTestList, type ToolCaller } from "../lists";

const ok = (data: unknown): ComposioExecResult => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });
const fail = (status = 500): ComposioExecResult => ({ ok: false, status, data: null, error: "down", outcome_unknown: false });

function mailchimpWith(total: number, failAtOffset: number | null = null): ProviderCall {
  return async (_slug, args) => {
    const offset = Number(args.offset ?? 0);
    if (failAtOffset !== null && offset >= failAtOffset) return fail();
    const n = Math.max(0, Math.min(200, total - offset));
    return ok({ data: { total_items: total, lists: Array.from({ length: n }, (_, i) => ({ id: `mc${offset + i}`, name: `List ${offset + i}`, stats: { member_count: 10 } })) } });
  };
}
const callers = (m: Partial<Record<EmailTool, ProviderCall | null | "throw" | "hang">>): ToolCaller => async (_t, tool) => {
  const c = m[tool];
  if (c === "throw") throw new Error("read failed");
  if (c === "hang") return () => new Promise(() => undefined);
  return c ?? null;
};

describe("a tool that rejects the saved key", () => {
  it("tells the founder to reconnect it, not to try again in a minute", async () => {
    const rejected: ProviderCall = async () => fail(401);
    const r = await readToolLists("t", "klaviyo", { caller: callers({ klaviyo: rejected }) });

    expect(r.status).toBe("unreadable");
    expect(r.error).toMatch(/Klaviyo rejected the key/);
    expect(r.error).toMatch(/disconnect Klaviyo, then reconnect/);
    expect(r.error).toMatch(/Private API key/);
    expect(r.error).not.toMatch(/try again in a minute/i);
  });

  it("still says try again when the tool is only down", async () => {
    const down: ProviderCall = async () => fail(503);
    const r = await readToolLists("t", "klaviyo", { caller: callers({ klaviyo: down }) });
    expect(r.error).toBe("Klaviyo could not be read right now. Try again in a minute.");
  });
});

describe("whether Gmail is connected", () => {
  it("asks for this workspace's own active Gmail account and says connected only when one is found", async () => {
    const asked: Array<[string, string]> = [];
    const found = async (t: string, kit: string) => (asked.push([t, kit]), { connected_account_id: "ca_1" });
    expect(await readGmailSender("tenant-a", found)).toEqual({ status: "connected" });
    expect(asked).toEqual([["tenant-a", "gmail"]]);
    expect(await readGmailSender("tenant-a", async () => null)).toEqual({ status: "not_connected" });
  });

  it("a check that fails or hangs is unreadable, never connected and never not connected", async () => {
    expect(await readGmailSender("t", async () => Promise.reject(new Error("composio list HTTP 503")))).toEqual({ status: "unreadable" });
    expect(await readGmailSender("t", () => new Promise(() => undefined), 20)).toEqual({ status: "unreadable" });
  });
});

describe("reading a tool's lists", () => {
  it("pages to the end: complete", async () => {
    const r = await readToolLists("t", "mailchimp", { caller: callers({ mailchimp: mailchimpWith(450) }) });
    expect(r.status).toBe("complete");
    expect(r.lists).toHaveLength(450);
  });

  it("too many pages: partial, with what it read", async () => {
    const r = await readToolLists("t", "mailchimp", { caller: callers({ mailchimp: mailchimpWith(5000) }), limits: { maxPages: 2 } });
    expect(r).toMatchObject({ status: "partial" });
    expect(r.lists).toHaveLength(400);
  });

  it("out of time: partial", async () => {
    let t = 0;
    const r = await readToolLists("t", "mailchimp", { caller: callers({ mailchimp: mailchimpWith(1000) }), now: () => (t += 10_000), limits: { routeTimeoutMs: 15_000 } });
    expect(r.status).toBe("partial");
  });

  it("the same cursor twice is not the end: partial, never complete", async () => {
    const loop: ProviderCall = async () => ok({ data: { data: [{ id: "K1", attributes: { name: "a" } }], links: { next: "https://a.klaviyo.com/api/lists/?page%5Bcursor%5D=same" } } });
    const r = await readToolLists("t", "klaviyo", { caller: callers({ klaviyo: loop }) });
    expect(r.status).toBe("partial");
  });

  it("an answer without its list is an error, not an empty last page", async () => {
    const odd: ProviderCall = async () => ok({ data: { unexpected: true } });
    expect((await readToolLists("t", "mailchimp", { caller: callers({ mailchimp: odd }) })).status).toBe("unreadable");
    expect((await readToolLists("t", "klaviyo", { caller: callers({ klaviyo: odd }) })).status).toBe("unreadable");
  });

  it("out of time before any page answered: unreadable, not partial", async () => {
    let t = 0;
    const r = await readToolLists("t", "mailchimp", { caller: callers({ mailchimp: mailchimpWith(10) }), now: () => (t += 20_000), limits: { routeTimeoutMs: 15_000 } });
    expect(r).toMatchObject({ status: "unreadable", lists: [] });
  });

  it("a page fails after others answered: partial; before any: unreadable; no connection: not_connected", async () => {
    expect((await readToolLists("t", "mailchimp", { caller: callers({ mailchimp: mailchimpWith(500, 200) }) })).status).toBe("partial");
    expect((await readToolLists("t", "mailchimp", { caller: callers({ mailchimp: mailchimpWith(500, 0) }) })).status).toBe("unreadable");
    expect((await readToolLists("t", "mailchimp", { caller: callers({}) })).status).toBe("not_connected");
    expect((await readToolLists("t", "mailchimp", { caller: callers({ mailchimp: "throw" }) })).status).toBe("unreadable");
  });
});

describe("the Test lists view", () => {
  const zavi = [{ id: "11111111-1111-4111-8111-111111111111", name: "Members", people: 40 }];

  it("every route side by side, marks shown; a gone list's mark may come off only after a complete read", async () => {
    const v = await readTestLists("t", {
      sendgridNeedsPermissions: async () => false,
      caller: callers({ mailchimp: mailchimpWith(3) }),
      marks: async () => new Set(["mailchimp:mc1", "mailchimp:gone", "zavi_list:22222222-2222-4222-8222-222222222222", "klaviyo:K1"]),
      zaviLists: async () => zavi,
    });
    expect(v.routes.map((r) => [r.route, r.status])).toEqual([["mailchimp", "complete"], ["klaviyo", "not_connected"], ["sendgrid", "not_connected"], ["zavi_list", "complete"]]);
    expect(v.routes[0].lists.find((l) => l.id === "mc1")!.marked).toBe(true);
    const by = (route: string, id: string) => v.orphans.find((o) => o.route === route && o.list_id === id)!;
    expect(by("mailchimp", "gone")).toMatchObject({ reason: "not_found", can_unmark: true });
    expect(by("mailchimp", "gone").note).toMatch(/Reconnecting/);
    expect(by("klaviyo", "K1")).toMatchObject({ reason: "not_checked", can_unmark: false });
    expect(by("zavi_list", "22222222-2222-4222-8222-222222222222")).toMatchObject({ can_unmark: true });
  });

  it("our own list store not answering: Zavi-list marks stay, with no Unmark", async () => {
    const v = await readTestLists("t", {
      sendgridNeedsPermissions: async () => false,
      caller: callers({}),
      marks: async () => new Set(["zavi_list:22222222-2222-4222-8222-222222222222"]),
      zaviLists: async () => Promise.reject(new Error("down")),
    });
    expect(v.routes.find((r) => r.route === "zavi_list")!.status).toBe("unreadable");
    expect(v.orphans).toEqual([expect.objectContaining({ route: "zavi_list", can_unmark: false, reason: "not_checked" })]);
  });

  it("a partial read: a mark not seen stays, with no Unmark", async () => {
    const v = await readTestLists("t", {
      sendgridNeedsPermissions: async () => false,
      caller: callers({ mailchimp: mailchimpWith(5000) }),
      marks: async () => new Set(["mailchimp:mc4999"]),
      zaviLists: async () => [],
      limits: { maxPages: 1 },
    });
    expect(v.orphans).toEqual([expect.objectContaining({ list_id: "mc4999", can_unmark: false, reason: "not_checked" })]);
  });

  it("a tool that hangs never holds up the others", async () => {
    const v = await readTestLists("t", {
      sendgridNeedsPermissions: async () => false,
      caller: callers({ klaviyo: "hang", mailchimp: mailchimpWith(2) }),
      marks: async () => new Set(),
      zaviLists: async () => zavi,
      limits: { routeTimeoutMs: 20, callTimeoutMs: 20 },
    });
    expect(v.routes.find((r) => r.route === "klaviyo")!.status).toBe("unreadable");
    expect(v.routes.find((r) => r.route === "mailchimp")!.status).toBe("complete");
  });

  it("our own list store that hangs is unreadable in time, never holding up the page", async () => {
    const v = await readTestLists("t", {
      sendgridNeedsPermissions: async () => false,
      caller: callers({}),
      marks: async () => new Set(),
      zaviLists: () => new Promise(() => undefined),
      limits: { routeTimeoutMs: 20, callTimeoutMs: 20 },
    });
    expect(v.routes.find((r) => r.route === "zavi_list")!.status).toBe("unreadable");
  });

  it("names that read like a test get a hint, never a mark", () => {
    expect(looksLikeTest("Internal test list")).toBe(true);
    expect(looksLikeTest("QA seed")).toBe(true);
    expect(looksLikeTest("Newsletter")).toBe(false);
    expect(looksLikeTest("Contestants")).toBe(false);
  });
});

describe("marking one list", () => {
  const rpc = (out: Record<string, unknown> = { ok: true, changed: true }) => {
    const calls: unknown[] = [];
    return { calls, fn: async (_t: string, a: unknown) => (calls.push(a), out) };
  };

  it("a tool list must be found to be marked", async () => {
    const r = rpc();
    expect(await setTestList("t", "u", "mailchimp", "mc2", true, { caller: callers({ mailchimp: mailchimpWith(3) }), rpc: r.fn })).toMatchObject({ ok: true, marked: true });
    expect(r.calls).toEqual([{ p_actor_user_id: "u", p_key: "mailchimp:mc2", p_marked: true }]);
    expect(await setTestList("t", "u", "mailchimp", "nope", true, { caller: callers({ mailchimp: mailchimpWith(3) }), rpc: r.fn })).toMatchObject({ ok: false, code: "list_not_found" });
    expect(await setTestList("t", "u", "mailchimp", "x", true, { caller: callers({}), rpc: r.fn })).toMatchObject({ ok: false, code: "not_connected" });
  });

  it("unmarking needs a complete read of its route, even for a list that is there", async () => {
    const r = rpc();
    expect(await setTestList("t", "u", "mailchimp", "mc0", false, { caller: callers({ mailchimp: mailchimpWith(5000) }), rpc: r.fn, limits: { maxPages: 1 } })).toMatchObject({
      ok: false,
      code: "could_not_check",
    });
    expect(r.calls).toHaveLength(0);
    expect(await setTestList("t", "u", "zavi_list", "11111111-1111-4111-8111-111111111111", false, { rpc: r.fn, zaviReadable: async () => Promise.reject(new Error("down")) })).toMatchObject({
      ok: false,
      code: "could_not_check",
    });
    expect(await setTestList("t", "u", "zavi_list", "11111111-1111-4111-8111-111111111111", false, { rpc: r.fn, zaviReadable: async () => undefined })).toMatchObject({ ok: true });
  });

  it("unmarking a list not seen needs a complete read", async () => {
    const r = rpc();
    expect(await setTestList("t", "u", "mailchimp", "gone", false, { caller: callers({ mailchimp: mailchimpWith(3) }), rpc: r.fn })).toMatchObject({ ok: true });
    expect(await setTestList("t", "u", "mailchimp", "gone", false, { caller: callers({ mailchimp: mailchimpWith(5000) }), rpc: r.fn, limits: { maxPages: 1 } })).toMatchObject({
      ok: false,
      code: "could_not_check",
    });
    expect(await setTestList("t", "u", "klaviyo", "K1", false, { caller: callers({}), rpc: r.fn })).toMatchObject({ ok: false, code: "not_connected" });
  });

  it("a Zavi list id: lowercase on the way in; not a UUID is refused before the database", async () => {
    const r = rpc();
    await setTestList("t", "u", "zavi_list", "AAAAAAAA-1111-4111-8111-111111111111", true, { rpc: r.fn });
    expect(r.calls).toEqual([{ p_actor_user_id: "u", p_key: "zavi_list:aaaaaaaa-1111-4111-8111-111111111111", p_marked: true }]);
    expect(await setTestList("t", "u", "zavi_list", "not-a-uuid", true, { rpc: r.fn })).toMatchObject({ ok: false, code: "bad_list" });
    expect(r.calls).toHaveLength(1);
  });

  it("a Zavi list goes straight to the database (it checks the list); bad input never reaches it; its refusal is passed on", async () => {
    const r = rpc({ ok: false, code: "list_not_found" });
    expect(await setTestList("t", "u", "zavi_list", "11111111-1111-4111-8111-111111111111", true, { caller: callers({}), rpc: r.fn })).toMatchObject({ ok: false, code: "list_not_found" });
    expect(r.calls).toHaveLength(1);
    expect(await setTestList("t", "u", "gmail" as never, "x", true, { rpc: r.fn })).toMatchObject({ ok: false, code: "bad_list" });
    expect(await setTestList("t", "u", "mailchimp", "a b", true, { rpc: r.fn })).toMatchObject({ ok: false, code: "bad_list" });
    expect(r.calls).toHaveLength(1);
  });
});

describe("a SendGrid key saved with Mail Send only", () => {
  const sendgridWith = (ids: string[]): ProviderCall => async () => ok({ result: ids.map((id) => ({ id, name: `Brightloop ${id}`, contact_count: 12 })) });
  const sendgridRoute = (v: Awaited<ReturnType<typeof readTestLists>>) => v.routes.find((r) => r.route === "sendgrid")!;

  it("is reported as needing permissions, not as not connected, and offers no SendGrid lists", async () => {
    const asked: string[] = [];
    const v = await readTestLists("t", {
      caller: callers({}),
      marks: async () => new Set(["sendgrid:SG1"]),
      zaviLists: async () => [],
      sendgridNeedsPermissions: async (tenant) => {
        asked.push(tenant);
        return true;
      },
    });
    expect(sendgridRoute(v)).toEqual({ route: "sendgrid", label: "SendGrid", status: "needs_permissions", error: expect.stringMatching(/missing the permissions campaigns need/), lists: [] });
    expect(asked).toEqual(["t"]);
    expect(v.routes.find((r) => r.route === "mailchimp")!.status).toBe("not_connected");
    expect(v.orphans).toEqual([expect.objectContaining({ route: "sendgrid", list_id: "SG1", reason: "not_checked", can_unmark: false })]);
  });

  it("a campaign-ready key reads its lists as before and never asks about permissions", async () => {
    let asked = 0;
    const v = await readTestLists("t", {
      caller: callers({ sendgrid: sendgridWith(["SG1", "SG2"]) }),
      marks: async () => new Set(),
      zaviLists: async () => [],
      sendgridNeedsPermissions: async () => {
        asked++;
        return true;
      },
    });
    expect(sendgridRoute(v)).toMatchObject({ status: "complete", error: null });
    expect(sendgridRoute(v).lists.map((l) => l.id)).toEqual(["SG1", "SG2"]);
    expect(asked).toBe(0);
  });

  it("no key saved, or the permission check failing, stays not connected", async () => {
    const none = await readTestLists("t", { caller: callers({}), marks: async () => new Set(), zaviLists: async () => [], sendgridNeedsPermissions: async () => false });
    expect(sendgridRoute(none)).toMatchObject({ status: "not_connected", error: null });
    const down = await readTestLists("t", { caller: callers({}), marks: async () => new Set(), zaviLists: async () => [], sendgridNeedsPermissions: () => Promise.reject(new Error("db down")) });
    expect(sendgridRoute(down)).toMatchObject({ status: "not_connected", error: null });
  });

  it("only SendGrid is asked: a Mailchimp that is not connected stays not connected", async () => {
    const asked: string[] = [];
    await readTestLists("t", { caller: callers({}), marks: async () => new Set(), zaviLists: async () => [], sendgridNeedsPermissions: async () => (asked.push("x"), true) });
    expect(asked).toHaveLength(1);
  });

  it("marking a list on that route is refused as not connected", async () => {
    let wrote = false;
    const r = await setTestList("t", "u", "sendgrid", "SG1", true, { caller: callers({}), rpc: async () => ((wrote = true), { ok: true }) });
    expect(r).toMatchObject({ ok: false, code: "not_connected" });
    expect(wrote).toBe(false);
  });
});

describe("Klaviyo people counts on the Test lists read", () => {
  const PAGES: Record<string, { ids: string[]; next: string | null }> = {
    first: { ids: Array.from({ length: 8 }, (_, i) => `A${i}`), next: "p2" },
    p2: { ids: Array.from({ length: 8 }, (_, i) => `B${i}`), next: "p3" },
    p3: { ids: Array.from({ length: 8 }, (_, i) => `C${i}`), next: null },
  };
  const klaviyoPaged = (clock: { t: number }, pageMs: number, sizeMs: number, sizeStarts: number[]): ProviderCall => async (slug, a) => {
    if (slug === "KLAVIYO_GET_LISTS") {
      clock.t += pageMs;
      const page = PAGES[String(a.page_cursor ?? "first")];
      return ok({ data: { data: page.ids.map((id) => ({ type: "list", id, attributes: { name: `Brightloop ${id}` } })), links: { next: page.next ? `https://a.klaviyo.com/api/lists?page%5Bcursor%5D=${page.next}` : null } } });
    }
    if (slug !== "KLAVIYO_GET_LIST") throw new Error(`unexpected ${slug}`);
    sizeStarts.push(clock.t);
    clock.t += sizeMs;
    return ok({ data: { type: "list", id: a.id, attributes: { profile_count: 50 } } });
  };
  const read = (call: ProviderCall, clock: { t: number }) =>
    readTestLists("t", { caller: callers({ klaviyo: call }), marks: async () => new Set(), zaviLists: async () => [], sendgridNeedsPermissions: async () => false, now: () => clock.t });
  const klaviyoRoute = (v: Awaited<ReturnType<typeof readTestLists>>) => v.routes.find((r) => r.route === "klaviyo")!;

  it("a 3-page read makes at most 10 size calls in all, the rest stay unknown, and the read stays complete", async () => {
    const clock = { t: 0 };
    const starts: number[] = [];
    const v = await read(klaviyoPaged(clock, 300, 100, starts), clock);
    const r = klaviyoRoute(v);
    expect(r.status).toBe("complete");
    expect(r.lists).toHaveLength(24);
    expect(starts).toHaveLength(10);
    expect(r.lists.filter((l) => l.people === 50).map((l) => l.id)).toEqual([...PAGES.first.ids, "B0", "B1"]);
    expect(r.lists.slice(10).every((l) => l.people === null)).toBe(true);
  });

  it("slow size calls stop at the ~3 s budget, measured from the end of paging", async () => {
    const clock = { t: 0 };
    const starts: number[] = [];
    const v = await read(klaviyoPaged(clock, 300, 700, starts), clock);
    expect(starts).toEqual([900, 1_600, 2_300, 3_000, 3_700]);
    expect(Math.max(...starts) - 900).toBeLessThan(3_000);
    expect(clock.t - 900).toBeLessThanOrEqual(3_000 + 700);
    expect(klaviyoRoute(v).lists.filter((l) => l.people !== null)).toHaveLength(5);
  });

  it("paging that used most of the 15 s route budget leaves sizing only what is left", async () => {
    const clock = { t: 0 };
    const starts: number[] = [];
    const v = await read(klaviyoPaged(clock, 4_500, 600, starts), clock);
    expect(klaviyoRoute(v).status).toBe("complete");
    expect(starts).toEqual([13_500, 14_100, 14_700]);
  });

  it("a size call that hangs never costs the founder the lists", async () => {
    let hung = 0;
    const call: ProviderCall = async (slug) => {
      if (slug === "KLAVIYO_GET_LIST") return (hung++, new Promise(() => undefined));
      return ok({ data: { data: [{ type: "list", id: "K1", attributes: { name: "Brightloop" } }], links: { next: null } } });
    };
    const v = await readTestLists("t", { caller: callers({ klaviyo: call }), marks: async () => new Set(), zaviLists: async () => [], sendgridNeedsPermissions: async () => false, size: { maxCalls: 10, budgetMs: 40 } });
    expect(klaviyoRoute(v)).toMatchObject({ status: "complete", lists: [expect.objectContaining({ id: "K1", people: null })] });
    expect(hung).toBe(1);
  });

  it("a write's list read (no size budget) never sizes", async () => {
    const clock = { t: 0 };
    const starts: number[] = [];
    const r = await readToolLists("t", "klaviyo", { caller: callers({ klaviyo: klaviyoPaged(clock, 10, 10, starts) }), now: () => clock.t });
    expect(r.lists).toHaveLength(24);
    expect(starts).toEqual([]);
  });
});
