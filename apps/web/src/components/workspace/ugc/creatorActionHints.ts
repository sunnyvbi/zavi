import { actionHint, channelName } from "../actions/actionHints";
import type { CardTarget, CreatorCard } from "./creatorCards";
import type { DrawerName } from "./hub";

const drawers: Record<DrawerName, string> = {
  brief:
    "Open the UGC brief editor. Review and save or publish the brief there. Opening it does not hire a creator, charge you, or publish a video.",
  hire: "Open creator checkout to review the package, rights and total price. Opening checkout does not book or pay the creator.",
  applicants:
    "Open the applicants for this brief so you can compare creators. No creator is hired by opening the list.",
  review:
    "Open the delivered video for review. Opening it does not accept the delivery or release payment.",
  find: "Open creator search to compare profiles and packages. No booking or payment is made.",
  thread:
    "Open the conversation with this creator. No message is sent by opening it.",
  job: "Open this creator job to view its status and next steps. Opening it does not change the job or release payment.",
  inbox: "Open your creator inbox. No message is sent by opening it.",
};

export function creatorActionHint(
  slug: string,
  card: CreatorCard,
  target: CardTarget,
): string {
  let detail: string;
  switch (target.kind) {
    case "hide":
      detail = card.dismissForDays
        ? `Hide this card for ${card.dismissForDays} days in this browser only, then allow it to return. This does not cancel a brief, booking or campaign, and does not send feedback to Zavi.`
        : "Hide this card in this browser only. This does not cancel a brief, booking or campaign, and does not send feedback to Zavi.";
      break;
    case "download":
      detail =
        "Download this card's delivered video. Nothing is published to the channel.";
      break;
    case "push":
      detail = `Open the ${target.push === "meta" ? "Meta ad" : "YouTube upload"} form for this video. Review and submit it there; opening the form does not launch an ad or upload the video.`;
      break;
    case "drawer":
      detail = drawers[target.name];
      break;
    case "channel": {
      const rows =
        target.drawer === "brief" && target.params?.from
          ? card.pane?.rows
              .filter(([name]) => ["Format", "For", "Ad rights", "Budget", "Budget estimate"].includes(name))
              .map(([name, value]) => `${name}: ${value}`)
              .join("; ")
          : null;
      detail = target.drawer
        ? drawers[target.drawer]
        : `Open the ${channelName(target.slug)} channel to continue this task. This does not execute the suggestion.`;
      if (rows)
        detail = `Open a prefilled UGC brief (${rows}). Review the angle, hook and current budget estimate before saving or publishing it. This click does not hire a creator, charge you, or publish a video.`;
      break;
    }
  }
  return actionHint({ title: card.title, channel_slug: slug }, "open", detail);
}
