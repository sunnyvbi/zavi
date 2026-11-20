// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const shell = vi.hoisted(() => ({ role: "member" as string | null }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ role: shell.role, currentUserId: "user-1" }),
  useWorkspace: () => ({ role: shell.role, currentUserId: "user-1" }),
}));

import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

afterEach(cleanup);

const doneLine = () => within(screen.getByTestId("exec-state")).getAllByRole("status")[0];

const linkedin = platformFor("linkedin_ads");
const meta = platformFor("meta_ads");
const video = platformFor("generated_video");

const launch = (over: Parameters<typeof makeAction>[1] = {}) =>
  makeAction("update_ad", {
    id: "li-launch",
    channel_slug: "linkedin_ads",
    title: "Launch LinkedIn campaign Q4 founders",
    executable: true,
    approve_needs_admin: true,
    body: {
      change_sentence: "Launches \"Q4 founders\" in LinkedIn Ads with a $500.00 total budget.",
      exact_change: { rows: [{ item: "Campaign", before: "Paused", after: "Active" }] },
      action_label: "Approve and launch",
    },
    ...over,
  });

const pause = (over: Parameters<typeof makeAction>[1] = {}) =>
  makeAction("pause_ad", {
    id: "li-pause",
    channel_slug: "linkedin_ads",
    title: "Pause the LinkedIn campaign \"Q3 cold\"",
    executable: true,
    body: {
      change_sentence: "Zavi pauses \"Q3 cold\" in LinkedIn Campaign Manager.",
      exact_change: { rows: [{ item: "Campaign \"Q3 cold\"", before: "Active", after: "Paused" }] },
      action_label: "Pause",
    },
    ...over,
  });

describe("who may approve a LinkedIn launch card on the Actions tab", () => {
  let handlers: ActionHandlers;
  beforeEach(() => {
    handlers = { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn() };
  });

  it("a member is offered no Approve on a launch, is told who can, and keeps the dismissal menu", () => {
    shell.role = "member";
    render(<ChannelActionCard action={launch()} platform={linkedin} handlers={handlers} />);
    expect(document.querySelector("[data-approve]")).toBeNull();
    expect(screen.getByTestId("approve-needs-admin").textContent).toBe("Only a workspace owner or admin can approve this. Ask one of them to approve it.");
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
    expect(handlers.onApprove).not.toHaveBeenCalled();
  });

  it("a viewer sees the LinkedIn launch but no executable controls", () => {
    shell.role = "viewer";
    render(<ChannelActionCard action={launch()} platform={linkedin} handlers={handlers} />);
    expect(document.querySelector("[data-approve]")).toBeNull();
    expect(screen.queryByTestId("approve-needs-admin")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("a member offered no Approve on a failed launch either: no Try again", () => {
    shell.role = "member";
    render(<ChannelActionCard action={launch({ exec_status: "failed", exec_bucket: "temporary" })} platform={linkedin} handlers={handlers} />);
    expect(document.querySelector("[data-approve]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each(["owner", "admin"])("an %s gets the Approve and it approves this card once", (r) => {
    shell.role = r;
    render(<ChannelActionCard action={launch()} platform={linkedin} handlers={handlers} />);
    const btn = document.querySelector("[data-approve]") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(handlers.onApprove).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handlers.onApprove!).mock.calls[0][0].id).toBe("li-launch");
    expect(screen.queryByTestId("approve-needs-admin")).toBeNull();
  });

  it("a member keeps the Approve on a LinkedIn pause, which the server lets any member approve", () => {
    shell.role = "member";
    render(<ChannelActionCard action={pause()} platform={linkedin} handlers={handlers} />);
    const btn = document.querySelector("[data-approve]") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    expect(handlers.onApprove).toHaveBeenCalledTimes(1);
  });
});

describe("blocked controls on the shared paid card", () => {
  const handlers: ActionHandlers = { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() };
  const action = () => launch({ id: "meta-launch", channel_slug: "meta_ads" });

  it("keeps Reject and More actions for a member who needs an admin to approve", () => {
    shell.role = "member";
    render(<ChannelActionCard action={action()} platform={meta} handlers={handlers} />);
    expect(document.querySelector("[data-approve]")).toBeNull();
    expect(screen.getByTestId("approve-needs-admin")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
  });

  it("hides executable controls from a viewer", () => {
    shell.role = "viewer";
    render(<ChannelActionCard action={action()} platform={meta} handlers={handlers} />);
    expect(document.querySelector("[data-approve]")).toBeNull();
    expect(screen.queryByTestId("approve-needs-admin")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Close/ })).toBeNull();
  });

  it("lets a viewer download a finished generated video but not post it", () => {
    shell.role = "viewer";
    const done = makeAction("video_post", {
      channel_slug: "generated_video",
      executable: true,
      exec_status: "executed",
      body: { media: { kind: "video", url: "https://storage.example/video.mp4", artifact_id: "artifact-1" } },
    });
    render(<ChannelActionCard action={done} platform={video} handlers={handlers} />);
    expect(screen.getByTestId("video-download")).toBeTruthy();
    expect(screen.queryByTestId("video-post")).toBeNull();
  });
});

describe("what an executed LinkedIn card says happened", () => {
  beforeEach(() => {
    shell.role = "owner";
  });
  const handlers: ActionHandlers = { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn() };
  const executed = { status: "acted" as const, exec_status: "executed" as const, executed_at: "2026-10-29T10:00:00Z" };

  it("a create says the campaign was created paused and spends nothing until launched", () => {
    const create = makeAction("create_ad", { id: "li-create", channel_slug: "linkedin_ads", executable: true, approve_needs_admin: true, title: "Create LinkedIn campaign", body: {}, ...executed });
    render(<ChannelActionCard action={create} platform={linkedin} handlers={handlers} />);
    const title = doneLine().textContent ?? "";
    expect(title).toBe("Created in LinkedIn Campaign Manager, paused. Nothing spends until you launch it.");
    expect(title).not.toMatch(/live/i);
  });

  it("Review 33 P8: a create on the shared wallet says it sits in Zavi's managed account, not in the founder's Campaign Manager", () => {
    const create = makeAction("create_ad", { id: "li-create-wallet", channel_slug: "linkedin_ads", executable: true, approve_needs_admin: true, title: "Create LinkedIn campaign", body: { exact_change: { rows: [{ item: "Funding", before: "Not chosen", after: "Shared Zavi ads balance" }] } }, ...executed });
    render(<ChannelActionCard action={create} platform={linkedin} handlers={handlers} />);
    const title = doneLine().textContent ?? "";
    expect(title).toBe("Created paused in Zavi's managed LinkedIn ad account, paid from your shared ads balance. Nothing spends until you launch it from this channel in Zavi.");
    expect(title).not.toMatch(/Campaign Manager/);
    cleanup();
    const own = makeAction("create_ad", { id: "li-create-own", channel_slug: "linkedin_ads", executable: true, approve_needs_admin: true, title: "Create LinkedIn campaign", body: { exact_change: { rows: [{ item: "Funding", before: "Not chosen", after: "Your LinkedIn account bills you directly" }] } }, ...executed });
    render(<ChannelActionCard action={own} platform={linkedin} handlers={handlers} />);
    expect(doneLine().textContent).toBe("Created in LinkedIn Campaign Manager, paused. Nothing spends until you launch it.");
  });

  it("a pause says paused, not live", () => {
    render(<ChannelActionCard action={pause(executed)} platform={linkedin} handlers={handlers} />);
    const title = doneLine().textContent ?? "";
    expect(title).toBe("Paused in LinkedIn Campaign Manager. It stops spending until someone turns it back on.");
    expect(title).not.toMatch(/live/i);
  });

  it("a launch says live", () => {
    render(<ChannelActionCard action={launch(executed)} platform={linkedin} handlers={handlers} />);
    expect(doneLine().textContent).toBe("Launched. The campaign is live in LinkedIn Campaign Manager.");
  });
});

describe("a LinkedIn copy card names what it copies", () => {
  const handlers: ActionHandlers = { onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn() };
  const executed = { status: "acted" as const, exec_status: "executed" as const, executed_at: "2026-10-29T10:00:00Z" };
  const groupCopy = (over: Parameters<typeof makeAction>[1] = {}) =>
    makeAction("create_ad", {
      id: "li-copy-group",
      channel_slug: "linkedin_ads",
      executable: true,
      approve_needs_admin: true,
      title: "Copy the LinkedIn campaign group \"Q4 founders\"",
      body: {
        kind_label: "Campaign group copy",
        change_sentence: "Zavi copies the LinkedIn campaign group \"Q4 founders\" as \"Q4 founders (copy)\", paused, with paused copies of its campaigns and their ads.",
        exact_change: { rows: [{ item: "Campaign group", before: "\"Q4 founders\"", after: "\"Q4 founders (copy)\" (paused copy)" }] },
        action_label: "Approve and copy",
      },
      ...over,
    });

  beforeEach(() => {
    shell.role = "owner";
  });

  it("must catch: a group copy wears the server's label, never the create_ad body's \"Ad\"", () => {
    render(<ChannelActionCard action={groupCopy()} platform={linkedin} handlers={handlers} />);
    const kinds = screen.getAllByTestId("action-kind").map((n) => n.textContent);
    expect(kinds).toContain("Campaign group copy");
    expect(kinds).not.toContain("Ad");
  });

  it("must catch: a copied group's done text is what Zavi copied, never the create_ad launch line", () => {
    const notice = "Copied the campaign group \"Q4 founders\" as \"Q4 founders (copy)\" (group 7), paused, with 2 paused campaigns and their ads.";
    render(<ChannelActionCard action={groupCopy({ ...executed, exec_notice: notice })} platform={linkedin} handlers={handlers} />);
    expect(doneLine().textContent).toBe(notice);
  });

  it("a model's intent word still wins over the server label, so every channel tags the same work the same way", () => {
    render(<ChannelActionCard action={groupCopy({ body: { kind_label: "Campaign group copy", intent: "create" } })} platform={linkedin} handlers={handlers} />);
    expect(screen.getAllByTestId("action-kind").map((n) => n.textContent)).toContain("Create");
  });
});
