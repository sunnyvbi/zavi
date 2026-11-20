// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "@/components/ui/toast";
import { ChannelActionCard } from "../ChannelActionCard";
import { ActionSection } from "../ActionSection";
import { laneKinds } from "../ChannelActionsLane";
import { resetExecFailureToasts } from "../ActionFooter";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import type { LaneEntry } from "../cardGroups";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { FIXTURES, makeAction } from "./fixtures";

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });
const video = platformFor("generated_video");

const NOTE =
  "Sorry, video generation is temporarily unavailable on our side, so nothing was made. You were not charged for it, and you can press Try again in a few minutes.";

const videoCard = (over: Parameters<typeof makeAction>[1] = {}) =>
  makeAction("video_post", {
    id: "vid-1",
    channel_slug: "generated_video",
    title: "Hook: That awkward quiet before class starts?",
    executable: true,
    card_kind: "executes",
    primary_label: "Approve",
    done_label: "Done",
    body: {
      step: {
        title: "Hook: That awkward quiet before class starts?",
        body: "Students freeze before the first question.\n\nApprove to make this as a 20-second vertical video.",
        blocking: false,
        effort: "minutes",
        evidence: [],
        deliverable: { kind: "script", label: "The script", content: "That awkward quiet before class starts? Not anymore." },
      },
      exact_change: {
        rows: [
          { item: "Video", before: "Script only", after: "Hook, about 20 seconds, 9:16" },
          { item: "Cost", before: "Nothing yet", after: "1,200 credits, charged only when the video arrives" },
        ],
      },
    },
    ...over,
  });

let add: MockInstance<Parameters<typeof toast.add>, ReturnType<typeof toast.add>>;
beforeEach(() => {
  resetExecFailureToasts();
  add = vi.spyOn(toast, "add").mockImplementation(() => "toast-x");
});
afterEach(() => {
  cleanup();
  add.mockRestore();
});

describe("the card title and its exact change", () => {
  it("draws no icon before the title or before an exact change's new value", () => {
    render(<ChannelActionCard action={videoCard()} platform={video} handlers={handlers()} />);
    const title = screen.getByRole("heading", { name: "Hook: That awkward quiet before class starts?" });
    expect(title.querySelector("svg")).toBeNull();
    expect(title.previousElementSibling?.tagName).not.toBe("svg");
    const afters = within(screen.getByTestId("exact-change")).getAllByTestId("exact-change-after");
    expect(afters.map((c) => c.textContent)).toEqual([
      "Hook, about 20 seconds, 9:16",
      "1,200 credits, charged only when the video arrives",
    ]);
    for (const cell of afters) expect(cell.closest("dd, td")?.querySelector("svg") ?? null).toBeNull();
  });
});

describe("How to do this", () => {
  it("uses the final How it works button and inline ordered steps", () => {
    const a = { ...FIXTURES.text_post, card_kind: "post" as const, primary_label: "Post it", done_label: "I posted it", how_to: ["Open the app.", "Paste the post."] };
    render(<ChannelActionCard action={a} platform={platformFor("x_organic")} handlers={handlers()} />);
    const how = screen.getByRole("button", { name: "How it works" });
    expect(how.getAttribute("aria-expanded")).toBe("false");
    const chevron = how.querySelector("svg");
    if (!chevron) throw new Error("Missing disclosure chevron");
    expect(chevron.tagName.toLowerCase()).toBe("svg");
    expect(chevron.getAttribute("class")).toContain("ease-ca-spring");
    fireEvent.click(how);
    expect(how.getAttribute("aria-expanded")).toBe("true");
    expect(chevron.getAttribute("class")).toContain("rotate-180");
    expect(screen.getByText("Paste the post.")).toBeTruthy();
  });
});

describe("a failed video", () => {
  it("toasts once with the short words, keeps Try again, and keeps the title and reason in the red banner", () => {
    const h = handlers();
    const failed = videoCard({ exec_status: "failed", exec_bucket: "temporary", note: NOTE });
    const { unmount } = render(<ChannelActionCard action={failed} platform={video} handlers={h} />);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toEqual({
      type: "error",
      timeout: 7000,
      title: "The video could not be made",
      description: "Sorry, video generation is temporarily unavailable on our side, so nothing was made.",
    });
    expect(screen.getByTestId("exec-state").getAttribute("data-exec")).toBe("failed");
    expect(screen.getByTestId("exec-title").textContent).toBe("The video could not be made.");
    expect(screen.getByTestId("exec-reason").textContent).toBe(NOTE);
    expect(screen.queryByRole("alert")).toBeNull();
    const card = screen.getByTestId("action-vid-1");
    expect(card.textContent).not.toMatch(/A temporary problem|Nothing was changed|Check it before trying again/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    unmount();

    render(<ChannelActionCard action={{ ...failed }} platform={video} handlers={h} />);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("re-renders and polls of the same failure never toast again", () => {
    const failed = videoCard({ exec_status: "failed", exec_bucket: "temporary", note: NOTE });
    const { rerender } = render(<ChannelActionCard action={failed} platform={video} handlers={handlers()} />);
    rerender(<ChannelActionCard action={{ ...failed }} platform={video} handlers={handlers()} />);
    rerender(<ChannelActionCard action={{ ...failed, note: NOTE }} platform={video} handlers={handlers()} />);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("a later visit in the same session does not toast, even after the module forgets", () => {
    const failed = videoCard({ exec_status: "failed", exec_bucket: "temporary", note: NOTE });
    const first = render(<ChannelActionCard action={failed} platform={video} handlers={handlers()} />);
    first.unmount();
    expect(window.localStorage.getItem("zavi:exec-failure-toasts")).toContain("vid-1");
    render(<ChannelActionCard action={{ ...failed }} platform={video} handlers={handlers()} />);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("must catch: a failure an earlier tab already toasted stays quiet in a new tab", () => {
    window.localStorage.setItem("zavi:exec-failure-toasts", JSON.stringify(["vid-1"]));
    window.sessionStorage.clear();
    render(<ChannelActionCard action={videoCard({ exec_status: "failed", exec_bucket: "partial_risk", note: NOTE })} platform={video} handlers={handlers()} />);
    expect(add).not.toHaveBeenCalled();
  });

  it("a Try again that fails toasts again", () => {
    const failed = videoCard({ exec_status: "failed", exec_bucket: "temporary", note: NOTE });
    const { rerender } = render(<ChannelActionCard action={failed} platform={video} handlers={handlers()} />);
    expect(add).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    rerender(<ChannelActionCard action={{ ...failed, exec_status: "dispatching" }} platform={video} handlers={handlers()} />);
    rerender(<ChannelActionCard action={{ ...failed, note: "The render timed out. You were not charged." }} platform={video} handlers={handlers()} />);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1]![0]).toMatchObject({ title: "The video could not be made", description: "The render timed out." });
    vi.restoreAllMocks();
  });

  it("a short wallet keeps its reason and the top-up link on the card", () => {
    render(
      <ChannelActionCard
        action={videoCard({ exec_status: "failed", exec_code: "insufficient_credits", note: "This video costs about 1,200 credits. Top up credits, then press Try again." })}
        platform={video}
        handlers={handlers()}
      />,
    );
    expect(add).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("exec-reason").textContent).toBe("This video costs about 1,200 credits. Top up credits, then press Try again.");
    expect(screen.getByTestId("exec-top-up").textContent).toBe("Top up credits");
  });
});

describe("a lane kind's toggle reads Show more and Show less, never a count or a noun", () => {
  const entries = (slug: string, n = 3): LaneEntry<ChannelActionView>[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "card" as const,
      card: makeAction("video_post", { id: `${slug}-${i + 1}`, channel_slug: slug, title: `Held card ${slug} ${i + 1}` }),
    }));

  function Lane({ slug, n }: { slug: string; n?: number }) {
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const platform = platformFor(slug);
    const kinds = laneKinds(
      entries(slug, n),
      [],
      open,
      (kind) => setOpen((prev) => (prev.has(kind) ? new Set([...prev].filter((k) => k !== kind)) : new Set([...prev, kind]))),
      platform,
    );
    return <ActionSection actions={kinds.flatMap((k) => k.entries.map((e) => (e.kind === "card" ? e.card : e.members[0]!)))} kinds={kinds} platform={platform} handlers={handlers()} empty={null} />;
  }

  for (const slug of ["generated_video", "tiktok_organic"]) {
    it(`on ${slug}, the final section shows every supplied card without a legacy kind toggle`, () => {
      render(<Lane slug={slug} n={6} />);
      expect(screen.getByTestId("action-section").querySelectorAll("article")).toHaveLength(6);
      expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Show less" })).toBeNull();
    });
  }

  it("still names the kind Videos for its heading on UGC Videos", () => {
    expect(laneKinds(entries("ugc"), [], new Set(), () => {}, platformFor("ugc"))[0]!.label).toBe("Videos");
  });
});
