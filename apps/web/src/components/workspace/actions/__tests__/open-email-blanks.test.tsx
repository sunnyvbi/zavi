// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ChannelActionCard } from "../ChannelActionCard";
import { clearBlankContextCache } from "../BlanksFill";
import { blankSource, knownBlankValues } from "../blanks";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const fail = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
const routes = (map: Record<string, () => Promise<unknown>>) =>
  apiFetch.mockImplementation((path: string) => (map[path] ? map[path]() : fail()));
const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

let assigned: string[];
let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearBlankContextCache();
  apiFetch.mockReset();
  routes({});
  assigned = [];
  Object.defineProperty(window, "location", { value: { set href(v: string) { assigned.push(v); } }, configurable: true });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

const pitch = (label: string, content: string) =>
  makeAction("send_message", {
    channel_slug: "ugc",
    title: "Email a local food creator",
    body: { step: { title: "Email a local food creator", body: "b", deliverable: { kind: "email", label, content } } },
    card_kind: "message",
    primary_label: "Open email",
    done_label: "I sent it",
    how_to: ["Press Open email."],
  });

const render_ = (content: string, label = "Collab with [bakery name]") => {
  const h = handlers();
  render(<ChannelActionCard action={pitch(label, content)} platform={platformFor("ugc")} handlers={h} />);
  return h;
};

const openButton = () => screen.getByRole("button", { name: /^Open email/ });
const press = async () => {
  fireEvent.click(openButton());
  await flush();
};
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(within(screen.getByTestId("blanks-fill")).getByLabelText(label), { target: { value } });
const decoded = (url: string) => {
  const q = new URLSearchParams(url.replace(/^mailto:\?/, ""));
  return { subject: q.get("subject") ?? "", body: q.get("body") ?? "" };
};
const UNFILLED = /\[[^\][]+\]/;

const assertNothingWentOut = (h: ActionHandlers) => {
  expect(assigned).toEqual([]);
  expect(screen.queryByRole("button", { name: "I sent it" })).toBeNull();
  expect(h.onSetStatus).not.toHaveBeenCalled();
};

describe("Open email never opens with a blank in it", () => {
  it("waits for every blank, says where to fill them before any press, then opens with the filled subject and body", async () => {
    const h = render_("Hi [First name],\n\nI run [bakery name] two streets from you. Would you try our cardamom buns?");
    await flush();
    expect(openButton().textContent).toBe("Open email (2 blanks to fill)");
    const pointer = screen.getByTestId("blanks-pointer").textContent ?? "";
    expect(pointer).toContain("Fill these in first");
    expect(pointer).toContain("2 blanks");

    await press();
    assertNothingWentOut(h);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("First name");

    type("First name", "Maya");
    await press();
    assertNothingWentOut(h);
    expect(openButton().textContent).toBe("Open email (1 blank to fill)");

    type("bakery name", "Brightloaf");
    expect(screen.queryByTestId("blanks-pointer")).toBeNull();
    await press();
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).not.toMatch(/%5B|%5D/i);
    const mail = decoded(assigned[0]);
    expect(mail.body).toBe("Hi Maya,\n\nI run Brightloaf two streets from you. Would you try our cardamom buns?");
    expect(`${mail.subject}\n${mail.body}`).not.toMatch(UNFILLED);
    expect(h.onSetStatus).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "I sent it" }));
    expect(h.onSetStatus).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }), "acted", { keep: true });
    expect(mail.subject).toBe("Collab with Brightloaf");
  });

  it("a blank only in the subject still holds the button, gets its own field, and lands in the subject", async () => {
    const h = render_("Hi Maya,\n\nWould you try our cardamom buns?");
    await flush();
    expect(openButton().textContent).toBe("Open email (1 blank to fill)");
    await press();
    assertNothingWentOut(h);

    type("bakery name", "Brightloaf");
    await press();
    expect(assigned).toHaveLength(1);
    expect(decoded(assigned[0])).toEqual({ subject: "Collab with Brightloaf", body: "Hi Maya,\n\nWould you try our cardamom buns?" });
  });

  it("a draft with its own Subject line mails that subject, filled, and keeps the Subject line out of the body", async () => {
    const h = render_("Subject: Cardamom buns for [creator handle]?\n\nHi [First name],\n\nWould you try them?", "First email");
    await flush();
    expect(openButton().textContent).toBe("Open email (2 blanks to fill)");
    await press();
    assertNothingWentOut(h);

    type("First name", "Maya");
    type("creator handle", "@mayaeats");
    await press();
    expect(assigned).toHaveLength(1);
    expect(decoded(assigned[0])).toEqual({ subject: "Cardamom buns for @mayaeats?", body: "Hi Maya,\n\nWould you try them?" });
  });

  it("a body too long for the URL still waits for the subject blank, then puts only the filled subject in the URL", async () => {
    const long = `Hi Maya,\n\n${"word ".repeat(600).trim()}`;
    const h = render_(long);
    await flush();
    await press();
    assertNothingWentOut(h);
    expect(writeText).not.toHaveBeenCalled();

    type("bakery name", "Brightloaf");
    await press();
    expect(assigned).toEqual(["mailto:?subject=Collab%20with%20Brightloaf"]);
    expect(writeText).toHaveBeenCalledWith(long);
  });
});

describe("the business's own name is filled from company details", () => {
  it("names a [bakery name] blank from the company name when the company details say bakery", () => {
    expect(blankSource("[bakery name]")).toBe("business_name");
    expect(blankSource("[Your name]")).toBeNull();
    expect(blankSource("[creator name]")).toBeNull();
    expect(knownBlankValues(["[bakery name]"], { companyName: "Brightloaf", whatWeSell: "Sourdough and cardamom buns from our bakery" })).toEqual({
      "[bakery name]": { value: "Brightloaf", from: "From your company details" },
    });
    expect(knownBlankValues(["[bakery name]"], { companyName: "Brightloaf Bakery" })["[bakery name]"]?.value).toBe("Brightloaf Bakery");
    expect(knownBlankValues(["[bakery name]"], { companyName: "Northside Yoga", whatWeSell: "Yoga classes" })).toEqual({});
    expect(knownBlankValues(["[Product name]", "[Campaign name]", "[Event name]"], { companyName: "Product Lab", whatWeSell: "product design consulting, campaign and event planning" })).toEqual({});
  });

  it("prefills it on the card, the founder can change it, and the change is what the mail app gets", async () => {
    routes({
      "/api/connectors/company-facts": () => ok({ facts: [{ key: "company_name", value_text: "Brightloaf Bakery" }] }),
    });
    const h = render_("Hi [First name],\n\nI run [bakery name]. Would you try our buns?");
    await flush();
    const field = within(screen.getByTestId("blanks-fill")).getByLabelText("bakery name") as HTMLInputElement;
    expect(field.value).toBe("Brightloaf Bakery");
    expect(screen.getByText("From your company details")).toBeTruthy();
    expect(openButton().textContent).toBe("Open email (1 blank to fill)");

    await press();
    assertNothingWentOut(h);

    type("bakery name", "Brightloaf");
    type("First name", "Maya");
    await press();
    expect(decoded(assigned[0])).toEqual({ subject: "Collab with Brightloaf", body: "Hi Maya,\n\nI run Brightloaf. Would you try our buns?" });
  });

  it("a company whose details do not say bakery leaves the blank for the founder", async () => {
    routes({
      "/api/connectors/company-facts": () => ok({ facts: [{ key: "company_name", value_text: "Northside Yoga" }, { key: "what_we_sell", value_text: "Yoga classes" }] }),
    });
    const h = render_("Hi Maya,\n\nWould you try our buns?");
    await flush();
    expect((within(screen.getByTestId("blanks-fill")).getByLabelText("bakery name") as HTMLInputElement).value).toBe("");
    await press();
    assertNothingWentOut(h);
  });
});
