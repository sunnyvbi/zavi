// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: m.fetch }));

import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import { CHANNEL_SETTINGS_CHANGED_EVENT } from "@/lib/workspace/onTabReturn";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const linkedin = platformFor("linkedin_ads");

const askCard = (over: Parameters<typeof makeAction>[1] = {}) =>
  makeAction("setup", {
    id: "ask-1",
    channel_slug: "linkedin_ads",
    title: "Add what one new customer is worth to you in year one",
    executable: false,
    card_kind: "task",
    primary_label: "Verify",
    done_label: "It works",
    blocking: true,
    how_to: ['Add it in LinkedIn Ads > Settings > "What one new customer is worth in year one".', "Do this first."],
    body: {
      step: {
        title: "Add what one new customer is worth to you in year one",
        body: "Not yet: a readable test is $350 (14 days at LinkedIn's suggested $25/day) and the site could not be read, so one customer's value is unknown.",
        blocking: true,
        effort: "minutes",
        evidence: [],
        how_to: ['Add it in LinkedIn Ads > Settings > "What one new customer is worth in year one".', "Do this first."],
      },
    },
    ...over,
  });

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

let puts: Array<{ path: string; body: unknown }>;
let order: string[];
let putStatus: number;
let saved: unknown[];

beforeEach(() => {
  puts = [];
  order = [];
  putStatus = 200;
  saved = [];
  m.fetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      order.push("put");
      puts.push({ path, body: JSON.parse(init.body ?? "null") });
      return putStatus === 200 ? ok({}) : { ok: false, status: putStatus, json: async () => ({ error: { message: "Nope." } }) };
    }
    return ok({ fields: { deal_value: saved } });
  });
});
afterEach(() => {
  cleanup();
  m.fetch.mockReset();
});

const handlers = (): ActionHandlers => ({
  onSetStatus: vi.fn(async () => {
    order.push("acted");
  }),
  onRedo: vi.fn(),
  onApprove: vi.fn(),
  onOpenChat: vi.fn(),
});

describe("a card that asks for a channel setting takes the answer itself", () => {
  it("must catch: the number is asked for on the card, saved to the setting, and only then the card closes", async () => {
    const h = handlers();
    const announced = vi.fn();
    window.addEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, announced);
    render(<ChannelActionCard action={askCard()} platform={linkedin} handlers={h} />);
    expect(screen.queryByText("Verify")).toBeNull();
    const saveButton = screen.getByTestId("setting-ask-save");
    const menu = screen.getByRole("button", { name: /More actions/ });
    expect(screen.getByTestId("setting-ask").contains(saveButton)).toBe(false);
    expect(saveButton.parentElement?.parentElement?.contains(menu) || saveButton.parentElement?.contains(menu)).toBe(true);
    expect(screen.getByTestId("setting-ask").textContent).toMatch(/US\$/);
    expect(screen.queryByText(/Add it in LinkedIn Ads > Settings/)).toBeNull();
    fireEvent.change(screen.getByLabelText("What one new customer is worth in year one"), { target: { value: "$2,250" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("setting-ask-save"));
    });
    await waitFor(() => expect(h.onSetStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "ask-1" }), "acted", expect.objectContaining({ keep: true })));
    expect(puts).toEqual([{ path: "/api/channels/linkedin_ads/settings/deal_value", body: { items: [{ item: "2250" }] } }]);
    expect(order).toEqual(["put", "acted"]);
    expect(announced).toHaveBeenCalledTimes(1);
    window.removeEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, announced);
  });

  it("must catch: the form sits above Save, and opening How it works shows no step that sends the founder to Settings", () => {
    render(<ChannelActionCard action={askCard()} platform={linkedin} handlers={handlers()} />);
    const form = screen.getByTestId("setting-ask");
    const save = screen.getByTestId("setting-ask-save");
    expect(form.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const toggle = screen.queryByRole("button", { name: /How it works/ });
    if (toggle) fireEvent.click(toggle);
    expect(screen.queryByText(/Add it in LinkedIn Ads > Settings/)).toBeNull();
    expect(screen.queryByText("Do this first.")).toBeNull();
  });

  it("must catch: a refused save keeps the card open and says why", async () => {
    putStatus = 403;
    const h = handlers();
    render(<ChannelActionCard action={askCard()} platform={linkedin} handlers={h} />);
    fireEvent.change(screen.getByTestId("setting-ask-input"), { target: { value: "220" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("setting-ask-save"));
    });
    expect((await screen.findByTestId("setting-ask-error")).textContent).toBe("Only a workspace owner or admin can save this.");
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });

  it("must catch: a value that is not a number never reaches the setting", async () => {
    const h = handlers();
    render(<ChannelActionCard action={askCard()} platform={linkedin} handlers={h} />);
    fireEvent.change(screen.getByTestId("setting-ask-input"), { target: { value: "a lot" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("setting-ask-save"));
    });
    expect(screen.getByTestId("setting-ask-error").textContent).toBe("Type a number, digits only.");
    expect(puts).toHaveLength(0);
    expect(h.onSetStatus).not.toHaveBeenCalled();
  });

  it("shows the value already saved, so the founder can confirm it", async () => {
    saved = [{ item: "1200", status: null }];
    render(<ChannelActionCard action={askCard()} platform={linkedin} handlers={handlers()} />);
    await waitFor(() => expect((screen.getByTestId("setting-ask-input") as HTMLInputElement).value).toBe("1200"));
  });

  it("a task that names no setting keeps its own button", () => {
    render(
      <ChannelActionCard
        action={askCard({ how_to: ["Open Campaign Manager and check the Insight Tag."], body: { step: { title: "Check the tag", body: "Check the Insight Tag fires.", blocking: false, effort: "minutes", evidence: [] } } })}
        platform={linkedin}
        handlers={handlers()}
      />,
    );
    expect(screen.queryByTestId("setting-ask")).toBeNull();
    expect(screen.getByText("Verify")).toBeTruthy();
  });

  it("a closed card asks for nothing", () => {
    render(<ChannelActionCard action={askCard({ status: "acted" })} platform={linkedin} handlers={handlers()} />);
    expect(screen.queryByTestId("setting-ask")).toBeNull();
  });
});
