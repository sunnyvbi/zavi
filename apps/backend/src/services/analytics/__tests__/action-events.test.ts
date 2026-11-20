import { describe, it, expect, vi, beforeEach } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../mixpanel", () => ({ track }));

import { CATALOG } from "@/routes/admin/action-tracker";
import {
  FOUNDER_RESPONSES,
  trackApprovalCardDecided,
  trackChannelActionExecuted,
  trackChannelActionProposed,
  trackChannelActionResponded,
  trackChannelRunStarted,
  trackDocumentDelivered,
  trackMediaGenerated,
  trackPrototypePublished,
  trackSocialPostPublished,
} from "../action-events";

const T = "tenant-1";

beforeEach(() => {
  track.mockReset();
});

function fireAll(): void {
  trackChannelRunStarted({ tenant_id: T, channel_slug: "seo", path: "recipe" });
  trackChannelActionProposed({ tenant_id: T, channel_slug: "seo", action_type: "content" });
  for (const response of FOUNDER_RESPONSES) {
    trackChannelActionResponded({ tenant_id: T, user_id: "u-1", channel_slug: "seo", response });
  }
  trackApprovalCardDecided({ tenant_id: T, decision_class: "engineer.ship-pr", outcome: "approved" });
  trackApprovalCardDecided({ tenant_id: T, decision_class: "engineer.ship-pr", outcome: "rejected" });
  trackSocialPostPublished({ tenant_id: T, platform: "x" });
  trackChannelActionExecuted({ tenant_id: T, channel_slug: "google_ads" });
  trackMediaGenerated({ tenant_id: T, media: "image", kind: "ai_image" });
  trackMediaGenerated({ tenant_id: T, media: "video", kind: "launch_video" });
  for (const mime of [
    "application/pdf",
    "text/html",
    "application/vnd.zavi.ui+json",
    "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]) {
    trackDocumentDelivered({ tenant_id: T, mime });
  }
  for (const prototype of ["wireframe", "html_preview", "shared_page"] as const) {
    trackPrototypePublished({ tenant_id: T, prototype });
  }
}

describe("action-events", () => {
  it("every action_key sent is a key in the Action tracker catalog", () => {
    fireAll();
    const catalogKeys = new Set(CATALOG.flatMap((g) => g.actions.map((a) => a.key)));
    const sent = track.mock.calls.map((c) => (c[1] as { action_key: string }).action_key);
    expect(sent.filter((k) => !catalogKeys.has(k))).toEqual([]);
  });

  it("covers every catalog action except the ones sent by existing events", () => {
    fireAll();
    const sent = new Set(track.mock.calls.map((c) => (c[1] as { action_key: string }).action_key));
    const elsewhere = new Set(["agent.run_person", "agent.run_auto", "chat.message"]);
    const missing = CATALOG.flatMap((g) => g.actions.map((a) => a.key)).filter(
      (k) => !sent.has(k) && !elsewhere.has(k),
    );
    expect(missing).toEqual([]);
  });

  it("pins the event names", () => {
    fireAll();
    expect([...new Set(track.mock.calls.map((c) => c[0]))].sort()).toEqual([
      "approval_card_decided",
      "channel_action_executed",
      "channel_action_proposed",
      "channel_action_responded",
      "channel_run_started",
      "document_generated",
      "media_generated",
      "prototype_published",
      "social_post_published",
    ]);
  });

  it("an approval card carries its class family; a channel.recipe_step card sends nothing", () => {
    trackApprovalCardDecided({
      tenant_id: T,
      user_id: "u-1",
      decision_class: "fundraising.send_email",
      outcome: "approved",
      staff: false,
    });
    trackApprovalCardDecided({ tenant_id: T, decision_class: "channel.recipe_step", outcome: "approved" });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("approval_card_decided", {
      tenant_id: T,
      user_id: "u-1",
      decision_class: "fundraising.send_email",
      decision_family: "fundraising",
      outcome: "approved",
      staff: false,
      action_key: "decision.approved",
    });
  });

  it("documents: only the tracker's mimes send, and only a PDF carries a kind", () => {
    trackDocumentDelivered({ tenant_id: T, mime: "image/png" });
    trackDocumentDelivered({ tenant_id: T, mime: "video/mp4" });
    trackDocumentDelivered({ tenant_id: T, mime: "application/vnd.ms-powerpoint" });
    expect(track).not.toHaveBeenCalled();

    trackDocumentDelivered({ tenant_id: T, mime: "application/pdf" });
    trackDocumentDelivered({ tenant_id: T, mime: "application/pdf", kind: "deck" });
    trackDocumentDelivered({ tenant_id: T, mime: "text/csv", kind: "deck" });
    expect(track.mock.calls.map((c) => c[1])).toEqual([
      { tenant_id: T, doc: "pdf", kind: "other", action_key: "doc.pdf" },
      { tenant_id: T, doc: "pdf", kind: "deck", action_key: "doc.pdf" },
      { tenant_id: T, doc: "spreadsheet", kind: undefined, action_key: "doc.spreadsheet" },
    ]);
  });

  it("a throwing Mixpanel client never reaches the caller", () => {
    track.mockImplementation(() => {
      throw new Error("mixpanel down");
    });
    expect(() => fireAll()).not.toThrow();
  });
});
