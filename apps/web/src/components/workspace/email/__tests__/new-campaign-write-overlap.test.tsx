// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";

type Claim = { run: string; visible: boolean };
const srv = vi.hoisted(() => ({
  calls: [] as Array<{ rid: string; brief: string }>,
  claims: new Map<string, { run: string; visible: boolean }>(),
  runs: 0,
  lagNext: false,
  hold: null as null | Promise<void>,
  routes: {} as Record<string, { status: number; body: unknown }>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string }) => {
    const r = srv.routes[`${init?.method ?? "GET"} ${url}`] ?? { status: 200, body: { ok: true } };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("../../actions/topActions/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions/topActions/api")>()),
  startTopAction: async (_slug: string, _key: string, rid: string, inputs: Record<string, unknown>) => {
    srv.calls.push({ rid, brief: String(inputs.brief) });
    const known: Claim | undefined = srv.claims.get(rid);
    if (known) return { run_id: known.visible ? known.run : null, duplicate: true };
    const claim: Claim = { run: `run-${++srv.runs}`, visible: false };
    srv.claims.set(rid, claim);
    if (srv.lagNext) {
      srv.lagNext = false;
      queueMicrotask(() => (claim.visible = true));
      return { run_id: null, duplicate: true };
    }
    const gate = srv.hold;
    srv.hold = null;
    if (gate) await gate;
    claim.visible = true;
    return { run_id: claim.run };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));

import { NewCampaignDialog, newCampaignSession, type CampaignSession } from "../NewCampaignDialog";
import { CHANNEL_RUN_STARTED_EVENT } from "../../actions/topActions/api";

async function openFilled(session: CampaignSession, brief: string) {
  const view = render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" session={session} onClose={vi.fn()} />);
  const q = within(view.container);
  fireEvent.click(await q.findByRole("radio", { name: /Paying customers/ }));
  fireEvent.change(q.getByLabelText("What should this email do?"), { target: { value: brief } });
  const button = q.getByRole("button", { name: /Write it/ }) as HTMLButtonElement;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  return { q, button };
}
const flush = () => act(async () => undefined);
const ridsOf = (brief: string) => srv.calls.filter((c) => c.brief === brief).map((c) => c.rid);
const distinct = () => new Set(srv.calls.map((c) => c.rid)).size;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  srv.calls.length = 0;
  srv.claims.clear();
  srv.runs = 0;
  srv.lagNext = false;
  srv.hold = null;
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Write it: one press is one request id across all of its retries", () => {
  it("a duplicate answer, then a sibling press of the same email succeeds and rotates the session: the retry keeps the press's id and no second paid run starts", async () => {
    const session = newCampaignSession();
    const first = await openFilled(session, "Spring sale");
    const sibling = await openFilled(session, "Spring sale");
    const started = vi.fn();
    window.addEventListener(CHANNEL_RUN_STARTED_EVENT, started);
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    srv.hold = new Promise<void>((r) => (release = r));
    fireEvent.click(sibling.button);
    await flush();
    fireEvent.click(first.button);
    await flush();
    expect(srv.calls).toHaveLength(2);
    expect(srv.calls[1].rid).toBe(srv.calls[0].rid);
    const pressed = srv.calls[0].rid;
    await act(async () => release());
    expect(session.runId).not.toBe(pressed);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await act(() => vi.advanceTimersByTimeAsync(1500 * 3));
    expect(srv.calls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(srv.calls.map((c) => c.rid))).toEqual(new Set([pressed]));
    expect(srv.runs).toBe(1);
    expect(first.q.getByText(/Zavi is writing it/)).toBeTruthy();
    expect(sibling.q.getByText(/Zavi is writing it/)).toBeTruthy();
    window.removeEventListener(CHANNEL_RUN_STARTED_EVENT, started);
  });

  it("a duplicate answer, then a sibling press of a different email succeeds in between: the first press retries with its own id, so distinct ids equal presses", async () => {
    const session = newCampaignSession();
    const first = await openFilled(session, "Spring sale");
    const sibling = await openFilled(session, "Summer sale");
    vi.useFakeTimers();
    srv.lagNext = true;
    fireEvent.click(first.button);
    await flush();
    expect(srv.calls).toHaveLength(1);
    fireEvent.click(sibling.button);
    await flush();
    expect(sibling.q.getByText(/Zavi is writing it/)).toBeTruthy();
    const firstRid = srv.calls[0].rid;
    const siblingRid = ridsOf("Summer sale")[0];
    expect(siblingRid).not.toBe(firstRid);
    expect(session.runId).not.toBe(firstRid);
    expect(session.runId).not.toBe(siblingRid);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await act(() => vi.advanceTimersByTimeAsync(1500 * 3));
    const firstRids = ridsOf("Spring sale");
    expect(firstRids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(firstRids)).toEqual(new Set([firstRid]));
    expect(distinct()).toBe(2);
    expect(srv.runs).toBe(2);
    expect(first.q.getByText(/Zavi is writing it/)).toBeTruthy();
  });

  it("the first press finishing does not rotate the id a later, different press is still holding", async () => {
    const session = newCampaignSession();
    const first = await openFilled(session, "Spring sale");
    const sibling = await openFilled(session, "Summer sale");
    vi.useFakeTimers();
    srv.lagNext = true;
    fireEvent.click(first.button);
    await flush();
    let release: () => void = () => undefined;
    srv.hold = new Promise<void>((r) => (release = r));
    fireEvent.click(sibling.button);
    await flush();
    const siblingRid = ridsOf("Summer sale")[0];
    expect(session.runId).toBe(siblingRid);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(first.q.getByText(/Zavi is writing it/)).toBeTruthy();
    expect(session.runId).toBe(siblingRid);
    expect(session.lastAsk).not.toBeNull();
    await act(async () => release());
    expect(session.runId).not.toBe(siblingRid);
    expect(distinct()).toBe(2);
  });

  it("a double click on Write it before React re-renders is one press: one call, one id, one run, one run-started", async () => {
    const session = newCampaignSession();
    const only = await openFilled(session, "Spring sale");
    const started = vi.fn();
    window.addEventListener(CHANNEL_RUN_STARTED_EVENT, started);
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    srv.hold = new Promise<void>((r) => (release = r));
    act(() => {
      only.button.click();
      only.button.click();
    });
    await flush();
    await act(async () => release());
    await act(() => vi.advanceTimersByTimeAsync(1500 * 4));
    expect(srv.calls).toHaveLength(1);
    expect(distinct()).toBe(1);
    expect(srv.runs).toBe(1);
    expect(started).toHaveBeenCalledTimes(1);
    expect(only.q.getByText(/Zavi is writing it/)).toBeTruthy();
    window.removeEventListener(CHANNEL_RUN_STARTED_EVENT, started);
  });
});
