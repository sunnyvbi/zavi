import { describe, it, expect } from "vitest";
import { buildApprovalBlocks, SLACK_ACTION_APPROVE } from "../slack-approval-blocks";

type Text = { type: string; text: string; emoji?: boolean };
type Block = { type: string; text?: Text; fields?: Text[]; elements?: Array<Record<string, unknown>> };
const build = (decision_class: string, body: Record<string, unknown>) =>
  buildApprovalBlocks({ id: "d1", decision_class, body } as never) as Block[];
const texts = (blocks: Block[]) => blocks.filter((b) => b.type === "section" && b.text?.type === "plain_text").map((b) => b.text as Text);
const valueOf = (t: Text[], label: string) => {
  const i = t.findIndex((x) => x.text.startsWith(`${label}\n`));
  if (i < 0) return null;
  let out = t[i].text.slice(label.length + 1);
  for (let j = i + 1; j < t.length && !/^[A-Z][\w -]*\n/.test(t[j].text); j++) out += t[j].text;
  return out;
};
const buttons = (blocks: Block[]) => blocks.find((b) => b.type === "actions")?.elements ?? [];

describe("send_email Slack card", () => {
  it("shows To, Reply-To, Subject and the whole message", () => {
    const body_text = "Line one\n" + "x".repeat(2_390);
    const t = texts(build("send_email", { to: "jane@acme.test", reply_to: "me@acme.test", subject: "Your refund", body_text }));
    expect(valueOf(t, "To")).toBe("jane@acme.test");
    expect(valueOf(t, "Reply-To")).toBe("me@acme.test");
    expect(valueOf(t, "Subject")).toBe("Your refund");
    expect(valueOf(t, "Message")).toBe(body_text);
  });

  it("every value is plain text, so markup and formatting show as typed", () => {
    const body_text = "Use *SAVE20* _now_ ~today~ `code` :tada: at <https://evil.test|https://bank.test> & <!channel>";
    const t = texts(build("send_email", { to: "a@b.co", subject: "<!here> *sale*", body_text }));
    for (const x of t) expect(x).toMatchObject({ type: "plain_text", emoji: false });
    expect(valueOf(t, "Subject")).toBe("<!here> *sale*");
    expect(valueOf(t, "Message")).toBe(body_text);
  });

  it("a long message with characters Slack would expand is shown whole and unchanged", () => {
    const body_text = "&".repeat(2_000) + "é🙂<" + "a".repeat(395);
    expect(valueOf(texts(build("send_email", { to: "a@b.co", subject: "s", body_text })), "Message")).toBe(body_text);
  });
});

describe("governed raw-write cards", () => {
  it("a charge shows the amount and fee, and can only be approved on the web", () => {
    const blocks = build("stripe.create_payment", {
      amount: 1999, currency: "usd", application_fee_amount: 100, client_reference: "order-7", governed_by: "chokepoint", fingerprint: "f",
    });
    const t = texts(blocks);
    expect(valueOf(t, "Charge")).toBe("19.99 USD");
    expect(valueOf(t, "Zavi fee")).toBe("1.00 USD");
    expect(valueOf(t, "Reference")).toBe("order-7");
    const b = buttons(blocks);
    expect(b.some((x) => x.action_id === SLACK_ACTION_APPROVE)).toBe(false);
    expect(b.find((x) => (x.text as Text).text === "Open to approve")?.url).toMatch(/\/workspace\?tab=needs-you(&company=[^&]+)?&decision=[^&]+$/);
  });

  it("a pull request shows its files and keeps Approve", () => {
    const blocks = build("github.open_pr_direct", {
      repo: "acme/web", base_branch: "main", head_branch: "engineer/fix", title: "Fix", body: "", governed_by: "chokepoint",
      files: [{ path: "a.ts", action: "modify", content: "x\ny" }],
    });
    expect(valueOf(texts(blocks), "Files")).toBe("a.ts (modify, 2 lines)");
    expect(buttons(blocks).some((x) => x.action_id === SLACK_ACTION_APPROVE)).toBe(true);
  });

  it("a card too long for one Slack message shows what fits and is approved on the web", () => {
    const blocks = build("create_jira_issue", {
      project_key: "OPS", summary: "s", description_markdown: "y".repeat(140_000), governed_by: "chokepoint",
    });
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(blocks)).toContain("too long to show in full here");
    expect(buttons(blocks).some((x) => x.action_id === SLACK_ACTION_APPROVE)).toBe(false);
  });

  it("a card another flow emitted for the same class keeps its own look", () => {
    expect(valueOf(texts(build("create_jira_issue", { project_key: "OPS", summary: "s" })), "Project")).toBeNull();
  });
});

describe("money amounts use the currency's own decimal places", () => {
  it("three-decimal, zero-decimal and two-decimal currencies", async () => {
    const { formatMinor } = await import("../exact-action-view");
    expect(formatMinor(1000, "kwd")).toBe("1.000 KWD");
    expect(formatMinor(1000, "jpy")).toBe("1000 JPY");
    expect(formatMinor(1000, "usd")).toBe("10.00 USD");
    expect(formatMinor(500, "ugx")).toBe("5.00 UGX");
  });
});

describe("Slack buttons open the decision where it lives (2026-10-17)", () => {
  it("a web-only card on a channel tile opens that tile on the card, for its company", () => {
    const blocks = buildApprovalBlocks({
      id: "d9",
      decision_class: "stripe.create_payment",
      body: { amount: 1999, currency: "usd", application_fee_amount: 100, client_reference: "o", governed_by: "chokepoint", fingerprint: "f" },
      home_channel: "seo",
      tenant_id: "t1",
    }) as Block[];
    const url = buttons(blocks).find((x) => (x.text as Text).text === "Open to approve")?.url as string;
    expect(url).toMatch(/\/workspace\?tab=channels&channel=seo&action=d9&company=t1$/);
  });

  it("an ad change's 'Manage ads autopilot' opens the Growth page, never /approvals", () => {
    const blocks = buildApprovalBlocks({ id: "d8", decision_class: "google_ads.update_campaign_budget", body: {}, tenant_id: "t1" }) as Block[];
    const url = buttons(blocks).find((x) => (x.text as Text).text === "Manage ads autopilot →")?.url as string;
    expect(url).toMatch(/\/workspace\?tab=growth-strategy&company=t1$/);
    expect(JSON.stringify(blocks)).not.toContain("/approvals");
  });
});
