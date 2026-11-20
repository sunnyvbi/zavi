import { copyLabel, findBlanks } from "../blanks";
import { isPartialRiskExecCode } from "@zavi/shared";
import { actionHint } from "../actionHints";
import { isDeveloperCard } from "../devMail";
import { ANSWER_CHECK_SLUG, answerCheckPage, isAnswerCheckCard } from "../answerCheck";
import { channelScanHandle } from "../../layout/channelScanHandle";
import { isAnswerCard, opensMail } from "../StoredPrimary";
import { isZaviBuilderCard } from "../zaviBuilder";
import { AUDIENCE_READ_LABEL, AUDIENCE_REVIEW_LABEL, isAudienceReviewCard } from "../audienceReview";
import { actionLink, deliverableOf, postContent, type ActionHandlers, type ActionItem } from "../types";

export type PrimaryMode = "publish" | "approve" | "review" | "plan" | "answer" | "copy" | "mail" | "builder" | "developer" | "external" | "steps" | "done" | "balance" | "answerCheck" | "audience";

export type PrimarySpec = {
  mode: PrimaryMode;
  label: string;
  confirm: string;
  resolved: string;
  icon: "external" | "copy" | null;
  undo: boolean;
  href?: string | null;
  text?: string | null;
  directLink?: boolean;
  sameTab?: boolean;
  handoff?: boolean;
  describe?: string;
  testId?: string;
};

export type FamilyWords = {
  network: string;
  executed: (a: ActionItem) => string;
  manageUrl?: string | null;
  execPartial?: { href: string; label: string } | null;
  composerUrl?: ((text: string, a: ActionItem) => string | null) | null;
  composerLabel?: string | null;
  directPublishOnly?: boolean;
  walletTopUp?: boolean;
  publishLabel?: string | null;
  taskHref?: string | null;
  taskLabel?: string | null;
};

const AD_LABELS: Record<string, string> = { create_ad: "Create ad", update_ad: "Apply change", pause_ad: "Pause" };
const GENERIC_TASK_LABELS = new Set(["Review it", "Apply change", "Create it", "Fix setup"]);

const POST_TYPES = new Set(["text_post", "image_post", "video_post", "reply"]);

export function isPostCard(a: ActionItem): boolean {
  return POST_TYPES.has(a.action_type) && !a.executable;
}
const COPY_KINDS = new Set(["message", "ad_manual", "copy_to_site"]);

export function copyTextOf(a: ActionItem): string | null {
  if (POST_TYPES.has(a.action_type)) {
    const { text, thread } = postContent(a);
    return [text, ...(thread ?? [])].join("\n\n");
  }
  return deliverableOf(a)?.content ?? null;
}

function spec(mode: PrimaryMode, label: string, over: Partial<PrimarySpec> = {}): PrimarySpec {
  return { mode, label, confirm: "Done", resolved: "Done", icon: null, undo: true, ...over };
}

export function primaryOf(a: ActionItem, handlers: ActionHandlers, words: FamilyWords, filled?: string | null, composerText?: string | null): PrimarySpec | null {
  const stored = a.primary_label ?? null;
  const done = a.done_label ?? "Done";
  const text = filled ?? copyTextOf(a);
  const blanks = findBlanks(text, deliverableOf(a)?.kind);
  const link = actionLink(a);
  const composerSource = composerText ?? text;
  const composerHref = composerSource && words.composerUrl ? words.composerUrl(composerSource, a) : null;
  if (handlers.onReviewExecute && a.body?.step?.deliverable?.presentation?.type === "campaign_draft") {
    return spec("review", "Review and create", { undo: false });
  }
  if (a.executable && a.exec_status === "failed") {
    const partialRisk = isPartialRiskExecCode(a.exec_code) || a.exec_bucket === "partial_risk";
    if (partialRisk || a.exec_bucket === "blocked_on_us") {
      if (partialRisk && !a.exec_managed && words.execPartial) {
        return spec("external", words.execPartial.label, {
          href: words.execPartial.href,
          icon: "external",
          undo: false,
          directLink: true,
          testId: "exec-partial-link",
        });
      }
      return null;
    }
    return spec("approve", "Try again", { resolved: `Approved. Sending to ${words.network}.`, undo: false });
  }
  if (a.executable && a.held?.wallet_short && words.walletTopUp) {
    return spec("balance", "Add balance", { resolved: words.executed(a), undo: false, testId: "held-add-balance" });
  }
  if (a.executable) {
    return spec("approve", stored ?? a.body?.action_label ?? AD_LABELS[a.action_type] ?? "Approve", { resolved: `Approved. Sending to ${words.network}.`, undo: false });
  }
  if (isAudienceReviewCard(a)) {
    return handlers.onCreateAudiences
      ? spec("audience", AUDIENCE_REVIEW_LABEL, { resolved: "Saved to LinkedIn", undo: false, text, testId: "create-audience" })
      : spec("done", AUDIENCE_READ_LABEL, { resolved: AUDIENCE_READ_LABEL });
  }
  const canPublish = !!handlers.onPublish && (words.directPublishOnly || !(words.composerLabel && !composerHref));
  if (POST_TYPES.has(a.action_type) && (canPublish || words.directPublishOnly) && a.card_kind !== "copy_to_site") {
    return spec("publish", words.publishLabel ?? (stored && !stored.startsWith("Copy") ? stored : `Post on ${words.network}`), { resolved: `Posted on ${words.network}`, undo: false, text });
  }
  if (POST_TYPES.has(a.action_type) && composerHref && !canPublish) {
    return spec("external", words.composerLabel ?? "Open draft", {
      confirm: done === "Done" ? "I posted it" : done,
      resolved: done === "Done" ? "I posted it" : done,
      href: composerHref,
      icon: "external",
      directLink: true,
      handoff: true,
      describe: actionHint(a, "composer"),
      text,
    });
  }
  if (isAnswerCheckCard(a)) {
    return channelScanHandle(ANSWER_CHECK_SLUG)
      ? spec("answerCheck", stored ?? "Check AI answers", { undo: false })
      : spec("external", stored ?? "Check AI answers", { href: answerCheckPage(), directLink: true, sameTab: true, icon: null, undo: false });
  }
  if (a.card_kind === "plan") return spec("plan", stored ?? "Approve plan", { resolved: "Approved" });
  if (isAnswerCard(a)) return spec("answer", stored ?? "Reply", { resolved: "Sent", undo: false });
  if (opensMail(a)) return spec("mail", copyLabel(stored ?? "Open email", blanks), { confirm: done, resolved: done, icon: "external", text });
  const copyKind = a.card_kind ? COPY_KINDS.has(a.card_kind) : POST_TYPES.has(a.action_type);
  if ((copyKind || (a.card_kind === "post" && !handlers.onPublish)) && text) {
    const base = stored ?? (POST_TYPES.has(a.action_type) ? "Copy post" : "Copy text");
    return spec("copy", copyLabel(base, blanks), { confirm: done === "Done" ? "I posted it" : done, resolved: done === "Done" ? "I posted it" : done, icon: "copy", text });
  }
  if (a.card_kind === "task" && isZaviBuilderCard(a)) return spec("builder", copyLabel(stored ?? "Send to Zavi", blanks), { confirm: done, resolved: done, text });
  if (a.card_kind === "task" && isDeveloperCard(a)) return spec("developer", copyLabel(stored ?? "Send to dev", blanks), { confirm: done, resolved: done, icon: "external", text });
  const href = link ?? (a.card_kind === "task" ? words.taskHref ?? words.manageUrl ?? null : null);
  const swapped = !link && stored && words.taskLabel && GENERIC_TASK_LABELS.has(stored) ? words.taskLabel : null;
  if (href) return spec("external", swapped ?? stored ?? a.body?.action_label ?? AD_LABELS[a.action_type] ?? "Review it", { confirm: done === "Done" ? "I reviewed it" : done, resolved: done === "Done" ? "I reviewed it" : done, icon: "external", href, directLink: true, handoff: true });
  if (a.card_kind) return spec("steps", stored ?? "Do it", { confirm: done, resolved: done });
  return spec("done", "Done", { resolved: "Done" });
}
