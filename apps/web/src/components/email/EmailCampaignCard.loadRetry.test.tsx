// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Call = { url: string; method: string };
const calls: Call[] = [];
type Step = { status: number; body: unknown } | "throw";
const script: Record<string, Step[]> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const queue = script[`${method} ${url}`] ?? [];
    const step = queue.length > 1 ? queue.shift()! : queue[0] ?? { status: 200, body: {} };
    if (step === "throw") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: step.status < 400, status: step.status, json: () => Promise.resolve(step.body), clone() { return this; } });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => null }));

import { EmailCampaignCard, type EmailCardView } from "./EmailCampaignCard";
import { ApprovalBlock } from "@/components/agents/ApprovalBlock";
import { ChannelActionSection } from "@/components/workspace/actions/ChannelActionSection";
import { platformFor } from "@/components/workspace/actions/platforms";
import { makeAction } from "@/components/workspace/actions/__tests__/fixtures";

const ID = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const URL = (id: string, rail = "channel_actions") => `/api/email-cards/${rail}/${id}`;

function card(id: string, rail: "channel_actions" | "decisions" = "channel_actions"): EmailCardView {
  return {
    rail,
    id,
    class: "email_campaign.create_and_send",
    status: "pending",
    open: true,
    route: "sendgrid",
    list: { name: "Brightloop members", people: 238 },
    sender: { email: "hello@brightloop.test", name: "Brightloop" },
    reply_to: null,
    unsubscribe_group_id: "7",
    viewer_can_approve: true,
    chosen_variant: null,
    versions: [1, 2].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>V${n}</p>`, tested_by_me: false, tested_by_approver: false })),
    can_approve: [true, true],
    reasons: [],
  };
}

const ok = (c: EmailCardView): Step => ({ status: 200, body: { card: c } });
const bad: Step = { status: 500, body: { error: { message: "boom" } } };
const reads = (id = ID) => calls.filter((c) => c.method === "GET" && c.url === URL(id));
const writes = () => calls.filter((c) => c.method !== "GET");
const redBox = () => screen.queryByText("This email could not be loaded");

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(script)) delete script[k];
  window.localStorage.clear();
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("first load that fails retries by itself", () => {
  it("two failures then a success: the skeleton the whole time, the red box and the calm box never appear, 3 reads", async () => {
    script[`GET ${URL(ID)}`] = [bad, "throw", ok(card(ID))];
    const seen: string[] = [];
    const obs = new MutationObserver(() => {
      if (redBox()) seen.push("red");
      if (screen.queryByTestId("email-card-not-loading")) seen.push("calm");
    });
    const { container } = render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    obs.observe(container, { childList: true, subtree: true, characterData: true });
    expect(screen.getByRole("status", { name: "Loading email" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve/ })).toBeDefined(), { timeout: 4000 });
    obs.disconnect();
    expect(seen).toEqual([]);
    expect(reads()).toHaveLength(3);
    expect(screen.queryByText(/Zavi did not answer/)).toBeNull();
  });

  it("all three fail: exactly 3 reads, a calm box with Try again and no 'Zavi did not answer', no approval possible", async () => {
    script[`GET ${URL(ID)}`] = [bad];
    render(<EmailCampaignCard rail="channel_actions" id={ID} removable />);
    await waitFor(() => expect(screen.getByTestId("email-card-not-loading")).toBeDefined(), { timeout: 4000 });
    expect(reads()).toHaveLength(3);
    expect(screen.getByText("This email isn't loading right now.")).toBeTruthy();
    expect(screen.queryByText(/Zavi did not answer/)).toBeNull();
    expect(redBox()).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve|Send/ })).toBeNull();
    await new Promise((r) => setTimeout(r, 2500));
    expect(reads()).toHaveLength(3);
    expect(writes()).toEqual([]);
  });

  it("Try again after giving up starts a fresh round of 3 and can succeed", async () => {
    script[`GET ${URL(ID)}`] = [bad];
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-not-loading")).toBeDefined(), { timeout: 4000 });
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    script[`GET ${URL(ID)}`] = [bad, ok(card(ID))];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("status", { name: "Loading email" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve/ })).toBeDefined(), { timeout: 4000 });
    expect(reads()).toHaveLength(5);
  });

  it("unmount during the backoff makes no further read", async () => {
    script[`GET ${URL(ID)}`] = [bad];
    const { unmount } = render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(reads()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    unmount();
    await new Promise((r) => setTimeout(r, 2500));
    expect(reads()).toHaveLength(1);
  });

  it("an id change during the backoff stops the old id's retries", async () => {
    script[`GET ${URL(ID)}`] = [bad];
    script[`GET ${URL(OTHER)}`] = [ok(card(OTHER))];
    const { rerender } = render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(reads()).toHaveLength(1));
    rerender(<EmailCampaignCard rail="channel_actions" id={OTHER} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve/ })).toBeDefined());
    await new Promise((r) => setTimeout(r, 2500));
    expect(reads(ID)).toHaveLength(1);
  });

  it("jitter: the backoff is not a fixed number, so cards failing together do not retry together", async () => {
    vi.useFakeTimers();
    try {
      (Math.random as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0.999);
      script[`GET ${URL(ID)}`] = [bad];
      render(<EmailCampaignCard rail="channel_actions" id={ID} />);
      await vi.advanceTimersByTimeAsync(0);
      expect(reads()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1200);
      expect(reads()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(400);
      expect(reads()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("401 does not retry and keeps the session message", async () => {
    script[`GET ${URL(ID)}`] = [{ status: 401, body: {} }];
    render(<EmailCampaignCard rail="channel_actions" id={ID} removable />);
    await waitFor(() => expect(redBox()).toBeTruthy());
    await new Promise((r) => setTimeout(r, 2500));
    expect(reads()).toHaveLength(1);
    expect(screen.queryByTestId("email-card-not-loading")).toBeNull();
  });

  it("404 not_found does not retry and offers no Try again", async () => {
    script[`GET ${URL(ID)}`] = [{ status: 404, body: { error: { code: "not_found", message: "No such email." } } }];
    render(<EmailCampaignCard rail="channel_actions" id={ID} removable />);
    await waitFor(() => expect(redBox()).toBeTruthy());
    await new Promise((r) => setTimeout(r, 2500));
    expect(reads()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a failed refresh after a load keeps the existing banner and does not retry", async () => {
    script[`GET ${URL(ID)}`] = [ok({ ...card(ID), status: "dispatching", open: false, viewer_can_approve: false, chosen_variant: 1 }), bad];
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByText("This email could not be refreshed")).toBeDefined(), { timeout: 9000 });
    expect(screen.queryByTestId("email-card-not-loading")).toBeNull();
  }, 12000);
});

describe("Remove", () => {
  it("hides the card, posts nothing, claims nothing, and the slot stays gone after a remount", async () => {
    script[`GET ${URL(ID)}`] = [bad];
    const first = render(<EmailCampaignCard rail="channel_actions" id={ID} removable />);
    await waitFor(() => expect(screen.getByTestId("email-card-not-loading")).toBeDefined(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(first.container.innerHTML).toBe("");
    expect(writes()).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem("zavi_email_cards_hidden") ?? "[]")).toEqual([ID]);
    first.unmount();
    const second = render(<EmailCampaignCard rail="channel_actions" id={ID} removable />);
    expect(second.container.innerHTML).toBe("");
    expect(screen.queryByText(/deleted|rejected|removed/i)).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("a card that loads on a surface that does not hide it comes back", async () => {
    window.localStorage.setItem("zavi_email_cards_hidden", JSON.stringify([ID]));
    script[`GET ${URL(ID)}`] = [ok(card(ID))];
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve/ })).toBeDefined());
    expect(window.localStorage.getItem("zavi_email_cards_hidden")).toBe("[]");
  });

  it("works when localStorage throws: hidden for this page view, no crash", async () => {
    script[`GET ${URL(ID)}`] = [bad];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const view = render(<EmailCampaignCard rail="channel_actions" id={ID} removable />);
    await waitFor(() => expect(screen.getByTestId("email-card-not-loading")).toBeDefined(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(view.container.innerHTML).toBe("");
  });

  it("the single-card page (no removable): only Try again, no Remove", async () => {
    script[`GET ${URL(ID)}`] = [bad];
    render(<EmailCampaignCard rail="channel_actions" id={ID} />);
    await waitFor(() => expect(screen.getByTestId("email-card-not-loading")).toBeDefined(), { timeout: 4000 });
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Try again"]);
  });

  it("channel list host: the slot collapses, the section count drops by one, and it stays after a remount", async () => {
    const a = makeAction("send_message", { id: ID, channel_slug: "email_marketing", executable: true, email_card: true, exec_status: null });
    const b = makeAction("send_message", { id: OTHER, channel_slug: "email_marketing", executable: true, email_card: true, exec_status: null });
    script[`GET ${URL(ID)}`] = [bad];
    script[`GET ${URL(OTHER)}`] = [ok(card(OTHER))];
    const handlers = { onSetStatus: vi.fn(), onRedo: vi.fn() };
    const ui = <ChannelActionSection actions={[a, b]} platform={platformFor("email_marketing")} handlers={handlers} empty={null} />;
    const first = render(ui);
    await waitFor(() => expect(screen.getByTestId("email-card-not-loading")).toBeDefined(), { timeout: 4000 });
    expect(screen.getByTestId("section-count").textContent).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByTestId(`action-${ID}`)).toBeNull();
    expect(screen.queryByTestId("email-card-not-loading")).toBeNull();
    expect(screen.getByTestId("section-count").textContent).toBe("1");
    first.unmount();
    calls.length = 0;
    render(ui);
    expect(screen.getByTestId("section-count").textContent).toBe("1");
    expect(reads(ID)).toHaveLength(0);
    expect(writes()).toEqual([]);
  });

  it("chat host: ApprovalBlock for a hidden email decision renders nothing at all", () => {
    window.localStorage.setItem("zavi_email_cards_hidden", JSON.stringify([ID]));
    const body = { decision_id: ID, decision_class: "email_campaign.create_and_send", title: "Email", status: "pending" } as unknown as Parameters<typeof ApprovalBlock>[0]["body"];
    const { container } = render(<ApprovalBlock body={body} />);
    expect(container.innerHTML).toBe("");
    expect(calls).toEqual([]);
  });
});
