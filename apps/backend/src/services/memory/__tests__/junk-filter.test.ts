import { describe, it, expect } from "vitest";
import {
  junkReasonForText,
  junkReasonForCandidate,
  junkReasonForRunOutput,
  isRawJson,
} from "../junk-filter";

describe("junk filter: whole run outputs (before the extractor)", () => {
  it("skips an output that is an envelope or a JSON blob end to end", () => {
    expect(junkReasonForRunOutput('<goal_moves> {"move":"x"}')).toBe("tagged_envelope");
    expect(junkReasonForRunOutput('{"status":"done","items":[1,2]}')).toBe("raw_json");
  });

  it("keeps a prose report that merely quotes a field or a role line", () => {
    const report =
      'Paused two ad sets. Dispatched {"agent_slug":"meta-ads"} with the new cap.\n' +
      "**cgo (assistant)**: plan\n**meta-ads (agent)**: done\nTake rate is 15%.";
    expect(junkReasonForRunOutput(report)).toBeNull();
  });
});

describe("junk filter: whole-text classes", () => {
  it("flags a tagged agent envelope", () => {
    expect(junkReasonForText('<goal_moves> {"move":"raise budget","by":20}')).toBe("tagged_envelope");
    expect(junkReasonForText("<untrusted_agent_output>\nhello\n</untrusted_agent_output>")).toBe(
      "tagged_envelope",
    );
  });

  it("flags raw JSON, fenced or not, and near-JSON with several quoted keys", () => {
    expect(junkReasonForText('{"goal":"x","status":"ok"}')).toBe("raw_json");
    expect(junkReasonForText('```json\n[{"a":1}]\n```')).toBe("raw_json");
    expect(isRawJson('{"a": 1, "b": 2, "c": 3,')).toBe(true);
  });

  it("flags the retired task-card shape and role-prefixed transcripts", () => {
    expect(junkReasonForText("Task — cgo: reviewed meta ads and paused two ad sets")).toBe(
      "agent_transcript",
    );
    expect(
      junkReasonForText("**cgo (assistant)**: go\n**meta-ads (agent)**: done\nok"),
    ).toBe("agent_transcript");
    expect(junkReasonForText('dispatching {"agent_slug":"engineer","run_id":"x"}')).toBe(
      "agent_transcript",
    );
  });

  it("leaves ordinary business prose alone", () => {
    for (const t of [
      "Our take rate is 15% on every booking.",
      "We never refund disputes under $20.",
      "The Meta pixel ID is 1234567890.",
      "We run a weekly promo every Friday.",
      "Primary geo: California Bay Area. Vendor: SendGrid.",
    ]) {
      expect(junkReasonForText(t), t).toBeNull();
    }
  });
});

describe("junk filter: candidate facts", () => {
  it("flags one-run states", () => {
    expect(
      junkReasonForCandidate({
        title: "Stripe unreachable",
        body: "The agent could not access Stripe in this run.",
      }),
    ).toBe("one_run_state");
    expect(
      junkReasonForCandidate({ title: "Status", body: "During the current session the export failed." }),
    ).toBe("one_run_state");
  });

  it("checks the title too", () => {
    expect(junkReasonForCandidate({ title: "Task — pm: roadmap", body: "Roadmap reviewed." })).toBe(
      "agent_transcript",
    );
  });

  it("flags a candidate that narrates the agent or the memory instead of stating a fact", () => {
    for (const body of [
      "The agent said it saw no record of a LinkedIn campaign launching or delivering, but explicitly did not confirm this.",
      "Saved memory already holds the verified zero-delivery state with 16 draft campaigns.",
      "The assistant didn’t check the Stripe balance.",
      "The reply noted that the pixel was missing.",
      "Memory already has the take rate.",
    ]) {
      expect(junkReasonForCandidate({ title: "LinkedIn Ads", body }), body).toBe("meta_narration");
    }
    expect(junkReasonForCandidate({ title: "The agent said that LinkedIn stalled", body: "Zero delivery." })).toBe("meta_narration");
  });

  it("flags a candidate whose subject is the run, the reply or the read, or that only agrees with saved memory", () => {
    for (const body of [
      "The run mentioned draft campaigns including a $200/day 'test1' draft, which is consistent with the saved state of 16 draft campaigns and zero delivery.",
      "The run mentioned draft campaigns including a $200/day 'test1' draft.",
      "The reply says LinkedIn has 16 drafts.",
      "That run found 16 draft campaigns.",
      "The previous run reported zero impressions.",
      "The agent's read showed 0 clicks.",
      "The channel run surfaced a $200/day draft.",
      "LinkedIn has 16 draft campaigns, consistent with the saved state.",
      "Zero delivery, which matches what is saved.",
      "16 draft campaigns, as already saved.",
      "Spend is $0, in line with the stored value.",
    ]) {
      expect(junkReasonForCandidate({ title: "LinkedIn Ads", body }), body).toBe("meta_narration");
    }
  });

  it("keeps facts that merely mention agents, models, replies or memory", () => {
    for (const body of [
      "LinkedIn Ads has 16 draft campaigns and none has delivered an impression yet.",
      "Our support agent handles refunds within two days.",
      "The Model 3 is our best-selling rental.",
      "Reply rate on cold email is 4%.",
      "We sell memory foam mattresses.",
      "Existing memory foam stock is 200 units.",
      "We resell stored memory cards to camera shops.",
      "The base model's memory has 8GB.",
      "Device memory holds 128GB.",
      "The agent reports directly to the broker.",
      "The model sees peak demand in Q4.",
      "The agent notes every lead in HubSpot.",
      "The model states 5-seat capacity.",
      'The only LinkedIn ad account the connection can access is "Developer\'s Ad Account" (ID 559880687, USD, ACTIVE).',
      "The run club meets every Saturday.",
      "Our test run mentioned in the board deck cost $5k.",
      "The test run mentioned in the board deck cost $5k.",
      "The product is consistent with SOC 2 controls.",
      "The read rate on our newsletter is 42%.",
      "The reply rate shows a 4% lift after the subject change.",
      "The response time is under two hours.",
      "The response shows strong demand from CFOs.",
      "The latest read shows CPL $40.",
      "That response confirms buyers want annual billing.",
      "Pricing is consistent with the saved-search tier on our marketplace.",
      "Our cart matches what shoppers expect at checkout.",
      "LinkedIn Ads has 16 draft campaigns, including a $200/day test1 draft.",
    ]) {
      expect(junkReasonForCandidate({ title: "Fact", body }), body).toBeNull();
    }
  });

  it("keeps a durable fact", () => {
    expect(
      junkReasonForCandidate({ title: "Take rate", body: "Current take rate is 15% of booking value." }),
    ).toBeNull();
  });
});
