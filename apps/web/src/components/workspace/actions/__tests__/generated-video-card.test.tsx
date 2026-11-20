// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "@/components/ui/toast";
import { resetExecFailureToasts } from "../ActionFooter";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

afterEach(cleanup);

const platform = platformFor("generated_video");

function handlers(over: Partial<ActionHandlers> = {}) {
  return { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn(), ...over } satisfies ActionHandlers;
}

const card = (over: Parameters<typeof makeAction>[1] = {}) =>
  makeAction("video_post", {
    channel_slug: "generated_video",
    title: "Product demo: Setup took four minutes",
    executable: true,
    card_kind: "executes",
    primary_label: "Approve",
    done_label: "Done",
    body: {
      step: {
        title: "Product demo: Setup took four minutes",
        body: "Setup time is the objection in three reviews.\n\nApprove to make this as a 20-second vertical video.",
        blocking: false,
        effort: "minutes",
        evidence: [],
        deliverable: { kind: "script", label: "The script", content: "Setup took four minutes and that was the whole job." },
      },
      exact_change: {
        rows: [
          { item: "Video", before: "Script only", after: "Product demo, about 20s, 9:16" },
          { item: "Cost", before: "Nothing yet", after: "1,200 credits, charged only when the video arrives" },
        ],
      },
    },
    ...over,
  });

describe("AI UGC Videos card", () => {
  it("shows the cost and an Approve that calls the approve handler", () => {
    const h = handlers();
    const a = card();
    render(<ChannelActionCard action={a} platform={platform} handlers={h} />);
    expect(screen.getByText(/1,200 credits, charged only when the video arrives/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(h.onApprove).toHaveBeenCalledWith(a);
  });

  it("reads Making... while it renders, with nothing to press", () => {
    render(<ChannelActionCard action={card({ exec_status: "dispatching" })} platform={platform} handlers={handlers()} />);
    expect(screen.getByTestId("exec-state").textContent).toMatch(/Making your video/);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("plays the video on the same card with a Download and no AI-generated label", () => {
    const h = handlers();
    const a = card({
      exec_status: "executed",
      body: {
        ...card().body,
        media: { kind: "video", url: "https://storage.example/v.mp4", download_url: "https://storage.example/v.mp4?download=v.mp4", ai_generated: true },
      },
    });
    const { container } = render(<ChannelActionCard action={a} platform={platform} handlers={h} />);
    expect(container.querySelector("video")?.getAttribute("src")).toBe("https://storage.example/v.mp4");
    expect(screen.queryByText(/AI-generated/)).toBeNull();
    expect(screen.getByTestId("video-download").getAttribute("href")).toBe("https://storage.example/v.mp4?download=v.mp4");
    expect(screen.getByTestId("exec-state").textContent).toMatch(/charged only now that it arrived/);
    expect(screen.getAllByTestId("video-download")).toHaveLength(1);
    expect(screen.getByTestId("video-download").closest("article")).toBe(container.querySelector("video")?.closest("article"));
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("offers Post this video when the video is also a library video; nothing posts until the dialog's Post", () => {
    const a = card({
      exec_status: "executed",
      body: {
        ...card().body,
        media: { kind: "video", url: "https://storage.example/v.mp4", download_url: "https://storage.example/v.mp4?download=v.mp4", ai_generated: true, artifact_id: "art-1" },
      },
    });
    const { container } = render(<ChannelActionCard action={a} platform={platform} handlers={handlers()} />);
    expect(screen.getByTestId("video-post").textContent).toBe("Post this video");
    expect(screen.getByTestId("video-post").closest("article")).toBe(container.querySelector("video")?.closest("article"));
    expect(screen.queryByTestId("video-post-dialog")).toBeNull();
  });

  it("no Post this video without a library id", () => {
    const a = card({ exec_status: "executed", body: { ...card().body, media: { kind: "video", url: "https://storage.example/v.mp4", ai_generated: true } } });
    render(<ChannelActionCard action={a} platform={platform} handlers={handlers()} />);
    expect(screen.queryByTestId("video-post")).toBeNull();
  });

  it("a failed render toasts that it could not be made and why, and offers Try again", () => {
    resetExecFailureToasts();
    const add = vi.spyOn(toast, "add").mockImplementation(() => "t");
    render(
      <ChannelActionCard
        action={card({ exec_status: "failed", note: "Sorry, the video generation didn't complete. You were not charged for it." })}
        platform={platform}
        handlers={handlers()}
      />,
    );
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({ type: "error", title: "The video could not be made", description: "Sorry, the video generation didn't complete." });
    expect(screen.getByTestId("exec-reason").textContent).toBe("Sorry, the video generation didn't complete. You were not charged for it.");
    expect(document.body.textContent).not.toMatch(/part of it may have gone through/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByTestId("exec-top-up")).toBeNull();
    add.mockRestore();
  });

  it("a short wallet adds a top-up link", () => {
    render(
      <ChannelActionCard
        action={card({ exec_status: "failed", exec_code: "insufficient_credits", note: "This video costs about 1,200 credits. Top up credits, then press Try again." })}
        platform={platform}
        handlers={handlers()}
      />,
    );
    expect(screen.getByTestId("exec-top-up").getAttribute("href")).toMatch(/billing/);
  });
});
