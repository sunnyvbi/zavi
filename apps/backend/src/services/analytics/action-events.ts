
import { track, type TrackProps } from "./mixpanel";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

function send(event: string, action_key: string, props: TrackProps): void {
  try {
    track(event, { ...props, action_key });
  } catch {
  }
}

export function trackChannelRunStarted(args: {
  tenant_id: string;
  channel_slug: string;
  path: "recipe" | "direct";
}): void {
  send("channel_run_started", "channel.run", args);
}

export function trackChannelActionProposed(args: {
  tenant_id: string;
  channel_slug: string;
  action_type: string;
}): void {
  send("channel_action_proposed", "channel_action.proposed", args);
}

export const FOUNDER_RESPONSES = ["acted", "approved", "rejected", "snoozed", "redo_requested"] as const;
export type FounderResponse = (typeof FOUNDER_RESPONSES)[number];

export function trackChannelActionResponded(args: {
  tenant_id: string;
  user_id?: string;
  channel_slug: string;
  response: FounderResponse;
}): void {
  send("channel_action_responded", `founder.${args.response}`, args);
  if (args.response === "approved" || args.response === "acted") {
    void notifyFounderActivity({
      event: "first_approval",
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      details: { channel: args.channel_slug, response: args.response },
    });
  }
}

export function trackApprovalCardDecided(args: {
  tenant_id: string;
  user_id?: string;
  decision_class: string;
  outcome: "approved" | "rejected";
  staff?: boolean;
}): void {
  if (args.decision_class === "channel.recipe_step") return;
  send("approval_card_decided", `decision.${args.outcome}`, {
    ...args,
    decision_family: args.decision_class.split(".")[0],
  });
  if (args.outcome === "approved" && !args.staff) {
    void notifyFounderActivity({
      event: "first_approval",
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      details: { decision: args.decision_class },
    });
  }
}

export function trackSocialPostPublished(args: { tenant_id: string; platform: string }): void {
  send("social_post_published", "published.social_post", args);
}

export function trackChannelActionExecuted(args: { tenant_id: string; channel_slug: string }): void {
  send("channel_action_executed", "published.action_executed", args);
}

export function trackMediaGenerated(args: {
  tenant_id: string;
  media: "image" | "video";
  kind: string;
}): void {
  send("media_generated", `media.${args.media}`, args);
}

const DOC_BY_MIME: Record<string, "pdf" | "html" | "spreadsheet" | "dashboard"> = {
  "application/pdf": "pdf",
  "text/html": "html",
  "application/vnd.zavi.ui+json": "dashboard",
  "text/csv": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
};

export function trackDocumentDelivered(args: { tenant_id: string; mime: string; kind?: string }): void {
  const doc = DOC_BY_MIME[args.mime];
  if (!doc) return;
  send("document_generated", `doc.${doc}`, {
    tenant_id: args.tenant_id,
    doc,
    kind: doc === "pdf" ? (args.kind ?? "other") : undefined,
  });
}

export function trackPrototypePublished(args: {
  tenant_id: string;
  prototype: "wireframe" | "html_preview" | "shared_page";
}): void {
  send("prototype_published", `proto.${args.prototype}`, args);
}

export function trackDoneForYou(
  event: "dfy_approved" | "dfy_executed" | "dfy_cannot_do" | "dfy_failed",
  args: {
    tenant_id: string;
    user_id?: string;
    run_id?: string;
    action_id?: string;
    channel_slug?: string | null;
    mode?: string | null;
    attempt: number;
    status?: string;
  },
): void {
  const props: TrackProps = { tenant_id: args.tenant_id, attempt: args.attempt };
  for (const k of ["user_id", "run_id", "action_id", "channel_slug", "mode", "status"] as const) {
    const v = args[k];
    if (typeof v === "string" && v) props[k] = v;
  }
  send(event, "growth.done_for_you", props);
}
