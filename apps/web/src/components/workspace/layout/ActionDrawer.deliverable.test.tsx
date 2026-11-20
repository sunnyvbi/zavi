
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionDrawer } from "./ActionDrawer";

const noop = () => {};
const content = "Booking deposits for small studios, held until the class runs.\n\nNo card charge until then.";

const decision = {
  id: "d-1",
  decision_class: "channel.recipe_step",
  handler: null,
  emitted_at: "2026-09-12T00:00:00Z",
  body: {
    position: 1,
    of: 2,
    action_key: "k",
    rendered_markdown: "## The whole run",
    step: {
      title: "Paste your new X bio",
      body: "Your current bio names the category, not the buyer.",
      blocking: false,
      effort: "minutes",
      evidence: ["fetched https://studio.test"],
      deliverable: { kind: "page_copy", label: "X bio", content },
    },
  },
};

const render = (d: typeof decision) =>
  renderToStaticMarkup(
    <ActionDrawer
      decision={d}
      mode="advise"
      busy={false}
      error={null}
      onClose={noop}
      onApprove={noop}
      onReject={noop}
      onDidIt={noop}
      onDidntDoIt={noop}
      onNotNow={noop}
      onOpenThread={noop}
    />,
  );

describe("ActionDrawer deliverable", () => {
  it("renders the paste-ready copy with a Copy button before the why and the audit", () => {
    const html = render(decision);
    const iContent = html.indexOf("Booking deposits for small studios");
    const iBody = html.indexOf("Your current bio names the category");
    const iAudit = html.indexOf("Show the full audit");
    expect(iContent).toBeGreaterThan(-1);
    expect(iContent).toBeLessThan(iBody);
    expect(iBody).toBeLessThan(iAudit);
    expect(html).toContain(">Copy<");
    expect(html).toContain(">Page copy<");
  });

  it("shows each bio alternative with its own Copy, never one paste of all three", () => {
    const parts = [
      { label: "Bio A", content: "Handmade cups for your daily coffee." },
      { label: "Bio B", content: "Make your coffee ritual yours." },
      { label: "Bio C", content: "A handmade cup for every morning." },
    ];
    const joined = parts.map((p) => `${p.label}\n${p.content}`).join("\n\n");
    const step = { ...decision.body.step, deliverable: { kind: "page_copy", label: "Instagram bios", content: joined, parts } };
    const html = render({ ...decision, body: { ...decision.body, step } });
    for (const p of parts) expect(html).toContain(p.content);
    expect(html.match(/>Copy</g)).toHaveLength(3);
    expect(html).not.toContain("Bio A\nHandmade");
  });

  it("renders no copy block for an action with no deliverable", () => {
    const { deliverable: _omit, ...step } = decision.body.step;
    const html = render({ ...decision, body: { ...decision.body, step } as typeof decision.body });
    expect(html).not.toContain(">Copy<");
  });
});

describe("ActionDrawer bulk email draft", () => {
  it("never says Zavi will carry out a bulk email on approve", () => {
    const html = renderToStaticMarkup(
      <ActionDrawer
        decision={{
          id: "d-bulk",
          decision_class: "bulk_outbound.send",
          handler: "bulk_outbound.send",
          emitted_at: "2026-10-07T00:00:00Z",
          body: { template: { subject: "Come back", body_text: "We miss you" } },
        }}
        mode="execute"
        busy={false}
        error={null}
        onClose={noop}
        onApprove={noop}
        onReject={noop}
        onDidIt={noop}
        onDidntDoIt={noop}
        onNotNow={noop}
        onOpenThread={noop}
      />,
    );
    expect(html).not.toContain("Zavi will carry this out");
    expect(html).toContain("Sends nothing. Bulk email is not switched on yet");
  });
});
