
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tools/outbound/_flag-check", () => ({ isOutboundEmailProducerEnabled: async () => true }));
vi.mock("@/services/comms/email-sender", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/email-sender")>()),
  connectedEmailSender: async () => "gmail",
}));
import {
  classifyChatTurnByRules,
  inheritedChatTurnVerdict,
  resolveChatTurnVerdict,
  type VerdictReader,
} from "../chat-turn-verdict";
import { CHAT_CARD_OFFER_LINE } from "../channel-chat-mode";
import { chatAnswerTurnEmit, stripProposeToolsOnRedo } from "../redo-mode";
import { resolveChannelExecEmit } from "@/services/channels/exec-emit";
import { callOutboundTool } from "@/services/mcp/internal/outbound";

const OFFER = `CPC is high because the audience is narrow. I would widen it.\n\n${CHAT_CARD_OFFER_LINE}`;
const tags = { tenantId: "t1", agentSlug: "meta_ads", runId: "r1" };
const never = vi.fn(async () => {
  throw new Error("tiebreak must not run on a turn the rules place");
});

describe("verdict rules", () => {
  it.each([
    ["why is my CPC high?", "answer"],
    ["do you think a shorter run is better", "answer"],
    ["Could you shorten it to 3 hours?", "action"],
    ["fit it in the avaibale balance we have right now", "action"],
    ["Do shorter runs perform better?", "answer"],
    ["Why would you do a shorter run?", "answer"],
    ["Do not shorten it, just explain", "answer"],
    ["do a shorter run, no cards please", "answer"],
    ["Should we pause the LA campaign?", "answer"],
    ["don't create any cards, just explain", "answer"],
    ["Raise the Meta budget to $80", "action"],
    ["can you pause the LA campaign?", "action"],
    ["The campaign is not yet live, launch it", "action"],
    ["Pause the ad set that's not yet converting", "action"],
    ["don't do that, lower it to $40 instead", "action"],
    ["Run a $50 ChatGPT ad", "action"],
    ["make this a card", "action"],
    ["Can you draft a LinkedIn post about our launch?", "action"],
    ["Can we launch this?", "action"],
    ["Create a LinkedIn post announcing our launch.", "action"],
    ["Draft emails are missing from the queue. Why?", "answer"],
    ["no cards, just explain the drop", "answer"],
    ["Create a LinkedIn post, no card needed.", "answer"],
    ["Make emails have clearer CTAs", "action"],
    ["Update the targeting to US only", "action"],
    ["change the destination url to https://example.com/cars", "action"],
    ["Replace the creative with a new image and headline", "action"],
    ["Prepare a new Reddit campaign at $5 a day", "action"],
    ["Pause the ad group and the ad too", "action"],
    ["Authorize the account for Autopilot", "action"],
    ["how do I update the targeting?", "answer"],
    ["Rename the campaign to Spring traffic", "action"],
    ["Archive the paused campaign", "action"],
    ["Delete the archived ad", "action"],
    ["Remove the old ad group", "action"],
    ["can I delete an ad later?", "answer"],
    ["Rename which campaign?", "answer"],
    ["Change what exactly on the ad?", "answer"],
    ["Can you rename the campaign to Spring traffic?", "action"],
    ["Change the headline because it doesn't convert", "action"],
    ["Remove ads that keep failing review", "action"],
    ["Can you remove failed ads?", "action"],
    ["Please archive failed campaigns?", "action"],
    ["Delete the stopped campaigns", "action"],
    ["Remove failed ads", "action"],
    ["Remove the old failed ads", "action"],
    ["Archive the stopped reddit campaigns", "action"],
    ["The ad is old, delete it. Archive the ad group too", "action"],
  ])("%s -> %s, without a model call", async (text, want) => {
    expect(await resolveChatTurnVerdict({ userText: text, prevAssistantText: null, tags, tiebreak: never })).toBe(want);
    expect(never).not.toHaveBeenCalled();
  });

  it("a bare yes files only right after the card offer", async () => {
    expect(await resolveChatTurnVerdict({ userText: "yes", prevAssistantText: OFFER, tags, tiebreak: never })).toBe("action");
    expect(await resolveChatTurnVerdict({ userText: "go ahead", prevAssistantText: OFFER, tags, tiebreak: never })).toBe("action");
    expect(await resolveChatTurnVerdict({ userText: "yes", prevAssistantText: "CPC is high because the audience is narrow.", tags, tiebreak: never })).toBe("answer");
    expect(await resolveChatTurnVerdict({ userText: "yes", prevAssistantText: null, tags, tiebreak: never })).toBe("answer");
  });

  it("describing that no cards exist is not a veto", () => {
    expect(classifyChatTurnByRules("There are no cards for this campaign, so create one", null)).not.toBe("answer");
    expect(classifyChatTurnByRules("There are no cards, so create one", null)).not.toBe("answer");
    expect(classifyChatTurnByRules("No cards exist for this campaign, so create one", null)).not.toBe("answer");
  });

  it("only a turn the rules cannot place goes to the tiebreak", () => {
    expect(classifyChatTurnByRules("the hook on the reels feels tired", null)).toBe("ambiguous");
    expect(classifyChatTurnByRules("do a shorter run,", null)).toBe("ambiguous");
    expect(classifyChatTurnByRules("do the shorter version", null)).toBe("ambiguous");
  });

  it("an edit verb in a description is never an order", () => {
    for (const t of ["Delete button on the ad doesn't work", "Update targeting failed with an error", "Archive keeps erroring on the campaign", "Archive never finishes for the campaign", "Pause option is greyed out on the ad group", "Update the targeting failed with an error", "Rename the campaign failed"]) expect(classifyChatTurnByRules(t, null)).not.toBe("action");
    expect(classifyChatTurnByRules("Change button text on the ad to Shop now", null)).toBe("action");
  });

  it("a bare edit question with no request frame goes to the tiebreak", () => {
    expect(classifyChatTurnByRules("Delete the archived ad?", null)).toBe("ambiguous");
    expect(classifyChatTurnByRules("Rename the campaign to Spring traffic?", null)).toBe("ambiguous");
  });

  it("a tiebreak that times out or fails is an answer", async () => {
    const slow = vi.fn(() => Promise.reject(new Error("chatTurnTiebreak timeout after 1500ms")));
    expect(await resolveChatTurnVerdict({ userText: "the hook on the reels feels tired", prevAssistantText: null, tags, tiebreak: slow })).toBe("answer");
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("the tiebreak decides an ambiguous turn", async () => {
    const act = vi.fn(async () => "action" as const);
    expect(await resolveChatTurnVerdict({ userText: "the hook on the reels feels tired", prevAssistantText: null, tags, tiebreak: act })).toBe("action");
  });
});

describe("continuations inherit the founder turn's verdict", () => {
  const reader = (over: Partial<VerdictReader> = {}): VerdictReader => ({
    run: async () => null,
    message: async (id) => (id === "m-ask" ? { body: "Raise the Meta budget to $80", created_at: "2026-10-21T00:00:00Z", thread_id: "th1", sender_role: "user" } : id === "m-q" ? { body: "why is my CPC high?", created_at: "2026-10-21T00:00:00Z", thread_id: "th1", sender_role: "user" } : null),
    assistantBefore: async () => null,
    ...over,
  });

  it("an approval resume of an order is an action", async () => {
    expect(await inheritedChatTurnVerdict({ originPayload: { thread_id: "th1", user_message_id: "m-ask" }, agent_slug: "meta_ads", thread_id: "th1", reader: reader(), tags, tiebreak: never })).toBe("action");
  });

  it("walks a resume chain back to the founder's message", async () => {
    const r = reader({ run: async (id) => (id === "run-0" ? { agent_slug: "meta_ads", trigger: "chat", payload: { thread_id: "th1", user_message_id: "m-ask" } } : null) });
    expect(await inheritedChatTurnVerdict({ originPayload: { thread_id: "th1", resume_of_run_id: "run-0" }, agent_slug: "meta_ads", thread_id: "th1", reader: r, tags, tiebreak: never })).toBe("action");
  });

  it("follows a clarify continuation (its own message is the fixed reply) back through prior_run_id", async () => {
    const r = reader({
      run: async (id) => (id === "run-ask" ? { agent_slug: "meta_ads", trigger: "chat", payload: { thread_id: "th1", user_message_id: "m-ask" } } : null),
      message: async (id) => (id === "m-ask" ? { body: "Raise the Meta budget to $80", created_at: "2026-10-21T00:00:00Z", thread_id: "th1", sender_role: "user" } : { body: "Answered the clarifying questions.", created_at: "2026-10-21T00:01:00Z", thread_id: "th1", sender_role: "user" }),
    });
    expect(await inheritedChatTurnVerdict({ originPayload: { thread_id: "th1", user_message_id: "m-clarify", prior_run_id: "run-ask" }, agent_slug: "meta_ads", thread_id: "th1", reader: r, tags, tiebreak: never })).toBe("action");
  });

  it("a question's continuation stays an answer, and so does another agent's or thread's chain", async () => {
    expect(await inheritedChatTurnVerdict({ originPayload: { thread_id: "th1", user_message_id: "m-q" }, agent_slug: "meta_ads", thread_id: "th1", reader: reader(), tags, tiebreak: never })).toBe("answer");
    const other = reader({ run: async () => ({ agent_slug: "google_ads", trigger: "chat", payload: { thread_id: "th1", user_message_id: "m-ask" } }) });
    expect(await inheritedChatTurnVerdict({ originPayload: { thread_id: "th1", resume_of_run_id: "run-0" }, agent_slug: "meta_ads", thread_id: "th1", reader: other, tags, tiebreak: never })).toBe("answer");
    expect(await inheritedChatTurnVerdict({ originPayload: { thread_id: "th2", user_message_id: "m-ask" }, agent_slug: "meta_ads", thread_id: "th1", reader: reader(), tags, tiebreak: never })).toBe("answer");
  });

  it("an unreadable chain is an answer", async () => {
    const broken = reader({ message: async () => { throw new Error("db down"); } });
    expect(await inheritedChatTurnVerdict({ originPayload: { thread_id: "th1", user_message_id: "m-ask" }, agent_slug: "meta_ads", thread_id: "th1", reader: broken, tags, tiebreak: never })).toBe("answer");
  });
});

describe("answer turn: the card-filing tools are gone", () => {
  const tools = [
    "meta_ads__account_read",
    "meta_ads__propose_budget_change",
    "outbound__propose_email",
    "growth__propose_creative_brief",
    "social__propose_post",
    "generated_video__animate",
    "google_ads__propose_video_ad",
    "memory__write",
  ].map((name) => ({ name }));

  it("strips every propose tool, the email and brief writers included", () => {
    expect(stripProposeToolsOnRedo(tools, false, true).map((t) => t.name)).toEqual(["meta_ads__account_read", "memory__write"]);
  });

  it("an action turn keeps its full grant", () => {
    expect(stripProposeToolsOnRedo(tools, false, false)).toBe(tools);
  });
});

describe("answer turn: every card sink refuses without a model call or a read", () => {
  it("the channel_actions rail refuses before any stamp read, and reads still resolve", async () => {
    const write = vi.fn(async () => "card-1");
    const readScope = vi.fn();
    const emit = await resolveChannelExecEmit(new Set(["meta_ads"]), { tenant_id: "t1", run_id: "r1", run_trigger: "chat", emit_decision: chatAnswerTurnEmit }, write, readScope);
    expect(emit).toBe(chatAnswerTurnEmit);
    await expect(emit!("meta_ads.budget_change", {})).rejects.toMatchObject({ code: "chat_answer_turn" });
    expect(write).not.toHaveBeenCalled();
    expect(readScope).not.toHaveBeenCalled();
  });

  it("a caller that substitutes its own emitter is refused by the flag", async () => {
    const write = vi.fn(async () => "card-1");
    const emit = await resolveChannelExecEmit(new Set(["seo"]), { tenant_id: "t1", run_id: "r1", run_trigger: "chat", chat_answer_turn: true, emit_decision: async () => "" }, write);
    await expect(emit!("seo.create_pr.v1", {})).rejects.toMatchObject({ code: "chat_answer_turn" });
    expect(write).not.toHaveBeenCalled();
  });

  it("an email informational turn cannot reach the outbound send emit", async () => {
    const res = await callOutboundTool(
      { tenant_id: "t1", emit_decision: chatAnswerTurnEmit, run_id: "r1", agent_slug: "email_marketing", run_trigger: "chat" },
      "propose_email",
      { to: "jo@example.com", subject: "Hello", body_text: "Hi Jo, a quick note about our launch.", rationale: "The founder asked." },
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content)).toMatchObject({ error: "chat_answer_turn" });
  });
});

describe("an edit to a card's email words", () => {
  it.each([
    "Change only the subject of Email 1 to: Welcome to Zavi, start here",
    "Rewrite the second paragraph of email 2",
    "Update the preview text on Email 3",
    "Please change the CTA button to Start now",
  ])("MUST-CATCH: %s is an action, so the propose tool stays", (msg) => {
    expect(classifyChatTurnByRules(msg, null)).toBe("action");
  });

  it.each(["What is the subject of Email 1?", "Why is the open rate low on the welcome email?"])("%s stays an answer", (msg) => {
    expect(classifyChatTurnByRules(msg, null)).not.toBe("action");
  });
});
