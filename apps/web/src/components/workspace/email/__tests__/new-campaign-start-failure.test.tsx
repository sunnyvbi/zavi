// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";

type Start = (init: { body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
const srv = vi.hoisted(() => ({
  starts: [] as Array<{ rid: string; signal: AbortSignal | undefined }>,
  start: null as null | Start,
}));

const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: () => Promise.resolve(body) });
const bodyless = (status: number) => ({ ok: status < 400, status, json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")) });

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string; signal?: AbortSignal }) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url === "/api/channels/email_marketing/top-actions/new_email") {
      srv.starts.push({ rid: JSON.parse(init?.body ?? "{}").request_id, signal: init?.signal });
      return srv.start!(init ?? {});
    }
    if (url === "/api/workspace/email-test-lists")
      return answer(200, {
        routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Newsletter", people: 6, marked: false, looks_like_test: false }] }],
        orphans: [],
      });
    if (url === "/api/workspace/email-template")
      return answer(200, { template: { postal_address: "1 Main St, Springfield, IL 62701", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true });
    if (url === "/api/workspace/sending-domain")
      return answer(200, { domain: { domain: "acme.com", status: "verified", from_address: "hi@acme.com", dns_records: [], last_error: null, verified_at: "2026-10-01T00:00:00Z" }, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true });
    return answer(200, {});
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));

import { NewCampaignDialog, newCampaignSession, WRITE_UNSURE, type CampaignSession } from "../NewCampaignDialog";
import { CHANNEL_RUN_STARTED_EVENT } from "../../actions/topActions/api";

async function openFilled(session: CampaignSession = newCampaignSession()) {
  const view = render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" session={session} onClose={vi.fn()} />);
  const q = within(view.container);
  fireEvent.click(await q.findByRole("radio", { name: /Newsletter/ }));
  fireEvent.change(q.getByLabelText("What should this email do?"), { target: { value: "Spring sale: 20% off until Sunday" } });
  const button = () => q.getByRole("button", { name: /Write it|Starting…/ }) as HTMLButtonElement;
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  return { q, button, session, text: () => view.container.textContent ?? "" };
}
const flush = () => act(async () => undefined);
const started = vi.fn();

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  srv.starts.length = 0;
  srv.start = null;
  started.mockReset();
  window.addEventListener(CHANNEL_RUN_STARTED_EVENT, started);
});
afterEach(() => {
  window.removeEventListener(CHANNEL_RUN_STARTED_EVENT, started);
  cleanup();
  vi.useRealTimers();
});

describe("Write it: a start that fails with no readable reason", () => {
  it("a 502 with no body shows the plain sentence, never HTTP 502, and keeps the press's request id", async () => {
    srv.start = async () => bodyless(502);
    const d = await openFilled();
    const pressedWith = d.session.runId;
    fireEvent.click(d.button());
    const shown = await d.q.findByText(WRITE_UNSURE);
    expect(shown).toBeTruthy();
    expect(d.text()).not.toMatch(/HTTP|502/);
    expect(d.button().textContent).toBe("Write it");
    expect(d.button().disabled).toBe(false);
    expect(srv.starts.map((s) => s.rid)).toEqual([pressedWith]);
    expect(d.session.runId).toBe(pressedWith);
    expect(started).not.toHaveBeenCalled();
  });

  it("a fetch that rejects with TypeError Failed to fetch shows the plain sentence, not the browser's words", async () => {
    srv.start = async () => {
      throw new TypeError("Failed to fetch");
    };
    const d = await openFilled();
    const pressedWith = d.session.runId;
    fireEvent.click(d.button());
    await d.q.findByText(WRITE_UNSURE);
    expect(d.text()).not.toMatch(/Failed to fetch|TypeError/);
    expect(d.button().textContent).toBe("Write it");
    expect(d.session.runId).toBe(pressedWith);
    expect(started).not.toHaveBeenCalled();
  });

  it("a request that never answers: after 30 seconds the button leaves Starting… and the sentence shows, and the request is aborted", async () => {
    srv.start = () => new Promise(() => undefined);
    const d = await openFilled();
    vi.useFakeTimers();
    fireEvent.click(d.button());
    await flush();
    expect(d.button().textContent).toBe("Starting…");
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(d.button().textContent).toBe("Starting…");
    expect(d.text()).not.toContain(WRITE_UNSURE);
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(d.button().textContent).toBe("Write it");
    expect(d.button().disabled).toBe(false);
    expect(d.text()).toContain(WRITE_UNSURE);
    expect(srv.starts).toHaveLength(1);
    expect(srv.starts[0].signal).toBeInstanceOf(AbortSignal);
    expect(started).not.toHaveBeenCalled();
  });

  it("a retry after a timeout sends the same request id, and only the success rotates it", async () => {
    let hang = true;
    srv.start = () => (hang ? new Promise(() => undefined) : Promise.resolve(answer(200, { run_id: "run-1" })));
    const d = await openFilled();
    const pressedWith = d.session.runId;
    vi.useFakeTimers();
    fireEvent.click(d.button());
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(d.text()).toContain(WRITE_UNSURE);
    expect(d.session.runId).toBe(pressedWith);
    hang = false;
    fireEvent.click(d.button());
    await flush();
    await flush();
    expect(srv.starts.map((s) => s.rid)).toEqual([pressedWith, pressedWith]);
    expect(d.text()).toContain("Zavi is writing it");
    expect(started).toHaveBeenCalledTimes(1);
    expect(d.session.runId).not.toBe(pressedWith);
  });

  it("a refusal with the server's own reason still shows that reason and starts a fresh request next time", async () => {
    srv.start = async () => answer(400, { error: { code: "list_empty", message: "That list has nobody on it." } });
    const d = await openFilled();
    const pressedWith = d.session.runId;
    fireEvent.click(d.button());
    await d.q.findByText("That list has nobody on it.");
    expect(d.text()).not.toContain(WRITE_UNSURE);
    expect(d.session.runId).not.toBe(pressedWith);
  });
  it("presses that each end still starting (no run id) keep the request id, so the run the server finally hands back is the first press's", async () => {
    let fresh: string | null = null;
    srv.start = async (init) => {
      const rid = JSON.parse(init.body ?? "{}").request_id;
      return answer(200, { ok: true, run_id: fresh !== null && rid === fresh ? "run-1" : null, stamped: false, duplicate: true });
    };
    const d = await openFilled();
    const first = d.session.runId;
    vi.useFakeTimers();
    for (let press = 1; press <= 3; press++) {
      fireEvent.click(d.button());
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(d.text()).toContain("Zavi is still starting this");
      expect(d.button().textContent).toBe("Write it");
      expect(d.session.runId).toBe(first);
    }
    expect(new Set(srv.starts.map((s) => s.rid))).toEqual(new Set([first]));
    expect(srv.starts).toHaveLength(12);
    expect(started).toHaveBeenCalledTimes(3);
    fresh = first;
    fireEvent.click(d.button());
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    const fourth = srv.starts[12].rid;
    expect(fourth).toBe(first);
    expect(srv.starts).toHaveLength(13);
    expect(d.text()).toContain("Zavi is writing it");
    expect(started).toHaveBeenCalledTimes(4);
  });

  it("a still-starting press followed by a timeout does not count toward the switch: the count is of consecutive still-starting presses", async () => {
    let mode: "stuck" | "hang" = "stuck";
    srv.start = () => (mode === "hang" ? new Promise(() => undefined) : Promise.resolve(answer(200, { ok: true, run_id: null, duplicate: true })));
    const d = await openFilled();
    const first = d.session.runId;
    vi.useFakeTimers();
    for (const m of ["stuck", "stuck", "hang", "stuck", "stuck"] as const) {
      mode = m;
      fireEvent.click(d.button());
      await act(() => vi.advanceTimersByTimeAsync(31_000));
    }
    expect(new Set(srv.starts.map((s) => s.rid))).toEqual(new Set([first]));
    expect(d.session.runId).toBe(first);
  });
});
