// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Answer = { status: number; body: unknown } | "lost";
const srv = vi.hoisted(() => ({
  keys: [] as string[],
  cards: 0,
  minted: 0,
  stored: new Map<string, { status: number; body: unknown }>(),
  plan: [] as Array<{ writes: boolean; answer: Answer }>,
  routes: {} as Record<string, { status: number; body: unknown }>,
}));
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? "GET";
    if (`${method} ${url}` === "POST /api/email-cards/paste") {
      const key = init?.headers?.["Idempotency-Key"] ?? `auto-${++srv.minted}`;
      srv.keys.push(key);
      const replay = srv.stored.get(key);
      if (replay) return { ok: replay.status < 400, status: replay.status, json: () => Promise.resolve(replay.body) };
      const step = srv.plan.length > 1 ? srv.plan.shift()! : (srv.plan[0] ?? { writes: true, answer: { status: 200, body: card() } });
      if (step.writes) srv.cards += 1;
      const answer: { status: number; body: unknown } = step.answer === "lost" ? { status: 200, body: card() } : step.answer;
      if (answer.status < 400 || answer.status >= 500) srv.stored.set(key, answer);
      if (step.answer === "lost") throw new TypeError("Failed to fetch");
      return { ok: answer.status < 400, status: answer.status, json: () => Promise.resolve(answer.body) };
    }
    const r = srv.routes[`${method} ${url}`] ?? { status: 200, body: { ok: true } };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));

import { NewCampaignDialog, PASTE_DONE } from "../NewCampaignDialog";
import { HTML_SOURCE_WARNING, mergeTagIn, pastedWithLinks } from "../pasteText";

const CARD_LINK = "/w/acme/channels/email_marketing?card=card-7";
function card() {
  return { ok: true, card: { rail: "channel_actions", id: "card-7" }, link: CARD_LINK, route: "mailchimp", versions: 1 };
}
const BODY = "Hi there,\n\nOur spring sale starts Friday.\n\nSee you soon.";
const primary = () => screen.getByRole("button", { name: /Add it for approval/ }) as HTMLButtonElement;

async function fillPaste(body = BODY) {
  render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("radio", { name: /Paying customers/ }));
  fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
  fireEvent.change(screen.getByLabelText("Email body"), { target: { value: body } });
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring sale" } });
}
async function send() {
  await waitFor(() => expect(primary().disabled).toBe(false));
  const before = srv.keys.length;
  fireEvent.click(primary());
  await waitFor(() => expect(srv.keys.length).toBe(before + 1));
  await waitFor(() => expect(primary().disabled).toBe(false));
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  srv.keys.length = 0;
  srv.cards = 0;
  srv.minted = 0;
  srv.stored.clear();
  srv.plan.length = 0;
  for (const k of Object.keys(srv.routes)) delete srv.routes[k];
  srv.routes["GET /api/workspace/email-test-lists"] = {
    status: 200,
    body: {
      routes: [{ route: "mailchimp", label: "Mailchimp", status: "complete", error: null, lists: [{ id: "L1", name: "Paying customers", people: 300, marked: false, looks_like_test: false }] }],
      orphans: [],
    },
  };
  srv.routes["GET /api/workspace/email-template"] = { status: 200, body: { template: { postal_address: "1 Main St, Springfield, IL 62701", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true } };
  srv.routes["GET /api/channels/email_marketing/settings"] = { status: 200, body: { fields: {} } };
  srv.routes["GET /api/workspace/sending-domain"] = {
    status: 200,
    body: { domain: { domain: "acme.com", status: "verified", from_address: "hi@acme.com", dns_records: [], last_error: null, verified_at: "2026-10-01T00:00:00Z" }, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true },
  };
});
afterEach(() => cleanup());

describe("Paste my email: a retry never files a second card", () => {
  it("the card was written but the answer was lost: the retry sends the same key, the server replays it, one card, and the founder lands on it", async () => {
    srv.plan.push({ writes: true, answer: "lost" }, { writes: true, answer: { status: 200, body: card() } });
    await fillPaste();
    await send();
    expect(await screen.findByText(/could not reach Zavi/)).toBeTruthy();
    expect(srv.cards).toBe(1);
    fireEvent.click(primary());
    expect(await screen.findByText(PASTE_DONE)).toBeTruthy();
    expect(srv.keys).toHaveLength(2);
    expect(srv.keys[1]).toBe(srv.keys[0]);
    expect(srv.cards).toBe(1);
    expect((screen.getByRole("link", { name: "Open the email" }) as HTMLAnchorElement).getAttribute("href")).toBe(CARD_LINK);
  });

  it("a 500 after the card was written: pressing again replays the stored answer and files nothing new", async () => {
    srv.plan.push({ writes: true, answer: { status: 500, body: { error: { code: "paste_failed", message: "Zavi could not add this. Try again." } } } }, { writes: true, answer: { status: 200, body: card() } });
    await fillPaste();
    await send();
    await send();
    await send();
    expect(new Set(srv.keys).size).toBe(1);
    expect(srv.cards).toBe(1);
  });

  it("an edited email is a new ask and gets a new key", async () => {
    srv.plan.push({ writes: false, answer: { status: 500, body: { error: { code: "paste_failed", message: "Try again." } } } }, { writes: true, answer: { status: 200, body: card() } });
    await fillPaste();
    await send();
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: `${BODY}\n\nP.S. Bring a friend.` } });
    fireEvent.click(primary());
    expect(await screen.findByText(PASTE_DONE)).toBeTruthy();
    expect(srv.keys).toHaveLength(2);
    expect(srv.keys[1]).not.toBe(srv.keys[0]);
    expect(srv.cards).toBe(1);
  });

  it("a definite refusal frees the ask: the same email sent again gets a fresh key and goes through", async () => {
    srv.plan.push({ writes: false, answer: { status: 409, body: { error: { code: "email_list_busy", message: "That list is busy. Try again." } } } }, { writes: true, answer: { status: 200, body: card() } });
    await fillPaste();
    await send();
    expect(await screen.findByText(/list is busy/)).toBeTruthy();
    fireEvent.click(primary());
    expect(await screen.findByText(PASTE_DONE)).toBeTruthy();
    expect(srv.keys[1]).not.toBe(srv.keys[0]);
    expect(srv.cards).toBe(1);
  });

  it("idempotency_in_progress is not a refusal: the retry keeps the key so the running paste is not doubled", async () => {
    srv.plan.push({ writes: true, answer: { status: 409, body: { error: { code: "idempotency_in_progress", message: "Still adding it." } } } }, { writes: true, answer: { status: 200, body: card() } });
    await fillPaste();
    await send();
    fireEvent.click(primary());
    expect(await screen.findByText(PASTE_DONE)).toBeTruthy();
    expect(srv.keys).toHaveLength(2);
    expect(srv.keys[1]).toBe(srv.keys[0]);
  });
});

describe("Paste my email: what Zavi sends as typed", () => {
  it("warns about a merge tag in the body or subject, and still lets the founder add it", async () => {
    await fillPaste("Hi {{first_name}},\n\nOur sale starts Friday.");
    expect(screen.getByRole("note").textContent).toBe("Zavi sends your words as written, so {{first_name}} would reach people as typed. Remove it or write the greeting out.");
    await waitFor(() => expect(primary().disabled).toBe(false));
    fireEvent.click(primary());
    expect(await screen.findByText(PASTE_DONE)).toBeTruthy();
    expect(srv.cards).toBe(1);
  });

  it("no warning for plain words, and none for a lone brace", async () => {
    await fillPaste("Hi there, the {sale} starts Friday.");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("warns when the body is HTML source", async () => {
    await fillPaste('<table><tr><td><p>Our sale</p></td></tr></table>');
    expect(screen.getByRole("note").textContent).toBe(HTML_SOURCE_WARNING);
  });

  it("pasting formatted text keeps each link's target next to its words", async () => {
    await fillPaste("");
    const box = screen.getByLabelText("Email body") as HTMLTextAreaElement;
    const clip: Record<string, string> = {
      "text/html": '<p>Our sale starts Friday. <a href="https://acme.com/sale">Shop the sale</a> or <a href="https://acme.com/faq">read the FAQ</a>.</p>',
      "text/plain": "Our sale starts Friday. Shop the sale or read the FAQ.",
    };
    fireEvent.paste(box, { clipboardData: { getData: (t: string) => clip[t] ?? "" } });
    expect(box.value).toBe("Our sale starts Friday. Shop the sale (https://acme.com/sale) or read the FAQ (https://acme.com/faq).");
    await waitFor(() => expect(primary().disabled).toBe(false));
    fireEvent.click(primary());
    expect(await screen.findByText(PASTE_DONE)).toBeTruthy();
  });
});

describe("pasteText", () => {
  it("finds merge tags of the common senders, and ignores single braces", () => {
    expect(mergeTagIn("Hi {{ first_name }}")).toBe("{{ first_name }}");
    expect(mergeTagIn("plain", "Hey *|FNAME|*")).toBe("*|FNAME|*");
    expect(mergeTagIn("{% if vip %}")).toBe("{% if vip %}");
    expect(mergeTagIn("a {b} c", "")).toBeNull();
  });

  it("leaves a paste alone when its links already show, are not http, or match their words", () => {
    expect(pastedWithLinks('<a href="https://a.co">https://a.co</a>', "https://a.co")).toBeNull();
    expect(pastedWithLinks('<a href="mailto:x@a.co">mail us</a>', "mail us")).toBeNull();
    expect(pastedWithLinks('<a href="https://a.co/x">go</a>', "go (https://a.co/x)")).toBeNull();
    expect(pastedWithLinks("", "go")).toBeNull();
    expect(pastedWithLinks('<a href="https://a.co/x">go</a> then <a href="https://a.co/y">go</a>', "go then go")).toBe("go (https://a.co/x) then go (https://a.co/y)");
  });
});
