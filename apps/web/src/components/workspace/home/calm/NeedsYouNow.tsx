"use client";

import { useCallback, useEffect, useState, type JSX } from "react";
import { approveDecision, rejectDecision } from "@/lib/approvals/approveDecision";
import { fetchHome } from "@/lib/approvals/decisionApi";
import { useWorkspace } from "../../WorkspaceShell";
import { useOpenStatic } from "../../layout/shared";
import {
  decisionTitle,
  dispatchCardHeadline,
  handlerPreview,
  isAcknowledgeOnly,
} from "@/app/approvals/approvalsHelpers";
import { decisionConsequence } from "@/app/approvals/decisionCopy";
import { bulkDraftLine } from "@/app/approvals/approvalsHelpers";
import { DecisionBody } from "@/app/approvals/ApprovalsIsland";
import { MAX_SHOWN, filterNeedsYou } from "./needsYouFilter";
import { UNWIRED_APPROVE_HANDLERS, oneClickApprovable } from "@/lib/approvals/oneClick";
import { LiveDecisionCard } from "@/components/agents/LiveDecisionCard";
import { ApprovalCardSkeleton } from "./CalmHomeSkeleton";

type Decision = {
  id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: Record<string, unknown>;
  status: string;
  handler: string | null;
  emitted_at: string;
  agent_slug?: string | null;
  needs_owner_admin?: boolean;
};

export const UNWIRED_HANDLERS = UNWIRED_APPROVE_HANDLERS;

type CardIcon = "megaphone" | "send" | "upload";

function iconForDecision(d: Decision): CardIcon {
  const slug = (d.agent_slug ?? "").toLowerCase();
  const cls = d.decision_class.toLowerCase();
  const handler = (d.handler ?? "").toLowerCase();
  if (
    slug === "performance-marketer" ||
    slug === "growth-lead" ||
    cls.startsWith("growth-lead.") ||
    /(^|[._-])(ads?|budget|campaign|marketing)([._-]|$)/.test(cls) ||
    handler.includes("ads")
  ) {
    return "megaphone";
  }
  if (cls.includes("dispatch") || slug === "chief-of-staff") return "upload";
  return "send";
}

function IconMegaphone() {
  return (
    <svg width="21" height="22" viewBox="0 0 19.4953 21.5001" fill="none" aria-hidden>
      <path d="M12.3516 0.986376C13.9514 0.218462 14.9168 -0.246002 16.0566 0.136767C17.2106 0.523767 17.6137 1.37044 18.2227 2.65044C19.9195 6.20933 19.9195 10.2917 18.2227 13.8506C17.6127 15.1306 17.2097 15.9773 16.0557 16.3643C15.7759 16.4582 15.5071 16.501 15.2363 16.501L15.2383 16.502C14.4063 16.502 13.5596 16.0957 12.3516 15.5157L6.92188 12.9083C7.47232 14.839 8.4043 15.6984 9.35352 16.3204C10.0265 16.7613 10.454 17.4849 10.4961 18.2569C10.5351 18.9709 10.2386 19.6427 9.68457 20.0997L8.19434 21.3291C8.05634 21.4431 7.8858 21.5 7.7168 21.5C7.55185 21.5 7.38794 21.4459 7.25098 21.3379C3.956 18.7249 3.97084 17.1147 4.00684 13.2237C4.00938 12.929 4.00991 12.6279 4.01172 12.3116C3.93332 12.3262 3.86522 12.3398 3.79785 12.3477C2.81504 12.4597 1.89409 12.1823 1.20215 11.5655C0.438168 10.8845 2.23421e-05 9.84107 0 8.7061V7.79497C1.21884e-05 6.65899 0.438159 5.61659 1.20215 4.93559C1.89309 4.3188 2.81405 4.04142 3.79688 4.15337C3.98387 4.17437 4.18029 4.21771 4.57129 4.30571C4.9632 4.39363 5.34227 4.35072 5.7002 4.17876L12.3516 0.986376ZM5.50391 13.4327C5.47295 16.8926 5.50543 17.9178 7.71387 19.7803L8.72949 18.9424C8.96749 18.7464 9.00705 18.5059 8.99805 18.3379C8.98202 18.0401 8.80702 17.7553 8.53125 17.5743C7.00291 16.5737 6.05102 15.2914 5.50391 13.4327ZM15.582 1.55864C15.0461 1.37869 14.5009 1.61897 13.0029 2.33794L6.35059 5.5313C6.236 5.58631 6.11828 5.63112 6 5.67192V10.8262C6.11826 10.867 6.2349 10.9149 6.34961 10.9698L13.002 14.1641C14.4999 14.8831 15.0451 15.1234 15.5811 14.9434C16.1081 14.7664 16.2971 14.4111 16.8711 13.2071C18.3721 10.0581 18.3721 6.44494 16.8711 3.29595C16.2971 2.09095 16.108 1.73564 15.582 1.55864ZM3.62891 5.64263C3.06106 5.57766 2.58107 5.7169 2.20312 6.05474C1.75813 6.45173 1.50294 7.08599 1.50293 7.79497V8.7061C1.50295 9.41507 1.75814 10.0494 2.20312 10.4463C2.58204 10.7841 3.06109 10.9234 3.62988 10.8584C3.73788 10.8464 3.91809 10.8055 4.24609 10.7325C4.33066 10.7134 4.41532 10.6978 4.5 10.6856V5.81548C4.41498 5.80323 4.32999 5.78763 4.24512 5.7686C3.91812 5.6956 3.73691 5.65463 3.62891 5.64263Z" fill="currentColor" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="23" height="16" viewBox="0 0 22.5005 15.5" fill="none" aria-hidden>
      <path d="M19.1369 0C20.0691 0 20.8107 0.396289 21.343 1.03613C21.8534 1.6497 22.1535 2.46136 22.3196 3.30762C22.6519 5.00183 22.4971 7.09199 22.0901 8.83398C21.6718 10.6242 21.0902 12.2475 20.2854 13.4404C19.4749 14.6418 18.3663 15.4999 16.9153 15.5C15.8969 15.5 14.9189 14.947 13.9983 14.0791C13.2588 13.382 12.5011 12.4287 11.7199 11.2383C10.8537 12.4413 10.0159 13.4028 9.19944 14.1025C8.18589 14.9712 7.13677 15.4998 6.06955 15.5C4.53964 15.5 3.3413 14.6775 2.44358 13.4678C1.55693 12.273 0.914767 10.6457 0.453341 8.85059C0.00396378 7.10256 -0.168119 5.00024 0.200412 3.29297C0.385054 2.43775 0.71883 1.62243 1.27951 1.00977C1.86044 0.374985 2.64895 7.87958e-05 3.62424 0C4.59889 0 5.59017 0.626309 6.47678 1.40332C7.39932 2.21183 8.36226 3.32197 9.29416 4.55957C10.2139 5.78079 11.0226 7.00613 11.7199 8.23438C12.3729 6.96996 13.1049 5.75135 13.9104 4.58594C14.7568 3.34953 15.632 2.23838 16.4729 1.42773C16.8936 1.02213 17.323 0.674296 17.7522 0.424805C18.1767 0.178022 18.6475 6.22104e-05 19.1369 0ZM3.62424 1.5C3.072 1.50007 2.68419 1.69658 2.38596 2.02246C2.06755 2.37043 1.81931 2.90502 1.66721 3.60938C1.36228 5.02201 1.4954 6.87746 1.90647 8.47656C2.34585 10.186 2.92617 11.602 3.64768 12.5742C4.35815 13.5316 5.15492 14 6.06955 14C6.63135 13.9998 7.34331 13.7176 8.22287 12.9639C9.02876 12.2732 9.91634 11.2367 10.8811 9.82812C10.123 8.37821 9.19563 6.92205 8.09592 5.46191C7.19444 4.26472 6.30217 3.24436 5.4885 2.53125C4.63888 1.78665 4.01119 1.5 3.62424 1.5ZM19.1369 1.5C19.0075 1.50007 18.8011 1.55019 18.5061 1.72168C18.2155 1.8906 17.8823 2.1517 17.5139 2.50684C16.7767 3.2175 15.9666 4.23682 15.1467 5.43457L15.1447 5.4375C14.1841 6.82723 13.3333 8.29729 12.6008 9.83301C13.4838 11.2539 14.2942 12.296 15.0276 12.9873C15.8284 13.7422 16.4524 14 16.9153 14C17.6862 13.9999 18.3908 13.5671 19.0422 12.6016C19.6993 11.6275 20.2286 10.2073 20.6291 8.49316C21.0042 6.88821 21.1276 5.02128 20.8479 3.5957C20.7078 2.88209 20.4785 2.3423 20.1897 1.99512C19.9227 1.67435 19.5935 1.5 19.1369 1.5Z" fill="currentColor" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg width="21" height="21" viewBox="0 0 20.5 20.5" fill="none" aria-hidden>
      <path d="M10.25 0C14.931 0 17.2806 0.000352504 18.8906 1.61133C20.4996 3.22233 20.5 5.57 20.5 10.25C20.5 14.93 20.4996 17.2787 18.8896 18.8887C17.2796 20.4996 14.931 20.5 10.25 20.5C5.56902 20.5 3.21937 20.4996 1.60938 18.8887C0.000374961 17.2777 0 14.93 0 10.25C0 5.57 0.000351518 3.22133 1.61035 1.61133C3.22035 0.000352368 5.56902 0 10.25 0ZM10.25 1.5C5.983 1.5 3.8409 1.4999 2.6709 2.6709C1.4999 3.8419 1.5 5.984 1.5 10.25C1.5 14.516 1.4999 16.6571 2.6709 17.8291C3.8409 19.0001 5.983 19 10.25 19C14.517 19 16.6591 19.0001 17.8291 17.8291C19.0001 16.6581 19 14.516 19 10.25C19 5.984 19.0001 3.8429 17.8291 2.6709C16.6591 1.4999 14.517 1.5 10.25 1.5ZM10.2334 7.48926C10.8452 7.49838 11.3415 7.89079 11.6494 8.21973L11.6602 8.23242L13.2598 10.0137C13.5368 10.3217 13.5111 10.7962 13.2031 11.0732C12.8951 11.3502 12.4215 11.3236 12.1445 11.0156L10.9727 9.71094V15.2891C10.9727 15.7029 10.6364 16.0388 10.2227 16.0391C9.80866 16.0391 9.47266 15.7031 9.47266 15.2891V9.70605L8.31348 11.0127C8.03848 11.3227 7.56391 11.3511 7.25391 11.0771C6.94401 10.8022 6.91657 10.3285 7.19043 10.0186L8.77051 8.23633C9.19142 7.75546 9.70401 7.48936 10.2129 7.48926H10.2334ZM14.2422 4.53906C14.6562 4.53906 14.9922 4.87506 14.9922 5.28906C14.9922 5.70306 14.6562 6.03906 14.2422 6.03906H6.24219C5.82819 6.03906 5.49219 5.70306 5.49219 5.28906C5.49219 4.87506 5.82819 4.53906 6.24219 4.53906H14.2422Z" fill="currentColor" />
    </svg>
  );
}

const CARD_ICON: Record<CardIcon, () => JSX.Element> = {
  megaphone: IconMegaphone,
  send: IconSend,
  upload: IconUpload,
};

function whyLine(d: Decision): string {
  const preview = handlerPreview(d.handler, d.body);
  if (preview) return preview.replace(/^[\s→·–—-]+/, "");
  const rationale = (d.body as { rationale?: unknown })?.rationale;
  if (typeof rationale === "string" && rationale.trim()) {
    return rationale.trim().slice(0, 140);
  }
  if (d.decision_class === "bulk_outbound.send") return bulkDraftLine(d.body);
  return d.decision_class;
}

export function NeedsYouNow() {
  const { openAgentTab, role } = useWorkspace();
  const openStatic = useOpenStatic();
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [decidedHere, setDecidedHere] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await fetchHome("needs_you", { count: true, limit: MAX_SHOWN });
      setDecisions(page.decisions.map((d) => ({ ...d, body: d.body ?? {} })) as Decision[]);
      setServerTotal(page.totals?.needs_you ?? page.decisions.length);
      setDecidedHere(0);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  async function approve(id: string) {
    setBusy(id);
    try {
      const res = await approveDecision(id, {}, undefined, { surface: "needs_you" });
      if (!res) return;
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setDecisions((prev) => prev.filter((d) => d.id !== id));
      setDecidedHere((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(id: string) {
    setBusy(id);
    setDismissed((prev) => new Set(prev).add(id));
    try {
      const res = await rejectDecision(id, { surface: "needs_you" });
      if (!res.ok) {
        const r = await res.json().catch(() => ({}));
        throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      }
      setDecisions((prev) => prev.filter((d) => d.id !== id));
      setDecidedHere((n) => n + 1);
    } catch (e) {
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const visible = decisions.filter((d) => !dismissed.has(d.id));
  const filtered = filterNeedsYou(visible);
  const shown = filtered.shown;
  const total = Math.max(visible.length, serverTotal - decidedHere - (decisions.length - visible.length));
  const hidden = Math.max(0, total - shown.length);

  return (
    <section className="mt-9" aria-label="Needs you now">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">
          Needs you now
        </h2>
        {total > 0 && (
          <span className="text-[16px] font-medium leading-5 text-[#0e0f11]">
            ({total} Pending)
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-[#f4cfcb] bg-[#fdecec] px-3 py-2 text-[12px] text-[#a3372f]">
          {error}
        </div>
      )}

      {!loaded && !error ? (
        <div className="flex flex-col gap-4" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading approvals…</span>
          {[0, 1].map((i) => (
            <ApprovalCardSkeleton key={i} />
          ))}
        </div>
      ) : loaded && shown.length === 0 && !error ? (
        <div className="rounded-[20px] border border-[#f0f0f0] bg-white px-4 py-6 text-center">
          <p className="text-[16px] text-[#595959]">
            Nothing needs you. Your team&apos;s got it.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          {shown.map((d) => {
            const { agentLabel, verbLabel } = decisionTitle(d.decision_class, d.body);
            const dispatch =
              d.handler === "praxis.dispatch_specialist"
                ? dispatchCardHeadline(d.body)
                : null;
            const cardTitle = dispatch ? dispatch.headline : agentLabel;
            const cardSubline = dispatch
              ? `${agentLabel} → ${dispatch.targetLabel}`
              : whyLine(d);
            const unwired = !!d.handler && UNWIRED_HANDLERS.has(d.handler);
            const Icon = CARD_ICON[iconForDecision(d)];
            const consequence = decisionConsequence(
              d.handler,
              d.decision_class,
              d.body,
            );
            const isOpen = !collapsed.has(d.id);
            const ackOnly = isAcknowledgeOnly(d.handler, d.body);
            const oneClick = oneClickApprovable(d, role ?? null);
            return (
              <div
                key={d.id}
                data-testid="needs-you-now-row"
                data-slip={oneClick ? "card" : "header"}
                className={
                  oneClick
                    ? "flex w-full flex-col gap-3 overflow-hidden rounded-2xl border border-[#efe2c3] bg-white pb-4 shadow-[0_1px_2px_rgba(43,36,22,0.06),0_10px_28px_-16px_rgba(43,36,22,0.25)]"
                    : "flex w-full flex-col gap-3 py-1"
                }
              >
                {oneClick && <div aria-hidden className="h-1.5 bg-[#e8c46a]" />}
                <div className={oneClick ? "-mt-3 flex items-start gap-4 bg-[#fbf6ea] px-4 pb-3 pt-3" : "flex items-start gap-4"}>
                  {}
                  <span
                    aria-hidden
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-3xl border border-white bg-[#f9f9f9] text-[#1f1f1f]"
                  >
                    <Icon />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-[16px] font-semibold leading-6 text-[#0e0f11] [overflow-wrap:anywhere]">
                      {cardTitle}
                    </div>
                    <div
                      className="mt-[7px] max-w-full break-words [overflow-wrap:anywhere] text-[13px] leading-5 tracking-[0.01px] text-[#595959]"
                      title={dispatch ? cardTitle : whyLine(d)}
                    >
                      {cardSubline}
                    </div>
                  </div>
                  {verbLabel ? (
                    <span className="shrink-0 rounded-md bg-[#f5faf8] px-1.5 py-1 text-[13px] font-medium leading-[18px] text-[#167f50]">
                      {verbLabel}
                    </span>
                  ) : null}
                </div>

                {}
                <dl className={`grid grid-cols-[max-content_1fr] gap-x-2.5 gap-y-1 pl-[53px] text-[13px] leading-5 ${oneClick ? "pr-4" : ""}`}>
                  <dt className="font-medium text-[#167f50]">If approved</dt>
                  <dd className="min-w-0 text-[#595959]">{consequence.approve}</dd>
                  <dt className="font-medium text-[#a3372f]">If rejected</dt>
                  <dd className="min-w-0 text-[#595959]">{consequence.reject}</dd>
                </dl>

                {!oneClick ? (
                  <div className="pl-[53px]">
                    <LiveDecisionCard
                      decisionId={d.id}
                      decisionClass={d.decision_class}
                      title={cardTitle}
                      viewerRole={role ?? null}
                      surface="needs_you"
                      onResolved={() => setDecidedHere((n) => n + 1)}
                    />
                  </div>
                ) : (
                <>
                <div className="pl-[53px] pr-4">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(d.id)) next.delete(d.id);
                        else next.add(d.id);
                        return next;
                      })
                    }
                    aria-expanded={isOpen}
                    aria-controls={`needs-you-details-${d.id}`}
                    className="inline-flex items-center gap-2 rounded-cta py-1 text-[13px] font-medium text-[#1f1f1f] transition-colors hover:text-[#0e0f11]"
                  >
                    <svg
                      aria-hidden
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`transition-transform ${isOpen ? "rotate-90" : ""}`}
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                    {isOpen ? "Hide details" : "Details"}
                  </button>
                  {}
                  {isOpen && (
                    <div id={`needs-you-details-${d.id}`} className="mt-1">
                      <DecisionBody
                        decisionClass={d.decision_class}
                        handler={d.handler}
                        body={d.body}
                      />
                    </div>
                  )}
                </div>

                <div className="border-t border-[#f3ead6]" aria-hidden />
                <div className="flex flex-wrap items-center gap-3 pl-[53px] pr-4">

                  <button
                    type="button"
                    onClick={() => void approve(d.id)}
                    disabled={busy === d.id || unwired}
                    title={unwired ? "This action's dispatcher isn't wired yet. Review it in Needs you." : undefined}
                    className="h-10 rounded-xl bg-[#0f1729] px-5 text-[16px] font-bold text-white transition-colors hover:bg-[#1c2740] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === d.id ? "…" : ackOnly ? "Acknowledge" : "Approve"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void openAgentTab(d.agent_slug ?? "operator")
                    }
                    className="h-10 rounded-xl border border-[#e6d6b0] bg-white px-4 text-[16px] font-semibold text-[#2b2416] transition-colors hover:bg-[#fff8ea]"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy === d.id}
                    onClick={() => void dismiss(d.id)}
                    title="Dismiss this permanently. Your team won't ask again"
                    className="ml-auto h-10 rounded-xl px-3 text-[15px] font-semibold text-[#7a6a4a] transition-colors hover:text-[#b3261e] disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
                </>
                )}
              </div>
            );
          })}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => openStatic("needs-you")}
              className="inline-flex h-10 items-center gap-2 rounded-cta px-4 text-[16px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#f9f9f9]"
            >
              See all {total}
              {}
              <svg aria-hidden width="20" height="20" viewBox="0 0 14.584 9.58291" fill="none" className="shrink-0">
                <path d="M9.34961 0.183058C9.59369 -0.0610204 9.9903 -0.0610185 10.2344 0.183058L14.4004 4.34907C14.4294 4.37806 14.4546 4.41056 14.4775 4.44478C14.514 4.49929 14.5391 4.55845 14.5566 4.61958C14.5724 4.6744 14.584 4.73158 14.584 4.79146C14.584 4.85103 14.5722 4.90778 14.5566 4.96236C14.5392 5.02354 14.514 5.08259 14.4775 5.13716C14.4547 5.17143 14.4294 5.20383 14.4004 5.23286L10.2344 9.39986C9.9903 9.64393 9.59369 9.64393 9.34961 9.39986C9.1059 9.15583 9.10586 8.76006 9.34961 8.51607L12.4502 5.41646H0.625C0.280003 5.41628 5.09855e-05 5.13648 0 4.79146C0 4.44639 0.279972 4.16663 0.625 4.16646H12.4502L9.34961 1.06685C9.10577 0.822885 9.10594 0.427128 9.34961 0.183058Z" fill="currentColor" />
              </svg>
            </button>
          )}
        </div>
      )}
    </section>
  );
}
