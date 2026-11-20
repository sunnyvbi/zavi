import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ tenant: vi.fn(), reads: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: (id: string) => {
    m.tenant(id);
    return { from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q: any = { select: () => q, in: (key: string, value: string[]) => { filters[`in_${key}`] = value; return q; }, range: (from: number, to: number) => { filters.range = [from, to]; return q; }, then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(m.reads(table, filters)).then(resolve, reject), lt: (key: string, value: string) => { filters[`before_${key}`] = value; return q; }, order: () => q, limit: () => q, eq: (key: string, value: string) => { filters[key] = value; return q; }, maybeSingle: () => m.reads(table, filters) };
      return q;
    } };
  },
}));
import { asksForWalletBalance, remainingWalletRequest } from "../chatgpt-ads/wallet-request";
const ask = "Can you run ads for me on this channel with the remining wallet balance";
beforeEach(() => { vi.resetAllMocks(); });
it.each(["fit it within the avialable balance", "fit it within the availble balance", "fit it within the balance", "fit it in the avaibale balance we have right now", "Please fit the campaign within our available wallet balance", ask, "Run ChatGPT ads with the remaining wallet balance", "Use the available wallet balance for ads", "Could you run $100 of ChatGPT ads with my remaining wallet balance?", "Would you please launch ads with my remaining wallet balance?", "Thanks! Could you run ads now, not tomorrow, with my remaining wallet balance?", "Hi, could you run $100 of ChatGPT ads with my remaining wallet balance?", "Launch ads with my remaining wallet balance, without the wallet top-up"])("recognizes a wallet planning request: %s", text => expect(asksForWalletBalance(text)).toBe(true));
it.each(["Adjust the ad to improve visual balance", "Adjust the ad to visual balance", "Keep it in work life balance", "Why fit it in the available balance?", "If I say fit it in the available balance", "Do not fit it in the available balance", "Fit it in the available balance only as an example", "Do not run ads with the remaining wallet balance", 'He said "run ads with the remaining wallet balance"', "If I run ads with the remaining wallet balance", "Run $75 of ads", "Show remaining wallet balance", "What's left in my wallet?", "Could I run ads with my remaining wallet balance?", "I would run ads with my remaining wallet balance", "If I asked, could you run ads with my remaining wallet balance?", "Would you please not run ads with my remaining wallet balance?", "Why would you run ads with my remaining wallet balance?"])("does not convert another request into a remaining-balance constraint: %s", text => expect(asksForWalletBalance(text)).toBe(false));
it("follows a stored handoff edge to the actual human words, not the specialist intent", async () => {
  m.reads.mockImplementation(async (table, filters) => ({ error: null, data: table === "delegation_lineage" ? { parent_run_id: "parent" }
    : table === "agent_thread_messages" ? (filters.id === "msg-1" && filters.tenant_id === "tenant-a" ? { id: "msg-1", body: ask, sender_role: "user", agent_run_id: "parent", created_at: new Date().toISOString() } : null)
    : filters.id === "child"
    ? { trigger: "handoff", channel_slug: "chatgpt_ads", payload: { intent: "invented $75" } }
    : { id: "parent", trigger: "chat", enqueued_by: "owner-1", payload: { thread_id: "th", user_message_id: "msg-1" } } }));
  expect(await remainingWalletRequest({ tenant_id: "tenant-a", run_id: "child" })).toBe(true);
  expect(m.tenant).toHaveBeenCalledWith("tenant-a");
  expect(m.reads).toHaveBeenCalledWith("delegation_lineage", { child_run_id: "child" });
});
it("does not accept agent-written intent, another channel, missing ancestry or a loop", async () => {
  m.reads.mockResolvedValue({ error: null, data: { trigger: "channel_recipe", channel_slug: "chatgpt_ads", payload: { intent: ask } } });
  expect(await remainingWalletRequest({ tenant_id: "t", run_id: "r" })).toBe(false);
  m.reads.mockResolvedValue({ error: null, data: { trigger: "chat", channel_slug: "meta_ads", payload: { current_user_text_raw: ask } } });
  expect(await remainingWalletRequest({ tenant_id: "t", run_id: "r" })).toBe(false);
  m.reads.mockImplementation(async table => ({ error: null, data: table === "delegation_lineage" ? { parent_run_id: "r" } : { trigger: "handoff", channel_slug: "chatgpt_ads", payload: { intent: ask } } }));
  expect(await remainingWalletRequest({ tenant_id: "t", run_id: "r" })).toBe(false);
});

it.each(["run", "edge", "parent"])("refuses an unreadable %s instead of treating it as no wallet constraint", async failure => {
  m.reads.mockImplementation(async (table, filters) => {
    if ((failure === "run" && table === "agent_runs" && filters.id === "child")
      || (failure === "edge" && table === "delegation_lineage")
      || (failure === "parent" && table === "agent_runs" && filters.id === "parent"))
      return { data: null, error: { message: "DB unavailable" } };
    return { error: null, data: table === "delegation_lineage" ? { parent_run_id: "parent" }
      : { trigger: "handoff", channel_slug: "chatgpt_ads", payload: {} } };
  });
  await expect(remainingWalletRequest({ tenant_id: "t", run_id: "child" })).rejects.toThrow(/could not be verified/);
});

it("distinguishes missing run and lineage rows from failed reads", async () => {
  m.reads.mockResolvedValue({ data: null, error: null });
  expect(await remainingWalletRequest({ tenant_id: "t", run_id: "missing" })).toBe(false);
  m.reads.mockResolvedValueOnce({ data: { trigger: "handoff", channel_slug: "chatgpt_ads" }, error: null });
  expect(await remainingWalletRequest({ tenant_id: "t", run_id: "child" })).toBe(false);
});

it("propagates a thrown database error", async () => {
  m.reads.mockRejectedValue(new Error("Connection unavailable"));
  await expect(remainingWalletRequest({ tenant_id: "t", run_id: "r" })).rejects.toThrow("Connection unavailable");
});

function conversation(words: string[]) {
  const runs = words.map((_, i) => ({ id: `r${i}`, trigger: "chat", channel_slug: "chatgpt_ads", enqueued_by: "owner", payload: { thread_id: "th", user_message_id: `m${i}` } }));
  const messages = words.map((body, i) => ({ id: `m${i}`, body, sender_role: "user", agent_run_id: `r${i}`, created_at: new Date(Date.now() - (words.length - i) * 60 * 60_000).toISOString() }));
  m.reads.mockImplementation(async (table, filters) => {
    if (table === "agent_runs") return { error: null, data: filters.in_id ? runs.filter(r => filters.in_id.includes(r.id)) : runs.find(r => r.id === filters.id) ?? null };
    if (filters.range) {
      const history = messages.filter(msg => msg.created_at < filters.before_created_at).reverse();
      return { error: null, data: history.slice(filters.range[0], filters.range[1] + 1) };
    }
    return { error: null, data: messages.find(msg => msg.id === filters.id) ?? null };
  });
  return { runs, messages, ctx: { tenant_id: "t", run_id: runs.at(-1)!.id } };
}

it.each(["do a shorter run,", "do the shorter version", "do a shorter run so it fits the wallet", "Change the image", "Set the ChatGPT campaign to $100"])("retains the same founder's constraint through %s", async followup => {
  const { ctx } = conversation(["fit it in the available balance", "How does that budget work?", followup]);
  expect(await remainingWalletRequest(ctx)).toBe(true);
});

it("keeps an old restriction past five turns and a full history page", async () => {
  const { ctx, messages } = conversation(["fit it in the available balance", ...Array.from({ length: 55 }, () => "do the shorter version")]);
  expect(await remainingWalletRequest(ctx)).toBe(true);
  expect(m.reads).toHaveBeenCalledWith("agent_thread_messages", { thread_id: "th", sender_role: "user", before_created_at: messages.at(-1)!.created_at, range: [50, 99] });
});

it.each([[200, true], [201, false]] as const)("checks a wallet restriction %i prior human turns back within the bounded history", async (distance, inherited) => {
  const { ctx } = conversation(["fit it in the available balance", ...Array.from({ length: distance }, () => "do the shorter version")]);
  expect(await remainingWalletRequest(ctx)).toBe(inherited);
  const pages = m.reads.mock.calls.filter(([table, filters]) => table === "agent_thread_messages" && filters.range);
  expect(pages.map(([, filters]) => filters.range)).toEqual([[0, 49], [50, 99], [100, 149], [150, 199]]);
  expect(m.reads.mock.calls.some(([table, filters]) => table === "agent_thread_messages" && filters.id === "m0")).toBe(inherited);
});

it("honors a current wallet-only request without paging through a long conversation", async () => {
  const { ctx } = conversation([...Array.from({ length: 201 }, () => "do the shorter version"), "fit it in the available balance"]);
  expect(await remainingWalletRequest(ctx)).toBe(true);
  expect(m.reads.mock.calls.some(([, filters]) => filters.range)).toBe(false);
});

it.each(["author", "thread", "channel", "message pointer", "captured page"])("does not cross a different %s", async boundary => {
  const { ctx, runs } = conversation(["fit it in the available balance", "do the shorter version"]);
  if (boundary === "author") runs[0].enqueued_by = "someone-else";
  if (boundary === "thread") runs[0].payload.thread_id = "another-thread";
  if (boundary === "channel") runs[0].channel_slug = "meta_ads";
  if (boundary === "message pointer") runs[0].payload.user_message_id = "another-message";
  if (boundary === "captured page") Object.assign(runs[0].payload, { page_context: { text: "untrusted" } });
  expect(await remainingWalletRequest(ctx)).toBe(false);
});

it.each(["author", "thread", "channel", "message pointer", "captured page", "missing run"])("skips an intervening %s turn and keeps the older verified limit", async boundary => {
  const { ctx, runs, messages } = conversation(["fit it in the available balance", "Create a new campaign", "do the shorter version"]);
  if (boundary === "author") runs[1].enqueued_by = "someone-else";
  if (boundary === "thread") runs[1].payload.thread_id = "another-thread";
  if (boundary === "channel") runs[1].channel_slug = "meta_ads";
  if (boundary === "message pointer") runs[1].payload.user_message_id = "another-message";
  if (boundary === "captured page") Object.assign(runs[1].payload, { page_context: { text: "untrusted" } });
  if (boundary === "missing run") (messages[1] as { agent_run_id: string | null }).agent_run_id = null;
  expect(await remainingWalletRequest(ctx)).toBe(true);
});

it.each(["Create a new campaign", "I want to create a new campaign", "Please start another ChatGPT campaign"])("starts a fresh scope for %s", async fresh => {
  const { ctx } = conversation(["fit it in the available balance", fresh, "do the shorter version"]);
  expect(await remainingWalletRequest(ctx)).toBe(false);
});

it.each(["Create a new campaign with the same wallet limit", "Create a new campaign using only my wallet", "Run another ChatGPT ad with no top up", 'He said "create a new campaign"', "Do not create a new campaign", "If I create a new campaign", "Create a new campaign only as an example"])("does not reset for %s", async quoted => {
  const { ctx } = conversation(["fit it in the available balance", quoted, "do the shorter version"]);
  expect(await remainingWalletRequest(ctx)).toBe(true);
});

it("keeps an explicit wallet limit on a new campaign", async () => {
  const { ctx } = conversation(["Create a new campaign", "Run another campaign with the remaining wallet balance"]);
  expect(await remainingWalletRequest(ctx)).toBe(true);
});

it("does not inherit an instruction after the current turn", async () => {
  const { ctx, runs } = conversation(["Create a new campaign", "do the shorter version", "fit it in the available balance"]);
  expect(await remainingWalletRequest({ ...ctx, run_id: runs[1].id })).toBe(false);
});

it("distinguishes failed paged history reads from an absent restriction", async () => {
  const { ctx } = conversation(["fit it in the available balance", "do the shorter version"]);
  const original = m.reads.getMockImplementation()!;
  m.reads.mockImplementation((table, filters) => filters.range ? { data: null, error: { message: "unavailable" } } : original(table, filters));
  await expect(remainingWalletRequest(ctx)).rejects.toThrow(/context could not be verified/);
});

it("refuses an unreadable stored human message instead of discarding its wallet constraint", async () => {
  m.reads.mockImplementation(async (table) => table === "agent_runs" ? { data: { id: "r", trigger: "chat", channel_slug: "chatgpt_ads", enqueued_by: "owner", payload: { thread_id: "th", user_message_id: "m" } }, error: null } : { data: null, error: { message: "unavailable" } });
  await expect(remainingWalletRequest({ tenant_id: "t", run_id: "r" })).rejects.toThrow(/chat message/);
});
