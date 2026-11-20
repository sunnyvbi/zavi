
import { describe, it, expect } from "vitest";
import {
  REDO_ALLOWED_DECISION_CLASS,
  redoRefusesClass,
  runCarriesRedo,
  stripProposeToolsOnRedo,
} from "@/services/agents/redo-mode";

const tools = (...names: string[]) => names.map((name) => ({ name }));

const REDO_PAYLOAD = {
  channel_slug: "seo",
  router: [{ id: "indexability" }],
  redo: {
    action_key: "794fbd95694815b5",
    action_title: "Add an H1 to the homepage",
    note: "we are a marketplace, not a SaaS",
  },
};

describe("runCarriesRedo", () => {
  it("is true for the payload the engine actually builds", () => {
    expect(runCarriesRedo(REDO_PAYLOAD)).toBe(true);
  });

  it("is false for a normal channel run", () => {
    expect(runCarriesRedo({ channel_slug: "seo", router: [] })).toBe(false);
  });

  it("is false for junk rather than throwing", () => {
    expect(runCarriesRedo(null)).toBe(false);
    expect(runCarriesRedo(undefined)).toBe(false);
    expect(runCarriesRedo("redo")).toBe(false);
    expect(runCarriesRedo({ redo: "yes" })).toBe(false);
    expect(runCarriesRedo({ redo: null })).toBe(false);
  });
});

describe("stripProposeToolsOnRedo — layer 1", () => {
  it("takes the Google Ads money proposals away from a redo", () => {
    const out = stripProposeToolsOnRedo(
      tools(
        "google_ads__list_campaigns",
        "google_ads__propose_budget_change",
        "google_ads__propose_removal",
        "google_ads__propose_keywords",
      ),
      true,
    );
    expect(out.map((t) => t.name)).toEqual(["google_ads__list_campaigns"]);
  });

  it("covers the YouTube tools, which live on the google_ads server", () => {
    const out = stripProposeToolsOnRedo(
      tools("google_ads__propose_video_ad", "google_ads__propose_video_campaign"),
      true,
    );
    expect(out.map((t) => t.name)).toEqual(["google_ads__propose_video_ad"]);
  });

  it("covers Meta, so switching that channel later does not reopen this", () => {
    const out = stripProposeToolsOnRedo(
      tools("meta_ads__list_ads", "meta_ads__propose_budget_change"),
      true,
    );
    expect(out.map((t) => t.name)).toEqual(["meta_ads__list_ads"]);
  });

  it("covers the non-ads emitters a switched organic channel can reach", () => {
    const out = stripProposeToolsOnRedo(
      tools(
        "social__propose_post",
        "social__propose_standing_order",
        "outbound__propose_cohort_email",
        "outbound__propose_email",
        "fundraising__propose_email",
        "generated_video__propose",
      ),
      true,
    );
    expect(out).toEqual([]);
  });

  it("does NOT strip the brief writer, which layer 2 cannot refuse", () => {
    const out = stripProposeToolsOnRedo(tools("growth__propose_creative_brief"), true);
    expect(out.map((t) => t.name)).toEqual(["growth__propose_creative_brief"]);
  });

  it("leaves the reads alone, because the rewrite still needs its evidence", () => {
    const reads = tools(
      "google_ads__search_terms",
      "google_ads__conversion_tracking_health",
      "web_fetch__fetch",
      "memory__search",
    );
    expect(stripProposeToolsOnRedo(reads, true).map((t) => t.name)).toEqual(
      reads.map((t) => t.name),
    );
  });

  it("a NORMAL run keeps its full grant, by identity not by value", () => {
    const full = tools(
      "google_ads__list_campaigns",
      "google_ads__propose_budget_change",
      "meta_ads__propose_status_change",
    );
    const out = stripProposeToolsOnRedo(full, false);
    expect(out.map((t) => t.name)).toEqual(full.map((t) => t.name));
    expect(out).toBe(full);
  });
});

describe("redoRefusesClass — layer 2, the belt", () => {
  it("lets the rewritten action itself through", () => {
    expect(redoRefusesClass(true, REDO_ALLOWED_DECISION_CLASS)).toBe(false);
  });

  it("refuses a money proposal that reached the emitter anyway", () => {
    expect(redoRefusesClass(true, "google_ads.budget_change")).toBe(true);
    expect(redoRefusesClass(true, "meta_ads.status_change")).toBe(true);
  });

  it("refuses classes layer 1 does not name at all", () => {
    expect(redoRefusesClass(true, "social.publish.v2")).toBe(true);
    expect(redoRefusesClass(true, "outbound.cohort_email")).toBe(true);
  });

  it("refuses nothing on a normal run", () => {
    for (const c of [
      REDO_ALLOWED_DECISION_CLASS,
      "google_ads.budget_change",
      "social.publish.v2",
      "outbound.cohort_email",
    ]) {
      expect(redoRefusesClass(false, c)).toBe(false);
    }
  });
});
