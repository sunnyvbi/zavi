"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { startReconnectFlow } from "../../settings/reconnectFlows";
import { channelCardHref } from "../GrowthReviewList";
import {
  answerQuestion,
  approveCard,
  checkDecision,
  redoCard,
  rejectCard,
  saveDraft,
  setCard,
  proposeLinkedInPause,
  readDoneWeek,
  recordCopy,
  redoDecision,
  snoozeDecision,
  startDoneForYou,
  unsnoozeDecision,
  type CardKind,
  type Forecast,
  type OpenCard,
  type WriteResult,
} from "./api";
import { amountText, creditsText, day, daysLeftInMonth, dollars, launchDailyUsd, monthEnd, runsOutAfter, runsOutNow, runsOutText, shiftText } from "./format";
import { pickToday, READY } from "./pickToday";
import { channelLabel } from "./PlanStep";
import { B, BLink, L, Mark, Tabs, box, cardBox, eyebrow, type Overlay } from "./ui";
import { DfyBlock, DfyOffer, dfyModalBody, useDoneForYou } from "./DoneForYou";
import { trackEvent } from "@/lib/analytics/events";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import { useWorkspaceOptional } from "../../WorkspaceShell";

type St = "open" | "busy" | "done" | "later" | "rejected";
type CS = { s: St; note?: string; copied?: boolean; text?: string; failed_before?: string | null };
type Say = (text: string, undo?: () => void) => void;

export const TODAY_ID = "growth-j6-today";

type Tier = "all" | "high" | "medium" | "low";
const TIERS: { value: Tier; name: string; tone?: "danger" | "warn" | "info" }[] = [
  { value: "all", name: "All" },
  { value: "high", name: "High", tone: "danger" },
  { value: "medium", name: "Medium", tone: "warn" },
  { value: "low", name: "Low", tone: "info" },
];
const FIX: readonly CardKind[] = ["check", "reconnect", "spend", "link"];
const DECIDE: readonly CardKind[] = ["question", "plan"];
const tierOf = (k: CardKind): Exclude<Tier, "all"> => (FIX.includes(k) ? "high" : READY.includes(k) || DECIDE.includes(k) ? "medium" : "low");

const ASKED: Partial<Record<CardKind, string>> = { post: "Posted it?", copy: "Updated it?", message: "Sent it?", task: "Done it?" };

const APPLYING = "approved, applying";
const UNCONFIRMED = "approved, not confirmed yet";
const ELSEWHERE = "already handled";
const HANDLED_CODES = new Set(["already_executed", "illegal_transition", "decision_closed"]);
const errorCode = (r: WriteResult): unknown => {
  const e = r.body?.error;
  return e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
};
const unconfirmedWords = (c: OpenCard | undefined) =>
  c?.stops_live_spend
    ? "Zavi couldn't confirm the pause you approved went through. The campaign may still be spending: check it on its channel page."
    : "Zavi couldn't confirm the change you approved went through. Check it on its channel page before you approve it again.";
const APPLY_POLL_MS = 15_000;
const APPLY_POLLS = 20;
const failedWords = (c: OpenCard) =>
  c.stops_live_spend
    ? "You approved this, but the pause did not go through. This campaign can still spend."
    : "You approved this, but it did not go through. Check it before you approve it again.";

export type TodaySummary = { open: number; allDone: boolean; anyDone: boolean };

export function TodayStep({
  cards,
  failed = false,
  forecast,
  leftUsd,
  say,
  overlay,
  close,
  reload,
  onSummary,
  focusId,
}: {
  cards: OpenCard[] | null;
  failed?: boolean;
  forecast: Forecast | null;
  leftUsd: number | null;
  say: Say;
  overlay: (o: Overlay) => void;
  close: () => void;
  reload: () => Promise<void>;
  onSummary: (s: TodaySummary) => void;
  focusId?: string;
}) {
  const known = useRef(new Map<string, OpenCard>());
  for (const c of cards ?? []) known.current.set(c.id, c);
  const [cs, setCs] = useState<Record<string, CS>>({});
  const [today, setToday] = useState<string[] | null>(null);
  const [pinned, setPinned] = useState<string[]>([]);
  const [filedPause, setFiledPause] = useState<{ id: string; name: string | null; settled: boolean } | null>(null);
  const [tier, setTier] = useState<Tier>("all");

  const stateOf = (c: OpenCard): CS => cs[c.id] ?? { s: c.snoozed_until ? "later" : "open" };
  const isOpen = (c: OpenCard) => stateOf(c).s === "open";
  const live = new Set((cards ?? []).map((c) => c.id));
  const pool = (cards ?? []).filter((c) => isOpen(c));

  useEffect(() => {
    if (today !== null || cards === null) return;
    setToday(pickToday(cards.filter((c) => !c.snoozed_until)));
  }, [cards, today]);

  const [focusDone, setFocusDone] = useState<string | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);
  useEffect(() => {
    if (!focusId || focusDone === focusId || cards === null || today === null) return;
    setFocusDone(focusId);
    const hit = cards.find((c) => c.id === focusId);
    if (!hit) {
      setFocusMissing(true);
      return;
    }
    setFocusMissing(false);
    setTier("all");
    if (hit.snoozed_until) setCs((m) => ({ ...m, [hit.id]: { s: "open" } }));
    setToday((t) => {
      const kept = (t ?? []).filter((id) => id !== hit.id).slice(-2);
      return [hit.id, ...kept];
    });
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-j6-card="${hit.id.replace(/["\\]/g, "")}"]`);
      if (!el) return;
      el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      el.classList.add("animate-pulse");
      window.setTimeout(() => el.classList.remove("animate-pulse"), 1600);
    }, 0);
  }, [focusId, focusDone, cards, today]);

  useEffect(() => {
    const urgent = (cards ?? []).filter((c) => c.stops_live_spend && !c.snoozed_until).map((c) => c.id);
    if (urgent.length === 0) return;
    setPinned((p) => {
      const add = urgent.filter((id) => !p.includes(id));
      return add.length ? [...p, ...add] : p;
    });
  }, [cards]);

  const filedPauseListed = !!filedPause && (cards ?? []).some((c) => c.id === filedPause.id);
  useEffect(() => {
    if (!filedPauseListed || !filedPause) return;
    const id = filedPause.id;
    setTier("all");
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-j6-card="${id.replace(/["\\]/g, "")}"]`);
      if (!el) return;
      el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      el.classList.add("animate-pulse");
      window.setTimeout(() => el.classList.remove("animate-pulse"), 1600);
    }, 0);
  }, [filedPauseListed, filedPause]);

  const ids = today ?? [];
  const batchStart = Math.max(0, ids.length - 3);
  const earlier = ids.slice(0, batchStart);
  const urgentNow = (cards ?? []).filter((c) => c.stops_live_spend && !c.snoozed_until).map((c) => c.id);
  const allPinned = [...pinned, ...urgentNow.filter((id) => !pinned.includes(id))];
  const todayCards = [...ids.slice(batchStart), ...allPinned.filter((id) => !ids.includes(id))]
    .map((id) => known.current.get(id))
    .filter((c): c is OpenCard => !!c)
    .sort((a, b) => Number(!!b.stops_live_spend && isOpen(b)) - Number(!!a.stops_live_spend && isOpen(a)));
  const todayOpen = todayCards.filter((c) => isOpen(c) || stateOf(c).s === "busy");
  const shown = new Set([...ids, ...allPinned]);
  const rest = pool.filter((c) => !shown.has(c.id));
  const snoozedElsewhere = (cards ?? []).filter((c) => !shown.has(c.id) && stateOf(c).s === "later");
  const allDone = cards !== null && todayOpen.length === 0;
  const anyDone = todayCards.some((c) => stateOf(c).s === "done" || stateOf(c).s === "rejected");

  useEffect(() => {
    onSummary({ open: todayOpen.length, allDone, anyDone });
  }, [todayOpen.length, allDone, anyDone, onSummary]);

  const workspace = useWorkspaceOptional();
  const tenantId = workspace?.tenantId ?? null;
  const { dfy, reload: reloadDfy } = useDoneForYou();
  const offerAvailable = dfy?.state === "available";
  const offerCard = offerAvailable ? todayOpen.find((c) => isOpen(c) && !!c.dfy) ?? null : null;
  const offerSent = useRef<string | null>(null);
  useEffect(() => {
    if (!offerAvailable || today === null || cards === null) return;
    const key = offerCard ? `offer:${offerCard.id}` : "none";
    if (offerSent.current === key) return;
    offerSent.current = key;
    if (offerCard) {
      trackEvent("dfy_offered", {
        tenant_id: tenantId,
        action_id: offerCard.id,
        channel_slug: offerCard.channel_slug,
        mode: offerCard.dfy ?? null,
        slot: todayOpen.findIndex((c) => c.id === offerCard.id) + 1,
      });
    } else {
      trackEvent("dfy_no_eligible_today", { tenant_id: tenantId });
    }
  }, [offerAvailable, offerCard, today, cards, tenantId, todayOpen]);
  const lastDfy = useRef<string | null>(null);
  useEffect(() => {
    const st = dfy?.state ?? null;
    if (lastDfy.current === "running" && st !== "running") void reload();
    lastDfy.current = st;
  }, [dfy, reload]);
  const upgrade = () => {
    if (workspace) openBillingSettings(workspace.openTab, "billing-upgrade-starter");
  };

  const set = (id: string, next: CS) => setCs((m) => ({ ...m, [id]: next }));
  const applying = (c: OpenCard): CS => ({ s: "done", note: APPLYING, failed_before: c.exec_failed_at });
  const waiting = Object.values(cs).some((x) => x.note === APPLYING);
  const csNow = useRef(cs);
  csNow.current = cs;
  const cardsNow = useRef(cards);
  cardsNow.current = cards;
  useEffect(() => {
    if (!waiting) return;
    let left = APPLY_POLLS;
    let stopped = false;
    const settle = async (last: boolean) => {
      const done = await readDoneWeek();
      if (stopped) return;
      const doneIds = new Set((done ?? []).map((d) => d.id));
      const listed = new Set((cardsNow.current ?? []).map((c) => c.id));
      let unsure: OpenCard | undefined;
      for (const [id, x] of Object.entries(csNow.current)) {
        if (x.note !== APPLYING) continue;
        if (doneIds.has(id)) set(id, { s: "done", note: "approved" });
        else if (last && !listed.has(id)) {
          set(id, { s: "done", note: UNCONFIRMED, failed_before: x.failed_before });
          unsure = unsure ?? known.current.get(id);
        }
      }
      if (last && unsure) say(unconfirmedWords(unsure));
    };
    const t = window.setInterval(() => {
      left -= 1;
      const last = left <= 0;
      if (last) window.clearInterval(t);
      void reload().catch(() => undefined).then(() => settle(last));
    }, APPLY_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
  }, [waiting, reload]);
  useEffect(() => {
    for (const c of cards ?? []) {
      const was = cs[c.id];
      if (was?.note !== APPLYING && was?.note !== UNCONFIRMED) continue;
      if (c.kind !== "check" && (!c.exec_failed_at || c.exec_failed_at === was.failed_before)) continue;
      set(c.id, { s: "open" });
      say(failedWords(c));
    }
  }, [cards]);

  const write = async (c: OpenCard, fn: () => Promise<WriteResult>, after: CS, text: string, undo?: () => void) => {
    const before = stateOf(c);
    set(c.id, { ...before, s: "busy" });
    const r = await fn();
    if (!r.ok) {
      if (HANDLED_CODES.has(errorCode(r) as string)) {
        set(c.id, { s: "done", note: ELSEWHERE });
        say(errorCode(r) === "decision_closed" && r.message ? r.message : "That card was already handled somewhere else, so Zavi took it off today's list.");
        void reload();
        return false;
      }
      set(c.id, before);
      if (r.message) say(r.message);
      return false;
    }
    set(c.id, after);
    const batch = todayCards;
    if (after.s === "done" && batch.some((y) => y.id === c.id)) {
      const doneN = batch.filter((y) => y.id === c.id || stateOf(y).s === "done").length;
      const next = batch.find((y) => y.id !== c.id && isOpen(y));
      const nextLine = next ? `. Next: ${next.title.length > 42 ? `${next.title.slice(0, 40)}…` : next.title}` : ". All done.";
      say(`${text.replace(/\.$/, "")} · ${doneN} of ${batch.length} today${nextLine}`, undo);
    } else {
      say(text, undo);
    }
    void reload();
    return true;
  };

  const local = (c: OpenCard) => c.id.startsWith("reconnect:");
  const reopen = (c: OpenCard) => {
    if (!ids.includes(c.id)) {
      setPinned((p) => (p.includes(c.id) ? p : [...p, c.id]));
      setTier((t) => (t === "all" ? t : "high"));
    }
    if (local(c)) return Promise.resolve(set(c.id, { s: "open" }));
    return write(c, () => (c.source === "channel_action" ? setCard(c.id, "open") : unsnoozeDecision(c.id)), { s: "open" }, "Back on today's list.");
  };

  const acted = (c: OpenCard, note: string, text: string) =>
    write(c, () => setCard(c.id, "acted", note), { s: "done", note }, text, c.source === "channel_action" ? () => void reopen(c) : undefined);

  const doForMe = (c: OpenCard) => {
    if (!c.dfy) return;
    overlay({
      kind: "modal",
      title: "Have Zavi do this?",
      body: (
        <div>
          <p>{dfyModalBody(c.dfy)}</p>
          <div className="mt-4 flex gap-2">
            <B
              dark
              onClick={() => {
                close();
                void (async () => {
                  const r = await startDoneForYou(c.id);
                  if (!r.ok) {
                    say(r.message ?? "Couldn't start it. Try again.");
                    await reloadDfy();
                    return;
                  }
                  say("Zavi is on it. It shows at the top of Today when it's done.");
                  await reloadDfy();
                })();
              }}
            >
              Start
            </B>
            <B onClick={close}>Cancel</B>
          </div>
        </div>
      ),
    });
  };

  const approve = (c: OpenCard) => {
    const delta = c.amount;
    const added = delta ?? launchDailyUsd(c.launch_usd, c.launch_ends_at);
    const before = runsOutNow(forecast, leftUsd);
    const after = added === null ? before : runsOutAfter(forecast, added, leftUsd);
    const spend =
      added !== null ? `About ${dollars(Math.abs(added) * daysLeftInMonth())} ${added >= 0 ? "more" : "less"} spend by ${day(monthEnd())} (estimate).` : null;
    const shift = added === null ? "" : shiftText(before, after);
    const runs = runsOutText(after);
    overlay({
      kind: "modal",
      title: `${c.title.replace(/\?$/, "")}?`,
      body: (
        <div>
          {delta !== null && <p className="text-[20px] font-extrabold text-ink">{amountText(delta)}</p>}
          {c.effect && <p className="mt-1">{c.effect}</p>}
          {spend && <p className="mt-1">{spend}</p>}
          <p className="mt-2 text-[12.5px] text-inkMuted">
            {runs ? `Ad money then ${runs}${shift ? `, ${shift}` : ""} (estimate).` : "Ad money forecast isn't ready yet."}
          </p>
          <div className="mt-4 flex gap-2">
            <B
              dark
              onClick={() => {
                close();
                void write(c, () => approveCard(c), applying(c), "Approved. Applying…");
              }}
            >
              Approve
            </B>
            <B onClick={close}>Cancel</B>
          </div>
        </div>
      ),
    });
  };

  const check = (c: OpenCard) =>
    overlay({
      kind: "drawer",
      title: c.title,
      body: (
        <div className="space-y-3">
          {c.why && <p>{c.why}</p>}
          <p className="pt-2 font-semibold text-ink">What did you find?</p>
          <div className="flex flex-col items-start gap-1.5">
            <B
              onClick={() => {
                close();
                void write(c, () => checkDecision(c.id, false), { s: "done", note: "nothing was live" }, "Thanks. Zavi goes back to it.");
              }}
            >
              Nothing is live
            </B>
            <B
              onClick={() => {
                close();
                void write(c, () => checkDecision(c.id, true), { s: "done", note: "kept live" }, "Kept live. Zavi will watch its spend.");
              }}
            >
              It&apos;s live and I want it
            </B>
            {c.platform === "linkedin_ads" && c.campaign_id && c.account_id && (
              <B
                dark
                onClick={() => {
                  close();
                  void (async () => {
                    const r = await proposeLinkedInPause(c.campaign_id!, c.account_id!);
                    if (!r.ok) {
                      say(r.message ?? "Zavi couldn't file the pause.");
                      return;
                    }
                    const id = typeof r.body?.action_id === "string" ? r.body.action_id : null;
                    const campaign = r.body?.campaign as { name?: unknown } | undefined;
                    const name = typeof campaign?.name === "string" && campaign.name.trim() ? campaign.name.trim() : null;
                    if (id) setFiledPause({ id, name, settled: false });
                    say(`Zavi filed a pause for ${name ? `"${name}"` : "this campaign"}. Approve it at the top of Today to stop the spend.`);
                    await reload();
                    if (id) setFiledPause({ id, name, settled: true });
                  })();
                }}
              >
                Something is live: pause it
              </B>
            )}
          </div>
        </div>
      ),
    });

  const edit = (c: OpenCard) => {
    const cur = stateOf(c).text ?? c.body ?? "";
    const Body = () => {
      const [v, setV] = useState(cur);
      const [saving, setSaving] = useState(false);
      const [err, setErr] = useState<string | null>(null);
      const tooLong = c.channel_slug === "x_organic" && c.kind === "post" && v.length > 280;
      return (
        <div>
          <textarea
            aria-label="Draft"
            value={v}
            onChange={(e) => setV(e.target.value)}
            rows={6}
            className="w-full rounded-lg border border-rule bg-cream p-2 text-[13px] text-ink outline-none focus:border-ink"
          />
          <p className="mt-1 text-[11.5px] text-inkMuted">
            {v.length} characters{tooLong ? " · too long for X (280)" : ""}
          </p>
          {err && <p className="mt-1 text-[12px] text-danger dark:text-coral">{err}</p>}
          <div className="mt-3 flex gap-2">
            <B
              dark
              disabled={!v.trim() || v === cur || tooLong || saving}
              onClick={async () => {
                setSaving(true);
                const r = await saveDraft(c.id, v);
                setSaving(false);
                if (!r.ok) return setErr(r.message ?? "Could not save your edit.");
                set(c.id, { ...stateOf(c), text: v });
                close();
                say("Saved your edit.");
              }}
            >
              Save
            </B>
            <B onClick={close}>Cancel</B>
          </div>
        </div>
      );
    };
    overlay({ kind: "modal", title: "Edit", body: <Body /> });
  };

  const changePlan = (c: OpenCard) => {
    const Body = () => {
      const [v, setV] = useState("");
      return (
        <div>
          <p className="text-[15px] leading-6 text-inkMuted">
            What should Zavi change? It redrafts and asks you again.
            {c.source === "channel_action" && c.redo_credits ? ` This uses at least ${creditsText(c.redo_credits)}.` : ""}
          </p>
          <textarea
            autoFocus
            aria-label="What should Zavi change?"
            value={v}
            onChange={(e) => setV(e.target.value)}
            rows={3}
            className="mt-2 w-full rounded-lg border border-rule bg-cream p-2 text-[13px] text-ink outline-none focus:border-ink"
          />
          <div className="mt-3 flex gap-2">
            <B
              dark
              disabled={!v.trim()}
              onClick={() => {
                close();
                void write(
                  c,
                  () => (c.source === "channel_action" ? redoCard(c.id, v.trim()) : redoDecision(c.id, v.trim())),
                  { s: "done", note: "you asked for changes" },
                  "Sent. Zavi will redraft it.",
                );
              }}
            >
              Send
            </B>
            <B onClick={close}>Cancel</B>
          </div>
        </div>
      );
    };
    overlay({ kind: "modal", title: "Change it", body: <Body /> });
  };

  const connect = async (c: OpenCard) => {
    if (!c.channel_slug) return;
    try {
      await startReconnectFlow(c.channel_slug);
      say("Finish the connection in the window that opened. This card drops once Zavi can read it again.");
    } catch (e) {
      say((e as Error).message || "That did not finish. Nothing changed.");
    }
  };

  const copy = (c: OpenCard) => {
    const text = stateOf(c).text ?? c.body ?? "";
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
    }
    if (c.url) window.open(c.url, "_blank", "noopener,noreferrer");
    void recordCopy(c);
    set(c.id, { ...stateOf(c), copied: true });
    say(c.kind === "post" ? `Copied. Post it on ${c.where ?? channelLabel(c.channel_slug ?? "")}, then come back and say yes.` : "Copied.");
  };

  const later = async (c: OpenCard) => {
    if (local(c)) {
      set(c.id, { s: "later" });
      say("Moved to later.", () => set(c.id, { s: "open" }));
      return;
    }
    await write(
      c,
      () => (c.source === "channel_action" ? setCard(c.id, "snoozed") : snoozeDecision(c.id)),
      { s: "later" },
      "Moved to later.",
      () => void reopen(c),
    );
  };

  const showNext = (c: OpenCard) => {
    const next = pickToday(rest, 1)[0];
    if (next) setToday((t) => (t ?? []).map((id) => (id === c.id ? next : id)));
  };

  const row = (c: OpenCard) => (
    <CardRow
      key={c.id}
      c={c}
      cs={stateOf(c)}
      gone={!live.has(c.id)}
      on={{
        approve: () => approve(c),
        reject: (why) =>
          void write(c, () => rejectCard(c, why), { s: "rejected", note: why }, `Rejected${why ? `: ${why.toLowerCase()}` : ""}.`),
        check: () => check(c),
        connect: () => void connect(c),
        answer: (a, label) =>
          void write(c, () => answerQuestion(c.id, a), { s: "done", note: label }, a === "not_now" ? "Skipped. Zavi will ask again later." : `Answered: ${label}.`),
        copy: () => copy(c),
        yes: () => void acted(c, "done", c.kind === "post" ? "Marked posted." : c.kind === "message" ? "Marked sent." : "Marked done."),
        notYet: () => {
          set(c.id, { ...stateOf(c), copied: false });
          say("OK, it stays here.");
        },
        decide: () => void write(c, () => approveCard(c), c.kind === "spend" ? applying(c) : { s: "done", note: "approved" }, "Approved."),
        planOk: () =>
          void (c.source === "channel_action" ? acted(c, "approved", "Plan approved.") : write(c, () => approveCard(c), { s: "done", note: "approved" }, "Plan approved.")),
        planChange: () => changePlan(c),
        edit: () => edit(c),
        notNow: () => void later(c),
        reopen: () => void reopen(c),
        showNext: rest.length > 0 && ids.includes(c.id) ? () => showNext(c) : undefined,
      }}
    />
  );

  const inTier = (t: Exclude<Tier, "all">) => rest.filter((c) => tierOf(c.kind) === t);
  const highCount = todayOpen.length + inTier("high").length;
  const count = (t: Tier) =>
    t === "all" ? highCount + inTier("medium").length + inTier("low").length : t === "high" ? highCount : inTier(t).length;
  const note = (text: ReactNode) => <p className={`${box} px-4 py-3.5 text-[15px] leading-6 text-inkMuted`}>{text}</p>;

  const group = (label: string, list: OpenCard[], extra?: ReactNode) =>
    (list.length > 0 || extra) && (
      <section key={label} className="mt-5 first:mt-0" aria-label={label}>
        <h3 className={eyebrow}>{label}</h3>
        <ul className="mt-2 flex flex-col gap-3">
          {list.map((c) => (
            <li key={c.id}>
              {offerCard?.id === c.id && <DfyOffer onStart={() => doForMe(c)} />}
              {row(c)}
            </li>
          ))}
        </ul>
        {extra}
      </section>
    );

  const firstCard = todayOpen[0] && isOpen(todayOpen[0]) ? todayOpen[0] : null;
  const thenCards = [...todayCards.filter((c) => c.id !== firstCard?.id), ...snoozedElsewhere, ...inTier("high")];
  const doneBanner =
    allDone && todayCards.length > 0 ? (
      <div className={`mt-3 flex flex-wrap items-center gap-2 rounded-2xl px-4 py-3 text-[15px] text-ink ${anyDone ? "bg-successBg" : "border border-rule"}`}>
        {anyDone && <Check className="h-4 w-4 text-success dark:text-mint" />}
        <b className="font-semibold">{anyDone ? "Done for today." : `${todayCards.length} moved to later.`}</b>
        {anyDone && <span className="text-inkMuted">{rest.length ? "Next 3 tomorrow." : "Nothing else waiting."}</span>}
        {rest.length > 0 && (
          <span className="ml-auto">
            <B onClick={() => setToday((t) => [...(t ?? []), ...pickToday(rest, 3)])}>{anyDone ? "Do 3 more now" : "Show the next 3"}</B>
          </span>
        )}
      </div>
    ) : null;
  const handled =
    earlier.length > 0 ? (
      <p key="handled" className="mb-3 flex items-center gap-2 rounded-xl bg-successBg px-4 py-2.5 text-[14px] text-success">
        <Check className="h-3.5 w-3.5" /> {earlier.length} handled today
      </p>
    ) : null;
  const high = [handled, group("Do this first", firstCard ? [firstCard] : []), group(firstCard ? "Then" : "Today", thenCards, doneBanner)];
  const hasHigh = !!firstCard || thenCards.length > 0 || !!doneBanner || !!handled;
  const mediumList = inTier("medium");
  const medium = [group("Ready to publish", mediumList.filter((c) => READY.includes(c.kind))), group("Decide", mediumList.filter((c) => !READY.includes(c.kind)))];

  let body: ReactNode;
  if (cards === null) {
    body = note(failed ? "Couldn't load today's list yet. It shows up here once it loads." : "Loading today's list…");
  } else if (cards.length === 0 && ids.length === 0) {
    body = note("Nothing waiting on you right now.");
  } else if (today === null) {
    body = note("Loading today's list…");
  } else if (tier === "high") {
    body = hasHigh ? high : note("Nothing here right now.");
  } else if (tier === "medium") {
    body = mediumList.length ? medium : note("Nothing here right now.");
  } else if (tier === "low") {
    const list = inTier("low");
    body = list.length ? (
      <ul className="flex flex-col gap-3">
        {list.map((c) => (
          <li key={c.id}>{row(c)}</li>
        ))}
      </ul>
    ) : (
      note("Nothing here right now.")
    );
  } else {
    const low = inTier("low");
    body = hasHigh || mediumList.length || low.length ? [...high, ...medium, group("Set up", low)] : note("Nothing here right now.");
  }

  const tabbed = cards !== null && (cards.length > 0 || ids.length > 0);
  return (
    <>
      <DfyBlock dfy={dfy} tenantId={tenantId} onUpgrade={upgrade} />
      {focusMissing && (
        <p role="status" className="text-[14px] text-inkMuted">
          That card was already handled.
        </p>
      )}
      {filedPause?.settled && !filedPauseListed && (
        <p role="status" className="text-[14px] font-semibold text-danger dark:text-coral">
          Zavi filed a pause for {filedPause.name ? `"${filedPause.name}"` : "this campaign"}, but today&apos;s list did not refresh. It keeps spending until you approve the pause. Reload this page to see it.
        </p>
      )}
      {tabbed && (
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <Tabs
            label="To do today, by how urgent"
            value={tier}
            onChange={setTier}
            items={TIERS.map((t) => ({ value: t.value, label: t.name, count: count(t.value), tone: t.tone }))}
          />
        </div>
      )}
      <div role={tabbed ? "tabpanel" : undefined} aria-label={`${tier} cards`}>
        {body}
      </div>
    </>
  );
}

type On = {
  approve: () => void;
  reject: (why: string) => void;
  check: () => void;
  connect: () => void;
  answer: (a: "yes" | "no" | "not_now" | { text: string }, label: string) => void;
  copy: () => void;
  yes: () => void;
  notYet: () => void;
  decide: () => void;
  planOk: () => void;
  planChange: () => void;
  edit: () => void;
  notNow: () => void;
  reopen: () => void;
  showNext?: () => void;
};

function A({ children, onClick, expanded }: { children: ReactNode; onClick: () => void; expanded?: boolean }) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className="inline-flex min-h-8 cursor-pointer items-center rounded-sm text-[14px] font-semibold leading-5 text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
    >
      {children}
    </button>
  );
}

export function CardRow({ c, cs, on, gone }: { c: OpenCard; cs: CS; on: On; gone?: boolean }) {
  const [why, setWhy] = useState(false);
  const [full, setFull] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const text = cs.text ?? c.body;
  const isDecision = c.source === "decision";

  if (cs.s === "later")
    return (
      <div data-j6-card={c.id} className={`${cardBox} flex items-center gap-3 border-dashed px-5 py-3 text-[15px] leading-6 text-inkMuted`}>
        <Mark slug={c.channel_slug} size={24} />
        <span className="min-w-0 flex-1 truncate">Later: {c.title}</span>
        {on.showNext && <B onClick={on.showNext}>Show the next one</B>}
        <L onClick={on.reopen}>Undo</L>
      </div>
    );

  if (cs.s !== "open")
    return (
      <div data-j6-card={c.id} className={`${cardBox} flex items-center gap-3 px-5 py-3 text-[15px] leading-6 text-inkMuted`}>
        <Mark slug={c.channel_slug} size={24} />
        {cs.s === "busy" ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="flex-1">{c.title}: saving…</span>
          </>
        ) : (
          <>
            {cs.s === "done" && cs.note !== APPLYING && cs.note !== UNCONFIRMED && cs.note !== ELSEWHERE ? <Check className="h-3.5 w-3.5 text-success dark:text-mint" /> : <span className="w-3.5" />}
            <span className="min-w-0 flex-1 truncate">
              {cs.s === "rejected" ? "Rejected: " : ""}
              {c.title} {amountText(c.amount) ?? ""}
              {cs.note ? ` · ${cs.note}` : ""}
            </span>
            {c.source === "channel_action" && cs.note !== ELSEWHERE && <L onClick={on.reopen}>Change</L>}
          </>
        )}
      </div>
    );

  const toneText = c.stops_live_spend || c.tone === "danger" ? "text-danger dark:text-coral" : c.tone === "warn" || c.exec_failed_at ? "text-warn dark:text-marigold" : "text-inkMuted";
  const where = c.where ?? (c.channel_slug ? channelLabel(c.channel_slug) : "it");
  const notNow = !["check", "reconnect", "spend"].includes(c.kind) ? (
    <B pill onClick={on.notNow}>
      Not now
    </B>
  ) : null;
  const reject = (
    <B pill onClick={() => setRejecting(!rejecting)}>
      Reject
    </B>
  );
  let buttons: ReactNode = null;

  if (c.opens_review) {
    buttons = (
      <>
        {notNow}
        <BLink pill dark href={channelCardHref(c.channel_slug ?? "linkedin_ads", c.id)}>
          {c.primary_label ?? "Review and create"}
        </BLink>
      </>
    );
  } else if (c.approve_blocked) {
    buttons = (
      <>
        {notNow}
        {reject}
      </>
    );
  } else if (c.kind === "check") {
    buttons = isDecision ? (
      <B pill dark onClick={on.check}>
        Check
      </B>
    ) : (
      <B pill dark onClick={on.yes}>
        Mark done
      </B>
    );
  } else if (c.kind === "reconnect" || c.kind === "connect") {
    buttons = (
      <>
        {notNow}
        <B pill dark onClick={on.connect}>
          {c.kind === "reconnect" ? "Reconnect" : `Connect ${c.channel_slug ? channelLabel(c.channel_slug) : ""}`.trim()}
        </B>
      </>
    );
  } else if (c.kind === "spend") {
    buttons = (
      <>
        {reject}
        <B pill dark onClick={on.approve}>
          Approve
        </B>
      </>
    );
  } else if (c.kind === "question") {
    const opts = c.options ?? null;
    buttons = (
      <>
        {notNow}
        <B pill onClick={() => on.answer("not_now", "Not sure")}>
          Not sure
        </B>
        {opts ? (
          opts.map((o, i) => (
            <B pill key={o} dark={i === 0} onClick={() => on.answer({ text: o }, o)}>
              {o}
            </B>
          ))
        ) : (
          <>
            <B pill onClick={() => on.answer("no", "No")}>
              No
            </B>
            <B pill dark onClick={() => on.answer("yes", "Yes")}>
              Yes
            </B>
          </>
        )}
      </>
    );
  } else if (c.kind === "plan") {
    buttons = (
      <>
        {notNow}
        {c.can_redo && (
          <B pill onClick={on.planChange}>
            Change it
          </B>
        )}
        <B pill dark onClick={on.planOk}>
          Looks good
        </B>
      </>
    );
  } else if (isDecision) {
    buttons = (
      <>
        {notNow}
        {reject}
        <B pill dark onClick={on.decide}>
          {c.primary_label ?? "Approve"}
        </B>
      </>
    );
  } else if (!text) {
    buttons = (
      <>
        {notNow}
        <B pill dark onClick={on.yes}>
          {c.primary_label ?? "Mark done"}
        </B>
      </>
    );
  } else if (cs.copied) {
    buttons = (
      <>
        {notNow}
        <span className="self-center text-[14px] text-inkMuted">{ASKED[c.kind] ?? "Done it?"}</span>
        <B pill onClick={on.notYet}>
          Not yet
        </B>
        <B pill dark onClick={on.yes}>
          {c.kind === "post" ? "Yes, it's live" : "Yes"}
        </B>
      </>
    );
  } else {
    buttons = (
      <>
        {notNow}
        <B pill dark onClick={on.copy}>
          {c.kind === "task" ? (c.primary_label ?? "Copy it") : `Copy & open ${where}`}
        </B>
      </>
    );
  }

  const tag = c.stops_live_spend ? "Stops live spend" : c.kind === "check" ? "Money at risk" : c.kind === "reconnect" ? "Broken" : c.kind === "spend" ? "Money" : null;
  const editable = !isDecision && (c.kind === "post" || c.kind === "message");
  const canChange = c.can_redo && c.kind !== "plan";

  return (
    <div data-j6-card={c.id} className={cardBox}>
      <div className="flex gap-4 p-5 text-ink">
        <Mark slug={c.channel_slug} size={24} />
        <div className="min-w-0 flex-1">
          {(c.tone || tag) && (
            <p className={`text-[12px] font-semibold uppercase leading-4 tracking-[0.08em] ${toneText}`}>
              {tag ?? (c.tone === "danger" ? "Urgent" : "Fix")}
            </p>
          )}
          <p className="text-[17px] font-semibold leading-6 tracking-tight">
            {c.title}
            {c.amount !== null && <span className="ml-1.5 font-bold tabular-nums">{amountText(c.amount)}</span>}
          </p>
          {gone && <p className="text-[14px] text-inkMuted">No longer on the server&apos;s list.</p>}
          {c.exec_failed_at && <p className="mt-1 text-[14px] font-medium leading-5 text-danger dark:text-coral">{failedWords(c)}</p>}
          {c.approve_blocked && <p className="mt-1 text-[14px] font-medium leading-5 text-danger dark:text-coral">{c.approve_blocked}</p>}
          {text && (
            <div className="mt-3 text-[15px] leading-6 text-inkSoft">
              <p className={`whitespace-pre-wrap ${full ? "" : "line-clamp-2"}`}>{text}</p>
              {(text.length > 90 || editable) && (
                <span className="mt-1 flex gap-4">
                  {text.length > 90 && (
                    <A expanded={full} onClick={() => setFull(!full)}>
                      {full ? "Show less" : "Show all"}
                    </A>
                  )}
                  {editable && <A onClick={on.edit}>Edit</A>}
                </span>
              )}
            </div>
          )}
          {rejecting && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[14px]">
              <span className="text-inkMuted">Why? (optional)</span>
              {["Not now", "I disagree", "Too much money"].map((w) => (
                <B key={w} onClick={() => on.reject(w)}>
                  {w}
                </B>
              ))}
              <B dark onClick={() => on.reject("")}>
                Reject
              </B>
              <L onClick={() => setRejecting(false)}>Cancel</L>
            </div>
          )}
          {}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-rule pt-3">
            <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
              {c.why && (
                <A expanded={why} onClick={() => setWhy(!why)}>
                  Why?
                </A>
              )}
              {canChange && <A onClick={on.planChange}>Change it</A>}
            </span>
            <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1.5">{buttons}</span>
          </div>
          {why && c.why && (
            <p className="mt-2 rounded-xl bg-creamDeep px-4 py-3 text-[15px] leading-6 text-inkSoft">
              <span className="font-semibold text-ink">Why: </span>
              {c.why}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
