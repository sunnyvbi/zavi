// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ job: null as unknown, calls: [] as Array<[string, unknown[]]>, jobImpl: null as null | (() => Promise<unknown>) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return {
    ...actual,
    creatorApi: new Proxy(
      {},
      {
        get: (_t, key: string) => {
          if (key === "jobs") return async () => ({ jobs: [h.job] });
          if (key === "job") return () => (h.jobImpl ? h.jobImpl() : Promise.resolve({ job: h.job }));
          return async (...args: unknown[]) => {
            h.calls.push([key, args]);
            return { messages: [], offers: [], ok: true };
          };
        },
      },
    ),
  };
});

import { CreatorJobsScreen, JOB_REFRESH_MS, jobBucket, viewFor } from "./CreatorJobs";

const job = (over: Record<string, unknown> = {}) => ({
  id: "o1",
  source: "booking",
  status: "in_progress",
  closed_reason: null,
  created_at: "2026-10-22T05:14:42Z",
  due_at: "2026-10-25T05:16:26Z",
  accepted_at: "2026-10-22T05:16:26Z",
  closed_at: null,
  extension_state: null,
  extension_requested_due_at: null,
  package: { title: "3 * Post", kind: "audience_post" },
  brief: null,
  currency: "usd",
  price_cents: 300,
  creator_fee_cents: 45,
  creator_payout_cents: 255,
  amount_cents: 255,
  part_paid: false,
  payout_status: "not_due",
  payout_ready_at: null,
  deadline: null,
  submissions: [],
  has_thread: false,
  business_name: "UpcarAI",
  revisions_used: 0,
  revisions_max: 2,
  ...over,
});

afterEach(() => {
  cleanup();
  h.jobImpl = null;
});

describe("a creator's own extension request", () => {
  it("after asking, the job says so clearly and offers no second ask", async () => {
    h.job = job({ extension_state: "requested", extension_requested_due_at: "2026-10-27T05:16:26Z" });
    render(<CreatorJobsScreen orderId="o1" />);
    const panel = await screen.findByTestId("extension-requested");
    expect(panel.textContent).toContain("You asked for 2 more days. Waiting for UpcarAI.");
    expect(panel.className).toContain("bg-setup-cool");
    expect(panel.className).not.toMatch(/sky-\d/);
    expect(panel.textContent).toContain("If UpcarAI approves, your draft is due");
    expect(screen.queryByRole("button", { name: "Ask for more time" })).toBeNull();
  });

  it("before asking, the button is there and there is no request panel", async () => {
    h.job = job();
    render(<CreatorJobsScreen orderId="o1" />);
    expect(await screen.findByRole("button", { name: "Ask for more time" })).toBeTruthy();
    expect(screen.queryByTestId("extension-requested")).toBeNull();
  });
});

describe("after asking Zavi for help", () => {
  it("shows what was asked, does not claim a draft was sent, and counts the job as in progress", async () => {
    h.job = job({ status: "in_dispute", help_request: { reason: "What is the market price for this type of brief?", opened_at: "2026-10-22T05:33:21Z" } });
    render(<CreatorJobsScreen orderId="o1" />);
    const asked = await screen.findByTestId("help-request");
    expect(asked.textContent).toContain("\u201cWhat is the market price for this type of brief?\u201d");
    expect(asked.textContent).toContain("Zavi emails you both when it decides.");
    expect(document.body.textContent).not.toMatch(/reply in Messages|may message you/);
    const steps = viewFor("in_dispute", h.job as never, "UpcarAI");
    expect(steps.done).toBe(2);
    expect(viewFor("in_dispute", { ...(h.job as object), submissions: [{ id: "s1" }] } as never, "UpcarAI").done).toBe(3);
    expect(jobBucket(h.job as never)).toBe("in_progress");
  });

  it("while the draft is being made there is no step-in button: nothing is in dispute yet", async () => {
    for (const status of [{ status: "in_progress" }, { status: "in_progress", due_at: "2026-10-01T00:00:00Z" }]) {
      h.job = job(status);
      render(<CreatorJobsScreen orderId="o1" />);
      await screen.findByTestId("deliver-input");
      expect(screen.queryByRole("button", { name: /Ask Zavi/ })).toBeNull();
      cleanup();
    }
  });

  it("after the draft is sent, Ask Zavi to step in warns first and only then opens the dispute", async () => {
    h.calls = [];
    h.job = job({ status: "submitted", submissions: [{ id: "s1", version: 1, position: 0, kind: "video", mime_type: "video/mp4", bytes: 1, note: null, created_at: "2026-10-22T06:00:00Z" }] });
    render(<CreatorJobsScreen orderId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask Zavi to step in" }));
    expect(screen.getByTestId("help-warning").textContent).toContain("the job and its money pause until they decide");
    expect(h.calls.some(([k]) => k === "askZaviForHelp")).toBe(false);
    fireEvent.change(screen.getByLabelText("What should Zavi look at?"), { target: { value: "UpcarAI asks for work outside the order." } });
    fireEvent.click(screen.getByRole("button", { name: "Pause the job and ask Zavi" }));
    await screen.findByRole("button", { name: "Ask Zavi to step in" });
    expect(h.calls.filter(([k]) => k === "askZaviForHelp")).toEqual([["askZaviForHelp", ["o1", "UpcarAI asks for work outside the order."]]]);
    expect(h.calls.some(([k]) => k === "sendMessage")).toBe(false);
  });
});

describe("the business answers while the creator has the job open", () => {
  it("a decline shows on its own within the refresh, without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.job = job({ extension_state: "requested", extension_requested_due_at: "2026-10-28T05:36:15Z" });
    render(<CreatorJobsScreen orderId="o1" />);
    expect(await screen.findByTestId("extension-requested")).toBeTruthy();
    h.job = job({ extension_state: "declined", extension_requested_due_at: "2026-10-28T05:36:15Z" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_REFRESH_MS);
    });
    expect(screen.queryByTestId("extension-requested")).toBeNull();
    expect(screen.getByText(/UpcarAI kept the original due date/)).toBeTruthy();
    vi.useRealTimers();
  });

  it("coming back to the tab re-reads the job at once", async () => {
    h.job = job({ extension_state: "requested", extension_requested_due_at: "2026-10-28T05:36:15Z" });
    render(<CreatorJobsScreen orderId="o1" />);
    expect(await screen.findByTestId("extension-requested")).toBeTruthy();
    h.job = job({ extension_state: "declined", extension_requested_due_at: "2026-10-28T05:36:15Z" });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText(/UpcarAI kept the original due date/)).toBeTruthy();
  });
});

describe("the business's answer on the creator's job", () => {
  it("declined and approved each get their own clear panel", async () => {
    h.job = job({ extension_state: "declined" });
    render(<CreatorJobsScreen orderId="o1" />);
    expect((await screen.findByTestId("extension-declined")).textContent).toContain("UpcarAI kept the original due date");
    cleanup();
    h.job = job({ extension_state: "approved", due_at: "2026-10-28T05:36:15Z" });
    render(<CreatorJobsScreen orderId="o1" />);
    expect((await screen.findByTestId("extension-approved")).textContent).toContain("UpcarAI gave you more time. Your draft is now due");
    expect(screen.queryByRole("button", { name: "Ask for more time" })).toBeNull();
  });
});

describe("two refreshes in flight at once", () => {
  it("a slow older answer never puts back a state the newer answer already replaced", async () => {
    h.job = job({ extension_state: "requested", extension_requested_due_at: "2026-10-28T05:36:15Z" });
    render(<CreatorJobsScreen orderId="o1" />);
    expect(await screen.findByTestId("extension-requested")).toBeTruthy();

    let releaseSlow: (v: unknown) => void = () => {};
    const stale = { job: job({ extension_state: "requested", extension_requested_due_at: "2026-10-28T05:36:15Z" }) };
    const fresh = { job: job({ extension_state: "declined", extension_requested_due_at: "2026-10-28T05:36:15Z" }) };
    const answers = [new Promise((r) => (releaseSlow = r)), Promise.resolve(fresh)];
    h.jobImpl = () => answers.shift() ?? Promise.resolve(fresh);
    h.job = fresh.job;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByTestId("extension-declined")).toBeTruthy();

    await act(async () => {
      releaseSlow(stale);
      await Promise.resolve();
    });
    expect(screen.queryByTestId("extension-requested")).toBeNull();
    expect(screen.getByTestId("extension-declined")).toBeTruthy();
  });
});
