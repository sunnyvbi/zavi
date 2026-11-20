"use client";

import { useEffect, useRef, useState } from "react";
import { campaignFetch } from "../managed-campaigns/api";
import { requestCampaignReview } from "../managed-campaigns/campaignReviewRequest";
import { ApiError, newRequestId } from "@/lib/workspace/channelActionsApi";
import { approveDecision } from "@/lib/approvals/approveDecision";
import { toast } from "@/components/ui/toast";
import { followPostInToast } from "./postToast";
import { upgradeOnPlanRefusal, useChannelPlanLock } from "../channelPlanLock";
import type { TopActionSpec } from "../platformSpec";
import { ActionModal, MDone, m } from "./ActionModal";
import { runCostLabel } from "../../layout/useChannelRunPress";
import { APPROVALS_CHANGED_EVENT, addGeoQuestion, addGeoRival, addRedditCommunity, proposeSocialPost, sendTikTokDraft, startStarterVideos, startTopAction } from "./api";
import { TopActionFields, useTopActionForm } from "./fields";
import { useWorkspaceOptional } from "../../WorkspaceShell";
import { platformFor } from "../platforms";

export function FormActionModal({
  slug,
  channelName,
  action,
  onClose,
  onChanged,
  onStarted,
}: {
  slug: string;
  channelName: string;
  action: TopActionSpec;
  onClose: () => void;
  onChanged: () => void;
  onStarted?: () => void;
}) {
  const planLock = useChannelPlanLock();
  const tenantId = useWorkspaceOptional()?.tenantId;
  const submitTo = action.submit ?? "run";
  const isRun = submitTo === "run";
  const form = useTopActionForm(slug, action.key, action.fields, isRun);
  const [consented, setConsented] = useState(!action.consent);
  const [busy, setBusy] = useState(false);
  const [pressed, setPressed] = useState<"primary" | "stage" | null>(null);
  const [done, setDone] = useState(false);
  const [doneText, setDoneText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(newRequestId());
  const lastAsk = useRef<string | null>(null);
  const proposalAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const zaviWrites = submitTo === "social_propose" && !!action.writes && form.inputs().text === undefined;
  const notConnected = form.contextRead && form.context.connected === false;
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [error]);
  const followStagedPost = (decisionId: string) =>
    tenantId
      ? followPostInToast(decisionId, channelName, undefined, tenantId)
      : followPostInToast(decisionId, channelName);

  const close = () => {
    onChanged();
    onClose();
  };

  async function startRun(key: string, inputs: Record<string, unknown>) {
    const asked = JSON.stringify([key, inputs]);
    if (lastAsk.current !== null && lastAsk.current !== asked) requestId.current = newRequestId();
    lastAsk.current = asked;
    let r = await startTopAction(slug, key, requestId.current, inputs);
    for (let i = 0; i < 3 && !r.run_id; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      r = await startTopAction(slug, key, requestId.current, inputs);
    }
    if (!r.run_id) throw new Error("Zavi is still starting this. Check the list in a minute.");
    onStarted?.();
  }

  async function submit(stageOnly = false) {
    setPressed(stageOnly ? "stage" : "primary");
    setBusy(true);
    setError(null);
    try {
      if (action.submit === "linkedin_campaign_draft") {
        const out = await campaignFetch<{ action_id: string }>("/api/channels/linkedin_ads/campaign-drafts", { method: "POST", body: "{}" });
        onChanged();
        onClose();
        requestCampaignReview(out.action_id);
        return;
      }
      if (submitTo === "geo_prompt" || submitTo === "geo_rival" || submitTo === "video_starters") {
        const inputs = form.inputs();
        let title = action.done ?? "Done.";
        let type: "success" | "info" = "success";
        if (submitTo === "geo_prompt") await addGeoQuestion(String(inputs.text ?? ""));
        else if (submitTo === "geo_rival") {
          const name = String(inputs.name ?? "").trim();
          const r = await addGeoRival(name);
          if (r.baseline_reset === false) {
            type = "info";
            const listed = (r.rivals ?? []).some((x) => x.trim().toLowerCase() === name.toLowerCase());
            title = listed ? "That rival is already on your list." : "Zavi couldn't use that name. Try a shorter or plainer one.";
          }
        } else {
          const r = await startStarterVideos();
          if (r.duplicate) {
            type = "info";
            title = "A starter run already exists. Check What Zavi wants to do for its videos.";
          } else onStarted?.();
        }
        onChanged();
        toast.add({ type, title });
        setBusy(false);
        close();
        return;
      }
      if (submitTo === "social_propose" || submitTo === "tiktok_drafts" || submitTo === "reddit_community") {
        const inputs = form.inputs();
        if (submitTo === "social_propose" && action.writes && inputs.text === undefined) {
          await startRun(action.writes.key, inputs);
          if (action.postNow) {
            toast.add({ type: "success", title: "Sent for approval", description: action.writes.done });
            close();
            return;
          }
          setDoneText(action.writes.done);
          setDone(true);
          setBusy(false);
          return;
        }
        if (submitTo === "social_propose") {
          if (!action.socialChannel) throw new Error("This button is not set up.");
          const fingerprint = JSON.stringify(inputs);
          const attempt =
            proposalAttempt.current?.fingerprint === fingerprint
              ? proposalAttempt.current
              : { fingerprint, key: newRequestId() };
          proposalAttempt.current = attempt;
          const staged = await proposeSocialPost(action.socialChannel, inputs, attempt.key);
          if (action.postNow && !stageOnly) {
            let res: Response | null;
            try {
              res = await approveDecision(staged.decision_id, { scheduled_at: null });
            } catch {
              window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
              toast.add({
                type: "info",
                title: "Could not confirm the approval",
                description: `The pin is saved. Zavi is checking whether ${channelName} received it; do not post it again yet.`,
                timeout: 10_000,
              });
              void followStagedPost(staged.decision_id);
              close();
              return;
            }
            window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
            if (!res?.ok) {
              const why = res
                ? ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message
                : null;
              if (res && res.status < 500) {
                toast.add({
                  type: "error",
                  title: "Pin saved for approval",
                  description: `It was not posted${why ? `: ${why.trim().replace(/\.+$/, "")}` : ""}. Review it on the Pinterest page.`,
                  timeout: 10_000,
                });
              } else {
                toast.add({
                  type: "info",
                  title: "Could not confirm the approval",
                  description: `The pin is saved. Zavi is checking whether ${channelName} received it; do not post it again yet.`,
                  timeout: 10_000,
                });
                void followStagedPost(staged.decision_id);
              }
              close();
              return;
            }
            void followStagedPost(staged.decision_id);
            close();
            return;
          }
          window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
          if (action.postNow) {
            toast.add({ type: "success", title: "Sent for approval", description: `It waits on the ${channelName} page until you approve it.` });
            close();
            return;
          }
        } else if (submitTo === "tiktok_drafts") {
          await sendTikTokDraft(String(inputs.video_path ?? ""));
        } else {
          await addRedditCommunity(String(inputs.name ?? ""));
          toast.add({ type: "success", title: action.done ?? "Subreddit added." });
          setBusy(false);
          close();
          return;
        }
        onChanged();
        setDone(true);
        setBusy(false);
        return;
      }
      await startRun(action.key, form.inputs());
      setBusy(false);
      if (action.closeOnDone) {
        toast.add({ type: "success", title: action.done ?? "Started. It lands in What Zavi wants to do." });
        close();
        return;
      }
      setDone(true);
    } catch (e) {
      setBusy(false);
      if (upgradeOnPlanRefusal(planLock, e)) {
        onClose();
        return;
      }
      const refusal = e as { status?: unknown; code?: unknown };
      if (action.ownersOnly && refusal.status === 403 && refusal.code === "forbidden") setError(action.ownersOnly);
      else if (e instanceof ApiError && e.status === 402) setError(e.message || "You are out of credits for this. Top up, then try again.");
      else setError((e as Error).message || "Zavi could not start this. Try again.");
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        requestId.current = newRequestId();
        lastAsk.current = null;
      }
    }
  }

  return (
    <ActionModal
      eyebrow={channelName}
      title={action.label}
      sub={action.lead ?? ""}
      onClose={close}
      busy={busy}
      hint={isRun ? [action.hint, form.contextRead && platformFor(slug).hideRunCost !== true ? runCostLabel(typeof form.context.credits === "number" && form.context.credits > 0 ? form.context.credits : null) : null].filter(Boolean).join(" · ") : action.hint}
      footer={
        <>
          <button type="button" className={m.cancel} disabled={busy} onClick={close}>
            Cancel
          </button>
          {action.postNow && (
            <button type="button" className={m.cancel} disabled={!form.valid || !consented || busy || notConnected} aria-busy={busy && pressed === "stage"} onClick={() => void submit(true)}>
              {busy && pressed === "stage" ? "Loading…" : action.postNow.stageLabel}
            </button>
          )}
          <button
            type="button"
            className={m.primary}
            disabled={!form.valid || !consented || busy || notConnected || (!!action.postNow && zaviWrites)}
            title={action.postNow && zaviWrites ? action.postNow.needsWords : undefined}
            onClick={() => void submit()}
          >
            {action.postNow
              ? busy && pressed === "primary"
                ? "Loading…"
                : (action.primary ?? "Continue")
              : busy
                ? isRun
                  ? "Starting…"
                  : "Sending…"
                : (action.primary ?? "Continue")}
          </button>
        </>
      }
      done={
        done ? (
          <MDone
            text={doneText ?? action.done ?? "Started. It lands in What Zavi wants to do."}
            action={
              <button type="button" className={m.cancel} onClick={close}>
                Done
              </button>
            }
          />
        ) : undefined
      }
    >
      {notConnected ? (
        <p role="status" className={m.note}>
          {channelName} is not connected. Connect it in Integrations, then {action.label.toLowerCase()}.{" "}
          <a href="/workspace?tab=settings&section=integration" className="font-medium underline underline-offset-2">
            Open Integrations
          </a>
        </p>
      ) : action.note && <p className={m.note}>{action.postNow && zaviWrites ? `${action.note} ${action.postNow.needsWords}` : action.note}</p>}
      {error && (
        <p ref={errorRef} role="alert" className={m.error}>
          {error}
        </p>
      )}
      {action.fields && action.fields.length > 0 && <TopActionFields fields={action.fields} form={form} disabled={busy || done} />}
      {action.consent && (
        <label className="flex items-start gap-2.5 text-[14px] leading-5 text-[#1f1f1f]">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={consented} disabled={busy || done} onChange={(e) => setConsented(e.target.checked)} />
          {action.consent}
        </label>
      )}
    </ActionModal>
  );
}
