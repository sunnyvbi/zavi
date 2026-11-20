import { describe, expect, it } from "vitest";
import { safeExecReceipt } from "../exec-receipt";
import { toActionView } from "../channel-actions";

const row = (over: Record<string, unknown>) =>
  ({
    id: "ca-1", channel_slug: "email_marketing", run_id: "run-1", position: 1, run_of: 1, blocking: false,
    action_type: "send_message", title: "Send it", body: {}, status: "acted", note: null,
    snoozed_until: null, impact: null, impact_reason: null, proposed_at: "2026-10-07T00:00:00Z",
    repeat_of: null, redo_of: null, ...over,
  }) as never;

describe("safeExecReceipt", () => {
  it("keeps a line and an https link on the tool's own site", () => {
    expect(safeExecReceipt({ line: "Sent to 412 people via Mailchimp", url: "https://admin.mailchimp.com/campaigns/show/?id=9" })).toEqual({
      line: "Sent to 412 people via Mailchimp",
      url: "https://admin.mailchimp.com/campaigns/show/?id=9",
    });
    expect(safeExecReceipt({ line: "Sent", url: "https://www.klaviyo.com/campaign/ABC/reports/overview" })?.url).toBe("https://www.klaviyo.com/campaign/ABC/reports/overview");
  });

  const dropped: Array<[string, string]> = [
    ["http, not https", "http://admin.mailchimp.com/campaigns/show/?id=9"],
    ["another site", "https://evil.example/campaigns"],
    ["a look-alike host", "https://mailchimp.com.evil.example/x"],
    ["a host that only ends in the name", "https://notmailchimp.com/x"],
    ["credentials in the link", "https://user:pw@admin.mailchimp.com/x"],
    ["a script link", "javascript:alert(1)"],
    ["not a link at all", "see your account"],
  ];
  for (const [name, url] of dropped) {
    it(`drops the link but keeps the line: ${name}`, () => {
      expect(safeExecReceipt({ line: "Sent to 412 people via Mailchimp", url })).toEqual({ line: "Sent to 412 people via Mailchimp" });
    });
  }

  it("no usable line means no receipt", () => {
    for (const raw of [null, undefined, "Sent", [], {}, { line: "" }, { line: 5 }, { url: "https://admin.mailchimp.com/x" }]) {
      expect(safeExecReceipt(raw)).toBeNull();
    }
  });

  it("flattens whitespace and caps the line", () => {
    expect(safeExecReceipt({ line: "Sent\n to   412" })?.line).toBe("Sent to 412");
    expect(safeExecReceipt({ line: "x".repeat(500) })?.line).toHaveLength(200);
  });
});

describe("the receipt on the wire", () => {
  it("an executed card serves the receipt, and nothing else of exec_result", () => {
    const v = toActionView(
      row({ exec_class: "email_campaign.create_and_send", exec_status: "executed", exec_result: { notice: "n", receipt: { line: "Sent to 412 people via Mailchimp", url: "https://admin.mailchimp.com/campaigns/show/?id=9" }, secret_detail: "provider says xyz" } }),
      1,
      {},
    );
    expect(v.exec_receipt).toEqual({ line: "Sent to 412 people via Mailchimp", url: "https://admin.mailchimp.com/campaigns/show/?id=9" });
    expect(JSON.stringify(v)).not.toContain("provider says xyz");
  });

  it("a stored link that is off the tool's site is dropped at the wire too", () => {
    const v = toActionView(row({ exec_class: "email_campaign.create_and_send", exec_status: "executed", exec_result: { receipt: { line: "Sent", url: "https://evil.example/x" } } }), 1, {});
    expect(v.exec_receipt).toEqual({ line: "Sent" });
  });

  it("a channel whose executed change reports no receipt is unchanged: none is served", () => {
    const v = toActionView(row({ channel_slug: "meta_ads", action_type: "update_ad", exec_class: "meta_ads.set_status", exec_status: "executed", exec_result: { notice: null } }), 1, {});
    expect(v.exec_receipt).toBeNull();
  });

  it("a receipt is never served for a card that did not execute", () => {
    for (const exec_status of ["failed", "queued", "dispatching", null]) {
      const v = toActionView(row({ exec_class: "email_campaign.create_and_send", exec_status, exec_result: { receipt: { line: "Sent" } } }), 1, {});
      expect(v.exec_receipt, String(exec_status)).toBeNull();
    }
  });
});

it("shows historical ChatGPT creation references without exposing the raw result", () => {
  const v = toActionView(row({ channel_slug: "chatgpt_ads", exec_class: "chatgpt_ads.create_and_launch", exec_status: "executed", exec_result: { created: { id: "cmpn_123", platform: "chatgpt", object_type: "campaign", status: "ACTIVE" }, secret_detail: "hidden" } }), 1, {});
  expect(v.exec_receipt?.line).toContain("cmpn_123");
  expect(v.exec_receipt?.url).toBeUndefined();
  expect(JSON.stringify(v)).not.toContain("hidden");
});

describe("ad receipts", () => {
  it("never link to an ad platform: the id alone cannot pick the founder's ad account", () => {
    expect(safeExecReceipt({ line: "Live", url: "https://adsmanager.facebook.com/adsmanager/manage/ads?selected_ad_ids=1" })).toEqual({ line: "Live" });
    const v = toActionView(row({ channel_slug: "meta_ads", exec_class: "meta_ads.create_ad", exec_status: "executed", exec_result: { created: { platform: "meta", object_type: "ad", id: "1", status: "ACTIVE" } } }), 10, {});
    expect(v.exec_receipt).toBeNull();
  });
});
