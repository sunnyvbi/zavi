// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";
import { briefRow, ChannelHumanLane, jobRow } from "./ChannelHumanLane";
import type { CreatorJobSummary } from "@/components/humans/creatorJobTypes";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const byId = (slug: string) => (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!;

const BRIEF = {
  id: "b1",
  title: "Spring menu launch",
  utm_campaign: null,
  status: "sent",
  deliverables: 1,
  created_at: "2026-09-01T00:00:00Z",
  match_count: null,
  application_count: 3,
  engagement_count: 0,
  posted_at: "2026-09-22T00:00:00Z",
  answer_by: "2026-10-02T00:00:00Z",
  closed_at: null,
};

function job(over: Partial<CreatorJobSummary> = {}): CreatorJobSummary {
  return {
    id: "o1",
    source: "booking",
    status: "submitted",
    closed_reason: null,
    title: "1 video for your ads",
    creator_display_name: "Maya Films",
    creator_slug: null,
    created_at: "2026-09-20T00:00:00Z",
    due_at: "2026-09-30T00:00:00Z",
    money: {
      currency: "usd",
      price_cents: 15000,
      business_fee_cents: 1500,
      business_total_cents: 16500,
      business_fee_label: "10%",
      creator_payout_cents: 12750,
      payout_status: "held",
    },
    deadline: { kind: "review", deadline_at: "2026-09-28T00:00:00Z", deadline_text: "", consequence_text: "", line: "" },
    awaiting_creator: false,
    ...over,
  };
}

function respond(briefs: unknown[], jobs: unknown[]) {
  apiFetch.mockImplementation((path: string) =>
    Promise.resolve({
      ok: true,
      json: async () => (String(path).includes("/orders") ? { jobs } : { briefs }),
    }),
  );
}

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  respond([], []);
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=ugc");
});

describe("ChannelHumanLane", () => {
  it("renders nothing, and fetches nothing, on a channel with no human lane", () => {
    for (const slug of ["generated_video", "meta_ads"]) {
      const { container } = render(<ChannelHumanLane channel={byId(slug)} />);
      expect(container.innerHTML).toBe("");
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("renders Your creators on ugc from briefs and jobs", async () => {
    respond([BRIEF], [job({ revisions_used: 1 })]);
    render(<ChannelHumanLane channel={byId("ugc")} />);
    expect(await screen.findByText("Your creators")).toBeTruthy();
    expect(await screen.findByText("Spring menu launch")).toBeTruthy();
    expect(screen.getByLabelText("3 applied · answer by Oct 2")).toBeTruthy();
    expect(screen.getByText("Maya Films: 1 video for your ads")).toBeTruthy();
    expect(screen.getByText("Delivered, review it")).toBeTruthy();
    expect(screen.getByText("Review by Sep 28, 00:00 UTC · 1 of 2 changes used")).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith("/api/humans/briefs");
    expect(apiFetch).toHaveBeenCalledWith("/api/humans/orders");
  });

  it("opens a side drawer over the channel instead of leaving for /humans", async () => {
    respond([BRIEF], [job()]);
    render(<ChannelHumanLane channel={byId("ugc")} />);
    fireEvent.click(await screen.findByText("Spring menu launch"));
    expect(window.location.search).toBe("?tab=channels&channel=ugc&drawer=applicants&brief=b1");
    expect(screen.queryByText("Find creators")).toBeNull();
  });

  it("makes the whole row one button: its status and line open the same drawer as the title", async () => {
    respond([BRIEF], []);
    render(<ChannelHumanLane channel={byId("ugc")} />);
    const row = (await screen.findByText("Spring menu launch")).closest("button") as HTMLButtonElement;
    expect(row.textContent).toContain("Brief");
    expect(row.textContent).toContain("3 applied");
    expect(row.textContent).toContain("answer by Oct 2");
    expect(row.textContent).toContain("Open");
    expect(row.closest("button")?.querySelector("u, .underline")).toBeNull();
    fireEvent.click(screen.getByText("answer by Oct 2"));
    expect(window.location.search).toBe("?tab=channels&channel=ugc&drawer=applicants&brief=b1");
  });

  it("folds and unfolds from its heading, and starts unfolded", async () => {
    respond([BRIEF], []);
    render(<ChannelHumanLane channel={byId("ugc")} />);
    expect(await screen.findByText("Spring menu launch")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /Your creators/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Spring menu launch")).toBeNull();
    expect(screen.queryByText(/Briefs you posted and the jobs running/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Spring menu launch")).toBeTruthy();
  });

  it("says the jobs failed to load instead of showing no jobs", async () => {
    apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        String(path).includes("/orders")
          ? { ok: false, status: 503, json: async () => ({}) }
          : { ok: true, json: async () => ({ briefs: [BRIEF] }) },
      ),
    );
    render(<ChannelHumanLane channel={byId("ugc")} />);
    expect(await screen.findByText(/Couldn.t load your jobs just now/)).toBeTruthy();
    expect(screen.getByText("Spring menu launch")).toBeTruthy();
    expect(screen.queryByText(/No briefs or jobs yet/)).toBeNull();
  });

  it("lists finished work under the running rows, five at a time, never an empty state beside real jobs", async () => {
    respond(
      [{ ...BRIEF, id: "old", title: "Old brief", closed_at: "2026-09-10T00:00:00Z" }],
      [
        job({ id: "done1", status: "completed", closed_reason: "approved", title: "Done one" }),
        job({ id: "run1", status: "in_progress", title: "Running one", deadline: null }),
        job({ id: "done2", status: "completed", closed_reason: "auto_accepted", title: "Done two" }),
        job({ id: "done3", status: "cancelled", closed_reason: "mediation_refund", title: "Done three" }),
        job({ id: "done4", status: "completed", closed_reason: "approved", title: "Done four" }),
        job({ id: "unpaid", status: "cancelled", closed_reason: "checkout_abandoned", title: "Never paid" }),
      ],
    );
    render(<ChannelHumanLane channel={byId("ugc")} />);
    const first = await screen.findByText("Maya Films: Running one");
    expect(first).toBeTruthy();
    expect(screen.queryByText(/No briefs or jobs yet/)).toBeNull();
    expect(screen.queryByText("Maya Films: Never paid")).toBeNull();
    expect(screen.getByText("Show more")).toBeTruthy();
    expect(screen.queryByText("Old brief")).toBeNull();
    fireEvent.click(screen.getByText("Show more"));
    expect(screen.getByText("Old brief")).toBeTruthy();
    fireEvent.click(screen.getByText("Show less"));
    expect(screen.queryByText("Old brief")).toBeNull();
  });

  it("says there is nothing yet rather than rendering an empty list", async () => {
    render(<ChannelHumanLane channel={byId("ugc")} />);
    expect(await screen.findByText(/No briefs or jobs yet/i)).toBeTruthy();
  });
});

describe("jobRow", () => {
  it("names the product step while the product has not arrived", () => {
    const r = jobRow(job({ status: "in_progress", product_needed: true, product_received_at: null }));
    expect(r?.status).toBe("Waiting for your product");
    expect(r?.line).toBe("Send Maya the product. The due date starts when Maya marks it received.");
  });

  it("keeps finished jobs, marked done, and says why they closed", () => {
    const done = jobRow(job({ status: "completed", closed_reason: "auto_accepted", closed_at: "2026-09-22T00:00:00Z" }));
    expect(done).toMatchObject({ status: "Accepted automatically", tone: "quiet", line: "Closed Sep 22", drawer: "review", done: true });
    expect(jobRow(job({ status: "cancelled", closed_reason: "no_show" }))).toMatchObject({ status: "Not delivered, refunded", drawer: "job", done: true });
  });

  it("never lists an order nobody paid for", () => {
    expect(jobRow(job({ status: "checkout_pending" }))).toBeNull();
    expect(jobRow(job({ status: "cancelled", closed_reason: "checkout_abandoned" }))).toBeNull();
  });

  it("lists only briefs you posted: a draft is a Next steps card, not a posted brief", () => {
    expect(briefRow({ ...BRIEF, posted_at: null, status: "draft" })).toBeNull();
    expect(briefRow(BRIEF)?.status).toBe("Open");
  });

  it("keeps a posted brief that closed, after the running ones", () => {
    expect(briefRow({ ...BRIEF, closed_at: "2026-09-25T00:00:00Z" })).toMatchObject({ status: "Closed", line: "3 applied · closed Sep 25", done: true });
    expect(briefRow({ ...BRIEF, status: "filled", closed_at: "2026-09-25T00:00:00Z" })?.status).toBe("Hired");
  });
});

describe("Your creators rows", () => {
  it("read as a primary list: large title, roomy row, readable status", async () => {
    apiFetch.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () => (path === "/api/humans/briefs" ? { briefs: [BRIEF] } : { jobs: [] }),
    }));
    render(<ChannelHumanLane channel={byId("ugc")} />);
    const title = await screen.findByText("Spring menu launch");
    expect(title.className).toContain("text-[17px]");
    expect(title.className).toContain("font-semibold");
    const row = title.closest("button")!;
    expect(row.className).toContain("py-4");
    expect(screen.getByRole("heading", { name: /^Your creators/ }).className).toContain("text-[22px]");
  });

  it("marks state at a glance: tinted icon and dot for open, no side stripe, muted for closed, details as chips, a count by the heading", async () => {
    apiFetch.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () =>
        path === "/api/humans/briefs"
          ? { briefs: [BRIEF, { ...BRIEF, id: "b2", title: "Old launch", closed_at: "2026-09-25T00:00:00Z" }] }
          : { jobs: [] },
    }));
    render(<ChannelHumanLane channel={byId("ugc")} />);
    const open = (await screen.findByText("Spring menu launch")).closest("button")!;
    const closed = screen.getByText("Old launch").closest("button")!;
    expect(open.querySelector("[data-edge]")).toBeNull();
    expect(open.querySelector('[aria-hidden="true"].bg-emerald-500\\/15')).toBeTruthy();
    expect(closed.className).toContain("opacity-75");
    expect(open.className).not.toContain("opacity-75");
    const chips = screen.getByLabelText("3 applied · answer by Oct 2").children;
    expect([...chips].map((c) => c.textContent)).toEqual(["3 applied", "answer by Oct 2"]);
    expect(chips[0].querySelector("svg")).toBeTruthy();
    expect(screen.getByLabelText("2 in total").textContent).toBe("2");
    expect(open.textContent).not.toMatch(/\u2014/);
  });

  it("hovers quietly: no lift, no glare border, no underline, and no visible kind label", async () => {
    apiFetch.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () => (path === "/api/humans/briefs" ? { briefs: [BRIEF] } : { jobs: [] }),
    }));
    render(<ChannelHumanLane channel={byId("ugc")} />);
    const title = await screen.findByText("Spring menu launch");
    const row = title.closest("button")!;
    expect(row.className).toContain("hover:bg-bone");
    expect(row.className).not.toMatch(/hover:-translate-y|hover:border-inkMuted |hover:shadow-elevMd/);
    expect(title.className).not.toContain("group-hover:underline");
    expect(row.querySelector(".sr-only")!.textContent).toBe("Brief: ");
  });
});

describe("an extension request on the founder side", () => {
  it("the job's row says the creator asked for more time, and to which day", () => {
    const row = jobRow(job({ status: "in_progress", extension_state: "requested", extension_requested_due_at: "2026-10-27T05:16:26Z" }));
    expect(row?.status).toBe("Maya asked for more time");
    expect(row?.tone).toBe("action");
    expect(row?.line).toContain("wants Oct 27");
    expect(row?.drawer).toBe("job");
  });

  it("re-reads Your creators when the founder comes back to the tab", async () => {
    respond([BRIEF], []);
    render(<ChannelHumanLane channel={byId("ugc")} />);
    expect(await screen.findByText("Spring menu launch")).toBeTruthy();
    const before = vi.mocked(apiFetch).mock.calls.filter((c) => c[0] === "/api/humans/orders").length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter((c) => c[0] === "/api/humans/orders").length).toBe(before + 1));
  });
});

