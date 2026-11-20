
import { describe, it, expect } from "vitest";
import {
  isUntrustedContextPayload,
  isHumanAuthoredChat,
  carriesCapturedPageContext,
} from "../untrusted-context";
import { trustTierFor } from "@/services/memory/trust-tier";

describe("isUntrustedContextPayload — server-side derivation", () => {
  it("taints a payload carrying a Chrome-extension page capture", () => {
    expect(
      isUntrustedContextPayload({
        thread_id: "t1",
        surface: "chrome_extension",
        page_context: { url: "https://ads.example.com/x", title: "Ads", dom_scrubbed: "<p>hi</p>" },
      }),
    ).toBe(true);
  });

  it("taints even a minimal/odd page_context — presence is the signal, not shape", () => {
    expect(isUntrustedContextPayload({ page_context: {} })).toBe(true);
    expect(isUntrustedContextPayload({ page_context: "" })).toBe(true);
    expect(isUntrustedContextPayload({ page_context: 0 })).toBe(true);
  });

  it("does NOT taint an ordinary chat payload", () => {
    expect(isUntrustedContextPayload({ thread_id: "t1", current_message: "raise budget" })).toBe(
      false,
    );
  });

  it("does NOT taint on a surface marker alone — the capture is the untrusted material", () => {
    expect(isUntrustedContextPayload({ surface: "chrome_extension" })).toBe(false);
  });

  it("is total: null / undefined / primitives / arrays never throw and never taint", () => {
    for (const v of [null, undefined, 0, "", "page_context", true, []]) {
      expect(isUntrustedContextPayload(v)).toBe(false);
    }
  });

  it("does NOT taint a screenshot-mode capture (full chat parity)", () => {
    expect(
      isUntrustedContextPayload({
        thread_id: "t1",
        surface: "chrome_extension",
        image_paths: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg"],
        page_context: { mode: "screenshot", url: "https://app.slack.com/client/T1", title: "Slack" },
      }),
    ).toBe(false);
  });

  it("STILL taints a typed meta_ads capture on the same surface", () => {
    expect(
      isUntrustedContextPayload({
        thread_id: "t1",
        surface: "chrome_extension",
        page_context: {
          url: "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
          title: "Ads Manager",
          adapter_id: "meta_ads",
          schema_version: 1,
          extraction: { rows: [], truncated: false, row_count_total: 0 },
          observation_only: false,
          browser_observed: true,
        },
      }),
    ).toBe(true);
  });

  it("an explicit null page_context is not a capture", () => {
    expect(isUntrustedContextPayload({ page_context: null })).toBe(false);
  });
});

describe("isHumanAuthoredChat — narrows, never widens", () => {
  it("true for an ordinary chat turn (taint absent or false)", () => {
    expect(isHumanAuthoredChat({ run_trigger: "chat" })).toBe(true);
    expect(isHumanAuthoredChat({ run_trigger: "chat", untrusted_context: false })).toBe(true);
  });

  it("false for a TAINTED chat turn — reads as agent-initiated", () => {
    expect(isHumanAuthoredChat({ run_trigger: "chat", untrusted_context: true })).toBe(false);
  });

  it("NEVER widens: a non-chat trigger stays false no matter the taint", () => {
    for (const t of ["cron", "slack", "a2a", "webhook", "email", "handoff", "manual", undefined]) {
      expect(isHumanAuthoredChat({ run_trigger: t, untrusted_context: false })).toBe(false);
      expect(isHumanAuthoredChat({ run_trigger: t, untrusted_context: true })).toBe(false);
    }
  });
});

describe("trustTierFor — a tainted chat turn is not 'operator-stated'", () => {
  const agent_slug = "performance-marketer";

  it("UNTAINTED chat is still tier 0 (byte-identical to pre-taint)", () => {
    expect(trustTierFor({ trigger: "chat", agent_slug })).toBe(0);
    expect(trustTierFor({ trigger: "chat", agent_slug, untrusted_context: false })).toBe(0);
  });

  it("TAINTED chat demotes to 2 (agent-inferred) so a web page cannot write tier-0 brain input", () => {
    expect(trustTierFor({ trigger: "chat", agent_slug, untrusted_context: true })).toBe(2);
  });

  it("every non-chat trigger is unchanged by the taint", () => {
    for (const trigger of ["cron", "mcp", "webhook", "manual", "a2a", "handoff"]) {
      expect(trustTierFor({ trigger, agent_slug, untrusted_context: true })).toBe(
        trustTierFor({ trigger, agent_slug }),
      );
    }
  });

  it("demotes to 2, NOT 3 — an extension run is authenticated, just not operator-authored", () => {
    expect(trustTierFor({ trigger: "chat", agent_slug, untrusted_context: true })).not.toBe(3);
    expect(trustTierFor({ trigger: "chat", agent_slug, untrusted_context: true })).toBe(2);
  });
});

const SCREENSHOT_PAYLOAD = {
  thread_id: "t1",
  surface: "chrome_extension",
  page_context: { mode: "screenshot", url: "https://app.slack.com/client/T1", title: "Slack" },
};

describe("carriesCapturedPageContext — what a run may TEACH", () => {
  it("is TRUE for a screenshot capture, where the behaviour taint is false", () => {
    expect(carriesCapturedPageContext(SCREENSHOT_PAYLOAD)).toBe(true);
    expect(isUntrustedContextPayload(SCREENSHOT_PAYLOAD)).toBe(false);
  });

  it("is TRUE for a typed capture too", () => {
    expect(
      carriesCapturedPageContext({
        surface: "chrome_extension",
        page_context: { url: "https://adsmanager.facebook.com", adapter_id: "meta_ads" },
      }),
    ).toBe(true);
  });

  it("is FALSE for an ordinary chat payload, so web/mobile chat is unchanged", () => {
    expect(carriesCapturedPageContext({ thread_id: "t1", user_message_id: "u1" })).toBe(false);
    expect(carriesCapturedPageContext({ surface: "chrome_extension" })).toBe(false);
    expect(carriesCapturedPageContext({ thread_id: "t1", page_context: null })).toBe(false);
  });

  it("is total: null / undefined / primitives / arrays never throw", () => {
    for (const v of [null, undefined, 0, "", "x", [], true]) {
      expect(carriesCapturedPageContext(v)).toBe(false);
    }
  });
});

describe("a screenshot turn cannot write a tier-0 company fact", () => {
  const chat = { trigger: "chat", agent_slug: "operator" };

  it("stamps tier 2 when the tier is derived the way write-signal derives it", () => {
    expect(
      trustTierFor({ ...chat, untrusted_context: carriesCapturedPageContext(SCREENSHOT_PAYLOAD) }),
    ).toBe(2);
  });

  it("still stamps tier 0 for a turn the operator actually typed", () => {
    expect(
      trustTierFor({
        ...chat,
        untrusted_context: carriesCapturedPageContext({ thread_id: "t1", user_message_id: "u1" }),
      }),
    ).toBe(0);
  });
});

describe("isHumanAuthoredChat — a screenshot turn is not human-authored", () => {
  it("false for a screenshot turn, even though it is untainted by decision 6", () => {
    expect(
      isHumanAuthoredChat({
        run_trigger: "chat",
        untrusted_context: false,
        captured_page_context: true,
      }),
    ).toBe(false);
  });

  it("still true for an ordinary typed chat turn", () => {
    expect(
      isHumanAuthoredChat({
        run_trigger: "chat",
        untrusted_context: false,
        captured_page_context: false,
      }),
    ).toBe(true);
    expect(isHumanAuthoredChat({ run_trigger: "chat" })).toBe(true);
  });

  it("NEVER widens: a non-chat trigger stays false whatever the new flag says", () => {
    for (const trigger of ["cron", "handoff", "mcp", "webhook"]) {
      expect(isHumanAuthoredChat({ run_trigger: trigger, captured_page_context: false })).toBe(
        false,
      );
    }
  });
});
