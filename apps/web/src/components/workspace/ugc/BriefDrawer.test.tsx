// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
let respond: ((path: string) => unknown) | null = null;
vi.mock("./useCards", () => ({
  callJson: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    const custom = respond?.(path);
    if (custom) return custom;
    if (path === "/api/humans/briefs") return { ok: true, data: { brief: { id: "b-new" } } };
    return { ok: true, data: {} };
  }),
}));
vi.mock("./CreatorHiringCards", () => ({ loadBudgetHint: vi.fn(async () => null) }));

import { BriefDrawer } from "./BriefDrawer";
import { UgcDrawerHost } from "./UgcDrawerHost";

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
}

function fillRequired() {
  fill("Title", "Spring launch");
  fill("Angle", "A real morning routine");
  fill("Hook", "I did not expect this");
  fill("Format", "Vertical 9:16, 30 seconds");
  fill("Budget per video", "150");
  fill("Days to deliver", "7");
}

beforeEach(() => {
  calls.length = 0;
  respond = null;
  window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=brief");
});
afterEach(cleanup);

describe("BriefDrawer", () => {
  it("separates the business fee estimate from the creator preview without booking anything", () => {
    render(<BriefDrawer />);
    fill("Budget per video", "250");
    expect(screen.getByText(/You pay the agreed price plus Zavi.s 10% fee/)).toBeTruthy();
    expect(screen.getByText(/your total would be \$275/).textContent).toContain("estimate, not a booking price");
    expect(screen.getByText(/Creator preview: at \$250/).textContent).toContain("$212.50");
    expect(calls).toEqual([]);
    fill("Budget per video", "300");
    expect(screen.getByText(/your total would be \$330/)).toBeTruthy();
  });

  it("shows the can't-edit warning and the four headings", () => {
    render(<BriefDrawer />);
    expect(screen.getByText(/Once you publish, the brief can.t be edited/)).toBeTruthy();
    for (const h of ["The video", "Where it runs", "Money and time", "Who can apply"])
      expect(screen.getByRole("heading", { name: h })).toBeTruthy();
  });

  it("the first Publish press only asks; the second publishes", async () => {
    render(<BriefDrawer />);
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByText(/Publish for good\? You can.t edit it after/)).toBeTruthy();
    expect(calls).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Yes, publish" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/humans/briefs/b-new/publish")).toBe(true));
    expect(calls[0].path).toBe("/api/humans/briefs");
  });

  it("Not yet takes the question back without publishing", () => {
    render(<BriefDrawer />);
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(screen.queryByText(/Publish for good/)).toBeNull();
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  const alertOf = (label: string) => {
    const input = screen.getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;
    const id = input.getAttribute("aria-describedby");
    return { input, text: id ? document.getElementById(id)?.textContent ?? null : null };
  };

  it("each number field says its range on the field, and an out-of-range value blocks Save draft and Publish", () => {
    render(<BriefDrawer />);
    fillRequired();
    const save = () => screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
    const publish = () => screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(save().disabled).toBe(false);
    expect(publish().disabled).toBe(false);
    const cases: Array<[string, string[], string[], string]> = [
      ["How many videos", ["0", "21"], ["1", "20"], "Enter 1 to 20 videos."],
      ["Budget per video", ["0"], ["1", "9999"], "Enter a budget of at least $1 per video."],
      ["Days to deliver", ["0", "91"], ["1", "90"], "Enter 1 to 90 days."],
      ["Application limit", ["0", "501", "9999"], ["1", "500"], "Enter a limit from 1 to 500."],
    ];
    for (const [label, bad, good, message] of cases) {
      for (const v of bad) {
        fill(label, v);
        const { input, text } = alertOf(label);
        expect([label, v, text]).toEqual([label, v, message]);
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(save().disabled).toBe(true);
        expect(publish().disabled).toBe(true);
      }
      for (const v of good) {
        fill(label, v);
        expect([label, v, alertOf(label).text]).toEqual([label, v, null]);
        expect(save().disabled).toBe(false);
      }
    }
    fill("Application limit", "12345");
    expect(alertOf("Application limit").input.value).toBe("1234");
  });

  it("the number fields are required to publish but not to save a draft, and Publish shows what is missing", () => {
    render(<BriefDrawer />);
    fill("Title", "Spring launch");
    fill("Angle", "A real morning routine");
    fill("Hook", "I did not expect this");
    fill("Format", "Vertical 9:16, 30 seconds");
    expect(alertOf("Application limit").input.value).toBe("20");
    expect(alertOf("How many videos").input.value).toBe("1");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    const save = screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.queryByRole("group", { name: "Confirm publish" })).toBeNull();
    expect(alertOf("Budget per video").text).toBe("Enter a budget of at least $1 per video. It is required to publish.");
    expect(alertOf("Days to deliver").text).toBe("Enter 1 to 90 days. It is required to publish.");
    fill("Application limit", "");
    expect(alertOf("Application limit").text).toBe("Enter a limit from 1 to 500. It is required to publish.");
    expect(calls).toEqual([]);
    fill("Budget per video", "150");
    fill("Days to deliver", "7");
    fill("Application limit", "20");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByRole("group", { name: "Confirm publish" })).toBeTruthy();
  });

  it("a text field emptied after typing says it is required; an untouched blank form shows no errors", () => {
    render(<BriefDrawer />);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    fill("Title", "x");
    fill("Title", "");
    expect(alertOf("Title").text).toBe("Title is required.");
    fill("Format", "f".repeat(121));
    expect(alertOf("Format").text).toBe("Format has to be 120 characters or fewer. It is 121 now.");
    fill("Locations", Array.from({ length: 26 }, (_, i) => `City ${i}`).join(", "));
    expect(alertOf("Locations").text).toBe("List 25 locations at most. There are 26 now.");
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the preview's Apply is a muted picture of the creators' button, never a second action beside Publish", () => {
    render(<BriefDrawer />);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    const preview = screen.getByTestId("preview-apply");
    expect(preview.textContent).toBe("ApplyCreators see this button");
    expect(preview.querySelector('[aria-hidden="true"]')?.className).toContain("border-dashed");
  });

  it("offers no kind of job to pick: a new brief is always a UGC video", async () => {
    respond = (path) => (path === "/api/humans/briefs/b-new/workbench" ? { ok: false, message: "gone" } : null);
    render(<BriefDrawer />);
    expect(screen.queryByText("What kind of job")).toBeNull();
    expect(screen.queryByText(/Posted on the creator.s account/)).toBeNull();
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/humans/briefs")).toBe(true));
    const body = calls.find((c) => c.path === "/api/humans/briefs")?.init?.body as Record<string, unknown>;
    expect(body.lane).toBe("ugc_video");
    expect(body.ad_rights_days).toBe(90);
  });

  it("an old draft saved as an audience post is saved back as a UGC video with its ad rights", async () => {
    window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=brief&brief=b-old");
    respond = (path) =>
      path === "/api/humans/briefs/b-old/workbench"
        ? {
            ok: true,
            data: {
              brief: {
                id: "b-old",
                status: "draft",
                title: "Old post brief",
                angle: "A real morning routine",
                hook: "I did not expect this",
                format: "Vertical 9:16, 30 seconds",
                deliverables: 1,
                lane: "audience_post",
                budget_usd: 150,
                delivery_days: 7,
                applicant_cap: 20,
                ad_rights_days: null,
                posted_at: null,
                answer_by: null,
                closed_at: null,
                rationale: null,
                filters: { niches: [], platforms: [], locations: [] },
              },
              creator_preview: { business_name: "Acme" },
              applicant_count: 0,
            },
          }
        : null;
    render(<UgcDrawerHost />);
    expect(await screen.findByDisplayValue("Old post brief")).toBeTruthy();
    expect(screen.queryByText(/Posted on the creator.s account/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/humans/briefs/b-old" && c.init?.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.path === "/api/humans/briefs/b-old" && c.init?.method === "PATCH")?.init?.body as Record<string, unknown>;
    expect(body.lane).toBe("ugc_video");
    expect(body.ad_rights_days).toBe(90);
  });

  it("a picked chip is aria-pressed and carries a check icon", () => {
    render(<BriefDrawer />);
    const chip = screen.getByRole("button", { name: "TikTok" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.querySelector("svg")).toBeNull();
    fireEvent.click(chip);
    const on = screen.getByRole("button", { name: "TikTok" });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(on.querySelector("svg")).not.toBeNull();
  });

  const localToday = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const dayButton = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
    return screen.getByRole("button", { name: `${wd} ${d} ${mon} ${y}` }) as HTMLButtonElement;
  };

  it("Answer everyone by opens Zavi's own calendar, not the browser's, and picking a day closes it", () => {
    render(<BriefDrawer />);
    const field = screen.getByRole("button", { name: "Answer everyone by" });
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(field.closest("label")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
    fireEvent.click(field);
    expect(screen.getByRole("dialog", { name: "Choose a day" })).toBeTruthy();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    const target = screen.getAllByRole("button").find((b) => b.textContent === "15" && b.getAttribute("aria-label")?.includes(" 15 ")) as HTMLButtonElement;
    fireEvent.click(target);
    expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
    expect(screen.getByRole("button", { name: "Answer everyone by" }).textContent).toBe(target.getAttribute("aria-label"));
  });

  it("starts at the earliest day a brief can close: earlier days and months cannot be picked", () => {
    render(<BriefDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Answer everyone by" }));
    const now = new Date();
    const local = localToday();
    const utc = now.toISOString().slice(0, 10);
    const min = local > utc ? local : utc;
    expect(dayButton(min).disabled).toBe(false);
    const [y, m, d] = min.split("-").map(Number);
    if (d > 1) expect(dayButton(`${y}-${String(m).padStart(2, "0")}-${String(d - 1).padStart(2, "0")}`).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous month" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("in a US evening, when UTC is already tomorrow, today cannot be picked because it would close at once", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T02:30:00.000Z"));
    const local = localToday();
    render(<BriefDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Answer everyone by" }));
    if (local < "2026-10-08") expect(dayButton(local).disabled).toBe(true);
    expect(dayButton("2026-10-08").disabled).toBe(false);
    vi.useRealTimers();
  });

  it("Escape and a click outside both close the calendar without changing the day", () => {
    render(<BriefDrawer />);
    const before = screen.getByRole("button", { name: "Answer everyone by" }).textContent;
    fireEvent.click(screen.getByRole("button", { name: "Answer everyone by" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Answer everyone by" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
    expect(screen.getByRole("button", { name: "Answer everyone by" }).textContent).toBe(before);
  });

  describe("a published brief: close and repost", () => {
    const posted = (over: Record<string, unknown> = {}) => ({
      brief: {
        id: "b-live",
        status: "sent",
        title: "Spring launch",
        angle: "A real morning routine",
        hook: "I did not expect this",
        format: "Vertical 9:16, 30 seconds",
        deliverables: 1,
        lane: "ugc_video",
        budget_usd: 150,
        delivery_days: 7,
        applicant_cap: 20,
        posted_at: "2026-10-21T13:07:45Z",
        answer_by: "2026-10-26T13:07:45Z",
        closed_at: null,
        rationale: null,
        filters: { niches: [], platforms: [], locations: [] },
        ...over,
      },
      creator_preview: { business_name: "Acme" },
      applicant_count: 2,
    });
    const copy = { ...posted().brief, id: "b-copy", status: "draft", posted_at: null, answer_by: null };
    let live = posted();

    beforeEach(() => {
      live = posted();
      window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=brief&brief=b-live");
      respond = (path) => {
        if (path === "/api/humans/briefs/b-live/workbench") return { ok: true, data: live };
        if (path === "/api/humans/briefs/b-copy/workbench") return { ok: true, data: { ...posted(), brief: copy, applicant_count: 0 } };
        if (path === "/api/humans/briefs/b-live/repost") return { ok: true, data: { brief: copy } };
        return null;
      };
    });

    const factValue = (label: string) => screen.getByText(label).closest("div")?.querySelector("dd")?.textContent;

    it("shows an open brief's status, dates and numbers, and says why it can't be edited", async () => {
      render(<UgcDrawerHost />);
      expect(await screen.findByRole("heading", { level: 2, name: "Spring launch" })).toBeTruthy();
      expect(screen.getByText("Open").className).toContain("bg-successBg");
      expect(screen.getByText("Posted Oct 21")).toBeTruthy();
      expect(factValue("Applied")).toBe("2 of 20");
      expect(factValue("Answer by")).toBe("Oct 26");
      expect(factValue("Budget")).toBe("$150 per video");
      expect(factValue("Deliver in")).toBe("7 days");
      expect(screen.getByText("Published briefs can't be edited. To change it, close it and repost a copy.")).toBeTruthy();
    });

    it("asks before closing a live brief, says what happens, and Not yet closes nothing", async () => {
      render(<UgcDrawerHost />);
      const button = await screen.findByRole("button", { name: "Close and repost" });
      expect(button.querySelector("svg")?.getAttribute("class")).toContain("lucide-repeat2");
      fireEvent.click(button);
      expect(calls.some((c) => c.path.endsWith("/repost"))).toBe(false);
      const ask = screen.getByRole("group", { name: "Confirm repost" });
      expect(ask.textContent).toContain("Close this brief and start a copy?");
      expect(ask.textContent).toContain("Creators can no longer apply to this brief. Nobody gets a message.");
      expect(ask.textContent).toContain("The 2 applicants stay listed under this closed brief.");
      expect(ask.textContent).toContain("Nothing is posted until you publish it.");
      expect(within(ask).getByRole("button", { name: "Close and repost" }).querySelector("svg")?.getAttribute("class")).toContain("lucide-repeat2");
      fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
      expect(screen.queryByRole("group", { name: "Confirm repost" })).toBeNull();
      expect(calls.some((c) => c.path.endsWith("/repost"))).toBe(false);
    });

    it("on confirm, reposts once and opens the copy with a banner saying it is a copy", async () => {
      render(<UgcDrawerHost />);
      fireEvent.click(await screen.findByRole("button", { name: "Close and repost" }));
      fireEvent.click(screen.getByRole("button", { name: "Close and repost" }));
      await waitFor(() => expect(new URLSearchParams(window.location.search).get("brief")).toBe("b-copy"));
      expect(calls.filter((c) => c.path === "/api/humans/briefs/b-live/repost")).toHaveLength(1);
      expect(new URLSearchParams(window.location.search).get("reposted")).toBe("1");
      expect(await screen.findByText("This is a copy of your closed brief")).toBeTruthy();
      expect(screen.getByText("Edit the copy, then publish")).toBeTruthy();
      expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe("Spring launch");
    });

    it("a closed brief offers Make a copy, without claiming it will close anything", async () => {
      live = posted({ closed_at: "2026-10-21T13:07:34Z" });
      render(<UgcDrawerHost />);
      expect(await screen.findByText("Closed")).toBeTruthy();
      expect(screen.getByText("· Closed Oct 21")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Close and repost" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Make a copy" }));
      const ask = screen.getByRole("group", { name: "Confirm repost" });
      expect(ask.textContent).toContain("Make an editable copy of this brief?");
      expect(ask.textContent).not.toContain("no longer apply");
    });
  });

  describe("a new brief's first publish that the server refuses", () => {
    const REFUSAL = "Add the ad rights before you publish.";
    const workbench = {
      brief: {
        id: "b-new",
        title: "Spring launch",
        angle: "A real morning routine",
        hook: "I did not expect this",
        format: "Vertical 9:16, 30 seconds",
        deliverables: 1,
        lane: "ugc_video",
        posted_at: null,
        closed_at: null,
        rationale: null,
        filters: { niches: [], platforms: [], locations: [] },
      },
      creator_preview: { business_name: "Acme" },
      applicant_count: 0,
    };

    beforeEach(() => {
      respond = (path) => {
        if (path === "/api/humans/briefs/b-new/publish")
          return { ok: false, status: 400, message: REFUSAL };
        if (path === "/api/humans/briefs/b-new/workbench") return { ok: true, data: workbench };
        return null;
      };
    });

    it("keeps the refusal on screen after the drawer moves to the new draft's link and remounts", async () => {
      render(<UgcDrawerHost />);
      fillRequired();
      fireEvent.click(screen.getByRole("button", { name: "Publish" }));
      fireEvent.click(screen.getByRole("button", { name: "Yes, publish" }));

      await waitFor(() => expect(calls.some((c) => c.path === "/api/humans/briefs/b-new/workbench")).toBe(true));
      expect(new URLSearchParams(window.location.search).get("brief")).toBe("b-new");
      expect(await screen.findByText(REFUSAL)).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Draft brief" })).toBeTruthy();
      expect(screen.queryByText(/, published$/)).toBeNull();
      expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe("Spring launch");
      expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
      expect(calls.filter((c) => c.path === "/api/humans/briefs")).toHaveLength(1);
    });

    it("says the refusal once: opening the same draft again later starts clean", async () => {
      render(<UgcDrawerHost />);
      fillRequired();
      fireEvent.click(screen.getByRole("button", { name: "Publish" }));
      fireEvent.click(screen.getByRole("button", { name: "Yes, publish" }));
      expect(await screen.findByText(REFUSAL)).toBeTruthy();
      cleanup();

      render(<UgcDrawerHost />);
      expect(await screen.findByRole("heading", { name: "Draft brief" })).toBeTruthy();
      expect(screen.queryByText(REFUSAL)).toBeNull();
    });

    it("a first Save draft still says Draft saved after the drawer remounts on the new draft", async () => {
      render(<UgcDrawerHost />);
      fillRequired();
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
      await waitFor(() => expect(calls.some((c) => c.path === "/api/humans/briefs/b-new/workbench")).toBe(true));
      expect(await screen.findByText("Draft saved.")).toBeTruthy();
    });
  });
});
