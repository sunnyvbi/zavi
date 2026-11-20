import { describe, it, expect } from "vitest";
import {
  verifyActionAndLiveReadClaims,
  actionClaimGuardEnabled,
  removeUnbackedActionClaims,
  isActionClaimSentence,
  isChangeDoneSentence,
  PROPOSAL_LINES,
} from "../claim-grounding-verifier";
import type { ToolCallTrace } from "@/services/tools/types";

function trace(
  name: string,
  output = "{}",
  status: ToolCallTrace["status"] = "ok",
): ToolCallTrace {
  return { name, input_preview: "", output_preview: output, ms: 12, status };
}

describe("verifyActionAndLiveReadClaims — fabricated action grounding", () => {
  describe("FLAGS (fabricated this-turn action claim, no matching tool call)", () => {
    it("flags chief-of-staff 'I just queued in /approvals' with NO propose_dispatch in trace", () => {
      const out = verifyActionAndLiveReadClaims({
        reply:
          "Approve the engineer dispatch I just queued in /approvals — it's ready for your sign-off.",
        toolCalls: [trace("memory__search", '{"hits":[]}')],
      });
      expect(out.flagged).toBe(true);
      expect(out.text).toMatch(/Unverified action claim/i);
      expect(out.text).toMatch(/I just queued in \/approvals/);
      expect(out.flags.action_claim).toBe(true);
      expect(out.flags.matched_action_patterns.length).toBeGreaterThan(0);
    });

    it("flags an action claim ('filed ✓') when the only tool call was a read", () => {
      const out = verifyActionAndLiveReadClaims({
        reply: "Ticket filed ✓ — engineering will pick it up in the next sprint.",
        toolCalls: [trace("github_search_code", '{"results":[]}')],
      });
      expect(out.flagged).toBe(true);
      expect(out.flags.action_claim).toBe(true);
    });

    it("flags \"I've posted it to #ops\" with no slack_post_message call", () => {
      const out = verifyActionAndLiveReadClaims({
        reply: "Done — I've posted it to #ops so the team sees it immediately.",
        toolCalls: [trace("slack_get_channel_history", '{"messages":[]}')],
      });
      expect(out.flagged).toBe(true);
      expect(out.flags.action_claim).toBe(true);
    });
  });

  describe("DOES NOT FLAG (the claim is real, or properly hedged as prior)", () => {
    it("does NOT flag when the matching side-effect tool call IS in the trace", () => {
      const out = verifyActionAndLiveReadClaims({
        reply:
          "Approve the engineer dispatch I just queued in /approvals — it's ready for your sign-off.",
        toolCalls: [trace("propose_dispatch", '{"decision_id":"d_123"}')],
      });
      expect(out.flagged).toBe(false);
      expect(out.text).toMatch(/I just queued in \/approvals/);
    });

    it("does NOT flag a properly-marked prior-turn reference ('earlier I saw X, haven't rechecked')", () => {
      const out = verifyActionAndLiveReadClaims({
        reply:
          "Earlier in this thread I saw the dispatch I queued; I haven't rechecked it this turn, so confirm in /approvals before acting.",
        toolCalls: [],
      });
      expect(out.flagged).toBe(false);
      expect(out.flags.prior_turn_marked).toBe(true);
    });

    it("does NOT flag a future/conditional action ('I will queue', 'I can dispatch')", () => {
      const out = verifyActionAndLiveReadClaims({
        reply:
          "If you approve, I will queue the engineer dispatch and post a summary to #ops.",
        toolCalls: [],
      });
      expect(out.flagged).toBe(false);
      expect(out.flags.action_claim).toBe(false);
    });

    it("does NOT flag ordinary prose with no action claim", () => {
      const out = verifyActionAndLiveReadClaims({
        reply:
          "Here are three options for the budget split. Which one do you want to go with?",
        toolCalls: [],
      });
      expect(out.flagged).toBe(false);
    });

    it("does NOT flag an empty reply", () => {
      const out = verifyActionAndLiveReadClaims({ reply: "", toolCalls: [] });
      expect(out.flagged).toBe(false);
    });

    it("banner is prepended BEFORE the original reply (read order matters)", () => {
      const out = verifyActionAndLiveReadClaims({
        reply: "Ticket filed ✓ for the bug.",
        toolCalls: [],
      });
      const bannerIdx = out.text.indexOf("Unverified action claim");
      const originalIdx = out.text.indexOf("Ticket filed ✓ for the bug.");
      expect(bannerIdx).toBeGreaterThanOrEqual(0);
      expect(originalIdx).toBeGreaterThan(bannerIdx);
    });
  });

  describe("flag is default ON (kill-switch = env 'false')", () => {
    it("actionClaimGuardEnabled defaults to true when env unset", () => {
      const prev = process.env.ACTION_CLAIM_GUARD_ENABLED;
      delete process.env.ACTION_CLAIM_GUARD_ENABLED;
      expect(actionClaimGuardEnabled()).toBe(true);
      if (prev !== undefined) process.env.ACTION_CLAIM_GUARD_ENABLED = prev;
    });

    it("actionClaimGuardEnabled is disabled only when env === 'false'", () => {
      const prev = process.env.ACTION_CLAIM_GUARD_ENABLED;
      process.env.ACTION_CLAIM_GUARD_ENABLED = "false";
      expect(actionClaimGuardEnabled()).toBe(false);
      process.env.ACTION_CLAIM_GUARD_ENABLED = "true";
      expect(actionClaimGuardEnabled()).toBe(true);
      process.env.ACTION_CLAIM_GUARD_ENABLED = "1";
      expect(actionClaimGuardEnabled()).toBe(true);
      if (prev === undefined) delete process.env.ACTION_CLAIM_GUARD_ENABLED;
      else process.env.ACTION_CLAIM_GUARD_ENABLED = prev;
    });
  });
});

describe("verifyActionAndLiveReadClaims — recorded server-side dispatch grounding", () => {
  it("does NOT flag pm 'Dispatched to engineer' when parsed.dispatched_actions is non-empty (no in-trace tool)", () => {
    const out = verifyActionAndLiveReadClaims({
      reply: "## Dispatched — 1 action sent to engineer. I queued the backlog item for build.",
      toolCalls: [trace("memory__search", '{"hits":[]}')],
      dispatchedActions: [{ agent_slug: "engineer", decision_id: "d_1" }],
    });
    expect(out.flagged).toBe(false);
  });

  it("STILL flags chief-of-staff overclaim when dispatched_actions is EMPTY (no regression)", () => {
    const out = verifyActionAndLiveReadClaims({
      reply: "Approve the engineer dispatch I just queued in /approvals — ready for sign-off.",
      toolCalls: [trace("memory__search", '{"hits":[]}')],
      dispatchedActions: [],
    });
    expect(out.flagged).toBe(true);
  });

  it("backward-compatible: omitting dispatchedActions preserves prior behavior (flags unbacked claim)", () => {
    const out = verifyActionAndLiveReadClaims({
      reply: "I just dispatched the work to engineer.",
      toolCalls: [trace("memory__search", '{"hits":[]}')],
    });
    expect(out.flagged).toBe(true);
  });

  describe("status-aware grounding (S4)", () => {
    it("flags 'posted ✅' when the slack post FAILED (status=tool_error)", () => {
      const out = verifyActionAndLiveReadClaims({
        reply: "Done — I posted the recap to #growth ✅",
        toolCalls: [trace("slack__post_message", '{"ok":false}', "tool_error")],
      });
      expect(out.flagged).toBe(true);
      expect(out.flags.action_claim).toBe(true);
    });

    it("does NOT flag when the slack post SUCCEEDED (no over-block of honest success)", () => {
      const out = verifyActionAndLiveReadClaims({
        reply: "Done — I posted the recap to #growth ✅",
        toolCalls: [trace("slack__post_message", '{"ok":true,"ts":"1719"}', "ok")],
      });
      expect(out.flagged).toBe(false);
    });
  });
});

describe("removeUnbackedActionClaims — per-sentence judgement", () => {
  it("a successful slack__upload_file grounds 'I sent the report to Slack'", () => {
    const text = "I sent the report to Slack.";
    const out = removeUnbackedActionClaims({ text, toolCalls: [trace("slack__upload_file")] });
    expect(out).toEqual({ text, removed: 0 });
    expect(removeUnbackedActionClaims({ text, toolCalls: [] }).removed).toBe(1);
  });

  it("a future sentence no longer shields a separate completed claim", () => {
    const out = removeUnbackedActionClaims({
      text: "I sent the email. I'll follow up tomorrow.",
      toolCalls: [],
    });
    expect(out.text).toBe("I'll follow up tomorrow.");
    expect(out.removed).toBe(1);
  });

  it("an explicit 'haven't rechecked' disclaimer still exempts the reply", () => {
    const text = "I sent the email. I haven't rechecked whether it was delivered.";
    expect(removeUnbackedActionClaims({ text, toolCalls: [] })).toEqual({ text, removed: 0 });
  });

  it("single-quoted reported speech stays byte-identical", () => {
    const text = "The customer wrote 'I sent the invoice.'";
    expect(removeUnbackedActionClaims({ text, toolCalls: [] })).toEqual({ text, removed: 0 });
  });

  it("a contraction is not a quote: 'I'll send it' is untouched", () => {
    const text = "I'll send it.";
    expect(removeUnbackedActionClaims({ text, toolCalls: [] })).toEqual({ text, removed: 0 });
  });

  it("a possessive is not a quote: 'I sent the customer's invoice' is still removed", () => {
    const out = removeUnbackedActionClaims({
      text: "The total is $40. I sent the customer's invoice.",
      toolCalls: [],
    });
    expect(out.text).toBe("The total is $40.");
    expect(out.removed).toBe(1);
  });
});

describe("reply-truth pass 3: removal stays conservative", () => {
  it("a sentence mixing quoted speech with an action claim is left alone", () => {
    const text = 'The customer said "I\'ll send the receipt," but I sent the invoice.';
    expect(isActionClaimSentence(text)).toBe(false);
  });

  it("repeated calls give the same answer (no global-regex state)", () => {
    const s = "The customer wrote 'I sent the invoice.'";
    expect(isActionClaimSentence(s)).toBe(false);
    expect(isActionClaimSentence(s)).toBe(false);
    expect(isActionClaimSentence("I sent the invoice.")).toBe(true);
  });
});

describe("reply-truth pass 4: quoted labels do not shield a claim", () => {
  it("a quoted campaign name is not speech: the claim is still detected", () => {
    expect(isActionClaimSentence('I created the campaign named "Fall Launch".')).toBe(true);
  });
  it("attributed speech with a colon is left alone", () => {
    expect(isActionClaimSentence('The log shows: "I sent the invoice."')).toBe(false);
  });
});

describe("removeUnbackedActionClaims — a proposal is not a change", () => {
  const approvalCard = trace(
    "meta_ads__propose_budget_change",
    JSON.stringify({ decision_id: "d1", decision_class: "meta_ads.update_ad_set_budget_review", within_cap: false }),
  );
  const autoBudget = trace(
    "meta_ads__propose_budget_change",
    JSON.stringify({ decision_id: "d4", decision_class: "meta_ads.update_ad_set_budget", within_cap: true }),
  );

  it("swaps 'I raised it' after a proposal that waits for approval", () => {
    const text = "Weekend promo is your cheapest ad set. I raised its budget from $120 to $144 a day. Check it tomorrow.";
    const out = removeUnbackedActionClaims({ text, toolCalls: [trace("growth__get_metric"), approvalCard] });
    expect(out.removed).toBe(1);
    expect(out.text).toBe(`Weekend promo is your cheapest ad set. ${PROPOSAL_LINES.approval} Check it tomorrow.`);
  });

  it("says it applies on its own when the tool said so", () => {
    for (const t of [
      trace("meta_ads__propose_status_change", JSON.stringify({ decision_id: "d2", will_auto_apply: true })),
      autoBudget,
      trace("reddit_ads_propose_launch", JSON.stringify({ action_id: "a1", approval_required: false, execution_state: "queued" })),
    ]) {
      const r = removeUnbackedActionClaims({ text: "I'm pausing Lead form test now.", toolCalls: [t] });
      expect(r.text).toBe(PROPOSAL_LINES.auto);
    }
  });

  it("one line for several change claims", () => {
    const text = "I raised Weekend promo to $144. I also paused Lead form test.";
    const out = removeUnbackedActionClaims({ text, toolCalls: [approvalCard] });
    expect(out.text).toBe(PROPOSAL_LINES.approval);
  });

  it("leaves what a proposal really did, and plans or questions", () => {
    const text =
      "I sent the raise to you for approval. I submitted the card. I'll raise it once you approve. Should I pause Lead form test? I put together a plan.";
    expect(removeUnbackedActionClaims({ text, toolCalls: [approvalCard] })).toEqual({ text, removed: 0 });
  });

  it("a real change tool still backs the claim", () => {
    const text = "I raised its budget to $144.";
    const out = removeUnbackedActionClaims({ text, toolCalls: [approvalCard, trace("meta_ads__update_ad_set_budget")] });
    expect(out).toEqual({ text, removed: 0 });
  });

  it("'I'm raising' with no tool at all is removed like any unbacked claim", () => {
    const out = removeUnbackedActionClaims({ text: "Good news. I'm raising Weekend promo to $144 a day.", toolCalls: [trace("growth__get_metric")] });
    expect(out.text).toBe("Good news.");
  });

  it("a within-cap change the router still sent to review waits for approval", () => {
    const unsure = trace("meta_ads__propose_budget_change", JSON.stringify({ decision_id: "d5", decision_class: "meta_ads.update_ad_set_budget_review", within_cap: true, agent_unsure: true }));
    expect(removeUnbackedActionClaims({ text: "I raised it to $144.", toolCalls: [unsure] }).text).toBe(PROPOSAL_LINES.approval);
  });

  it("one proposal waiting for the founder makes the line 'for approval'", () => {
    expect(removeUnbackedActionClaims({ text: "I raised it and paused the other one.", toolCalls: [autoBudget, approvalCard] }).text).toBe(PROPOSAL_LINES.approval);
  });

  it("a dry run or refused proposal filed nothing: the claim just goes", () => {
    const dry = trace("meta_ads__propose_budget_change", JSON.stringify({ dry_run: true, simulation: {} }));
    expect(removeUnbackedActionClaims({ text: "Good read. I raised it to $144.", toolCalls: [dry] }).text).toBe("Good read.");
    expect(removeUnbackedActionClaims({ text: "I raised it to $144.", toolCalls: [dry] }).text).toBe("No changes were made.");
    const draft = trace("praxis__propose_custom_agent", JSON.stringify({ draft: {}, created: false }));
    expect(removeUnbackedActionClaims({ text: "Here is the draft. I created your weekly agent.", toolCalls: [draft] }).text).toBe("Here is the draft.");
  });

  it("reads the stored preview, which is JSON-encoded twice", () => {
    const stored = (v: unknown) => JSON.stringify(JSON.stringify(v));
    const review = trace("meta_ads__propose_budget_change", stored({ decision_id: "d1", decision_class: "meta_ads.update_ad_set_budget_review" }));
    expect(removeUnbackedActionClaims({ text: "I raised it to $144.", toolCalls: [review] }).text).toBe(PROPOSAL_LINES.approval);
    const auto = trace("meta_ads__propose_budget_change", stored({ decision_id: "d2", decision_class: "meta_ads.update_ad_set_budget" }));
    expect(removeUnbackedActionClaims({ text: "I raised it to $144.", toolCalls: [auto] }).text).toBe(PROPOSAL_LINES.auto);
  });

  describe("the card's real state (ad-card-receipt) outranks the tool's words", () => {
    const card = (card_status: string, extra: Record<string, unknown> = {}) =>
      trace("google_ads__propose_new_campaign", JSON.stringify({ card_status, receipt: "r", decision_id: "d9", will_auto_apply: false, ...extra }));

    it("example 2: a create Autopilot approved and ran keeps 'I launched it'", () => {
      const text = "I launched the new search campaign at $20 a day.";
      expect(removeUnbackedActionClaims({ text, toolCalls: [card("carried_out")] })).toEqual({ text, removed: 0 });
    });

    it("a direct ask still launching says Zavi will post the result, never 'approved and still being set up'", () => {
      const text = removeUnbackedActionClaims({ text: "I'm launching your $25 ChatGPT ad now.", toolCalls: [card("direct_ask_launching")] }).text;
      expect(text).toBe(PROPOSAL_LINES.directAsk);
      expect(text).not.toContain("approved");
    });

    it("a direct ask still launching is not shielded by an unrelated shipped side effect (Codex F3)", () => {
      const text = removeUnbackedActionClaims({ text: "I launched your ChatGPT ad.", toolCalls: [card("direct_ask_launching")], sideEffectKind: "shipped" }).text;
      expect(text).toBe(PROPOSAL_LINES.directAsk);
    });

    it("a direct ask still launching: a status in any person goes too (Grok F4)", () => {
      const text = removeUnbackedActionClaims({ text: "Your $25 ChatGPT ad was approved and is still being set up. It targets the US.", toolCalls: [card("direct_ask_launching")] }).text;
      expect(text).toBe(`${PROPOSAL_LINES.directAsk} It targets the US.`);
    });

    it("a status sentence about something other than the ad is left alone (Codex fix-delta)", () => {
      const r = removeUnbackedActionClaims({ text: "Your website is live. I'm launching the ad.", toolCalls: [card("direct_ask_launching")] });
      expect(r.text).toBe(`Your website is live. ${PROPOSAL_LINES.directAsk}`);
    });

    it("a dry run beside a direct ask is not 'another card' (Codex fix-delta)", () => {
      const dry = trace("meta_ads__propose_new_ad_set", JSON.stringify({ dry_run: true, would_propose: true }));
      const text = removeUnbackedActionClaims({ text: "I launched it.", toolCalls: [card("direct_ask_launching"), dry] }).text;
      expect(text).toBe(PROPOSAL_LINES.directAsk);
    });

    it("a direct ask beside a card waiting for approval gets its own line, not the other card's (Codex F5)", () => {
      const waiting = trace("meta_ads__propose_new_ad_set", JSON.stringify({ card_status: "waiting_for_approval", decision_id: "d8" }));
      const text = removeUnbackedActionClaims({ text: "I launched both.", toolCalls: [card("direct_ask_launching"), waiting] }).text;
      expect(text).toBe(PROPOSAL_LINES.directAskMixed);
    });

    it("approved but still being set up says so, never 'sent for approval' and never 'live'", () => {
      expect(removeUnbackedActionClaims({ text: "I launched it.", toolCalls: [card("approved_by_autopilot")] }).text).toBe(PROPOSAL_LINES.inProgress);
    });

    it("one card that ran does not back a claim about another that waits", () => {
      const waiting = trace("meta_ads__propose_new_ad_set", JSON.stringify({ card_status: "waiting_for_approval", decision_id: "d8" }));
      expect(removeUnbackedActionClaims({ text: "I launched both.", toolCalls: [card("carried_out"), waiting] }).text).toBe(PROPOSAL_LINES.mixed);
    });

    it("F4: a card that ran beside a dry run does not back 'launched both'", () => {
      const dry = trace("meta_ads__propose_new_ad_set", JSON.stringify({ dry_run: true, simulation: {} }));
      expect(removeUnbackedActionClaims({ text: "I launched both.", toolCalls: [card("carried_out"), dry] }).text).toBe(PROPOSAL_LINES.mixed);
    });

    it("a create that ran but was never switched on, a partial run and a closed card each say so", () => {
      expect(removeUnbackedActionClaims({ text: "I launched it.", toolCalls: [card("created_not_live")] }).text).toBe(PROPOSAL_LINES.created);
      expect(removeUnbackedActionClaims({ text: "I launched it.", toolCalls: [card("uncertain")] }).text).toBe(PROPOSAL_LINES.uncertain);
      expect(removeUnbackedActionClaims({ text: "I launched it.", toolCalls: [card("closed")] }).text).toBe(PROPOSAL_LINES.closed);
    });

    it("must not: a card that truly waits still says it was sent for approval, whatever the tool claimed", () => {
      expect(removeUnbackedActionClaims({ text: "I launched it.", toolCalls: [card("waiting_for_approval", { will_auto_apply: true })] }).text).toBe(PROPOSAL_LINES.approval);
    });

    it("a card that failed never reads as done", () => {
      expect(removeUnbackedActionClaims({ text: "I launched it.", toolCalls: [card("failed")] }).text).toBe(PROPOSAL_LINES.failed);
    });
  });

  it("a later promise in the same sentence does not shield the claim", () => {
    const out = removeUnbackedActionClaims({ text: "I'm raising the budget now, but I'll check results tomorrow.", toolCalls: [approvalCard] });
    expect(out.text).toBe(PROPOSAL_LINES.approval);
  });

  it("someone else's words after a colon are not the agent's claim", () => {
    expect(isChangeDoneSentence("She said: I raised the budget yesterday.")).toBe(false);
  });

  it("a promise in another clause does not shield a change claim", () => {
    const out = removeUnbackedActionClaims({ text: "I'll check it tomorrow, and I'm raising the budget now.", toolCalls: [approvalCard] });
    expect(out.text).toBe(PROPOSAL_LINES.approval);
  });

  it("'I'm putting together a plan' is not an action claim", () => {
    const text = "I'm putting together a plan for your launch.";
    expect(removeUnbackedActionClaims({ text, toolCalls: [] })).toEqual({ text, removed: 0 });
    expect(isActionClaimSentence(text)).toBe(false);
  });

  it("isChangeDoneSentence: someone else's change, quotes and idioms are not claims", () => {
    expect(isChangeDoneSentence("You raised it to $144 yesterday.")).toBe(false);
    expect(isChangeDoneSentence('The card says "I raised it".')).toBe(false);
    expect(isChangeDoneSentence("I set up the tracking plan.")).toBe(false);
    expect(isChangeDoneSentence("I've paused Reddit Ads.")).toBe(true);
  });
});

describe("removeUnbackedActionClaims — unbacked status sentences", () => {
  const disabled = "Heads up: your Google Ads account is flagged as disabled.";
  const scheduled = "Good news. A test was set to start Nov 1.";

  it("removes an account status no tool in the run returned", () => {
    const out = removeUnbackedActionClaims({
      text: `${disabled} Spend last week was $420.`,
      toolCalls: [trace("memory__search", '{"hits":["account disabled"]}'), trace("google_ads__get_campaigns", '{"status":"ENABLED"}')],
    });
    expect(out.text).toBe("Spend last week was $420.");
    expect(out.removed).toBe(1);
  });

  it("removes a scheduled start nothing scheduled, and drops the emptied paragraph", () => {
    const out = removeUnbackedActionClaims({
      text: `Here is the plan.\n\n${scheduled}\n\nNext, pick a budget.`,
      toolCalls: [trace("growth__get_metric", '{"value":12}')],
    });
    expect(out.text).toBe("Here is the plan.\n\nGood news.\n\nNext, pick a budget.");
    const solo = removeUnbackedActionClaims({ text: "Intro.\n\nThe test is scheduled for Nov 1.\n\nOutro.", toolCalls: [] });
    expect(solo.text).toBe("Intro.\n\nOutro.");
  });

  it("keeps the status when a live tool result reports it", () => {
    const text = `${disabled} Spend last week was $420.`;
    const out = removeUnbackedActionClaims({
      text,
      toolCalls: [trace("google_ads__get_account", '{"customer":{"status":"DISABLED"}}')],
    });
    expect(out).toEqual({ text, removed: 0 });
    const sched = removeUnbackedActionClaims({
      text: scheduled,
      toolCalls: [trace("meta_ads__get_campaign", '{"start_time":"2026-11-01T00:00:00Z"}')],
    });
    expect(sched).toEqual({ text: scheduled, removed: 0 });
  });

  it("leaves conditional and question phrasing alone", () => {
    for (const text of [
      "If the account is disabled, appeal it from the billing page.",
      "Is the account flagged as disabled?",
      "Once you approve, the campaign will launch on Monday.",
    ]) {
      expect(removeUnbackedActionClaims({ text, toolCalls: [] })).toEqual({ text, removed: 0 });
    }
  });

  it("drops the absence banner the removed sentence raised", () => {
    const banner = "> ⚠️ **May be out of date** — this reply mentions something.\n> Treat the absence as **unconfirmed**.\n\n";
    const out = removeUnbackedActionClaims({ text: `${banner}Your ad account was suspended. Spend was $40.`, toolCalls: [] });
    expect(out.text).toBe("Spend was $40.");
  });

  it("first-person action claims behave as before", () => {
    expect(removeUnbackedActionClaims({ text: "Done. I scheduled the post.", toolCalls: [] }).text).toBe("Done.");
    const text = "Done. I scheduled the post.";
    expect(removeUnbackedActionClaims({ text, toolCalls: [trace("buffer__schedule_post")] })).toEqual({ text, removed: 0 });
  });
});

describe("removeUnbackedActionClaims — status review fixes", () => {
  it("an unrelated write does not back a scheduled start; a scheduling write does", () => {
    const text = "Posted. The experiment is scheduled to start Monday.";
    expect(removeUnbackedActionClaims({ text, toolCalls: [trace("slack__post_message")] }).text).toBe("Posted.");
    expect(removeUnbackedActionClaims({ text, toolCalls: [trace("buffer__schedule_post")] })).toEqual({ text, removed: 0 });
    expect(removeUnbackedActionClaims({ text, toolCalls: [], sideEffectKind: "shipped" }).text).toBe("Posted.");
    const search: ToolCallTrace = { ...trace("slack__search_messages", '{"messages":[]}'), input_preview: '{"query":"schedule"}' };
    expect(removeUnbackedActionClaims({ text, toolCalls: [search] }).text).toBe("Posted.");
  });

  it("catches simple-present starts with a date and leaves non-account 'marked as' alone", () => {
    expect(removeUnbackedActionClaims({ text: "Hi. The campaign starts Monday.", toolCalls: [] }).text).toBe("Hi.");
    const text = "The legacy report is marked as inactive.";
    expect(removeUnbackedActionClaims({ text, toolCalls: [] })).toEqual({ text, removed: 0 });
  });
});

describe("removeUnbackedActionClaims — status second review", () => {
  const sched = "Good news. A test was set to start Nov 1.";
  it("a null or long-past schedule field does not back a scheduled start", () => {
    for (const out of ['{"campaigns":[{"start_time":null}]}', '{"posts":[{"scheduled_at":"2023-01-05T00:00:00Z"}]}']) {
      expect(removeUnbackedActionClaims({ text: sched, toolCalls: [trace("google_ads__list_campaigns", out)] }).text).toBe("Good news.");
    }
    expect(removeUnbackedActionClaims({ text: sched, toolCalls: [], parsed: { dispatched_actions: [{ agent: "pm" }] } }).text).toBe("Good news.");
  });

  it("advice that is not a start date is left alone", () => {
    for (const text of [
      "The promo is due for a creative refresh.",
      "Your ads are set to run on Advantage+.",
      "The campaign starts decreasing bids after day 3.",
      "The email sequence begins marketing to new leads.",
    ]) {
      expect(removeUnbackedActionClaims({ text, toolCalls: [] })).toEqual({ text, removed: 0 });
    }
    expect(removeUnbackedActionClaims({ text: "Hi. The post is scheduled for next Monday.", toolCalls: [] }).text).toBe("Hi.");
  });

  it("platform status codes back the state word", () => {
    const text = "Your ad account is flagged as disabled.";
    expect(removeUnbackedActionClaims({ text, toolCalls: [trace("meta_ads__account_read", '{"ad_accounts":[{"id":"act_1","account_status":2}]}')] })).toEqual({ text, removed: 0 });
    expect(removeUnbackedActionClaims({ text, toolCalls: [trace("google_ads__get_account", '{"status":"SUSPENDED"}')] })).toEqual({ text, removed: 0 });
    expect(removeUnbackedActionClaims({ text, toolCalls: [trace("meta_ads__account_read", '{"ad_accounts":[{"account_status":1}]}')] }).text).not.toContain("disabled");
  });

  it("a modal in another clause does not exempt the claim", () => {
    const out = removeUnbackedActionClaims({ text: "Spend was $40. Your Google Ads account is flagged as disabled, which would block spend.", toolCalls: [] });
    expect(out.text).toBe("Spend was $40.");
    const seen = removeUnbackedActionClaims({ text: "Spend was $40. I can see your Google Ads account is flagged as disabled.", toolCalls: [] });
    expect(seen.text).toBe("Spend was $40.");
    const hedged = "Your account could be flagged as disabled.";
    expect(removeUnbackedActionClaims({ text: hedged, toolCalls: [] })).toEqual({ text: hedged, removed: 0 });
  });
});

describe("removeUnbackedActionClaims — status Grok delta", () => {
  it("unix and older-but-real schedule values back the sentence", () => {
    const text = "The campaign is scheduled to start Nov 1.";
    const nov = Math.floor(Date.now() / 1000) + 86_400;
    expect(removeUnbackedActionClaims({ text, toolCalls: [trace("chatgpt_ads__read_performance", `{"start_time":${nov}}`)] })).toEqual({ text, removed: 0 });
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const sep = "The campaign was set to start Sep 10.";
    expect(removeUnbackedActionClaims({ text: sep, toolCalls: [trace("google_ads__list_campaigns", `{"start_time":"${old}"}`)] })).toEqual({ text: sep, removed: 0 });
  });

  it("'the 2nd phase' is not a date, and an offer is not a claim", () => {
    for (const text of ["The experiment begins the 2nd phase of the test.", "I can make sure the post is scheduled for Monday."]) {
      expect(removeUnbackedActionClaims({ text, toolCalls: [] })).toEqual({ text, removed: 0 });
    }
    expect(removeUnbackedActionClaims({ text: "Hi. The post goes live on the 2nd of November.", toolCalls: [] }).text).toBe("Hi.");
  });
});

describe("removeUnbackedActionClaims — status Grok delta 2", () => {
  it("an offer hedges only its own clause; 'the 2nd at 9am' is a date", () => {
    expect(removeUnbackedActionClaims({ text: "Spend was $40. Your Google Ads account is flagged as disabled, so I can draft the appeal.", toolCalls: [] }).text).toBe("Spend was $40.");
    expect(removeUnbackedActionClaims({ text: "Spend was $40. I can also see your Google Ads account is flagged as disabled.", toolCalls: [] }).text).toBe("Spend was $40.");
    expect(removeUnbackedActionClaims({ text: "Hi. The post goes live on the 2nd at 9am.", toolCalls: [] }).text).toBe("Hi.");
  });
});

describe("removeUnbackedActionClaims — offers and inabilities", () => {
  it("an offer or inability before the status covers it", () => {
    for (const text of [
      "I can make sure the creative is approved, so the post is scheduled for Monday.",
      "I can submit it today, then the campaign will launch on Monday.",
      "I can't make sure the post is scheduled for Monday.",
      "I can't confirm the campaign is scheduled for Monday, so pick a date.",
      "I cannot confirm your Google Ads account is flagged as disabled.",
      "I can submit it today but not tomorrow, so the campaign will launch on Monday.",
      "I couldn't see the post is scheduled for Monday.",
      "I'm unable to confirm the campaign is scheduled for Monday.",
    ]) {
      expect(removeUnbackedActionClaims({ text, toolCalls: [] })).toEqual({ text, removed: 0 });
    }
  });

  it("a report, a later offer, or a 'because' status is still checked", () => {
    for (const text of [
      "I can draft an appeal because your Google Ads account is disabled.",
      "I can draft the appeal, but your Google Ads account is disabled.",
      "I can draft an appeal, and your Google Ads account is disabled.",
      "I can draft the appeal; your Google Ads account is flagged as disabled.",
      "I can confirm your Google Ads account is flagged as disabled.",
      "I can see your Google Ads account is flagged as disabled.",
      "Your Google Ads account is flagged as disabled, so I can draft the appeal.",
    ]) {
      expect(removeUnbackedActionClaims({ text: `Spend was $40. ${text}`, toolCalls: [] }).text).toBe("Spend was $40.");
    }
  });
});
