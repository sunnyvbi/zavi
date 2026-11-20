// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiFetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }) }));

import { ChannelActionCard } from "../ChannelActionCard";
import { ChannelActionFrame } from "../ChannelActionFrame";
import { ChannelSurface } from "../ChannelSurface";
import { cardCopy } from "../cardCopy";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

afterEach(cleanup);

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn() });

const DOMAIN = "zavi-bulk-qa-cakely.private-rents.com";

const dmarcCard = (extra: Record<string, unknown> = {}, channel_slug = "email_marketing") =>
  makeAction("fix", {
    channel_slug,
    run_id: null,
    blocking: true,
    card_kind: "copy_to_site",
    title: `Publish a DMARC record on ${DOMAIN}`,
    body: {
      intent: "fix_setup",
      step: {
        title: `Publish a DMARC record on ${DOMAIN}`,
        body: `The name \`_dmarc.${DOMAIN}\` returns only a CNAME alias to cloudfront and no \`v=DMARC1\` TXT record, so there is no DMARC policy. \`p=none\` only reports and blocks nothing, so it is safe on day one. Move to \`p=quarantine\` once the reports look clean. Use an inbox you actually check for \`rua\`. Don't write SPF or DKIM values by hand. Take them from your email tool's domain verification screen.`,
        effort: "minutes",
        blocking: true,
        deliverable: { kind: "code", label: `DMARC TXT record for ${DOMAIN}`, content: `Type: TXT\nName/Host: _dmarc\nValue: v=DMARC1; p=none; rua=mailto:[an inbox you check, e.g. dmarc@${DOMAIN}]` },
      },
      ...extra,
    },
  } as Parameters<typeof makeAction>[1]);

const renderFrame = (action: ReturnType<typeof dmarcCard>) => {
  const { container } = render(<ChannelActionFrame a={action as never} header={null} right={null} />);
  return container;
};

describe("the DMARC fix-setup card's details", () => {
  it("has no Cost row and never says Not supplied when the setup step costs nothing", () => {
    const card = renderFrame(dmarcCard());
    expect(card.querySelector("[data-testid='action-cost']")).toBeNull();
    expect(within(card).queryByText("Not supplied")).toBeNull();
    expect(card.querySelector("[data-testid='action-provenance']")?.textContent).toBe("Saved channel proposal");
    expect(card.querySelector("[data-testid='action-destination']")?.textContent).toBe("Email campaigns");
  });

  it("keeps the Cost row on a setup card that does carry a price", () => {
    const card = renderFrame(dmarcCard({ cost: "$12 a month" }));
    expect(card.querySelector("[data-testid='action-cost']")?.textContent).toBe("$12 a month");
  });

  it("keeps the SPF/DKIM line with its subject in the steps instead of listing it alone as a reason", () => {
    const copy = cardCopy(dmarcCard(), false);
    expect(copy.why.some((line) => /^Take them/.test(line))).toBe(false);
    const dont = copy.steps.indexOf("Don't write SPF or DKIM values by hand.");
    expect(dont).toBeGreaterThanOrEqual(0);
    expect(copy.steps[dont + 1]).toBe("Take them from your email tool's domain verification screen.");
  });

  it("files a take-rate sentence as a reason, not a step, while Take them stays a step", () => {
    const base = dmarcCard();
    const step = (base.body as { step: Record<string, unknown> }).step;
    const copy = cardCopy(dmarcCard({ step: { ...step, body: `The name \`_dmarc.${DOMAIN}\` has no DMARC policy. Take rate is 15% on mail from this domain. Take them from your email tool's domain verification screen.` } }), false);
    expect(copy.steps).not.toContain("Take rate is 15% on mail from this domain.");
    expect([copy.lead, ...copy.why]).toContain("Take rate is 15% on mail from this domain.");
    expect(copy.steps).toContain("Take them from your email tool's domain verification screen.");
  });

  it("renders a setup card with the exact record and no orphaned line or Not supplied, end to end", () => {
    const action = dmarcCard({}, "seo");
    render(<ChannelSurface slug="seo"><ChannelActionCard action={action} platform={platformFor("seo")} handlers={handlers()} /></ChannelSurface>);
    const card = screen.getByTestId(`action-${action.id}`);
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    expect(card.textContent).toContain("no DMARC policy");
    fireEvent.click(within(card).getByRole("button", { name: "What it is" }));
    expect(screen.getByRole("dialog", { name: "Details" }).textContent).toContain("v=DMARC1; p=none");
    expect(card.querySelector("[data-testid='action-cost']")).toBeNull();
    expect(within(card).queryByText("Not supplied")).toBeNull();
  });
});
