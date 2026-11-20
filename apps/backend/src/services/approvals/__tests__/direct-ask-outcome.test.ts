import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/tenant-client", () => ({ asTenantId: (v: string) => v, tenantClient: () => { throw new Error("no db in this test"); }, tenantRpc: vi.fn() }));
import { directAskOutcomeText, tellDirectAskOutcome, type TellDeps } from "@/services/approvals/direct-ask-outcome";
import { buildEnvelope } from "@/services/approvals/approval-envelope";

const T = "tenant-a";
const plan = { channel_slug: "meta_ads", budget_type: "daily" as const, total_usd: 30, daily_usd: 10, start: "2026-10-17", end: "2026-10-20", days: 3, switched_from: null };
const env = (id: string) => buildEnvelope({ envelope_id: id, tenant_id: T, approver: { user_id: "u", role: "owner", surface: "chat" }, plan });

function deps(over: Partial<TellDeps> & { trigger?: string; payload?: unknown; envelope?: unknown; releaseFails?: boolean } = {}) {
  const claims = new Map<string, string>();
  const sent: Array<{ surface: string; body: string }> = [];
  const d: TellDeps = {
    readAction: async () => ({ channel_slug: "meta_ads", exec_class: "meta_ads.launch_campaign", approval_envelope: "envelope" in over ? over.envelope : env("ask:root") }),
    readRun: async () => ({ id: "root", trigger: over.trigger ?? "chat", payload: over.payload ?? { thread_id: "th-1" }, agent_slug: "operator" }),
    claim: async (_t, k) => (claims.get(k) === "done" ? "taken" : (claims.set(k, claims.get(k) ?? "processing"), "claimed")),
    release: async (_t, k) => over.releaseFails ? false : claims.delete(k),
    done: async (_t, k) => (claims.set(k, "done"), true),
    chat: async (_t, _th, body) => (sent.push({ surface: "chat", body }), true),
    slack: async (_t, _r, body) => (sent.push({ surface: "slack", body }), true),
    email: async (_t, _r, body) => (sent.push({ surface: "email", body }), true),
    waitForFilingRun: async () => {},
    ...over,
  };
  return { d, sent, claims };
}

describe("tellDirectAskOutcome", () => {
  it("waits for the run that filed the card (and its reply in the thread) before posting", async () => {
    const order: string[] = [];
    const { d } = deps({
      waitForFilingRun: async (_t, action, surface) => { order.push(`wait:${action}:${surface.thread_id}:${surface.email}`); },
      chat: async () => (order.push("post"), true),
    });
    await tellDirectAskOutcome({ tenant_id: T, action_id: "a1", ok: false, text: "archived", code: "chatgpt_ads_launch_undone" }, d);
    expect(order).toEqual(["wait:a1:th-1:false", "post"]);
  });

  it("a wait that errors never holds the outcome back", async () => {
    const { d, sent } = deps({ waitForFilingRun: async () => { throw new Error("db down"); } });
    expect(await tellDirectAskOutcome({ tenant_id: T, action_id: "a1", ok: true, text: "Your Meta ad is on." }, d)).toBe("told");
    expect(sent).toHaveLength(1);
  });

  it("posts once in the chat thread the founder asked in; a retry is not told twice", async () => {
    const { d, sent } = deps();
    const o = { tenant_id: T, action_id: "a1", ok: false, text: "Meta refused the ad set: no Page permission.", code: "meta_ads_failed" };
    expect(await tellDirectAskOutcome(o, d)).toBe("told");
    expect(await tellDirectAskOutcome(o, d)).toBe("already_told");
    expect(sent).toEqual([{ surface: "chat", body: "Your Meta ad didn't finish setting up. Meta refused the ad set: no Page permission." }]);
  });
  it("a later, different outcome (a top-up landed) is told too", async () => {
    const { d, sent } = deps();
    await tellDirectAskOutcome({ tenant_id: T, action_id: "a1", ok: false, text: "Add $25 to start: https://pay", code: "wallet_short" }, d);
    await tellDirectAskOutcome({ tenant_id: T, action_id: "a1", ok: true, text: "Your Meta ad is on." }, d);
    expect(sent.map((s) => s.body)).toEqual(["Your Meta ad didn't finish setting up. Add $25 to start: https://pay", "Your Meta ad is on."]);
  });
  it("Slack and email asks are answered on their own surface", async () => {
    const slack = deps({ trigger: "slack", payload: { slack: { channel_id: "C1", thread_ts: "1.2", team_id: "T1" } } });
    expect(await tellDirectAskOutcome({ tenant_id: T, action_id: "a2", ok: true, text: null }, slack.d)).toBe("told");
    expect(slack.sent).toEqual([{ surface: "slack", body: "Your Meta ad is on." }]);
    const email = deps({ trigger: "email", payload: { email: { email_message_id: "m1" } } });
    expect(await tellDirectAskOutcome({ tenant_id: T, action_id: "a3", ok: true, text: null }, email.d)).toBe("told");
    expect(email.sent.map((s) => s.surface)).toEqual(["email"]);
  });
  it("a failed delivery gives the claim back so the settle retry can tell", async () => {
    const { d, claims } = deps({ chat: async () => false });
    expect(await tellDirectAskOutcome({ tenant_id: T, action_id: "a4", ok: true, text: null }, d)).toBe("failed");
    expect(claims.size).toBe(0);
  });
  it("a failed send whose claim give-back ALSO fails is still resent next time (Codex r2 F2)", async () => {
    let up = false;
    const { d, sent } = deps({ releaseFails: true, chat: async (_t, _th, body) => (up ? (sent.push({ surface: "chat", body }), true) : false) });
    const o = { tenant_id: T, action_id: "a7", ok: true, text: null };
    expect(await tellDirectAskOutcome(o, d)).toBe("failed");
    up = true;
    expect(await tellDirectAskOutcome(o, d)).toBe("told");
    expect(await tellDirectAskOutcome(o, d)).toBe("already_told");
    expect(sent).toHaveLength(1);
  });
  it("a cgo-yes envelope, no envelope, or a non-ad class is not this path", async () => {
    expect(await tellDirectAskOutcome({ tenant_id: T, action_id: "a5", ok: true, text: null }, deps({ envelope: env("q:question-1") }).d)).toBe("not_a_direct_ask");
    expect(await tellDirectAskOutcome({ tenant_id: T, action_id: "a5", ok: true, text: null }, deps({ envelope: null }).d)).toBe("not_a_direct_ask");
    const other = deps();
    other.d.readAction = async () => ({ channel_slug: "email_marketing", exec_class: "email.send", approval_envelope: env("ask:root") });
    expect(await tellDirectAskOutcome({ tenant_id: T, action_id: "a5", ok: true, text: null }, other.d)).toBe("not_a_direct_ask");
  });
  it("an envelope for another tenant is never told here", async () => {
    const foreign = buildEnvelope({ envelope_id: "ask:root", tenant_id: "tenant-b", approver: { user_id: "u", role: "owner", surface: "chat" }, plan });
    expect(await tellDirectAskOutcome({ tenant_id: T, action_id: "a6", ok: true, text: null }, deps({ envelope: foreign }).d)).toBe("not_a_direct_ask");
  });
});

describe("directAskOutcomeText", () => {
  it("names a created object the reason did not mention", () => {
    expect(directAskOutcomeText({ ok: false, text: "Launch failed.", created: { object_type: "campaign", id: "123" } }, "TikTok")).toBe("Your TikTok ad didn't finish setting up. Launch failed. Zavi created campaign 123 on TikTok; check it there.");
    expect(directAskOutcomeText({ ok: false, text: null }, "X")).toBe("Your X ad didn't finish setting up. The change did not go through.");
  });
});
