import { describe, it, expect } from "vitest";
import {
  classifyFundraisingChatMode,
  classifyFundraisingStage,
  classifyFundraisingAdviceTopic,
} from "../classify";
import {
  ADVISE_READINESS_PROMPT,
  ADVISE_ROUND_DESIGN_PROMPT,
} from "../../../services/fundraising/raise-resolver";

describe("classifyFundraisingChatMode", () => {
  it("defaults to source for a sourcing ask", () => {
    expect(classifyFundraisingChatMode("find seed investors for my company")).toBe("source");
    expect(classifyFundraisingChatMode("build me a list of angels")).toBe("source");
  });

  it("returns strategy for an outreach-plan ask", () => {
    expect(classifyFundraisingChatMode("prepare the outreach plan")).toBe("strategy");
    expect(classifyFundraisingChatMode("draft the cold emails for these investors")).toBe("strategy");
    expect(classifyFundraisingChatMode("write the emails and get ready to send")).toBe("strategy");
    expect(classifyFundraisingChatMode("create copy variants per channel")).toBe("strategy");
    expect(classifyFundraisingChatMode("draft a linkedin DM for each")).toBe("strategy");
    expect(classifyFundraisingChatMode("set up the follow-up sequence")).toBe("strategy");
  });

  it("returns advise for a judgment ask (Slice 3)", () => {
    expect(classifyFundraisingChatMode("am I ready to raise?")).toBe("advise");
    expect(classifyFundraisingChatMode("how much should I raise?")).toBe("advise");
    expect(classifyFundraisingChatMode("prep me for the Uncork call")).toBe("advise");
    expect(classifyFundraisingChatMode("they sent a lowball term sheet, what do I say?")).toBe("advise");
  });

  it("keeps source / strategy asks OUT of advise (no regression)", () => {
    expect(classifyFundraisingChatMode("who should I raise from?")).toBe("source");
    expect(classifyFundraisingChatMode("find seed investors for my company")).toBe("source");
    expect(classifyFundraisingChatMode("prepare the outreach plan")).toBe("strategy");
  });

  it("falls back to source on empty / ambiguous input", () => {
    expect(classifyFundraisingChatMode("")).toBe("source");
    expect(classifyFundraisingChatMode("thanks!")).toBe("source");
  });
});

describe("classifyFundraisingAdviceTopic", () => {
  it("resolves round_design (checked before readiness so 'should I raise' loses)", () => {
    expect(classifyFundraisingAdviceTopic("how much should I raise?")).toBe("round_design");
    expect(classifyFundraisingAdviceTopic("help me with round design")).toBe("round_design");
    expect(classifyFundraisingAdviceTopic("what round size makes sense?")).toBe("round_design");
  });

  it("resolves readiness", () => {
    expect(classifyFundraisingAdviceTopic("am I ready to raise?")).toBe("readiness");
    expect(classifyFundraisingAdviceTopic("run my raise readiness")).toBe("readiness");
    expect(classifyFundraisingAdviceTopic("should I raise now?")).toBe("readiness");
  });

  it("resolves meeting_prep", () => {
    expect(classifyFundraisingAdviceTopic("prep me for the Uncork call")).toBe("meeting_prep");
    expect(classifyFundraisingAdviceTopic("meeting prep for tomorrow")).toBe("meeting_prep");
  });

  it("resolves objection", () => {
    expect(classifyFundraisingAdviceTopic("they want exclusivity")).toBe("objection");
    expect(classifyFundraisingAdviceTopic("how do I answer a lowball term sheet?")).toBe("objection");
  });

  it("returns undefined for a non-advise ask", () => {
    expect(classifyFundraisingAdviceTopic("find seed investors")).toBeUndefined();
    expect(classifyFundraisingAdviceTopic("prepare the outreach plan")).toBeUndefined();
    expect(classifyFundraisingAdviceTopic("")).toBeUndefined();
  });
});

describe("classifyFundraisingStage", () => {
  it("reads the explicit structured-stage marker the dashboard emits", () => {
    expect(
      classifyFundraisingStage(
        'Treat this as a Pre-seed round and set the structured stage field to "Pre-seed".',
      ),
    ).toBe("Pre-seed");
    expect(
      classifyFundraisingStage('set the structured stage field to "Series B+".'),
    ).toBe("Series B+");
  });

  it("resolves each rung from prose, most-specific first", () => {
    expect(classifyFundraisingStage("raising an angel round")).toBe("Angel");
    expect(classifyFundraisingStage("this is a pre-seed raise")).toBe("Pre-seed");
    expect(classifyFundraisingStage("we're raising a seed round")).toBe("Seed");
    expect(classifyFundraisingStage("targeting series a funds")).toBe("Series A");
    expect(classifyFundraisingStage("series b investors please")).toBe("Series B+");
  });

  it("does not let 'pre-seed' collapse into the bare 'seed' branch", () => {
    expect(classifyFundraisingStage("find me pre-seed investors")).toBe("Pre-seed");
  });

  it("returns undefined when no stage is named", () => {
    expect(classifyFundraisingStage("")).toBeUndefined();
    expect(classifyFundraisingStage("find investors for my company")).toBeUndefined();
  });
});

describe("Raise Room banner prompts close their advise loop", () => {
  it("routes the readiness prompt to the readiness topic", () => {
    expect(classifyFundraisingAdviceTopic(ADVISE_READINESS_PROMPT)).toBe(
      "readiness",
    );
  });

  it("routes the round-design prompt to the round_design topic", () => {
    expect(classifyFundraisingAdviceTopic(ADVISE_ROUND_DESIGN_PROMPT)).toBe(
      "round_design",
    );
  });
});
