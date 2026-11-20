import { CHANNELS } from "@zavi/shared";
import type { ActionItem } from "./types";

export type HintAction = Pick<ActionItem, "title" | "channel_slug"> &
  Partial<Pick<ActionItem, "body" | "exec_status" | "edited_body">>;
export type ActionOperation =
  | "approve"
  | "review"
  | "done"
  | "reject"
  | "snooze"
  | "redo"
  | "answer"
  | "ask"
  | "copy"
  | "copyAll"
  | "edit"
  | "finishEdit"
  | "publish"
  | "composer"
  | "open"
  | "steps"
  | "email"
  | "builder"
  | "plan"
  | "writePage"
  | "checkAnswers"
  | "download"
  | "more"
  | "dismiss";
export const channelName = (slug: string) =>
  CHANNELS.find((c) => c.slug === slug)?.name ?? slug.replace(/_/g, " ");
const short = (value: string, limit = 120) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

export function actionHint(
  a: HintAction,
  operation: ActionOperation,
  detail?: string,
): string {
  const descriptions: Record<ActionOperation, string> = {
    approve: `${a.exec_status === "failed" ? "Retry" : "Authorize"} Zavi to execute this card's exact change. This can change the connected account or use the budget or credits shown on the card.`,
    review:
      "Open the campaign review form to check the creative, budget and targeting before submitting approval. Opening the form does not create a campaign or spend money.",
    done: "Mark this item completed because you have handled it. This does not perform the suggested work or publish anything.",
    reject:
      "Open an optional reason box before rejecting this suggestion. Your reason helps guide the next channel run; rejecting does not undo earlier work.",
    snooze:
      "Choose when this item returns to Next steps: tomorrow, in 3 days, or in 1 week. This postpones the suggestion; it does not pause an existing campaign or post.",
    redo: "Open a place to explain what should change. Sending your instruction asks Zavi to rerun this channel and replace this suggestion.",
    answer:
      "Type the answer this card asks for. Sending it gives Zavi your answer, and Zavi runs this channel again to do the next step.",
    ask: "Open the channel chat about this action. Add your question and send it; opening chat does not approve the action.",
    copy: "Copy this card's current text to your clipboard. Paste it where you need it; copying does not publish or send it.",
    copyAll:
      "Copy all parts of this card, including parts on other tabs, to your clipboard. Nothing is published or sent.",
    edit: "Open this draft's editor to change its text before publishing.",
    finishEdit:
      "Close the inline editor and return to the draft preview. This does not publish the post.",
    publish:
      "Approve this draft for publishing through the connected account. It may go live immediately or at its scheduled time. Check the content and destination before continuing.",
    composer:
      "Open the platform's composer in a new tab. Finish and submit the post there; opening it does not publish through Zavi.",
    open: "Open the linked page to carry out this task. Zavi does not apply the suggested change by opening the page.",
    steps:
      "Show this card's instructions so you can carry out the task yourself.",
    email:
      "Open your email app with this card's content prepared. Choose the recipient and send it yourself; Zavi does not send the email.",
    builder:
      "Open Zavi's builder with this task prepared so you can continue the change there.",
    plan: "Mark this plan accepted so the next channel run can use it. This does not publish its posts or launch ads.",
    writePage:
      "Start a short run that writes the topic you picked as a new page. It uses credits from your plan and replaces this card when the page is ready. Nothing is published to your site.",
    checkAnswers:
      "Ask the AI assistants your tracked questions and count who they name and cite. This is the GEO page's Check AI answers, with its plan and weekly limits. Results fill the GEO page; nothing changes on your site.",
    download:
      "Download the video attached to this card. Downloading does not publish it to the channel.",
    more: "Open the other available options for this card. Opening the menu does not apply a change.",
    dismiss:
      "Choose a reason to dismiss this suggestion or bring it back later. This does not undo work already completed.",
  };
  const change =
    !detail &&
    operation === "approve" &&
    typeof a.body?.change_sentence === "string"
      ? ` Proposed change: ${short(a.body.change_sentence, 180)}`
      : "";
  return `${channelName(a.channel_slug)} · “${short(a.title)}”. ${detail ?? descriptions[operation]}${change}`;
}
