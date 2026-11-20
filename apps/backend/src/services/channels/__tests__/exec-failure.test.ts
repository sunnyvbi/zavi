import { describe, expect, it } from "vitest";
import { blockedOnUsNote, classifyExecFailure, execVerdictOf, fixWords, verdictFor } from "../exec-failure";
import { EXEC_FIXTURES, MUTATE_NOT_ALLOWED } from "./exec-failure.fixtures";

describe("classifyExecFailure", () => {
  it.each(EXEC_FIXTURES.map((x) => [x.name, x] as const))("%s", (_n, x) => {
    const got = classifyExecFailure(x.result);
    if (x.bucket === null) expect(got).toBeNull();
    else expect(got).toEqual({ bucket: x.bucket, fix: x.fix, platform_code: x.platform_code });
  });

  it("is pure", () => {
    const r = { error: MUTATE_NOT_ALLOWED };
    const c = JSON.parse(JSON.stringify(r));
    classifyExecFailure(r);
    expect(r).toEqual(c);
  });

  it("never throws on junk", () => {
    for (const junk of [null, undefined, 7, "x", [], [{ error: "x" }], { error: 5, code: 9 }]) {
      expect(classifyExecFailure(junk)).toEqual({ bucket: "temporary", fix: null, platform_code: null });
    }
  });

  it("a code that shadows an Object prototype key is not a verdict", () => {
    expect(classifyExecFailure({ code: "constructor", error: "socket hang up" })?.bucket).toBe("temporary");
    expect(classifyExecFailure({ code: "toString" })?.bucket).toBe("temporary");
  });
});

describe("verdictFor (what the settle facades store)", () => {
  it("a ChatGPT launch Zavi archived closes with its own note, never 'refused'", () => {
    const v = verdictFor({ code: "chatgpt_ads_launch_undone", error: "Zavi created ChatGPT campaign cmpn_1 but could not launch it, so it was archived" }, "chatgpt_ads.create_and_launch");
    expect(v).toMatchObject({ bucket: "blocked_on_us", platform_code: "chatgpt_ads_launch_undone" });
    expect(v?.note).toContain("Zavi archived this campaign");
    expect(v?.note).not.toContain("refused");
    expect(blockedOnUsNote("chatgpt_ads.create_and_launch")).toContain("refused");
  });

  it("a blocked verdict carries the founder-clean note", () => {
    expect(verdictFor({ error: MUTATE_NOT_ALLOWED }, "google_ads.create_campaign")).toEqual({
      bucket: "blocked_on_us",
      fix: null,
      platform_code: "UNKNOWN,MUTATE_NOT_ALLOWED,RESOURCE_NOT_FOUND",
      note: "Google Ads refused this change, so Zavi closed the card. We've been alerted; nothing for you to do.",
    });
    expect(verdictFor({ error: "socket hang up" }, "meta_ads.update_ad_set_budget")).toEqual({ bucket: "temporary", fix: null, platform_code: null, note: null });
    expect(verdictFor({ held_for_founder: true }, "meta_ads.set_status")).toBeNull();
  });
  it("an ad budget refusal is the founder's, with a note that nothing reached the platform", () => {
    expect(verdictFor({ error: "cap_refuse: ad_budget_over_month" }, "meta_ads.update_ad_set_budget_review")).toEqual({
      bucket: "needs_founder",
      fix: "ad_budget",
      platform_code: null,
      note: "Nothing was sent to Meta Ads.",
    });
  });
});

describe("execVerdictOf", () => {
  it("null unless failed; stored verdict wins; legacy rows classified; garbage bucket ignored", () => {
    expect(execVerdictOf("executed", { error: MUTATE_NOT_ALLOWED })).toBeNull();
    expect(execVerdictOf(null, { error: MUTATE_NOT_ALLOWED })).toBeNull();
    expect(execVerdictOf("failed", { bucket: "needs_founder", fix: "billing", platform_code: "X" })).toEqual({ bucket: "needs_founder", fix: "billing", platform_code: "X" });
    expect(execVerdictOf("failed", { bucket: "needs_founder", fix: "bogus", platform_code: 4 })).toEqual({ bucket: "needs_founder", fix: null, platform_code: null });
    expect(execVerdictOf("failed", { error: MUTATE_NOT_ALLOWED })?.bucket).toBe("blocked_on_us");
    expect(execVerdictOf("failed", { bucket: "nope", error: "socket hang up" })?.bucket).toBe("temporary");
    expect(execVerdictOf("failed", null)?.bucket).toBe("temporary");
  });
});

it("fixWords / blockedOnUsNote", () => {
  expect(fixWords("reconnect", "Google Ads")).toBe("reconnect Google Ads in Settings");
  expect(fixWords("permission", "Meta Ads")).toBe("give Zavi's connection access to the Meta Ads account again");
  expect(fixWords("billing", "Google Ads")).toBe("fix billing in Google Ads");
  expect(fixWords("credits", "AI UGC Videos")).toBe("top up your Zavi credits");
  expect(fixWords("plan", "Meta Ads")).toBe("upgrade your Zavi plan");
  expect(fixWords("page_grant", "Meta Ads")).toBe("reconnect Meta Ads in Settings and allow access to your Facebook Page");
  expect(fixWords("page", "Meta Ads")).toBe("add a Facebook Page to your Meta Ads account in Meta Business Settings");
  expect(fixWords("ad_budget", "Meta Ads")).toBe("raise your ad budget on the Growth page, or approve a smaller change");
  expect(fixWords("audience_terms", "Meta Ads")).toBe("accept Meta's Custom Audience terms at https://www.facebook.com/customaudiences/app/tos");
  expect(fixWords(null, "Meta Ads")).toBeNull();
  expect(blockedOnUsNote("generated_video.render.v1")).toBe("AI UGC Videos refused this change, so Zavi closed the card. We've been alerted; nothing for you to do.");
  expect(blockedOnUsNote("meta_ads.set_status")).toMatch(/^Meta Ads refused/);
  expect(blockedOnUsNote("weird")).toMatch(/^These refused/);
});
