
import { isActionType, type ActionType } from "@/lib/workspace/actionTypes";
import type { ActionBody, ActionItem } from "./types";
import { TextPost } from "./bodies/TextPost";
import { ImagePost } from "./bodies/ImagePost";
import { VideoPost } from "./bodies/VideoPost";
import { Reply } from "./bodies/Reply";
import { SendMessage } from "./bodies/SendMessage";
import { CreateAd } from "./bodies/CreateAd";
import { UpdateAd } from "./bodies/UpdateAd";
import { PauseAd } from "./bodies/PauseAd";
import { Fix } from "./bodies/Fix";
import { Check } from "./bodies/Check";
import { Setup } from "./bodies/Setup";
import { Page } from "./bodies/Page";
import { Other } from "./bodies/Other";

export const ACTION_BODY: Record<ActionType, ActionBody> = {
  text_post: TextPost,
  image_post: ImagePost,
  video_post: VideoPost,
  reply: Reply,
  send_message: SendMessage,
  create_ad: CreateAd,
  update_ad: UpdateAd,
  pause_ad: PauseAd,
  fix: Fix,
  check: Check,
  setup: Setup,
  page: Page,
  other: Other,
};

export const ACTION_KIND_LABEL: Record<ActionType, string> = {
  text_post: "Post",
  image_post: "Post",
  video_post: "Post",
  reply: "Reply",
  send_message: "Message",
  create_ad: "Ad",
  update_ad: "Ad change",
  pause_ad: "Pause",
  fix: "Fix",
  check: "Check",
  setup: "Setup",
  page: "Page",
  other: "To do",
};

export const INTENT_TAG: Record<string, string> = {
  fix_setup: "Fix setup",
  improve: "Improve results",
  create: "Create",
  reach_out: "Reach out",
  review: "Review",
  answer: "Question",
};

export function cardTag(a: Pick<ActionItem, "body">, fallback?: string): string | undefined {
  const intent = a.body?.intent ?? a.body?.step?.intent;
  const named = a.body?.kind_label;
  return (typeof intent === "string" && INTENT_TAG[intent]) || (typeof named === "string" && named.trim()) || fallback;
}

export function isSetupTodo(a: Pick<ActionItem, "body">): boolean {
  return (a.body?.intent ?? a.body?.step?.intent) === "fix_setup";
}

export function cardKind(a: Pick<ActionItem, "body" | "action_type">): string {
  if (isSetupTodo(a)) return "Setup fix";
  return ACTION_KIND_LABEL[isActionType(a.action_type) ? a.action_type : "other"];
}

const KIND_PLURAL: Record<string, string> = {
  Post: "Posts",
  Reply: "Replies",
  Message: "Messages",
  Ad: "New ads",
  "Ad change": "Ad changes",
  Pause: "Pauses",
  Fix: "Fixes",
  Check: "Checks",
  Setup: "Setup steps",
  "Setup fix": "Setup fixes",
  Page: "Pages",
  "To do": "Other to-dos",
};

export function kindPlural(kind: string, platform?: { postsNoun?: string }): string {
  if (kind === "Post" && platform?.postsNoun) return platform.postsNoun;
  return KIND_PLURAL[kind] ?? kind;
}

export function kindBuckets<E>(entries: readonly E[], kindOf: (e: E) => string): { kind: string; entries: E[] }[] {
  const out: { kind: string; entries: E[] }[] = [];
  const at = new Map<string, number>();
  for (const e of entries) {
    const k = kindOf(e);
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, out.length);
      out.push({ kind: k, entries: [e] });
    } else out[i]!.entries.push(e);
  }
  return out;
}
